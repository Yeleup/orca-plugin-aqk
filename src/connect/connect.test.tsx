// «Подключение проекта» end to end (Ф1, points 1–4, without the path through a PR; Ф3, the entry rule): the panel Orca
// opens, the real worker, real git on a temporary repository whose `origin` is a local bare repository, fake `gh` with
// a fake GitHub and a fake CLI of Orca (src/testing/connect-world.ts). Every name, repository and number is invented.
import { afterEach, assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as panelModule from '../panel'
import { PLUGIN_LABELS } from '../github/labels'
import { dataDirectory } from '../platform/paths'
import { ENTRY_RULE_BEGIN, entryRuleBlock, entryRuleIn } from '../project/entry-rule'
import { parseProjectSettings } from '../project/settings'
import { dataRuleTemplate, taskRulesTemplate } from '../project/templates'
import type { ConnectCandidate, ConnectForm, ConnectResult, GhCheck } from '../protocol'
import { textsIn, textsNotFromCatalog } from '../testing/panel-tree'
import { GITHUB_REPOSITORY, SHOP, withConnectWorld, type ConnectWorld } from '../testing/connect-world'
import type { FakeGhCall } from '../testing/fake-github'

const FOUR = ['.agent-queue.json', '.agent-queue.md', 'AGENTS.md', 'CLAUDE.md']

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

/** The panel in Russian over the world's worker, on «Подключение проекта» (from the menu of «Очередь»). */
async function openWizard(world: ConnectWorld, settings?: Record<string, string>): Promise<TestPanel> {
  await view?.unmount()
  view = await mount(panelModule, { host: world.panelHost(settings) })
  await view.press({ type: 'Button', text: settings?.interfaceLanguage === 'en' ? 'Connect project' : 'Подключить проект' })
  return view
}

async function chooseShop(panel: TestPanel): Promise<void> {
  await panel.press({ testId: `choose:${SHOP.id}` })
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

function assertClean(panel: TestPanel, language: 'ru' | 'en' = 'ru', data: readonly string[] = []): void {
  assert.deepEqual(panel.errors, [])
  assert.deepEqual(panel.warnings, [])
  assert.deepEqual(panel.refusals, [])
  const values = [SHOP.name, GITHUB_REPOSITORY, 'main', 'Claude', 'Codex', ...data]
  const stray = textsNotFromCatalog(textsIn(panel.tree()), language, values).filter((text) => !values.some((value) => text.includes(value)))
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

async function assertNothingWritten(world: ConnectWorld, before: RepoState, what: string): Promise<void> {
  assert.deepEqual(await repoState(world), before, `${what}: репозиторий изменился`)
  assert.deepEqual(writes(world), [], `${what}: запись в GitHub`)
  assert.deepEqual(world.github.labels, [], `${what}: метки`)
  assert.deepEqual(operations(world), [], `${what}: журнал операций`)
}

async function changedIn(world: ConnectWorld, commit: string): Promise<string[]> {
  return (await world.repo.git(['diff-tree', '--no-commit-id', '--name-only', '-r', commit])).split('\n').filter((line) => line !== '').sort()
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

test('К1.1: подключить проект при исправных gh и git → коммит в базовой ветке меняет только .agent-queue.json, .agent-queue.md, CLAUDE.md, AGENTS.md; в GitHub семь меток плагина; коммит запушен; открыт экран «Проверка проекта»', async () => {
  await withConnectWorld(async (world) => {
    const source = (await repoState(world)).head
    assert.deepEqual(await world.worker.request('projects.list'), { projects: [] })
    const panel = await openWizard(world)
    assert.deepEqual(headings(panel), ['Подключение проекта'])
    assert.match(shown(panel), /Проекты Orca, ещё не подключённые:/)
    assert.ok(shown(panel).includes(`· GitHub: ${GITHUB_REPOSITORY}`), shown(panel))
    await chooseShop(panel)
    for (const line of [`git и GitHub: ${GITHUB_REPOSITORY}`, 'gh: вход есть', 'агенты: claude, codex']) {
      assert.ok(shown(panel).includes(line), `нет строки «${line}»`)
    }
    assert.equal(panel.valueOf({ label: 'Базовая ветка' }), 'main')
    await panel.type({ label: 'Команда полных тестов' }, 'make test')
    assertClean(panel, 'ru', [world.repo.checkout, 'make test'])
    await panel.press({ type: 'Button', text: 'Подключить' })

    assert.deepEqual(headings(panel), ['Проверка проекта'])
    const after = await repoState(world)
    assert.equal(after.status, '', 'чекаут не чистый после подключения')
    assert.equal(after.origin, after.head, 'коммит не запушен')
    assert.equal((await world.repo.git(['rev-parse', `${after.head}^`])).trim(), source, 'родитель коммита — не исходный SHA')
    assert.deepEqual(await changedIn(world, after.head), FOUR)
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

test('Подключение: журнал операций — намерение (id операции, исходный SHA, четыре пути и хэш ожидаемого содержимого каждого) записано до меток; id операции — в сообщении коммита', async () => {
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
    const intent = JSON.parse(readFileSync(join(dir, 'intent.json'), 'utf8')) as Record<string, unknown>
    assert.equal(intent.kind, 'connect')
    assert.equal(intent.operation, result.operation)
    assert.equal(intent.sourceCommit, source)
    assert.equal(intent.baseBranch, 'main')
    const paths = intent.paths as { path: string; sourceBlob: string | null; expectedBlob: string }[]
    assert.deepEqual(paths.map((one) => one.path), ['.agent-queue.json', '.agent-queue.md', 'CLAUDE.md', 'AGENTS.md'])
    for (const one of paths) {
      const committed = (await world.repo.git(['rev-parse', `${result.commit}:${one.path}`])).trim()
      assert.equal(one.expectedBlob, committed, `хэш ожидаемого содержимого ${one.path}`)
      assert.equal(one.sourceBlob, null, `${one.path} не было в исходном коммите`)
    }
    for (const step of ['labels', 'files', 'commit', 'push']) assert.ok(existsSync(join(dir, `${step}.json`)), step)
    const message = await world.repo.git(['log', '-1', '--format=%B', result.commit])
    assert.match(message, new RegExp(`^Agent Queue: подключение проекта к очереди\\n\\nAgent-Queue-Operation: ${result.operation}\\n`))
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
      assertClean(panel, 'ru', [world.repo.checkout])
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
    const panel = await openWizard(world)
    await chooseShop(panel)
    await panel.type({ label: 'Команда полных тестов' }, 'make test')
    await world.repo.git(['checkout', '--quiet', '-b', 'feature/search'])
    const before = await repoState(world)
    await panel.press({ type: 'Button', text: 'Подключить' })
    assert.ok(
      shown(panel).includes('Основной чекаут не на базовой ветке main (сейчас feature/search). Ничего не записано.'),
      shown(panel),
    )
    assert.ok(panel.find({ type: 'Button', text: 'Проверить снова' }))
    assertClean(panel, 'ru', ['feature/search'])
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
    const panel = await openWizard(world)
    await chooseShop(panel)
    await panel.type({ label: 'Команда полных тестов' }, 'make test')
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
    const panel = await openWizard(world)
    await chooseShop(panel)
    await panel.type({ label: 'Команда полных тестов' }, 'make test')
    await panel.press({ type: 'Button', text: 'Подключить' })
    assert.ok(shown(panel).includes('Основной чекаут отстаёт от origin/main: коммитов — 1. Ничего не записано.'), shown(panel))
    await assertNothingWritten(world, before, 'отстаёт')
  })
})

test('К1.3 (опережает): у основного чекаута незапушенный коммит → «Подключить» отказывает с этой причиной, ничего не записано и не запушено', async () => {
  await withConnectWorld(async (world) => {
    await world.repo.commit({ 'src/app.txt': 'приложение\n' }, 'not pushed')
    const before = await repoState(world)
    const panel = await openWizard(world)
    await chooseShop(panel)
    await panel.type({ label: 'Команда полных тестов' }, 'make test')
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
    assertClean(panel, 'ru', [world.repo.checkout])
    await assertNothingWritten(world, before, 'пустая команда')
    // Spaces only are empty too, also for the worker itself.
    const result = await connect(world, { testCommand: '   ' })
    assert.deepEqual(result, {
      status: 'fields',
      errors: [{ field: 'testCommand', code: 'required', detail: 'the command of the full tests is required' }],
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
      assertClean(panel, 'ru', [world.repo.checkout])
      const result = await connect(world)
      assert.deepEqual(result, { status: 'refused', refusal: { reason: 'git', check: { status: 'problem', problem: 'no-github' } } })
      await assertNothingWritten(world, before, 'нет GitHub')
      assert.deepEqual(world.github.calls, [], 'gh вызван без репозитория GitHub')
      await panel.press({ type: 'Button', text: 'К выбору проекта' })
      assert.ok(panel.find({ testId: `choose:${SHOP.id}` }))
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
    const result = await connect(world)
    assert.equal(result.status, 'connected', JSON.stringify(result))
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
    const panel = await openWizard(world)
    await chooseShop(panel)
    await panel.type({ label: 'Команда полных тестов' }, 'make test')
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
    const after = await repoState(world)
    assert.equal(after.origin, after.head)
    assert.equal((await world.repo.git(['rev-parse', `${after.head}^`])).trim(), before.head)
    assert.deepEqual(await changedIn(world, after.head), FOUR)
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
    assert.equal(panel.find({ testId: `choose:${SHOP.id}` })?.disabled, true, 'проект на ките можно выбрать')
    assertClean(panel, 'ru', [world.repo.checkout])
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
    // The block the plugin writes is that one, in the project's language.
    const result = await connect(world, { language: 'en', taskRules: taskRulesTemplate({ language: 'en', testCommand: 'make test' }) })
    assert.equal(result.status, 'connected', JSON.stringify(result))
    for (const file of ['CLAUDE.md', 'AGENTS.md']) {
      const written = entryRuleIn(await fileOnOrigin(world, file))
      assert.equal(written, entryRuleBlock('en', GITHUB_REPOSITORY), file)
      assert.ok(written?.includes('«Depends on #N»'))
      assert.ok(written?.includes(`--repo ${GITHUB_REPOSITORY} --label agent-queue`))
    }
  })
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
    assert.equal(result.status, 'refused')
    assert.ok(result.status === 'refused' && result.refusal.reason === 'agents')
    await assertNothingWritten(world, before, 'без CLI')
    world.orca.cliPresent = true
    await panel.press({ type: 'Button', text: 'Проверить снова' })
    assert.ok(connectButton(panel), 'форма не открылась')
    assert.ok(shown(panel).includes('агенты: claude, codex'))
  })
})

test('Подключение, агенты: CLI не дал списка (отказ Orca, не JSON, нет ответа в срок) или список пуст → строка агентов блокирует, формы нет', async () => {
  await withConnectWorld(async (world) => {
    const cases: [string, () => void, string][] = [
      ['отказ Orca', () => (world.orca.installedRefusal = { code: 'runtime_unavailable', message: 'Orca is not running' }), 'агенты: не проверено: orca agent installed: Orca refused: runtime_unavailable: Orca is not running (exit 1)'],
      ['не JSON', () => (world.orca.installedAnswer = { code: 0, stdout: 'claude codex\n' }), 'агенты: не проверено: orca agent installed: answered no JSON (exit 0): claude codex'],
      ['нет ответа в срок', () => (world.orca.installedAnswer = { timedOut: true, signal: 'SIGKILL' }), 'агенты: не проверено: orca agent installed: stopped after 30000 ms without an answer'],
      ['пустой список', () => (world.orca.installedAgents = []), 'агенты: Orca не нашла на этом компьютере ни одного агента — установите агента или включите его в Settings → Agents'],
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
    }
    await assertNothingWritten(world, before, 'список агентов не прочитан')
  })
})

test('Подключение, агенты: после открытия формы агент роли пропал из списка → «Подключить» даёт ошибку у поля этой роли; список в момент «Подключить» не читается → отказ с причиной; ничего не записано', async () => {
  await withConnectWorld(async (world) => {
    const before = await repoState(world)
    const panel = await openWizard(world)
    await chooseShop(panel)
    await panel.type({ label: 'Команда полных тестов' }, 'make test')
    world.orca.installedAgents = [{ id: 'claude', name: 'Claude' }]
    await panel.press({ type: 'Button', text: 'Подключить' })
    assert.equal(fieldError(panel, 'Ревьюер'), 'Выберите агента из тех, кого знает Orca')
    assert.equal(fieldError(panel, 'Исполнитель'), undefined)
    await assertNothingWritten(world, before, 'агент пропал')

    world.orca.installedAgents = [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' }]
    world.orca.installedRefusal = { code: 'runtime_unavailable', message: 'Orca is not running' }
    await panel.select({ role: 'combobox', label: 'Ревьюер' }, 'codex')
    await panel.press({ type: 'Button', text: 'Подключить' })
    assert.ok(
      shown(panel).includes(
        'Агенты не проверены: orca agent installed: Orca refused: runtime_unavailable: Orca is not running (exit 1). Ничего не записано.',
      ),
      shown(panel),
    )
    assert.ok(panel.find({ type: 'Button', text: 'Проверить снова' }))
    await assertNothingWritten(world, before, 'список не читается')
  })
})

test('Подключение: проверки идут одна за другой (git ✓, «gh: проверяю вход…», «агенты: жду»), «Подключаю…», пока воркер подключает; светлая и тёмная тема Orca', async () => {
  const candidate: ConnectCandidate = {
    id: SHOP.id,
    hostId: SHOP.hostId,
    name: SHOP.name,
    path: '/work/shop-demo',
    repository: GITHUB_REPOSITORY,
    kit: false,
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

    const choosing = panel.press({ testId: `choose:${SHOP.id}` })
    await drawnUntil(panel, () => shown(panel).includes('gh: проверяю вход…'))
    for (const line of [`git и GitHub: ${GITHUB_REPOSITORY}`, 'gh: проверяю вход…', 'агенты: жду']) {
      assert.ok(shown(panel).includes(line), `${theme}: нет «${line}»`)
    }
    assert.equal(connectButton(panel), null, `${theme}: форма до конца проверок`)
    answerGh({ status: 'ok', login: 'avery-example' })
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
