// The coordinator's check of the queue, its claims by the protocol of counts and the right to act (TZ Ф4), with fakes
// only: several coordinators — each a fake computer with its own data directory and coordinator id — on one fake
// GitHub behind a fake gh, on one fake clock. A test calls one check of the queue itself and never waits for a timer;
// the protocol's wait of 60 seconds moves the fake clock. What a test looks at is what ends up on the fake GitHub —
// which comments with which marks and counts, in which order, which labels — who would start the agents (the hook
// `started`) and when, and what each coordinator writes or does not write afterwards.
import { assert, test } from 'orca/testing'
import { parseRepository } from '../github/gh'
import { GitHub } from '../github/github'
import { PLUGIN_LABELS } from '../github/labels'
import { composeBody, parseBody, type Mark } from '../github/mark'
import { dataDirectory } from '../platform/paths'
import { parseProjectSettings, type ProjectSettings } from '../project/settings'
import { FakeGitHub, readCall } from '../testing/fake-github'
import { fakeClock, type FakeMachine } from '../testing/fake-machine'
import { fakeSleep, holdCall, isCommentOn, isLabelOn, isRead, isUnlabelOn, isWrite } from '../testing/hold'
import { DEFERRAL_MS, expectationOf, readClaims, REREAD_AFTER_MS, UNSETTLED_MS } from './claims'
import { ClaimJournal } from './journal'
import {
  Coordinator,
  LED_ELSEWHERE,
  type ChoiceRule,
  type CoordinatorHooks,
  type LedTask,
  type LostTask,
  type QueueProject,
} from './coordinator'

const OWNER = 'avery-dev'
const REPO = 'acme/demo-shop'
// Invented coordinator ids (random UUID v4 form) of four computers.
const A = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const B = '5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9'
const C = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f'
const X = '9f8e7d6c-5b4a-4c3d-b2e1-f0a9b8c7d6e5'
const NAMES: Record<string, string> = { [A]: 'A', [B]: 'B', [C]: 'C', [X]: 'X' }
const MINUTE = 60_000
const START = Date.UTC(2026, 2, 2, 10, 0, 0)

const PROJECT: QueueProject = {
  id: 'example-org/demo-shop',
  hostId: 'local',
  name: 'demo-shop',
  checkout: '/home/avery/src/demo-shop',
  repository: parseRepository(REPO),
}

const WORKING = 'agent-queue:working'
const BLOCKED = 'agent-queue:blocked'
const BAD_GATEWAY = { code: 1, stderr: 'gh: Server Error (HTTP 502)' }

function projectSettings(more: Record<string, unknown> = {}): ProjectSettings {
  const text = JSON.stringify({ version: 1, testCommand: 'make test', language: 'ru', dataRule: 'No customer data in GitHub.', ...more })
  const parsed = parseProjectSettings(text, 'main')
  assert.ok(parsed.ok, JSON.stringify(parsed))
  return parsed.settings
}

type Computer = {
  readonly coordinator: Coordinator
  readonly machine: FakeMachine
  readonly sleep: ReturnType<typeof fakeSleep>
  readonly started: LedTask[]
  readonly leading: LedTask[]
  readonly lost: LostTask[]
  readonly logs: string[]
  // The gh calls of this computer that wrote something, as `METHOD path`.
  writes(): string[]
}

type ComputerOptions = {
  // The same computer again (a restart of its worker).
  readonly machine?: FakeMachine
  readonly stopped?: boolean
  readonly rules?: readonly ChoiceRule[]
  // Hooks run before the recording ones (they may throw).
  readonly hooks?: CoordinatorHooks
}

function world(settings: Partial<Record<string, unknown>> = {}) {
  const clock = fakeClock(START)
  const github = new FakeGitHub({ repository: REPO, login: OWNER, clock, pageSize: 50 })
  for (const label of PLUGIN_LABELS) github.addLabel(label)
  const project = projectSettings(settings)
  const computer = (id: string, options: ComputerOptions = {}): Computer => {
    const machine = options.machine ?? github.computer()
    const sleep = fakeSleep(clock)
    const started: LedTask[] = []
    const leading: LedTask[] = []
    const lost: LostTask[] = []
    const logs: string[] = []
    const coordinator = new Coordinator({
      machine,
      dataDir: dataDirectory(machine),
      coordinatorId: id,
      readSettings: async () => ({ ok: true, settings: project }),
      sleep: sleep.sleep,
      queueStopped: () => options.stopped ?? false,
      ...(options.rules ? { rules: options.rules } : {}),
      hooks: {
        started: async (task) => {
          await options.hooks?.started?.(task)
          started.push(task)
        },
        leading: async (task) => {
          await options.hooks?.leading?.(task)
          leading.push(task)
        },
        lost: async (task) => {
          await options.hooks?.lost?.(task)
          lost.push(task)
        },
      },
      log: (line) => logs.push(line),
    })
    const writes = () =>
      machine.starts
        .map(readCall)
        .filter(isWrite)
        .map((call) => `${call.method} ${call.path.replace(`repos/${REPO}/`, '')}`)
    return { coordinator, machine, sleep, started, leading, lost, logs, writes }
  }
  // A comment of a coordinator written directly on the fake GitHub (what another computer wrote earlier).
  const mark = (issue: number, value: Mark, text = 'ход') => github.addComment(issue, OWNER, composeBody(value, text))
  // The comments of a task: `kind coordinator count` of each mark (with its text for a notice), the text of a comment
  // without one.
  const thread = (issue: number) =>
    github.comments
      .filter((comment) => comment.issue === issue)
      .map((comment) => {
        const { mark: found, text } = parseBody(comment.body)
        const named = (line: string) => line.trim().replace(/[0-9a-f-]{36}/g, (id) => NAMES[id] ?? id)
        if (found === null) return named(text)
        const head = `${found.kind} ${NAMES[found.coordinator ?? ''] ?? found.coordinator} ${found.claim ?? ''}`.trim()
        return found.kind === 'yield' ? `${head}: ${named(text)}` : head
      })
  const labels = (issue: number) => [...(github.issues.find((one) => one.number === issue)?.labels ?? [])].sort()
  const issue = (number: number) => {
    const found = github.issues.find((one) => one.number === number)
    assert.ok(found, `#${number}`)
    return found
  }
  // The claims of a task as a decision of another coordinator reads them (the watchdog's reading).
  const claimsOf = async (number: number) => {
    const layer = new GitHub({
      machine: github.computer(),
      repository: PROJECT.repository,
      settings: { language: 'ru', forbiddenPatterns: [] },
    })
    return readClaims(await layer.listComments(number))
  }
  return { clock, github, computer, mark, thread, labels, issue, claimsOf }
}

// The time `started` ran and the labels the task had then.
function startedWith(w: ReturnType<typeof world>, issue: number) {
  const seen: { at: number; labels: string[] }[] = []
  return {
    seen,
    hooks: {
      started: () => {
        seen.push({ at: w.clock.now(), labels: w.labels(issue) })
      },
    } satisfies CoordinatorHooks,
  }
}

// ── К4.3 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Both coordinators read task #7 free, then their claims reach GitHub in the order `first`, `second`; both re-read after
// both claims are written.
async function raceForTask(order: 'A-first' | 'B-first') {
  const w = world()
  w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
  const a = w.computer(A)
  const b = w.computer(B)
  const claimOf = { a: holdCall(a.machine, isCommentOn(7)), b: holdCall(b.machine, isCommentOn(7)) }
  const waitOf = { a: a.sleep.hold(), b: b.sleep.hold() }
  const checks = Promise.all([a.coordinator.checkProject(PROJECT), b.coordinator.checkProject(PROJECT)])
  // Both have read the task and found it free; neither claim is on GitHub yet.
  await Promise.all([claimOf.a.reached, claimOf.b.reached])
  assert.deepEqual(w.thread(7), [])
  const [first, second] = order === 'A-first' ? (['a', 'b'] as const) : (['b', 'a'] as const)
  claimOf[first].release()
  await waitOf[first].reached
  claimOf[second].release()
  await waitOf[second].reached
  // Both claims are written and the label is on; now both re-read.
  waitOf.a.release()
  waitOf.b.release()
  const [checkA, checkB] = await checks
  return { w, a, b, checkA, checkB }
}

test('К4.3: A и B читают задачу свободной, затем A пишет заявку, затем B; оба перечитывают → агентов запускает только A; B пишет «Задачу ведёт A» и больше ничего не делает', async () => {
  const { w, a, b, checkA, checkB } = await raceForTask('A-first')
  assert.deepEqual(checkA.claimed, { kind: 'leads', issue: 7, count: 1 })
  assert.deepEqual(checkB.claimed, { kind: 'lost', issue: 7, count: 1, leader: A, noticed: true })
  // Both wrote the same count; A's claim is first in GitHub's order. B's notice is bound to B and count 1.
  assert.deepEqual(w.thread(7), ['claim A 1', 'claim B 1', 'yield B 1: Задачу ведёт A.'])
  assert.deepEqual(w.labels(7), ['agent-queue', WORKING])
  // Only A would start the agents.
  assert.deepEqual(
    a.started.map((task) => [task.issue.number, task.count, task.kind, task.stage]),
    [[7, 1, 'claim', null]],
  )
  assert.deepEqual(b.started, [])
  // B: its claim and its notice; the label was on already (A set it).
  assert.deepEqual(b.writes(), ['POST issues/7/comments', 'POST issues/7/comments'])

  // Later checks: B writes nothing more on the task and starts nothing; A goes on leading it.
  const writtenByB = b.writes().length
  const writtenByA = a.writes().length
  for (let check = 0; check < 2; check++) {
    w.clock.advance(5 * MINUTE)
    const laterB = await b.coordinator.checkProject(PROJECT)
    assert.equal(laterB.claimed, null)
    assert.deepEqual(laterB.led, [])
    const laterA = await a.coordinator.checkProject(PROJECT)
    assert.deepEqual(laterA.led, [7])
  }
  assert.equal(b.writes().length, writtenByB)
  assert.deepEqual(b.started, [])
  assert.equal(b.lost.length, 0)
  assert.equal(a.writes().length, writtenByA)
  assert.equal(a.started.length, 1)
  assert.deepEqual(a.leading.map((task) => task.count), [1, 1])
  assert.deepEqual(w.thread(7), ['claim A 1', 'claim B 1', 'yield B 1: Задачу ведёт A.'])
})

test('К4.3 (порядок «A, B, запись B, запись A»): ведёт тот, чья заявка в GitHub первая — B; A пишет «Задачу ведёт B» и больше ничего не делает', async () => {
  const { w, a, b, checkA, checkB } = await raceForTask('B-first')
  assert.deepEqual(checkB.claimed, { kind: 'leads', issue: 7, count: 1 })
  assert.deepEqual(checkA.claimed, { kind: 'lost', issue: 7, count: 1, leader: B, noticed: true })
  assert.deepEqual(w.thread(7), ['claim B 1', 'claim A 1', 'yield A 1: Задачу ведёт B.'])
  assert.deepEqual(w.labels(7), ['agent-queue', WORKING])
  assert.deepEqual(b.started.map((task) => [task.issue.number, task.count]), [[7, 1]])
  assert.deepEqual(a.started, [])

  const writtenByA = a.writes().length
  w.clock.advance(5 * MINUTE)
  assert.equal((await a.coordinator.checkProject(PROJECT)).claimed, null)
  assert.equal(a.writes().length, writtenByA)
  assert.deepEqual(a.started, [])
  assert.deepEqual(w.thread(7), ['claim B 1', 'claim A 1', 'yield A 1: Задачу ведёт B.'])
})

// A and B race for #7, A's claim first; B's re-read after its wait fails, so B has not written its notice.
async function loserWithoutNotice() {
  const w = world()
  w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
  const a = w.computer(A)
  const b = w.computer(B)
  const claimOf = { a: holdCall(a.machine, isCommentOn(7)), b: holdCall(b.machine, isCommentOn(7)) }
  const waitOfB = b.sleep.hold()
  const checkA = a.coordinator.checkProject(PROJECT)
  const checkB = b.coordinator.checkProject(PROJECT)
  await Promise.all([claimOf.a.reached, claimOf.b.reached])
  claimOf.a.release()
  assert.deepEqual((await checkA).claimed, { kind: 'leads', issue: 7, count: 1 })
  claimOf.b.release()
  await waitOfB.reached
  w.github.fail(isRead('AqIssue', 7), { code: 1, stderr: 'gh: connection reset' })
  waitOfB.release()
  assert.equal((await checkB).claimed?.kind, 'incomplete')
  assert.deepEqual(w.thread(7), ['claim A 1', 'claim B 1'])
  return { w, a, b }
}

test('К4.3 (проигравший после сбоя): перечитывание проигравшего не прошло → на следующей проверке (и после перезапуска) он дописывает «Задачу ведёт A» один раз, и после потерянного ответа — без дубля', async () => {
  const { w, b } = await loserWithoutNotice()
  // B's worker restarts; its next check finds its claim that lost count 1 and writes the notice. The first write
  // reaches GitHub, its answer is lost.
  const restarted = w.computer(B, { machine: b.machine })
  w.github.fail(isCommentOn(7), BAD_GATEWAY, { apply: true })
  await restarted.coordinator.checkProject(PROJECT)
  assert.deepEqual(w.thread(7), ['claim A 1', 'claim B 1', 'yield B 1: Задачу ведёт A.'])
  for (let check = 0; check < 2; check++) {
    w.clock.advance(5 * MINUTE)
    await restarted.coordinator.checkProject(PROJECT)
  }
  assert.deepEqual(w.thread(7), ['claim A 1', 'claim B 1', 'yield B 1: Задачу ведёт A.'])
  assert.deepEqual(restarted.started, [])
  // The notice is no progress of A's count: A's deadline of К4.12 is its own comments'.
  const claims = await w.claimsOf(7)
  assert.equal(claims.leaderLastAt, claims.claimAt)
})

