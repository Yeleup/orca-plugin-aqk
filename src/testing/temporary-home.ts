// Runs a test body with the worker's home directory and the data variables of each system (XDG_DATA_HOME, LOCALAPPDATA)
// in a new temporary directory, then puts the environment back: the real worker module (src/worker.ts) then keeps its
// data directory and coordinator id there, never in the real data directory of this computer, and looks up no system
// folder.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env } from 'node:process'

export async function withTemporaryHome(body: (home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'agent-queue-home-'))
  const names = ['HOME', 'USERPROFILE', 'XDG_DATA_HOME', 'LOCALAPPDATA']
  const saved = names.map((name) => [name, env[name]] as const)
  try {
    env.HOME = home
    env.USERPROFILE = home
    env.XDG_DATA_HOME = join(home, 'data')
    env.LOCALAPPDATA = join(home, 'local')
    await body(home)
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete env[name]
      else env[name] = value
    }
    rmSync(home, { recursive: true, force: true })
  }
}
