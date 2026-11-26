// The system's per-user folders, from the home directory and the worker's own environment only — no process is started
// and nothing else is asked (decision «🤖 Решение по #4: question»): the data directory must come out the same on every
// start of the worker, since it keeps the coordinator id forever. A variable counts only when it is in the worker's
// environment and is an absolute path; Orca 1.4.273+ leaves LOCALAPPDATA, XDG_DATA_HOME and XDG_CACHE_HOME out of a
// trusted-worker's environment (machine.ts), so today the defaults under the home directory apply.
import { absoluteEnvPath, mergeEnv, pathsOf, type Env, type Machine } from './machine'

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

// The environment of a program the plugin starts (git, gh, Orca's CLI, the project's tests): the worker's own with
// `extra` on top, and on Windows the per-user folder variables Windows gives every user session, where the worker
// lacks them: APPDATA (<home>\AppData\Roaming) and LOCALAPPDATA (as localAppData above). Programs find their usual
// configuration there — gh keeps its login in %APPDATA%\GitHub CLI, and without APPDATA it would look in
// ~\.config\gh. The values come from the home directory by the same rule as the data directory (decision «🤖 Решение
// по #4: question»): no process is started, a folder the user moved elsewhere does not count, nothing is read or
// copied. macOS and Linux need none: there a missing XDG variable means its default under the home directory to every
// program.
export function commandEnv(machine: FolderMachine, extra: Env = {}): Env {
  const env = mergeEnv(machine, extra)
  if (machine.platform !== 'win32') return env
  const run = { platform: machine.platform, env, homedir: machine.homedir }
  const missing: Record<string, string> = {}
  if (absoluteEnvPath(run, 'APPDATA') === undefined) {
    missing.APPDATA = pathsOf(machine).join(machine.homedir, 'AppData', 'Roaming')
  }
  if (absoluteEnvPath(run, 'LOCALAPPDATA') === undefined) missing.LOCALAPPDATA = localAppData(run)
  return mergeEnv(run, missing)
}
