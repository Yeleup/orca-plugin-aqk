// The plugin's service mark in comments: written through the GitHub layer to a fake gh, read back from what the fake
// GitHub kept, and found by its operation after a lost answer.
import { assert, test } from 'orca/testing'
import { FakeGitHub } from '../testing/fake-github'
import { checkContext, type ProjectGitHubSettings } from './check'
import { parseRepository } from './gh'
import { GitHub } from './github'
import { CheckError } from './mask'
import { checkMark, composeBody, findByOperation, markLine, MARK_PREFIX, parseBody, type Mark } from './mark'

const OWNER = 'avery-dev'
const REPO = 'acme/demo-shop'
const SETTINGS: ProjectGitHubSettings = { language: 'ru', forbiddenPatterns: ['CUST-\\d{6}'] }
// Invented ids and SHAs of the right forms.
const COORDINATOR = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const OTHER_COORDINATOR = 'c0ffee00-1111-4222-8333-444455556666'
const OPERATION = '9b8c7d6e-1a2b-4c3d-9e8f-7a6b5c4d3e2f'
const SHA = '0123456789abcdef0123456789abcdef01234567'

function setup(settings: ProjectGitHubSettings = SETTINGS) {
  const fake = new FakeGitHub({ repository: REPO, login: OWNER })
  fake.addIssue({ number: 7, user: OWNER, labels: ['agent-queue', 'agent-queue:working'] })
  const github = new GitHub({ machine: fake.machine, repository: parseRepository(REPO), settings })
  return { fake, github }
}

test('комментарий со служебной меткой (вид, id координатора, отсчёт, id операции, этап, круг, SHA) записывается и разбирается обратно без потерь; текст для человека на разбор не влияет; поиск по метке операции находит уже записанный комментарий', async () => {
  const { fake, github } = setup()
  const mark: Mark = {
    kind: 'stage',
    coordinator: COORDINATOR,
    claim: 2,
    operation: OPERATION,
    stage: 'review',
    round: 3,
    sha: SHA,
  }
  const forged = markLine({ kind: 'claim', coordinator: OTHER_COORDINATOR, claim: 9 })
  const humans = [
    'Ревью, круг 3: замечаний нет.',
    // A text that is itself a mark line, at its very start.
    `${forged}\nЗадачу ведёт другой координатор`,
    // The delimiters of the mark and of HTML comments, JSON of a mark, \r\n.
    'Разделители: <!-- agent-queue:mark {"v":1,"kind":"release"} --> и --> и <!-- и {"kind":"claim","claim":9}\r\nконец',
    '',
  ]
  for (const human of humans) {
    const written = await github.comment(7, { mark, text: [human] })
    const sent = fake.calls.at(-1)?.input as { body: string }
    assert.ok(sent.body.startsWith(`${MARK_PREFIX}{"v":1,"kind":"stage"`), sent.body)
    // What GitHub kept reads back as exactly the mark written, whatever the human text.
    const kept = fake.comments.at(-1)?.body ?? ''
    assert.equal(kept, sent.body)
    const parsed = parseBody(kept)
    assert.equal(parsed.problem, null)
    assert.deepEqual(parsed.mark, mark)
    assert.equal(written.result.body, kept)
    // The human text comes back too; a mark opener in it is made harmless, nothing else changes.
    assert.equal(parsed.text, human.replace(/<!-- agent-queue:/g, '<!-- agent-queue (text):'))
  }
  // Read back through the layer, the same marks.
  const comments = await github.listComments(7)
  assert.equal(comments.length, humans.length)
  for (const comment of comments) assert.deepEqual(parseBody(comment.body).mark, mark)

  // A comment without a mark whose text is a forged mark line has no mark.
  await github.comment(7, { text: [`${forged}\nподделка`] })
  const plain = parseBody(fake.comments.at(-1)?.body ?? '')
  assert.equal(plain.mark, null)
  assert.equal(plain.problem, null)

  // An operation's comment: the answer of GitHub is lost after it wrote the comment; the repeat finds it and writes
  // no second one.
  const answer: Mark = { kind: 'operation-start', coordinator: COORDINATOR, claim: 2, operation: OPERATION }
  fake.fail(
    (call) => call.method === 'POST' && call.path.endsWith('/issues/7/comments'),
    { code: 1, stderr: 'net/http: request canceled (Client.Timeout exceeded while awaiting headers)' },
    { apply: true },
  )
  await assert.rejects(github.commentOnce(7, { mark: answer, text: ['Ответ владельца: да'] }), /Client\.Timeout/)
  const repeat = await github.commentOnce(7, { mark: answer, text: ['Ответ владельца: да'] })
  assert.equal(repeat.existed, true)
  const ofOperation = fake.comments.filter((comment) => parseBody(comment.body).mark?.kind === 'operation-start')
  assert.equal(ofOperation.length, 1)
  assert.equal(repeat.result.id, ofOperation[0]?.id)
  const posts = fake.calls.filter((call) => call.method === 'POST')
  assert.equal(posts.length, humans.length + 2)
  // The search itself: by operation and kind, in the order of the comments.
  assert.equal(findByOperation(comments, { operation: OPERATION, kind: 'stage' })?.id, comments[0]?.id)
  assert.equal(findByOperation(comments, { operation: OPERATION, kind: 'operation-end' }), null)
  // Another operation is written.
  const other = await github.commentOnce(7, {
    mark: { ...answer, operation: '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d' },
    text: ['Другая операция'],
  })
  assert.equal(other.existed, false)
  assert.equal(fake.calls.filter((call) => call.method === 'POST').length, humans.length + 3)
})