test('К4.3 (уведомление один раз): уведомление проигравшего, которого не было в чтении проверки, но которое видно в свежем чтении перед записью (запоздавший ответ), второй раз не пишется', async () => {
  const { w, b } = await loserWithoutNotice()
  // The notice of an earlier write shows up only by the time B reads the comments again right before its own write.
  let reads = 0
  w.github.before(
    (call) => call.operation === 'AqComments' && Number(call.variables.number) === 7 && ++reads === 2,
    () => {
      w.mark(7, { kind: 'yield', coordinator: B, claim: 1 }, `Задачу ведёт ${A}.`)
    },
  )
  const writtenByB = b.writes().length
  await b.coordinator.checkProject(PROJECT)
  assert.equal(reads >= 2, true)
  assert.equal(b.writes().length, writtenByB)
  assert.deepEqual(w.thread(7), ['claim A 1', 'claim B 1', 'yield B 1: Задачу ведёт A.'])
})

test('К4.3 (метка после освобождения): заявка B того же отсчёта, а A уже освободил его → B метку не ставит и уведомления не пишет', async () => {
  const w = world()
  w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
  const a = w.computer(A)
  const b = w.computer(B)
  const claimOf = { a: holdCall(a.machine, isCommentOn(7)), b: holdCall(b.machine, isCommentOn(7)) }
  // B's reading before its label, after its claim, waits.
  const readOfB = holdCall(b.machine, isRead('AqIssue', 7), { after: isCommentOn(7) })
  const checkA = a.coordinator.checkProject(PROJECT)
  const checkB = b.coordinator.checkProject(PROJECT)
  await Promise.all([claimOf.a.reached, claimOf.b.reached])
  claimOf.a.release()
  assert.deepEqual((await checkA).claimed, { kind: 'leads', issue: 7, count: 1 })
  claimOf.b.release()
  await readOfB.reached
  // A ends its count meanwhile: its release, then the label off.
  const taskA = a.started[0]
  assert.ok(taskA)
  const released = await taskA.right.act(() =>
    taskA.github.comment(7, { mark: { kind: 'release', coordinator: A, claim: 1 }, text: ['Освобождение'] }),
  )
  assert.equal(released.ok, true)
  assert.equal((await taskA.right.act(() => taskA.github.removeLabel(7, WORKING), { released: true })).ok, true)
  readOfB.release()
  assert.deepEqual((await checkB).claimed, { kind: 'yielded', issue: 7, count: 1, leader: A })
  assert.deepEqual(w.labels(7), ['agent-queue'])
  assert.deepEqual(w.thread(7), ['claim A 1', 'claim B 1', 'release A 1'])
  assert.deepEqual(b.writes(), ['POST issues/7/comments'])
  assert.deepEqual(b.started, [])
})

// ── К4.2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('К4.2: предел «одновременно в работе» 1 и одна задача в работе → вторая не берётся, пока первая не закрыта или не заблокирована', async () => {
  for (const ending of ['blocked', 'closed'] as const) {
    const w = world({ maxInProgress: 1 })
    w.github.addIssue({ number: 1, user: OWNER, labels: ['agent-queue', WORKING] })
    w.mark(1, { kind: 'claim', coordinator: X, claim: 1 })
    w.github.addIssue({ number: 2, user: OWNER, labels: ['agent-queue'] })
    const a = w.computer(A)

    for (let check = 0; check < 3; check++) {
      const result = await a.coordinator.checkProject(PROJECT)
      assert.equal(result.claimed, null, ending)
      assert.deepEqual(result.inWork, [1])
      assert.deepEqual(result.skipped, [
        { issue: 1, reason: 'claimed' },
        { issue: 2, reason: 'limit: 1 of 1 in work' },
      ])
      w.clock.advance(30 * MINUTE)
    }
    assert.deepEqual(a.writes(), [], ending)
    assert.deepEqual(w.thread(2), [])

    const first = w.issue(1)
    if (ending === 'blocked') {
      // The leader of #1 blocks it (Ф6): the block comment of its count, `blocked` instead of `working`.
      w.mark(1, { kind: 'block', coordinator: X, claim: 1 }, 'Нужен ответ владельца')
      first.labels = ['agent-queue', BLOCKED]
    } else {
      first.state = 'closed'
    }
    const result = await a.coordinator.checkProject(PROJECT)
    assert.deepEqual(result.claimed, { kind: 'leads', issue: 2, count: 1 }, ending)
    assert.deepEqual(w.thread(2), ['claim A 1'])
    assert.deepEqual(w.labels(2), ['agent-queue', WORKING])
    assert.deepEqual(a.started.map((task) => task.issue.number), [2])
  }
})

test('в работе — задачи с действующей заявкой, а не с меткой working: заявка без метки предел занимает, метка на освобождённом отсчёте — нет', async () => {
  const w = world({ maxInProgress: 1 })
  // #1: X's claim of 2 minutes ago, its label not set yet (the write failed). #2 waits.
  w.github.addIssue({ number: 1, user: OWNER, labels: ['agent-queue'] })
  w.mark(1, { kind: 'claim', coordinator: X, claim: 1 })
  w.github.addIssue({ number: 2, user: OWNER, labels: ['agent-queue'] })
  const a = w.computer(A)
  w.clock.advance(2 * MINUTE)
  const held = await a.coordinator.checkProject(PROJECT)
  assert.deepEqual(held.inWork, [1])
  assert.equal(held.claimed, null)
  assert.deepEqual(held.skipped, [
    { issue: 1, reason: 'claimed' },
    { issue: 2, reason: 'limit: 1 of 1 in work' },
  ])
  assert.deepEqual(a.writes(), [])

  // X set the label and then released its count: `working` is still on, but no claim is active — #1 is not in work
  // (and waits its 10 minutes), #2 is taken.
  w.issue(1).labels = ['agent-queue', WORKING]
  w.mark(1, { kind: 'release', coordinator: X, claim: 1 }, 'Освобождение')
  const result = await a.coordinator.checkProject(PROJECT)
  assert.deepEqual(result.inWork, [])
  assert.deepEqual(result.skipped, [{ issue: 1, reason: 'released-recently' }])
  assert.deepEqual(result.claimed, { kind: 'leads', issue: 2, count: 1 })
})

// ── К4.10 ────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('К4.10: `working` стоит, последний отсчёт освобождён 10 минут назад → проверка очереди захватывает задачу новым отсчётом', async () => {
  const w = world()
  w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue', WORKING] })
  w.mark(7, { kind: 'claim', coordinator: X, claim: 1 })
  w.clock.advance(20 * MINUTE)
  w.mark(7, { kind: 'release', coordinator: X, claim: 1 }, 'Освобождение')
  const a = w.computer(A)

  // 9 minutes after the release: X may still take its label off — nobody takes the task.
  w.clock.advance(UNSETTLED_MS - MINUTE)
  const early = await a.coordinator.checkProject(PROJECT)
  assert.equal(early.claimed, null)
  assert.deepEqual(early.skipped, [{ issue: 7, reason: 'released-recently' }])
  assert.deepEqual(a.writes(), [])

  w.clock.advance(MINUTE)
  const result = await a.coordinator.checkProject(PROJECT)
  assert.deepEqual(result.claimed, { kind: 'leads', issue: 7, count: 2 })
  assert.deepEqual(w.thread(7), ['claim X 1', 'release X 1', 'claim A 2'])
  assert.deepEqual(w.labels(7), ['agent-queue', WORKING])
  assert.deepEqual(a.started.map((task) => [task.issue.number, task.count]), [[7, 2]])
})

// ── К4.12 ────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('К4.12: запись метки после заявки не прошла → агенты не запускаются; тот же координатор на следующей проверке (и после перезапуска — по своему журналу) ставит метку, ждёт 60 секунд и только тогда запускает; другой координатор задачу не берёт', async () => {
  const w = world()
  w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
  const a = w.computer(A)
  const b = w.computer(B)
  w.github.fail(isLabelOn(7), BAD_GATEWAY)

  const first = await a.coordinator.checkProject(PROJECT)
  assert.equal(first.claimed?.kind, 'incomplete')
  assert.deepEqual(first.led, [])
  assert.deepEqual(w.thread(7), ['claim A 1'])
  assert.deepEqual(w.labels(7), ['agent-queue'])
  assert.deepEqual(a.started, [])

  // B, 5 minutes later: the claim is A's and fresh — B does not take the task.
  w.clock.advance(5 * MINUTE)
  const byB = await b.coordinator.checkProject(PROJECT)
  assert.equal(byB.claimed, null)
  assert.deepEqual(byB.skipped, [{ issue: 7, reason: 'claimed' }])
  assert.deepEqual(b.writes(), [])

  // A's worker restarts: the next check completes the claim — the label, then the wait, then the start.
  const watch = startedWith(w, 7)
  const restarted = w.computer(A, { machine: a.machine, hooks: watch.hooks })
  const labelledAt = w.clock.now()
  const next = await restarted.coordinator.checkProject(PROJECT)
  assert.deepEqual(next.led, [7])
  assert.equal(next.claimed, null)
  assert.deepEqual(w.labels(7), ['agent-queue', WORKING])
  assert.deepEqual(w.thread(7), ['claim A 1'])
  assert.deepEqual(restarted.started.map((task) => task.count), [1])
  assert.deepEqual(watch.seen, [{ at: labelledAt + REREAD_AFTER_MS, labels: ['agent-queue', WORKING] }])

  // With the label on, the claim holds however old it is; A starts nothing again.
  w.clock.advance(UNSETTLED_MS)
  assert.equal((await b.coordinator.checkProject(PROJECT)).claimed, null)
  assert.deepEqual(b.writes(), [])
  await restarted.coordinator.checkProject(PROJECT)
  assert.equal(restarted.started.length, 1)
})

test('К4.12: запись метки после заявки не прошла и заявитель пропал → другой координатор 10 минут задачу не берёт, потом берёт новым отсчётом, а вернувшийся заявитель уступает', async () => {
  const w = world()
  w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
  const a = w.computer(A)
  const b = w.computer(B)
  w.github.fail(isLabelOn(7), BAD_GATEWAY)
  assert.equal((await a.coordinator.checkProject(PROJECT)).claimed?.kind, 'incomplete')
  assert.deepEqual(a.started, [])
  const claimedAt = Date.parse(w.github.comments[0]?.created_at ?? '')

  // Less than 10 minutes since A's claim, no label and no progress comment of A: B waits.
  w.clock.advance(claimedAt + UNSETTLED_MS - MINUTE - w.clock.now())
  const waiting = await b.coordinator.checkProject(PROJECT)
  assert.equal(waiting.claimed, null)
  assert.deepEqual(b.writes(), [])

  // 10 minutes: B takes it with a new count.
  w.clock.advance(MINUTE)
  const taken = await b.coordinator.checkProject(PROJECT)
  assert.deepEqual(taken.claimed, { kind: 'leads', issue: 7, count: 2 })
  assert.deepEqual(w.thread(7), ['claim A 1', 'claim B 2'])
  assert.deepEqual(w.labels(7), ['agent-queue', WORKING])
  assert.deepEqual(b.started.map((task) => task.count), [2])

  // A comes back: it sees the new count and yields — no label, no comment, no agents.
  const writtenByA = a.writes().length
  for (let check = 0; check < 2; check++) {
    w.clock.advance(5 * MINUTE)
    const back = await a.coordinator.checkProject(PROJECT)
    assert.equal(back.claimed, null)
    assert.deepEqual(back.led, [])
  }
  assert.equal(a.writes().length, writtenByA)
  assert.deepEqual(a.started, [])
  assert.equal(a.lost.length, 0)
  assert.deepEqual(w.thread(7), ['claim A 1', 'claim B 2'])
})

test('К4.12 (ход старого отсчёта): запоздалый комментарий прежнего отсчёта того же координатора не продлевает 10 минут его новой заявки без метки', async () => {
  const w = world()
  w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
  w.mark(7, { kind: 'claim', coordinator: A, claim: 1 })
  w.mark(7, { kind: 'release', coordinator: A, claim: 1 }, 'Освобождение')
  w.clock.advance(20 * MINUTE)
  // A's new claim, its label not set.
  w.mark(7, { kind: 'claim', coordinator: A, claim: 2 })
  const claimedAt = w.clock.now()
  // A late comment of A's count 1 lands 5 minutes later: no progress of count 2.
  w.clock.advance(5 * MINUTE)
  w.mark(7, { kind: 'stage', coordinator: A, claim: 1, stage: 'review' }, 'Ревью')
  const b = w.computer(B)
  w.clock.advance(claimedAt + UNSETTLED_MS - w.clock.now())
  const result = await b.coordinator.checkProject(PROJECT)
  assert.deepEqual(result.claimed, { kind: 'leads', issue: 7, count: 3 })
  assert.deepEqual(w.thread(7), ['claim A 1', 'release A 1', 'claim A 2', 'stage A 1', 'claim B 3'])
})

// ── К4.13 ────────────────────────────────────────────────────────────────────────────────────────────────────────────

// A leads #7 with count 1; its next action has checked its right and waits before its write (`late`), while B takes
// the task over with count 2. Then A's write lands.
async function takeoverInTheWindow(late: (task: LedTask) => Promise<unknown>, match: Parameters<typeof holdCall>[1]) {
  const w = world()
  w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
  const a = w.computer(A)
  const b = w.computer(B)
  assert.deepEqual((await a.coordinator.checkProject(PROJECT)).claimed, { kind: 'leads', issue: 7, count: 1 })
  const taskA = a.started[0]
  assert.ok(taskA)
  // A has been silent for 3 hours: the watchdog of B decides to take the task over (Ф10).
  w.clock.advance(180 * MINUTE)
  const held = holdCall(a.machine, match)
  const action = late(taskA)
  await held.reached
  const takeover = await b.coordinator.claimTask(PROJECT, 7, { kind: 'takeover' })
  assert.deepEqual(takeover, { kind: 'leads', issue: 7, count: 2 })
  held.release()
  const landed = await action
  return { w, a, b, taskA, landed }
}

