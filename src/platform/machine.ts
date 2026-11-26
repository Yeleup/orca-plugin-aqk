// The computer the worker runs on, as the rest of the plugin sees it: the system's rules (macOS, Windows or Linux), the
// worker's environment, the home directory, the clock, the few file operations the plugin needs and the start of a
// process. The worker uses realMachine(); tests put a fake system, environment, clock, files or process start in its
// place (src/testing/fake-machine.ts), so the rules of every system are checked on any of them.
import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, posix, win32, type PlatformPath } from 'node:path'
import { cwd, env, platform } from 'node:process'
import { randomUUID } from 'node:crypto'

export type Platform = 'linux' | 'darwin' | 'win32'

export type Env = Readonly<Record<string, string | undefined>>

// One process to start: `file` with `args` as they are (no shell in between, except the one a caller names as `file`).
export type StartRequest = {
  readonly file: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly env: Env
  // Windows: the arguments go to the process as written (cmd.exe /d /s /c "…"), without Node's quoting.
  readonly windowsVerbatimArguments?: boolean
  // Stops the process after this many milliseconds; `timedOut` says it was stopped.
  readonly timeoutMs?: number
}

export type StartOutcome = {
  // The exit code, or null when the process did not start or ended by a signal.
  readonly code: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  // Each stream keeps its last MAX_OUTPUT characters; true when an earlier part was dropped.
  readonly truncated: boolean
  readonly timedOut: boolean
  // Set when the process could not be started (e.g. ENOENT): Node's code and message.
  readonly startError: { readonly code: string | null; readonly message: string } | null
}

export type Machine = {
  readonly platform: Platform
  readonly env: Env
  readonly homedir: string
  // The worker's working directory: a relative command path counts from here.
  readonly cwd: string
  // Milliseconds since the epoch.
  now(): number
  // A regular file this system can run: on Windows any file, elsewhere one with the execute permission.
  isRunnableFile(path: string): boolean
  // The text of a file, or null when there is no such file.
  readText(path: string): string | null
  // Creates the file with exactly this text unless the file exists, creating its directory first. True when this call
  // created it, false when it was already there; a reader never sees it half written. Throws on any other failure.
  createText(path: string, text: string): boolean
  start(request: StartRequest): Promise<StartOutcome>
}

export const MAX_OUTPUT = 16 * 1024 * 1024

// The rules of this system. Orca runs on macOS, Windows and Linux; any other POSIX system follows Linux's rules.
export function realPlatform(name: string = platform): Platform {
  return name === 'darwin' || name === 'win32' ? name : 'linux'
}

export function realMachine(overrides: Partial<Machine> = {}): Machine {
  const system = realPlatform()
  return {
    platform: system,
    env: { ...env },
    homedir: homedir(),
    cwd: cwd(),
    now: () => Date.now(),
    isRunnableFile: (path) => isRunnableFile(path, system),
    readText,
    createText,
    start: startProcess,
    ...overrides,
  }
}

// The path rules of the machine's system (separators, absolute paths), whatever system the code runs on.
export function pathsOf(machine: Pick<Machine, 'platform'>): PlatformPath {
  return machine.platform === 'win32' ? win32 : posix
}

// A variable of the machine's environment; on Windows names have no case (PATH is often `Path` there).
export function envValue(machine: Pick<Machine, 'platform' | 'env'>, name: string): string | undefined {
  if (machine.platform !== 'win32') return machine.env[name]
  const upper = name.toUpperCase()
  const key = Object.keys(machine.env).find(
    (candidate) => candidate.toUpperCase() === upper && machine.env[candidate] !== undefined,
  )
  return key === undefined ? undefined : machine.env[key]
}

// The machine's environment with `extra` on top; on Windows a variable of `extra` replaces the one of any case.
export function mergeEnv(machine: Pick<Machine, 'platform' | 'env'>, extra: Env = {}): Env {
  const merged: Record<string, string | undefined> = { ...machine.env }
  for (const [name, value] of Object.entries(extra)) {
    if (machine.platform === 'win32') {
      for (const key of Object.keys(merged)) if (key.toUpperCase() === name.toUpperCase()) delete merged[key]
    }
    merged[name] = value
  }
  return merged
}

function isRunnableFile(path: string, system: Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (system !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

// The text goes to a temporary file beside the target first; a hard link then gives it the target's name only if that
// name is free (the link fails with EEXIST otherwise), so a reader sees the whole text or no file. Where the file
// system has no hard links, an exclusive create (flag wx) takes the name instead.
function createText(path: string, text: string): boolean {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx' })
  try {
    linkSync(temporary, path)
    return true
  } catch (error) {
    const code = errorCode(error)
    if (code === 'EEXIST') return false
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'ENOSYS') throw error
    try {
      writeFileSync(path, text, { encoding: 'utf8', flag: 'wx' })
      return true
    } catch (fallbackError) {
      if (errorCode(fallbackError) === 'EEXIST') return false
      throw fallbackError
    }
  } finally {
    try {
      unlinkSync(temporary)
    } catch {
      // Already gone; nothing else uses the temporary name.
    }
  }
}

function startProcess(request: StartRequest): Promise<StartOutcome> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let spawned = false
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const keep = (text: string, chunk: string) => {
      const joined = text + chunk
      if (joined.length <= MAX_OUTPUT) return joined
      truncated = true
      return joined.slice(joined.length - MAX_OUTPUT)
    }
    const finish = (outcome: Pick<StartOutcome, 'code' | 'signal' | 'startError'>) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve({ ...outcome, stdout, stderr, truncated, timedOut })
    }
    let child: ChildProcess
    try {
      child = spawn(request.file, request.args, {
        cwd: request.cwd,
        env: { ...request.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: request.windowsVerbatimArguments === true,
      })
    } catch (error) {
      finish({ code: null, signal: null, startError: { code: errorCode(error), message: errorMessage(error) } })
      return
    }
    child.stdout?.setEncoding('utf8').on('data', (chunk) => (stdout = keep(stdout, chunk)))
    child.stderr?.setEncoding('utf8').on('data', (chunk) => (stderr = keep(stderr, chunk)))
    child.on('spawn', () => {
      spawned = true
      if (request.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, request.timeoutMs)
      }
    })
    child.on('error', (error) => {
      if (spawned) return
      finish({ code: null, signal: null, startError: { code: error.code ?? null, message: error.message } })
    })
    child.on('close', (code, signal) => finish({ code, signal, startError: null }))
  })
}

export function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
