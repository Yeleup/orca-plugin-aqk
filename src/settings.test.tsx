// The screen «Настройки» and the plugin's settings (task settings): the interface language, the queue check interval,
// merge notifications and the coordinator of this computer as Orca keeps them for the plugin; the saved and error
// states; «Настройки проекта», which opens the selected project's files in Orca's editor through the worker. The panel
// under test is the module the manifest names as its entry; Orca's mock host stands in for Orca (its settings are the
// plugin's settings) and, where a test says so, the real worker answers on a host of its own. Projects, paths and
// errors are invented.
import { settings, type JsonValue, type PluginRequestInput, type PluginRequestOutput } from 'orca'
import {
  afterEach,
  assert,
  hostError,
  mockHost,
  mount,
  mountWorker,
  test,
  type MockHost,
  type MockRequests,
  type TestPanel,
} from 'orca/testing'
import manifest from '../orca-plugin.json' with { type: 'json' }
import { LANGUAGE_SETTING, type Language } from './i18n/catalog'
import type { Project } from './protocol'
import {
  DEFAULT_SETTINGS,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  parseSettings,
  readSettings,
  SETTING_KEYS,
} from './settings'
import { pixelWidths, textsIn, textsNotFromCatalog } from './testing/panel-tree'
import { withTemporaryHome } from './testing/temporary-home'
import * as worker from './worker'

const declared = manifest.contributes.panels.find((contribution) => contribution.id === 'agent-queue')
if (!declared || declared.ui !== 'components') {
  throw new Error('orca-plugin.json: no components panel agent-queue in contributes.panels')
}
const panelModule = (await import(`../${declared.entry}`)) as typeof import('./panel')
const DeclaredPanel = panelModule.default

// Every draw of the panel lets the waiters of `nextDraw()` go on (as in src/panel.test.tsx): a test sees the panel as it
// is drawn while a write it holds back is on its way. The panel itself is the declared module, unchanged.
let drawWaiters: (() => void)[] = []
function nextDraw(): Promise<void> {
  return new Promise((resolve) => drawWaiters.push(resolve))
}
const observedPanel = {
  setup: panelModule.setup,
  default: () => {
    for (const resolve of drawWaiters.splice(0)) resolve()
    return <DeclaredPanel />
  },
}

// Orca's ids and hosts of the projects (project.list); the panel keeps the id as the selected project.
const SHOP: Project = { id: 'project-shop', hostId: 'local', name: 'shop-demo' }
const BLOG: Project = { id: 'project-blog', hostId: 'local', name: 'blog-demo' }

const RU = { [LANGUAGE_SETTING]: 'ru' }

let view: TestPanel | undefined
// Lets through every write a test held back and did not end (a failed test), so the next test's writes are not queued
// behind it.
let releaseHeld: (() => void) | null = null
afterEach(async () => {
  releaseHeld?.()
  releaseHeld = null
  await view?.unmount()
  view = undefined
})

/** A host whose plugin settings hold `stored`; the worker answers `projects.list` with `projects`. */
function hostWith(options: {
  settings?: Record<string, JsonValue>
  projects?: Project[]
  results?: Record<string, unknown>
  requests?: MockRequests
} = {}): MockHost {
  return mockHost({
    settings: options.settings ?? {},
    results: options.results,
    requests: { 'projects.list': { projects: options.projects ?? [SHOP] }, ...options.requests },
  })
}

/** Mounts the panel on `host`, after closing the one a test opened before. */
async function open(host: MockHost): Promise<TestPanel> {
  await view?.unmount()
  view = undefined
  view = await mount(observedPanel, { host })
  return view
}

/** Opens «Настройки» from the menu of «Очередь». */
async function openSettings(panel: TestPanel, language: Language = 'ru'): Promise<void> {
  await panel.press({ type: 'Button', text: language === 'ru' ? 'Настройки' : 'Settings' })
}

function headings(panel: TestPanel): string[] {
  return panel.findAll({ type: 'Heading' }).map((heading) => heading.text)
}

function callouts(panel: TestPanel): { tone: unknown; text: string }[] {
  return panel.findAll({ type: 'Callout' }).map((callout) => ({ tone: callout.props.tone, text: callout.text }))
}

const LABELS = {
  ru: {
    language: 'Язык интерфейса',
    interval: 'Интервал проверки очереди, минут',
    notifications: 'Уведомления о мержах',
    coordinator: 'Координатор на этом компьютере',
  },
  en: {
    language: 'Interface language',
    interval: 'Queue check interval, minutes',
    notifications: 'Merge notifications',
    coordinator: 'Coordinator on this computer',
  },
} as const

/** What the screen shows in each of its controls, read by the labels of `language`. */
function shown(panel: TestPanel, language: Language) {
  const labels = LABELS[language]
  return {
    language: panel.valueOf({ label: labels.language }),
    interval: panel.valueOf({ label: labels.interval }),
    notifications: panel.valueOf({ label: labels.notifications }),
    coordinator: panel.valueOf({ label: labels.coordinator }),
  }
}

/** The settings the mock host keeps for the plugin now. */
function stored(host: MockHost): Record<string, JsonValue> {
  return host.data().settings as Record<string, JsonValue>
}

function assertClean(panel: TestPanel): void {
  assert.deepEqual(panel.errors, [])
  assert.deepEqual(panel.warnings, [])
  assert.deepEqual(panel.refusals, [])
}

