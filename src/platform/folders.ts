// The system's per-user folders that the worker's environment does not name. Orca leaves LOCALAPPDATA, XDG_DATA_HOME
// and XDG_CACHE_HOME out of a trusted-worker's environment (machine.ts), so the plugin asks the system for them.
import { win32 } from 'node:path'
import { absoluteEnvPath, pathsOf, type Machine } from './machine'

// How long Windows may take to name a folder before its default is used.
export const FOLDER_QUERY_TIMEOUT_MS = 20_000

// Prints FOLDERID_LocalAppData as Windows names it (SHGetFolderPath behind .NET's GetFolderPath), in UTF-8.
export const LOCAL_APP_DATA_SCRIPT =
  "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::Out.Write([Environment]::GetFolderPath('LocalApplicationData'))"

type FolderMachine = Pick<Machine, 'platform' | 'env' | 'homedir' | 'start'>

const localAppDataOf = new WeakMap<object, Promise<string>>()

// Windows' Local AppData of this user: LOCALAPPDATA when the environment has it; otherwise the folder Windows names
// (powershell.exe, asked once per machine); if that fails, its default <home>\AppData\Local.
export function localAppData(machine: FolderMachine): Promise<string> {
  let known = localAppDataOf.get(machine)
  if (known === undefined) {
    known = askLocalAppData(machine)
    localAppDataOf.set(machine, known)
  }
  return known
}

// The PowerShell of every Windows since 7, under %SystemRoot% (SYSTEMROOT is in the worker's environment).
export function windowsPowerShell(machine: Pick<Machine, 'platform' | 'env'>): string {
  const root = absoluteEnvPath(machine, 'SYSTEMROOT') ?? 'C:\\Windows'
  return win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

async function askLocalAppData(machine: FolderMachine): Promise<string> {
  const fromEnv = absoluteEnvPath(machine, 'LOCALAPPDATA')
  if (fromEnv) return fromEnv
  const outcome = await machine
    .start({
      file: windowsPowerShell(machine),
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', LOCAL_APP_DATA_SCRIPT],
      env: machine.env,
      timeoutMs: FOLDER_QUERY_TIMEOUT_MS,
    })
    .catch(() => null)
  const named = outcome?.code === 0 ? outcome.stdout.replace(/^\uFEFF/, '').trim() : ''
  return named && win32.isAbsolute(named) ? named : pathsOf(machine).join(machine.homedir, 'AppData', 'Local')
}

// $XDG_DATA_HOME or $XDG_CACHE_HOME of Linux when known (absolute), otherwise undefined: the caller takes the default
// of the XDG Base Directory specification.
export async function xdgHome(
  machine: FolderMachine,
  name: 'XDG_DATA_HOME' | 'XDG_CACHE_HOME',
): Promise<string | undefined> {
  return absoluteEnvPath(machine, name)
}
