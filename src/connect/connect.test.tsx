// «Подключение проекта» end to end (Ф1, points 1–4, without the path through a PR; Ф3, the entry rule): the panel Orca
// opens, the real worker, real git on a temporary repository whose `origin` is a local bare repository, fake `gh` with
// a fake GitHub, a fake CLI of Orca and a fake clock (src/testing/connect-world.ts). Every name, repository and number
// is invented.
import { afterEach, assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platform } from 'node:process'
import * as panelModule from '../panel'
import { PLUGIN_LABELS } from '../github/labels'
import { dataDirectory } from '../platform/paths'
import { ENTRY_RULE_BEGIN, entryRuleBlock, entryRuleIn } from '../project/entry-rule'
import { parseProjectSettings } from '../project/settings'
import { dataRuleTemplate, taskRulesTemplate } from '../project/templates'
import type { ConnectCandidate, ConnectForm, ConnectResult, GhCheck } from '../protocol'
import { backToQueue, openScreen } from '../ui/navigation'
import { textsIn, textsNotFromCatalog } from '../testing/panel-tree'
import {
  GITHUB_REPOSITORY,
  MARKED_HOOKS,
  OTHER_HOST,
  SHOP,
  withConnectWorld,
  writeMarkingHooks,
  type ConnectWorld,
} from '../testing/connect-world'
import type { FakeGhCall } from '../testing/fake-github'

