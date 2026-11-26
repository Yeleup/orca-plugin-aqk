// The panel's frame (task panel-shell): the screens, «Назад», the project selector, the common loading and error states
// and the interface languages. Orca's mock host stands in for Orca and, where a test says so, for the worker; the
// project names are invented.
import { settings } from 'orca'
import { afterEach, assert, hostError, mockHost, mount, mountWorker, test, type TestPanel } from 'orca/testing'
import { catalogs, format, LANGUAGE_SETTING, type Language, type MessageKey } from './i18n/catalog'
import * as panelModule from './panel'
import type { Project } from './protocol'
import { openScreen, SCREENS } from './ui/navigation'
import * as worker from './worker'

type ProjectsAnswer = { projects: Project[] }

const SHOP: Project = { id: 'shop-demo', name: 'shop-demo' }
const BLOG: Project = { id: 'blog-demo', name: 'blog-demo' }

let view: TestPanel | undefined
afterEach(async () => {
  await view?.unmount()
  view = undefined
})

/** Mounts the panel over a mock host: the worker answers `projects.list` with `projects` (or by `list`). */
async function open(options: {
  language?: Language
  projects?: Project[]
  list?: () => ProjectsAnswer | Promise<ProjectsAnswer>
} = {}): Promise<TestPanel> {
  const projects = options.projects ?? [SHOP]
  const host = mockHost({
    settings: options.language ? { [LANGUAGE_SETTING]: options.language } : {},
    requests: { 'projects.list': options.list ?? (() => ({ projects })) },
  })
  return show(host)
}

/** Mounts the panel, after closing the one a test opened before. */
async function show(host: ReturnType<typeof mockHost>, theme?: 'light' | 'dark'): Promise<TestPanel> {
  await view?.unmount()
  view = undefined
  view = await mount(panelModule, { host, theme })
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
    assert.deepEqual(buttons(panel), [], `на экране «${screen}» осталось меню «Очереди»`)
    assert.ok(panel.find({ type: 'Link', text: 'Назад' }), `на экране «${screen}» нет «Назад»`)

    await panel.press({ type: 'Link', text: 'Назад' })
    assert.deepEqual(headings(panel), ['Agent Queue'], `«Назад» с «${screen}» не вернул к «Очереди»`)
    assert.deepEqual(buttons(panel), MENU_RU)
  }
  // The project list was read once, when the panel opened: moving between screens asks nothing more.
  assert.deepEqual(requests(panel), [{ name: 'projects.list' }])
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
  const texts = Object.values(catalogs[language])
  const fromCatalog = (text: string) =>
    texts.some((template) => {
      const pattern = template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{\w+\}/g, '.+')
      return new RegExp(`^${pattern}$`, 's').test(text)
    })
  const seen: string[] = []
  const walk = (node: unknown) => {
    if (typeof node === 'string') {
      seen.push(node)
      return
    }
    if (!node || typeof node !== 'object') return
    const { props, children } = node as { props?: Record<string, unknown>; children?: unknown[] }
    for (const name of ['label', 'title', 'description', 'placeholder', 'tooltip']) {
      if (typeof props?.[name] === 'string') seen.push(props[name] as string)
    }
    if (Array.isArray(props?.options)) {
      for (const option of props.options as { label: string }[]) seen.push(option.label)
    }
    for (const child of children ?? []) walk(child)
  }
  walk(panel.tree())
  assert.ok(seen.length > 0, `${where}: нет текстов`)
  for (const text of seen) {
    assert.ok(data.includes(text) || fromCatalog(text), `${where} (${language}): «${text}» не из каталога строк`)
  }
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
    let loading = false
    const failing = await open({
      language,
      list: async () => {
        calls++
        if (calls === 1) throw hostError('action_failed', 'worker stopped')
        // The retry: the panel draws its loading rows while the worker has not answered.
        await new Promise((resolve) => setTimeout(resolve, 0))
        assertTextsFromCatalog(failing, language, [], 'загрузка')
        loading = true
        return { projects: [SHOP] }
      },
    })
    assertTextsFromCatalog(failing, language, ['worker stopped'], 'ошибка')
    await failing.press({ type: 'Button', text: format(language, 'state.retry') })
    assert.ok(loading, 'повтор не дошёл до воркера')
  }
})

test('Каркас панели: ответ воркера на plugin.request с ошибкой → экран в состоянии ошибки с «Повторить»; нажатие повторяет запрос', async () => {
  let calls = 0
  let duringRetry: string[] = []
  const panel = await open({
    language: 'ru',
    list: async () => {
      calls++
      if (calls === 1) throw hostError('action_failed', 'каталог данных недоступен')
      // While the worker has not answered the retry, the screen shows its loading rows.
      await new Promise((resolve) => setTimeout(resolve, 0))
      duringRetry = panel.summary()
      return { projects: [SHOP, BLOG] }
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

  await panel.press({ type: 'Button', text: 'Повторить' })
  assert.deepEqual(requests(panel), [{ name: 'projects.list' }, { name: 'projects.list' }], '«Повторить» не повторил запрос')
  assert.ok(
    duringRetry.filter((line) => line.startsWith('Skeleton')).length >= 3,
    `при повторе нет заготовок строк: ${JSON.stringify(duringRetry)}`,
  )
  assert.ok(!duringRetry.some((line) => line.startsWith('Callout')), 'при повторе осталась прежняя ошибка')

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

test('Каркас панели: панель с настоящим воркером — запрос projects.list доходит до воркера, «Очередь» без проектов показывает меню', async () => {
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

test('Каркас панели: светлая и тёмная тема Orca — панель рисуется без ошибок и отказов', async () => {
  for (const theme of ['light', 'dark'] as const) {
    const panel = await show(mockHost({ requests: { 'projects.list': { projects: [SHOP] } } }), theme)
    assert.deepEqual(headings(panel), ['Agent Queue'], theme)
    assert.deepEqual(buttons(panel), ['Project check', 'Start MVP', 'Settings', 'Connect project'], theme)
    assertClean(panel)
  }
})