function assertFromCatalog(panel: TestPanel, language: Language, data: readonly string[], where: string): void {
  const seen = textsIn(panel.tree())
  assert.ok(seen.length > 0, `${where}: нет текстов`)
  assert.deepEqual(textsNotFromCatalog(seen, language, data), [], `${where} (${language}): не из каталога строк`)
}

const SAVED_RU = 'Сохранено.'
const NOTIFICATIONS_OFF_RU = 'Сохранено: уведомлений о мержах не будет, о блокировках — будут.'
const COORDINATOR_OFF_RU = 'Сохранено: координатор этого компьютера не берёт и не ведёт задачи; панель только показывает очередь.'
const BOTH_OFF_RU = 'Сохранено: уведомлений о мержах нет, координатор этого компьютера задачи не берёт.'

test('К15.2: смена языка интерфейса в «Настройках» → панель сразу на выбранном языке', async () => {
  const host = hostWith({ settings: RU })
  const panel = await open(host)
  await openSettings(panel)
  assert.deepEqual(headings(panel), ['Настройки'])
  assert.equal(panel.valueOf({ label: 'Язык интерфейса' }), 'ru')
  assert.deepEqual(
    panel.find({ label: 'Язык интерфейса' })?.props.options,
    [
      { value: 'en', label: 'English' },
      { value: 'ru', label: 'Русский' },
    ],
  )

  await panel.select({ label: 'Язык интерфейса' }, 'en')
  assert.equal(stored(host)[LANGUAGE_SETTING], 'en')
  // The same screen, at once in English: its title, «Back», every label and the saved line.
  assert.deepEqual(headings(panel), ['Settings'])
  assert.ok(panel.find({ type: 'Link', text: 'Back' }), 'нет «Back»')
  assert.deepEqual(shown(panel, 'en'), { language: 'en', interval: '5', notifications: true, coordinator: true })
  assert.deepEqual(callouts(panel), [{ tone: 'success', text: 'Saved.' }])
  assert.ok(panel.find({ type: 'Text', text: 'Project settings' }), 'нет «Project settings»')
  assertFromCatalog(panel, 'en', [], 'после смены языка')
  // The rest of the panel too.
  await panel.press({ type: 'Link', text: 'Back' })
  assert.deepEqual(
    panel.findAll({ type: 'Button' }).map((button) => button.text),
    ['Project check', 'Start MVP', 'Settings', 'Connect project'],
  )

  // And back to Russian.
  await openSettings(panel, 'en')
  await panel.select({ label: 'Interface language' }, 'ru')
  assert.equal(stored(host)[LANGUAGE_SETTING], 'ru')
  assert.deepEqual(headings(panel), ['Настройки'])
  assert.deepEqual(callouts(panel), [{ tone: 'success', text: SAVED_RU }])
  assertFromCatalog(panel, 'ru', [], 'после возврата к русскому')
  assertClean(panel)
})

test('Настройки: выключить «Уведомления о мержах», сменить язык, выйти и вернуться в «Настройки» → переключатель выключен, тексты на выбранном языке', async () => {
  const host = hostWith({ settings: RU })
  const panel = await open(host)
  await openSettings(panel)
  assert.equal(panel.valueOf({ label: 'Уведомления о мержах' }), true)

  await panel.toggle({ label: 'Уведомления о мержах' })
  assert.equal(stored(host)[SETTING_KEYS.mergeNotifications], false)
  assert.equal(panel.valueOf({ label: 'Уведомления о мержах' }), false)
  assert.deepEqual(callouts(panel), [{ tone: 'success', text: NOTIFICATIONS_OFF_RU }])

  await panel.select({ label: 'Язык интерфейса' }, 'en')
  assert.deepEqual(shown(panel, 'en'), { language: 'en', interval: '5', notifications: false, coordinator: true })
  assert.deepEqual(callouts(panel), [{ tone: 'success', text: 'Saved.' }])

  await panel.press({ type: 'Link', text: 'Back' })
  assert.deepEqual(headings(panel), ['Agent Queue'])
  await openSettings(panel, 'en')
  assert.deepEqual(headings(panel), ['Settings'])
  assert.deepEqual(shown(panel, 'en'), { language: 'en', interval: '5', notifications: false, coordinator: true })
  assert.deepEqual(callouts(panel), [], 'новый заход на экран — без прежней строки «Saved.»')
  assertFromCatalog(panel, 'en', [], 'после возврата на экран')
  assertClean(panel)

  // The next run of the panel reads the same settings from Orca.
  const again = await open(hostWith({ settings: stored(host) }))
  await openSettings(again, 'en')
  assert.deepEqual(headings(again), ['Settings'])
  assert.deepEqual(shown(again, 'en'), { language: 'en', interval: '5', notifications: false, coordinator: true })
  assertClean(again)
})

