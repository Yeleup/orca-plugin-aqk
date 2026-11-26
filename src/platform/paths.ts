// Paths by the rules of the machine's system: the plugin's data directory outside every repository, files in it, and
// files in a worktree. Every path these functions return uses only the system's separator (`\` on Windows, `/`
// elsewhere): on Windows a path from git (`C:/Users/…`) and the same path from Orca (`C:\Users\…`) come out alike.
import { createHash } from 'node:crypto'
import { localAppData, xdgHome } from './folders'
import { pathsOf, type Machine } from './machine'

// The name of the plugin's directory inside the system's place for per-user application data.
export const DATA_DIRECTORY_NAME = 'orca-agent-queue'

// The plugin's data directory on this computer (TZ «Данные», «Состояние на компьютере»), by the rules of the system:
// - Windows: %LOCALAPPDATA%\orca-agent-queue when the worker's environment has an absolute LOCALAPPDATA, otherwise
//   <home>\AppData\Local\orca-agent-queue. Local, not Roaming: a roaming profile would carry the coordinator id to
//   another computer.
// - macOS: ~/Library/Application Support/orca-agent-queue.
// - Linux: $XDG_DATA_HOME/orca-agent-queue when the worker's environment has an absolute XDG_DATA_HOME, otherwise
//   ~/.local/share/orca-agent-queue (XDG Base Directory).
// Orca does not pass LOCALAPPDATA or XDG_DATA_HOME to the worker, so a location the user moved does not count
// (folders.ts); nothing is asked of the system, and the directory is the same on every start.
export function dataDirectory(machine: Pick<Machine, 'platform' | 'env' | 'homedir'>): string {
  const paths = pathsOf(machine)
  let base: string
  if (machine.platform === 'win32') base = localAppData(machine)
  else if (machine.platform === 'darwin') base = paths.join(machine.homedir, 'Library', 'Application Support')
  else base = xdgHome(machine, 'XDG_DATA_HOME')
  return nativePath(machine, paths.join(base, DATA_DIRECTORY_NAME))
}

// A file or directory inside the data directory: each name is one plain path component.
export function dataPath(machine: Pick<Machine, 'platform'>, dataDir: string, ...names: string[]): string {
  for (const name of names) {
    if (name === '' || name === '.' || name === '..' || /[\\/]/.test(name)) {
      throw new Error(`not a plain name inside the data directory: ${JSON.stringify(name)}`)
    }
  }
  return nativePath(machine, pathsOf(machine).join(dataDir, ...names))
}

// A plain name inside the data directory for any id — a project's id may hold `/`, `:`, capitals or anything else: the
// id's letters, digits, `.`, `_` and `-` (others become `-`), lower-cased, without leading `.`, `_` and `-`, cut to 40,
// then `-` and 12 hex digits of the id's SHA-256. Two ids never share a name, also on the file systems of Windows and
// macOS, where names have no case; the name stays the same for the same id on every system.
export function dataName(id: string): string {
  const readable = id
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+/, '')
    .slice(0, 40)
    .replace(/[.-]+$/, '')
  const hash = createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 12)
  return readable === '' ? hash : `${readable}-${hash}`
}

// The path in the machine's own form: on Windows forward slashes become backslashes; `.` and doubled separators go.
export function nativePath(machine: Pick<Machine, 'platform'>, path: string): string {
  const normalized = pathsOf(machine).normalize(path)
  return normalized.length > 1 && /[\\/]$/.test(normalized) && !/^[A-Za-z]:[\\/]$/.test(normalized)
    ? normalized.slice(0, -1)
    : normalized
}

// A file of a worktree: `worktree` is its root as Orca or git gives it, `repoPath` a path inside the repository as git
// prints it (`src/app/main.ts`, always with `/`). A path that leaves the worktree is refused.
export function worktreeFile(machine: Pick<Machine, 'platform'>, worktree: string, repoPath: string): string {
  const paths = pathsOf(machine)
  if (!paths.isAbsolute(worktree)) throw new Error(`a worktree path must be absolute: ${worktree}`)
  const parts = repoPath.split(machine.platform === 'win32' ? /[\\/]/ : /\//)
  if (paths.isAbsolute(repoPath) || parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`not a path inside the repository: ${repoPath}`)
  }
  return nativePath(machine, paths.join(worktree, ...parts))
}