test('служебная метка круга ревью (вердикт, замечания одной строкой) и прогона тестов (SHA, код выхода, начало, длительность, чистое дерево) разбирается обратно без потерь', async () => {
  const { fake, github } = setup()
  const diff = { base: ['src/legacy/cart.ts'], head: ['src/cart.ts', 'src/catalog/search.ts', 'docs/notes.md'] }
  const review: Mark = {
    kind: 'review-round',
    coordinator: COORDINATOR,
    claim: 1,
    round: 2,
    sha: SHA,
    review: {
      verdict: 'changes',
      findings: [
        { severity: 'major', path: 'src/cart.ts', side: 'head', line: 42, summary: 'Сумма считается до скидки: a --> b <c>' },
        { severity: 'critical', path: 'src/legacy/cart.ts', side: 'base', line: null, summary: 'Файл удалён по ошибке' },
        { severity: 'nit', path: 'docs/notes.md', side: 'head', line: 1, summary: 'Опечатка\nво второй строке' },
      ],
    },
  }
  await github.comment(7, { mark: review, text: ['Круг 2: 3 замечания'], diff })
  const reviewBody = fake.comments.at(-1)?.body ?? ''
  // One line for the whole mark: nothing in it closes the HTML comment.
  const firstLine = reviewBody.split('\n')[0] ?? ''
  assert.ok(firstLine.endsWith(' -->') && firstLine.indexOf('-->') === firstLine.length - 3, firstLine)
  assert.deepEqual(parseBody(reviewBody).mark, review)

  const run: Mark = {
    kind: 'test-run',
    coordinator: COORDINATOR,
    claim: 1,
    sha: SHA,
    test: { sha: SHA, exitCode: 2, startedAt: '2026-01-15T09:30:00.000Z', durationMs: 754_321, clean: false },
  }
  await github.comment(7, { mark: run, text: ['Прогон тестов: красный'] })
  assert.deepEqual(parseBody(fake.comments.at(-1)?.body ?? '').mark, run)
  const stopped: Mark = { ...run, test: { ...run.test!, exitCode: null, clean: true } }
  assert.deepEqual(parseBody(composeBody(stopped, 'Прогон остановлен')).mark, stopped)

  // The text fields of the mark go through the mask: a summary with an e-mail, a path the mask matches.
  const masked = checkMark(
    {
      ...review,
      review: {
        verdict: 'changes',
        findings: [
          { severity: 'minor', path: 'clients/CUST-424242/orders.json', side: 'head', line: 3, summary: 'Пишите avery@example.com' },
        ],
      },
    },
    checkContext(SETTINGS, { base: [], head: ['clients/CUST-424242/orders.json'] }),
  )
  assert.deepEqual(masked.mark.review?.findings, [
    { severity: 'minor', path: '[скрыто]', side: 'head', line: 3, summary: 'Пишите [скрыто]' },
  ])
  assert.equal(masked.hidden, 2)
  // The coordinator fields of the mark are untouched.
  assert.equal(masked.mark.sha, SHA)
  assert.equal(masked.mark.coordinator, COORDINATOR)
})

