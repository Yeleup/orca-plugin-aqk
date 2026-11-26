// Creating a file only if absent (the coordinator id's file), on the real disk: the finished text gets its name by a
// hard link only, so an existing file is never replaced; without hard links nothing is created. The names in a
// directory, on the real disk.
import { assert, test } from 'orca/testing'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createText, listNames } from './files'

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-queue-files-'))
  try {
    await body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('создание файла: только если его нет — из нескольких писателей сразу ровно один, существующий файл не заменяется, временных файлов не остаётся', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'state', 'coordinator-id')
    const texts = ['first\n', 'second\n', 'third\n', 'fourth\n']
    const created = await Promise.all(texts.map((text) => createText(path, text)))
    assert.equal(created.filter(Boolean).length, 1, JSON.stringify(created))
    const winner = texts[created.indexOf(true)]
    assert.equal(readFileSync(path, 'utf8'), winner)
    assert.equal(await createText(path, 'later\n'), false)
    assert.equal(readFileSync(path, 'utf8'), winner)
    assert.deepEqual(readdirSync(join(dir, 'state')), ['coordinator-id'])
  })
})

test('создание файла без жёстких ссылок: ошибка с причиной, файл не создаётся и ничего не заменяется', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'coordinator-id')
    const noLinks = {
      link: () => {
        throw Object.assign(new Error('operation not supported'), { code: 'ENOTSUP' })
      },
    }
    await assert.rejects(createText(path, 'first\n', noLinks), /the file system has no hard links \(ENOTSUP\)/)
    assert.equal(existsSync(path), false)
    assert.deepEqual(readdirSync(dir), [])
  })
})

test('имена в каталоге: файлы и каталоги внутри, каталога нет — null, файл вместо каталога — ошибка', async () => {
  await withTempDir(async (dir) => {
    assert.equal(listNames(join(dir, 'agents')), null)
    await createText(join(dir, 'agents', '1', 'task.md'), 'one\n')
    await createText(join(dir, 'agents', '2', 'task.md'), 'two\n')
    await createText(join(dir, 'agents', 'notes.md'), 'notes\n')
    assert.deepEqual((listNames(join(dir, 'agents')) ?? []).sort(), ['1', '2', 'notes.md'])
    // A file, not a directory: an error, not «no directory».
    assert.throws(() => listNames(join(dir, 'agents', 'notes.md')))
  })
})
