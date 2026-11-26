// The search for Orca's CLI (TZ Ф14, «CLI Orca»). The worker's environment is filtered, so ORCA_CLI_COMMAND (set in
// Orca's terminals) may be missing there, and the plugin looks for the CLI itself:
//   1. ORCA_CLI_COMMAND, when set;
//   2. otherwise by the system — `orca-ide` on Linux, `orca` on macOS and Windows — in PATH;
//   3. not in PATH: the known paths of the CLI in Orca's installation on this system (knownOrcaCliPaths).
// A bare `orca` on Linux is never started: outside Orca's terminals it is GNOME's screen reader. Each CLI found must
// answer `status --json` with `ok: true`; one that does not is passed over for the next. None at all — the result
// «CLI Orca не найден» (code `orca_cli_not_found`) with the reason; the row of «Проверка проекта» about it and the
// refusal to create a worktree come with the tasks `doctor` and `worktree`.
import { localAppData, xdgHome } from './folders'
import { absoluteEnvPath, envValue, pathsOf, type Machine } from './machine'
import { resolveCommand, runProgram } from './run'

export const ORCA_CLI_NOT_FOUND = 'orca_cli_not_found'

// How long `status` may take before the CLI counts as not answering.
export const STATUS_TIMEOUT_MS = 20_000

export type OrcaCliSource = 'ORCA_CLI_COMMAND' | 'PATH' | 'known path'

// A candidate that was not taken, and why.
export type OrcaCliAttempt = {
  readonly source: OrcaCliSource
  // The name or path as the source gives it.
  readonly command: string
  // The file it resolved to, or null.
  readonly file: string | null
  readonly problem: string
}

export type OrcaCliSearch =
  | {
      readonly found: true
      // The CLI to start: an absolute path.
      readonly file: string
      readonly source: OrcaCliSource
      // Orca's version from the answer of `status`, when it gives one.
      readonly version: string | null
      readonly tried: readonly OrcaCliAttempt[]
    }
  | {
      readonly found: false
      // «CLI Orca не найден».
      readonly code: typeof ORCA_CLI_NOT_FOUND
      readonly reason: string
      readonly tried: readonly OrcaCliAttempt[]
    }

// The name of Orca's CLI on the system (Orca 1.4.273 documentation; Orca's own
// src/shared/cli/orca-cli-command-name.ts): `orca-ide` on Linux, `orca` on macOS and Windows.
export function orcaCliName(machine: Pick<Machine, 'platform'>): 'orca-ide' | 'orca' {
  return machine.platform === 'linux' ? 'orca-ide' : 'orca'
}

// Exactly the bare name `orca` on Linux: GNOME's screen reader, never Orca's CLI. A path ending in `orca` (the CLI shim
// of Orca's terminals) is not bare.
export function isScreenReader(machine: Pick<Machine, 'platform'>, command: string): boolean {
  return machine.platform === 'linux' && command.trim() === 'orca'
}

// Where Orca's installation puts its CLI on each system, in the order they are tried. From the code of Orca 1.4.274
// (out/main of its app.asar: the CLI installer, the bundled CLI of each system, the deb/rpm after-install script):
// - First, on every system, the CLI of the very Orca that runs the worker: the worker is forked from Orca's main
//   process, so `execPath` is Orca's executable and its resources hold the CLI — <dir>/resources/bin/orca-ide on Linux,
//   <dir>\resources\bin\orca.exe on Windows (any install directory, e.g. NSIS /D), <App>.app/Contents/Resources/bin/orca
//   on macOS.
// - Linux: ~/.local/bin/orca-ide — the command Orca registers; <XDG cache>/orca/appimage/launcher/orca-ide (by default
//   ~/.cache/…) — the stable launcher of the AppImage; /usr/bin/orca-ide — the link the deb and rpm packages make; the
//   CLI inside those packages in /opt/Orca, /opt/orca-ide or /opt/orca. XDG_CACHE_HOME counts only when the worker has it
//   (folders.ts).
// - macOS: /usr/local/bin/orca, or ~/.local/bin/orca where /usr/local/bin is missing — the command Orca registers;
//   Orca.app in /Applications or ~/Applications.
// - Windows: Orca in <Local AppData>\Programs\Orca (per user; %LOCALAPPDATA% when the worker has it, otherwise
//   <home>\AppData\Local, folders.ts) or in <Program Files>\Orca (all users; ProgramFiles when the worker has it,
//   otherwise <SYSTEMDRIVE>\Program Files).
export function knownOrcaCliPaths(machine: Pick<Machine, 'platform' | 'env' | 'homedir' | 'execPath'>): string[] {
  const paths = pathsOf(machine)
  const home = machine.homedir
  const own = runningOrcaCli(machine)
  const known: string[] = own === null ? [] : [own]
  if (machine.platform === 'linux') {
    const cache = xdgHome(machine, 'XDG_CACHE_HOME')
    known.push(
      paths.join(home, '.local', 'bin', 'orca-ide'),
      paths.join(cache, 'orca', 'appimage', 'launcher', 'orca-ide'),
      '/usr/bin/orca-ide',
      ...['/opt/Orca', '/opt/orca-ide', '/opt/orca'].map((dir) => paths.join(dir, 'resources', 'bin', 'orca-ide')),
    )
  } else if (machine.platform === 'darwin') {
    const bundled = paths.join('Orca.app', 'Contents', 'Resources', 'bin', 'orca')
    known.push(
      '/usr/local/bin/orca',
      paths.join(home, '.local', 'bin', 'orca'),
      paths.join('/Applications', bundled),
      paths.join(home, 'Applications', bundled),
    )
  } else {
    const bundled = paths.join('resources', 'bin', 'orca.exe')
    const drive = (envValue(machine, 'SYSTEMDRIVE')?.trim() || 'C:').replace(/[\\/]+$/, '')
    const programFiles = absoluteEnvPath(machine, 'ProgramFiles') ?? `${drive}\\Program Files`
    known.push(
      paths.join(localAppData(machine), 'Programs', 'Orca', bundled),
      paths.join(programFiles, 'Orca', bundled),
    )
  }
  return [...new Set(known.map((path) => paths.normalize(path)))]
}