test('К4.13: перехват записан между проверкой права и комментарием прежнего ведущего → этот комментарий в этап не идёт, прежний ведущий больше ничего не пишет', async () => {
  const { w, a, b, taskA, landed } = await takeoverInTheWindow(
    (task) =>
      task.right.act(() =>
        task.github.comment(7, { mark: { kind: 'stage', coordinator: A, claim: 1, stage: 'review' }, text: ['Ревью: круг 1'] }),
      ),
    isCommentOn(7),
  )
  // The window between A's check and its write: the one late write of the former leader lands after the takeover.
  assert.equal((landed as { ok: boolean }).ok, true)
  assert.deepEqual(w.thread(7), ['claim A 1', 'takeover B 2', 'stage A 1'])

  // B leads count 2; its stage comes from the comments of count 2 alone: A's «review» is not its stage.
  assert.deepEqual(b.started.map((task) => [task.count, task.kind, task.stage]), [[2, 'takeover', null]])
  const byB = await b.coordinator.checkProject(PROJECT)
  assert.deepEqual(byB.led, [7])
  assert.deepEqual(b.leading.map((task) => [task.count, task.stage]), [[2, null]])
  assert.deepEqual(w.labels(7), ['agent-queue', WORKING])

  // A's next action re-reads its right: B leads — nothing is written, now or at A's later checks.
  const writtenByA = a.writes().length
  const next = await taskA.right.act(() => taskA.github.addLabels(7, [BLOCKED]))
  assert.deepEqual(next, { ok: false, leader: B, last: 2 })
  for (let check = 0; check < 2; check++) {
    w.clock.advance(5 * MINUTE)
    assert.deepEqual((await a.coordinator.checkProject(PROJECT)).led, [])
  }
  assert.equal(a.writes().length, writtenByA)
  assert.deepEqual(a.lost.map((task) => [task.count, task.reason, task.leader]), [[1, 'newer-count', B]])
  assert.deepEqual(w.thread(7), ['claim A 1', 'takeover B 2', 'stage A 1'])
  assert.deepEqual(w.labels(7), ['agent-queue', WORKING])
})

test('К4.13 (две записи прежнего ведущего): два действия сразу, через разные права одной задачи, и одна проверка дважды → после перехвата проходит не больше одной записи', async () => {
  // Two actions at once: the second waits for the first, and its own check already sees the takeover.
  {
    const w = world()
    w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
    const a = w.computer(A)
    const b = w.computer(B)
    await a.coordinator.checkProject(PROJECT)
    w.clock.advance(5 * MINUTE)
    await a.coordinator.checkProject(PROJECT)
    const [first, second] = [a.started[0], a.leading[0]]
    assert.ok(first && second && first.right !== second.right)
    w.clock.advance(180 * MINUTE)
    const held = holdCall(a.machine, isCommentOn(7))
    const stage = (task: LedTask, text: string) =>
      task.right.act(() => task.github.comment(7, { mark: { kind: 'stage', coordinator: A, claim: 1, stage: 'tests' }, text: [text] }))
    const one = stage(first, 'Прогон 1')
    const two = stage(second, 'Прогон 2')
    await held.reached
    assert.deepEqual(await b.coordinator.claimTask(PROJECT, 7, { kind: 'takeover' }), { kind: 'leads', issue: 7, count: 2 })
    held.release()
    assert.equal((await one).ok, true)
    assert.deepEqual(await two, { ok: false, leader: B, last: 2 })
    assert.deepEqual(w.thread(7), ['claim A 1', 'takeover B 2', 'stage A 1'])
  }
  // One check, two writes: the second write checks again.
  {
    const w = world()
    w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
    const a = w.computer(A)
    await a.coordinator.checkProject(PROJECT)
    const taskA = a.started[0]
    assert.ok(taskA)
    w.clock.advance(180 * MINUTE)
    const check = await taskA.right.check()
    const other = await taskA.right.check()
    assert.equal(check.mine, true)
    const comment = (text: string) => () =>
      taskA.github.comment(7, { mark: { kind: 'stage', coordinator: A, claim: 1, stage: 'tests' }, text: [text] })
    assert.equal((await taskA.right.write(check, comment('Прогон 1'))).ok, true)
    // B's takeover lands at once — the clock does not move: both checks are fresh (under 30 seconds).
    w.mark(7, { kind: 'takeover', coordinator: B, claim: 2 }, 'Перехват')
    // The used check and the one made before that write are both made again.
    assert.deepEqual(await taskA.right.write(check, comment('Прогон 2')), { ok: false, leader: B, last: 2 })
    assert.deepEqual(await taskA.right.write(other, comment('Прогон 3')), { ok: false, leader: B, last: 2 })
    assert.deepEqual(w.thread(7), ['claim A 1', 'stage A 1', 'takeover B 2'])
  }
})

test('К4.13 (блокировка прежнего ведущего): перехват записан между проверкой права и комментарием блокировки прежнего ведущего → блокировка его отсчёта не освобождает отсчёт ведущего, задачу никто не берёт новым отсчётом', async () => {
  const { w, a, b, taskA } = await takeoverInTheWindow(
    (task) =>
      task.right.act(() =>
        task.github.comment(7, { mark: { kind: 'block', coordinator: A, claim: 1 }, text: ['Нужен ответ владельца'] }),
      ),
    isCommentOn(7),
  )
  assert.deepEqual(w.thread(7), ['claim A 1', 'takeover B 2', 'block A 1'])
  // B's count 2 holds: B leads, the task is in work, and a third coordinator does not take it.
  assert.deepEqual((await b.coordinator.checkProject(PROJECT)).led, [7])
  assert.equal(b.lost.length, 0)
  const c = w.computer(X)
  w.clock.advance(UNSETTLED_MS)
  const byX = await c.coordinator.checkProject(PROJECT)
  assert.deepEqual(byX.inWork, [7])
  assert.equal(byX.claimed, null)
  assert.deepEqual(c.writes(), [])
  // A's next action (the label of its block) writes nothing.
  assert.equal((await taskA.right.act(() => taskA.github.addLabels(7, [BLOCKED]))).ok, false)
  assert.deepEqual(w.labels(7), ['agent-queue', WORKING])
  // A's next check: the takeover came before its block — the count was lost, not ended by A: its agents are to stop.
  // Nothing is written.
  const writtenByA = a.writes().length
  w.clock.advance(5 * MINUTE)
  assert.deepEqual((await a.coordinator.checkProject(PROJECT)).led, [])
  assert.deepEqual(a.lost.map((task) => [task.count, task.reason, task.leader]), [[1, 'newer-count', B]])
  assert.equal(a.writes().length, writtenByA)
  assert.deepEqual(w.thread(7), ['claim A 1', 'takeover B 2', 'block A 1'])
})

test('К4.13 (метки): перехват записан между проверкой права и записью метки прежнего ведущего → ведущий приводит метки к своему этапу, прежний ведущий больше ничего не пишет', async () => {
  const { w, a, b, taskA, landed } = await takeoverInTheWindow(
    (task) => task.right.act(() => task.github.addLabels(7, [BLOCKED])),
    isLabelOn(7),
  )
  assert.equal((landed as { ok: boolean }).ok, true)
  assert.deepEqual(w.labels(7), ['agent-queue', BLOCKED, WORKING])
  assert.deepEqual(w.thread(7), ['claim A 1', 'takeover B 2'])

  // B's next check brings the labels to its stage: in work — `working` on, `blocked` off.
  const writtenByB = b.writes().length
  const byB = await b.coordinator.checkProject(PROJECT)
  assert.deepEqual(byB.led, [7])
  assert.deepEqual(w.labels(7), ['agent-queue', WORKING])
  assert.deepEqual(b.writes().slice(writtenByB), [`DELETE issues/7/labels/${encodeURIComponent(BLOCKED)}`])
  assert.deepEqual(b.leading.map((task) => [task.count, task.issue.labels.slice().sort()]), [[2, ['agent-queue', WORKING]]])

  // A writes nothing more.
  const writtenByA = a.writes().length
  assert.equal((await taskA.right.act(() => taskA.github.addLabels(7, [BLOCKED]))).ok, false)
  w.clock.advance(5 * MINUTE)
  assert.deepEqual((await a.coordinator.checkProject(PROJECT)).led, [])
  assert.equal(a.writes().length, writtenByA)
  assert.deepEqual(w.labels(7), ['agent-queue', WORKING])
  assert.deepEqual(w.thread(7), ['claim A 1', 'takeover B 2'])
})

test('К4.13 (метка во время ожидания): запоздалая метка blocked прежнего ведущего пришла, пока новый ведущий ждал 60 секунд → он снимает её до запуска агентов', async () => {
  const w = world()
  w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
  const a = w.computer(A)
  const watch = startedWith(w, 7)
  const b = w.computer(B, { hooks: watch.hooks })
  await a.coordinator.checkProject(PROJECT)
  const taskA = a.started[0]
  assert.ok(taskA)
  w.clock.advance(180 * MINUTE)
  const heldA = holdCall(a.machine, isLabelOn(7))
  const late = taskA.right.act(() => taskA.github.addLabels(7, [BLOCKED]))
  await heldA.reached
  const waitOfB = b.sleep.hold()
  const takeover = b.coordinator.claimTask(PROJECT, 7, { kind: 'takeover' })
  await waitOfB.reached
  // B's takeover is written and the label is on; A's late label lands while B waits.
  heldA.release()
  assert.equal((await late).ok, true)
  assert.deepEqual(w.labels(7), ['agent-queue', BLOCKED, WORKING])
  waitOfB.release()
  assert.deepEqual(await takeover, { kind: 'leads', issue: 7, count: 2 })
  assert.deepEqual(watch.seen.map((one) => one.labels), [['agent-queue', WORKING]])
  assert.deepEqual(w.labels(7), ['agent-queue', WORKING])
})

// ── Who took `working` off (decision «Решение по #15: вопрос») ─────────────────────────────────────────────────────

// A led #7 with count 1 and released it; the removal of its label, admitted by its check, waits on the way. 10 minutes
// later the label is still on: B may take the task with count 2.
async function releasedWithLabelOn() {
  const w = world()
  w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
  const a = w.computer(A)
  await a.coordinator.checkProject(PROJECT)
  const taskA = a.started[0]
  assert.ok(taskA)
  const released = await taskA.right.act(() =>
    taskA.github.comment(7, { mark: { kind: 'release', coordinator: A, claim: 1 }, text: ['Готово'] }),
  )
  assert.equal(released.ok, true)
  const heldA = holdCall(a.machine, isUnlabelOn(7, WORKING))
  const removal = taskA.right.act(() => taskA.github.removeLabel(7, WORKING), { released: true })
  await heldA.reached
  w.clock.advance(UNSETTLED_MS)
  return { w, a, heldA, removal }
}

// The time GitHub created B's claim of count 2 on #7.
function claimTime(w: ReturnType<typeof world>, coordinator: string, count: number): number {
  const comment = w.github.comments.find((one) => {
    const { mark } = parseBody(one.body)
    return mark?.kind !== undefined && ['claim', 'takeover'].includes(mark.kind) && mark.coordinator === coordinator && mark.claim === count
  })
  assert.ok(comment, `claim ${count} of ${coordinator}`)
  return Date.parse(comment.created_at)
}

test('К4.13 (запоздалое снятие working во время ожидания): снятие метки прежним ведущим пришло, пока новый ведущий ждал 60 секунд → метка возвращена, агенты запущены, освобождения нет', async () => {
  const { w, a, heldA, removal } = await releasedWithLabelOn()
  const watch = startedWith(w, 7)
  const b = w.computer(B, { hooks: watch.hooks })
  const waitOfB = b.sleep.hold()
  const check = b.coordinator.checkProject(PROJECT)
  await waitOfB.reached
  // B's claim of count 2 is written, the label left from count 1 is on; A's removal lands now.
  heldA.release()
  assert.equal((await removal).ok, true)
  assert.deepEqual(w.labels(7), ['agent-queue'])
  waitOfB.release()
  assert.deepEqual((await check).claimed, { kind: 'leads', issue: 7, count: 2 })
  assert.deepEqual(watch.seen.map((one) => one.labels), [['agent-queue', WORKING]])
  assert.deepEqual(w.thread(7), ['claim A 1', 'release A 1', 'claim B 2'])
  assert.deepEqual(b.writes(), ['POST issues/7/comments', 'POST issues/7/labels'])
  assert.equal(b.lost.length, 0)
  // A ended its own count: nothing more from it.
  const writtenByA = a.writes().length
  await a.coordinator.checkProject(PROJECT)
  assert.equal(a.writes().length, writtenByA)
})

test('К4.13 (запоздалое снятие working после запуска): снятие прежним ведущим в пределах 3 минут после заявки → на следующей проверке метка возвращена, и после перезапуска решение то же; второе снятие — освобождение', async () => {
  const { w, heldA, removal } = await releasedWithLabelOn()
  const b = w.computer(B)
  assert.deepEqual((await b.coordinator.checkProject(PROJECT)).claimed, { kind: 'leads', issue: 7, count: 2 })
  // B's claim is complete (60 seconds); A's removal lands within the 3 minutes after the claim.
  w.clock.advance(MINUTE)
  heldA.release()
  assert.equal((await removal).ok, true)
  assert.ok(w.clock.now() <= claimTime(w, B, 2) + 3 * MINUTE)
  // Far later than that, B's next check — on a restarted worker — decides by GitHub's times: a late write.
  w.clock.advance(10 * MINUTE)
  const restarted = w.computer(B, { machine: b.machine })
  const writtenByB = restarted.writes().length
  assert.deepEqual((await restarted.coordinator.checkProject(PROJECT)).led, [7])
  assert.deepEqual(w.labels(7), ['agent-queue', WORKING])
  assert.deepEqual(restarted.writes().slice(writtenByB), ['POST issues/7/labels'])
  assert.deepEqual(restarted.leading.map((task) => task.count), [2])
  assert.deepEqual(w.thread(7), ['claim A 1', 'release A 1', 'claim B 2'])
  // A second removal is the owner's: the count is released.
  w.github.setLabel(7, WORKING, false)
  w.clock.advance(5 * MINUTE)
  assert.deepEqual((await restarted.coordinator.checkProject(PROJECT)).led, [])
  assert.deepEqual(w.thread(7), ['claim A 1', 'release A 1', 'claim B 2', 'release B 2'])
  assert.deepEqual(restarted.lost.map((task) => [task.count, task.reason]), [[2, 'released-by-owner']])
})

