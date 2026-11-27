// The computer the worker runs on, as the rest of the plugin sees it: the system's rules (macOS, Windows or Linux), the
// worker's environment, the home directory, the clock, the few file operations the plugin needs and the start of a
// process. The worker uses realMachine(); tests put a fake system, environment, clock, files or process start in its
// place (src/testing/fake-machine.ts), so the rules of every system are checked on any of them.
//
// The environment is the worker's own, and Orca filters it: Orca 1.4.273+ forks a trusted-worker with only PATH, HOME,
// USERPROFILE, LANG, LC_ALL, LC_CTYPE, TZ, TMPDIR, TEMP, TMP, XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS, SSH_AUTH_SOCK,
// SYSTEMROOT, SYSTEMDRIVE, WINDIR, COMSPEC, PATHEXT, PROCESSOR_ARCHITECTURE and NUMBER_OF_PROCESSORS (on Windows with
// upper-case names, SystemRoot as such), plus GIT_TERMINAL_PROMPT=0 and ELECTRON_RUN_AS_NODE=1. Nothing here may count
// on another variable being set.
import { homedir } from 'node:os'
import { posix, win32, type PlatformPath } from 'node:path'
import { cwd, env, execPath, platform } from 'node:process'
import { createText, isRunnableFile, listEntries, modifiedAt, readText, replaceText } from './files'
import { startProcess } from './process'

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
  // Text the process reads on its standard input (as UTF-8), which is closed after it; without it the standard input
  // is empty. Long texts go this way rather than as an argument: a command line has a length limit (32767 characters
  // on Windows).
  readonly input?: string
  // Stops the process and the processes it started after this many milliseconds; `timedOut` says it was stopped.
  readonly timeoutMs?: number
  // A file that gets all the output, both streams in the order they come, as raw bytes.
  readonly outputFile?: string
  // How many bytes of each stream the result keeps (its beginning and its end); by default 16 MiB.
  readonly maxOutput?: number
}

export type StartOutcome = {
  // The exit code, or null when the process did not start or ended by a signal.
  readonly code: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  // True when the middle of a stream was left out of `stdout` or `stderr` (`outputFile` has it all).
  readonly truncated: boolean
  readonly timedOut: boolean
  // Why `outputFile` lacks output (it could not be written whole), or null.
  readonly outputError: string | null
  // After a timeout: why the processes the started one started may still run, or null.
  readonly stopError: string | null
  // Set when the process could not be started (e.g. ENOENT): Node's code and message.
  readonly startError: { readonly code: string | null; readonly message: string } | null
}

// An entry of a directory: a real directory, a regular file, or anything else (a link, a junction, a device).
export type DirectoryEntry = { readonly name: string; readonly kind: 'directory' | 'file' | 'other' }

export type Machine = {
  readonly platform: Platform
  readonly env: Env
  readonly homedir: string
  // The worker's working directory: a relative path without a run's own `cwd` counts from here.
  readonly cwd: string
  // The program the worker runs in: Orca's own executable (the worker is forked from Orca's main process).
  readonly execPath: string
  // Milliseconds since the epoch.
  now(): number
  // A regular file this system can run: on Windows any file, elsewhere one with the execute permission.
  isRunnableFile(path: string): boolean
  // The text of a file, or null when there is no such file.
  readText(path: string): string | null
  // When the file was last written, in milliseconds since the epoch (the clock of now()) with the fraction the file
  // system keeps, or null when there is no such file.
  modifiedAt(path: string): number | null
  // The entries right inside a directory, each as the directory has it — a symbolic link or a Windows junction is
  // `other`, never followed — or null when there is no such directory. Throws on any other failure (no access, not a
  // directory).
  listEntries(path: string): DirectoryEntry[] | null
  // Creates the file with exactly this text unless the file exists, creating its directory first. True when this call
  // created it, false when it was already there; a reader never sees it half written. Throws on any other failure.
  createText(path: string, text: string): Promise<boolean>
  // Writes the file with exactly this text, replacing the whole file when it exists (its directory must exist): a reader
  // sees the old text or the new one, never a mix. Throws on any failure.
  replaceText(path: string, text: string): Promise<void>
  start(request: StartRequest): Promise<StartOutcome>
}

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
    execPath,
    now: () => Date.now(),
    isRunnableFile: (path) => isRunnableFile(path, system),
    readText,
    modifiedAt,
    listEntries,
    createText: (path, text) => createText(path, text),
    replaceText: async (path, text) => replaceText(path, text),
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

// An absolute path from the environment, or undefined (a relative one does not count).
export function absoluteEnvPath(machine: Pick<Machine, 'platform' | 'env'>, name: string): string | undefined {
  const value = envValue(machine, name)?.trim()
  return value && pathsOf(machine).isAbsolute(value) ? value : undefined
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

export { errorCode, errorMessage } from './errors'