// The CLI in the resources of the Orca whose executable is `execPath`, or null when `execPath` is not an app's.
function runningOrcaCli(machine: Pick<Machine, 'platform' | 'execPath'>): string | null {
  const paths = pathsOf(machine)
  if (!paths.isAbsolute(machine.execPath)) return null
  const dir = paths.dirname(machine.execPath)
  if (machine.platform === 'darwin') {
    if (paths.basename(dir) !== 'MacOS' || paths.basename(paths.dirname(dir)) !== 'Contents') return null
    return paths.join(paths.dirname(dir), 'Resources', 'bin', 'orca')
  }
  return paths.join(dir, 'resources', 'bin', machine.platform === 'win32' ? 'orca.exe' : 'orca-ide')
}

export async function findOrcaCli(machine: Machine, options: { timeoutMs?: number } = {}): Promise<OrcaCliSearch> {
  const tried: OrcaCliAttempt[] = []
  const checked = new Set<string>()
  const timeoutMs = options.timeoutMs ?? STATUS_TIMEOUT_MS

  const attempt = async (
    source: OrcaCliSource,
    command: string,
    file: string | null,
  ): Promise<OrcaCliSearch | null> => {
    if (file === null) {
      const problem = source === 'PATH' ? 'not in PATH' : source === 'known path' ? 'no such file' : 'not found'
      tried.push({ source, command, file, problem })
      return null
    }
    if (checked.has(file)) return null
    checked.add(file)
    const answer = await statusOf(machine, file, timeoutMs)
    if (answer.ok) return { found: true, file, source, version: answer.version, tried }
    tried.push({ source, command, file, problem: answer.problem })
    return null
  }

  const named = envValue(machine, 'ORCA_CLI_COMMAND')?.trim()
  if (named) {
    if (isScreenReader(machine, named)) {
      tried.push({
        source: 'ORCA_CLI_COMMAND',
        command: named,
        file: null,
        problem: "a bare orca on Linux is GNOME's screen reader, not Orca's CLI: not started",
      })
    } else {
      const found = await attempt('ORCA_CLI_COMMAND', named, resolveCommand(machine, named))
      if (found) return found
    }
  }

  const name = orcaCliName(machine)
  const inPath = await attempt('PATH', name, resolveCommand(machine, name))
  if (inPath) return inPath

  for (const path of knownOrcaCliPaths(machine)) {
    const found = await attempt('known path', path, machine.isRunnableFile(path) ? path : null)
    if (found) return found
  }

  return {
    found: false,
    code: ORCA_CLI_NOT_FOUND,
    reason: tried.map(describeAttempt).join('; '),
    tried,
  }
}

function describeAttempt(entry: OrcaCliAttempt): string {
  const file = entry.file !== null && entry.file !== entry.command ? ` (${entry.file})` : ''
  return `${entry.command}${file}: ${entry.problem}`
}

// The answer of `<cli> status --json`: Orca's CLI prints a JSON object with `ok: true` (and Orca's version in
// result.runtime.appVersion); on a failure `ok: false` with error.message.
async function statusOf(
  machine: Machine,
  file: string,
  timeoutMs: number,
): Promise<{ ok: true; version: string | null } | { ok: false; problem: string }> {
  const result = await runProgram(machine, file, ['status', '--json'], { timeoutMs })
  if (result.error !== null) return { ok: false, problem: `orca status: ${result.error.reason}` }
  let answer: unknown
  try {
    answer = JSON.parse(result.stdout)
  } catch {
    const said = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/)[0] ?? ''
    return { ok: false, problem: `orca status answered no JSON (exit ${result.code})${said ? `: ${said}` : ''}` }
  }
  const field = (value: unknown, key: string): unknown =>
    typeof value === 'object' && value !== null && key in value ? (value as Record<string, unknown>)[key] : undefined
  if (field(answer, 'ok') !== true) {
    const message = field(field(answer, 'error'), 'message')
    const said = typeof message === 'string' ? `: ${message}` : ''
    return { ok: false, problem: `orca status: not ok${said} (exit ${result.code})` }
  }
  if (result.code !== 0) return { ok: false, problem: `orca status: exit ${result.code}` }
  const version = field(field(field(answer, 'result'), 'runtime'), 'appVersion')
  return { ok: true, version: typeof version === 'string' ? version : null }
}
