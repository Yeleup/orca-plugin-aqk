// The file operations of the real machine: whether a file can be run, reading a text file, and creating a file only if
// it is absent, in a way no reader ever sees half written.
import { randomUUID } from 'node:crypto'
import {
  accessSync,
  constants,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { errorCode } from './errors'
import type { Platform } from './machine'

export function isRunnableFile(path: string, system: Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (system !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

// How the finished text gets the target's name; tests replace them to see the fallback and its order.
export type PublishOps = {
  link(existingPath: string, newPath: string): void
  rename(oldPath: string, newPath: string): void
}

const NODE_OPS: PublishOps = { link: linkSync, rename: renameSync }

// The errors of a file system without hard links (FAT, exFAT, some network shares).
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'])

// A lock older than this belongs to a writer that died: the next writer takes it over.
export const LOCK_STALE_MS = 10_000
const LOCK_WAIT_MS = 5_000

// Creates `path` with exactly `text` unless it exists, creating its directory first: true when this call created it.
// The text is written whole to a temporary file beside the target, and only then gets the target's name:
// - by a hard link, which fails with EEXIST when the name is taken;
// - on a file system without hard links, by a rename under a lock directory (mkdir is exclusive): the writer holding
//   the lock checks that the name is free and renames. A lock left by a writer that died is taken over.
// Either way a reader sees the whole text or no file, also after a writer was killed half way.
export async function createText(path: string, text: string, ops: PublishOps = NODE_OPS): Promise<boolean> {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx' })
  try {
    try {
      ops.link(temporary, path)
      return true
    } catch (error) {
      const code = errorCode(error)
      if (code === 'EEXIST') return false
      if (code === null || !NO_HARD_LINKS.has(code)) throw error
    }
    return await renameUnderLock(temporary, path, ops)
  } finally {
    try {
      unlinkSync(temporary)
    } catch {
      // Renamed to the target, or already gone.
    }
  }
}

async function renameUnderLock(temporary: string, path: string, ops: PublishOps): Promise<boolean> {
  const lock = `${path}.lock`
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
      if (lockAge(lock) > LOCK_STALE_MS) {
        removeLock(lock)
        continue
      }
      if (Date.now() > deadline) throw new Error(`${lock}: another writer holds the lock`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  try {
    if (existsSync(path)) return false
    ops.rename(temporary, path)
    return true
  } finally {
    removeLock(lock)
  }
}

function lockAge(lock: string): number {
  try {
    return Date.now() - statSync(lock).mtimeMs
  } catch {
    // Gone meanwhile: the next mkdir decides.
    return 0
  }
}

function removeLock(lock: string): void {
  try {
    rmdirSync(lock)
  } catch {
    // Another writer removed it first.
  }
}