test('Настройки: хранилище отказало в записи → «Не удалось сохранить: <ошибка>», на экране прежние значения', async () => {
  const before = {
    [LANGUAGE_SETTING]: 'ru',
    [SETTING_KEYS.queueCheckInterval]: 10,
    [SETTING_KEYS.mergeNotifications]: true,
    [SETTING_KEYS.coordinator]: false,
  }
  const host = hostWith({
    settings: before,
    results: {
      'settings.set': () => {
        throw hostError('action_failed', 'хранилище плагина недоступно')
      },
    },
  })
  const panel = await open(host)
  await openSettings(panel)
  const previous = { language: 'ru', interval: '10', notifications: true, coordinator: false }
  assert.deepEqual(shown(panel, 'ru'), previous)
  const refused = [{ tone: 'danger', text: 'Не удалось сохранить: хранилище плагина недоступно' }]

  await panel.toggle({ label: 'Уведомления о мержах' })
  assert.deepEqual(callouts(panel), refused, 'уведомления о мержах')
  assert.deepEqual(shown(panel, 'ru'), previous, 'уведомления о мержах')

  await panel.toggle({ label: 'Координатор на этом компьютере' })
  assert.deepEqual(callouts(panel), refused, 'координатор')
  assert.deepEqual(shown(panel, 'ru'), previous, 'координатор')

  await panel.type({ label: 'Интервал проверки очереди, минут' }, '30', { replace: true })
  assert.deepEqual(callouts(panel), refused, 'интервал')
  assert.deepEqual(shown(panel, 'ru'), previous, 'интервал')

  await panel.select({ label: 'Язык интерфейса' }, 'en')
  assert.deepEqual(callouts(panel), refused, 'язык')
  assert.deepEqual(shown(panel, 'ru'), previous, 'язык')
  assert.deepEqual(headings(panel), ['Настройки'], 'панель сменила язык, хотя он не сохранён')

  assert.ok(host.callsOf('settings.set').length >= 4, 'не каждое изменение дошло до хранилища')
  assert.deepEqual(stored(host), before)
  assertFromCatalog(panel, 'ru', ['хранилище плагина недоступно'], 'ошибка')
  assertClean(panel)
})

/** The panel's request `project.openFile`, answered by the real worker. */
type OpenFile = (input: PluginRequestInput<'project.openFile'>) => Promise<PluginRequestOutput<'project.openFile'>>

/** The real worker on a host of its own, with Orca's projects and workspaces; the panel's host asks it. */
async function withWorker(
  orcaResults: Record<string, unknown>,
  body: (orcaHost: MockHost, openFile: OpenFile) => Promise<void>,
): Promise<void> {
  await withTemporaryHome(async () => {
    const orcaHost = mockHost({ results: orcaResults })
    const running = await mountWorker(worker, { host: orcaHost })
    await body(orcaHost, (input) => running.request('project.openFile', input))
    assert.deepEqual(running.refusals, [], 'Orca отказала воркеру')
    await running.deactivate()
  })
}

// The blog project has a copy on another host with the same id and the same path, listed first by Orca.
const REMOTE = 'ssh:build-box'
const ORCA_PROJECTS = {
  projects: [
    { id: SHOP.id, name: 'shop-demo', kind: 'git', hostId: 'local', path: '/work/shop-demo' },
    { id: BLOG.id, name: 'blog-demo', kind: 'git', hostId: REMOTE, path: '/work/blog-demo' },
    { id: BLOG.id, name: 'blog-demo', kind: 'git', hostId: 'local', path: '/work/blog-demo' },
  ],
  truncated: false,
}
const ORCA_WORKSPACES = {
  workspaces: [
    // A row that records no host is one of this machine (workspace.list).
    { id: 'ws-shop-main', kind: 'worktree', name: 'main', projectId: SHOP.id, path: '/work/shop-demo', branch: 'main', hostId: null },
    { id: 'ws-remote-blog-main', kind: 'worktree', name: 'main', projectId: BLOG.id, path: '/work/blog-demo', branch: 'main', hostId: REMOTE },
    {
      id: 'ws-blog-issue-7',
      kind: 'worktree',
      name: 'agent-queue/issue-7',
      projectId: BLOG.id,
      path: '/work/blog-demo-worktrees/issue-7',
      branch: 'agent-queue/issue-7',
      hostId: 'local',
    },
    { id: 'ws-blog-main', kind: 'worktree', name: 'main', projectId: BLOG.id, path: '/work/blog-demo/', branch: 'main', hostId: 'local' },
  ],
  truncated: false,
}

/** The worker's calls that show a workspace and open a file in it, in order. */
function opening(orcaHost: MockHost): { method: string; params: unknown }[] {
  return orcaHost.calls.filter((call) => call.method === 'workspace.open' || call.method === 'editor.open')
}

