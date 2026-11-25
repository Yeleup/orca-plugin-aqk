// The tools of a worktree of this plugin, for its preparation (scripts/setup.mjs, `setup` in orca.yaml) and its tests.
// Node only, no packages: the same code runs on macOS, Windows and Linux.
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, extname, join, resolve } from 'node:path'

// The installation of the development tools (TypeScript from package-lock.json) without bin links: npm's links in
// node_modules/.bin are symlinks, and `orca plugin inspect` refuses a plugin folder that holds one. README names the
// same command as the preparation command.
export const INSTALL_ARGS = ['ci', '--no-audit', '--no-fund', '--no-bin-links']

// The tools `setup` needs besides Orca's CLI.
export const REQUIRED_TOOLS = ['git', 'node', 'npm']

// Orca's CLI: ORCA_CLI_COMMAND when set (Orca's terminals set it); otherwise `orca` on macOS and Windows and `orca-ide`
// elsewhere — never a bare `orca` on Linux: outside Orca's terminals that is GNOME's screen reader.
export function orcaCliCommand(env = process.env, platform = process.platform) {
  const named = envValue(env, 'ORCA_CLI_COMMAND', platform)?.trim()
  if (named) return named
  return platform === 'darwin' || platform === 'win32' ? 'orca' : 'orca-ide'
}

// The file a shell of this system runs for `command`, or null: a command with a directory in it is that path; a bare
// name is looked up in PATH, on Windows with the extensions of PATHEXT.
export function findCommand(command, env = process.env) {
  const windows = process.platform === 'win32'
  const candidates = /[\\/]/.test(command)
    ? [resolve(command)]
    : (envValue(env, 'PATH') ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, command))
  const extensions = windows ? windowsExtensions(command, env) : ['']
  for (const candidate of candidates) {
    for (const extension of extensions) {
      if (runnable(candidate + extension, windows)) return candidate + extension
    }
  }
  return null
}

// The tools `setup` needs that this system does not have, by the names `setup` reports.
export function missingTools(env = process.env, platform = process.platform) {
  const missing = REQUIRED_TOOLS.filter((tool) => findCommand(tool, env) === null)
  const cli = orcaCliCommand(env, platform)
  if (findCommand(cli, env) === null) missing.push(`Orca CLI (${cli})`)
  return missing
}

// On Windows a name with an extension of PATHEXT runs as it is; any other name runs with one of them added.
function windowsExtensions(command, env) {
  const known = (envValue(env, 'PATHEXT', 'win32') ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
    .map((extension) => extension.toLowerCase())
  return known.includes(extname(command).toLowerCase()) ? [''] : known
}

function runnable(file, windows) {
  try {
    if (!statSync(file).isFile()) return false
    if (!windows) accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

// An environment variable; on Windows its name has no case (PATH is often `Path` there).
function envValue(env, name, platform = process.platform) {
  if (platform !== 'win32') return env[name]
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name)
  return key === undefined ? undefined : env[key]
}
