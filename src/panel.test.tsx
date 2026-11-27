// The panel's frame (task panel-shell): the screens, «Назад», the project selector, the common loading and error states,
// the interface languages and a layout not built for one width. The panel under test is the module the manifest's
// panel names as its entry, as Orca opens it from the right sidebar. Orca's mock host stands in for Orca and, where a
// test says so, for the worker; the project names are invented.
import { settings } from 'orca'
import {
  afterEach,
  assert,
  hostError,
  mockHost,
  mount,
  mountWorker,
  test,
  type TestPanel,
  type TestQuery,
  type TreeSnapshot,
} from 'orca/testing'
import manifest from '../orca-plugin.json' with { type: 'json' }
import { catalogs, format, LANGUAGE_SETTING, type Language, type MessageKey } from './i18n/catalog'
import type { Project } from './protocol'
import { loadLanguage } from './ui/language'
import { openScreen, SCREENS } from './ui/navigation'
import { pixelWidths, textsIn, textsNotFromCatalog } from './testing/panel-tree'
import { withTemporaryHome } from './testing/temporary-home'
import * as worker from './worker'

// The panel Orca opens from its right sidebar: the entry of the manifest's components panel `agent-queue`.
const declared = manifest.contributes.panels.find((contribution) => contribution.id === 'agent-queue')
if (!declared || declared.ui !== 'components') {
  throw new Error('orca-plugin.json: no components panel agent-queue in contributes.panels')
}
const panelModule = (await import(`../${declared.entry}`)) as typeof import('./panel')
const DeclaredPanel = panelModule.default

// Every draw of the panel lets the waiters of `nextDraw()` go on. A draw is synchronous — the panel computes its tree and
// Orca's test runtime takes it at once — so a test that awaits `nextDraw()` sees exactly what the panel drew, with no
// timer. The panel itself is the declared module, unchanged, inside this observer.
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