test('Настройки: «Настройки проекта» → запрос открыть .agent-queue.json и .agent-queue.md выбранного проекта в редакторе Orca', async () => {
  const orca = {
    'project.list': ORCA_PROJECTS,
    'workspace.list': ORCA_WORKSPACES,
    'workspace.open': { opened: true },
    'editor.open': { opened: true },
  }
  await withWorker(orca, async (orcaHost, openFile) => {
    const panel = await open(
      hostWith({ settings: RU, projects: [SHOP, BLOG], requests: { 'project.openFile': openFile } }),
    )
    // The project selected on «Очередь».
    await panel.select({ role: 'combobox' }, BLOG.id)
    await openSettings(panel)
    assert.ok(panel.find({ type: 'Text', text: 'Настройки проекта' }), 'нет «Настройки проекта»')
    const files = panel.findAll({ type: 'Button' })
    assert.deepEqual(
      files.map((button) => [button.text, button.props.tooltip, button.disabled]),
      [
        ['.agent-queue.json', 'Открывает файл в редакторе Orca', false],
        ['.agent-queue.md', 'Открывает файл в редакторе Orca', false],
      ],
    )

    await panel.press({ type: 'Button', text: '.agent-queue.json' })
    await panel.press({ type: 'Button', text: '.agent-queue.md' })
    const asked = panel.host.callsOf('plugin.request').filter((call) => (call as { name: string }).name !== 'projects.list')
    assert.deepEqual(asked, [
      { name: 'project.openFile', input: { projectId: BLOG.id, hostId: 'local', file: '.agent-queue.json' } },
      { name: 'project.openFile', input: { projectId: BLOG.id, hostId: 'local', file: '.agent-queue.md' } },
    ])
    // The worker shows the workspace of the project's main checkout on the project's own host — not a task's worktree,
    // not the copy on another host with the same id and path — and then opens the file in it.
    assert.deepEqual(opening(orcaHost), [
      { method: 'workspace.open', params: { workspaceId: 'ws-blog-main' } },
      { method: 'editor.open', params: { workspaceId: 'ws-blog-main', path: '.agent-queue.json' } },
      { method: 'workspace.open', params: { workspaceId: 'ws-blog-main' } },
      { method: 'editor.open', params: { workspaceId: 'ws-blog-main', path: '.agent-queue.md' } },
    ])
    assert.deepEqual(callouts(panel), [])
    assertClean(panel)
  })
})

test('Настройки: у проекта нет основного чекаута в Orca или редактор Orca отказал → «Не удалось открыть <файл>: <причина>»; файл вне «Настроек проекта» воркер не открывает', async () => {
  let editor: () => unknown = () => ({ opened: true })
  const orca = {
    // Orca has the blog project only on another host now; its main checkout there is not the selected project's.
    'project.list': {
      projects: ORCA_PROJECTS.projects.filter((project) => project.id !== BLOG.id || project.hostId !== 'local'),
      truncated: false,
    },
    'workspace.list': ORCA_WORKSPACES,
    'workspace.open': { opened: true },
    'editor.open': () => editor(),
  }
  await withWorker(orca, async (orcaHost, openFile) => {
    const panel = await open(
      hostWith({ settings: RU, projects: [SHOP, BLOG], requests: { 'project.openFile': openFile } }),
    )
    await panel.select({ role: 'combobox' }, BLOG.id)
    await openSettings(panel)
    await panel.press({ type: 'Button', text: '.agent-queue.json' })
    assert.deepEqual(callouts(panel), [
      { tone: 'danger', text: 'Не удалось открыть .agent-queue.json: в Orca нет основного чекаута этого проекта' },
    ])
    assert.deepEqual(opening(orcaHost), [], 'открыта копия проекта на другом хосте')

    await panel.press({ type: 'Link', text: 'Назад' })
    await panel.select({ role: 'combobox' }, SHOP.id)
    await openSettings(panel)
    assert.deepEqual(callouts(panel), [], 'новый заход на экран — без прежней ошибки')
    editor = () => {
      throw hostError('unavailable', 'only the Orca desktop app can do this')
    }
    await panel.press({ type: 'Button', text: '.agent-queue.md' })
    assert.deepEqual(callouts(panel), [
      { tone: 'danger', text: 'Не удалось открыть .agent-queue.md: only the Orca desktop app can do this' },
    ])
    assertFromCatalog(panel, 'ru', [SHOP.name, BLOG.name, 'only the Orca desktop app can do this'], 'ошибка открытия')

    // The next press that opens the file takes the error away.
    editor = () => ({ opened: true })
    await panel.press({ type: 'Button', text: '.agent-queue.md' })
    assert.deepEqual(callouts(panel), [])
    assert.deepEqual(orcaHost.callsOf('editor.open'), [
      { workspaceId: 'ws-shop-main', path: '.agent-queue.md' },
      { workspaceId: 'ws-shop-main', path: '.agent-queue.md' },
    ])
    assertClean(panel)

    // Any other path, or a request without the project's host, is refused before Orca is asked.
    const refused = [
      ...['../.env', '.agent-queue.json/../secret', 'README.md', ''].map((file) => ({ projectId: SHOP.id, hostId: 'local', file })),
      { projectId: SHOP.id, file: '.agent-queue.json' },
      { projectId: SHOP.id, hostId: '', file: '.agent-queue.json' },
    ]
    for (const input of refused) {
      await assert.rejects(
        openFile(input as never),
        (error) => (error as { code?: string }).code === 'invalid_params',
      )
    }
    assert.equal(orcaHost.callsOf('editor.open').length, 2)
  })
})

test('Настройки: нет подключённых проектов → «Настройки проекта» недоступны и «Нет подключённых проектов», запросов к воркеру нет', async () => {
  const panel = await open(hostWith({ settings: RU, projects: [] }))
  await openSettings(panel)
  const files = panel.findAll({ type: 'Button' })
  assert.deepEqual(
    files.map((button) => [button.text, button.disabled]),
    [
      ['.agent-queue.json', true],
      ['.agent-queue.md', true],
    ],
  )
  assert.ok(panel.find({ type: 'Text', text: 'Нет подключённых проектов' }))
  assert.deepEqual(panel.host.callsOf('plugin.request'), [{ name: 'projects.list' }])
  assertClean(panel)
})

