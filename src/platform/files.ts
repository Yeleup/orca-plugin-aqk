// The file operations of the real machine: whether a file can be run, reading a text file, and creating a file only if
// it is absent, in a way no reader ever sees half written.
import { randomUUID } from 'node:crypto'
import { accessSync, constants, linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
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

// How the finished text gets the target's name; tests replace it to see a file system without hard links.
export type PublishOps = { link(existingPath: string, newPath: string): void }

const NODE_OPS: PublishOps = { link: linkSync }

// The errors of a file system without hard links (FAT, exFAT, some network shares).
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'])

// Creates `path` with exactly `text` unless it exists, creating its directory first: true when this call created it.
// The text is written whole to a temporary file beside the target, and only then gets the target's name by a hard
// link, which the system makes only while the name is free (EEXIST otherwise). So an existing file is never replaced,
// two writers at once leave exactly one winner, and a reader sees the whole text or no file, also after a writer was
// killed half way (its temporary file has another name). There is no other way of publishing: on a file system without
// hard links (the plugin's data directory is under the home directory, where NTFS, APFS, ext4, btrfs, xfs, NFS and SMB
// all have them) it is an error with that reason, and the file is not created.
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
