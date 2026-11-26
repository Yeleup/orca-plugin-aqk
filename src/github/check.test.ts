// The check before a write to GitHub and the plugin's mask, on texts built of segments. All values are invented: the
// address, the phone number, the token-shaped strings (not real keys) and the customer id of the patterns.
import { assert, test } from 'orca/testing'
import {
  checkContext,
  checkText,
  field,
  formatDuration,
  postMergeStepText,
  savedWorkText,
  type GitHubText,
  type ProjectGitHubSettings,
} from './check'
import { BUILT_IN_RULES, CheckError, compileMask, HIDDEN } from './mask'

const COORDINATOR = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const OPERATION = '9b8c7d6e-1a2b-4c3d-9e8f-7a6b5c4d3e2f'
const SHA = '0123456789abcdef0123456789abcdef01234567'
const TIME = '2026-01-15T09:30:00.000Z'
// Token-shaped values are put together from parts when the test runs: no literal in the source looks like a secret to
// a scanner (GitHub's push protection), and none is a real key.
const shaped = (...parts: string[]) => parts.join('')
const TOKEN = shaped('ghp', '_TESTONLYnotarealtoken0000000000000000')

test('маска заменяет на «[скрыто]» адрес почты, номер телефона, строку вида токена и значение по шаблону запрещённых данных; путь файла, на который срабатывает маска, — «[скрыто]»; поля координатора фиксированного вида (номера, SHA, время, id) не меняются', () => {
  // Patterns of the settings that would match the coordinator fields too: a SHA, a date, a coordinator id, an issue
  // number, an exit code. Those fields stay as they are; the same values in plain text are hidden.
  const settings: ProjectGitHubSettings = {
    language: 'ru',
    forbiddenPatterns: ['CUST-\\d{6}', '[0-9a-f]{40}', '2026-01-15', '3f2a1b4c', '#7\\b', '\\b42\\b'],
  }
  const diff = { base: [], head: ['src/clients/CUST-424242/orders.ts', 'src/cart.ts'] }
  const text: GitHubText = [
    'Почта avery@example.com, телефон +1 555 010 0199, токен ',
    TOKEN,
    ', клиент CUST-424242.\n',
    'Задача ',
    field.issue(7),
    ', PR ',
    field.pr(42),
    ', SHA ',
    field.sha(SHA),
    ', код ',
    field.exitCode(3221225477),
    ', начало ',
    field.time(TIME),
    ', за ',
    field.duration(125_000),
    ', координатор ',
    field.coordinator(COORDINATOR),
    ', операция ',
    field.operation(OPERATION),
    ', этап ',
    field.stage('review'),
    ', круг ',
    field.round(2),
    ', отсчёт ',
    field.claim(3),
    '.\nФайлы: ',
    field.path('src/clients/CUST-424242/orders.ts', 'head'),
    ' и ',
    field.path('src/cart.ts', 'head'),
    ':',
    field.line(42),
    `.\nВ тексте: ${SHA}, 2026-01-15, #7, 42, 3221225477.`,
  ]
  const checked = checkText(text, checkContext(settings, diff))
  assert.equal(
    checked.text,
    'Почта [скрыто], телефон [скрыто], токен [скрыто], клиент [скрыто].\n' +
      `Задача #7, PR #42, SHA ${SHA}, код 3221225477, начало ${TIME}, за 2 min 5 s, координатор ${COORDINATOR}, ` +
      `операция ${OPERATION}, этап review, круг 2, отсчёт 3.\n` +
      'Файлы: [скрыто] и src/cart.ts:42.\n' +
      'В тексте: [скрыто], [скрыто], [скрыто], [скрыто], [скрыто].',
  )
  assert.equal(checked.hidden, 10)
  assert.deepEqual(
    [...checked.rules].sort(),
    ['email', 'pattern:1', 'pattern:2', 'pattern:3', 'pattern:5', 'pattern:6', 'phone', 'token:github'],
  )
})

test('совпадение маски через несколько частей текста: части текста скрыты, поле координатора между ними — нет, путь — целиком', () => {
  const context = checkContext({ language: 'ru', forbiddenPatterns: ['order-\\d+logs'] }, { base: [], head: ['logs/x.txt'] })
  // An address split around a coordinator field: its text parts are hidden, the count stays.
  assert.equal(checkText(['пишите user', field.count(1), '@example.com'], context).text, 'пишите [скрыто]1[скрыто]')
  // A pattern that runs from the text into a path hides the path whole.
  assert.equal(checkText(['order-12', field.path('logs/x.txt'), '-done'], context).text, '[скрыто][скрыто]-done')
  // Two strings next to each other are one text: a token split between them is still found.
  assert.equal(checkText([shaped('ключ gh', 'p_TESTONLY'), 'notarealtoken0000000000000000 конец'], context).text, `ключ ${HIDDEN} конец`)
})