test('К4.13 (снятие working позже 3 минут после заявки): запоздалое снятие прежнего ведущего, пришедшее позже 3 минут, — освобождение нового отсчёта (принятая цена решения)', async () => {
  const { w, heldA, removal } = await releasedWithLabelOn()
  const b = w.computer(B)
  assert.deepEqual((await b.coordinator.checkProject(PROJECT)).claimed, { kind: 'leads', issue: 7, count: 2 })
  w.clock.advance(claimTime(w, B, 2) + 3 * MINUTE + 1_000 - w.clock.now())
  heldA.release()
  assert.equal((await removal).ok, true)
  w.clock.advance(MINUTE)
  assert.deepEqual((await b.coordinator.checkProject(PROJECT)).led, [])
  assert.deepEqual(w.thread(7), ['claim A 1', 'release A 1', 'claim B 2', 'release B 2'])
  assert.deepEqual(w.labels(7), ['agent-queue'])
})

test('владелец снял working у отсчёта 1 во время ожидания 60 секунд → освобождение без запуска агентов; то же после перезапуска во время ожидания — метка заново не ставится', async () => {
  // In the wait itself.
  {
    const w = world()
    w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
    const a = w.computer(A)
    const waitOfA = a.sleep.hold()
    const check = a.coordinator.checkProject(PROJECT)
    await waitOfA.reached
    w.github.setLabel(7, WORKING, false)
    waitOfA.release()
    const result = await check
    assert.deepEqual(result.claimed, { kind: 'released', issue: 7, count: 1 })
    assert.deepEqual(result.led, [])
    assert.deepEqual(a.started, [])
    assert.equal(a.lost.length, 0)
    assert.deepEqual(w.thread(7), ['claim A 1', 'release A 1'])
    assert.deepEqual(w.labels(7), ['agent-queue'])
  }
  // The worker stops during the wait (its re-read fails); the restarted one decides the same and sets no label.
  {
    const w = world()
    w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
    const a = w.computer(A)
    const waitOfA = a.sleep.hold()
    const check = a.coordinator.checkProject(PROJECT)
    await waitOfA.reached
    w.github.setLabel(7, WORKING, false)
    w.github.fail(isRead('AqIssue', 7), { code: 1, stderr: 'gh: connection reset' })
    waitOfA.release()
    assert.equal((await check).claimed?.kind, 'incomplete')
    const restarted = w.computer(A, { machine: a.machine })
    const writtenByA = restarted.writes().length
    const result = await restarted.coordinator.checkProject(PROJECT)
    assert.deepEqual(result.led, [])
    assert.deepEqual(restarted.started, [])
    assert.deepEqual(restarted.writes().slice(writtenByA), ['POST issues/7/comments'])
    assert.deepEqual(w.thread(7), ['claim A 1', 'release A 1'])
    assert.deepEqual(w.labels(7), ['agent-queue'])
  }
})

test('владелец снял working у отсчёта 2: метку ставил сам заявитель, снятие через минуту; метка осталась от прежнего отсчёта, снятие на 4-й минуте при проверке на 5-й; снятие другим пользователем в первые 3 минуты → освобождение', async () => {
  // count 1 of X, released; `labelled` — whether its label is still on when B claims count 2.
  const setup = (labelLeft: boolean) => {
    const w = world()
    w.github.addIssue({ number: 7, user: OWNER, labels: labelLeft ? ['agent-queue', WORKING] : ['agent-queue'] })
    w.mark(7, { kind: 'claim', coordinator: X, claim: 1 })
    w.mark(7, { kind: 'release', coordinator: X, claim: 1 }, 'Освобождение')
    w.clock.advance(UNSETTLED_MS)
    return w
  }
  const released = (w: ReturnType<typeof world>, b: Computer) => {
    assert.deepEqual(w.thread(7), ['claim X 1', 'release X 1', 'claim B 2', 'release B 2'])
    assert.deepEqual(w.labels(7), ['agent-queue'])
    assert.deepEqual(b.lost.map((task) => [task.count, task.reason]), [[2, 'released-by-owner']])
  }
  // B set the label itself after its claim.
  {
    const w = setup(false)
    const b = w.computer(B)
    assert.deepEqual((await b.coordinator.checkProject(PROJECT)).claimed, { kind: 'leads', issue: 7, count: 2 })
    w.github.setLabel(7, WORKING, false)
    w.clock.advance(MINUTE)
    await b.coordinator.checkProject(PROJECT)
    released(w, b)
  }
  // The label was left from count 1; the owner takes it off in the 4th minute after the claim, B checks in the 5th.
  {
    const w = setup(true)
    const b = w.computer(B)
    assert.deepEqual((await b.coordinator.checkProject(PROJECT)).claimed, { kind: 'leads', issue: 7, count: 2 })
    w.clock.advance(claimTime(w, B, 2) + 4 * MINUTE - w.clock.now())
    w.github.setLabel(7, WORKING, false)
    w.clock.advance(MINUTE)
    await b.coordinator.checkProject(PROJECT)
    released(w, b)
  }
  // The label was left from count 1; another GitHub user takes it off in the first minute.
  {
    const w = setup(true)
    const b = w.computer(B)
    assert.deepEqual((await b.coordinator.checkProject(PROJECT)).claimed, { kind: 'leads', issue: 7, count: 2 })
    w.github.setLabel(7, WORKING, false, 'casey-guest')
    await b.coordinator.checkProject(PROJECT)
    released(w, b)
  }
  // A takeover of a count its leader never released, the label on: the owner's removal in the first minute.
  {
    const w = world()
    w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue', WORKING] })
    w.mark(7, { kind: 'claim', coordinator: X, claim: 1 })
    w.clock.advance(180 * MINUTE)
    const b = w.computer(B)
    assert.deepEqual(await b.coordinator.claimTask(PROJECT, 7, { kind: 'takeover' }), { kind: 'leads', issue: 7, count: 2 })
    w.github.setLabel(7, WORKING, false)
    await b.coordinator.checkProject(PROJECT)
    assert.deepEqual(w.thread(7), ['claim X 1', 'takeover B 2', 'release B 2'])
    assert.deepEqual(b.lost.map((task) => [task.count, task.reason]), [[2, 'released-by-owner']])
  }
})

test('снятие working ещё не видно в истории метки → по задаче ни одной записи; появилось — решается', async () => {
  const w = world()
  w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
  const a = w.computer(A)
  await a.coordinator.checkProject(PROJECT)
  // The label is gone, but GitHub's history does not show its removal yet (the last event is its setting).
  w.issue(7).labels = ['agent-queue']
  const written = a.writes().length
  await a.coordinator.checkProject(PROJECT)
  assert.equal(a.writes().length, written)
  assert.equal(a.leading.length, 0)
  // The removal shows up: the owner's, on count 1 — the count is released.
  w.github.labelEvents.push({
    issue: 7,
    kind: 'unlabeled',
    label: WORKING,
    actor: OWNER,
    created_at: new Date(w.clock.now()).toISOString(),
  })
  await a.coordinator.checkProject(PROJECT)
  assert.deepEqual(w.thread(7), ['claim A 1', 'release A 1'])
})

test('история метки working не прочитана → по задаче ни одной записи и ни шага этапа; решает следующая проверка', async () => {
  const w = world()
  w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue', WORKING] })
  w.mark(7, { kind: 'claim', coordinator: X, claim: 1 })
  w.mark(7, { kind: 'release', coordinator: X, claim: 1 }, 'Освобождение')
  w.clock.advance(UNSETTLED_MS)
  const b = w.computer(B)
  assert.deepEqual((await b.coordinator.checkProject(PROJECT)).claimed, { kind: 'leads', issue: 7, count: 2 })
  // Within the 3 minutes, by the owner's login, the first event since the claim: by GitHub's data a late write.
  w.github.setLabel(7, WORKING, false)
  w.github.fail((call) => call.operation === 'AqLabelEvents', { code: 1, stderr: 'gh: connection reset' })
  const writtenByB = b.writes().length
  const unread = await b.coordinator.checkProject(PROJECT)
  assert.deepEqual(unread.inWork, [7])
  assert.equal(b.writes().length, writtenByB)
  assert.equal(b.leading.length, 0)
  assert.deepEqual(w.labels(7), ['agent-queue'])
  // The next check reads the events and decides.
  await b.coordinator.checkProject(PROJECT)
  assert.deepEqual(w.labels(7), ['agent-queue', WORKING])
  assert.deepEqual(w.thread(7), ['claim X 1', 'release X 1', 'claim B 2'])
  assert.deepEqual(b.leading.map((task) => task.count), [2])
})

// ── The protocol for other targets, and the decision it is made on ─────────────────────────────────────────────────

test('перехват по решению о старом отсчёте: отсчёт, его активность или ход изменились после решения → заявки нет, вызывающий решает заново', async () => {
  const setup = () => {
    const w = world()
    w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue', WORKING] })
    w.mark(7, { kind: 'claim', coordinator: X, claim: 1 })
    w.clock.advance(180 * MINUTE)
    return w
  }
  // B and C decide on the same reading; B takes the task over first.
  {
    const w = setup()
    const b = w.computer(B)
    const c = w.computer(C)
    const expect = expectationOf(await w.claimsOf(7))
    assert.deepEqual(await b.coordinator.claimTask(PROJECT, 7, { kind: 'takeover', expect }), { kind: 'leads', issue: 7, count: 2 })
    assert.deepEqual(await c.coordinator.claimTask(PROJECT, 7, { kind: 'takeover', expect }), {
      kind: 'changed',
      issue: 7,
      reason: 'the last count is 2, not 1',
    })
    assert.deepEqual(c.writes(), [])
    assert.deepEqual(w.thread(7), ['claim X 1', 'takeover B 2'])
  }
  // New progress of the leader, or its deferral, after the decision.
  for (const [mark, reason] of [
    [{ kind: 'stage', coordinator: X, claim: 1, stage: 'tests' }, 'count 1 has new progress'],
    [{ kind: 'deferred', coordinator: X, claim: 1 }, 'count 1 is released now'],
  ] as const) {
    const w = setup()
    const c = w.computer(C)
    const expect = expectationOf(await w.claimsOf(7))
    w.clock.advance(MINUTE)
    w.mark(7, mark)
    assert.deepEqual(await c.coordinator.claimTask(PROJECT, 7, { kind: 'takeover', expect }), { kind: 'changed', issue: 7, reason })
    assert.deepEqual(c.writes(), [])
  }
  // The caller's own condition, on the fresh reading.
  {
    const w = setup()
    const c = w.computer(C)
    const expect = expectationOf(await w.claimsOf(7))
    const seen: number[] = []
    const outcome = await c.coordinator.claimTask(PROJECT, 7, {
      kind: 'takeover',
      expect,
      admit: (target) => {
        seen.push(target.claims.last)
        return 'the leader is not silent long enough'
      },
    })
    assert.deepEqual(outcome, { kind: 'not-free', issue: 7, reason: 'the leader is not silent long enough' })
    assert.deepEqual(seen, [1])
    assert.deepEqual(c.writes(), [])
  }
})

test('протокол отсчётов для других целей: закрытая задача и задача «MVP» берутся по своей проверке вызывающего и со своими метками этапа; без неё — строгие правила очереди', async () => {
  const w = world()
  // A closed task whose leader X went silent during a merge attempt.
  w.github.addIssue({ number: 20, user: OWNER, labels: ['agent-queue', WORKING], state: 'closed' })
  w.mark(20, { kind: 'claim', coordinator: X, claim: 1 })
  // The «MVP» issue, blocked waiting for the owner.
  w.github.addIssue({ number: 21, user: OWNER, labels: ['agent-queue:mvp', BLOCKED] })
  w.clock.advance(180 * MINUTE)
  const a = w.computer(A)

  assert.deepEqual(await a.coordinator.claimTask(PROJECT, 20, { kind: 'takeover' }), { kind: 'not-free', issue: 20, reason: 'closed' })
  assert.deepEqual(await a.coordinator.claimTask(PROJECT, 21), { kind: 'not-free', issue: 21, reason: 'no label agent-queue' })
  assert.deepEqual(a.writes(), [])

  const closed = await a.coordinator.claimTask(PROJECT, 20, {
    kind: 'takeover',
    admit: (target) => (target.issue.state === 'closed' && target.claims.active ? null : 'not a closed task in work'),
  })
  assert.deepEqual(closed, { kind: 'leads', issue: 20, count: 2 })
  assert.deepEqual(w.thread(20), ['claim X 1', 'takeover A 2'])

  const mvp = await a.coordinator.claimTask(PROJECT, 21, { admit: () => null, labels: { on: [], off: [] } })
  assert.deepEqual(mvp, { kind: 'leads', issue: 21, count: 1 })
  assert.deepEqual(w.thread(21), ['claim A 1'])
  assert.deepEqual(w.labels(21), [BLOCKED, 'agent-queue:mvp'])
  assert.deepEqual(a.started.map((task) => [task.issue.number, task.count]), [[20, 2], [21, 1]])
  // A second call on a target it leads writes nothing.
  const written = a.writes().length
  assert.deepEqual(await a.coordinator.claimTask(PROJECT, 21, { admit: () => null, labels: { on: [], off: [] } }), {
    kind: 'leads',
    issue: 21,
    count: 1,
  })
  assert.equal(a.writes().length, written)
})

// ── Further rules of the choice ────────────────────────────────────────────────────────────────────────────────────

test('выбор: самая старая подходящая задача; blocked, split, открытая зависимость и отложение держат задачу, закрытая зависимость — нет', async () => {
  const w = world({ maxInProgress: 5 })
  w.github.addIssue({ number: 3, user: OWNER, labels: ['agent-queue', BLOCKED] })
  w.github.addIssue({ number: 4, user: OWNER, labels: ['agent-queue', 'agent-queue:split'] })
  w.github.addIssue({ number: 5, user: OWNER, labels: ['agent-queue'], body: 'Сделать поиск.\n\nЗависит от #9' })
  w.github.addIssue({ number: 6, user: OWNER, labels: ['agent-queue'] })
  w.mark(6, { kind: 'claim', coordinator: X, claim: 1 })
  w.mark(6, { kind: 'deferred', coordinator: X, claim: 1 }, 'Отложено до 2026-03-02T11:00:00Z')
  w.github.addIssue({ number: 8, user: OWNER, labels: ['agent-queue'], body: 'Depends on #2' })
  w.github.addIssue({ number: 9, user: OWNER, labels: [] })
  w.github.addIssue({ number: 2, user: OWNER, labels: [], state: 'closed' })
  const a = w.computer(A)
  const result = await a.coordinator.checkProject(PROJECT)
  assert.deepEqual(result.skipped, [
    { issue: 3, reason: 'blocked' },
    { issue: 4, reason: 'split' },
    { issue: 5, reason: 'depends on #9: open' },
    { issue: 6, reason: 'deferred' },
  ])
  assert.deepEqual(result.claimed, { kind: 'leads', issue: 8, count: 1 })

  // The deferral holds one hour from its comment; then the task is taken with a new count.
  const deferredAt = Date.parse(w.github.comments.find((one) => one.body.includes('"deferred"'))?.created_at ?? '')
  w.clock.advance(deferredAt + DEFERRAL_MS - MINUTE - w.clock.now())
  const early = await a.coordinator.checkProject(PROJECT)
  assert.ok(early.skipped.some((one) => one.issue === 6 && one.reason === 'deferred'), JSON.stringify(early.skipped))
  w.clock.advance(MINUTE)
  const later = await a.coordinator.checkProject(PROJECT)
  assert.deepEqual(later.claimed, { kind: 'leads', issue: 6, count: 2 })
  assert.deepEqual(w.thread(6), ['claim X 1', 'deferred X 1', 'claim A 2'])
})

