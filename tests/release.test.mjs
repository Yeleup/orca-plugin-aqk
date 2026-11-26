// The release command (Ф14): `node scripts/release.mjs [<commit>]` prints the Orca catalog entry of a release commit from
// `plugin release-entry`, run in a temporary clone of that commit; the working checkout stays as it was.
//
// A local git repository (a clean export of HEAD with commits of invented versions, `origin` a local bare repository)
// runs its own copy of the command with a fake Orca CLI: the fake logs where and how `plugin release-entry` was called —
// the folder, its commit and state — and answers in the form of Orca's CLI (`--json`).
import { assert, test } from 'orca/testing'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { exportHead, nestedRun, readJson, run, tempDir, testEnv, writeExecutable } from './helpers.mjs'

// A test with git repositories and processes of its own: it skips in the inner runs of the delivery tests and К14.6.
function releaseTest(name, body) {
  test(name, (t) => {
    if (nestedRun) {
      t.skip('внутренний прогон: эти проверки ведёт внешний')
      return
    }
    const temp = tempDir('release')
    try {
      return body(temp.dir, t)
    } finally {
      temp.remove()
    }
  })
}

// Git without the user's and the system's config, with a test author.
function gitEnv(temp) {
  const config = join(temp, 'gitconfig')
  if (!existsSync(config)) writeFileSync(config, '')
  return testEnv({
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Release Test',
    GIT_AUTHOR_EMAIL: 'release-test@example.invalid',
    GIT_COMMITTER_NAME: 'Release Test',
    GIT_COMMITTER_EMAIL: 'release-test@example.invalid',
  })
}

function git(temp, cwd, ...args) {
  const result = run('git', args, { cwd, env: gitEnv(temp) })
  assert.equal(result.status, 0, result.output)
  return result.stdout.trim()
}

function setVersion(dir, version) {
  const file = join(dir, 'orca-plugin.json')
  writeFileSync(file, `${JSON.stringify({ ...readJson(file), version }, null, 2)}\n`)
}

// The checkout: an export of HEAD as a repository whose `origin` is a local bare one; on `main` the release 0.4.2
// (tagged v0.4.2, pushed) and after it 0.5.0. Returns { dir, released, head }.
function checkout(temp) {
  const origin = join(temp, 'origin.git')
  git(temp, temp, 'init', '-q', '--bare', origin)
  const dir = exportHead(temp)
  git(temp, dir, 'init', '-q', '-b', 'main')
  git(temp, dir, 'remote', 'add', 'origin', origin)
  setVersion(dir, '0.4.2')
  git(temp, dir, 'add', '-A')
  git(temp, dir, 'commit', '-q', '-m', 'release 0.4.2')
  git(temp, dir, 'tag', 'v0.4.2')
  const released = git(temp, dir, 'rev-parse', 'HEAD')
  setVersion(dir, '0.5.0')
  git(temp, dir, 'commit', '-q', '-am', 'version 0.5.0')
  git(temp, dir, 'push', '-q', 'origin', 'main', 'v0.4.2')
  return { dir, released, head: git(temp, dir, 'rev-parse', 'HEAD') }
}

// Everything of the checkout a command could change: HEAD and its branch, every ref, the index and the working tree as
// git sees them, the stash, the worktrees, and the bytes of every file outside .git.
function snapshot(temp, dir) {
  const files = {}
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.name === '.git' && current === dir) continue
      if (entry.isDirectory()) walk(path)
      else files[relative(dir, path).replaceAll('\\', '/')] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  walk(dir)
  return {
    head: git(temp, dir, 'rev-parse', 'HEAD'),
    branch: git(temp, dir, 'symbolic-ref', '-q', 'HEAD'),
    refs: git(temp, dir, 'for-each-ref', '--format=%(refname) %(objectname)'),
    status: git(temp, dir, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored'),
    stash: git(temp, dir, 'stash', 'list'),
    worktrees: git(temp, dir, 'worktree', 'list', '--porcelain'),
    files,
  }
}

