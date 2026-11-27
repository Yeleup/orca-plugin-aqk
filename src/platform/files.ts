// The file operations of the real machine: whether a file can be run, reading a text file and the time of its last
// write, the entries of a directory, creating a file only if it is absent, in a way no reader ever sees half written,
// and replacing or removing a file only while it holds the text the caller saw.
import { randomUUID } from 'node:crypto'
import {
  accessSync,
  constants,
  linkSync,
  mkdirSync,
  readFileSync,
  lstatSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { errorCode } from './errors'
import type { DirectoryEntry, Platform } from './machine'

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

// When the file was last written (its modification time), in milliseconds since the epoch with the fraction of a
// millisecond the file system keeps — never rounded: a file written 0.7 ms after a time Orca took in whole milliseconds
// (Date.now()) is later than that time, not equal to it; null when there is no such file.
export function modifiedAt(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

// The kind of each entry comes from the directory itself (for an unknown one Node asks lstat): a link is not followed.
export function listEntries(path: string): DirectoryEntry[] | null {
  try {
    return readdirSync(path, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      kind: entry.isSymbolicLink() ? 'other' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
    }))
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

// How the finished text gets the target's name; tests replace it to see a file system without hard links.
export type PublishOps = { link(existingPath: string, newPath: string): void }

const NODE_OPS: PublishOps = { link: linkSync }

// The errors of a file system without hard links (FAT, exFAT, some network shares).
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'])

// Creates `path` with exactly `text` unless it exists, creating its directory first: true when this call created it.
// The text is written whole to a temporary file beside the target, and only then gets the target's name by a hard
// link, which the system makes only while the name is free (EEXIST otherwise). So an existing file is never replaced,
// two writers at once leave exactly one winner, and a reader sees the whole text or no file, also after a writer was
// killed half way (its temporary file has another name). There is no other way of publishing (decision «🤖 Решение по
// #4: review»): the data directory needs a file system with hard links — the home directory's usual ones (NTFS, APFS,
// ext4, btrfs, xfs, NFS) have them; FAT, exFAT and a network share without them do not. There it is an error with that
// reason and the file is not created: the worker starts without a coordinator id, the reason in its log, and the queue
// does not work on that computer.
export async function createText(path: string, text: string, ops: PublishOps = NODE_OPS): Promise<boolean> {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx' })
  try {
    ops.link(temporary, path)
    return true
  } catch (error) {
    const code = errorCode(error)
    if (code === 'EEXIST') return false
    if (code !== null && NO_HARD_LINKS.has(code)) {
      throw new Error(`${dirname(path)}: the file system has no hard links (${code}); ${path} is not created`)
    }
    throw error
  } finally {
    try {
      unlinkSync(temporary)
    } catch {
      // Already gone.
    }
  }
}

// Replaces the regular file `path` with exactly `text`, only while it holds exactly `expected` (its bytes as UTF-8 text):
// the new text is written whole to a temporary file beside it, then — in one synchronous step, with nothing awaited
// between the look and the swap — the file is checked to be a regular file (not a link) holding `expected`, and the
// temporary file takes its name (a rename within one directory: a reader sees the old text or the new one). True when
// it was replaced; false — something else is there now, and nothing was changed. Used for the files of a project's main
// checkout the connection writes or puts back: what another hand wrote meanwhile is never overwritten.
export function replaceText(path: string, text: string, expected: string): boolean {
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx' })
  try {
    if (!holdsText(path, expected)) return false
    renameSync(temporary, path)
    return true
  } finally {
    try {
      unlinkSync(temporary)
    } catch {
      // Renamed, or already gone.
    }
  }
}

// Removes the regular file `path` only while it holds exactly `expected`: the look and the removal in one synchronous
// step. True when it was removed; false — something else is there, and nothing was changed.
export function removeText(path: string, expected: string): boolean {
  if (!holdsText(path, expected)) return false
  unlinkSync(path)
  return true
}

// Whether `path` is a regular file (not a link) holding exactly `expected`.
function holdsText(path: string, expected: string): boolean {
  try {
    if (!lstatSync(path).isFile()) return false
    return readFileSync(path, 'utf8') === expected
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}