test('выбор на свежем чтении: зависимость, дописанная между выбором и заявкой, и правило выбора, отказавшее перед заявкой, держат задачу — берётся следующая', async () => {
  const w = world({ maxInProgress: 5 })
  w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'], body: 'Поиск по каталогу' })
  w.github.addIssue({ number: 8, user: OWNER, labels: ['agent-queue'] })
  w.github.addIssue({ number: 9, user: OWNER, labels: ['agent-queue'] })
  w.github.addIssue({ number: 12, user: OWNER, labels: [] })
  // The owner adds a dependency on the open #12 after the check read the list, before the claim reads #7 again.
  w.github.before(isRead('AqIssue', 7), () => {
    w.issue(7).body = 'Поиск по каталогу\n\nЗависит от #12'
  })
  // A rule of the choice that holds #8 on the fresh reading only (an operation started meanwhile).
  const phases: string[] = []
  const rule: ChoiceRule = (task, context) => {
    if (task.issue.number !== 8) return null
    phases.push(context.phase)
    return context.phase === 'claim' ? 'created by an unfinished operation' : null
  }
  const a = w.computer(A, { rules: [rule] })
  const result = await a.coordinator.checkProject(PROJECT)
  assert.deepEqual(result.claimed, { kind: 'leads', issue: 9, count: 1 })
  assert.deepEqual(result.skipped, [
    { issue: 7, reason: 'depends on #12: open' },
    { issue: 8, reason: 'created by an unfinished operation' },
  ])
  assert.deepEqual(phases, ['choice', 'claim'])
  assert.deepEqual([w.thread(7), w.thread(8), w.thread(9)], [[], [], ['claim A 1']])
})

// ── Its own counts: release and loss ───────────────────────────────────────────────────────────────────────────────

test('владелец снял `working` у задачи в работе → ведущий пишет «освобождение» своего отсчёта и в эту проверку задачу снова не берёт', async () => {
  const w = world()
  w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
  const a = w.computer(A)
  assert.deepEqual((await a.coordinator.checkProject(PROJECT)).claimed, { kind: 'leads', issue: 7, count: 1 })
  // The owner takes `working` off on GitHub.
  w.github.setLabel(7, WORKING, false)
  w.clock.advance(5 * MINUTE)
  const result = await a.coordinator.checkProject(PROJECT)
  assert.equal(result.claimed, null)
  assert.deepEqual(result.led, [])
  assert.deepEqual(w.thread(7), ['claim A 1', 'release A 1'])
  const release = parseBody(w.github.comments.at(-1)?.body ?? '')
  assert.match(release.text, /^Освобождение: метку agent-queue:working сняли; координатор 0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d больше не ведёт задачу \(отсчёт 1\)\.$/)
  assert.deepEqual(w.labels(7), ['agent-queue'])
  assert.deepEqual(a.lost.map((task) => [task.count, task.reason]), [[1, 'released-by-owner']])
})

test('потеря и освобождение отсчёта: хук lost, упавший один раз, повторяется на следующей проверке и после перезапуска — и у задачи, ушедшей из очереди; освобождение с потерянным ответом доводится без второго комментария', async () => {
  // A computer leading #7, with #1 in work by X afterwards: with the limit 1 the released #7 is not taken again.
  const leading = async (hooks: CoordinatorHooks = {}) => {
    const w = world({ maxInProgress: 1 })
    w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
    const a = w.computer(A, { hooks })
    assert.deepEqual((await a.coordinator.checkProject(PROJECT)).claimed, { kind: 'leads', issue: 7, count: 1 })
    w.github.addIssue({ number: 1, user: OWNER, labels: ['agent-queue', WORKING] })
    w.mark(1, { kind: 'claim', coordinator: X, claim: 1 })
    return { w, a }
  }
  const failingOnce = (what: string): CoordinatorHooks => {
    let failures = 1
    return {
      lost: () => {
        if (failures-- > 0) throw new Error(what)
      },
    }
  }
  // The hook fails once; the release is written once.
  {
    const { w, a } = await leading(failingOnce('the agent did not stop'))
    // The owner takes `working` off on GitHub.
    w.github.setLabel(7, WORKING, false)
    w.clock.advance(5 * MINUTE)
    await a.coordinator.checkProject(PROJECT)
    assert.equal(a.lost.length, 0)
    assert.deepEqual(w.thread(7), ['claim A 1', 'release A 1'])
    // The worker restarts: its next check runs the handling again — once it succeeds, never again.
    const restarted = w.computer(A, { machine: a.machine })
    for (let check = 0; check < 3; check++) {
      w.clock.advance(5 * MINUTE)
      await restarted.coordinator.checkProject(PROJECT)
    }
    assert.deepEqual(restarted.lost.map((task) => [task.count, task.reason]), [[1, 'released-by-owner']])
    assert.deepEqual(w.thread(7), ['claim A 1', 'release A 1'])
    assert.deepEqual(w.labels(7), ['agent-queue'])
  }
  // The release reaches GitHub, its answer is lost.
  {
    const { w, a } = await leading()
    // The owner takes `working` off on GitHub.
    w.github.setLabel(7, WORKING, false)
    w.clock.advance(5 * MINUTE)
    w.github.fail(isCommentOn(7), BAD_GATEWAY, { apply: true })
    await a.coordinator.checkProject(PROJECT)
    assert.equal(a.lost.length, 0)
    assert.deepEqual(w.thread(7), ['claim A 1', 'release A 1'])
    w.clock.advance(5 * MINUTE)
    await a.coordinator.checkProject(PROJECT)
    assert.deepEqual(a.lost.map((task) => [task.count, task.reason]), [[1, 'released-by-owner']])
    assert.deepEqual(w.thread(7), ['claim A 1', 'release A 1'])
  }
  // A count lost to a takeover: the hook fails once; meanwhile the owner closes the task — the handling still runs.
  {
    const { w, a } = await leading(failingOnce('the work was not saved'))
    const b = w.computer(B)
    w.clock.advance(180 * MINUTE)
    assert.deepEqual(await b.coordinator.claimTask(PROJECT, 7, { kind: 'takeover' }), { kind: 'leads', issue: 7, count: 2 })
    await a.coordinator.checkProject(PROJECT)
    assert.equal(a.lost.length, 0)
    w.issue(7).state = 'closed'
    await a.coordinator.checkProject(PROJECT)
    await a.coordinator.checkProject(PROJECT)
    assert.deepEqual(a.lost.map((task) => [task.count, task.reason, task.leader]), [[1, 'newer-count', B]])
  }
})

test('отсчёт, который координатор закончил сам (своя блокировка до нового отсчёта), — не потеря: новый отсчёт другого координатора не зовёт остановку его агентов', async () => {
  const w = world()
  w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
  const a = w.computer(A)
  const b = w.computer(B)
  assert.deepEqual((await a.coordinator.checkProject(PROJECT)).claimed, { kind: 'leads', issue: 7, count: 1 })
  const taskA = a.started[0]
  assert.ok(taskA)
  // A blocks the task (Ф6): the block of its count, then the labels of the block — its own release allows them.
  const blocked = await taskA.right.act(() =>
    taskA.github.comment(7, { mark: { kind: 'block', coordinator: A, claim: 1 }, text: ['Нужен ответ владельца'] }),
  )
  assert.equal(blocked.ok, true)
  assert.equal((await taskA.right.act(() => taskA.github.addLabels(7, [BLOCKED]))).ok, false)
  assert.equal((await taskA.right.act(() => taskA.github.addLabels(7, [BLOCKED]), { released: true })).ok, true)
  assert.equal((await taskA.right.act(() => taskA.github.removeLabel(7, WORKING), { released: true })).ok, true)
  // The owner answers and takes `blocked` off; B takes the task with count 2.
  w.github.setLabel(7, BLOCKED, false)
  assert.deepEqual((await b.coordinator.checkProject(PROJECT)).claimed, { kind: 'leads', issue: 7, count: 2 })
  await a.coordinator.checkProject(PROJECT)
  assert.equal(a.lost.length, 0)
  assert.deepEqual(w.thread(7), ['claim A 1', 'block A 1', 'claim B 2'])
})

test('очередь проекта остановлена → новая задача не берётся, а своя незавершённая заявка завершается: метка после сбоя ставится, агенты запускаются', async () => {
  const w = world({ maxInProgress: 3 })
  w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
  w.github.addIssue({ number: 8, user: OWNER, labels: ['agent-queue'] })
  const a = w.computer(A)
  w.github.fail(isLabelOn(7), BAD_GATEWAY)
  assert.equal((await a.coordinator.checkProject(PROJECT)).claimed?.kind, 'incomplete')
  const stopped = w.computer(A, { machine: a.machine, stopped: true })
  const result = await stopped.coordinator.checkProject(PROJECT)
  assert.equal(result.claimed, null)
  assert.deepEqual(result.led, [7])
  assert.deepEqual(w.labels(7), ['agent-queue', WORKING])
  assert.deepEqual(stopped.started.map((task) => task.issue.number), [7])
  assert.deepEqual(w.thread(8), [])
})

test('GitHub не прочитан → проверка проекта — ошибка, а не пустая очередь: ничего не взято и не записано', async () => {
  const w = world()
  w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
  const a = w.computer(A)
  w.github.fail((call) => call.operation === 'AqIssues', { code: 1, stderr: 'gh: connection reset' })
  const result = await a.coordinator.checkProject(PROJECT)
  assert.equal(result.claimed, null)
  assert.match(result.error ?? '', /connection reset/)
  assert.deepEqual(a.writes(), [])
  assert.ok(a.logs.some((line) => line.includes('the queue was not checked')), JSON.stringify(a.logs))
})

test('текст заявки — на языке проекта, id координатора и отсчёт — поля координатора: маска их не трогает', async () => {
  // A forbidden-data pattern that matches the start of A's id: in a plain text it would be hidden.
  const w = world({ language: 'en', forbiddenPatterns: ['0a1b2c3d'] })
  w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
  const a = w.computer(A)
  await a.coordinator.checkProject(PROJECT)
  const claim = parseBody(w.github.comments[0]?.body ?? '')
  assert.deepEqual(claim.mark, { kind: 'claim', coordinator: A, claim: 1 })
  assert.equal(claim.text, `Claimed by coordinator ${A}, claim count 1.`)
  // The re-read after REREAD_AFTER_MS: the fake clock moved by it.
  assert.ok(w.clock.now() >= START + REREAD_AFTER_MS)
})

// ── Round 3 of the review: the limit, the admission's age, one start, the switch, the caller's claims ──────────────

test('К4.2 (занятая перед заявкой): предел 1, задачи #1 и #2 свободны при чтении проверки, другой координатор взял #1 до свежего чтения → #2 не берётся', async () => {
  const w = world({ maxInProgress: 1 })
  w.github.addIssue({ number: 1, user: OWNER, labels: ['agent-queue'] })
  w.github.addIssue({ number: 2, user: OWNER, labels: ['agent-queue'] })
  // X claims #1 after A's check read the list, before A reads #1 again for its claim.
  w.github.before(isRead('AqIssue', 1), () => {
    w.mark(1, { kind: 'claim', coordinator: X, claim: 1 })
  })
  const a = w.computer(A)
  const result = await a.coordinator.checkProject(PROJECT)
  assert.equal(result.claimed, null)
  assert.deepEqual(result.inWork, [1])
  assert.deepEqual(result.skipped, [
    { issue: 1, reason: 'the last count is 1, not 0' },
    { issue: 2, reason: 'limit: 1 of 1 in work' },
  ])
  assert.deepEqual(a.writes(), [])
})

test('К4.2 (повтор уборки старого отсчёта): уборка освобождённого раньше отсчёта повторяется, а задачу уже взял другой новым отсчётом → она в работе, вторая задача при пределе 1 не берётся', async () => {
  const w = world({ maxInProgress: 1 })
  w.github.addIssue({ number: 1, user: OWNER, labels: ['agent-queue'] })
  let failures = 1
  const a = w.computer(A, {
    hooks: {
      lost: () => {
        if (failures-- > 0) throw new Error('the agent did not stop')
      },
    },
  })
  const b = w.computer(B)
  await a.coordinator.checkProject(PROJECT)
  // The owner takes `working` off: A releases count 1, its handling fails.
  w.github.setLabel(1, WORKING, false)
  w.clock.advance(5 * MINUTE)
  await a.coordinator.checkProject(PROJECT)
  assert.equal(a.lost.length, 0)
  // B takes #1 with count 2; then #2 comes.
  assert.deepEqual((await b.coordinator.claimTask(PROJECT, 1)).kind, 'leads')
  w.github.addIssue({ number: 2, user: OWNER, labels: ['agent-queue'] })
  const result = await a.coordinator.checkProject(PROJECT)
  assert.deepEqual(a.lost.map((task) => [task.count, task.reason]), [[1, 'released-by-owner']])
  assert.deepEqual(result.inWork, [1])
  assert.equal(result.claimed, null)
  assert.deepEqual(result.skipped.at(-1), { issue: 2, reason: 'limit: 1 of 1 in work' })
  assert.deepEqual(w.thread(2), [])
})

