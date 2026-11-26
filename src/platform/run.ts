// Running external commands — git, gh, Orca's CLI, the project's test command — by the rules of the machine's
// system, each with its exit code, output, start time and duration. A program is looked up in PATH the way the
// system's shell does (on Windows with the extensions of PATHEXT); a .cmd or .bat file on Windows goes through cmd.exe,
// since Windows starts only .exe files directly. The project's test command is a line for the system's shell:
// /bin/sh -c on macOS and Linux, cmd.exe /d /s /c on Windows, where the project may name a command of its own.
// A relative command path, relative PATH entries and the run itself all count from the run's `cwd`.
import { commandEnv } from './folders'
import { envValue, errorMessage, pathsOf, type Env, type Machine, type StartRequest } from './machine'

export type RunOptions = {
  // The run's working directory (relative: from the machine's); by default the machine's.
  readonly cwd?: string
  // Variables on top of the machine's environment.
  readonly env?: Env
  readonly timeoutMs?: number
  // A file that gets the full output, both streams as they come (StartRequest.outputFile).
  readonly outputFile?: string
  readonly maxOutput?: number
}

export type RunErrorKind =
  // The program, or the command of a shell line, does not exist.
  | 'not_found'
  // The system refused to start it (permissions, a broken file, a directory cmd.exe cannot use …).
  | 'start_failed'
  // It ran longer than `timeoutMs` and was stopped.
  | 'timed_out'
  // It ran, but `outputFile` could not be written whole: the run's full output is not kept.
  | 'output_failed'

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

export async function runShell(machine: Machine, line: string, options: RunOptions = {}): Promise<RunResult> {
  const cwd = runDirectory(machine, options)
  const env = commandEnv(machine, options.env)
  const result = await startTimed(machine, line, { ...shellInvocation(machine, line), env, cwd }, options)
  const notFound = machine.platform === 'win32' ? 9009 : 127
  if (result.error !== null || result.code !== notFound) return result
  const said = firstLine(result.stderr) ?? firstLine(result.stdout)
  const reason = `the shell found no such command (exit ${notFound})${said ? `: ${said}` : ''}`
  return { ...result, error: { kind: 'not_found', reason } }
}

// The shell's own verdict decides «not found»: exit 127 of sh, exit 9009 of cmd.exe (its ERRORLEVEL for a command it
// cannot find). Any other exit is the command's own result, kept with its code and output — also when cmd.exe reports
// a missing command with exit 1, which a program that ran may return too: the shell's message is then in `stderr`.
// Which of the two cmd.exe /c returns for a missing command is proven only on real Windows (CI of task `ci`).

// Runs a program — a name looked up in PATH, or a path — with its arguments, without a shell.
export async function runProgram(
  machine: Machine,
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const cwd = runDirectory(machine, options)
  const env = commandEnv(machine, options.env)
  const file = resolveCommand({ ...machine, env, cwd }, command)
  if (file === null) {
    return notStarted(machine, command, args, 'not_found', notFoundReason({ ...machine, env, cwd }, command))
  }
  let invocation: Omit<StartRequest, 'env'>
  try {
    invocation = programInvocation(machine, file, args)
  } catch (error) {
    return notStarted(machine, command, args, 'start_failed', errorMessage(error))
  }
  return startTimed(machine, command, { ...invocation, env, cwd }, options)
}

// How a resolved program starts: directly, or on Windows a .cmd or .bat file through cmd.exe (Windows starts only .exe
// files directly). A batch file's arguments are read by cmd.exe more than once — on the cmd.exe /c line, and again
// wherever the batch file passes %* or %1 on (wrappers, npm's cmd-shims) — so they follow the rules Rust's standard
// library adopted for batch files (CVE-2024-24576): each argument that needs it goes in double quotes, a quote inside
// is doubled (`""`), so cmd.exe never leaves the quotes and & | < > ( ) ^ stay text on every pass, and each % becomes
// `%%cd:~,%`, which cmd.exe expands to a lone % instead of a variable. Delayed expansion is off (/v:OFF), command
// extensions on (/e:ON). A batch file gets %1 in quotes and %~1 without them; a program a wrapper hands %* to reads
// `""` inside quotes as one quote. An argument with a line break or NUL cannot reach a batch file intact: refused.
export function programInvocation(
  machine: Pick<Machine, 'platform' | 'env'>,
  file: string,
  args: readonly string[],
): Omit<StartRequest, 'env'> {
  if (machine.platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) return { file, args }
  const line = [`"${file}"`, ...args.map(batchArgument)].join(' ')
  const cmdArgs = ['/e:ON', '/v:OFF', '/d', '/c', `"${line}"`]
  return { file: windowsShell(machine), args: cmdArgs, windowsVerbatimArguments: true }
}

