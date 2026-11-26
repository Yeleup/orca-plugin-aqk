// The coordinator id of this computer (TZ «Данные», «Состояние на компьютере»): random — a UUID v4, nothing from
// the computer's name, the user's name or paths — created once in the plugin's data directory and kept there forever.
// Every later start of the worker reads the same id back.
import { randomUUID } from 'node:crypto'
import type { Machine } from './machine'
import { dataPath } from './paths'

export const COORDINATOR_ID_FILE = 'coordinator-id'

const ID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function isCoordinatorId(value: string): boolean {
  return ID_FORMAT.test(value)
}

// The id kept in `dataDir`, created there first if the directory has none. Two workers starting at once agree on one
// id: the file is created only if absent, and whoever loses reads the winner's. A file that holds anything else than an
// id is never replaced (the id must stay): it is an error with the file's path.
export function ensureCoordinatorId(
  machine: Pick<Machine, 'platform' | 'readText' | 'createText'>,
  dataDir: string,
  newId: () => string = randomUUID,
): string {
  const file = dataPath(machine, dataDir, COORDINATOR_ID_FILE)
  const stored = machine.readText(file)
  if (stored === null) {
    const id = newId()
    if (!isCoordinatorId(id)) throw new Error(`not a coordinator id: ${id}`)
    if (machine.createText(file, `${id}\n`)) return id
  }
  const kept = (stored ?? machine.readText(file) ?? '').trim()
  if (!isCoordinatorId(kept)) throw new Error(`${file} holds no coordinator id; it is kept as it is`)
  return kept
}