test('заявка после долгого допуска: допуск дольше 30 секунд, а другой координатор за это время взял задачу → заявки нет; без изменений — заявка по свежему перечитыванию', async () => {
  // The caller's own admission takes 31 seconds; X claims meanwhile.
  {
    const w = world()
    w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
    const a = w.computer(A)
    const outcome = await a.coordinator.claimTask(PROJECT, 7, {
      admit: async () => {
        w.clock.advance(31_000)
        w.mark(7, { kind: 'claim', coordinator: X, claim: 1 })
        return null
      },
    })
    assert.deepEqual(outcome, { kind: 'changed', issue: 7, reason: 'changed during the admission: the last count is 1, not 0' })
    assert.deepEqual(a.writes(), [])
  }
  // The same 31 seconds with nothing changed: the claim goes on.
  {
    const w = world()
    w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
    const a = w.computer(A)
    const outcome = await a.coordinator.claimTask(PROJECT, 7, {
      admit: async () => {
        w.clock.advance(31_000)
        return null
      },
    })
    assert.deepEqual(outcome, { kind: 'leads', issue: 7, count: 1 })
  }
  // The queue's own admission: the dependency read right before the claim is slow, and X claims the task meanwhile.
  {
    const w = world({ maxInProgress: 1 })
    w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'], body: 'Зависит от #12' })
    w.github.addIssue({ number: 8, user: OWNER, labels: ['agent-queue'] })
    w.github.addIssue({ number: 12, user: OWNER, labels: [], state: 'closed' })
    let reads = 0
    w.github.before(
      (call) => call.operation === 'AqIssue' && Number(call.variables.number) === 12 && ++reads === 2,
      () => {
        w.clock.advance(31_000)
        w.mark(7, { kind: 'claim', coordinator: X, claim: 1 })
      },
    )
    const a = w.computer(A)
    const result = await a.coordinator.checkProject(PROJECT)
    assert.equal(result.claimed, null)
    assert.deepEqual(result.skipped, [
      { issue: 7, reason: 'changed during the admission: the last count is 1, not 0' },
      { issue: 8, reason: 'limit: 1 of 1 in work' },
    ])
    assert.deepEqual(a.writes(), [])
  }
})

test('одно завершение отсчёта: проверка очереди ждёт 60 секунд, а claimTask того же координатора завершает тот же отсчёт → агенты запускаются один раз; так же для второго воркера на том же каталоге данных', async () => {
  // One coordinator, two completions at once.
  {
    const w = world()
    w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
    const a = w.computer(A)
    w.github.fail(isLabelOn(7), BAD_GATEWAY)
    assert.equal((await a.coordinator.checkProject(PROJECT)).claimed?.kind, 'incomplete')
    const waitOfA = a.sleep.hold()
    const check = a.coordinator.checkProject(PROJECT)
    await waitOfA.reached
    const reads = () => a.machine.starts.map(readCall).filter(isRead('AqIssue', 7)).length
    const before = reads()
    const asked = a.coordinator.claimTask(PROJECT, 7)
    // The second call reads the task once (its claim step), then joins the completion under way.
    for (let turn = 0; turn < 100 && reads() === before; turn++) await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(reads(), before + 1)
    waitOfA.release()
    const [checked, claimed] = await Promise.all([check, asked])
    assert.deepEqual(checked.led, [7])
    assert.deepEqual(claimed, { kind: 'leads', issue: 7, count: 1 })
    assert.deepEqual(a.started.map((task) => task.count), [1])
    // One completion: one re-read after the wait, and no wait and re-read of a second one.
    assert.equal(reads(), before + 2)
  }
  // Two workers on one data directory: only the one that records the lead first starts the agents.
  {
    const w = world()
    w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
    const a = w.computer(A)
    w.github.fail(isLabelOn(7), BAD_GATEWAY)
    assert.equal((await a.coordinator.checkProject(PROJECT)).claimed?.kind, 'incomplete')
    const first = w.computer(A, { machine: a.machine })
    const second = w.computer(A, { machine: a.machine })
    const waitOfFirst = first.sleep.hold()
    const one = first.coordinator.checkProject(PROJECT)
    await waitOfFirst.reached
    assert.deepEqual((await second.coordinator.checkProject(PROJECT)).led, [7])
    waitOfFirst.release()
    assert.deepEqual((await one).led, [7])
    assert.deepEqual([first.started.length, second.started.length], [0, 1])
  }
})

test('координатор выключен во время проверки задачи → перед поправкой меток и перед шагом этапа ничего не делается; включён снова — продолжает', async () => {
  // Off right after the check of the task began: the label of its stage is not fixed, the stage does not go on.
  const setup = async () => {
    const w = world()
    w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
    const a = w.computer(A)
    await a.coordinator.checkProject(PROJECT)
    return { w, a }
  }
  const onFor = (calls: number) => {
    let asked = 0
    return async () => ++asked <= calls
  }
  {
    const { w, a } = await setup()
    w.github.setLabel(7, BLOCKED, true)
    const written = a.writes().length
    const result = await a.coordinator.checkProject(PROJECT, { enabled: onFor(1) })
    assert.deepEqual(result.led, [7])
    assert.equal(a.writes().length, written)
    assert.deepEqual(w.labels(7), ['agent-queue', BLOCKED, WORKING])
    assert.equal(a.leading.length, 0)
    // On again: the label of its stage is fixed and the stage goes on.
    await a.coordinator.checkProject(PROJECT, { enabled: async () => true })
    assert.deepEqual(w.labels(7), ['agent-queue', WORKING])
    assert.deepEqual(a.leading.map((task) => task.count), [1])
  }
  {
    const { a } = await setup()
    const written = a.writes().length
    await a.coordinator.checkProject(PROJECT, { enabled: onFor(1) })
    assert.equal(a.writes().length, written)
    assert.equal(a.leading.length, 0)
  }
  // Off before the check reached the task: nothing of it is read further or done.
  {
    const { a } = await setup()
    const result = await a.coordinator.checkProject(PROJECT, { enabled: onFor(0) })
    assert.deepEqual([result.led, result.claimed], [[], null])
    assert.equal(a.leading.length, 0)
  }
})

test('восстановление заявки вызывающего: свой профиль меток и владелец восстановления сохраняются с заявкой — проверка очереди её не трогает, вызывающий завершает её повторным вызовом; профиль очереди — проверка завершает с сохранёнными метками', async () => {
  const none = { on: [], off: [] }
  // A task of the queue's list, claimed by a caller with its own (empty) labels, the caller owning its recovery.
  {
    const w = world()
    w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue', BLOCKED] })
    const a = w.computer(A)
    const options = { admit: () => null, labels: none, recovery: 'caller' as const }
    // The re-read after the wait fails.
    const outcome = await (async () => {
      const waitOfA = a.sleep.hold()
      const claim = a.coordinator.claimTask(PROJECT, 7, options)
      await waitOfA.reached
      w.github.fail(isRead('AqIssue', 7), { code: 1, stderr: 'gh: connection reset' })
      waitOfA.release()
      return claim
    })()
    assert.equal(outcome.kind, 'incomplete')
    const restarted = w.computer(A, { machine: a.machine })
    const written = restarted.writes().length
    await restarted.coordinator.checkProject(PROJECT)
    assert.equal(restarted.writes().length, written)
    assert.equal(restarted.started.length, 0)
    assert.deepEqual(w.labels(7), ['agent-queue', BLOCKED])
    assert.deepEqual(await restarted.coordinator.claimTask(PROJECT, 7, options), { kind: 'leads', issue: 7, count: 1 })
    assert.deepEqual(restarted.started.map((task) => task.count), [1])
    assert.deepEqual(w.labels(7), ['agent-queue', BLOCKED])
    assert.deepEqual(w.thread(7), ['claim A 1'])
  }
  // The same claim with the queue owning its recovery: the check completes it with the labels kept with the claim.
  {
    const w = world()
    w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue', BLOCKED] })
    const a = w.computer(A)
    const waitOfA = a.sleep.hold()
    const claim = a.coordinator.claimTask(PROJECT, 7, { admit: () => null, labels: none })
    await waitOfA.reached
    w.github.fail(isRead('AqIssue', 7), { code: 1, stderr: 'gh: connection reset' })
    waitOfA.release()
    assert.equal((await claim).kind, 'incomplete')
    const restarted = w.computer(A, { machine: a.machine })
    assert.deepEqual((await restarted.coordinator.checkProject(PROJECT)).led, [7])
    assert.deepEqual(restarted.started.map((task) => task.count), [1])
    assert.deepEqual(w.labels(7), ['agent-queue', BLOCKED])
  }
  // A closed task taken over by a caller: after a failure and a restart the caller's next call completes the same count.
  {
    const w = world()
    w.github.addIssue({ number: 20, user: OWNER, labels: ['agent-queue', WORKING], state: 'closed' })
    w.mark(20, { kind: 'claim', coordinator: X, claim: 1 })
    w.clock.advance(180 * MINUTE)
    const a = w.computer(A)
    const options = {
      kind: 'takeover' as const,
      admit: (target: { readonly issue: { readonly state: string } }) => (target.issue.state === 'closed' ? null : 'open'),
      recovery: 'caller' as const,
    }
    const waitOfA = a.sleep.hold()
    const claim = a.coordinator.claimTask(PROJECT, 20, options)
    await waitOfA.reached
    w.github.fail(isRead('AqIssue', 20), { code: 1, stderr: 'gh: connection reset' })
    waitOfA.release()
    assert.equal((await claim).kind, 'incomplete')
    const restarted = w.computer(A, { machine: a.machine })
    assert.deepEqual(await restarted.coordinator.claimTask(PROJECT, 20, options), { kind: 'leads', issue: 20, count: 2 })
    assert.deepEqual(w.thread(20), ['claim X 1', 'takeover A 2'])
    assert.deepEqual(restarted.started.map((task) => [task.issue.number, task.count]), [[20, 2]])
  }
})

test('свой отсчёт, законченный блокировкой, у закрытой задачи — без повторных чтений вне очереди', async () => {
  const w = world()
  w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
  const a = w.computer(A)
  await a.coordinator.checkProject(PROJECT)
  const taskA = a.started[0]
  assert.ok(taskA)
  assert.equal(
    (await taskA.right.act(() => taskA.github.comment(7, { mark: { kind: 'block', coordinator: A, claim: 1 }, text: ['Вопрос'] }))).ok,
    true,
  )
  // The owner closes the task before A's next check.
  w.issue(7).state = 'closed'
  await a.coordinator.checkProject(PROJECT)
  const readsOf7 = () =>
    a.machine.starts.map(readCall).filter((call) => Number(call.variables.number) === 7 || call.path.includes('/issues/7')).length
  const reads = readsOf7()
  for (let check = 0; check < 3; check++) {
    w.clock.advance(5 * MINUTE)
    await a.coordinator.checkProject(PROJECT)
  }
  assert.equal(readsOf7(), reads)
  assert.equal(a.lost.length, 0)
})

// ── Round 4 of the review (decision «Решение по #15: ревью») ────────────────────────────────────────────────────────

// A computer of `w` whose files take `ms` on the fake clock to create a file whose path ends with `suffix` — the
// first time only — and run `meanwhile` then.
function slowFile(w: ReturnType<typeof world>, machine: FakeMachine, suffix: RegExp, meanwhile: () => void = () => {}) {
  const create = machine.createText.bind(machine)
  let slowed = false
  machine.createText = async (path: string, text: string) => {
    if (!slowed && suffix.test(path)) {
      slowed = true
      w.clock.advance(31_000)
      meanwhile()
    }
    return create(path, text)
  }
}

// A leader of #7 (count 1, complete) and its world.
async function leaderOf7(hooks: CoordinatorHooks = {}) {
  const w = world()
  w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
  const a = w.computer(A, { hooks })
  assert.deepEqual((await a.coordinator.checkProject(PROJECT)).claimed, { kind: 'leads', issue: 7, count: 1 })
  return { w, a }
}

const takeover = (w: ReturnType<typeof world>) => w.mark(7, { kind: 'takeover', coordinator: B, claim: 2 }, 'Перехват')

test('право на действие (п. 1): чтение выключателя перед записью метки ведущего заняло 31 секунду (и 20 секунд), за это время задачу перехватили → прежний ведущий ничего не пишет', async () => {
  // 31 seconds, as the decision names it; 20 seconds — within the 30 seconds of a check: the check comes after the switch.
  for (const delay of [31_000, 20_000]) {
    const { w, a } = await leaderOf7()
    w.github.setLabel(7, BLOCKED, true)
    let calls = 0
    const enabled = async () => {
      // The first ask is before the task; the second right before the write of the label of its stage.
      if (++calls === 2) {
        w.clock.advance(delay)
        takeover(w)
      }
      return true
    }
    const written = a.writes().length
    await a.coordinator.checkProject(PROJECT, { enabled })
    assert.equal(a.writes().length, written, `${delay}`)
    assert.deepEqual(w.labels(7), ['agent-queue', BLOCKED, WORKING])
    assert.equal(a.leading.length, 0)
  }
})

test('право на действие (п. 1): чтение заявок проверки права заняло 31 секунду → записи в этот проход нет, следующая проверка её делает', async () => {
  const { w, a } = await leaderOf7()
  w.github.setLabel(7, BLOCKED, true)
  let reads = 0
  w.github.before(
    (call) => call.operation === 'AqComments' && Number(call.variables.number) === 7 && ++reads === 2,
    () => w.clock.advance(31_000),
  )
  const written = a.writes().length
  await a.coordinator.checkProject(PROJECT)
  assert.equal(a.writes().length, written)
  assert.ok(a.logs.some((line) => line.includes('took longer than 30 seconds')), JSON.stringify(a.logs))
  assert.equal(a.leading.length, 0)
  await a.coordinator.checkProject(PROJECT)
  assert.deepEqual(w.labels(7), ['agent-queue', WORKING])
  assert.deepEqual(a.leading.map((task) => task.count), [1])
})