test('Настройки: строка «Сохранено» после переключателя называет, что переключатели теперь значат, — как на кадрах «Настройки — сохранено — …»', async () => {
  const host = hostWith({ settings: RU })
  const panel = await open(host)
  await openSettings(panel)
  assert.deepEqual(callouts(panel), [], '«с данными» — без строки')
  const steps: [string, string, boolean, boolean][] = [
    ['Уведомления о мержах', NOTIFICATIONS_OFF_RU, false, true],
    ['Координатор на этом компьютере', BOTH_OFF_RU, false, false],
    ['Уведомления о мержах', COORDINATOR_OFF_RU, true, false],
    ['Координатор на этом компьютере', SAVED_RU, true, true],
    ['Координатор на этом компьютере', COORDINATOR_OFF_RU, true, false],
    ['Уведомления о мержах', BOTH_OFF_RU, false, false],
    ['Координатор на этом компьютере', NOTIFICATIONS_OFF_RU, false, true],
    ['Уведомления о мержах', SAVED_RU, true, true],
  ]
  for (const [toggled, line, notifications, coordinator] of steps) {
    await panel.toggle({ label: toggled })
    assert.deepEqual(callouts(panel), [{ tone: 'success', text: line }], `«${toggled}» → ${notifications}, ${coordinator}`)
    const saved = parseSettings(stored(host))
    assert.deepEqual([saved.mergeNotifications, saved.coordinator], [notifications, coordinator], `«${toggled}»: сохранено`)
    assert.deepEqual(shown(panel, 'ru'), { language: 'ru', interval: '5', notifications, coordinator })
  }

  // In English the same lines come from the English catalog; a change of the language says only «Saved.».
  await panel.toggle({ label: 'Уведомления о мержах' })
  await panel.select({ label: 'Язык интерфейса' }, 'en')
  assert.deepEqual(callouts(panel), [{ tone: 'success', text: 'Saved.' }])
  await panel.toggle({ label: 'Coordinator on this computer' })
  assert.deepEqual(callouts(panel), [
    { tone: 'success', text: 'Saved: no merge notifications, and the coordinator of this computer takes no tasks.' },
  ])
  assertClean(panel)
})

// Each change of the field that is a whole number of minutes, at least 1, is saved at once, as the person types it
// (typing «30» saves 3, then 30); a text that is not stays in the field with its error and is not saved. No upper limit.
// The top of the range is no product limit, only the largest whole number a JSON number holds exactly
// (Number.MAX_SAFE_INTEGER), declared as the setting's maximum so that Orca's Settings take the same intervals.
test('Настройки: интервал проверки очереди — целое число минут не меньше 1 сохраняется сразу, без верхнего предела; другое значение не сохраняется, у поля ошибка', async () => {
  const host = hostWith({ settings: RU })
  const panel = await open(host)
  await openSettings(panel)
  const field = { label: 'Интервал проверки очереди, минут' }
  const invalid = `Введите целое число минут, не меньше ${MIN_INTERVAL_MINUTES}`
  const tooLarge = `Введите целое число минут, не больше ${MAX_INTERVAL_MINUTES}`
  const assertRefused = (typed: string, kept: number, error = invalid) => {
    assert.equal(stored(host)[SETTING_KEYS.queueCheckInterval], kept, `«${typed}» сохранено`)
    assert.equal(panel.valueOf(field), typed, `«${typed}»: в поле не то, что набрано`)
    assert.ok(panel.find({ type: 'Text', text: error }), `«${typed}»: нет ошибки у поля`)
    assert.equal(panel.find(field)?.props.invalid, true, `«${typed}»: поле не помечено`)
    // A new change takes away the line of the earlier one: nothing of this text is saved.
    assert.deepEqual(callouts(panel), [], `«${typed}»: прежняя строка над настройками`)
  }

  await panel.type(field, '15', { replace: true })
  assert.equal(stored(host)[SETTING_KEYS.queueCheckInterval], 15)
  assert.equal(panel.valueOf(field), '15')
  assert.deepEqual(callouts(panel), [{ tone: 'success', text: SAVED_RU }])
  assert.equal(panel.find({ type: 'Text', text: invalid }), null)

  for (const typed of ['0', '00', '-5', 'пять', '']) {
    await panel.type(field, typed, { replace: true })
    assertRefused(typed, 15)
  }
  // Once in two days, and once in a year: no upper limit.
  for (const minutes of [2880, 525600]) {
    await panel.type(field, String(minutes), { replace: true })
    assert.equal(stored(host)[SETTING_KEYS.queueCheckInterval], minutes)
    assert.equal(panel.valueOf(field), String(minutes))
    assert.equal(panel.find({ type: 'Text', text: invalid }), null)
  }
  // A fraction.
  await panel.type(field, '.5')
  assertRefused('525600.5', 525600)
  // The largest whole number a JSON number holds is saved; one digit more is past it.
  await panel.type(field, String(MAX_INTERVAL_MINUTES), { replace: true })
  assert.equal(stored(host)[SETTING_KEYS.queueCheckInterval], MAX_INTERVAL_MINUTES)
  assert.deepEqual(callouts(panel), [{ tone: 'success', text: SAVED_RU }])
  await panel.type(field, '0')
  assertRefused(`${MAX_INTERVAL_MINUTES}0`, MAX_INTERVAL_MINUTES, tooLarge)
  await panel.type(field, '2880', { replace: true })

  await panel.press({ type: 'Link', text: 'Назад' })
  await openSettings(panel)
  assert.equal(panel.valueOf(field), '2880', 'на экране не сохранённый интервал')
  assert.equal(panel.find({ type: 'Text', text: invalid }), null, 'новый заход на экран — без прежней ошибки')
  assertClean(panel)
})

