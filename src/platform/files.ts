// The file operations of the real machine: whether a file can be run, reading a text file and the time of its last
// write, the entries of a directory, creating a file only if it is absent, in a way no reader ever sees half written,
// and removing a file.
import { randomUUID } from 'node:crypto'
import { accessSync, constants, linkSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
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

// Removes the file `path` — the name itself: a link there is removed, never what it points to. True when this call
// removed it, false when there was none; throws on any other failure (a directory there, no access).
export async function removeFile(path: string): Promise<boolean> {
  try {
    unlinkSync(path)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}