test('заявка (п. 1): запись профиля попытки заняла 31 секунду и за это время задачу взял другой → POST не уходит, changed; без чужой заявки — заявка по перечитанному', async () => {
  {
    const w = world()
    w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
    const a = w.computer(A)
    slowFile(w, a.machine, /profile-1$/, () => w.mark(7, { kind: 'claim', coordinator: X, claim: 1 }))
    assert.deepEqual(await a.coordinator.claimTask(PROJECT, 7), {
      kind: 'changed',
      issue: 7,
      reason: 'changed during the admission: the last count is 1, not 0',
    })
    assert.deepEqual(a.writes(), [])
  }
  {
    const w = world()
    w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
    const a = w.computer(A)
    slowFile(w, a.machine, /profile-1$/)
    assert.deepEqual(await a.coordinator.claimTask(PROJECT, 7), { kind: 'leads', issue: 7, count: 1 })
    assert.deepEqual(w.thread(7), ['claim A 1'])
  }
})

test('первая метка и уступка (п. 1): чтение выключателя 31 секунду перед первой меткой и перед уступкой → записи нет, следующая проверка пишет', async () => {
  // The first label.
  {
    const w = world()
    w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
    const a = w.computer(A)
    let slowed = false
    const enabled = async () => {
      if (!slowed && w.github.comments.length > 0 && !w.labels(7).includes(WORKING)) {
        slowed = true
        w.clock.advance(31_000)
      }
      return true
    }
    const first = await a.coordinator.checkProject(PROJECT, { enabled })
    assert.equal(first.claimed?.kind, 'incomplete')
    assert.deepEqual(w.labels(7), ['agent-queue'])
    assert.deepEqual(a.started, [])
    assert.deepEqual((await a.coordinator.checkProject(PROJECT, { enabled })).led, [7])
    assert.deepEqual(w.labels(7), ['agent-queue', WORKING])
    assert.equal(a.started.length, 1)
  }
  // The notice.
  {
    const { w, b } = await loserWithoutNotice()
    let calls = 0
    const enabled = async () => {
      // The first ask is before the task; the second right before the notice.
      if (++calls === 2) w.clock.advance(31_000)
      return true
    }
    const written = b.writes().length
    await b.coordinator.checkProject(PROJECT, { enabled })
    assert.equal(b.writes().length, written)
    await b.coordinator.checkProject(PROJECT)
    assert.deepEqual(w.thread(7), ['claim A 1', 'claim B 1', 'yield B 1: Задачу ведёт A.'])
  }
})

test('запуск агентов (п. 2): перехват после перечитывания завершения → started нет, led нет, прежний ведущий ничего не пишет; запись led 31 секунду с перехватом → started нет, на следующей проверке lost', async () => {
  // A takeover between the re-read and the start: nothing to fix in the labels.
  {
    const w = world()
    w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
    const a = w.computer(A)
    let done = false
    const enabled = async () => {
      // The switch asked right before the start, after the wait.
      if (!done && w.clock.now() >= START + REREAD_AFTER_MS) {
        done = true
        takeover(w)
      }
      return true
    }
    const result = await a.coordinator.checkProject(PROJECT, { enabled })
    assert.deepEqual(result.claimed, { kind: 'yielded', issue: 7, count: 1, leader: B })
    assert.deepEqual(a.started, [])
    const written = a.writes().length
    await a.coordinator.checkProject(PROJECT)
    assert.equal(a.writes().length, written)
    assert.equal(a.lost.length, 0)
    assert.deepEqual(a.started, [])
  }
  // The record of the lead takes 31 seconds; the task is taken over meanwhile.
  {
    const w = world()
    w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
    const a = w.computer(A)
    slowFile(w, a.machine, /[\\/]led$/, () => takeover(w))
    const result = await a.coordinator.checkProject(PROJECT)
    assert.deepEqual(result.claimed, { kind: 'yielded', issue: 7, count: 1, leader: B })
    assert.deepEqual(a.started, [])
    await a.coordinator.checkProject(PROJECT)
    assert.deepEqual(a.lost.map((task) => [task.count, task.reason, task.leader]), [[1, 'newer-count', B]])
  }
})

test('продолжение этапа (п. 2): перехват после чтения задач проверки → leading нет, на следующей проверке lost один раз; без перехвата оба хука получают этап по свежему чтению', async () => {
  {
    const { w, a } = await leaderOf7()
    let calls = 0
    const enabled = async () => {
      // The first ask is before the task; the second right before the next step of the stage.
      if (++calls === 2) takeover(w)
      return true
    }
    await a.coordinator.checkProject(PROJECT, { enabled })
    assert.equal(a.leading.length, 0)
    for (let check = 0; check < 2; check++) await a.coordinator.checkProject(PROJECT)
    assert.equal(a.leading.length, 0)
    assert.deepEqual(a.lost.map((task) => [task.count, task.reason]), [[1, 'newer-count']])
  }
  // The stage from the reading that confirms the right: a stage comment that came after the reading of the check.
  {
    const w = world()
    w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
    const a = w.computer(A)
    const stage = (name: 'executor' | 'tests') => w.mark(7, { kind: 'stage', coordinator: A, claim: 1, stage: name })
    let started = false
    const atStart = async () => {
      if (!started && w.clock.now() >= START + REREAD_AFTER_MS) {
        started = true
        stage('executor')
      }
      return true
    }
    await a.coordinator.checkProject(PROJECT, { enabled: atStart })
    assert.deepEqual(a.started.map((task) => task.stage), ['executor'])
    let calls = 0
    const atLeading = async () => {
      if (++calls === 2) stage('tests')
      return true
    }
    await a.coordinator.checkProject(PROJECT, { enabled: atLeading })
    assert.deepEqual(a.leading.map((task) => task.stage), ['tests'])
  }
})

test('профиль попытки заявки (п. 3): POST заявки отклонён → следующая попытка с другим профилем живёт по своему; POST принят, ответ потерян → тот же отсчёт завершается своим профилем, второй заявки нет', async () => {
  const none = { on: [], off: [] }
  const caller = { admit: () => null, labels: none, recovery: 'caller' as const }
  // The caller's attempt is refused; the queue then takes the task with the same count — as the queue's.
  {
    const w = world()
    w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
    const a = w.computer(A)
    w.github.fail(isCommentOn(7), BAD_GATEWAY)
    assert.equal((await a.coordinator.claimTask(PROJECT, 7, caller)).kind, 'failed')
    assert.deepEqual(w.thread(7), [])
    assert.deepEqual((await a.coordinator.checkProject(PROJECT)).claimed, { kind: 'leads', issue: 7, count: 1 })
    assert.deepEqual(w.labels(7), ['agent-queue', WORKING])
    assert.equal(a.started.length, 1)
    await a.coordinator.checkProject(PROJECT)
    assert.deepEqual(a.leading.map((task) => task.count), [1])
  }
  // The reverse: the queue's attempt is refused; the caller's attempt with its empty labels is then the claim's.
  {
    const w = world()
    w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
    const a = w.computer(A)
    w.github.fail(isCommentOn(7), BAD_GATEWAY)
    assert.equal((await a.coordinator.checkProject(PROJECT)).claimed?.kind, 'failed')
    w.github.setLabel(7, BLOCKED, true)
    assert.deepEqual(await a.coordinator.claimTask(PROJECT, 7, caller), { kind: 'leads', issue: 7, count: 1 })
    assert.deepEqual(w.labels(7), ['agent-queue', BLOCKED])
    const written = a.writes().length
    await a.coordinator.checkProject(PROJECT)
    assert.equal(a.writes().length, written)
    assert.deepEqual(w.labels(7), ['agent-queue', BLOCKED])
    assert.equal(a.leading.length, 0)
  }
  // The caller's POST reaches GitHub, its answer is lost: the queue (and after a restart) leaves it; the caller's
  // next call completes the same count with its labels.
  {
    const w = world()
    w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
    const a = w.computer(A)
    w.github.fail(isCommentOn(7), BAD_GATEWAY, { apply: true })
    assert.equal((await a.coordinator.claimTask(PROJECT, 7, caller)).kind, 'failed')
    const restarted = w.computer(A, { machine: a.machine })
    const written = restarted.writes().length
    await a.coordinator.checkProject(PROJECT)
    await restarted.coordinator.checkProject(PROJECT)
    assert.equal(restarted.writes().length, written)
    assert.equal(a.started.length + restarted.started.length, 0)
    assert.deepEqual(await restarted.coordinator.claimTask(PROJECT, 7, caller), { kind: 'leads', issue: 7, count: 1 })
    assert.deepEqual(w.thread(7), ['claim A 1'])
    assert.deepEqual(w.labels(7), ['agent-queue'])
    assert.equal(restarted.started.length, 1)
  }
})

test('начатое освобождение (п. 4): POST освобождения отклонён, метку поставили снова → следующая проверка (и после перезапуска) дописывает освобождение, lost один раз, leading и started нет', async () => {
  // A count it leads.
  {
    const { w, a } = await leaderOf7()
    w.github.setLabel(7, WORKING, false)
    w.github.fail(isCommentOn(7), BAD_GATEWAY)
    await a.coordinator.checkProject(PROJECT)
    assert.deepEqual(w.thread(7), ['claim A 1'])
    w.github.setLabel(7, WORKING, true)
    const restarted = w.computer(A, { machine: a.machine })
    const written = restarted.writes().length
    const reads = () => a.machine.starts.map(readCall).filter(isRead('AqComments', 7)).length
    const before = reads()
    await restarted.coordinator.checkProject(PROJECT)
    // The release goes first: the reading of the check and the check of the release's own write, nothing else.
    assert.equal(reads(), before + 2)
    assert.deepEqual(w.thread(7), ['claim A 1', 'release A 1'])
    assert.deepEqual(restarted.writes().slice(written), ['POST issues/7/comments'])
    assert.deepEqual(restarted.lost.map((task) => [task.count, task.reason]), [[1, 'released-by-owner']])
    assert.equal(restarted.leading.length, 0)
    await restarted.coordinator.checkProject(PROJECT)
    assert.equal(restarted.lost.length, 1)
  }
  // A claim not complete: the removal in the wait, its release refused, the label back.
  {
    const w = world()
    w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
    const a = w.computer(A)
    const waitOfA = a.sleep.hold()
    const check = a.coordinator.checkProject(PROJECT)
    await waitOfA.reached
    w.github.setLabel(7, WORKING, false)
    w.github.fail(isCommentOn(7), BAD_GATEWAY)
    waitOfA.release()
    assert.equal((await check).claimed?.kind, 'incomplete')
    w.github.setLabel(7, WORKING, true)
    // The release goes first: one reading of the task, no wait and no re-read before it.
    const reads = () => a.machine.starts.map(readCall).filter(isRead('AqIssue', 7)).length
    const before = reads()
    const result = await a.coordinator.checkProject(PROJECT)
    assert.equal(reads(), before + 1)
    assert.deepEqual(result.led, [])
    assert.deepEqual(w.thread(7), ['claim A 1', 'release A 1'])
    assert.deepEqual(a.started, [])
  }
})

test('две копии одного репозитория (п. 5): заявку, метки, запуск и освобождение ведёт одна копия; при обратном порядке и после перезапуска — так же; незавершённую заявку одной завершает другая — запуск один', async () => {
  const copy: QueueProject = { ...PROJECT, id: 'example-org/demo-shop-copy', name: 'demo-shop-copy' }
  const setup = () => {
    const w = world({ maxInProgress: 1 })
    w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
    w.github.addIssue({ number: 8, user: OWNER, labels: ['agent-queue'] })
    return w
  }
  for (const order of [[PROJECT, copy], [copy, PROJECT]] as const) {
    const w = setup()
    const a = w.computer(A)
    const [first, second] = order
    const checks = await a.coordinator.checkQueue([first, second])
    assert.deepEqual(checks.map((check) => check.claimed?.kind ?? null), ['leads', null])
    assert.deepEqual(checks[1]?.inWork, [7])
    assert.deepEqual(checks[1]?.skipped.at(-1), { issue: 8, reason: 'limit: 1 of 1 in work' })
    assert.deepEqual(a.started.map((task) => task.project.id), [first.id])
    assert.deepEqual(w.thread(7), ['claim A 1'])
    assert.deepEqual(w.thread(8), [])
    // Later checks: only the first copy leads; after a restart too.
    const restarted = w.computer(A, { machine: a.machine })
    await restarted.coordinator.checkQueue([second, first])
    assert.deepEqual(restarted.leading.map((task) => task.project.id), [first.id])
    // The owner takes `working` off: one release, one handling, by the first copy.
    w.github.setLabel(7, WORKING, false)
    w.clock.advance(5 * MINUTE)
    await restarted.coordinator.checkQueue([second, first])
    await restarted.coordinator.checkQueue([first, second])
    assert.deepEqual(w.thread(7), ['claim A 1', 'release A 1'])
    assert.deepEqual(restarted.lost.map((task) => [task.project.id, task.reason]), [[first.id, 'released-by-owner']])
  }
  // The first copy's claim is not complete; the check of the second copy completes it — one start.
  {
    const w = setup()
    const a = w.computer(A)
    w.github.fail(isLabelOn(7), BAD_GATEWAY)
    assert.equal((await a.coordinator.checkProject(PROJECT)).claimed?.kind, 'incomplete')
    assert.deepEqual((await a.coordinator.checkProject(copy)).led, [7])
    assert.deepEqual((await a.coordinator.checkProject(PROJECT)).led, [])
    assert.deepEqual(a.started.map((task) => task.project.id), [copy.id])
  }
})

test('метка протокола (п. 6): working не первая в метках этапа — после заявки стоит она одна; снятие во время ожидания — освобождение без started и без меток, и после перезапуска; без снятия к started стоят обе', async () => {
  const AUTOPILOT = 'agent-queue:autopilot'
  const labels = { on: [AUTOPILOT, WORKING] as const, off: [] }
  {
    const w = world()
    w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
    const watch = startedWith(w, 7)
    const a = w.computer(A, { hooks: watch.hooks })
    const waitOfA = a.sleep.hold()
    const claim = a.coordinator.claimTask(PROJECT, 7, { labels: { on: [...labels.on], off: [] } })
    await waitOfA.reached
    assert.deepEqual(w.labels(7), ['agent-queue', WORKING])
    waitOfA.release()
    assert.deepEqual(await claim, { kind: 'leads', issue: 7, count: 1 })
    assert.deepEqual(watch.seen.map((one) => one.labels), [['agent-queue', AUTOPILOT, WORKING]])
  }
  for (const restart of [false, true]) {
    const w = world()
    w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
    const a = w.computer(A)
    const waitOfA = a.sleep.hold()
    const claim = a.coordinator.claimTask(PROJECT, 7, { labels: { on: [...labels.on], off: [] } })
    await waitOfA.reached
    w.github.setLabel(7, WORKING, false)
    if (restart) w.github.fail(isRead('AqIssue', 7), { code: 1, stderr: 'gh: connection reset' })
    waitOfA.release()
    const outcome = await claim
    if (restart) {
      assert.equal(outcome.kind, 'incomplete')
      const restarted = w.computer(A, { machine: a.machine })
      await restarted.coordinator.checkProject(PROJECT)
      assert.equal(restarted.started.length, 0)
    } else {
      assert.deepEqual(outcome, { kind: 'released', issue: 7, count: 1 })
    }
    assert.deepEqual(a.started, [])
    assert.deepEqual(w.thread(7), ['claim A 1', 'release A 1'])
    assert.deepEqual(w.labels(7), ['agent-queue'])
  }
})

