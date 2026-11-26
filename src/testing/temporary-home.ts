// Runs a test body with the worker's home directory in a new temporary directory and no data-directory variables, then
// puts the environment back: the real worker module (src/worker.ts) then keeps its data directory and coordinator id
// there, never in the real data directory of this computer.
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
    delete env.XDG_DATA_HOME
    delete env.LOCALAPPDATA
    await body(home)
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete env[name]
      else env[name] = value
    }
    rmSync(home, { recursive: true, force: true })
  }
}
