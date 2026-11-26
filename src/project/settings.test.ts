// The project's settings file .agent-queue.json (TZ «Данные», Ф1 point 3): its check names the field at fault, a file
// without optional fields gets the defaults of the connection form, and the plugin reads the file committed to the
// project's base branch (origin/<branch>) — with real git on a temporary repository whose `origin` is a local bare one.
import { assert, test } from 'orca/testing'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realMachine } from '../platform/machine'
import { startProcess } from '../platform/process'
import { projectTestCommand } from '../platform/run'
import { fakeClock, fakeMachine } from '../testing/fake-machine'
import { withRepository } from '../testing/git-repository'
import {
  formatProjectSettings,
  forbiddenPatternRegExps,
  readProjectSettings,
  SETTINGS_FILE,
  type ProjectSettings,
  type ReadSettingsResult,
} from './settings'

// The machine the plugin reads with: this computer and its git, with a clock that moves only when told.
const machine = realMachine({ now: fakeClock().now })

// A file with only the fields that have no default.
const MINIMAL = {
  version: 1,
  testCommand: 'make test',
  language: 'en',
  dataRule: 'No customer names, phone numbers or order ids in GitHub.',
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

function settingsOf(result: ReadSettingsResult): ProjectSettings {
  assert.ok(result.ok, JSON.stringify(result))
  return result.settings
}

test('в .agent-queue.json неизвестное поле или поле неверного типа → ошибка называет поле', async () => {
  const cases: { readonly why: string; readonly file: string; readonly fields: readonly (string | null)[] }[] = [
    { why: 'unknown field', file: json({ ...MINIMAL, reviewers: 'codex' }), fields: ['reviewers'] },
    { why: 'unknown agent role', file: json({ ...MINIMAL, agents: { planner: 'claude' } }), fields: ['agents.planner'] },
    {
      why: 'unknown field of a step',
      file: json({ ...MINIMAL, afterMerge: [{ command: 'make docs' }, { cmd: 'make deploy' }] }),
      fields: ['afterMerge[1].cmd', 'afterMerge[1].command'],
    },
    {
      why: 'unknown field of the stand',
      file: json({
        ...MINIMAL,
        acceptanceStand: { setup: 'make stand-setup', up: 'make stand-up', url: 'http://127.0.0.1:47391', down: 'make stand-down', port: 47391 },
      }),
      fields: ['acceptanceStand.port'],
    },
    { why: 'number as text', file: json({ ...MINIMAL, maxInProgress: '2' }), fields: ['maxInProgress'] },
    { why: 'zero in work', file: json({ ...MINIMAL, maxInProgress: 0 }), fields: ['maxInProgress'] },
    { why: 'agent id of a wrong type', file: json({ ...MINIMAL, agents: { reviewer: 42 } }), fields: ['agents.reviewer'] },
    { why: 'unknown language', file: json({ ...MINIMAL, language: 'de' }), fields: ['language'] },
    {
      why: 'unknown dependencies mode',
      file: json({ ...MINIMAL, worktreeDependencies: { mode: 'both', directories: ['node_modules'] } }),
      fields: ['worktreeDependencies.mode'],
    },
    {
      why: 'dependency directory outside the repository',
      file: json({ ...MINIMAL, worktreeDependencies: { directories: ['node_modules', '../vendor'] } }),
      fields: ['worktreeDependencies.directories[1]'],
    },
    { why: 'list as text', file: json({ ...MINIMAL, forbiddenPatterns: 'ORD-[0-9]{6}' }), fields: ['forbiddenPatterns'] },
    { why: 'broken regular expression', file: json({ ...MINIMAL, forbiddenPatterns: ['ORD-[0-9]{6}', 'ORD-[0-9'] }), fields: ['forbiddenPatterns[1]'] },
    { why: 'pattern matching an empty text', file: json({ ...MINIMAL, forbiddenPatterns: ['x*'] }), fields: ['forbiddenPatterns[0]'] },
    { why: 'Windows command of a wrong type', file: json({ ...MINIMAL, testCommandWindows: 7 }), fields: ['testCommandWindows'] },
    { why: 'empty test command', file: json({ ...MINIMAL, testCommand: '  ' }), fields: ['testCommand'] },
    { why: 'missing test command', file: json({ ...MINIMAL, testCommand: undefined }), fields: ['testCommand'] },
    { why: 'two-line command', file: json({ ...MINIMAL, testCommand: 'make test\nmake lint' }), fields: ['testCommand'] },
    { why: 'not a branch name', file: json({ ...MINIMAL, baseBranch: 'main branch' }), fields: ['baseBranch'] },
    { why: 'HEAD is not a branch', file: json({ ...MINIMAL, baseBranch: 'HEAD' }), fields: ['baseBranch'] },
    {
      why: 'stand address without http',
      file: json({ ...MINIMAL, acceptanceStand: { setup: 'make stand-setup', up: 'make stand-up', url: 'localhost:47391', down: 'make stand-down' } }),
      fields: ['acceptanceStand.url'],
    },
    { why: 'step name of a wrong type', file: json({ ...MINIMAL, afterMerge: [{ command: 'make docs', name: false }] }), fields: ['afterMerge[0].name'] },
    { why: 'unknown format version', file: json({ ...MINIMAL, version: 2 }), fields: ['version'] },
    { why: 'not JSON', file: '{ "version": 1, ', fields: [null] },
  ]
  await withRepository(
    async (repo) => {
      for (const { why, file, fields } of cases) {
        const commit = await repo.commit({ [SETTINGS_FILE]: file }, why)
        await repo.push()
        const result = await readProjectSettings(machine, repo.checkout)
        assert.ok(!result.ok && result.kind === 'invalid', `${why}: ${JSON.stringify(result)}`)
        assert.deepEqual(
          result.problems.map((problem) => problem.field),
          fields,
          `${why}: ${JSON.stringify(result.problems)}`,
        )
        assert.deepEqual(result.source, { branch: 'trunk', commit }, why)
        for (const field of fields) {
          if (field !== null) assert.ok(result.error.includes(field), `${why}: the error names ${field}: ${result.error}`)
        }
      }
    },
    { defaultBranch: 'trunk' },
  )
})

test('верный файл без необязательных полей → настройки с умолчаниями: агенты Claude, Codex, Claude, Claude, одновременно в работе 1, зависимости shared', async () => {
  await withRepository(
    async (repo) => {
      const commit = await repo.commit({ [SETTINGS_FILE]: json(MINIMAL) }, 'connect')
      await repo.push()
      const result = await readProjectSettings(machine, repo.checkout)
      assert.deepEqual(result, {
        ok: true,
        settings: {
          version: 1,
          // The repository's default branch: origin's HEAD.
          baseBranch: 'trunk',
          testCommand: 'make test',
          testCommandWindows: null,
          agents: { implementer: 'claude', reviewer: 'codex', solver: 'claude', start: 'claude' },
          language: 'en',
          dataRule: MINIMAL.dataRule,
          maxInProgress: 1,
          worktreeDependencies: { mode: 'shared', directories: [] },
          afterMerge: [],
          forbiddenPatterns: [],
          acceptanceStand: null,
        },
        source: { branch: 'trunk', commit },
      })

      // Agents the file leaves out keep their defaults one by one.
      await repo.commit({ [SETTINGS_FILE]: json({ ...MINIMAL, agents: { reviewer: 'claude' } }) })
      await repo.push()
      assert.deepEqual(settingsOf(await readProjectSettings(machine, repo.checkout)).agents, {
        implementer: 'claude',
        reviewer: 'claude',
        solver: 'claude',
        start: 'claude',
      })

      // A file an editor saved with a byte order mark and Windows line ends reads the same.
      await repo.commit({ [SETTINGS_FILE]: `\uFEFF${json(MINIMAL).replace(/\n/g, '\r\n')}` })
      await repo.push()
      assert.equal(settingsOf(await readProjectSettings(machine, repo.checkout)).maxInProgress, 1)
    },
    { defaultBranch: 'trunk' },
  )
})

test('настройки читаются из базовой ветки на origin: правка в рабочем дереве и незапушенный коммит основного чекаута не учитываются', async () => {
  await withRepository(async (repo) => {
    // Not connected yet: the base branch has no settings file.
    const before = await readProjectSettings(machine, repo.checkout)
    assert.ok(!before.ok && before.kind === 'missing', JSON.stringify(before))
    assert.equal(before.source.branch, 'main')
    assert.match(
      before.error,
      /^origin\/main has no \.agent-queue\.json, and no other branch of origin known to this clone has one$/,
    )

    const pushed = await repo.commit({ [SETTINGS_FILE]: json({ ...MINIMAL, maxInProgress: 2 }) }, 'connect')
    await repo.push()

    // An edit nobody committed, then a commit nobody pushed: the base branch still has the pushed file.
    repo.write(SETTINGS_FILE, json({ ...MINIMAL, maxInProgress: 'many', extra: true }))
    let result = await readProjectSettings(machine, repo.checkout)
    assert.equal(settingsOf(result).maxInProgress, 2)
    assert.deepEqual(result.ok && result.source, { branch: 'main', commit: pushed })

    const local = await repo.commit({ [SETTINGS_FILE]: json({ ...MINIMAL, maxInProgress: 3 }) })
    result = await readProjectSettings(machine, repo.checkout)
    assert.equal(settingsOf(result).maxInProgress, 2)

    // Once pushed, it is the base branch's file.
    await repo.push()
    result = await readProjectSettings(machine, repo.checkout)
    assert.equal(settingsOf(result).maxInProgress, 3)
    assert.deepEqual(result.ok && result.source, { branch: 'main', commit: local })

    // From a subdirectory of the checkout the file is the same: it is read from the root of the commit.
    repo.write('src/app/main.ts', 'export {}\n')
    assert.equal(settingsOf(await readProjectSettings(machine, join(repo.checkout, 'src', 'app'))).maxInProgress, 3)
  })
})

test('проект подключён на выбранной базовой ветке, а в ветке по умолчанию файла нет → клон на другом компьютере находит её по файлу, который называет свою ветку', async () => {
  await withRepository(async (repo) => {
    // The connection commit goes only to the base branch the owner chose, develop; main never gets the file.
    await repo.git(['checkout', '--quiet', '-b', 'develop'])
    const connected = await repo.commit({ [SETTINGS_FILE]: json({ ...MINIMAL, baseBranch: 'develop' }) }, 'connect')
    // A task's branch made from develop carries the same file, which names develop, not its own branch.
    await repo.git(['checkout', '--quiet', '-b', 'agent-queue/issue-5'])
    await repo.commit({ 'src/cart.ts': 'export {}\n' }, 'task')
    await repo.push()

    // Another computer: a clone that knows only origin. develop is not pushed yet: the task's copy names a branch origin
    // lacks, and that is named.
    const other = await repo.clone('shop-demo-2')
    let result = await readProjectSettings(machine, other)
    assert.ok(!result.ok && result.kind === 'invalid', JSON.stringify(result))
    assert.equal(result.source.branch, 'agent-queue/issue-5')
    assert.deepEqual(result.problems.map((problem) => problem.field), ['baseBranch'])
    assert.match(result.error, /names the base branch develop, but this clone has no origin\/develop/)

    await repo.push('develop')
    await repo.git(['fetch', '--quiet'], other)
    result = await readProjectSettings(machine, other)
    assert.equal(settingsOf(result).baseBranch, 'develop')
    assert.deepEqual(result.ok && result.source, { branch: 'develop', commit: connected })

    // The base branch's file found this way is checked whole: a wrong field there is named.
    await repo.git(['checkout', '--quiet', 'develop'])
    let broken = await repo.commit({ [SETTINGS_FILE]: json({ ...MINIMAL, baseBranch: 'develop', maxInProgress: 0 }) })
    await repo.push()
    await repo.git(['fetch', '--quiet'], other)
    result = await readProjectSettings(machine, other)
    assert.ok(!result.ok && result.kind === 'invalid', JSON.stringify(result))
    assert.deepEqual(result.problems.map((problem) => problem.field), ['maxInProgress'])
    assert.deepEqual(result.source, { branch: 'develop', commit: broken })

    // Even a wrong baseBranch: the copy whose base cannot be told is the base branch's own, and its field is named
    // (the task's copy names develop, which has a copy, and defers to it).
    broken = await repo.commit({ [SETTINGS_FILE]: json({ ...MINIMAL, baseBranch: 42 }) })
    await repo.push()
    await repo.git(['fetch', '--quiet'], other)
    result = await readProjectSettings(machine, other)
    assert.ok(!result.ok && result.kind === 'invalid', JSON.stringify(result))
    assert.deepEqual(result.problems.map((problem) => problem.field), ['baseBranch'])
    assert.deepEqual(result.source, { branch: 'develop', commit: broken })

    // A mistyped base branch: the copy names a branch without a copy, so it is the base's own, and the field is named.
    broken = await repo.commit({ [SETTINGS_FILE]: json({ ...MINIMAL, baseBranch: 'develp' }) })
    await repo.push()
    await repo.git(['fetch', '--quiet'], other)
    result = await readProjectSettings(machine, other)
    assert.ok(!result.ok && result.kind === 'invalid', JSON.stringify(result))
    assert.deepEqual(result.problems.map((problem) => problem.field), ['baseBranch'])
    assert.match(result.error, /names the base branch develp, but this clone has no origin\/develp/)
    assert.deepEqual(result.source, { branch: 'develop', commit: broken })

    // A second branch whose copy names itself: which one is the base branch is not known.
    await repo.commit({ [SETTINGS_FILE]: json({ ...MINIMAL, baseBranch: 'develop' }) })
    await repo.push()
    await repo.git(['checkout', '--quiet', '-b', 'staging'])
    await repo.commit({ [SETTINGS_FILE]: json({ ...MINIMAL, baseBranch: 'staging' }) })
    await repo.push()
    await repo.git(['fetch', '--quiet'], other)
    result = await readProjectSettings(machine, other)
    assert.ok(!result.ok && result.kind === 'ambiguous', JSON.stringify(result))
    assert.deepEqual(result.branches, ['develop', 'staging'])
    assert.match(result.error, /origin\/develop: names its own branch as baseBranch; origin\/staging: names its own/)
    // A caller that knows the base branch reads it directly.
    result = await readProjectSettings(machine, other, { branch: 'staging' })
    assert.equal(settingsOf(result).baseBranch, 'staging')
  })
})

test('в ветке по умолчанию файла нет, ни одна копия не называет свою ветку, а базой могут быть несколько испорченных → «неясно, какая ветка базовая» с причинами, ветка не выбирается', async () => {
  await withRepository(async (repo) => {
    await repo.git(['checkout', '--quiet', '-b', 'notes'])
    await repo.commit({ [SETTINGS_FILE]: '' }, 'empty')
    await repo.push()
    await repo.git(['checkout', '--quiet', '-b', 'draft', 'main'])
    await repo.commit({ [SETTINGS_FILE]: json({ ...MINIMAL, baseBranch: 'draft branch' }) }, 'not a branch name')
    await repo.push()
    let result = await readProjectSettings(machine, repo.checkout)
    assert.ok(!result.ok && result.kind === 'ambiguous', JSON.stringify(result))
    assert.deepEqual(result.branches, ['draft', 'notes'])
    assert.match(result.error, /origin\/draft: .*baseBranch: "draft branch" is not a branch name/)
    assert.match(result.error, /origin\/notes: .*not valid JSON/)

    // A branch whose copy names itself settles it: the copies that cannot say are not the base branch's.
    await repo.git(['checkout', '--quiet', '-b', 'develop', 'main'])
    await repo.commit({ [SETTINGS_FILE]: json({ ...MINIMAL, baseBranch: 'develop' }) }, 'connect')
    await repo.push()
    result = await readProjectSettings(machine, repo.checkout)
    assert.equal(settingsOf(result).baseBranch, 'develop')
  })
})

test('атрибут git -diff у файлов .json не прячет файл настроек выбранной базовой ветки', async () => {
  await withRepository(async (repo) => {
    // The attribute in the repository and in the user's own git configuration (core.attributesFile).
    const attributes = join(repo.origin, '..', 'attributes')
    writeFileSync(attributes, '*.json -diff\n')
    const config = join(repo.origin, '..', 'reader-gitconfig')
    writeFileSync(config, `[core]\n\tattributesFile = ${attributes.replace(/\\/g, '/')}\n`)
    const reader = realMachine({ now: fakeClock().now, env: { ...realMachine().env, GIT_CONFIG_GLOBAL: config } })
    await repo.git(['checkout', '--quiet', '-b', 'develop'])
    const connected = await repo.commit(
      { '.gitattributes': '*.json -diff\n', [SETTINGS_FILE]: json({ ...MINIMAL, baseBranch: 'develop' }) },
      'connect',
    )
    await repo.push()
    const result = await readProjectSettings(reader, await repo.clone('shop-demo-2'))
    assert.equal(settingsOf(result).baseBranch, 'develop')
    assert.deepEqual(result.ok && result.source, { branch: 'develop', commit: connected })
  })
})

test('ветка origin сдвинулась во время чтения → настройки и их источник — из одного и того же коммита, на котором выбрана базовая ветка', async () => {
  await withRepository(async (repo) => {
    await repo.git(['checkout', '--quiet', '-b', 'develop'])
    const connected = await repo.commit({ [SETTINGS_FILE]: json({ ...MINIMAL, baseBranch: 'develop' }) }, 'connect')
    await repo.push()
    // The next commit of develop names another base branch; a fetch brings it while the plugin reads.
    const next = await repo.commit({ [SETTINGS_FILE]: json({ ...MINIMAL, baseBranch: 'release' }) }, 'next')
    let fetched = false
    const reader = realMachine({
      now: fakeClock().now,
      start: async (request) => {
        const outcome = await startProcess(request)
        if (!fetched && request.args.includes('for-each-ref')) {
          fetched = true
          await repo.git(['update-ref', 'refs/remotes/origin/develop', next])
        }
        return outcome
      },
    })
    const result = await readProjectSettings(reader, repo.checkout)
    assert.ok(fetched, 'the reader looked at origin’s branches')
    assert.equal(settingsOf(result).baseBranch, 'develop')
    assert.deepEqual(result.ok && result.source, { branch: 'develop', commit: connected })
  })
})

test('клон одной ветки без origin/<ветка по умолчанию> → «не прочитано» с её именем, базовая ветка по остальным не выбирается; названная ветка читается, а после загрузки ветки по умолчанию база находится', async () => {
  await withRepository(async (repo) => {
    // main, the default branch, has no file; the only one is the connection commit on develop.
    await repo.git(['checkout', '--quiet', '-b', 'develop'])
    const connected = await repo.commit({ [SETTINGS_FILE]: json({ ...MINIMAL, baseBranch: 'develop' }) }, 'connect')
    await repo.push()
    // A clone of develop alone: it knows origin/develop, not origin/main.
    const single = await repo.clone('shop-demo-develop', ['--single-branch', '--branch', 'develop'])

    let result = await readProjectSettings(machine, single)
    assert.ok(!result.ok && result.kind === 'unreadable', JSON.stringify(result))
    assert.match(result.error, /this clone has no origin\/main, the repository's default branch, where reading starts/)

    result = await readProjectSettings(machine, single, { branch: 'develop' })
    assert.equal(settingsOf(result).baseBranch, 'develop')
    assert.deepEqual(result.ok && result.source, { branch: 'develop', commit: connected })

    // Once the clone has the default branch, the search finds develop.
    await repo.git(['fetch', '--quiet', 'origin', 'main:refs/remotes/origin/main'], single)
    result = await readProjectSettings(machine, single)
    assert.equal(settingsOf(result).baseBranch, 'develop')
    assert.deepEqual(result.ok && result.source, { branch: 'develop', commit: connected })
  })
})

test('git вернул список веток origin не целиком → «не прочитано» с причиной до любого решения, без ветки и с названной', async () => {
  await withRepository(async (repo) => {
    await repo.git(['checkout', '--quiet', '-b', 'develop'])
    await repo.commit({ [SETTINGS_FILE]: json({ ...MINIMAL, baseBranch: 'develop' }) }, 'connect')
    await repo.push()
    await repo.git(['checkout', '--quiet', '-b', 'staging'])
    await repo.commit({ [SETTINGS_FILE]: json({ ...MINIMAL, baseBranch: 'staging' }) })
    await repo.push()
    // The run layer kept only the beginning and the end of a huge list: staging was in the part left out.
    const cut = realMachine({
      now: fakeClock().now,
      start: async (request) => {
        const outcome = await startProcess(request)
        if (!request.args.includes('for-each-ref')) return outcome
        const lines = outcome.stdout.split('\n')
        const kept = lines.filter((line) => !line.startsWith('refs/remotes/origin/staging'))
        assert.equal(kept.length, lines.length - 1, outcome.stdout)
        return { ...outcome, stdout: kept.join('\n'), truncated: true }
      },
    })
    for (const options of [{}, { branch: 'staging' }]) {
      const result = await readProjectSettings(cut, repo.checkout, options)
      assert.ok(!result.ok && result.kind === 'unreadable', JSON.stringify(result))
      assert.match(result.error, /git for-each-ref .*: its output was too large to keep/)
    }

    // The whole list: two branches each name themselves.
    const whole = await readProjectSettings(machine, repo.checkout)
    assert.ok(!whole.ok && whole.kind === 'ambiguous', JSON.stringify(whole))
    assert.deepEqual(whole.branches, ['develop', 'staging'])
  })
})

test('много веток с большой копией файла настроек → каждый разный файл читается один раз, база находится; файл больше предела — своя причина', async () => {
  await withRepository(async (repo) => {
    // develop's file with a long data rule: 300 KiB.
    const big = { ...MINIMAL, baseBranch: 'develop', dataRule: `${'No customer data in GitHub. '.repeat(11_000)}` }
    await repo.git(['checkout', '--quiet', '-b', 'develop'])
    const connected = await repo.commit({ [SETTINGS_FILE]: json(big) }, 'connect')
    await repo.push()
    // 60 branches of origin, each its own commit made from develop, all with the same copy: 18 MiB in all.
    const tree = (await repo.git(['rev-parse', 'HEAD^{tree}'])).trim()
    for (let i = 0; i < 60; i++) {
      const commit = (await repo.git(['commit-tree', tree, '-p', connected, '-m', `task ${i}`])).trim()
      await repo.git(['update-ref', `refs/remotes/origin/agent-queue/issue-${100 + i}`, commit])
    }
    // A branch with a settings file above the limit.
    await repo.git(['checkout', '--quiet', '-b', 'huge', 'main'])
    await repo.commit({ [SETTINGS_FILE]: json({ ...MINIMAL, baseBranch: 'huge', dataRule: 'x'.repeat(1_100_000) }) })
    await repo.push()

    const starts: string[][] = []
    const reader = realMachine({
      now: fakeClock().now,
      start: (request) => {
        starts.push([...request.args])
        return startProcess(request)
      },
    })
    let result = await readProjectSettings(reader, repo.checkout)
    assert.equal(settingsOf(result).dataRule, big.dataRule)
    assert.deepEqual(result.ok && result.source, { branch: 'develop', commit: connected })
    // One read of develop's file for all 61 copies; the file above the limit is not read at all.
    assert.equal(starts.filter((args) => args.includes('cat-file')).length, 1)

    result = await readProjectSettings(machine, repo.checkout, { branch: 'huge' })
    assert.ok(!result.ok && result.kind === 'unreadable', JSON.stringify(result))
    assert.match(result.error, /origin\/huge: \.agent-queue\.json is \d+ bytes, more than the 1048576 read/)
  })
})

test('базовая ветка develop влита в ветку по умолчанию: файл в main называет develop → настройки берутся из файла develop, ошибка другого поля в копии main не мешает', async () => {
  await withRepository(async (repo) => {
    await repo.git(['checkout', '--quiet', '-b', 'develop'])
    await repo.commit({ [SETTINGS_FILE]: json({ ...MINIMAL, baseBranch: 'develop' }) }, 'connect')
    await repo.push()
    // A release: develop is merged into main, which now carries develop's file.
    await repo.git(['checkout', '--quiet', 'main'])
    await repo.git(['merge', '--quiet', '--no-ff', '--no-edit', 'develop'])
    await repo.push()
    // The owner then changes the settings on the base branch; main keeps the older file.
    await repo.git(['checkout', '--quiet', 'develop'])
    const develop = await repo.commit({ [SETTINGS_FILE]: json({ ...MINIMAL, baseBranch: 'develop', maxInProgress: 2 }) })
    await repo.push()

    let result = await readProjectSettings(machine, repo.checkout)
    assert.equal(settingsOf(result).baseBranch, 'develop')
    assert.equal(settingsOf(result).maxInProgress, 2)
    assert.deepEqual(result.ok && result.source, { branch: 'develop', commit: develop })

    // main's copy only names the base branch: a wrong field elsewhere in it does not stop reading develop's own file.
    await repo.git(['checkout', '--quiet', 'main'])
    const main = await repo.commit({ [SETTINGS_FILE]: json({ ...MINIMAL, baseBranch: 'develop', testCommand: '' }) })
    await repo.push()
    await repo.git(['checkout', '--quiet', 'develop'])
    result = await readProjectSettings(machine, repo.checkout)
    assert.equal(settingsOf(result).maxInProgress, 2)
    assert.deepEqual(result.ok && result.source, { branch: 'develop', commit: develop })

    // Reading may start at a branch the caller knows: the same settings.
    result = await readProjectSettings(machine, repo.checkout, { branch: 'develop' })
    assert.deepEqual(result.ok && result.source, { branch: 'develop', commit: develop })

    // The named branch's file names yet another branch: refused, naming baseBranch.
    const other = await repo.commit({ [SETTINGS_FILE]: json({ ...MINIMAL, baseBranch: 'release' }) })
    await repo.push()
    result = await readProjectSettings(machine, repo.checkout)
    assert.ok(!result.ok && result.kind === 'invalid', JSON.stringify(result))
    assert.deepEqual(result.problems.map((problem) => problem.field), ['baseBranch'])
    assert.deepEqual(result.source, { branch: 'develop', commit: other })

    // The named branch has no settings file: refused, naming baseBranch of the file that named it.
    await repo.git(['rm', '--quiet', SETTINGS_FILE])
    await repo.git(['commit', '--quiet', '--no-verify', '-m', 'no settings'])
    await repo.push()
    result = await readProjectSettings(machine, repo.checkout)
    assert.ok(!result.ok && result.kind === 'invalid', JSON.stringify(result))
    assert.deepEqual(result.problems.map((problem) => problem.field), ['baseBranch'])
    assert.deepEqual(result.source, { branch: 'main', commit: main })
  })
})

test('клон без origin/HEAD → ветку по умолчанию называет сам origin', async () => {
  await withRepository(
    async (repo) => {
      await repo.commit({ [SETTINGS_FILE]: json(MINIMAL) })
      await repo.push()
      const result = await readProjectSettings(machine, repo.checkout)
      assert.equal(settingsOf(result).baseBranch, 'trunk')
      assert.equal(result.ok && result.source.branch, 'trunk')
    },
    { defaultBranch: 'trunk', originHead: false },
  )
})

test('git не может прочитать файл → «не прочитано» с причиной, а не «файла нет»', async () => {
  // Not a repository at all.
  const empty = mkdtempSync(join(tmpdir(), 'agent-queue-no-repo-'))
  try {
    const result = await readProjectSettings(machine, empty)
    assert.ok(!result.ok && result.kind === 'unreadable', JSON.stringify(result))
    assert.match(result.error, /git/)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
  await withRepository(async (repo) => {
    // A base branch this clone never fetched.
    const result = await readProjectSettings(machine, repo.checkout, { branch: 'release' })
    assert.ok(!result.ok && result.kind === 'unreadable', JSON.stringify(result))
    assert.match(result.error, /origin\/release/)

    // HEAD is git's name for the current commit, never a base branch: origin/HEAD is not read as one.
    const head = await readProjectSettings(machine, repo.checkout, { branch: 'HEAD' })
    assert.ok(!head.ok && head.kind === 'unreadable', JSON.stringify(head))
    assert.match(head.error, /"HEAD" is not a branch name/)

    // The settings path is a directory.
    await repo.commit({ [`${SETTINGS_FILE}/x.json`]: '{}' })
    await repo.push()
    const directory = await readProjectSettings(machine, repo.checkout)
    assert.ok(!directory.ok && directory.kind === 'unreadable', JSON.stringify(directory))
    assert.match(directory.error, /directory/)
  })
  // git is not there at all.
  const noGit = await readProjectSettings(fakeMachine({ platform: 'linux', env: { PATH: '/usr/bin' } }), '/work/shop-demo')
  assert.ok(!noGit.ok && noGit.kind === 'unreadable', JSON.stringify(noGit))
  assert.match(noGit.error, /git is not in PATH/)
})

test('все поля .agent-queue.json: файл мастера подключения читается теми же настройками, а команды тестов идут в запуск тестов проекта', async () => {
  const full: ProjectSettings = {
    version: 1,
    baseBranch: 'main',
    testCommand: 'make test',
    testCommandWindows: 'npm run test:windows',
    agents: { implementer: 'claude', reviewer: 'codex', solver: 'gemini', start: 'claude' },
    language: 'ru',
    dataRule: 'В GitHub не попадают имена, телефоны и номера заказов клиентов.',
    maxInProgress: 3,
    worktreeDependencies: { mode: 'own', directories: ['node_modules', 'vendor'] },
    afterMerge: [
      { command: 'make docs', name: 'Документация' },
      { command: 'make cache-clear', name: null },
    ],
    forbiddenPatterns: ['ORD-[0-9]{6}', 'CUST_[A-Z]{3}[0-9]{4}'],
    acceptanceStand: {
      setup: 'npm ci && make stand-setup',
      up: 'make stand-up STAND_PORT=47391',
      url: 'http://127.0.0.1:47391',
      down: 'make stand-down STAND_PORT=47391',
    },
  }
  await withRepository(async (repo) => {
    await repo.commit({ [SETTINGS_FILE]: formatProjectSettings(full) })
    await repo.push()
    const settings = settingsOf(await readProjectSettings(machine, repo.checkout))
    assert.deepEqual(settings, full)

    // The test commands are those of the run layer (ProjectTestSettings): Windows gets its own, other systems the main.
    assert.equal(projectTestCommand(fakeMachine({ platform: 'win32' }), settings), 'npm run test:windows')
    assert.equal(projectTestCommand(fakeMachine({ platform: 'linux' }), settings), 'make test')
    assert.equal(projectTestCommand(fakeMachine({ platform: 'darwin' }), settings), 'make test')

    // The forbidden patterns find their data in a text.
    const text = 'Заказ ORD-123456 клиента CUST_ABC1234, заказ ORD-654321.'
    assert.deepEqual(
      forbiddenPatternRegExps(settings).flatMap((pattern) => text.match(pattern) ?? []),
      ['ORD-123456', 'ORD-654321', 'CUST_ABC1234'],
    )
  })
})
