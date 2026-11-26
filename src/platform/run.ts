// Running external commands — git, gh, Orca's CLI, the project's test command — by the rules of the machine's
// system, each with its exit code, output, start time and duration. A program is looked up in PATH the way the
// system's shell does (on Windows with the extensions of PATHEXT); a .cmd or .bat file on Windows goes through cmd.exe,
// since Windows starts only .exe files directly. The project's test command is a line for the system's shell:
// /bin/sh -c on macOS and Linux, cmd.exe /d /s /c on Windows, where the project may name a command of its own.
import { envValue, errorMessage, mergeEnv, pathsOf, type Env, type Machine, type StartRequest } from './machine'

export type RunOptions = {
  readonly cwd?: string
  // Variables on top of the machine's environment.
  readonly env?: Env
  readonly timeoutMs?: number
}

export type RunErrorKind =
  // The program, or the command of a shell line, does not exist.
  | 'not_found'
  // The system refused to start it (permissions, a broken file …).
  | 'start_failed'
  // It ran longer than `timeoutMs` and was stopped.
  | 'timed_out'

export type RunResult = {
  // The command as it was asked for: a program name or path, or the shell line.
  readonly command: string
  // The file started and its arguments, or null when nothing was started.
  readonly file: string | null
  readonly args: readonly string[]
  // When it started (ISO 8601, UTC) and how long it ran, by the machine's clock.
  readonly startedAt: string
  readonly durationMs: number
  // The exit code; null when it did not start or ended by a signal.
  readonly code: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
  // Why the command did not run as asked; null when it ran and exited (with any code).
  readonly error: { readonly kind: RunErrorKind; readonly reason: string } | null
}

// The project's settings this layer needs. The task `project-config` reads them from `.agent-queue.json`; its result
// fits this type, and tests pass their own.
export type ProjectTestSettings = {
  // The command of the full tests, a line for the system's shell.
  readonly testCommand: string
  // The command for Windows, when the project sets one.
  readonly testCommandWindows?: string | null
}

// The project's test command for the machine's system: on Windows the command for Windows when it is set, otherwise the
// main one.
export function projectTestCommand(machine: Pick<Machine, 'platform'>, settings: ProjectTestSettings): string {
  const windows = settings.testCommandWindows?.trim()
  return machine.platform === 'win32' && windows ? windows : settings.testCommand
}

export function runProjectTests(
  machine: Machine,
  settings: ProjectTestSettings,
  options: RunOptions = {},
): Promise<RunResult> {
  return runShell(machine, projectTestCommand(machine, settings), options)
}

// How the system's shell runs a command line: /bin/sh -c on macOS and Linux; on Windows cmd.exe (%ComSpec%) /d /s /c
// with the line in quotes and given verbatim — what Node does for `shell: true`.
export function shellInvocation(machine: Pick<Machine, 'platform' | 'env'>, line: string): Omit<StartRequest, 'env'> {
  if (machine.platform !== 'win32') return { file: '/bin/sh', args: ['-c', line] }
  return { file: windowsShell(machine), args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true }
}

// The exit codes with which the shell says it found no such command: 127 of sh, 9009 of cmd.exe.
const SHELL_NOT_FOUND: Record<'posix' | 'win32', number> = { posix: 127, win32: 9009 }

export async function runShell(machine: Machine, line: string, options: RunOptions = {}): Promise<RunResult> {
  const request = { ...shellInvocation(machine, line), env: mergeEnv(machine, options.env) }
  const result = await startTimed(machine, line, request, options)
  const notFound = SHELL_NOT_FOUND[machine.platform === 'win32' ? 'win32' : 'posix']
  if (result.error === null && result.code === notFound) {
    const said = firstLine(result.stderr) ?? firstLine(result.stdout)
    const reason = `the shell found no such command (exit ${notFound})${said ? `: ${said}` : ''}`
    return { ...result, error: { kind: 'not_found', reason } }
  }
  return result
}

// Runs a program — a name looked up in PATH, or a path — with its arguments, without a shell.
export async function runProgram(
  machine: Machine,
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const env = mergeEnv(machine, options.env)
  const file = resolveCommand({ ...machine, env }, command)
  if (file === null) {
    const at = machine.now()
    return {
      command,
      file: null,
      args,
      startedAt: new Date(at).toISOString(),
      durationMs: 0,
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
      truncated: false,
      error: { kind: 'not_found', reason: notFoundReason(machine, command, env) },
    }
  }
  return startTimed(machine, command, { ...programInvocation(machine, file, args), env }, options)
}