/**
 * Plugin settings whose writes the test holds back: each lands (or is refused) only when the test says. `written(n)`
 * resolves once n writes have reached the host (the screen sends the next write only after the one before has ended).
 */
function heldSettings(initial: Record<string, JsonValue>) {
  const store: Record<string, JsonValue> = { ...initial }
  const held: { key: string; value: JsonValue; land(): void; refuse(message: string): void }[] = []
  let waiters: { count: number; resolve: () => void }[] = []
  let released = false
  releaseHeld = () => {
    released = true
    for (const write of held) write.land()
  }
  const results = {
    'settings.get': () => ({ settings: { ...store } }),
    'settings.set': ({ key, value }: { key: string; value: JsonValue }) =>
      new Promise((resolve, reject) => {
        const land = () => {
          store[key] = value
          resolve({ ok: true })
        }
        if (released) return land()
        held.push({ key, value, land, refuse: (message) => reject(hostError('action_failed', message)) })
        const ready = waiters.filter((waiter) => held.length >= waiter.count)
        waiters = waiters.filter((waiter) => held.length < waiter.count)
        for (const waiter of ready) waiter.resolve()
      }),
  }
  const written = (count: number) =>
    held.length >= count ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ count, resolve }))
  return { store, held, results, written }
}

/**
 * Runs `act` and resolves once the panel has drawn after it, without waiting for the writes it holds back; `.acting`
 * ends with the act. (Wrapped: an async function's returned promise would be waited for.)
 */
async function drawnAfter(act: () => Promise<void>): Promise<{ acting: Promise<void> }> {
  const drawn = nextDraw()
  const acting = act()
  await drawn
  return { acting }
}

/** Ends a held write with `end` and resolves once the panel has drawn what followed. */
async function redrawnAfter(end: () => void): Promise<void> {
  const drawn = nextDraw()
  end()
  await drawn
}

test('Настройки: интервал — две цифры подряд, пока запись первой не закончилась → в поле набранное «15», сохраняется 15; отказ в записи первой цифры не откатывает вторую', async () => {
  const field = { label: 'Интервал проверки очереди, минут' }
  const refusal = { tone: 'danger', text: 'Не удалось сохранить: хранилище плагина недоступно' }
  const outcomes = [
    { firstRefused: false, secondRefused: false, field: '15', stored: 15, line: { tone: 'success', text: SAVED_RU } },
    { firstRefused: true, secondRefused: false, field: '15', stored: 15, line: { tone: 'success', text: SAVED_RU } },
    { firstRefused: false, secondRefused: true, field: '1', stored: 1, line: refusal },
    { firstRefused: true, secondRefused: true, field: '5', stored: undefined, line: refusal },
  ]
  for (const outcome of outcomes) {
    const where = `«1» ${outcome.firstRefused ? 'отказ' : 'сохранено'}, «15» ${outcome.secondRefused ? 'отказ' : 'сохранено'}`
    const writes = heldSettings(RU)
    const panel = await open(hostWith({ results: writes.results }))
    await openSettings(panel)
    assert.equal(panel.valueOf(field), '5')
    await panel.type(field, '', { replace: true })

    // «1» in place of «5»: its write is held back, and the field keeps «1».
    const first = await drawnAfter(() => panel.type(field, '1'))
    await writes.written(1)
    assert.equal(panel.valueOf(field), '1', 'пока идёт запись, в поле вернулось прежнее значение')
    // «5» after it — a separate input event while the write of «1» is on its way.
    const second = await drawnAfter(() => panel.type(field, '5'))
    assert.equal(panel.valueOf(field), '15')
    assert.deepEqual(callouts(panel), [], `${where}: строка, пока ничего не записано`)

    // The write of «1» ends: «15» is still on its way, so the field keeps it and the screen says nothing yet — neither
    // «Сохранено.» for a value it does not show, nor the refusal of a value the person has typed over. (A refused «1»
    // changes nothing on the screen, so there is no draw to wait for.)
    if (outcome.firstRefused) writes.held[0]?.refuse('хранилище плагина недоступно')
    else await redrawnAfter(() => writes.held[0]?.land())
    await writes.written(2)
    assert.equal(panel.valueOf(field), '15', `${where}: конец записи «1» изменил поле, хотя «15» ещё в пути`)
    assert.deepEqual(callouts(panel), [], `${where}: строка между концами записей`)
    assert.deepEqual(
      writes.held.map((write) => [write.key, write.value]),
      [
        [SETTING_KEYS.queueCheckInterval, 1],
        [SETTING_KEYS.queueCheckInterval, 15],
      ],
    )

    // The write of «15» ends: only now the line, and after a refusal the value Orca keeps.
    await redrawnAfter(() => {
      if (outcome.secondRefused) writes.held[1]?.refuse('хранилище плагина недоступно')
      else writes.held[1]?.land()
    })
    await first.acting
    await second.acting
    assert.equal(writes.store[SETTING_KEYS.queueCheckInterval], outcome.stored, where)
    assert.equal(panel.valueOf(field), outcome.field, where)
    assert.deepEqual(callouts(panel), [outcome.line], where)
    assertClean(panel)
  }
})