test('правила выбора (п. 7): перед каждым кандидатом — свежий контекст: правило второго кандидата видит в работе первый, взятый другим до свежего чтения, и его заявку', async () => {
  const w = world({ maxInProgress: 2 })
  w.github.addIssue({ number: 1, user: OWNER, labels: ['agent-queue'] })
  w.github.addIssue({ number: 2, user: OWNER, labels: ['agent-queue'] })
  w.github.before(isRead('AqIssue', 1), () => {
    w.mark(1, { kind: 'claim', coordinator: X, claim: 1 })
  })
  const seen: { inWork: number[]; last: number | undefined }[] = []
  const rule: ChoiceRule = (task, context) => {
    if (task.issue.number !== 2 || context.phase !== 'claim') return null
    seen.push({ inWork: [...context.inWork], last: context.tasks.find((one) => one.issue.number === 1)?.claims.last })
    return context.inWork.some((number) => number !== 2) ? 'an MVP task in work already' : null
  }
  const a = w.computer(A, { rules: [rule] })
  const result = await a.coordinator.checkProject(PROJECT)
  assert.equal(result.claimed, null)
  assert.deepEqual(seen, [{ inWork: [1], last: 1 }])
  assert.deepEqual(result.skipped.at(-1), { issue: 2, reason: 'an MVP task in work already' })
  assert.deepEqual(w.thread(2), [])
})

// ── Round 5 of the review ───────────────────────────────────────────────────────────────────────────────────────────

// Lets the promises and the timers of the fake computers run for a while.
async function settle(turns = 20): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setTimeout(resolve, 0))
}

// Holds the first creation of a file whose path matches `name` on `machine` until released (the file is not there
// meanwhile).
function holdFile(machine: FakeMachine, name: RegExp) {
  let arrived: () => void = () => {}
  let go: () => void = () => {}
  const reached = new Promise<void>((resolve) => {
    arrived = resolve
  })
  const released = new Promise<void>((resolve) => {
    go = resolve
  })
  const create = machine.createText.bind(machine)
  let armed = true
  machine.createText = async (path: string, text: string) => {
    if (armed && name.test(path)) {
      armed = false
      arrived()
      await released
    }
    return create(path, text)
  }
  return { reached, release: () => go() }
}

test('две копии одного репозитория (вызов второй во время ожидания первой): проверка и claimTask второй копии присоединяются к завершению первой → у второй not-free, задача не в её списке ведомых; запуск один', async () => {
  const copy: QueueProject = { ...PROJECT, id: 'example-org/demo-shop-copy', name: 'demo-shop-copy' }
  const w = world()
  w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
  const a = w.computer(A)
  const waitOfFirst = a.sleep.hold()
  const first = a.coordinator.checkProject(PROJECT)
  await waitOfFirst.reached
  const secondCheck = a.coordinator.checkProject(copy)
  const secondCall = a.coordinator.claimTask(copy, 7)
  await settle()
  waitOfFirst.release()
  const [byFirst, bySecond, called] = await Promise.all([first, secondCheck, secondCall])
  assert.deepEqual(byFirst.claimed, { kind: 'leads', issue: 7, count: 1 })
  assert.deepEqual(bySecond.led, [])
  assert.deepEqual(bySecond.inWork, [7])
  assert.deepEqual(called, { kind: 'not-free', issue: 7, reason: LED_ELSEWHERE })
  assert.deepEqual(a.started.map((task) => task.project.id), [PROJECT.id])
  assert.deepEqual(w.thread(7), ['claim A 1'])
})

test('два воркера одного журнала: освобождение, решённое во время ожидания другого (его POST отклонён, метка вернулась), идёт первым и после ожидания → освобождение, агенты не запускаются', async () => {
  const w = world()
  w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
  const a = w.computer(A)
  const waitOfA = a.sleep.hold()
  const checkA = a.coordinator.checkProject(PROJECT)
  await waitOfA.reached
  // The owner takes `working` off while A waits; the second worker of the same journal completes the same claim,
  // decides the owner's removal and records `releasing`, but its release is refused.
  w.github.setLabel(7, WORKING, false)
  const second = w.computer(A, { machine: a.machine })
  w.github.fail(isCommentOn(7), BAD_GATEWAY)
  assert.equal((await second.coordinator.checkProject(PROJECT)).claimed, null)
  assert.deepEqual(w.thread(7), ['claim A 1'])
  // The label comes back; A's wait ends.
  w.github.setLabel(7, WORKING, true)
  const reads = () => a.machine.starts.map(readCall).filter(isRead('AqComments', 7)).length
  const before = reads()
  waitOfA.release()
  assert.deepEqual((await checkA).claimed, { kind: 'released', issue: 7, count: 1 })
  // Right after the re-read the release goes first: the re-read and the check of the release's own write, nothing else.
  assert.equal(reads(), before + 2)
  assert.deepEqual(w.thread(7), ['claim A 1', 'release A 1'])
  assert.deepEqual([a.started.length, second.started.length], [0, 0])
})

test('два воркера одного журнала: одновременные попытки заявки с разными профилями, POST одной отклонён → принятая заявка завершается по профилю своей попытки', async () => {
  const none = { on: [], off: [] }
  const w = world()
  w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
  const queue = w.computer(A)
  const caller = w.computer(A, { machine: queue.machine })
  // The queue's attempt chose its profile and its POST waits on the way; meanwhile the caller's attempt runs as far
  // as it can, and the next claim POST GitHub gets is refused.
  const post = holdCall(queue.machine, isCommentOn(7))
  const byQueue = queue.coordinator.checkProject(PROJECT)
  await post.reached
  w.github.fail(isCommentOn(7), BAD_GATEWAY)
  const byCaller = caller.coordinator.claimTask(PROJECT, 7, { admit: () => null, labels: none, recovery: 'caller' })
  await settle()
  post.release()
  const [checked, called] = await Promise.all([byQueue, byCaller])
  const claims = w.github.comments.filter((one) => parseBody(one.body).mark?.kind === 'claim')
  assert.equal(claims.length, 1)
  const queueLeads = checked.claimed?.kind === 'leads'
  const callerLeads = called.kind === 'leads'
  assert.ok(queueLeads !== callerLeads, JSON.stringify([checked.claimed, called]))
  // The accepted claim goes on by the profile of its own attempt.
  if (queueLeads) {
    assert.deepEqual(w.labels(7), ['agent-queue', WORKING])
    assert.deepEqual(queue.started.map((task) => task.count), [1])
  } else {
    assert.deepEqual(w.labels(7), ['agent-queue'])
    const written = queue.writes().length
    await queue.coordinator.checkProject(PROJECT)
    assert.equal(queue.writes().length, written)
    assert.equal(queue.leading.length, 0)
  }
})

test('журнал заявок: номер файла профиля, занятый в это время другой попыткой, — профиль перечитывается и попытка берёт следующий номер со своим профилем', async () => {
  const w = world()
  const machine = w.github.computer()
  const journal = new ClaimJournal(machine, dataDirectory(machine))
  const queue = { recovery: 'queue' as const, on: [WORKING], off: [BLOCKED] }
  const caller = { recovery: 'caller' as const, on: [], off: [] }
  const held = holdFile(machine, /profile-1$/)
  const first = journal.writeProfile(PROJECT.repository, 7, 1, queue)
  await held.reached
  await journal.writeProfile(PROJECT.repository, 7, 1, caller)
  assert.deepEqual(journal.profile(PROJECT.repository, 7, 1), caller)
  held.release()
  await first
  assert.deepEqual(journal.profile(PROJECT.repository, 7, 1), queue)
})

test('правила выбора (п. 7, долгий допуск): допуск первого кандидата дольше 30 секунд, его взял другой → правило второго видит перечитанные заявки и комментарии первого вместе', async () => {
  const w = world({ maxInProgress: 2 })
  w.github.addIssue({ number: 1, user: OWNER, labels: ['agent-queue'] })
  w.github.addIssue({ number: 2, user: OWNER, labels: ['agent-queue'] })
  const seen: { last: number | undefined; marks: string[] }[] = []
  const rule: ChoiceRule = (task, context) => {
    if (context.phase !== 'claim') return null
    if (task.issue.number === 1) {
      // A long admission; X claims #1 meanwhile.
      w.clock.advance(31_000)
      w.mark(1, { kind: 'claim', coordinator: X, claim: 1 })
      return null
    }
    const first = context.tasks.find((one) => one.issue.number === 1)
    seen.push({
      last: first?.claims.last,
      marks: (first?.comments ?? []).map((one) => parseBody(one.body).mark?.kind ?? 'text'),
    })
    return context.inWork.includes(1) ? 'an MVP task in work already' : null
  }
  const a = w.computer(A, { rules: [rule] })
  const result = await a.coordinator.checkProject(PROJECT)
  assert.equal(result.claimed, null)
  assert.deepEqual(result.skipped, [
    { issue: 1, reason: 'changed during the admission: the last count is 1, not 0' },
    { issue: 2, reason: 'an MVP task in work already' },
  ])
  assert.deepEqual(seen, [{ last: 1, marks: ['claim'] }])
})

// ── Round 6 of the review ───────────────────────────────────────────────────────────────────────────────────────────

test('старый проход с задержанным POST и новый проход через другой объект Machine того же журнала (повторная активация): попытки заявки не перемешиваются — принятая заявка завершается по профилю своей попытки', async () => {
  const none = { on: [], off: [] }
  const w = world()
  w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
  const old = w.computer(A)
  // The new activation's computer: another Machine object on the same files (the same journal).
  const fresh = w.computer(A, { machine: { ...old.machine } })
  assert.notEqual(fresh.machine, old.machine)
  const post = holdCall(old.machine, isCommentOn(7))
  const byOld = old.coordinator.checkProject(PROJECT)
  await post.reached
  w.github.fail(isCommentOn(7), BAD_GATEWAY)
  const byFresh = fresh.coordinator.claimTask(PROJECT, 7, { admit: () => null, labels: none, recovery: 'caller' })
  await settle()
  post.release()
  const [checked, called] = await Promise.all([byOld, byFresh])
  const claims = w.github.comments.filter((one) => parseBody(one.body).mark?.kind === 'claim')
  assert.equal(claims.length, 1)
  const oldLeads = checked.claimed?.kind === 'leads'
  const freshLeads = called.kind === 'leads'
  assert.ok(oldLeads !== freshLeads, JSON.stringify([checked.claimed, called]))
  if (oldLeads) {
    assert.deepEqual(w.labels(7), ['agent-queue', WORKING])
  } else {
    assert.deepEqual(w.labels(7), ['agent-queue'])
    const written = old.writes().length
    await old.coordinator.checkProject(PROJECT)
    assert.equal(old.writes().length, written)
    assert.equal(old.leading.length, 0)
  }
})

test('освобождение, решённое перед подтверждением права (другим координатором того же журнала): ни запуска агентов, ни шага этапа, ни записи по задаче — только освобождение', async () => {
  // While the completion asks the switch right before confirming its right — after the re-read and its check of
  // `releasing` —, the owner takes `working` off, the other coordinator of the journal decides the release (its POST is
  // refused), and the label comes back.
  const interfere = async (w: ReturnType<typeof world>, machine: FakeMachine) => {
    w.github.setLabel(7, WORKING, false)
    const other = w.computer(A, { machine: { ...machine } })
    w.github.fail(isCommentOn(7), BAD_GATEWAY)
    await other.coordinator.checkProject(PROJECT)
    assert.deepEqual(w.thread(7), ['claim A 1'])
    w.github.setLabel(7, WORKING, true)
    return other
  }
  // The start.
  {
    const w = world()
    w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
    const a = w.computer(A)
    let other: Computer | null = null
    const enabled = async () => {
      if (other === null && w.clock.now() >= START + REREAD_AFTER_MS) other = await interfere(w, a.machine)
      return true
    }
    const result = await a.coordinator.checkProject(PROJECT, { enabled })
    assert.ok(other)
    assert.deepEqual(result.claimed, { kind: 'released', issue: 7, count: 1 })
    assert.deepEqual(w.thread(7), ['claim A 1', 'release A 1'])
    assert.deepEqual(a.started, [])
    // Refused at the confirmation itself: no lead was recorded, so there is no local handling of a lost count either.
    assert.equal(a.lost.length, 0)
    await a.coordinator.checkProject(PROJECT)
    assert.equal(a.lost.length, 0)
  }
  // The next step of the stage, and a write of the stage's code through its right.
  {
    const { w, a } = await leaderOf7()
    const taskA = a.started[0]
    assert.ok(taskA)
    let calls = 0
    let refused: unknown = null
    const enabled = async () => {
      // The first ask is before the task; the second right before the next step of the stage.
      if (++calls === 2) {
        await interfere(w, a.machine)
        refused = await taskA.right.act(() => taskA.github.addLabels(7, [BLOCKED]))
      }
      return true
    }
    const result = await a.coordinator.checkProject(PROJECT, { enabled })
    assert.deepEqual(refused, { ok: false, releasing: true })
    assert.deepEqual(result.led, [])
    assert.equal(a.leading.length, 0)
    assert.deepEqual(w.thread(7), ['claim A 1', 'release A 1'])
    assert.deepEqual(w.labels(7), ['agent-queue', WORKING])
    assert.deepEqual(a.lost.map((task) => [task.count, task.reason]), [[1, 'released-by-owner']])
  }
})
