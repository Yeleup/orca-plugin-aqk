// The connection's git work in a checkout (./checkout.ts), on real git: the check of the operation's commit against the
// intent before the push — its parent, the paths it changes, their blobs, its message — and git with no hook of the
// project at all. Names and texts are invented.
import { assert, test } from 'orca/testing'
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { realMachine } from '../platform/machine'
import { withRepository } from '../testing/git-repository'
import { Checkout, type OperationFile } from './checkout'

const machine = realMachine()

test('Подключение: сверка коммита до пуша — родитель, изменённые пути, blob каждого пути и сообщение должны совпасть с намерением', async () => {
  await withRepository(async (repo) => {
    const checkout = new Checkout(machine, repo.checkout, join(repo.root, 'no-hooks'))
    const source = (await repo.git(['rev-parse', 'HEAD'])).trim()
    const files: OperationFile[] = [
      { path: 'CLAUDE.md', text: 'правило\n', blob: await checkout.blobId('правило\n'), source: null },
      { path: 'AGENTS.md', text: 'правило\n', blob: await checkout.blobId('правило\n'), source: null },
    ]
    const message = 'Agent Queue: подключение проекта к очереди\n\nAgent-Queue-Operation: 7d3c1f2a-0b4e-4c5d-8e6f-1a2b3c4d5e6f\n'
    const commitWith = async (tree: Record<string, string>, text: string) => {
      await repo.git(['reset', '--quiet', '--hard', source])
      for (const [path, content] of Object.entries(tree)) repo.write(path, content)
      await repo.git(['add', '--', ...Object.keys(tree)])
      await repo.git(['commit', '--quiet', '--cleanup=verbatim', '-m', text.slice(0, text.indexOf('\n\n')), '-m', text.slice(text.indexOf('\n\n') + 2, -1)])
      return (await repo.git(['rev-parse', 'HEAD'])).trim()
    }
    const right = await commitWith({ 'CLAUDE.md': 'правило\n', 'AGENTS.md': 'правило\n' }, message)
    assert.equal(await checkout.verify(right, source, files, message), null)
    assert.deepEqual(await checkout.verify(right, right, files, message), { what: 'parent', file: null })
    const extra = await commitWith({ 'CLAUDE.md': 'правило\n', 'AGENTS.md': 'правило\n', 'notes.txt': 'чужой файл\n' }, message)
    assert.deepEqual(await checkout.verify(extra, source, files, message), { what: 'paths', file: null })
    const changed = await commitWith({ 'CLAUDE.md': 'правило\n', 'AGENTS.md': 'другое\n' }, message)
    assert.deepEqual(await checkout.verify(changed, source, files, message), { what: 'blob', file: 'AGENTS.md' })
    const renamed = await commitWith({ 'CLAUDE.md': 'правило\n', 'AGENTS.md': 'правило\n' }, `${message.slice(0, -1)}\nadded by a hook\n`)
    assert.deepEqual(await checkout.verify(renamed, source, files, message), { what: 'message', file: null })
  })
})

test('Подключение: каждая команда git мастера идёт без хуков проекта — и из .git/hooks, и из core.hooksPath настроек репозитория; коммит операции строится из исходного коммита, ветка двигается только с него', async () => {
  await withRepository(async (repo) => {
    const marks = join(repo.root, 'marks.txt')
    const hooks = join(repo.root, 'project-hooks')
    mkdirSync(hooks, { recursive: true })
    for (const dir of [join(repo.checkout, '.git', 'hooks'), hooks]) {
      for (const name of ['pre-commit', 'commit-msg', 'post-commit', 'reference-transaction', 'post-index-change']) {
        writeFileSync(join(dir, name), `#!/bin/sh\necho ${name} >> "${marks.replace(/\\/g, '/')}"\nexit 1\n`)
        chmodSync(join(dir, name), 0o755)
      }
    }
    await repo.git(['config', 'core.hooksPath', hooks])
    const checkout = new Checkout(machine, repo.checkout, join(repo.root, 'no-hooks'))
    const source = (await repo.git(['rev-parse', 'HEAD'])).trim()
    // The control: a commit of the test is refused by the hooks of the project, and they mark it.
    const user = await repo.commit({ 'notes.txt': 'работа пользователя\n' }, 'user work').catch(() => null)
    assert.equal(user, null, 'хук не отклонил коммит теста — контроль хуков не работает')
    assert.ok(existsSync(marks), 'контроль: хуки проекта работают для команд теста')
    // The test's own git commands may wake post-index-change: the marks are cleared before each step of the plugin.
    const step = async <T>(run: () => Promise<T>, what: string): Promise<T> => {
      rmSync(marks, { force: true })
      const result = await run()
      assert.equal(existsSync(marks), false, `${what}: сработал хук проекта`)
      return result
    }
    const files: OperationFile[] = [{ path: 'CLAUDE.md', text: 'правило\n', blob: await checkout.blobId('правило\n'), source: null }]
    const message = 'title\n\nAgent-Queue-Operation: 7d3c1f2a-0b4e-4c5d-8e6f-1a2b3c4d5e6f\n'
    const commit = await step(() => checkout.commitOf(source, files, ['title', 'Agent-Queue-Operation: 7d3c1f2a-0b4e-4c5d-8e6f-1a2b3c4d5e6f']), 'коммит')
    assert.equal(await checkout.verify(commit, source, files, message), null)
    assert.equal((await repo.git(['rev-parse', 'HEAD'])).trim(), source, 'коммит операции сдвинул HEAD')
    assert.equal(await step(() => checkout.moveRef('refs/heads/main', commit, source, 'test'), 'ветка'), null)
    assert.equal(await step(() => checkout.writeFile(files[0] as OperationFile), 'файл'), true)
    await step(() => checkout.stage(files), 'индекс')
    assert.equal((await repo.git(['rev-parse', 'HEAD'])).trim(), commit)
    assert.equal((await repo.git(['status', '--porcelain', '--', 'CLAUDE.md'])).trim(), '')
    const undone = await step(() => checkout.undoCommit(commit, source, 'main', files), 'отмена')
    assert.deepEqual(undone, { left: [] })
    assert.equal((await repo.git(['rev-parse', 'HEAD'])).trim(), source)
    assert.equal(existsSync(join(repo.checkout, 'CLAUDE.md')), false)
    // The user's staged file — from the refused commit of the control — stays staged.
    assert.equal((await repo.git(['diff', '--cached', '--name-only'])).trim(), 'notes.txt')
    // The branch is no longer the commit: it does not move back again.
    assert.equal((await step(() => checkout.moveRef('refs/heads/main', source, commit, 'test'), 'повтор отмены'))?.reason, 'moved')
  })
})