test('шаблон запрещённых данных — не регулярное выражение → запись отказана с причиной, шаблон не пропущен', () => {
  for (const patterns of [['CUST-\\d{6}', 'CLIENT-(\\d{4}'], ['[a-'], ['\\p{Unknown}'], ['']]) {
    assert.throws(
      () => checkContext({ language: 'en', forbiddenPatterns: patterns }),
      (error) => error instanceof CheckError && error.reason === 'invalid_pattern',
    )
  }
  assert.throws(() => compileMask(['ok', '(']), /forbidden-data pattern 2 is not a valid regular expression/)
  assert.throws(() => postMergeStepText({ number: 1, name: 'deploy' }, 0, { language: 'en', forbiddenPatterns: ['('] }), /pattern 1/)
  // A pattern that matches the empty string hides nothing where it matches nothing else.
  assert.equal(compileMask(['x*']).apply('abc').text, 'abc')
  assert.equal(compileMask(['x*']).apply('axxc').text, `a${HIDDEN}c`)
})

test('путь файла не из проверяемого diff (или не с той стороны diff) → отказ, путь в GitHub не уходит', () => {
  const diff = { base: ['src/old.ts'], head: ['src/new.ts'] }
  const context = checkContext({ language: 'ru', forbiddenPatterns: [] }, diff)
  const refused = (text: GitHubText) =>
    assert.throws(() => checkText(text, context), (error) => error instanceof CheckError && error.reason === 'path_outside_diff')
  refused([field.path('/home/avery/work/demo-shop/src/new.ts')])
  refused([field.path('C:\\Users\\Avery\\demo-shop\\src\\new.ts')])
  refused([field.path('src/other.ts')])
  refused([field.path('src/old.ts', 'head')])
  refused([field.path('src/new.ts', 'base')])
  assert.throws(
    () => checkText([field.path('src/new.ts')], checkContext({ language: 'ru', forbiddenPatterns: [] })),
    /no diff to check it against/,
  )
  assert.equal(checkText([field.path('src/old.ts', 'base'), ' ', field.path('src/new.ts')], context).text, 'src/old.ts src/new.ts')
})

test('маска знает токены и ключи известных форматов (GitHub, GitLab, облака, чаты, ИИ-провайдеры, платежи, JWT, приватные ключи); SHA, время, id, версии и номера задач в тексте не трогает', () => {
  const mask = compileMask([])
  // Each value is invented, only shaped like the real format.
  const secrets: [string, string][] = [
    ['token:github', TOKEN],
    ['token:github', shaped('github', '_pat_TESTONLY0000000000000000_notarealtoken')],
    ['token:gitlab', shaped('gl', 'pat-TESTONLYnotarealtoken00')],
    ['token:aws', shaped('AK', 'IA', 'TESTONLY00000000')],
    ['token:google', shaped('AI', 'za', 'T'.repeat(35))],
    ['token:slack', shaped('xo', 'xb-', '0'.repeat(12), '-TESTONLYnotreal')],
    ['token:slack', shaped('https://hooks.', 'slack.com/services/', 'T0000/B0000/TESTONLYnotreal')],
    ['token:telegram', shaped('123456789', ':A', 'A', 'T'.repeat(33))],
    ['token:discord', shaped('https://discord.', 'com/api/webhooks/', '123456/TESTONLY-notreal')],
    ['token:ai', shaped('sk', '-ant-api03-TESTONLYnotarealkey0000')],
    ['token:ai', shaped('sk', '-proj-TESTONLYnotarealkey00000000')],
    ['token:ai', shaped('hf', '_', 'T'.repeat(34))],
    ['token:stripe', shaped('sk', '_live_', 'TESTONLYnotarealkey0000')],
    ['token:npm', shaped('npm', '_', 'T'.repeat(36))],
    ['token:sendgrid', shaped('SG', '.TESTONLYnotreal00000', '.TESTONLYnotarealkey0000000')],
    ['token:jwt', shaped('ey', 'JhbGciOiJIUzI1NiJ9', '.ey', 'JzdWIiOiJ0ZXN0In0', '.TESTONLYnotarealsignature')],
    ['private-key', shaped('-----BEGIN OPENSSH ', 'PRIVATE KEY-----\nTESTONLY\nnotreal\n-----END OPENSSH ', 'PRIVATE KEY-----')],
    ['email', 'avery.stone+queue@mail.example.org'],
    ['phone', '+7 (701) 555-01-23'],
    ['phone', '8 701 555 0123'],
    ['phone', '+15550100199'],
  ]
  for (const [rule, secret] of secrets) {
    const masked = mask.apply(`до ${secret} после`)
    assert.equal(masked.text, `до ${HIDDEN} после`, `${rule}: ${secret}`)
    assert.ok(masked.rules.includes(rule), `${rule}: ${masked.rules.join(',')}`)
  }
  // A date is not a phone number, a phone number right after it still is.
  assert.equal(mask.apply('звонок 2026-11-26 701 555 0123 утром').text, `звонок 2026-11-26 ${HIDDEN} утром`)
  // A private key without its END line (a text cut short) is hidden to the end of the text.
  assert.equal(mask.apply(shaped('до -----BEGIN RSA ', 'PRIVATE KEY-----\nTESTONLY\nобрезано')).text, `до ${HIDDEN}`)
  for (const rule of new Set(secrets.map(([name]) => name))) assert.ok(BUILT_IN_RULES.includes(rule), rule)
  // Not secrets: left as they are.
  const plain = [
    SHA,
    TIME,
    COORDINATOR,
    'v1.4.273',
    'Зависит от #5, #7',
    'https://github.com/acme/demo-shop/issues/7#issuecomment-1234567890',
    'src/platform/run.ts:120',
    'Отложено до 2026-11-26 08:11',
    '2026-11-26 0811 и 26.11.2026 08:11:05',
    'число 3.1415926535',
    'exit 9009, 754321 ms',
    'skeleton task-runner',
    '192.168.100.200',
  ]
  for (const value of plain) assert.equal(mask.apply(value).text, value, value)
})