// A fake Orca CLI: logs each call (arguments, the real path of its working directory, and of the folder it got: its real path, git's
// top level, HEAD, status) to FAKE_ORCA_LOG and answers `plugin release-entry <dir> --json` as Orca's CLI does — the
// entry of the folder's HEAD, the version and name of its manifest, and for a folder below the top level its path there
// (sourcePath). FAKE_RELEASE_ANSWER=invalid answers plugin_invalid with exit 2, =other-commit an entry of another commit.
function fakeCli(temp) {
  const dir = join(temp, 'fake-orca')
  mkdirSync(dir)
  const script = join(dir, 'fake-orca.mjs')
  writeFileSync(script, `import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, relative, sep } from 'node:path'
const args = process.argv.slice(2)
const folder = args[2]
const git = (...a) => spawnSync('git', ['-C', folder, ...a], { encoding: 'utf8' }).stdout.trim()
const call = { args, cwd: realpathSync.native(process.cwd()) }
if (folder && existsSync(folder)) {
  Object.assign(call, { real: realpathSync.native(folder), toplevel: realpathSync.native(git('rev-parse', '--show-toplevel')),
    head: git('rev-parse', 'HEAD'), status: git('status', '--porcelain=v1', '--untracked-files=all') })
}
appendFileSync(process.env.FAKE_ORCA_LOG, JSON.stringify(call) + '\\n', 'utf8')
if (args[0] !== 'plugin' || args[1] !== 'release-entry' || args[3] !== '--json') process.exit(1)
if (process.env.FAKE_RELEASE_ANSWER === 'invalid') {
  console.log(JSON.stringify({ ok: false, error: { code: 'plugin_invalid', message: 'manifest: invalid' } }))
  process.exit(2)
}
const manifest = JSON.parse(readFileSync(join(folder, 'orca-plugin.json'), 'utf8'))
const commit = process.env.FAKE_RELEASE_ANSWER === 'other-commit' ? '0'.repeat(40) : call.head
const entry = { version: manifest.version, commit, contentHash: 'c'.repeat(64), execution: manifest.execution,
  minimumOrca: manifest.engines.orca.slice(2), name: manifest.name, contributes: [] }
const result = { path: folder, pluginKey: 'local.' + manifest.id, entry }
if (call.real !== call.toplevel) result.sourcePath = relative(call.toplevel, call.real).split(sep).join('/')
console.log(JSON.stringify({ ok: true, result }, null, 2))
`, 'utf8')
  const node = process.execPath
  const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`
  const cli = writeExecutable(dir, 'orca-ide', {
    sh: `#!/bin/sh\nexec ${quote(node)} ${quote(script)} "$@"\n`,
    cmd: `@echo off\n"${node}" "${script}" %*\nexit /b %errorlevel%\n`,
  })
  const log = join(temp, 'orca-calls.log')
  return {
    cli,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : []),
    env: { ORCA_CLI_COMMAND: cli, FAKE_ORCA_LOG: log },
  }
}

// The release command of the checkout `dir`, run there, with its temporary files in `tmp` (TMPDIR, TMP, TEMP);
// `nodeArgs` go to node before the script.
function release(temp, dir, args, env, nodeArgs = []) {
  const tmp = join(temp, 'tmp')
  mkdirSync(tmp, { recursive: true })
  return run('node', [...nodeArgs, join(dir, 'scripts', 'release.mjs'), ...args], {
    cwd: dir,
    env: { ...gitEnv(temp), TMPDIR: tmp, TMP: tmp, TEMP: tmp, ...env },
  })
}

function assertInTemporaryClone(call, dir, sha, temp) {
  const real = realpathSync.native(dir)
  assert.notEqual(call.real, real, 'release-entry в рабочем чекауте')
  assert.ok(relative(real, call.real).startsWith('..'), `release-entry внутри чекаута: ${call.real}`)
  assert.ok(!relative(realpathSync.native(join(temp, 'tmp')), call.real).startsWith('..'), `клон не во временном каталоге: ${call.real}`)
  assert.equal(call.toplevel, call.real, 'папка release-entry — не корень клона')
  assert.equal(call.head, sha, 'клон не на релизном коммите')
  assert.equal(call.status, '', 'клон не чистый')
  assert.equal(call.cwd, call.real, 'release-entry не из клона')
  assert.equal(existsSync(call.real), false, 'временный клон остался')
  assert.deepEqual(readdirSync(join(temp, 'tmp')), [], 'временные файлы остались')
}