test('Настройки: запись последней правки отказана, пока идёт запись → на экране снова сохранённое значение; до конца записи — то, что выбрал человек', async () => {
  for (const intervalRefused of [true, false]) {
    const writes = heldSettings(RU)
    const panel = await open(hostWith({ results: writes.results }))
    await openSettings(panel)
    const toggling = await drawnAfter(() => panel.toggle({ label: 'Уведомления о мержах' }))
    await writes.written(1)
    assert.equal(panel.valueOf({ label: 'Уведомления о мержах' }), false, 'пока идёт запись, переключатель вернулся')
    const typing = await drawnAfter(() => panel.type({ label: 'Интервал проверки очереди, минут' }, '0'))
    assert.equal(panel.valueOf({ label: 'Интервал проверки очереди, минут' }), '50')

    // The switch's write is refused: at once the refusal and the saved value of the switch; «50» stays on its way.
    const refusal = [{ tone: 'danger', text: 'Не удалось сохранить: хранилище плагина недоступно' }]
    await redrawnAfter(() => writes.held[0]?.refuse('хранилище плагина недоступно'))
    await writes.written(2)
    assert.equal(panel.valueOf({ label: 'Уведомления о мержах' }), true)
    assert.equal(panel.valueOf({ label: 'Интервал проверки очереди, минут' }), '50')
    assert.deepEqual(callouts(panel), refusal)

    // The interval's write ends: refused — «5» again; saved — «50», and the switch's refusal is not covered by
    // «Сохранено.».
    await redrawnAfter(() => {
      if (intervalRefused) writes.held[1]?.refuse('хранилище плагина недоступно')
      else writes.held[1]?.land()
    })
    await toggling.acting
    await typing.acting
    const interval = intervalRefused ? '5' : '50'
    assert.deepEqual(shown(panel, 'ru'), { language: 'ru', interval, notifications: true, coordinator: true })
    assert.deepEqual(callouts(panel), refusal)
    assert.deepEqual(writes.store, intervalRefused ? RU : { ...RU, [SETTING_KEYS.queueCheckInterval]: 50 })
    assertClean(panel)
  }
})

test('Настройки: English → Русский при выключенных переключателях — строка русского кадра о них; English → «Saved.» во всех четырёх английских кадрах', async () => {
  const cases: [boolean, boolean, string][] = [
    [false, true, NOTIFICATIONS_OFF_RU], // nastroyki-english-uv → nastroyki-uvedomleniya-vykl
    [true, false, COORDINATOR_OFF_RU], // nastroyki-english-ko → nastroyki-koordinator-vykl
    [false, false, BOTH_OFF_RU], // nastroyki-english-oba → nastroyki-oba-vykl
    [true, true, SAVED_RU], // nastroyki-english → nastroyki-sohraneno
  ]
  for (const [notifications, coordinator, line] of cases) {
    const host = hostWith({
      settings: {
        [LANGUAGE_SETTING]: 'en',
        [SETTING_KEYS.mergeNotifications]: notifications,
        [SETTING_KEYS.coordinator]: coordinator,
      },
    })
    const panel = await open(host)
    await openSettings(panel, 'en')
    await panel.select({ label: 'Interface language' }, 'ru')
    assert.deepEqual(callouts(panel), [{ tone: 'success', text: line }], `${notifications}, ${coordinator}`)
    assert.deepEqual(shown(panel, 'ru'), { language: 'ru', interval: '5', notifications, coordinator })
    await panel.select({ label: 'Язык интерфейса' }, 'en')
    assert.deepEqual(callouts(panel), [{ tone: 'success', text: 'Saved.' }], `${notifications}, ${coordinator}: English`)
    assertClean(panel)
  }
})