// One argument of a batch file on a cmd.exe line: Rust std's `append_bat_arg` (its Windows args module).
export function batchArgument(arg: string): string {
  if (/[\r\n\0]/.test(arg)) {
    throw new Error(`an argument for a batch file cannot hold a line break or NUL: ${JSON.stringify(arg)}`)
  }
  const quote = arg === '' || arg.endsWith('\\') || /[\x00-\x20!"%&'(),;<=>[\]^`{|}~\x7f]/.test(arg)
  let out = ''
  let backslashes = 0
  for (const char of arg) {
    if (char === '\\') {
      backslashes++
      out += char
      continue
    }
    if (char === '"') out += `${'\\'.repeat(backslashes)}"`
    else if (char === '%') out += '%%cd:~,'
    backslashes = 0
    out += char
  }
  return quote ? `"${out}${'\\'.repeat(backslashes)}"` : out
}

function windowsShell(machine: Pick<Machine, 'platform' | 'env'>): string {
  return envValue(machine, 'ComSpec')?.trim() || 'cmd.exe'
}

// The run's working directory: its own `cwd` (relative to the machine's), otherwise the machine's.
function runDirectory(machine: Pick<Machine, 'platform' | 'cwd'>, options: RunOptions): string {
  return options.cwd === undefined ? machine.cwd : pathsOf(machine).resolve(machine.cwd, options.cwd)
}

// The file the system's shell would run for `command`, or null. A command with a directory in it is that path (relative
// to `cwd`); a bare name is looked up in PATH (relative entries from `cwd`). On Windows a name without an extension of
// PATHEXT gets each of them in turn, and PATH entries may be quoted.
export function resolveCommand(
  machine: Pick<Machine, 'platform' | 'env' | 'cwd' | 'isRunnableFile'>,
  command: string,
): string | null {
  const paths = pathsOf(machine)
  const windows = machine.platform === 'win32'
  const candidates = hasDirectory(machine, command)
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

function hasDirectory(machine: Pick<Machine, 'platform'>, command: string): boolean {
  return machine.platform === 'win32' ? /[\\/]/.test(command) : command.includes('/')
}

function searchPath(machine: Pick<Machine, 'platform' | 'env' | 'cwd'>): string[] {
  const paths = pathsOf(machine)
  return (envValue(machine, 'PATH') ?? '')
    .split(paths.delimiter)
    .map((dir) => (machine.platform === 'win32' ? dir.replace(/^"(.*)"$/, '$1') : dir))
    .filter((dir) => dir !== '')
    .map((dir) => paths.resolve(machine.cwd, dir))
}

// The extensions to try after `command` on Windows: a name without an extension gets each of PATHEXT; a name with one
// is tried as given first (an explicit orca.exe runs whatever PATHEXT holds), then with PATHEXT's when its own is not
// among them.
function windowsExtensions(machine: Pick<Machine, 'platform' | 'env'>, command: string): string[] {
  const known = (envValue(machine, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension.startsWith('.'))
  const own = pathsOf(machine).extname(command).toLowerCase()
  if (own === '') return known
  return known.includes(own) ? [''] : ['', ...known]
}

function notFoundReason(machine: Pick<Machine, 'platform' | 'env' | 'cwd'>, command: string): string {
  if (hasDirectory(machine, command)) return `${pathsOf(machine).resolve(machine.cwd, command)}: no such program`
  const dirs = searchPath(machine)
  if (dirs.length === 0) return `${command} is not in PATH (PATH is empty)`
  return `${command} is not in PATH (${dirs.join(pathsOf(machine).delimiter)})`
}

function notStarted(
  machine: Pick<Machine, 'now'>,
  command: string,
  args: readonly string[],
  kind: RunErrorKind,
  reason: string,
): RunResult {
  return {
    command,
    file: null,
    args,
    startedAt: new Date(machine.now()).toISOString(),
    durationMs: 0,
    code: null,
    signal: null,
    stdout: '',
    stderr: '',
    truncated: false,
    error: { kind, reason },
  }
}

// cmd.exe cannot work in a UNC directory (\\server\share\…): it would warn and run in the Windows directory instead.
function isUncDirectory(machine: Pick<Machine, 'platform'>, cwd: string | undefined): boolean {
  return machine.platform === 'win32' && cwd !== undefined && /^[\\/]{2}/.test(cwd)
}

async function startTimed(
  machine: Machine,
  command: string,
  request: StartRequest,
  options: RunOptions,
): Promise<RunResult> {
  if (isUncDirectory(machine, request.cwd) && /(^|[\\/])cmd(\.exe)?$/i.test(request.file)) {
    const reason = `cmd.exe cannot run in a UNC directory (${request.cwd}); use a directory on a drive letter`
    return notStarted(machine, command, request.args, 'start_failed', reason)
  }
  const started = machine.now()
  const outcome = await machine
    .start({ ...request, timeoutMs: options.timeoutMs, outputFile: options.outputFile, maxOutput: options.maxOutput })
    .catch((error: unknown) => ({
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
      outputError: null,
      stopError: null,
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
    const tree = outcome.stopError === null ? '' : `; ${outcome.stopError}`
    error = { kind: 'timed_out', reason: `stopped after ${options.timeoutMs} ms without an answer${tree}` }
  } else if (outcome.outputError !== null) {
    error = { kind: 'output_failed', reason: outcome.outputError }
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
