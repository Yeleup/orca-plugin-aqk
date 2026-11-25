// `setup` of orca.yaml: prepares a worktree of this plugin on macOS, Windows and Linux. Orca runs that hook through bash
// on macOS and Linux and through a .cmd file on Windows, so the hook only calls this script.
//
// Checks that the system has git, node, npm and Orca's CLI, then installs the development tools without bin links
// (scripts/tools.mjs, INSTALL_ARGS) into the worktree's node_modules/. Exit code: 1 when a tool is missing, npm's own
// otherwise.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { INSTALL_ARGS, missingTools } from './tools.mjs'

const worktree = fileURLToPath(new URL('..', import.meta.url))

const missing = missingTools()
if (missing.length > 0) {
  console.error(`orca-plugin-aqk worktree: missing tools: ${missing.join(', ')}`)
  process.exit(1)
}

// npm is npm.cmd on Windows, which Node starts only through the shell; the arguments are fixed words, nothing to quote.
const npm =
  process.platform === 'win32'
    ? spawnSync(`npm ${INSTALL_ARGS.join(' ')}`, { cwd: worktree, stdio: 'inherit', shell: true })
    : spawnSync('npm', INSTALL_ARGS, { cwd: worktree, stdio: 'inherit' })
if (npm.error) {
  console.error(`orca-plugin-aqk worktree: npm did not start: ${npm.error.message}`)
  process.exit(1)
}
process.exit(npm.status ?? 1)
