// The system's per-user folders, from the home directory and the worker's own environment only — no process is started
// and nothing else is asked (decision «🤖 Решение по #4: question»): the data directory must come out the same on every
// start of the worker, since it keeps the coordinator id forever. A variable counts only when it is in the worker's
// environment and is an absolute path; Orca 1.4.273+ leaves LOCALAPPDATA, XDG_DATA_HOME and XDG_CACHE_HOME out of a
// trusted-worker's environment (machine.ts), so today the defaults under the home directory apply.
import { absoluteEnvPath, pathsOf, type Machine } from './machine'

type FolderMachine = Pick<Machine, 'platform' | 'env' | 'homedir'>

// Windows' Local AppData: %LOCALAPPDATA% when the worker has it, otherwise <home>\AppData\Local.
export function localAppData(machine: FolderMachine): string {
  return absoluteEnvPath(machine, 'LOCALAPPDATA') ?? pathsOf(machine).join(machine.homedir, 'AppData', 'Local')
}

// XDG Base Directory on Linux: $XDG_DATA_HOME (~/.local/share) and $XDG_CACHE_HOME (~/.cache).
export function xdgHome(machine: FolderMachine, name: 'XDG_DATA_HOME' | 'XDG_CACHE_HOME'): string {
  const fallback = name === 'XDG_DATA_HOME' ? ['.local', 'share'] : ['.cache']
  return absoluteEnvPath(machine, name) ?? pathsOf(machine).join(machine.homedir, ...fallback)
}