releaseTest('Релиз: команда релиза строит запись каталога через plugin release-entry релизного коммита во временном клоне; рабочий чекаут после неё без изменений', (temp) => {
  const { dir, head } = checkout(temp)
  // Work in progress in the checkout: a version that is not committed, a staged file and one git does not know.
  setVersion(dir, '9.9.9')
  writeFileSync(join(dir, 'staged.txt'), 'в индексе\n')
  git(temp, dir, 'add', 'staged.txt')
  writeFileSync(join(dir, 'untracked.txt'), 'не в git\n')
  const before = snapshot(temp, dir)
  const fake = fakeCli(temp)

  const result = release(temp, dir, [], fake.env)
  assert.equal(result.status, 0, result.output)
  const calls = fake.calls()
  assert.equal(calls.length, 1, JSON.stringify(calls))
  const [call] = calls
  assert.deepEqual([call.args[0], call.args[1], call.args[3], call.args.length], ['plugin', 'release-entry', '--json', 4])
  assertInTemporaryClone(call, dir, head, temp)

  const entry = JSON.parse(result.stdout)
  assert.deepEqual(entry, {
    version: '0.5.0',
    commit: head,
    contentHash: 'c'.repeat(64),
    execution: 'trusted-worker',
    minimumOrca: '1.4.273',
    name: 'Agent Queue',
    contributes: [],
  })
  assert.match(result.stderr, new RegExp(`Agent Queue 0\\.5\\.0, коммит ${head}\\. Рабочий чекаут не менялся`))
  assert.deepEqual(snapshot(temp, dir), before)
})

releaseTest('Релиз: релизный коммит по тегу — запись версии его манифеста, чекаут остаётся на своей ветке и коммите', (temp) => {
  const { dir, released, head } = checkout(temp)
  const before = snapshot(temp, dir)
  const fake = fakeCli(temp)

  const result = release(temp, dir, ['v0.4.2'], fake.env)
  assert.equal(result.status, 0, result.output)
  const [call] = fake.calls()
  assertInTemporaryClone(call, dir, released, temp)
  const entry = JSON.parse(result.stdout)
  assert.deepEqual([entry.version, entry.commit], ['0.4.2', released])
  assert.notEqual(released, head)
  assert.deepEqual(snapshot(temp, dir), before)
})

// The checkout by a path git spells otherwise: on windows-latest the temporary directory is an 8.3 short name
// (C:\Users\RUNNER~1\…) and git names the long one; here a link to the checkout (a junction on Windows), which the
// command keeps as its own path (node --preserve-symlinks-main) while git names the checkout's real one.
releaseTest('Релиз: чекаут по пути, который git пишет иначе (ссылка; на Windows — короткое имя 8.3), — запись через plugin release-entry в корне временного клона релизного коммита, чекаут без изменений', (temp) => {
  const { dir, head } = checkout(temp)
  const link = join(temp, 'checkout-link')
  symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir')
  const before = snapshot(temp, dir)
  const fake = fakeCli(temp)

  const result = release(temp, link, [], fake.env, ['--preserve-symlinks-main'])
  assert.equal(result.status, 0, result.output)
  const calls = fake.calls()
  assert.equal(calls.length, 1, JSON.stringify(calls))
  assertInTemporaryClone(calls[0], dir, head, temp)
  assert.deepEqual([JSON.parse(result.stdout).commit, JSON.parse(result.stdout).version], [head, '0.5.0'])
  assert.deepEqual(snapshot(temp, dir), before)
})