test('сохранённая работа — только числа и «сохранено на компьютере <id>»; шаг после мержа — имя из настроек или номер шага и код выхода, без команды', () => {
  const ru: ProjectGitHubSettings = { language: 'ru', forbiddenPatterns: ['CUST-\\d{6}', '\\d{4}'] }
  const context = checkContext(ru)
  // The digits of the counts and the id are coordinator fields: the pattern \d{4} does not hide them.
  assert.equal(
    checkText(savedWorkText({ commits: 2, changed: 1234, untracked: 0 }, COORDINATOR, 'ru'), context).text,
    `коммитов: 2, изменённых файлов: 1234, новых файлов: 0 — сохранено на компьютере ${COORDINATOR}`,
  )
  assert.equal(
    checkText(savedWorkText({ commits: 1, changed: 0, untracked: 3 }, COORDINATOR, 'en'), context).text,
    `commits: 1, changed files: 0, new files: 3 — saved on computer ${COORDINATOR}`,
  )
  assert.throws(() => checkText(savedWorkText({ commits: -1, changed: 0, untracked: 0 }, COORDINATOR, 'ru'), context), /count/)
  assert.throws(() => checkText(savedWorkText({ commits: 1, changed: 0, untracked: 0 }, 'avery-laptop', 'ru'), context), /coordinator id/)

  assert.equal(checkText(postMergeStepText({ number: 1, name: 'Обновить демо' }, 1, ru), context).text, 'Шаг после мержа «Обновить демо»: код выхода 1')
  // The name holds a customer id of the patterns: the step's number instead.
  assert.equal(
    checkText(postMergeStepText({ number: 2, name: 'Выгрузка CUST-424242' }, 0, ru), context).text,
    'Шаг после мержа 2: код выхода 0',
  )
  assert.equal(
    checkText(postMergeStepText({ number: 3, name: null }, 127, { language: 'en', forbiddenPatterns: [] }), context).text,
    'Post-merge step 3: exit code 127',
  )
  assert.equal(
    checkText(postMergeStepText({ number: 4, name: '  ' }, 2, { language: 'en', forbiddenPatterns: [] }), context).text,
    'Post-merge step 4: exit code 2',
  )
})

test('длительность в тексте — для человека: мс, секунды, минуты, часы', () => {
  assert.deepEqual(
    [850, 12_500, 59_999, 125_000, 3_600_000, 3_725_000].map(formatDuration),
    ['850 ms', '12.5 s', '60 s', '2 min 5 s', '1 h', '1 h 2 min'],
  )
})
