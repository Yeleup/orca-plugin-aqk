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
import {
  Coordinator,
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

test('К4.13 (запоздалое снятие working прежним ведущим): снятие метки прежним ведущим пришло после заявки нового отсчёта → ведущий возвращает метку и задачу не освобождает; снятие владельцем после подтверждения метки — освобождение', async () => {
  const w = world()
  w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
  const a = w.computer(A)
  const b = w.computer(B)
  await a.coordinator.checkProject(PROJECT)
  const taskA = a.started[0]
  assert.ok(taskA)
  // A ends its count; the removal of its label, admitted by its check, waits on the way.
  assert.equal(
    (await taskA.right.act(() => taskA.github.comment(7, { mark: { kind: 'release', coordinator: A, claim: 1 }, text: ['Готово'] }))).ok,
    true,
  )
  const heldA = holdCall(a.machine, isUnlabelOn(7, WORKING))
  const removal = taskA.right.act(() => taskA.github.removeLabel(7, WORKING), { released: true })
  await heldA.reached
  // 10 minutes with `working` on a released count: B takes the task with count 2.
  w.clock.advance(UNSETTLED_MS)
  assert.deepEqual((await b.coordinator.checkProject(PROJECT)).claimed, { kind: 'leads', issue: 7, count: 2 })
  heldA.release()
  assert.equal((await removal).ok, true)
  assert.deepEqual(w.labels(7), ['agent-queue'])

  // B's next check: the label is gone before B confirmed it — it may be that late write. B sets it again, keeps its count.
  w.clock.advance(5 * MINUTE)
  const writtenByB = b.writes().length
  assert.deepEqual((await b.coordinator.checkProject(PROJECT)).led, [7])
  assert.deepEqual(w.labels(7), ['agent-queue', WORKING])
  assert.deepEqual(b.writes().slice(writtenByB), ['POST issues/7/labels'])
  assert.deepEqual(w.thread(7), ['claim A 1', 'release A 1', 'claim B 2'])
  assert.equal(b.lost.length, 0)
  // A ended its own count: no loss for it, nothing written.
  const writtenByA = a.writes().length
  await a.coordinator.checkProject(PROJECT)
  assert.equal(a.writes().length, writtenByA)
  assert.equal(a.lost.length, 0)

  // Now the label is confirmed: the owner takes it off — B releases its count.
  w.issue(7).labels = ['agent-queue']
  w.clock.advance(5 * MINUTE)
  assert.deepEqual((await b.coordinator.checkProject(PROJECT)).led, [])
  assert.deepEqual(w.thread(7), ['claim A 1', 'release A 1', 'claim B 2', 'release B 2'])
  assert.deepEqual(b.lost.map((task) => [task.count, task.reason]), [[2, 'released-by-owner']])
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
  w.issue(7).labels = ['agent-queue']
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
    w.issue(7).labels = ['agent-queue']
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
    w.issue(7).labels = ['agent-queue']
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
  w.issue(7).labels = ['agent-queue']
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