// The plugin as a subdirectory of its repository: release-entry runs on that folder of the clone, and the command names
// its source.path for the catalog.
releaseTest('Релиз: плагин в подкаталоге репозитория — запись через plugin release-entry его папки во временном клоне релизного коммита, source.path для каталога в выводе, чекаут без изменений', (temp) => {
  const repo = join(temp, 'mono')
  mkdirSync(join(repo, 'plugins'), { recursive: true })
  const dir = exportHead(join(repo, 'plugins'))
  writeFileSync(join(repo, 'README.md'), 'Несколько плагинов.\n')
  git(temp, repo, 'init', '-q', '-b', 'main')
  git(temp, repo, 'add', '-A')
  git(temp, repo, 'commit', '-q', '-m', 'plugins')
  const head = git(temp, repo, 'rev-parse', 'HEAD')
  const before = snapshot(temp, repo)
  const fake = fakeCli(temp)

  const result = release(temp, dir, [], fake.env)
  assert.equal(result.status, 0, result.output)
  const calls = fake.calls()
  assert.equal(calls.length, 1, JSON.stringify(calls))
  const [call] = calls
  assert.equal(relative(call.toplevel, call.real).split(sep).join('/'), 'plugins/plugin', 'release-entry не на папке плагина')
  assert.ok(!relative(realpathSync.native(join(temp, 'tmp')), call.toplevel).startsWith('..'), `клон не во временном каталоге: ${call.toplevel}`)
  assert.equal(call.head, head, 'клон не на релизном коммите')
  assert.equal(call.status, '', 'клон не чистый')
  assert.equal(call.cwd, call.toplevel, 'release-entry не из клона')
  assert.equal(existsSync(call.toplevel), false, 'временный клон остался')
  assert.equal(JSON.parse(result.stdout).commit, head)
  assert.match(result.stderr, /^source\.path плагина в каталоге: plugins\/plugin$/m)
  assert.deepEqual(snapshot(temp, repo), before)
})

releaseTest('Релиз (контроль): отказ CLI, запись чужого коммита или нет такого коммита — ошибка без записи, клон убран, чекаут без изменений', (temp) => {
  const { dir, head } = checkout(temp)
  const before = snapshot(temp, dir)
  const fake = fakeCli(temp)

  const invalid = release(temp, dir, [], { ...fake.env, FAKE_RELEASE_ANSWER: 'invalid' })
  assert.equal(invalid.status, 1, invalid.output)
  assert.equal(invalid.stdout, '')
  assert.match(invalid.stderr, /plugin release-entry: код 2\n.*plugin_invalid/)
  assertInTemporaryClone(fake.calls()[0], dir, head, temp)

  const other = release(temp, dir, [], { ...fake.env, FAKE_RELEASE_ANSWER: 'other-commit' })
  assert.equal(other.status, 1, other.output)
  assert.equal(other.stdout, '')
  assert.match(other.stderr, new RegExp(`описал коммит 0{40}, а релизный — ${head}`))
  assertInTemporaryClone(fake.calls()[1], dir, head, temp)

  const missing = release(temp, dir, ['v9.9.9'], fake.env)
  assert.equal(missing.status, 1, missing.output)
  assert.match(missing.stderr, /релизный коммит «v9\.9\.9» не найден/)
  assert.equal(fake.calls().length, 2, 'CLI запускался без релизного коммита')

  assert.deepEqual(snapshot(temp, dir), before)
})

releaseTest('Релиз: ORCA_CLI_COMMAND=orca на Linux — отказ, экранный диктор не запускается', (temp, t) => {
  if (process.platform !== 'linux') {
    t.skip('голый orca — экранный диктор только на Linux; на macOS и Windows это CLI Orca')
    return
  }
  const { dir } = checkout(temp)
  const fake = fakeCli(temp)
  const bin = join(temp, 'screen-reader')
  mkdirSync(bin)
  writeExecutable(bin, 'orca', { sh: `#!/bin/sh\nexec '${fake.cli}' "$@"\n`, cmd: '' })
  const pathKey = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
  const result = release(temp, dir, [], { ...fake.env, ORCA_CLI_COMMAND: 'orca', [pathKey]: `${bin}:${process.env[pathKey]}` })
  assert.equal(result.status, 1, result.output)
  assert.match(result.stderr, /экранный диктор GNOME/)
  assert.deepEqual(fake.calls(), [])
})
