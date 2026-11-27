// The connection's git work in a checkout (./checkout.ts), on real git: the check of the operation's commit against the
// intent before the push — its parent, the paths it changes, their blobs, its message — and git with no hook of the
// project at all. Names and texts are invented.
import { assert, test } from 'orca/testing'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
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

test('Подключение: каждая команда git мастера идёт без хуков проекта — и из .git/hooks, и из core.hooksPath настроек репозитория', async () => {
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
    repo.write('CLAUDE.md', 'правило\n')
    const committed = await checkout.commit(['CLAUDE.md'], ['title', 'Agent-Queue-Operation: 7d3c1f2a-0b4e-4c5d-8e6f-1a2b3c4d5e6f'], source)
    assert.ok('commit' in committed, JSON.stringify(committed))
    assert.equal(existsSync(marks), false, 'сработал хук проекта')
    assert.equal(await checkout.undoCommit('commit' in committed ? committed.commit : '', source, 'main'), null)
    assert.equal(existsSync(marks), false, 'сработал хук проекта при отмене')
  })
})