// How a resolved program starts: directly, or on Windows a .cmd or .bat file through cmd.exe, its path and arguments
// escaped for cmd.exe (the rules of the cross-spawn package: a batch file reads its arguments through cmd.exe twice).
export function programInvocation(
  machine: Pick<Machine, 'platform' | 'env'>,
  file: string,
  args: readonly string[],
): Omit<StartRequest, 'env'> {
  if (machine.platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) return { file, args }
  const line = [file.replace(CMD_META, '^$1'), ...args.map(quoteForBatchFile)].join(' ')
  return { file: windowsShell(machine), args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true }
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g

function quoteForBatchFile(arg: string): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`
  return quoted.replace(CMD_META, '^$1').replace(CMD_META, '^$1')
}

function windowsShell(machine: Pick<Machine, 'platform' | 'env'>): string {
  return envValue(machine, 'ComSpec')?.trim() || 'cmd.exe'
}

// The file the system's shell would run for `command`, or null. A command with a directory in it is that path (relative
// to the machine's working directory); a bare name is looked up in PATH. On Windows a name without an extension of
// PATHEXT gets each of them in turn, and PATH entries may be quoted.
export function resolveCommand(
  machine: Pick<Machine, 'platform' | 'env' | 'cwd' | 'isRunnableFile'>,
  command: string,
): string | null {
  const paths = pathsOf(machine)
  const windows = machine.platform === 'win32'
  const hasDirectory = windows ? /[\\/]/.test(command) : command.includes('/')
  const candidates = hasDirectory
    ? [paths.resolve(machine.cwd, command)]
    : searchPath(machine).map((dir) => paths.join(dir, command))
  const extensions = windows ? windowsExtensions(machine, command) : ['']
  for (const candidate of candidates) {
    for (const extension of extensions) {
      if (machine.isRunnableFile(candidate + extension)) return candidate + extension
    }
  }
  return null
}

function searchPath(machine: Pick<Machine, 'platform' | 'env' | 'cwd'>): string[] {
  const paths = pathsOf(machine)
  return (envValue(machine, 'PATH') ?? '')
    .split(paths.delimiter)
    .map((dir) => (machine.platform === 'win32' ? dir.replace(/^"(.*)"$/, '$1') : dir))
    .filter((dir) => dir !== '')
    .map((dir) => paths.resolve(machine.cwd, dir))
}

function windowsExtensions(machine: Pick<Machine, 'platform' | 'env'>, command: string): string[] {
  const known = (envValue(machine, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension.startsWith('.'))
  return known.includes(pathsOf(machine).extname(command).toLowerCase()) ? [''] : known
}

function notFoundReason(machine: Machine, command: string, env: Env): string {
  const windows = machine.platform === 'win32'
  if (windows ? /[\\/]/.test(command) : command.includes('/')) return `${command}: no such program`
  const dirs = searchPath({ ...machine, env })
  if (dirs.length === 0) return `${command} is not in PATH (PATH is empty)`
  return `${command} is not in PATH (${dirs.join(pathsOf(machine).delimiter)})`
}

async function startTimed(
  machine: Machine,
  command: string,
  request: StartRequest,
  options: RunOptions,
): Promise<RunResult> {
  const started = machine.now()
  const outcome = await machine
    .start({ ...request, cwd: options.cwd, timeoutMs: options.timeoutMs })
    .catch((error: unknown) => ({
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
      startError: { code: null, message: errorMessage(error) },
    }))
  const durationMs = Math.max(0, machine.now() - started)
  let error: RunResult['error'] = null
  if (outcome.startError !== null) {
    const missing = outcome.startError.code === 'ENOENT'
    error = {
      kind: missing ? 'not_found' : 'start_failed',
      reason: `${request.file}: ${missing ? 'no such program' : outcome.startError.message}`,
    }
  } else if (outcome.timedOut) {
    error = { kind: 'timed_out', reason: `stopped after ${options.timeoutMs} ms without an answer` }
  }
  return {
    command,
    file: request.file,
    args: request.args,
    startedAt: new Date(started).toISOString(),
    durationMs,
    code: outcome.code,
    signal: outcome.signal,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    truncated: outcome.truncated,
    error,
  }
}

function firstLine(text: string): string | undefined {
  return text.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '')
}
