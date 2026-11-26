// Creating a file only if absent (the coordinator id's file), on the real disk: with hard links, and on a file system
// without them, where the finished text is renamed under a lock.
import { assert, test } from 'orca/testing'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createText, LOCK_STALE_MS, type PublishOps } from './files'

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-queue-files-'))
  try {
    await body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// A file system without hard links; each rename is checked first: the name is free and the file is finished.
function withoutHardLinks(path: string, text: string, renames: string[]): PublishOps {
  return {
    link: () => {
      throw Object.assign(new Error('operation not supported'), { code: 'ENOTSUP' })
    },
    rename: (from, to) => {
      assert.equal(to, path)
      assert.equal(existsSync(to), false, 'the name was taken before the rename')
      assert.equal(readFileSync(from, 'utf8'), text, 'the file was renamed before it was written whole')
      renames.push(to)
      renameSync(from, to)
    },
  }
}

test('создание файла: с жёсткими ссылками — только если его нет, без временных файлов рядом', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'state', 'coordinator-id')
    assert.equal(await createText(path, 'first\n'), true)
    assert.equal(await createText(path, 'second\n'), false)
    assert.equal(readFileSync(path, 'utf8'), 'first\n')
    assert.deepEqual(readdirSync(join(dir, 'state')), ['coordinator-id'])
  })
})

test('создание файла без жёстких ссылок: готовый файл получает имя переименованием под блокировкой; занятое имя и брошенная блокировка', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'coordinator-id')
    const renames: string[] = []
    assert.equal(await createText(path, 'first\n', withoutHardLinks(path, 'first\n', renames)), true)
    assert.equal(await createText(path, 'second\n', withoutHardLinks(path, 'second\n', renames)), false)
    assert.deepEqual(renames, [path])
    assert.equal(readFileSync(path, 'utf8'), 'first\n')
    assert.deepEqual(readdirSync(dir), ['coordinator-id'])

    // A writer died holding the lock, before its rename: the next start takes the old lock over and publishes.
    const next = join(dir, 'next-id')
    mkdirSync(`${next}.lock`)
    const old = (Date.now() - LOCK_STALE_MS - 5_000) / 1000
    utimesSync(`${next}.lock`, old, old)
    assert.equal(await createText(next, 'third\n', withoutHardLinks(next, 'third\n', renames)), true)
    assert.equal(readFileSync(next, 'utf8'), 'third\n')
    assert.deepEqual(readdirSync(dir).sort(), ['coordinator-id', 'next-id'])
  })
})
