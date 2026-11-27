// The coordinator's check of the queue, its claims by the protocol of counts and the right to act (TZ Ф4), with fakes
// only: several coordinators — each a fake computer with its own data directory and coordinator id — on one fake
// GitHub behind a fake gh, on one fake clock. A test calls one check of the queue itself and never waits for a timer;
// the protocol's wait of 60 seconds moves the fake clock. What a test looks at is what ends up on the fake GitHub —
// which comments with which marks and counts, in which order, which labels — who would start the agents (the hook
// `started`), and what each coordinator writes or does not write afterwards.
import { assert, test } from 'orca/testing'
import { parseRepository } from '../github/gh'
import { PLUGIN_LABELS } from '../github/labels'
import { composeBody, parseBody, type Mark } from '../github/mark'
import { dataDirectory } from '../platform/paths'
import { parseProjectSettings, type ProjectSettings } from '../project/settings'
import { FakeGitHub, readCall } from '../testing/fake-github'
import { fakeClock, type FakeMachine } from '../testing/fake-machine'
import { fakeSleep, holdCall, isCommentOn, isLabelOn, isWrite } from '../testing/hold'
import { DEFERRAL_MS, REREAD_AFTER_MS, UNSETTLED_MS } from './claims'
import { Coordinator, type LedTask, type LostTask, type QueueProject } from './coordinator'

const OWNER = 'avery-dev'
const REPO = 'acme/demo-shop'
// Invented coordinator ids (random UUID v4 form) of three computers.
const A = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const B = '5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9'
const X = '9f8e7d6c-5b4a-4c3d-b2e1-f0a9b8c7d6e5'
const NAMES: Record<string, string> = { [A]: 'A', [B]: 'B', [X]: 'X' }
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

