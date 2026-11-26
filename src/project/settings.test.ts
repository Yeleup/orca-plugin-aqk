// The project's settings file .agent-queue.json (TZ «Данные», Ф1 point 3): its check names the field at fault, a file
// without optional fields gets the defaults of the connection form, and the plugin reads the file committed to the
// project's base branch (origin/<branch>) — with real git on a temporary repository whose `origin` is a local bare one.
import { assert, test } from 'orca/testing'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realMachine } from '../platform/machine'
import { projectTestCommand } from '../platform/run'
import { fakeClock, fakeMachine } from '../testing/fake-machine'
import { withRepository } from '../testing/git-repository'
import { textsInCommits } from './base-branch'
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
    // Branches whose file is empty or not JSON do not name a branch either.
    await repo.git(['checkout', '--quiet', '-b', 'notes', 'main'])
    await repo.commit({ [SETTINGS_FILE]: '' }, 'empty')
    await repo.push()
    await repo.git(['checkout', '--quiet', '-b', 'draft', 'main'])
    await repo.commit({ [SETTINGS_FILE]: '{ "baseBranch": "draft", ' }, 'not json')
    await repo.push()

    // Another computer: a clone that knows only origin. develop is not pushed yet: no branch names itself.
    const other = await repo.clone('shop-demo-2')
    let result = await readProjectSettings(machine, other)
    assert.ok(!result.ok && result.kind === 'missing', JSON.stringify(result))
    assert.equal(result.source.branch, 'main')
    assert.match(result.error, /origin\/main has no \.agent-queue\.json, and no other branch/)

    await repo.push('develop')
    await repo.git(['fetch', '--quiet'], other)
    result = await readProjectSettings(machine, other)
    assert.equal(settingsOf(result).baseBranch, 'develop')
    assert.deepEqual(result.ok && result.source, { branch: 'develop', commit: connected })

    // The file of the base branch found this way is checked whole: a wrong field there is named.
    await repo.git(['checkout', '--quiet', 'develop'])
    const broken = await repo.commit({ [SETTINGS_FILE]: json({ ...MINIMAL, baseBranch: 'develop', maxInProgress: 0 }) })
    await repo.push()
    await repo.git(['fetch', '--quiet'], other)
    result = await readProjectSettings(machine, other)
    assert.ok(!result.ok && result.kind === 'invalid', JSON.stringify(result))
    assert.deepEqual(result.problems.map((problem) => problem.field), ['maxInProgress'])
    assert.deepEqual(result.source, { branch: 'develop', commit: broken })

    // A second branch whose file names itself: which one is the base branch is not known.
    await repo.git(['checkout', '--quiet', '-b', 'staging'])
    await repo.commit({ [SETTINGS_FILE]: json({ ...MINIMAL, baseBranch: 'staging' }) })
    await repo.push()
    await repo.git(['fetch', '--quiet'], other)
    result = await readProjectSettings(machine, other)
    assert.ok(!result.ok && result.kind === 'ambiguous', JSON.stringify(result))
    assert.deepEqual(result.branches, ['develop', 'staging'])
    assert.match(result.error, /origin\/develop, origin\/staging/)
    // A caller that knows the base branch reads it directly.
    result = await readProjectSettings(machine, other, { branch: 'staging' })
    assert.equal(settingsOf(result).baseBranch, 'staging')
  })
})

test('базовая ветка develop влита в ветку по умолчанию: файл в main называет develop → настройки берутся из файла develop', async () => {
  await withRepository(async (repo) => {
    await repo.git(['checkout', '--quiet', '-b', 'develop'])
    await repo.commit({ [SETTINGS_FILE]: json({ ...MINIMAL, baseBranch: 'develop' }) }, 'connect')
    await repo.push()
    // A release: develop is merged into main, which now carries develop's file.
    await repo.git(['checkout', '--quiet', 'main'])
    await repo.git(['merge', '--quiet', '--no-ff', '--no-edit', 'develop'])
    const main = (await repo.git(['rev-parse', 'HEAD'])).trim()
    await repo.push()
    // The owner then changes the settings on the base branch; main keeps the older file.
    await repo.git(['checkout', '--quiet', 'develop'])
    const develop = await repo.commit({ [SETTINGS_FILE]: json({ ...MINIMAL, baseBranch: 'develop', maxInProgress: 2 }) })
    await repo.push()

    let result = await readProjectSettings(machine, repo.checkout)
    assert.equal(settingsOf(result).baseBranch, 'develop')
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

test('поиск файла настроек по многим веткам: найден каждый коммит с файлом, и за пределом одного запуска git grep; каталог с тем же именем — не файл', async () => {
  await withRepository(async (repo) => {
    await repo.commit({ [SETTINGS_FILE]: json(MINIMAL) })
    const withFile = (await repo.git(['rev-parse', 'HEAD^{tree}'])).trim()
    const withoutFile = (await repo.git(['rev-parse', 'HEAD~1^{tree}'])).trim()
    // 230 commits, more than one git grep takes; every tenth has no settings file.
    const commits: string[] = []
    for (let i = 0; i < 230; i++) {
      commits.push((await repo.git(['commit-tree', i % 10 === 9 ? withoutFile : withFile, '-m', `commit ${i}`])).trim())
    }
    // A commit with a directory of that name instead of the file has no settings file either.
    await repo.git(['rm', '--quiet', SETTINGS_FILE])
    const directory = await repo.commit({ [`${SETTINGS_FILE}/settings.json`]: json(MINIMAL) })
    // Searched from a subdirectory of the checkout: paths count from the root all the same.
    repo.write('src/app/main.ts', 'export {}\n')
    const texts = await textsInCommits(machine, join(repo.checkout, 'src', 'app'), [...commits, directory], SETTINGS_FILE)
    assert.deepEqual([...texts.keys()].sort(), commits.filter((_, i) => i % 10 !== 9).sort())
    for (const text of texts.values()) assert.deepEqual(JSON.parse(text), MINIMAL)
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