const FOUR = ['.agent-queue.json', '.agent-queue.md', 'AGENTS.md', 'CLAUDE.md']
const CHOOSE = `choose:local:${SHOP.id}`
const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(3)}abcdef`

let view: TestPanel | undefined
afterEach(async () => {
  await view?.unmount()
  view = undefined
})

// Every draw of the panel lets the waiters of `nextDraw()` go on (as in src/panel.test.tsx): a test sees the panel as it
// is drawn while an answer it holds back is on its way.
let drawWaiters: (() => void)[] = []
function nextDraw(): Promise<void> {
  return new Promise((resolve) => drawWaiters.push(resolve))
}
const Panel = panelModule.default
const observedPanel = {
  setup: panelModule.setup,
  default: () => {
    for (const resolve of drawWaiters.splice(0)) resolve()
    return <Panel />
  },
}

/** Waits for the draws of the panel until `shows` holds (at most 20 draws). */
async function drawnUntil(panel: TestPanel, shows: () => boolean): Promise<void> {
  for (let draw = 0; draw < 20 && !shows(); draw++) await nextDraw()
  assert.ok(shows(), shown(panel))
}

/** Lets the worker go on until `holds` holds (at most 4 s): for what goes on while an answer is held back. */
async function until(holds: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 800 && !holds(); turn++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(holds(), what)
}

/** The panel in Russian over the world's worker, on «Подключение проекта» (from the menu of «Очередь»). */
async function openWizard(world: ConnectWorld, settings?: Record<string, string>): Promise<TestPanel> {
  await view?.unmount()
  view = await mount(observedPanel, { host: world.panelHost(settings) })
  await view.press({ type: 'Button', text: 'Подключить проект' })
  return view
}

async function chooseShop(panel: TestPanel): Promise<void> {
  await panel.press({ testId: CHOOSE })
}

/** Step 3 open, the test command typed. */
async function openForm(world: ConnectWorld): Promise<TestPanel> {
  const panel = await openWizard(world)
  await chooseShop(panel)
  await panel.type({ label: 'Команда полных тестов' }, 'make test')
  return panel
}

function shown(panel: TestPanel): string {
  return textsIn(panel.tree()).join('\n')
}

function headings(panel: TestPanel): string[] {
  return panel.findAll({ type: 'Heading' }).map((heading) => heading.text)
}

function connectButton(panel: TestPanel) {
  return panel.find({ type: 'Button', text: 'Подключить' })
}

function fieldError(panel: TestPanel, label: string): unknown {
  return panel.findAll({ type: 'Field' }).find((field) => field.label === label)?.props.error
}

function assertClean(panel: TestPanel, data: readonly string[] = []): void {
  assert.deepEqual(panel.errors, [])
  assert.deepEqual(panel.warnings, [])
  assert.deepEqual(panel.refusals, [])
  const values = [SHOP.name, GITHUB_REPOSITORY, 'main', 'Claude', 'Codex', ...data]
  const stray = textsNotFromCatalog(textsIn(panel.tree()), 'ru', values).filter((text) => !values.some((value) => text.includes(value)))
  assert.deepEqual(stray, [], 'тексты мимо каталога строк')
}

type RepoState = { head: string; status: string; origin: string; files: string[] }

async function repoState(world: ConnectWorld): Promise<RepoState> {
  const { repo } = world
  return {
    head: (await repo.git(['rev-parse', 'HEAD'])).trim(),
    status: await repo.git(['status', '--porcelain', '--untracked-files=all']),
    origin: (await repo.git(['rev-parse', 'main'], repo.origin)).trim(),
    files: readdirSync(repo.checkout).filter((name) => name !== '.git').sort(),
  }
}

// What the worker wrote to GitHub: every gh call that is not a read.
function writes(world: ConnectWorld): FakeGhCall[] {
  return world.github.calls.filter((call) => call.method !== 'GET' && call.path !== 'graphql')
}

// The operations recorded in the journal of this computer, by their directories.
function operations(world: ConnectWorld): string[] {
  const projects = join(dataDirectory(world.machine), 'projects')
  if (!existsSync(projects)) return []
  return readdirSync(projects).flatMap((project) => {
    const dir = join(projects, project, 'operations')
    return existsSync(dir) ? readdirSync(dir).map((operation) => join(dir, operation)) : []
  })
}

function journal(dir: string, step: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, `${step}.json`), 'utf8')) as Record<string, unknown>
}

async function assertNothingWritten(world: ConnectWorld, before: RepoState, what: string): Promise<void> {
  assert.deepEqual(await repoState(world), before, `${what}: репозиторий изменился`)
  assert.deepEqual(writes(world), [], `${what}: запись в GitHub`)
  assert.deepEqual(world.github.labels.filter((label) => label.name.startsWith('agent-queue')), [], `${what}: метки`)
  assert.deepEqual(operations(world), [], `${what}: журнал операций`)
}

async function changedIn(world: ConnectWorld, commit: string): Promise<string[]> {
  return (await world.repo.git(['diff-tree', '--no-commit-id', '--name-only', '-r', commit], world.repo.origin))
    .split('\n')
    .filter((line) => line !== '')
    .sort()
}

async function fileOnOrigin(world: ConnectWorld, path: string): Promise<string> {
  return world.repo.git(['show', `main:${path}`], world.repo.origin)
}

/** The form of «Подключить» a request sends straight to the worker. */
function form(values: Partial<ConnectForm> = {}): ConnectForm {
  return {
    baseBranch: 'main',
    testCommand: 'make test',
    testCommandWindows: '',
    agents: { implementer: 'claude', reviewer: 'codex', solver: 'claude', start: 'claude' },
    language: 'ru',
    dataRule: dataRuleTemplate('ru'),
    taskRules: taskRulesTemplate({ language: 'ru', testCommand: 'make test' }),
    maxInProgress: '1',
    worktreeMode: 'shared',
    directories: '',
    ...values,
  }
}

function connect(world: ConnectWorld, values: Partial<ConnectForm> = {}): Promise<ConnectResult> {
  return world.worker.request('connect.connect', { projectId: SHOP.id, hostId: SHOP.hostId, form: form(values) })
}

/** The checkout is clean and on a pushed commit whose parent is `source` and which changes exactly the four files. */
async function assertConnected(world: ConnectWorld, source: string): Promise<string> {
  const after = await repoState(world)
  assert.equal(after.status, '', 'чекаут не чистый после подключения')
  assert.equal(after.origin, after.head, 'коммит не запушен')
  assert.equal((await world.repo.git(['rev-parse', `${after.head}^`])).trim(), source, 'родитель коммита — не исходный SHA')
  assert.deepEqual(await changedIn(world, after.head), FOUR)
  return after.head
}

// ── Criteria ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('К1.1: подключить проект при исправных gh и git → коммит в базовой ветке меняет только .agent-queue.json, .agent-queue.md, CLAUDE.md, AGENTS.md; в GitHub семь меток плагина; коммит запушен; открыт экран «Проверка проекта»', async () => {
  await withConnectWorld(async (world) => {
    const source = (await repoState(world)).head
    assert.deepEqual(await world.worker.request('projects.list'), { projects: [] })
    const panel = await openWizard(world)
    assert.deepEqual(headings(panel), ['Подключение проекта'])
    assert.match(shown(panel), /Проекты Orca, ещё не подключённые:/)
    assert.ok(shown(panel).includes(`· GitHub: ${GITHUB_REPOSITORY}`), shown(panel))
    assert.ok(!shown(panel).includes('notes'), 'папка Orca в списке проектов')
    await chooseShop(panel)
    for (const line of [`git и GitHub: ${GITHUB_REPOSITORY}`, 'gh: вход есть', 'агенты: claude, codex']) {
      assert.ok(shown(panel).includes(line), `нет строки «${line}»`)
    }
    assert.equal(panel.valueOf({ label: 'Базовая ветка' }), 'main')
    await panel.type({ label: 'Команда полных тестов' }, 'make test')
    assertClean(panel, [world.repo.checkout, 'make test'])
    await panel.press({ type: 'Button', text: 'Подключить' })

    assert.deepEqual(headings(panel), ['Проверка проекта'])
    await assertConnected(world, source)
    assert.deepEqual(world.github.labels.map((label) => label.name).sort(), [...PLUGIN_LABELS].sort())
    const settings = parseProjectSettings(await fileOnOrigin(world, '.agent-queue.json'), 'main')
    assert.ok(settings.ok, JSON.stringify(settings))
    assert.equal(settings.settings.testCommand, 'make test')
    assert.equal(settings.settings.baseBranch, 'main')
    assert.equal(settings.settings.language, 'ru')
    assert.deepEqual(settings.settings.agents, { implementer: 'claude', reviewer: 'codex', solver: 'claude', start: 'claude' })
    assert.equal(settings.settings.maxInProgress, 1)
    assert.deepEqual(settings.settings.worktreeDependencies, { mode: 'shared', directories: [] })
    assert.equal(settings.settings.dataRule, dataRuleTemplate('ru'))
    assert.equal(await fileOnOrigin(world, '.agent-queue.md'), taskRulesTemplate({ language: 'ru', testCommand: 'make test' }))
    for (const file of ['CLAUDE.md', 'AGENTS.md']) {
      assert.equal(await fileOnOrigin(world, file), `${entryRuleBlock('ru', GITHUB_REPOSITORY)}\n`, file)
    }
    assert.deepEqual(await world.worker.request('projects.list'), { projects: [SHOP] })
    assert.deepEqual(world.worker.posts.at(-1), { event: 'projects.changed', payload: { projects: [SHOP] } })
    assert.deepEqual(await world.worker.request('connect.projects'), { projects: [] }, 'подключённый проект снова предложен')
    assert.deepEqual(panel.errors, [])
    assert.deepEqual(panel.refusals, [])
  })
})

test('К1.2: gh без входа → мастер показывает «gh: нет входа — выполните gh auth login», «Подключить» недоступна, файлы и GitHub не меняются', async () => {
  await withConnectWorld(
    async (world) => {
      const before = await repoState(world)
      const panel = await openWizard(world)
      await chooseShop(panel)
      assert.ok(shown(panel).includes('gh: нет входа — выполните gh auth login'), shown(panel))
      assert.ok(shown(panel).includes('Подключить нельзя, пока не исправлено: выполните gh auth login в терминале и проверьте снова.'))
      assert.equal(connectButton(panel), null, '«Подключить» есть на экране')
      assert.equal(panel.find({ label: 'Команда полных тестов' }), null, 'форма открыта')
      assert.ok(panel.find({ type: 'Button', text: 'Проверить снова' }))
      assertClean(panel, [world.repo.checkout])
      // The worker refuses «Подключить» itself.
      const result = await connect(world)
      assert.deepEqual(result, { status: 'refused', refusal: { reason: 'gh', check: { status: 'problem', problem: 'not-logged-in' } } })
      await assertNothingWritten(world, before, 'gh без входа')
      // Logged in now: «Проверить снова» opens the form.
      world.github.login = 'avery-example'
      await panel.press({ type: 'Button', text: 'Проверить снова' })
      assert.ok(connectButton(panel), 'после входа «Подключить» нет')
    },
    { login: null },
  )
})

test('К1.3 (не на базовой ветке): основной чекаут на другой ветке → «Подключить» отказывает с этой причиной, ничего не записано и не запушено', async () => {
  await withConnectWorld(async (world) => {
    const panel = await openForm(world)
    await world.repo.git(['checkout', '--quiet', '-b', 'feature/search'])
    const before = await repoState(world)
    await panel.press({ type: 'Button', text: 'Подключить' })
    assert.ok(
      shown(panel).includes('Основной чекаут не на базовой ветке main (сейчас feature/search). Ничего не записано.'),
      shown(panel),
    )
    assert.ok(panel.find({ type: 'Button', text: 'Проверить снова' }))
    assertClean(panel, ['feature/search'])
    await assertNothingWritten(world, before, 'не на базовой ветке')
  })
})

test('К1.3 (с изменениями): в основном чекауте изменённый и новый файл → «Подключить» отказывает с этой причиной, ничего не записано и не запушено', async () => {
  await withConnectWorld(async (world) => {
    world.repo.write('README.md', '# shop-demo\n\nчерновик\n')
    world.repo.write('notes.txt', 'заметки\n')
    const before = await repoState(world)
    const result = await connect(world)
    assert.deepEqual(result, { status: 'refused', refusal: { reason: 'dirty', paths: 2 } })
    const panel = await openForm(world)
    await panel.press({ type: 'Button', text: 'Подключить' })
    assert.ok(shown(panel).includes('Основной чекаут с изменениями: изменённых путей — 2. Ничего не записано.'), shown(panel))
    await assertNothingWritten(world, before, 'с изменениями')
  })
})

test('К1.3 (отстаёт): HEAD основного чекаута отстаёт от удалённой базовой ветки после свежего fetch → «Подключить» отказывает с этой причиной, ничего не записано и не запушено', async () => {
  await withConnectWorld(async (world) => {
    // Another computer pushed to main; this checkout has not fetched it — the plugin's own fetch finds it.
    const other = await world.repo.clone('elsewhere')
    await world.repo.git(['commit', '--quiet', '--allow-empty', '-m', 'elsewhere'], other)
    await world.repo.git(['push', '--quiet', 'origin', 'HEAD:main'], other)
    const result = await connect(world)
    assert.deepEqual(result, { status: 'refused', refusal: { reason: 'behind', commits: 1, base: 'main' } })
    const before = await repoState(world)
    const panel = await openForm(world)
    await panel.press({ type: 'Button', text: 'Подключить' })
    assert.ok(shown(panel).includes('Основной чекаут отстаёт от origin/main: коммитов — 1. Ничего не записано.'), shown(panel))
    await assertNothingWritten(world, before, 'отстаёт')
  })
})

test('К1.3 (опережает): у основного чекаута незапушенный коммит → «Подключить» отказывает с этой причиной, ничего не записано и не запушено', async () => {
  await withConnectWorld(async (world) => {
    await world.repo.commit({ 'src/app.txt': 'приложение\n' }, 'not pushed')
    const before = await repoState(world)
    const panel = await openForm(world)
    await panel.press({ type: 'Button', text: 'Подключить' })
    assert.ok(shown(panel).includes('Основной чекаут опережает origin/main: коммитов — 1. Ничего не записано.'), shown(panel))
    await assertNothingWritten(world, before, 'опережает')
  })
})

test('К1.4: пустая команда полных тестов → ошибка у поля, ничего не записано', async () => {
  await withConnectWorld(async (world) => {
    const before = await repoState(world)
    const panel = await openWizard(world)
    await chooseShop(panel)
    assert.equal(panel.valueOf({ label: 'Команда полных тестов' }), '')
    await panel.press({ type: 'Button', text: 'Подключить' })
    assert.equal(fieldError(panel, 'Команда полных тестов'), 'Нужна команда полных тестов')
    assert.equal(connectButton(panel)?.disabled, true, '«Подключить» доступна при ошибке поля')
    assertClean(panel, [world.repo.checkout])
    await assertNothingWritten(world, before, 'пустая команда')
    // Spaces only are empty too, also for the worker itself.
    const result = await connect(world, { testCommand: '   ' })
    assert.deepEqual(result, {
      status: 'fields',
      errors: [{ field: 'testCommand', code: 'required', detail: 'the command of the full tests is required' }],
      agents: null,
    })
    await assertNothingWritten(world, before, 'пробелы вместо команды')
    // The field changes: its error goes, «Подключить» is there again.
    await panel.type({ label: 'Команда полных тестов' }, 'make test')
    assert.equal(fieldError(panel, 'Команда полных тестов'), undefined)
    assert.equal(connectButton(panel)?.disabled, false)
  })
})

test('К1.5: у проекта нет удалённого репозитория GitHub → «Подключение невозможно: нет удалённого репозитория GitHub», форма настроек не открывается', async () => {
  await withConnectWorld(
    async (world) => {
      const before = await repoState(world)
      const panel = await openWizard(world)
      assert.ok(shown(panel).includes(`${world.repo.checkout} · удалённого репозитория GitHub нет`), shown(panel))
      await chooseShop(panel)
      assert.ok(shown(panel).includes('Подключение невозможно: нет удалённого репозитория GitHub'), shown(panel))
      assert.equal(panel.find({ label: 'Команда полных тестов' }), null, 'форма открыта')
      assert.equal(connectButton(panel), null)
      assert.ok(panel.find({ type: 'Button', text: 'К выбору проекта' }))
      assertClean(panel, [world.repo.checkout])
      const result = await connect(world)
      assert.deepEqual(result, { status: 'refused', refusal: { reason: 'git', check: { status: 'problem', problem: 'no-github' } } })
      await assertNothingWritten(world, before, 'нет GitHub')
      assert.deepEqual(world.github.calls, [], 'gh вызван без репозитория GitHub')
      await panel.press({ type: 'Button', text: 'К выбору проекта' })
      assert.ok(panel.find({ testId: CHOOSE }))
    },
    { github: false },
  )
})

test('К1.6: у части меток уже есть → создаются только недостающие; в CLAUDE.md с чужим текстом этот текст остаётся, блок правила добавлен один раз', async () => {
  await withConnectWorld(async (world) => {
    world.github.addLabel('agent-queue', 'ffffff', 'метка владельца')
    world.github.addLabel('Agent-Queue:Blocked', '000000', '')
    const own = '# shop-demo для агентов\n\nСобирать командой make, тесты — make test.\n'
    await world.repo.commit({ 'CLAUDE.md': own }, 'agents notes')
    await world.repo.push()
    const source = (await repoState(world)).head
    const panel = await openForm(world)
    await panel.press({ type: 'Button', text: 'Подключить' })
    assert.deepEqual(headings(panel), ['Проверка проекта'])
    await assertConnected(world, source)
    const created = writes(world).map((call) => (call.input as { name: string }).name)
    assert.deepEqual(created.sort(), ['agent-queue:autopilot', 'agent-queue:mvp', 'agent-queue:paused', 'agent-queue:split', 'agent-queue:working'])
    assert.deepEqual(world.github.labels.slice(0, 2), [
      { name: 'agent-queue', color: 'ffffff', description: 'метка владельца' },
      { name: 'Agent-Queue:Blocked', color: '000000', description: '' },
    ])
    const claude = await fileOnOrigin(world, 'CLAUDE.md')
    assert.ok(claude.startsWith(own), 'чужой текст CLAUDE.md изменён')
    assert.equal(claude, `${own}\n${entryRuleBlock('ru', GITHUB_REPOSITORY)}\n`)
    assert.equal(claude.split('\n').filter((line) => line.startsWith(ENTRY_RULE_BEGIN)).length, 1)
    assert.equal(await fileOnOrigin(world, 'AGENTS.md'), `${entryRuleBlock('ru', GITHUB_REPOSITORY)}\n`, 'AGENTS.md не создан с блоком')
  })
})

test('К1.7: пуш отклонён → основной чекаут на исходном SHA без нового коммита и без новых файлов, проект не подключён; повторное «Подключить» после устранения причины подключает его', async () => {
  await withConnectWorld(async (world) => {
    await world.repo.commit({ 'CLAUDE.md': '# Заметки\n' }, 'notes')
    await world.repo.push()
    const before = await repoState(world)
    world.rejectPushes()
    const panel = await openForm(world)
    await panel.press({ type: 'Button', text: 'Подключить' })
    assert.ok(
      shown(panel).includes('Пуш отклонён: remote rejected (pre-receive hook declined). Коммит отменён, проект не подключён.'),
      shown(panel),
    )
    assert.ok(panel.find({ type: 'Button', text: 'Повторить' }))
    assert.deepEqual(await repoState(world), before, 'чекаут не вернулся на исходный SHA или остались файлы')
    assert.equal(readFileSync(join(world.repo.checkout, 'CLAUDE.md'), 'utf8'), '# Заметки\n')
    assert.deepEqual(await world.worker.request('projects.list'), { projects: [] })
    assert.equal(world.github.labels.length, 7)

    world.acceptPushes()
    await panel.press({ type: 'Button', text: 'Повторить' })
    assert.deepEqual(headings(panel), ['Проверка проекта'])
    await assertConnected(world, before.head)
    assert.deepEqual(await world.worker.request('projects.list'), { projects: [SHOP] })
    // The repeat created no label: all seven were there.
    assert.equal(writes(world).length, 7)
    assert.equal(operations(world).length, 2, 'повтор — не новая операция')
  })
})

test('К1.8: в проекте есть .agent-queue/config.json → проект помечен «На agent-queue-kit — переход после MVP», его нельзя выбрать; его файлы и метки не меняются', async () => {
  await withConnectWorld(async (world) => {
    const kit = '<!-- agent-queue:begin (agent-queue rules writes this block) -->\nправило кита\n<!-- agent-queue:end -->\n'
    await world.repo.commit({ '.agent-queue/config.json': '{ "repo": "demo-org/shop-demo" }\n', 'CLAUDE.md': kit }, 'on the kit')
    await world.repo.push()
    world.github.addLabel('agent', '0e8a16', 'kit queue')
    const before = await repoState(world)
    const panel = await openWizard(world)
    assert.ok(shown(panel).includes('На agent-queue-kit — переход после MVP'), shown(panel))
    assert.equal(panel.find({ testId: CHOOSE })?.disabled, true, 'проект на ките можно выбрать')
    assertClean(panel, [world.repo.checkout])
    const result = await connect(world)
    assert.deepEqual(result, { status: 'refused', refusal: { reason: 'kit' } })
    assert.deepEqual(await repoState(world), before)
    assert.equal(readFileSync(join(world.repo.checkout, 'CLAUDE.md'), 'utf8'), kit)
    assert.deepEqual(world.github.labels, [{ name: 'agent', color: '0e8a16', description: 'kit queue' }])
    assert.deepEqual(world.github.calls, [])
    assert.deepEqual(operations(world), [])
  })
})

test('К3.5: блок правила входа, который пишет плагин, называет репозиторий проекта, метку agent-queue, строку «Зависит от #N» и говорит, что правило только для сессий в основном чекауте', async () => {
  await withConnectWorld(async (world) => {
    for (const [language, depends, only] of [
      ['ru', '«Зависит от #N»', /только для входных сессий: агентов в основном чекауте этого проекта/],
      ['en', '«Depends on #N»', /only for entry sessions: agents in the main checkout of this project/],
    ] as const) {
      const block = entryRuleBlock(language, GITHUB_REPOSITORY)
      assert.ok(block.includes('`demo-org/shop-demo`'), `${language}: нет репозитория`)
      assert.ok(block.includes(`gh issue create --repo ${GITHUB_REPOSITORY} --label agent-queue`), `${language}: нет команды постановки`)
      assert.ok(block.includes('`agent-queue`'), `${language}: нет метки`)
      assert.ok(block.includes(depends), `${language}: нет строки зависимости`)
      assert.match(block, only)
    }
    // The block the plugin writes is that one, in the project's language chosen in the form.
    const source = (await repoState(world)).head
    const panel = await openForm(world)
    await panel.select({ role: 'combobox', label: 'Язык текстов в GitHub' }, 'en')
    await panel.press({ type: 'Button', text: 'Подключить' })
    assert.deepEqual(headings(panel), ['Проверка проекта'])
    await assertConnected(world, source)
    for (const file of ['CLAUDE.md', 'AGENTS.md']) {
      const written = entryRuleIn(await fileOnOrigin(world, file))
      assert.equal(written, entryRuleBlock('en', GITHUB_REPOSITORY), file)
      assert.ok(written?.includes('«Depends on #N»'))
      assert.ok(written?.includes(`--repo ${GITHUB_REPOSITORY} --label agent-queue`))
    }
  })
})

// ── The journal ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('Подключение: журнал операций — намерение (id операции, исходный SHA, четыре пути и хэш ожидаемого содержимого каждого) записано до меток, время — по часам воркера; id операции — в сообщении коммита', async () => {
  await withConnectWorld(async (world) => {
    const source = (await repoState(world)).head
    let intentBeforeLabels: boolean | null = null
    world.github.before(
      (call) => call.method === 'POST' && call.path.endsWith('/labels'),
      () => {
        intentBeforeLabels = operations(world).some((dir) => existsSync(join(dir, 'intent.json')))
      },
    )
    const result = await connect(world)
    assert.equal(result.status, 'connected', JSON.stringify(result))
    if (result.status !== 'connected') return
    assert.equal(intentBeforeLabels, true, 'намерение не записано до меток')
    const [dir] = operations(world)
    assert.ok(dir !== undefined)
    assert.ok(dir.endsWith(result.operation), dir)
    const intent = journal(dir, 'intent')
    assert.equal(intent.kind, 'connect')
    assert.equal(intent.operation, result.operation)
    assert.equal(intent.sourceCommit, source)
    assert.equal(intent.baseBranch, 'main')
    assert.equal(intent.at, new Date(world.clock.now()).toISOString(), 'время журнала — не по часам воркера')
    const paths = intent.paths as { path: string; sourceBlob: string | null; expectedBlob: string }[]
    assert.deepEqual(paths.map((one) => one.path), ['.agent-queue.json', '.agent-queue.md', 'CLAUDE.md', 'AGENTS.md'])
    for (const one of paths) {
      const committed = (await world.repo.git(['rev-parse', `${result.commit}:${one.path}`])).trim()
      assert.equal(one.expectedBlob, committed, `хэш ожидаемого содержимого ${one.path}`)
      assert.equal(one.sourceBlob, null, `${one.path} не было в исходном коммите`)
    }
    for (const step of ['labels', 'files', 'commit', 'push']) assert.ok(existsSync(join(dir, `${step}.json`)), step)
    const raw = await world.repo.git(['cat-file', 'commit', result.commit])
    assert.equal(raw.slice(raw.indexOf('\n\n') + 2), `Agent Queue: подключение проекта к очереди\n\nAgent-Queue-Operation: ${result.operation}\n`)
  })
})

// ── Files of the working tree (review 1: findings 1, 2, 7, 15) ────────────────────────────────────────────────────────

test('Подключение: игнорируемый локальный AGENTS.md, которого нет в коммите, → отказ до журнала, байты файла на месте; игнорируемый путь без файла → отказ «git игнорирует этот путь»', async () => {
  await withConnectWorld(async (world) => {
    await world.repo.commit({ '.gitignore': 'AGENTS.md\n' }, 'ignore agents')
    await world.repo.push()
    const own = 'мои заметки для агентов\r\n'
    world.repo.write('AGENTS.md', own)
    const before = await repoState(world)
    const result = await connect(world)
    assert.deepEqual(result, {
      status: 'refused',
      refusal: { reason: 'file', file: 'AGENTS.md', problem: 'present', detail: 'in the working tree, not in the commit' },
    })
    assert.equal(readFileSync(join(world.repo.checkout, 'AGENTS.md'), 'utf8'), own, 'локальный AGENTS.md изменён')
    await assertNothingWritten(world, before, 'игнорируемый AGENTS.md')
    const panel = await openForm(world)
    await panel.press({ type: 'Button', text: 'Подключить' })
    assert.match(shown(panel), /AGENTS\.md: в рабочем дереве есть файл, которого нет в коммите/)
    assert.equal(readFileSync(join(world.repo.checkout, 'AGENTS.md'), 'utf8'), own, 'локальный AGENTS.md изменён')

    rmSync(join(world.repo.checkout, 'AGENTS.md'))
    const absent = await repoState(world)
    assert.deepEqual(await connect(world), {
      status: 'refused',
      refusal: { reason: 'file', file: 'AGENTS.md', problem: 'ignored', detail: 'git ignores it' },
    })
    await assertNothingWritten(world, absent, 'игнорируемый путь')
  })
})

test('Подключение: основной чекаут изменили, пока GitHub создавал метки → сбой «чекаут изменился», файлы не записаны, правка пользователя на месте, коммита нет', async () => {
  await withConnectWorld(async (world) => {
    await world.repo.commit({ 'CLAUDE.md': '# Заметки\n' }, 'notes')
    await world.repo.push()
    const source = (await repoState(world)).head
    world.github.before(
      (call) => call.method === 'POST' && call.path.endsWith('/labels'),
      () => writeFileSync(join(world.repo.checkout, 'CLAUDE.md'), '# Заметки\nправка пользователя\n'),
    )
    const panel = await openForm(world)
    await panel.press({ type: 'Button', text: 'Подключить' })
    assert.ok(
      shown(panel).includes('Основной чекаут изменился во время подключения: изменённых путей — 1. Файлы не записаны.'),
      shown(panel),
    )
    assert.ok(panel.find({ type: 'Button', text: 'Повторить' }))
    assert.equal(readFileSync(join(world.repo.checkout, 'CLAUDE.md'), 'utf8'), '# Заметки\nправка пользователя\n')
    const after = await repoState(world)
    assert.equal(after.head, source, 'коммит сделан')
    assert.equal(after.origin, source, 'пуш сделан')
    assert.equal(after.status, ' M CLAUDE.md\n')
    const [dir] = operations(world)
    assert.ok(dir !== undefined)
    assert.equal((journal(dir, 'failed').failure as { step: string }).step, 'changed')
  })
})

test('Подключение: файл появился в рабочем дереве прямо перед записью → записанные плагином пути возвращены, файл пользователя на месте, коммита нет', async () => {
  await withConnectWorld(async (world) => {
    const before = await repoState(world)
    world.beforeWrite = (path) => {
      if (path.endsWith('AGENTS.md')) writeFileSync(join(world.repo.checkout, 'AGENTS.md'), 'файл пользователя\n')
    }
    const result = await connect(world)
    world.beforeWrite = null
    assert.ok(result.status === 'failed' && result.failure.step === 'files', JSON.stringify(result))
    assert.deepEqual(result.status === 'failed' && result.failure.step === 'files' ? result.failure.left : null, [])
    assert.equal(readFileSync(join(world.repo.checkout, 'AGENTS.md'), 'utf8'), 'файл пользователя\n')
    const after = await repoState(world)
    assert.equal(after.head, before.head)
    assert.equal(after.origin, before.origin)
    assert.equal(after.status, '?? AGENTS.md\n', 'остались файлы плагина')
    assert.deepEqual(after.files, [...before.files, 'AGENTS.md'].sort())
  })
})

test('Подключение: пользователь сделал свой коммит, пока шёл отклонённый пуш → коммит подключения не отменяется поверх его работы; сбой называет причину', async () => {
  await withConnectWorld(async (world) => {
    const source = (await repoState(world)).head
    const hook = join(world.repo.origin, 'hooks', 'pre-receive')
    const checkout = world.repo.checkout.replace(/\\/g, '/')
    writeFileSync(
      hook,
      '#!/bin/sh\nunset GIT_DIR GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES\n' +
        `git -C "${checkout}" commit --quiet --allow-empty -m "user work" >&2\nexit 1\n`,
    )
    chmodSync(hook, 0o755)
    const result = await connect(world)
    assert.ok(
      result.status === 'failed' && result.failure.step === 'undo' && (result.failure.push ?? '').includes('pre-receive hook declined'),
      JSON.stringify(result),
    )
    assert.equal((await world.repo.git(['log', '-1', '--format=%s'])).trim(), 'user work', 'коммит пользователя потерян')
    assert.equal((await world.repo.git(['rev-parse', 'main'], world.repo.origin)).trim(), source, 'что-то запушено')
  })
})

test('Подключение: git add изменил бы новое содержимое (атрибуты и фильтры) → отказ до журнала «Ничего не записано»', async () => {
  await withConnectWorld(async (world) => {
    await world.repo.commit({ '.gitattributes': '.agent-queue.json filter=upper\n' }, 'filters')
    await world.repo.push()
    await world.repo.git(['config', 'filter.upper.clean', 'tr a-z A-Z'])
    await world.repo.git(['config', 'filter.upper.smudge', 'cat'])
    const before = await repoState(world)
    assert.deepEqual(await connect(world), {
      status: 'refused',
      refusal: { reason: 'file', file: '.agent-queue.json', problem: 'transformed', detail: 'git add would change it (.gitattributes)' },
    })
    await assertNothingWritten(world, before, 'фильтр')
  })
})

test('Подключение: CLAUDE.md с BOM и смешанными LF и CRLF → байты вне блока сохранены, у блока окончания последней строки файла', async () => {
  await withConnectWorld(async (world) => {
    const own = '﻿# Заметки\r\nстрока с LF\nстрока с CRLF\r\n'
    writeFileSync(join(world.repo.checkout, 'CLAUDE.md'), own)
    await world.repo.git(['add', 'CLAUDE.md'])
    await world.repo.git(['commit', '--quiet', '-m', 'notes'])
    await world.repo.push()
    const source = (await repoState(world)).head
    const result = await connect(world)
    assert.equal(result.status, 'connected', JSON.stringify(result))
    await assertConnected(world, source)
    const expected = `${own}\r\n${entryRuleBlock('ru', GITHUB_REPOSITORY).split('\n').join('\r\n')}\r\n`
    assert.equal(readFileSync(join(world.repo.checkout, 'CLAUDE.md'), 'utf8'), expected)
    assert.equal(
      (await world.repo.git(['hash-object', '--no-filters', 'CLAUDE.md'])).trim(),
      (await world.repo.git(['rev-parse', 'main:CLAUDE.md'], world.repo.origin)).trim(),
      'в коммите не те байты',
    )
  })
})

// ── The data the mask hides, the repository pushed to, the base branch fetched (findings 3, 4, 5, 14) ──────────────

test('Подключение: в команде тестов токен известного вида → ошибка у поля без текста совпадения, ничего не записано', async () => {
  await withConnectWorld(async (world) => {
    const before = await repoState(world)
    const result = await connect(world, { testCommand: `make test TOKEN=${TOKEN}` })
    assert.deepEqual(result, { status: 'fields', errors: [{ field: 'testCommand', code: 'masked', detail: 'token:github' }], agents: null })
    assert.ok(!JSON.stringify(result).includes(TOKEN.slice(4)), 'совпадение в ответе')
    const panel = await openWizard(world)
    await chooseShop(panel)
    await panel.type({ label: 'Команда полных тестов' }, `make test TOKEN=${TOKEN}`)
    await panel.press({ type: 'Button', text: 'Подключить' })
    assert.equal(fieldError(panel, 'Команда полных тестов'), 'Здесь данные, которые не попадают в GitHub (token:github)')
    await assertNothingWritten(world, before, 'токен')
  })
})

test('Подключение: пуш origin уходит в другой репозиторий (remote.origin.pushurl или url.*.pushInsteadOf, два bare-репозитория) → отказ до журнала, ни в один репозиторий ничего не запушено', async () => {
  await withConnectWorld(async (world) => {
    const second = mkdtempSync(join(tmpdir(), 'agent-queue-second-'))
    try {
      const bare = join(second, 'other.git')
      await world.repo.git(['init', '--quiet', '--bare', '--initial-branch=main', bare], second)
      const otherUrl = 'https://github.com/demo-org/other-shop.git'
      const setups = [
        async () => {
          await world.repo.git(['config', 'remote.origin.pushurl', otherUrl])
          await world.repo.git(['config', `url.${bare}.insteadOf`, otherUrl])
        },
        async () => {
          await world.repo.git(['config', '--unset', 'remote.origin.pushurl'])
          await world.repo.git(['config', `url.${bare}.pushInsteadOf`, 'https://github.com/demo-org/shop-demo.git'])
        },
      ]
      for (const setup of setups) {
        await setup()
        const before = await repoState(world)
        assert.deepEqual(await connect(world), {
          status: 'refused',
          refusal: { reason: 'git', check: { status: 'problem', problem: 'push-elsewhere' } },
        })
        await assertNothingWritten(world, before, 'другой репозиторий')
        assert.equal((await world.repo.git(['for-each-ref'], bare)).trim(), '', 'запушено в другой репозиторий')
        assert.deepEqual(await world.worker.request('connect.checkGit', { projectId: SHOP.id, hostId: SHOP.hostId }), {
          status: 'problem',
          problem: 'push-elsewhere',
        })
      }
    } finally {
      rmSync(second, { recursive: true, force: true })
    }
  })
})

test('Подключение: выбранную ветку удалили в origin после открытия формы → ошибка у базовой ветки, ничего не записано, ветка не создана заново; при ограниченном refspec fetch HEAD сверяется с веткой, полученной явно', async () => {
  await withConnectWorld(async (world) => {
    await world.repo.git(['branch', 'develop'])
    await world.repo.push('develop')
    await world.repo.git(['checkout', '--quiet', 'develop'])
    await world.repo.git(['push', '--quiet', 'origin', ':develop'])
    const before = await repoState(world)
    assert.deepEqual(await connect(world, { baseBranch: 'develop' }), {
      status: 'fields',
      errors: [{ field: 'baseBranch', code: 'no-branch', detail: 'develop' }],
      agents: null,
    })
    await assertNothingWritten(world, before, 'удалённая ветка')
    assert.equal((await world.repo.git(['branch', '--list', 'develop'], world.repo.origin)).trim(), '', 'ветка создана заново')

    await world.repo.git(['checkout', '--quiet', 'main'])
    await world.repo.git(['config', 'remote.origin.fetch', '+refs/heads/docs:refs/remotes/origin/docs'])
    const other = await world.repo.clone('elsewhere')
    await world.repo.git(['commit', '--quiet', '--allow-empty', '-m', 'elsewhere'], other)
    await world.repo.git(['push', '--quiet', 'origin', 'HEAD:main'], other)
    assert.deepEqual(await connect(world), { status: 'refused', refusal: { reason: 'behind', commits: 1, base: 'main' } })
    assert.deepEqual(writes(world), [])
  })
})

test('Подключение: ветка по умолчанию в GitHub сменилась, а клон помнит прежний origin/HEAD → форма предлагает ветку GitHub', async () => {
  await withConnectWorld(async (world) => {
    await world.repo.git(['branch', 'develop'])
    await world.repo.push('develop')
    world.github.defaultBranch = 'develop'
    assert.equal((await world.repo.git(['symbolic-ref', 'refs/remotes/origin/HEAD'])).trim(), 'refs/remotes/origin/main')
    const panel = await openWizard(world)
    await chooseShop(panel)
    assert.equal(panel.valueOf({ role: 'combobox', label: 'Базовая ветка' }), 'develop')
    assert.deepEqual(panel.find({ role: 'combobox', label: 'Базовая ветка' })?.props.options, [
      { value: 'develop', label: 'develop' },
      { value: 'main', label: 'main' },
    ])
  })
})

// ── Hooks (decision «🤖 Решение по #11: вопрос», the second) ──────────────────────────────────────────────────────────

for (const where of ['.git/hooks', 'core.hooksPath'] as const) {
  test(`Подключение, хуки git (${where}): ни один хук проекта не запускается — коммит ровно из четырёх файлов с хэшами журнала, сообщение — заголовок и строка операции`, async () => {
    await withConnectWorld(async (world) => {
      const source = (await repoState(world)).head
      const marks = join(world.repo.root, 'hook-marks.txt')
      const dir = where === '.git/hooks' ? join(world.repo.checkout, '.git', 'hooks') : join(world.repo.root, 'project-hooks')
      writeMarkingHooks(dir, marks)
      if (where === 'core.hooksPath') await world.repo.git(['config', 'core.hooksPath', dir])
      // The control: the test's own commit in this checkout is refused by the hooks.
      await assert.rejects(() => world.repo.git(['commit', '--allow-empty', '-m', 'control']))
      assert.ok(existsSync(marks), 'хуки не работают в контроле')
      rmSync(marks)

      const panel = await openForm(world)
      await panel.press({ type: 'Button', text: 'Подключить' })
      assert.equal(existsSync(marks), false, `сработали хуки: ${existsSync(marks) ? readFileSync(marks, 'utf8') : ''}`)
      assert.deepEqual(headings(panel), ['Проверка проекта'])
      const commit = (await world.repo.git(['rev-parse', 'main'], world.repo.origin)).trim()
      assert.equal((await world.repo.git(['rev-parse', `${commit}^`], world.repo.origin)).trim(), source)
      assert.deepEqual(await changedIn(world, commit), FOUR)
      const [op] = operations(world)
      assert.ok(op !== undefined)
      const intent = journal(op, 'intent')
      for (const one of intent.paths as { path: string; expectedBlob: string }[]) {
        assert.equal((await world.repo.git(['rev-parse', `${commit}:${one.path}`], world.repo.origin)).trim(), one.expectedBlob, one.path)
      }
      const raw = await world.repo.git(['cat-file', 'commit', commit], world.repo.origin)
      assert.equal(raw.slice(raw.indexOf('\n\n') + 2), `Agent Queue: подключение проекта к очереди\n\nAgent-Queue-Operation: ${String(intent.operation)}\n`)
      assert.equal(MARKED_HOOKS.length, 8)
    })
  })
}

test('Подключение, хуки git: пуш отклонён origin при хуках проекта → исход К1.7, ни один хук проекта не сработал', async () => {
  await withConnectWorld(async (world) => {
    const before = await repoState(world)
    const marks = join(world.repo.root, 'hook-marks.txt')
    writeMarkingHooks(join(world.repo.checkout, '.git', 'hooks'), marks)
    world.rejectPushes()
    const panel = await openForm(world)
    await panel.press({ type: 'Button', text: 'Подключить' })
    assert.equal(existsSync(marks), false, 'сработали хуки')
    assert.ok(shown(panel).includes('Пуш отклонён: remote rejected (pre-receive hook declined). Коммит отменён, проект не подключён.'))
    assert.deepEqual(await repoState(world), before)
  })
})

// ── Two forms, a long connection, a lost answer of the push, leaving the screen (findings 8, 9, 10, 17) ──────────────

test('Подключение: форма открыта заранее, проект тем временем подключили → «Подключить» отказывает «Проект уже подключён», настройки не заменены', async () => {
  await withConnectWorld(async (world) => {
    const panel = await openForm(world)
    const first = await connect(world)
    assert.equal(first.status, 'connected')
    const after = await repoState(world)
    await panel.type({ label: 'Команда полных тестов' }, 'npm test', { replace: true })
    await panel.press({ type: 'Button', text: 'Подключить' })
    assert.ok(shown(panel).includes('Проект уже подключён. Ничего не записано.'), shown(panel))
    assert.deepEqual(await connect(world, { testCommand: 'npm test' }), { status: 'refused', refusal: { reason: 'connected' } })
    assert.deepEqual(await repoState(world), after)
    assert.match(await fileOnOrigin(world, '.agent-queue.json'), /"testCommand": "make test"/)
    assert.equal(operations(world).length, 1)
  })
})

test('Подключение: подключение дольше окна ответа воркера → экран «Подключаю…», без сбоя и «Повторить», пока воркер не ответит; потом «Проверка проекта»', async () => {
  await withConnectWorld(
    async (world) => {
      const timer = world.timer
      assert.ok(timer !== null)
      const release = world.holdGh((call) => call.method === 'POST' && call.path.endsWith('/labels'))
      const panel = await openForm(world)
      const pressing = panel.press({ type: 'Button', text: 'Подключить' })
      for (let window = 0; window < 3; window++) {
        await until(() => timer.pending() > 0, 'воркер не ждёт окна ответа')
        timer.fire()
        await until(() => timer.pending() > 0, 'панель не спросила снова')
        assert.ok(shown(panel).includes('Подключаю… метки GitHub, файлы настроек, коммит, пуш'), shown(panel))
        assert.equal(panel.find({ type: 'Button', text: 'Повторить' }), null, 'сбой при долгом подключении')
      }
      const asked = (panel.host.callsOf('plugin.request') as { name: string }[]).filter((call) => call.name === 'connect.wait').length
      assert.ok(asked >= 3, `connect.wait: ${asked}`)
      release()
      await pressing
      assert.deepEqual(headings(panel), ['Проверка проекта'])
    },
    { manualTimer: true },
  )
})

test(
  'Подключение: связь оборвалась после обновления ветки в origin, исход пуша не подтверждён → коммит не отменяется, «исход пуша неизвестен»',
  async () => {
    // The hook that kills receive-pack after the ref is updated works in POSIX shells only.
    if (platform === 'win32') return
    await withConnectWorld(async (world) => {
      const hook = join(world.repo.origin, 'hooks', 'reference-transaction')
      writeFileSync(hook, '#!/bin/sh\nif [ "$1" = committed ]; then kill -9 $PPID; fi\nexit 0\n')
      chmodSync(hook, 0o755)
      const result = await connect(world)
      assert.ok(result.status === 'failed' && result.failure.step === 'push-unknown', JSON.stringify(result))
      const head = (await world.repo.git(['rev-parse', 'HEAD'])).trim()
      assert.equal((await world.repo.git(['rev-parse', 'main'], world.repo.origin)).trim(), head, 'коммит не на origin или отменён')
      assert.equal((await world.repo.git(['log', '-1', '--format=%s'])).trim(), 'Agent Queue: подключение проекта к очереди')
      const [op] = operations(world)
      assert.ok(op !== undefined)
      assert.equal(journal(op, 'push').outcome, 'unknown')
      assert.equal(existsSync(join(op, 'undo.json')), false, 'коммит отменяли')
    })
  },
)

test('Подключение: владелец ушёл с экрана, пока шло подключение → поздний ответ не уводит его с «Настроек»', async () => {
  await withConnectWorld(async (world) => {
    const release = world.holdGh((call) => call.method === 'POST' && call.path.endsWith('/labels'))
    const panel = await openForm(world)
    const pressing = panel.press({ type: 'Button', text: 'Подключить' })
    await drawnUntil(panel, () => shown(panel).includes('Подключаю… метки GitHub, файлы настроек, коммит, пуш'))
    backToQueue()
    openScreen('settings')
    release()
    await pressing
    await panel.settled()
    assert.deepEqual(headings(panel), ['Настройки'])
    assert.deepEqual(await world.worker.request('projects.list'), { projects: [SHOP] })
  })
})

// ── Projects of other hosts (decision «🤖 Решение по #11: вопрос», the second) ───────────────────────────────────────

test('Подключение, другой хост: копия проекта на ssh:build-box в списке недоступна с причиной, процессов в её каталоге нет; локальный проект подключается; projects.list — только проект этого компьютера', async () => {
  await withConnectWorld(
    async (world) => {
      const other = world.other
      assert.ok(other !== null)
      const otherHead = (await other.git(['rev-parse', 'HEAD'])).trim()
      const otherFiles = readdirSync(other.checkout).sort()
      const panel = await openWizard(world)
      const rows = panel.findAll({ type: 'Button', text: 'Выбрать' })
      assert.deepEqual(
        rows.map((row) => [row.key, row.disabled]),
        [
          [`choose:${OTHER_HOST}:${SHOP.id}`, true],
          [CHOOSE, false],
        ],
      )
      assert.ok(shown(panel).includes(`На другом хосте (${OTHER_HOST}) — подключаются только проекты этого компьютера`), shown(panel))
      assert.ok(!shown(panel).includes(other.checkout), 'путь проекта другого хоста показан')
      assertClean(panel, [world.repo.checkout, OTHER_HOST])
      await chooseShop(panel)
      await panel.type({ label: 'Команда полных тестов' }, 'make test')
      await panel.press({ type: 'Button', text: 'Подключить' })
      assert.deepEqual(headings(panel), ['Проверка проекта'])
      assert.deepEqual(await world.worker.request('projects.list'), { projects: [SHOP] })
      const inOther = world.starts.filter(
        (start) => (start.cwd ?? '').startsWith(other.checkout) || start.args.some((arg) => arg.includes(other.checkout)),
      )
      assert.deepEqual(inOther, [], 'процесс в каталоге проекта другого хоста')
      assert.equal((await other.git(['rev-parse', 'HEAD'])).trim(), otherHead)
      assert.deepEqual(readdirSync(other.checkout).sort(), otherFiles)
    },
    { otherHost: OTHER_HOST },
  )
})

test('Подключение, другой хост: проверки и «Подключить» для проекта ssh:… и runtime:… → invalid_params, ни одного процесса', async () => {
  await withConnectWorld(
    async (world) => {
      const started = world.starts.length
      for (const hostId of [OTHER_HOST, 'runtime:5f0c']) {
        const target = { projectId: SHOP.id, hostId }
        const asks = [
          () => world.worker.request('connect.checkGit', target),
          () => world.worker.request('connect.checkGh', target),
          () => world.worker.request('connect.checkAgents', target),
          () => world.worker.request('connect.connect', { ...target, form: form() }),
          () => world.worker.request('connect.wait', target),
        ]
        for (const ask of asks) await assert.rejects(ask, (error: unknown) => (error as { code?: string }).code === 'invalid_params')
      }
      assert.equal(world.starts.length, started, 'запущены процессы')
    },
    { otherHost: OTHER_HOST, local: false },
  )
})

test('Подключение, другой хост: в Orca только проект другого хоста → строка с причиной, а не «нет проектов»', async () => {
  await withConnectWorld(
    async (world) => {
      const panel = await openWizard(world)
      assert.ok(shown(panel).includes(`На другом хосте (${OTHER_HOST}) — подключаются только проекты этого компьютера`), shown(panel))
      assert.ok(!shown(panel).includes('Неподключённых проектов Orca на этом компьютере нет'))
      assert.equal(panel.find({ type: 'Button', text: 'Выбрать' })?.disabled, true)
    },
    { otherHost: OTHER_HOST, local: false },
  )
})

// ── The agents of the form (decision «🤖 Решение по #11: вопрос») ─────────────────────────────────────────────────────

test('Подключение, агенты: источник — ответ CLI Orca agent installed; у каждой роли — агенты списка в его порядке с именами Orca, выбраны claude, codex, claude, claude; ревьюер «Future Agent» попадает в .agent-queue.json', async () => {
  await withConnectWorld(async (world) => {
    world.orca.installedAgents = [
      { id: 'claude', name: 'Claude', default: true },
      { id: 'future-agent', name: 'Future Agent' },
      { id: 'codex', name: 'Codex' },
    ]
    const panel = await openWizard(world)
    await chooseShop(panel)
    assert.ok(shown(panel).includes('агенты: claude, codex'))
    const expected = [
      { value: 'claude', label: 'Claude' },
      { value: 'future-agent', label: 'Future Agent' },
      { value: 'codex', label: 'Codex' },
    ]
    const roles = { Исполнитель: 'claude', Ревьюер: 'codex', Решатель: 'claude', 'Агент старта': 'claude' }
    for (const [label, chosen] of Object.entries(roles)) {
      assert.deepEqual(panel.find({ role: 'combobox', label })?.props.options, expected, label)
      assert.equal(panel.valueOf({ role: 'combobox', label }), chosen, label)
    }
    await panel.select({ role: 'combobox', label: 'Ревьюер' }, 'future-agent')
    await panel.type({ label: 'Команда полных тестов' }, 'make test')
    await panel.press({ type: 'Button', text: 'Подключить' })
    assert.deepEqual(headings(panel), ['Проверка проекта'])
    const settings = JSON.parse(await fileOnOrigin(world, '.agent-queue.json')) as { agents: Record<string, string> }
    assert.deepEqual(settings.agents, { implementer: 'claude', reviewer: 'future-agent', solver: 'claude', start: 'claude' })
    const asked = world.orca.machine.starts.filter((start) => start.args[0] === 'agent')
    assert.ok(asked.length >= 2, 'список агентов не прочитан заново при «Подключить»')
    for (const start of asked) {
      assert.deepEqual(start.args, ['agent', 'installed', '--json'])
      assert.equal(start.file, world.orca.cli)
    }
  })
})

test('Подключение, агенты: в списке Orca нет codex → строка «проблема» с codex, форма открыта, у ревьюера ничего не выбрано; «Подключить» → ошибка у поля ревьюера, ничего не записано; выбран агент из списка → проект подключён', async () => {
  await withConnectWorld(async (world) => {
    world.orca.installedAgents = [{ id: 'claude', name: 'Claude' }, { id: 'copilot', name: 'Copilot' }]
    const before = await repoState(world)
    const panel = await openWizard(world)
    await chooseShop(panel)
    assert.ok(shown(panel).includes('агенты: Orca не знает codex на этом компьютере'), shown(panel))
    assert.ok(!panel.valueOf({ role: 'combobox', label: 'Ревьюер' }), 'ревьюер выбран')
    assert.equal(panel.find({ role: 'combobox', label: 'Ревьюер' })?.props.placeholder, 'выберите агента')
    for (const label of ['Исполнитель', 'Решатель', 'Агент старта']) assert.equal(panel.valueOf({ role: 'combobox', label }), 'claude')
    await panel.type({ label: 'Команда полных тестов' }, 'make test')
    await panel.press({ type: 'Button', text: 'Подключить' })
    assert.equal(fieldError(panel, 'Ревьюер'), 'Выберите агента из тех, кого знает Orca')
    await assertNothingWritten(world, before, 'ревьюер не выбран')
    await panel.select({ role: 'combobox', label: 'Ревьюер' }, 'copilot')
    await panel.press({ type: 'Button', text: 'Подключить' })
    assert.deepEqual(headings(panel), ['Проверка проекта'])
    const settings = JSON.parse(await fileOnOrigin(world, '.agent-queue.json')) as { agents: Record<string, string> }
    assert.equal(settings.agents.reviewer, 'copilot')
  })
})

test('Подключение, агенты: CLI Orca на компьютере нет → «не проверено» с причиной поиска, формы нет, «Подключить» недоступна, файлы и GitHub не менялись; CLI появился — «Проверить снова» открывает форму', async () => {
  await withConnectWorld(async (world) => {
    world.orca.cliPresent = false
    const before = await repoState(world)
    const panel = await openWizard(world)
    await chooseShop(panel)
    assert.match(shown(panel), /агенты: не проверено: CLI Orca не найден: .*orca/)
    assert.equal(panel.find({ label: 'Команда полных тестов' }), null)
    assert.equal(connectButton(panel), null)
    const result = await connect(world)
    assert.ok(
      result.status === 'refused' && result.refusal.reason === 'agents' && result.refusal.failure.kind === 'cli-not-found',
      JSON.stringify(result),
    )
    await assertNothingWritten(world, before, 'без CLI')
    world.orca.cliPresent = true
    await panel.press({ type: 'Button', text: 'Проверить снова' })
    assert.ok(connectButton(panel), 'форма не открылась')
    assert.ok(shown(panel).includes('агенты: claude, codex'))
  })
})

test('Подключение, агенты: CLI не дал списка (отказ Orca, не JSON, нет ответа в срок) или список пуст → строка агентов на языке панели блокирует, формы нет; CLI назван своим файлом', async () => {
  await withConnectWorld(async (world) => {
    const cli = world.orca.cli
    const cases: [string, () => void, string][] = [
      [
        'отказ Orca',
        () => (world.orca.installedRefusal = { code: 'runtime_unavailable', message: 'Orca is not running' }),
        'агенты: не проверено: Orca отказала: runtime_unavailable: Orca is not running (exit 1)',
      ],
      ['не JSON', () => (world.orca.installedAnswer = { code: 0, stdout: 'claude codex\n' }), `агенты: не проверено: CLI Orca ${cli} ответил не JSON (exit 0: claude codex)`],
      ['нет ответа в срок', () => (world.orca.installedAnswer = { timedOut: true, signal: 'SIGKILL' }), `агенты: не проверено: CLI Orca ${cli} не ответил за 30 с`],
      [
        'пустой список',
        () => (world.orca.installedAgents = []),
        'агенты: Orca не нашла на этом компьютере ни одного агента — установите агента или включите его в Settings → Agents',
      ],
    ]
    const before = await repoState(world)
    for (const [what, steer, line] of cases) {
      world.orca.installedRefusal = null
      world.orca.installedAnswer = null
      world.orca.installedAgents = [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' }]
      steer()
      const panel = await openWizard(world)
      await chooseShop(panel)
      assert.ok(shown(panel).includes(line), `${what}: ${shown(panel)}`)
      assert.equal(panel.find({ label: 'Команда полных тестов' }), null, `${what}: форма открыта`)
      assert.equal(connectButton(panel), null, what)
      assert.ok(panel.find({ type: 'Button', text: 'Проверить снова' }), what)
      assert.ok(!/(^|\s)orca agent installed/.test(shown(panel)), `${what}: голый orca`)
    }
    await assertNothingWritten(world, before, 'список агентов не прочитан')
  })
})

test('Подключение, агенты: после открытия формы агент роли пропал из списка → «Подключить» даёт ошибку у поля этой роли, в выборе — агенты нового списка; список в момент «Подключить» не читается → отказ с причиной; ничего не записано', async () => {
  await withConnectWorld(async (world) => {
    const before = await repoState(world)
    const panel = await openForm(world)
    world.orca.installedAgents = [{ id: 'claude', name: 'Claude' }]
    await panel.press({ type: 'Button', text: 'Подключить' })
    assert.equal(fieldError(panel, 'Ревьюер'), 'Выберите агента из тех, кого знает Orca')
    assert.equal(fieldError(panel, 'Исполнитель'), undefined)
    assert.deepEqual(panel.find({ role: 'combobox', label: 'Ревьюер' })?.props.options, [{ value: 'claude', label: 'Claude' }])
    await assertNothingWritten(world, before, 'агент пропал')

    await panel.select({ role: 'combobox', label: 'Ревьюер' }, 'claude')
    world.orca.installedRefusal = { code: 'runtime_unavailable', message: 'Orca is not running' }
    await panel.press({ type: 'Button', text: 'Подключить' })
    assert.ok(
      shown(panel).includes('Агенты не проверены: Orca отказала: runtime_unavailable: Orca is not running (exit 1). Ничего не записано.'),
      shown(panel),
    )
    assert.ok(panel.find({ type: 'Button', text: 'Проверить снова' }))
    await assertNothingWritten(world, before, 'список не читается')
  })
})

test('Подключение, агенты: все агенты пропали после открытия формы → «ни одного агента» и «Проверить снова», введённое сохранено; список сменился новым агентом → ошибки у ролей и новые варианты, с ним проект подключается', async () => {
  await withConnectWorld(async (world) => {
    const before = await repoState(world)
    const panel = await openForm(world)
    world.orca.installedAgents = []
    await panel.press({ type: 'Button', text: 'Подключить' })
    assert.ok(shown(panel).includes('агенты: Orca не нашла на этом компьютере ни одного агента'), shown(panel))
    assert.equal(connectButton(panel), null)
    assert.ok(panel.find({ type: 'Button', text: 'Проверить снова' }))
    await assertNothingWritten(world, before, 'агентов нет')

    world.orca.installedAgents = [{ id: 'copilot', name: 'Copilot' }]
    await panel.press({ type: 'Button', text: 'Проверить снова' })
    assert.equal(panel.valueOf({ label: 'Команда полных тестов' }), 'make test', 'введённое потеряно')
    await panel.press({ type: 'Button', text: 'Подключить' })
    for (const label of ['Исполнитель', 'Ревьюер', 'Решатель', 'Агент старта']) {
      assert.equal(fieldError(panel, label), 'Выберите агента из тех, кого знает Orca', label)
      assert.deepEqual(panel.find({ role: 'combobox', label })?.props.options, [{ value: 'copilot', label: 'Copilot' }], label)
      await panel.select({ role: 'combobox', label }, 'copilot')
    }
    await panel.press({ type: 'Button', text: 'Подключить' })
    assert.deepEqual(headings(panel), ['Проверка проекта'])
    const settings = JSON.parse(await fileOnOrigin(world, '.agent-queue.json')) as { agents: Record<string, string> }
    assert.deepEqual(settings.agents, { implementer: 'copilot', reviewer: 'copilot', solver: 'copilot', start: 'copilot' })
  })
})

// ── The frames in between ─────────────────────────────────────────────────────────────────────────────────────────────

test('Подключение: проверки идут одна за другой (git ✓, «gh: проверяю вход…», «агенты: жду»), «Подключаю…», пока воркер подключает; светлая и тёмная тема Orca', async () => {
  const candidate: ConnectCandidate = {
    id: SHOP.id,
    hostId: SHOP.hostId,
    name: SHOP.name,
    path: '/work/shop-demo',
    repository: GITHUB_REPOSITORY,
    kit: false,
    otherHost: false,
  }
  for (const theme of ['light', 'dark'] as const) {
    let answerGh: (check: GhCheck) => void = () => {}
    let answerConnect: (result: ConnectResult) => void = () => {}
    const host = mockHost({
      settings: { interfaceLanguage: 'ru' },
      requests: {
        'projects.list': { projects: [] },
        'connect.projects': { projects: [candidate] },
        'connect.checkGit': { status: 'ok', repository: GITHUB_REPOSITORY, branches: ['main', 'develop'], defaultBranch: 'main' },
        'connect.checkGh': () => new Promise<GhCheck>((resolve) => (answerGh = resolve)),
        'connect.checkAgents': {
          status: 'ok',
          agents: [
            { id: 'claude', name: 'Claude' },
            { id: 'codex', name: 'Codex' },
          ],
          defaults: { implementer: 'claude', reviewer: 'codex', solver: 'claude', start: 'claude' },
        },
        'connect.connect': () => new Promise<ConnectResult>((resolve) => (answerConnect = resolve)),
      },
    })
    await view?.unmount()
    view = await mount(observedPanel, { host, theme })
    const panel = view
    await panel.press({ type: 'Button', text: 'Подключить проект' })
    assert.ok(shown(panel).includes('/work/shop-demo · GitHub: demo-org/shop-demo'), theme)

    const choosing = panel.press({ testId: CHOOSE })
    await drawnUntil(panel, () => shown(panel).includes('gh: проверяю вход…'))
    for (const line of [`git и GitHub: ${GITHUB_REPOSITORY}`, 'gh: проверяю вход…', 'агенты: жду']) {
      assert.ok(shown(panel).includes(line), `${theme}: нет «${line}»`)
    }
    assert.equal(connectButton(panel), null, `${theme}: форма до конца проверок`)
    answerGh({ status: 'ok', login: 'avery-example', defaultBranch: 'main' })
    await choosing
    assert.ok(connectButton(panel), `${theme}: форма не открылась`)
    assert.deepEqual(panel.find({ role: 'combobox', label: 'Базовая ветка' })?.props.options, [
      { value: 'main', label: 'main' },
      { value: 'develop', label: 'develop' },
    ])
    await panel.type({ label: 'Команда полных тестов' }, 'make test')
    // The templates follow the language and the test command until the owner edits them.
    assert.equal(panel.valueOf({ label: 'Правила для заданий' }), taskRulesTemplate({ language: 'ru', testCommand: 'make test' }))
    await panel.select({ role: 'combobox', label: 'Язык текстов в GitHub' }, 'en')
    assert.equal(panel.valueOf({ label: 'Правила для заданий' }), taskRulesTemplate({ language: 'en', testCommand: 'make test' }))
    assert.equal(panel.valueOf({ label: 'Правило данных' }), dataRuleTemplate('en'))
    await panel.select({ role: 'combobox', label: 'Язык текстов в GitHub' }, 'ru')

    const connecting = panel.press({ type: 'Button', text: 'Подключить' })
    await drawnUntil(panel, () => shown(panel).includes('Подключаю… метки GitHub, файлы настроек, коммит, пуш'))
    assert.equal(connectButton(panel), null, `${theme}: «Подключить» во время подключения`)
    const sent = host.callsOf('plugin.request').at(-1) as { name: string; input: { form: ConnectForm } }
    assert.equal(sent.name, 'connect.connect')
    assert.equal(sent.input.form.testCommand, 'make test')
    assert.equal(sent.input.form.taskRules, taskRulesTemplate({ language: 'ru', testCommand: 'make test' }))
    assert.equal(sent.input.form.dataRule, dataRuleTemplate('ru'))
    answerConnect({ status: 'connected', project: SHOP, operation: '7d3c1f2a-0b4e-4c5d-8e6f-1a2b3c4d5e6f', commit: 'a'.repeat(40) })
    await connecting
    assert.deepEqual(headings(panel), ['Проверка проекта'], theme)
    assert.deepEqual(panel.errors, [], theme)
    assert.deepEqual(panel.warnings, [], theme)
    assert.deepEqual(panel.refusals, [], theme)
  }
})