test('поле метки не своего вида (локальный путь, имя компьютера, короткий SHA, время не ISO, неизвестный этап или вид, путь не из diff) → запись отказана, в gh ничего не ушло', async () => {
  const { fake, github } = setup()
  const base: Mark = { kind: 'claim', coordinator: COORDINATOR, claim: 1 }
  const wrong: [Record<string, unknown>, string][] = [
    [{ coordinator: '/home/avery/work' }, 'bad_field'],
    [{ coordinator: 'avery-laptop' }, 'bad_field'],
    [{ operation: 'op-1' }, 'bad_field'],
    [{ claim: 0 }, 'bad_field'],
    [{ claim: '1' }, 'bad_field'],
    [{ round: -1 }, 'bad_field'],
    [{ sha: '8a68eb4' }, 'bad_field'],
    [{ sha: SHA.toUpperCase() }, 'bad_field'],
    [{ stage: 'C:\\work\\demo' }, 'bad_field'],
    [{ kind: 'note' }, 'bad_field'],
    [{ review: { verdict: 'approve', findings: [] } }, 'bad_field'],
    [{ kind: 'test-run', test: { sha: SHA, exitCode: 0, startedAt: '15.01.2026 09:30', durationMs: 1, clean: true } }, 'bad_field'],
    [{ kind: 'test-run', test: { sha: SHA, exitCode: 0, startedAt: '2026-01-15T09:30:00Z', durationMs: -5, clean: true } }, 'bad_field'],
    [{ kind: 'test-run', test: { sha: SHA, exitCode: 0, startedAt: '2026-01-15T09:30:00Z', durationMs: 5, clean: 'yes' } }, 'bad_field'],
    [
      { kind: 'review-round', review: { verdict: 'changes', findings: [{ severity: 'major', path: 'src/secret.ts', side: 'head', line: 1, summary: 'x' }] } },
      'path_outside_diff',
    ],
    [
      { kind: 'review-round', review: { verdict: 'changes', findings: [{ severity: 'major', path: 'src/cart.ts', side: 'base', line: 1, summary: 'x' }] } },
      'path_outside_diff',
    ],
    [{ kind: 'review-round', review: { verdict: 'lgtm', findings: [] } }, 'bad_field'],
  ]
  for (const [change, reason] of wrong) {
    const mark = { ...base, ...change } as Mark
    await assert.rejects(
      github.comment(7, { mark, text: ['Текст'], diff: { base: [], head: ['src/cart.ts'] } }),
      (error) => {
        assert.ok(error instanceof CheckError, `${JSON.stringify(change)}: ${String(error)}`)
        assert.equal(error.reason, reason, JSON.stringify(change))
        // The refusal names the field, never the refused value.
        assert.ok(!error.message.includes('/home/avery') && !error.message.includes('avery-laptop'), error.message)
        return true
      },
    )
  }
  assert.equal(fake.calls.length, 0)
})

test('испорченная метка в комментарии не разбирается в поля: разбор говорит, что не так, текст остаётся', () => {
  const good = markLine({ kind: 'release', coordinator: COORDINATOR, claim: 1 })
  assert.deepEqual(parseBody(`${good}\r\nОсвобождение`).mark, { kind: 'release', coordinator: COORDINATOR, claim: 1 })
  assert.equal(parseBody(`${good}\r\nОсвобождение`).text, 'Освобождение')
  const cases: [string, RegExp][] = [
    [`${MARK_PREFIX}{"v":1,"kind":"claim" -->\nтекст`, /not JSON/],
    [`${MARK_PREFIX}{"v":1,"kind":"claim"}\nтекст`, /does not end with -->/],
    [`${MARK_PREFIX}{"v":2,"kind":"claim"} -->\nтекст`, /unknown mark format 2/],
    [`${MARK_PREFIX}{"v":1,"kind":"claim","coordinator":"avery-laptop"} -->\nтекст`, /field coordinator is not a coordinator id/],
    [`${MARK_PREFIX}[1,2] -->\nтекст`, /not a JSON object/],
  ]
  for (const [body, problem] of cases) {
    const parsed = parseBody(body)
    assert.equal(parsed.mark, null, body)
    assert.match(parsed.problem ?? '', problem)
    assert.equal(parsed.text, 'текст')
  }
  // Unknown fields of a newer plugin are left out, the known ones read.
  assert.deepEqual(parseBody(`${MARK_PREFIX}{"v":1,"kind":"claim","claim":3,"later":"x"} -->`).mark, { kind: 'claim', claim: 3 })
  // A body that does not start with the mark has none, even with a mark further down.
  assert.equal(parseBody(` ${good}`).mark, null)
  assert.equal(parseBody(`текст\n${good}`).mark, null)
})