/** An answer of the fake worker or host that the test holds back and then lets through with `open`. */
type Gate<T> = { promise: Promise<T>; open(value: T): void }
function gate<T>(): Gate<T> {
  let open: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

/**
 * Presses `target` while the fake worker holds `held` back: `between()` looks at the panel as it is drawn after the
 * press and before the answer, then the answer goes through and the panel settles. If the panel drew nothing before
 * the answer, nothing is left to run and Node's test runner fails the test.
 */
async function pressWhileWaiting<T>(
  panel: TestPanel,
  target: TestQuery,
  held: Gate<T>,
  answer: T,
  between: () => void,
): Promise<void> {
  const drawn = nextDraw()
  const pressing = panel.press(target)
  await drawn
  between()
  held.open(answer)
  await pressing
}

type ProjectsAnswer = { projects: Project[] }

const SHOP: Project = { id: 'shop-demo', hostId: 'local', name: 'shop-demo' }
const BLOG: Project = { id: 'blog-demo', hostId: 'local', name: 'blog-demo' }

let view: TestPanel | undefined
afterEach(async () => {
  await view?.unmount()
  view = undefined
})

/** Mounts the panel over a mock host: the worker answers `projects.list` with `projects` (or by `list`), and the
 *  wizard «Подключение проекта», opened, finds no project to connect. */
async function open(options: {
  language?: Language
  projects?: Project[]
  list?: () => ProjectsAnswer | Promise<ProjectsAnswer>
} = {}): Promise<TestPanel> {
  const projects = options.projects ?? [SHOP]
  const host = mockHost({
    settings: options.language ? { [LANGUAGE_SETTING]: options.language } : {},
    requests: { 'projects.list': options.list ?? (() => ({ projects })), 'connect.projects': { projects: [] } },
  })
  return show(host)
}

/** Mounts the panel, after closing the one a test opened before. */
async function show(
  host: ReturnType<typeof mockHost>,
  theme?: 'light' | 'dark',
  target: Parameters<typeof mount>[0] = observedPanel,
): Promise<TestPanel> {
  await view?.unmount()
  view = undefined
  view = await mount(target, { host, theme })
  return view
}

function headings(panel: TestPanel): string[] {
  return panel.findAll({ type: 'Heading' }).map((heading) => heading.text)
}

function buttons(panel: TestPanel): string[] {
  return panel.findAll({ type: 'Button' }).map((button) => button.text)
}

/** The panel's requests to the worker, in order. */
function requests(panel: TestPanel): unknown[] {
  return panel.host.callsOf('plugin.request')
}

function skeletons(panel: TestPanel): number {
  return panel.findAll({ type: 'Skeleton' }).length
}

function assertClean(panel: TestPanel): void {
  assert.deepEqual(panel.errors, [])
  assert.deepEqual(panel.warnings, [])
  assert.deepEqual(panel.refusals, [])
}

const MENU_RU = ['Проверка проекта', 'Начать MVP', 'Настройки', 'Подключить проект']

test('Каркас панели: панель открывается на «Очереди» с заголовком «Agent Queue» и меню «Проверка проекта», «Начать MVP», «Настройки», «Подключить проект»; каждый пункт открывает свой экран, «Назад» на нём возвращает к «Очереди»', async () => {
  const panel = await open({ language: 'ru' })
  assert.deepEqual(headings(panel), ['Agent Queue'])
  assert.deepEqual(buttons(panel), MENU_RU)
  assert.equal(panel.find({ type: 'Link', text: 'Назад' }), null, '«Назад» на «Очереди»')

  const opens = [
    ['Проверка проекта', 'Проверка проекта'],
    ['Начать MVP', 'Старт MVP'],
    ['Настройки', 'Настройки'],
    ['Подключить проект', 'Подключение проекта'],
  ]
  for (const [item, screen] of opens) {
    await panel.press({ type: 'Button', text: item })
    assert.deepEqual(headings(panel), [screen], `«${item}» открывает не «${screen}»`)
    const menuLeft = buttons(panel).filter((label) => MENU_RU.includes(label))
    assert.deepEqual(menuLeft, [], `на экране «${screen}» осталось меню «Очереди»`)
    assert.ok(panel.find({ type: 'Link', text: 'Назад' }), `на экране «${screen}» нет «Назад»`)

    await panel.press({ type: 'Link', text: 'Назад' })
    assert.deepEqual(headings(panel), ['Agent Queue'], `«Назад» с «${screen}» не вернул к «Очереди»`)
    assert.deepEqual(buttons(panel), MENU_RU)
  }
  // The project list was read once, when the panel opened: moving between screens asks nothing more of it. Opening
  // «Подключение проекта» asks for the projects it may connect.
  assert.deepEqual(requests(panel), [{ name: 'projects.list' }, { name: 'connect.projects' }])
  assertClean(panel)
})

test('Каркас панели: у каждого из девяти экранов ТЗ своя заготовка с заголовком, на каждом, кроме «Очереди», — «Назад» к «Очереди»', async () => {
  const titles = {
    queue: 'Agent Queue',
    task: 'Задача',
    newTask: 'Новая задача',
    answer: 'Ответ на блокировку',
    connect: 'Подключение проекта',
    doctor: 'Проверка проекта',
    settings: 'Настройки',
    mvp: 'MVP',
    mvpStart: 'Старт MVP',
  }
  assert.deepEqual([...SCREENS].sort(), Object.keys(titles).sort())
  const panel = await open({ language: 'ru' })
  for (const screen of SCREENS) {
    openScreen(screen)
    await panel.settled()
    assert.deepEqual(headings(panel), [titles[screen]], `экран ${screen}`)
    if (screen === 'queue') {
      assert.equal(panel.find({ type: 'Link', text: 'Назад' }), null)
      continue
    }
    await panel.press({ type: 'Link', text: 'Назад' })
    assert.deepEqual(headings(panel), ['Agent Queue'], `«Назад» с экрана ${screen}`)
    assert.deepEqual(buttons(panel), MENU_RU)
  }
  assertClean(panel)
})

test('Каркас панели: язык интерфейса не задан → тексты панели на английском; «Русский» → на русском', async () => {
  const english = await open()
  assert.deepEqual(headings(english), ['Agent Queue'])
  assert.deepEqual(buttons(english), ['Project check', 'Start MVP', 'Settings', 'Connect project'])
  assert.equal(english.find({ role: 'combobox' })?.label, 'Project')
  await english.press({ type: 'Button', text: 'Settings' })
  assert.deepEqual(headings(english), ['Settings'])
  assert.ok(english.find({ type: 'Link', text: 'Back' }))
  assertClean(english)

  const russian = await open({ language: 'ru' })
  assert.deepEqual(headings(russian), ['Agent Queue'])
  assert.deepEqual(buttons(russian), MENU_RU)
  assert.equal(russian.find({ role: 'combobox' })?.label, 'Проект')
  await russian.press({ type: 'Button', text: 'Настройки' })
  assert.deepEqual(headings(russian), ['Настройки'])
  assert.ok(russian.find({ type: 'Link', text: 'Назад' }))
  assertClean(russian)
})

test('Каркас панели: язык интерфейса меняется, пока панель открыта → панель сразу на новом языке, на том же экране', async () => {
  const panel = await open()
  await panel.press({ type: 'Button', text: 'Connect project' })
  assert.deepEqual(headings(panel), ['Connect project'])

  await settings.set(LANGUAGE_SETTING, 'ru')
  await panel.settled()
  assert.deepEqual(headings(panel), ['Подключение проекта'])
  await panel.press({ type: 'Link', text: 'Назад' })
  assert.deepEqual(buttons(panel), MENU_RU)

  await settings.set(LANGUAGE_SETTING, 'en')
  await panel.settled()
  assert.deepEqual(buttons(panel), ['Project check', 'Start MVP', 'Settings', 'Connect project'])
  assertClean(panel)
})

test('Каркас панели: у каждого ключа английского каталога строк есть русский, и наоборот', () => {
  const keys = (language: Language) => Object.keys(catalogs[language]).sort()
  assert.deepEqual(keys('ru'), keys('en'))
  const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort()
  for (const key of keys('en') as MessageKey[]) {
    for (const language of ['en', 'ru'] as const) {
      assert.ok(catalogs[language][key].trim(), `${language}: пустая строка ${key}`)
    }
    assert.deepEqual(placeholders(catalogs.ru[key]), placeholders(catalogs.en[key]), `подстановки ${key}`)
  }
})

// Every word the panel draws is a text of the current language's catalog (a `{name}` part is a value the screen puts
// in), apart from data: the names of projects.
function assertTextsFromCatalog(panel: TestPanel, language: Language, data: readonly string[], where: string): void {
  const seen = textsIn(panel.tree())
  assert.ok(seen.length > 0, `${where}: нет текстов`)
  assert.deepEqual(textsNotFromCatalog(seen, language, data), [], `${where} (${language}): не из каталога строк`)
}

test('Каркас панели: ни одной строки экрана мимо каталога — на каждом экране, в загрузке и в ошибке, на английском и на русском', async () => {
  for (const language of ['en', 'ru'] as const) {
    const panel = await open({ language, projects: [SHOP, BLOG] })
    for (const screen of SCREENS) {
      openScreen(screen)
      await panel.settled()
      assertTextsFromCatalog(panel, language, [SHOP.name, BLOG.name], `экран ${screen}`)
    }

    let calls = 0
    const retry = gate<ProjectsAnswer>()
    const failing = await open({
      language,
      list: () => {
        calls++
        if (calls === 1) throw hostError('action_failed', 'worker stopped')
        return retry.promise
      },
    })
    assertTextsFromCatalog(failing, language, ['worker stopped'], 'ошибка')
    // The retry: while the worker has not answered, the panel shows its loading rows.
    await pressWhileWaiting(failing, { type: 'Button', text: format(language, 'state.retry') }, retry, { projects: [SHOP] }, () => {
      assert.ok(skeletons(failing) > 0, `${language}: при повторе нет заготовок строк`)
      assertTextsFromCatalog(failing, language, [], 'загрузка')
    })
    assert.equal(calls, 2, 'повтор не дошёл до воркера')
  }
})

test('Каркас панели: ответ воркера на plugin.request с ошибкой → экран в состоянии ошибки с «Повторить»; нажатие повторяет запрос', async () => {
  let calls = 0
  const retry = gate<ProjectsAnswer>()
  const panel = await open({
    language: 'ru',
    list: () => {
      calls++
      if (calls === 1) throw hostError('action_failed', 'каталог данных недоступен')
      return retry.promise
    },
  })

  const error = panel.find({ type: 'Callout' })
  assert.ok(error, 'нет состояния ошибки')
  assert.equal(error.props.tone, 'danger')
  assert.equal(error.label, 'Ошибка')
  assert.match(error.text, /Не удалось прочитать подключённые проекты: каталог данных недоступен/)
  assert.deepEqual(buttons(panel), ['Повторить'], 'в ошибке — только «Повторить», без меню')
  assert.equal(panel.find({ role: 'combobox' }), null)
  assert.deepEqual(requests(panel), [{ name: 'projects.list' }])

  // «Повторить»: the same request goes to the worker again, and until it answers the screen shows its loading rows
  // instead of the old error.
  await pressWhileWaiting(panel, { type: 'Button', text: 'Повторить' }, retry, { projects: [SHOP, BLOG] }, () => {
    assert.deepEqual(requests(panel), [{ name: 'projects.list' }, { name: 'projects.list' }], '«Повторить» не повторил запрос')
    const drawn = panel.summary()
    assert.ok(drawn.filter((line) => line.startsWith('Skeleton')).length >= 3, `при повторе нет заготовок строк: ${JSON.stringify(drawn)}`)
    assert.ok(!drawn.some((line) => line.startsWith('Callout')), 'при повторе осталась прежняя ошибка')
    assert.deepEqual(buttons(panel), [], 'при повторе остались кнопки')
  })
  assert.equal(calls, 2)

  assert.equal(panel.find({ type: 'Callout' }), null, 'ошибка осталась после удачного повтора')
  assert.deepEqual(buttons(panel), MENU_RU)
  assert.equal(panel.valueOf({ role: 'combobox' }), SHOP.id)
  assertClean(panel)
})

test('Каркас панели: повтор снова с ошибкой → экран остаётся в ошибке с новым текстом и «Повторить»', async () => {
  const answers = ['первая ошибка', 'вторая ошибка']
  const panel = await open({
    language: 'ru',
    list: () => {
      throw hostError('action_failed', answers.shift() ?? 'ещё ошибка')
    },
  })
  assert.match(panel.find({ type: 'Callout' })?.text ?? '', /первая ошибка/)
  await panel.press({ type: 'Button', text: 'Повторить' })
  assert.match(panel.find({ type: 'Callout' })?.text ?? '', /вторая ошибка/)
  assert.deepEqual(buttons(panel), ['Повторить'])
  assert.equal(requests(panel).length, 2)
})

test('Каркас панели: выбор проекта — подключённые проекты от воркера; выбранный остаётся, пропавший сменяется первым', async () => {
  const panel = await open({ language: 'ru', projects: [] })
  assert.equal(panel.find({ role: 'combobox' }), null, 'выбор проекта без подключённых проектов')
  assert.deepEqual(buttons(panel), MENU_RU)

  // The worker tells open panels that the connected projects changed.
  await panel.post('projects.changed', { projects: [SHOP, BLOG] })
  const selector = panel.find({ role: 'combobox' })
  assert.ok(selector, 'нет выбора проекта')
  assert.equal(selector.label, 'Проект')
  assert.deepEqual(selector.props.options, [
    { value: SHOP.id, label: SHOP.name },
    { value: BLOG.id, label: BLOG.name },
  ])
  assert.equal(panel.valueOf({ role: 'combobox' }), SHOP.id)

  await panel.select({ role: 'combobox' }, BLOG.id)
  assert.equal(panel.valueOf({ role: 'combobox' }), BLOG.id)
  assert.equal(panel.persisted.plugin.selectedProject, BLOG.id)
  await panel.press({ type: 'Button', text: 'Настройки' })
  await panel.press({ type: 'Link', text: 'Назад' })
  assert.equal(panel.valueOf({ role: 'combobox' }), BLOG.id, 'выбор проекта потерялся после перехода')

  await panel.post('projects.changed', { projects: [SHOP] })
  assert.equal(panel.valueOf({ role: 'combobox' }), SHOP.id)
  assertClean(panel)
})

// The real worker keeps its data directory and coordinator id in a temporary home (src/testing/temporary-home.ts).
test('Каркас панели: панель с настоящим воркером — запрос projects.list доходит до воркера, «Очередь» без проектов показывает меню', async () => {
  await withTemporaryHome(async () => {
    const running = await mountWorker(worker)
    const asked: unknown[] = []
    const host = mockHost({
      requests: {
        'projects.list': async (input) => {
          asked.push(input ?? null)
          return running.request('projects.list', input)
        },
      },
    })
    const shown = await show(host)
    assert.deepEqual(asked, [null])
    assert.deepEqual(headings(shown), ['Agent Queue'])
    assert.equal(shown.find({ role: 'combobox' }), null)
    assert.deepEqual(buttons(shown), ['Project check', 'Start MVP', 'Settings', 'Connect project'])
    assertClean(shown)
    assert.deepEqual(running.refusals, [])
    await running.deactivate()
  })
})

test('Каркас панели: светлая и тёмная тема Orca — панель рисуется без ошибок и отказов', async () => {
  for (const theme of ['light', 'dark'] as const) {
    const panel = await show(mockHost({ requests: { 'projects.list': { projects: [SHOP] } } }), theme)
    assert.deepEqual(headings(panel), ['Agent Queue'], theme)
    assert.deepEqual(buttons(panel), ['Project check', 'Start MVP', 'Settings', 'Connect project'], theme)
    assertClean(panel)
  }
})

/** The rows of a drawn tree that hold all the buttons `labels` (the menu of «Очередь»). */
function rowsHolding(tree: TreeSnapshot | string | null, labels: readonly string[]): TreeSnapshot[] {
  if (tree === null || typeof tree === 'string') return []
  const children = tree.children ?? []
  const buttons = children
    .filter((child): child is TreeSnapshot => typeof child !== 'string' && child.type === 'Button')
    .map((button) => textsIn(button).join(' '))
  const here = tree.type === 'Row' && labels.every((label) => buttons.includes(label)) ? [tree] : []
  return [...here, ...children.flatMap((child) => rowsHolding(child, labels))]
}

test('Каркас панели: экраны не под одну ширину — ни у одного элемента нет ширины в пикселях (width, minWidth), ряд меню «Очереди» переносится', async () => {
  const drawn: [string, TreeSnapshot | string | null][] = []

  // Before the language is read: the panel component on its own, whose language nobody reads.
  const blank = await show(mockHost({ requests: { 'projects.list': { projects: [SHOP] } } }), undefined, () => <DeclaredPanel />)
  drawn.push(['до чтения языка', blank.tree()])

  const panel = await open({ language: 'ru', projects: [SHOP, BLOG] })
  for (const screen of SCREENS) {
    openScreen(screen)
    await panel.settled()
    drawn.push([`экран ${screen}`, panel.tree()])
  }
  openScreen('queue')
  await panel.settled()
  const menus = rowsHolding(panel.tree(), MENU_RU)
  assert.equal(menus.length, 1, `ряд меню «Очереди»: ${menus.length}`)
  assert.equal(menus[0]?.props?.wrap, true, 'ряд меню «Очереди» не переносится (wrap)')

  let calls = 0
  const retry = gate<ProjectsAnswer>()
  const failing = await open({
    language: 'ru',
    list: () => {
      calls++
      if (calls === 1) throw hostError('action_failed', 'worker stopped')
      return retry.promise
    },
  })
  drawn.push(['ошибка', failing.tree()])
  await pressWhileWaiting(failing, { type: 'Button', text: 'Повторить' }, retry, { projects: [SHOP] }, () => {
    assert.ok(skeletons(failing) > 0, 'при повторе нет заготовок строк')
    drawn.push(['загрузка', failing.tree()])
  })

  assert.deepEqual(drawn.map(([where]) => where), [
    'до чтения языка',
    ...SCREENS.map((screen) => `экран ${screen}`),
    'ошибка',
    'загрузка',
  ])
  for (const [where, tree] of drawn) {
    assert.ok(tree, `${where}: панель ничего не нарисовала`)
    assert.deepEqual(pixelWidths(tree), [], `${where}: ширина в пикселях`)
  }
})

test('Каркас панели: пока язык интерфейса не прочитан — заготовки строк без имени и без статуса, ни слова на языке Orca; прочитан «Русский» — заготовки с именем из русского каталога', async () => {
  const languageRead = gate<{ settings: Record<string, string> }>()
  const host = mockHost({
    results: { 'settings.get': () => languageRead.promise },
    requests: { 'projects.list': { projects: [SHOP] } },
  })
  // The panel's first draw: the panel component on its own, before anyone reads the language.
  const panel = await show(host, undefined, () => <DeclaredPanel />)
  const assertBlank = (when: string) => {
    assert.equal(skeletons(panel), 0, `${when}: Skeleton — статус с именем на языке Orca`)
    assert.deepEqual(textsIn(panel.tree()), [], `${when}: тексты до чтения языка`)
    assert.ok(panel.findAll({ type: 'Box' }).length >= 5, `${when}: нет заготовок строк`)
  }
  assertBlank('до чтения')

  // The read the panel's setup starts; Orca has not answered it yet.
  const reading = loadLanguage()
  assert.equal(host.callsOf('settings.get').length, 1)
  assertBlank('пока настройка не ответила')

  languageRead.open({ settings: { [LANGUAGE_SETTING]: 'ru' } })
  await reading
  await panel.settled()
  assert.deepEqual(headings(panel), ['Agent Queue'])
  const rows = panel.findAll({ type: 'Skeleton' })
  assert.ok(rows.length >= 3, 'после чтения языка нет заготовок строк')
  assert.deepEqual([...new Set(rows.map((row) => row.props.label))], ['Загрузка…'])
  assertTextsFromCatalog(panel, 'ru', [], 'после чтения языка')
  assertClean(panel)
})