function world(settings: Partial<Record<string, unknown>> = {}) {
  const clock = fakeClock(START)
  const github = new FakeGitHub({ repository: REPO, login: OWNER, clock, pageSize: 50 })
  for (const label of PLUGIN_LABELS) github.addLabel(label)
  const project = projectSettings(settings)
  // A computer with its coordinator; `machine` — the same computer again (a restart of its worker).
  const computer = (id: string, options: { machine?: FakeMachine; stopped?: boolean } = {}): Computer => {
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
      hooks: {
        started: (task) => {
          started.push(task)
        },
        leading: (task) => {
          leading.push(task)
        },
        lost: (task) => {
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
  // The comments of a task: `kind coordinator count` of each mark, the text of a comment without one.
  const thread = (issue: number) =>
    github.comments
      .filter((comment) => comment.issue === issue)
      .map((comment) => {
        const { mark: found, text } = parseBody(comment.body)
        if (found === null) return text.trim().replace(/[0-9a-f-]{36}/g, (id) => NAMES[id] ?? id)
        return `${found.kind} ${NAMES[found.coordinator ?? ''] ?? found.coordinator} ${found.claim ?? ''}`.trim()
      })
  const labels = (issue: number) => [...(github.issues.find((one) => one.number === issue)?.labels ?? [])].sort()
  return { clock, github, computer, mark, thread, labels }
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
  // Both claims and labels are written; now both re-read.
  waitOf.a.release()
  waitOf.b.release()
  const [checkA, checkB] = await checks
  return { w, a, b, checkA, checkB }
}

test('К4.3: A и B читают задачу свободной, затем A пишет заявку, затем B; оба перечитывают → агентов запускает только A; B пишет «Задачу ведёт A» и больше ничего не делает', async () => {
  const { w, a, b, checkA, checkB } = await raceForTask('A-first')
  assert.deepEqual(checkA.claimed, { kind: 'leads', issue: 7, count: 1 })
  assert.deepEqual(checkB.claimed, { kind: 'lost', issue: 7, count: 1, leader: A })
  // Both wrote the same count; A's claim is first in GitHub's order.
  assert.deepEqual(w.thread(7), ['claim A 1', 'claim B 1', 'Задачу ведёт A.'])
  assert.deepEqual(w.labels(7), ['agent-queue', WORKING])
  // Only A would start the agents.
  assert.deepEqual(
    a.started.map((task) => [task.issue.number, task.count, task.kind, task.stage]),
    [[7, 1, 'claim', null]],
  )
  assert.deepEqual(b.started, [])
  assert.deepEqual(b.writes(), ['POST issues/7/comments', 'POST issues/7/labels', 'POST issues/7/comments'])

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
  assert.deepEqual(b.lost, [])
  assert.equal(a.writes().length, writtenByA)
  assert.equal(a.started.length, 1)
  assert.deepEqual(a.leading.map((task) => task.count), [1, 1])
  assert.deepEqual(w.thread(7), ['claim A 1', 'claim B 1', 'Задачу ведёт A.'])
})

test('К4.3 (порядок «A, B, запись B, запись A»): ведёт тот, чья заявка в GitHub первая — B; A пишет «Задачу ведёт B» и больше ничего не делает', async () => {
  const { w, a, b, checkA, checkB } = await raceForTask('B-first')
  assert.deepEqual(checkB.claimed, { kind: 'leads', issue: 7, count: 1 })
  assert.deepEqual(checkA.claimed, { kind: 'lost', issue: 7, count: 1, leader: B })
  assert.deepEqual(w.thread(7), ['claim B 1', 'claim A 1', 'Задачу ведёт B.'])
  assert.deepEqual(w.labels(7), ['agent-queue', WORKING])
  assert.deepEqual(b.started.map((task) => [task.issue.number, task.count]), [[7, 1]])
  assert.deepEqual(a.started, [])

  const writtenByA = a.writes().length
  w.clock.advance(5 * MINUTE)
  assert.equal((await a.coordinator.checkProject(PROJECT)).claimed, null)
  assert.equal(a.writes().length, writtenByA)
  assert.deepEqual(a.started, [])
  assert.deepEqual(w.thread(7), ['claim B 1', 'claim A 1', 'Задачу ведёт B.'])
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

    const first = w.github.issues.find((issue) => issue.number === 1)
    assert.ok(first)
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
  const first = w.github.issues.find((issue) => issue.number === 1)
  assert.ok(first)
  first.labels = ['agent-queue', WORKING]
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

test('К4.12: запись метки после заявки не прошла → тот же координатор на следующей проверке ставит метку (и после перезапуска — по своему журналу); другой координатор задачу не берёт', async () => {
  const w = world()
  w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
  const a = w.computer(A)
  const b = w.computer(B)
  w.github.fail(isLabelOn(7), { code: 1, stderr: 'gh: Server Error (HTTP 502)' })

  const first = await a.coordinator.checkProject(PROJECT)
  assert.deepEqual(first.claimed, { kind: 'leads', issue: 7, count: 1 })
  assert.deepEqual(w.thread(7), ['claim A 1'])
  assert.deepEqual(w.labels(7), ['agent-queue'])

  // B, 5 minutes later: the claim is A's and fresh — B does not take the task.
  w.clock.advance(5 * MINUTE)
  const byB = await b.coordinator.checkProject(PROJECT)
  assert.equal(byB.claimed, null)
  assert.deepEqual(byB.skipped, [{ issue: 7, reason: 'claimed' }])
  assert.deepEqual(b.writes(), [])

  // A's worker restarts: the next check sets the label by A's journal; no new claim, no new start of the agents.
  const restarted = w.computer(A, { machine: a.machine })
  const next = await restarted.coordinator.checkProject(PROJECT)
  assert.deepEqual(next.led, [7])
  assert.equal(next.claimed, null)
  assert.deepEqual(w.labels(7), ['agent-queue', WORKING])
  assert.deepEqual(w.thread(7), ['claim A 1'])
  assert.deepEqual(restarted.started, [])
  assert.deepEqual(restarted.leading.map((task) => task.count), [1])

  // With the label on, the claim holds however old it is.
  w.clock.advance(UNSETTLED_MS)
  assert.equal((await b.coordinator.checkProject(PROJECT)).claimed, null)
  assert.deepEqual(b.writes(), [])
})

test('К4.12: запись метки после заявки не прошла и заявитель пропал → другой координатор 10 минут задачу не берёт, потом берёт новым отсчётом, а вернувшийся заявитель уступает', async () => {
  const w = world()
  w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
  const a = w.computer(A)
  const b = w.computer(B)
  w.github.fail(isLabelOn(7), { code: 1, stderr: 'gh: Server Error (HTTP 502)' })
  assert.deepEqual((await a.coordinator.checkProject(PROJECT)).claimed, { kind: 'leads', issue: 7, count: 1 })
  assert.deepEqual(a.started.map((task) => task.count), [1])
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

  // A comes back: it sees the new count and yields — no label, no comment, no agents; its agents of count 1 are to stop.
  const writtenByA = a.writes().length
  for (let check = 0; check < 2; check++) {
    w.clock.advance(5 * MINUTE)
    const back = await a.coordinator.checkProject(PROJECT)
    assert.equal(back.claimed, null)
    assert.deepEqual(back.led, [])
  }
  assert.equal(a.writes().length, writtenByA)
  assert.deepEqual(a.started.map((task) => task.count), [1])
  assert.deepEqual(
    a.lost.map((task) => [task.issue.number, task.count, task.reason, task.leader]),
    [[7, 1, 'newer-count', B]],
  )
  assert.deepEqual(w.thread(7), ['claim A 1', 'claim B 2'])
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
  const takeover = await b.coordinator.claimTask(PROJECT, 7, 'takeover')
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
  assert.deepEqual(b.lost, [])
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

// ── Further rules of the choice and of leading ─────────────────────────────────────────────────────────────────────

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

test('владелец снял `working` у задачи в работе → ведущий пишет «освобождение» своего отсчёта и в эту проверку задачу снова не берёт', async () => {
  const w = world()
  w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
  const a = w.computer(A)
  assert.deepEqual((await a.coordinator.checkProject(PROJECT)).claimed, { kind: 'leads', issue: 7, count: 1 })
  const issue = w.github.issues.find((one) => one.number === 7)
  assert.ok(issue)
  issue.labels = ['agent-queue']
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
  const issue = w.github.issues.find((one) => one.number === 7)
  assert.ok(issue)
  issue.labels = ['agent-queue']
  assert.deepEqual((await b.coordinator.checkProject(PROJECT)).claimed, { kind: 'leads', issue: 7, count: 2 })
  await a.coordinator.checkProject(PROJECT)
  assert.deepEqual(a.lost, [])
  assert.deepEqual(w.thread(7), ['claim A 1', 'block A 1', 'claim B 2'])
})

test('очередь проекта остановлена → новая задача не берётся, а задача, которую координатор ведёт, проверяется: метка после сбоя ставится', async () => {
  const w = world({ maxInProgress: 3 })
  w.github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
  w.github.addIssue({ number: 8, user: OWNER, labels: ['agent-queue'] })
  const a = w.computer(A)
  w.github.fail(isLabelOn(7), { code: 1, stderr: 'gh: Server Error (HTTP 502)' })
  assert.deepEqual((await a.coordinator.checkProject(PROJECT)).claimed, { kind: 'leads', issue: 7, count: 1 })
  const stopped = w.computer(A, { machine: a.machine, stopped: true })
  const result = await stopped.coordinator.checkProject(PROJECT)
  assert.equal(result.claimed, null)
  assert.deepEqual(result.led, [7])
  assert.deepEqual(w.labels(7), ['agent-queue', WORKING])
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
