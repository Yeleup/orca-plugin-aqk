// Creating a file only if absent (the coordinator id's file), on the real disk: the finished text gets its name by a
// hard link only, so an existing file is never replaced; without hard links nothing is created. The entries of a
// directory, and removing a file, on the real disk. The time of a file's last write, on the real disk and on the fake
// computer.
import { assert, test } from 'orca/testing'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeMachine } from '../testing/fake-machine'
import { createText, listEntries, removeFile } from './files'
import { realMachine } from './machine'

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

test('записи каталога: настоящий каталог, файл и ссылка на каталог — ссылка не раскрывается; каталога нет — null, файл вместо каталога — ошибка', async () => {
  await withTempDir(async (dir) => {
    const agents = join(dir, 'agents')
    assert.equal(listEntries(agents), null)
    await createText(join(agents, '1', 'task.md'), 'one\n')
    await createText(join(agents, 'notes.md'), 'notes\n')
    const elsewhere = join(dir, 'elsewhere')
    mkdirSync(elsewhere)
    // A link to a directory: a symbolic link, on Windows a junction (it needs no rights there).
    symlinkSync(elsewhere, join(agents, '7'), 'junction')
    const entries = (listEntries(agents) ?? []).sort((a, b) => (a.name < b.name ? -1 : 1))
    assert.deepEqual(entries, [
      { name: '1', kind: 'directory' },
      { name: '7', kind: 'other' },
      { name: 'notes.md', kind: 'file' },
    ])
    // A file, not a directory: an error, not «no directory».
    assert.throws(() => listEntries(join(agents, 'notes.md')))
  })
})

test('удаление файла: файл удалён — true, его другие соседи на месте; файла нет — false; каталог на его месте — ошибка, каталог остаётся', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'agents', '1', 'sending-1.json')
    await createText(path, '{}\n')
    await createText(join(dir, 'agents', '1', 'message-1.md'), 'text\n')
    assert.equal(await removeFile(path), true)
    assert.equal(existsSync(path), false)
    assert.deepEqual(readdirSync(join(dir, 'agents', '1')), ['message-1.md'])
    assert.equal(await removeFile(path), false)
    await assert.rejects(removeFile(join(dir, 'agents', '1')))
    assert.equal(statSync(join(dir, 'agents', '1')).isDirectory(), true)
  })
})

test('Время последней записи файла читается на настоящем компьютере во временном каталоге и на поддельном — по его часам', async () => {
  await withTempDir(async (dir) => {
    const machine = realMachine()
    const path = join(dir, 'agents', '1', 'report.md')
    assert.equal(machine.modifiedAt(path), null)
    await machine.createText(path, 'Черновик.\n')
    // The time the disk keeps for the file, as it keeps it.
    assert.equal(machine.modifiedAt(path), statSync(path).mtimeMs)
    // A time set on the file with a fraction of a millisecond: the fraction is kept, not dropped.
    const written = Date.UTC(2026, 0, 15, 9, 30, 0, 250)
    utimesSync(path, (written + 0.7) / 1000, (written + 0.7) / 1000)
    const fractional = machine.modifiedAt(path)
    assert.ok(fractional !== null && fractional > written + 0.6 && fractional < written + 0.8, String(fractional))
    // Written again: a later time.
    writeFileSync(path, 'Отчёт.\n')
    const rewritten = machine.modifiedAt(path)
    assert.ok(rewritten !== null && rewritten > written, String(rewritten))
    rmSync(path)
    assert.equal(machine.modifiedAt(path), null)
  })

  // The fake computer: the clock's reading when the test or createText wrote the file.
  const fake = fakeMachine({ platform: 'win32', files: { 'C:\\data\\given.md': 'given\n' } })
  const t0 = fake.clock.now()
  assert.equal(fake.modifiedAt('C:\\data\\given.md'), t0)
  fake.clock.advance(1_500)
  fake.files.set('C:\\data\\report.md', 'Черновик.\n')
  fake.clock.advance(500)
  assert.equal(await fake.createText('C:\\data\\created.md', 'created\n'), true)
  fake.clock.advance(500)
  assert.deepEqual(
    ['C:\\data\\given.md', 'C:\\data\\report.md', 'C:\\data\\created.md'].map((path) => fake.modifiedAt(path)),
    [t0, t0 + 1_500, t0 + 2_000],
  )
  // Names without case, as on Windows; a file written again has the new reading, a fraction of a millisecond kept; no
  // file — null.
  fake.clock.advance(0.5)
  fake.files.set('C:\\data\\report.md', 'Отчёт.\n')
  assert.equal(fake.modifiedAt('c:\\DATA\\Report.md'), t0 + 2_500.5)
  fake.files.delete('C:\\data\\report.md')
  assert.equal(fake.modifiedAt('C:\\data\\report.md'), null)
  assert.equal(fake.modifiedAt('C:\\data\\missing.md'), null)
})