test('Настройки: настройки не заданы → English, интервал 5 минут, уведомления о мержах и координатор включены; манифест объявляет те же значения по умолчанию', async () => {
  const panel = await open(hostWith())
  await openSettings(panel, 'en')
  assert.deepEqual(shown(panel, 'en'), { language: 'en', interval: '5', notifications: true, coordinator: true })
  assert.deepEqual(callouts(panel), [])
  assertClean(panel)

  assert.deepEqual(DEFAULT_SETTINGS, { language: 'en', queueCheckInterval: 5, mergeNotifications: true, coordinator: true })
  // Orca reads a declared setting as its default until the person changes it: the same defaults as the panel's.
  const declaredSettings = manifest.contributes.settings as { key: string; [field: string]: unknown }[]
  const byKey = (key: string) => declaredSettings.find((setting) => setting.key === key)
  assert.deepEqual(
    declaredSettings.map((setting) => setting.key),
    [SETTING_KEYS.language, SETTING_KEYS.queueCheckInterval, SETTING_KEYS.mergeNotifications, SETTING_KEYS.coordinator],
  )
  assert.equal(byKey(SETTING_KEYS.language)?.default, DEFAULT_SETTINGS.language)
  // The manifest, the screen and reading the settings take the same intervals: whole minutes, at least 1, no maximum.
  // The maximum is only the technical top: the largest whole number a JSON number holds exactly.
  const declaredInterval = byKey(SETTING_KEYS.queueCheckInterval)
  assert.deepEqual(
    [declaredInterval?.type, declaredInterval?.minimum, declaredInterval?.maximum],
    ['integer', MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES],
  )
  assert.equal(MAX_INTERVAL_MINUTES, Number.MAX_SAFE_INTEGER)
  assert.equal(byKey(SETTING_KEYS.queueCheckInterval)?.default, DEFAULT_SETTINGS.queueCheckInterval)
  for (const name of ['mergeNotifications', 'coordinator'] as const) {
    assert.equal(byKey(SETTING_KEYS[name])?.type, 'boolean', name)
    assert.equal(byKey(SETTING_KEYS[name])?.default, DEFAULT_SETTINGS[name], name)
  }

  // A value that is not set, or not valid, reads as its default — on the panel and in the worker alike (readSettings).
  assert.deepEqual(parseSettings({}), DEFAULT_SETTINGS)
  assert.deepEqual(
    parseSettings({
      [SETTING_KEYS.language]: 'de',
      [SETTING_KEYS.queueCheckInterval]: 0,
      [SETTING_KEYS.mergeNotifications]: 'false',
      [SETTING_KEYS.coordinator]: null,
    }),
    DEFAULT_SETTINGS,
  )
  for (const interval of [-5, 0, 1.5, '10', Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 3, Number.POSITIVE_INFINITY]) {
    assert.equal(parseSettings({ [SETTING_KEYS.queueCheckInterval]: interval }).queueCheckInterval, 5, String(interval))
  }
  for (const interval of [1, 1441, 2880, 525600, Number.MAX_SAFE_INTEGER]) {
    assert.equal(parseSettings({ [SETTING_KEYS.queueCheckInterval]: interval }).queueCheckInterval, interval)
  }
  const odd = await open(
    hostWith({
      settings: {
        [SETTING_KEYS.language]: 'ru',
        [SETTING_KEYS.queueCheckInterval]: 15,
        [SETTING_KEYS.mergeNotifications]: false,
        [SETTING_KEYS.coordinator]: 'yes',
      },
    }),
  )
  assert.deepEqual(await readSettings(settings), {
    language: 'ru',
    queueCheckInterval: 15,
    mergeNotifications: false,
    coordinator: true,
  })
  await openSettings(odd)
  assert.deepEqual(shown(odd, 'ru'), { language: 'ru', interval: '15', notifications: false, coordinator: true })
})

test('Настройки: настройку изменили в настройках Orca → экран «Настройки» сразу показывает новое значение', async () => {
  const panel = await open(hostWith({ settings: RU }))
  await openSettings(panel)
  await settings.set(SETTING_KEYS.coordinator, false)
  await settings.set(SETTING_KEYS.queueCheckInterval, 20)
  await panel.settled()
  assert.deepEqual(shown(panel, 'ru'), { language: 'ru', interval: '20', notifications: true, coordinator: false })
  await settings.set(LANGUAGE_SETTING, 'en')
  await panel.settled()
  assert.deepEqual(headings(panel), ['Settings'])
  assert.deepEqual(shown(panel, 'en'), { language: 'en', interval: '20', notifications: true, coordinator: false })
  assertClean(panel)
})

test('Настройки: экран и его состояния — тексты только из каталога строк, ни одного элемента с шириной в пикселях', async () => {
  for (const language of ['en', 'ru'] as const) {
    const drawn: [string, ReturnType<TestPanel['tree']>][] = []
    const labels = LABELS[language]
    const panel = await open(hostWith({ settings: { [LANGUAGE_SETTING]: language }, projects: [SHOP, BLOG] }))
    await openSettings(panel, language)
    drawn.push(['с данными', panel.tree()])
    await panel.toggle({ label: labels.notifications })
    drawn.push(['сохранено — уведомления выключены', panel.tree()])
    await panel.toggle({ label: labels.coordinator })
    drawn.push(['сохранено — оба выключены', panel.tree()])
    await panel.type({ label: labels.interval }, '0', { replace: true })
    drawn.push(['интервал с ошибкой', panel.tree()])
    // The file buttons wrap, as every row of buttons does.
    const fileRows = panel.findAll({ type: 'Row' }).filter((row) => row.text.includes('.agent-queue.json'))
    assert.deepEqual(fileRows.map((row) => row.props.wrap), [true])

    const failing = await open(
      hostWith({
        settings: { [LANGUAGE_SETTING]: language },
        projects: [],
        results: {
          'settings.set': () => {
            throw hostError('action_failed', 'storage is unavailable')
          },
        },
      }),
    )
    await openSettings(failing, language)
    await failing.toggle({ label: labels.notifications })
    drawn.push(['ошибка, нет подключённых проектов', failing.tree()])
    assertFromCatalog(failing, language, ['storage is unavailable'], 'ошибка')

    for (const [where, tree] of drawn) {
      assert.ok(tree, `${where}: экран ничего не нарисовал`)
      assert.deepEqual(pixelWidths(tree), [], `${language}, ${where}: ширина в пикселях`)
      const data = [SHOP.name, BLOG.name, 'storage is unavailable']
      assert.deepEqual(textsNotFromCatalog(textsIn(tree), language, data), [], `${language}, ${where}`)
    }
  }
})
