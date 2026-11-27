// The periodic check of the queue as the worker starts it (src/worker.ts: startPlugin, startCoordinator) over Orca's
// mock host: the plugin's settings are the host's, the timers and the clock are fake — the test moves the clock, the
// timers due by then fire, and each check runs to its end before the clock moves on. GitHub is a fake behind a fake gh.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { parseRepository } from '../github/gh'
import { PLUGIN_LABELS } from '../github/labels'
import { parseBody } from '../github/mark'
import { parseProjectSettings } from '../project/settings'
import { FakeGitHub } from '../testing/fake-github'
import { fakeClock, type FakeClock } from '../testing/fake-machine'
import { fakeSleep } from '../testing/hold'
import { startCoordinator, startPlugin } from '../worker'
import type { QueueProject } from './coordinator'
import { MAX_TIMER_MS, type QueueCheck, type Timers } from './schedule'

const OWNER = 'avery-dev'
const REPO = 'acme/demo-shop'
const MINUTE = 60_000

const PROJECT: QueueProject = {
  id: 'example-org/demo-shop',
  hostId: 'local',
  name: 'demo-shop',
  checkout: '/home/avery/src/demo-shop',
  repository: parseRepository(REPO),
}

// Timers on a fake clock: `advance` moves the clock to each timer due within the time given, in order, fires it and
// waits for the check it started (`settle`) before going on.
function fakeTimers(clock: FakeClock) {
  let next = 1
  const pending = new Map<number, { at: number; run: () => void }>()
  const timers: Timers = {
    set: (run, ms) => {
      const id = next++
      pending.set(id, { at: clock.now() + ms, run })
      return id
    },
    clear: (handle) => {
      pending.delete(handle as number)
    },
  }
  const advance = async (ms: number, settle: () => Promise<void>) => {
    const end = clock.now() + ms
    for (;;) {
      const due = [...pending.entries()].filter(([, one]) => one.at <= end).sort((x, y) => x[1].at - y[1].at)[0]
      if (due === undefined) break
      const [id, one] = due
      pending.delete(id)
      clock.advance(one.at - clock.now())
      one.run()
      await settle()
    }
    // A check moves the clock by the wait of its protocol: never back.
    if (end > clock.now()) clock.advance(end - clock.now())
  }
  return { timers, advance, pending: () => [...pending.values()].map((one) => one.at - clock.now()) }
}

async function startedWorker(settings: Record<string, number | boolean>) {
  const clock = fakeClock(Date.UTC(2026, 2, 2, 10, 0, 0))
  const github = new FakeGitHub({ repository: REPO, login: OWNER, clock, pageSize: 50 })
  for (const label of PLUGIN_LABELS) github.addLabel(label)
  github.addIssue({ number: 7, user: OWNER, labels: ['agent-queue'] })
  github.addIssue({ number: 8, user: OWNER, labels: ['agent-queue'] })
  const parsed = parseProjectSettings(
    JSON.stringify({ version: 1, testCommand: 'make test', language: 'ru', dataRule: 'No customer data in GitHub.', maxInProgress: 2 }),
    'main',
  )
  assert.ok(parsed.ok)
  const machine = github.computer()
  const fake = fakeTimers(clock)
  const started: number[] = []
  let api: OrcaWorkerApi | undefined
  let queue: QueueCheck | undefined
  const worker = await mountWorker(
    {
      default: async (orca: OrcaWorkerApi) => {
        api = orca
        const plugin = await startPlugin(orca, machine, {
          readSettings: async () => ({ ok: true, settings: parsed.settings }),
          sleep: fakeSleep(clock).sleep,
          hooks: { started: (task) => void started.push(task.issue.number) },
        })
        queue = startCoordinator(orca, plugin, { projects: async () => [PROJECT], timers: fake.timers })
      },
    },
    { host: mockHost({ settings }) },
  )
  assert.ok(api && queue)
  const q = queue
  const ghCalls = () => machine.starts.length
  const claims = () =>
    github.comments
      .map((comment) => parseBody(comment.body).mark)
      .filter((mark) => mark?.kind === 'claim')
      .map((mark) => mark?.claim)
  const advance = (ms: number) => fake.advance(ms, () => q.idle())
  return { api, worker, queue: q, clock, github, started, ghCalls, claims, advance, pending: fake.pending }
}

test('проверка очереди раз в интервал из настроек плагина: первая — через интервал после запуска воркера, следующая — через интервал после неё', async () => {
  const run = await startedWorker({ queueCheckInterval: 5, coordinatorEnabled: true })
  // The worker started: nothing is read from GitHub until the interval has passed.
  await run.advance(5 * MINUTE - 1)
  assert.equal(run.ghCalls(), 0)
  assert.deepEqual(run.started, [])
  await run.advance(1)
  assert.ok(run.ghCalls() > 0)
  assert.deepEqual(run.started, [7])
  const after = run.ghCalls()
  // The next check: one interval after the end of this one.
  await run.advance(5 * MINUTE - 1)
  assert.equal(run.ghCalls(), after)
  await run.advance(1)
  assert.ok(run.ghCalls() > after)
  assert.deepEqual(run.started, [7, 8])
  assert.deepEqual(run.worker.refusals, [])
  run.queue.stop()
  assert.deepEqual(run.pending(), [])
  await run.worker.deactivate()
})

test('координатор этого компьютера выключен → проверка очереди ничего не читает и не берёт; включён снова → берёт со следующей проверки', async () => {
  const run = await startedWorker({ queueCheckInterval: 5, coordinatorEnabled: false })
  await run.advance(30 * MINUTE)
  assert.equal(run.ghCalls(), 0)
  assert.deepEqual(run.started, [])
  assert.deepEqual(run.github.comments, [])
  await run.api.settings.set('coordinatorEnabled', true)
  await run.advance(5 * MINUTE)
  assert.deepEqual(run.started, [7])
  assert.deepEqual(run.claims(), [1])
  run.queue.stop()
  await run.worker.deactivate()
})

test('интервал проверки очереди изменён → следующая проверка — через новый интервал после прошлой', async () => {
  const run = await startedWorker({ queueCheckInterval: 10, coordinatorEnabled: true })
  await run.advance(10 * MINUTE)
  assert.deepEqual(run.started, [7])
  // 1 minute after that check the owner sets 3 minutes: the next check is 3 minutes after the last one.
  await run.advance(MINUTE)
  await run.api.settings.set('queueCheckInterval', 3)
  await run.queue.idle()
  await run.advance(MINUTE + 59_000)
  assert.deepEqual(run.started, [7])
  await run.advance(1_000)
  assert.deepEqual(run.started, [7, 8])
  // A longer interval than a timer of Node.js can wait: the worker wakes and waits again, with no check before it.
  await run.api.settings.set('queueCheckInterval', 60 * 24 * 60)
  await run.queue.idle()
  await run.advance(MINUTE)
  assert.ok(run.pending().every((wait) => wait <= MAX_TIMER_MS), JSON.stringify(run.pending()))
  const calls = run.ghCalls()
  await run.advance(MAX_TIMER_MS + MINUTE)
  assert.equal(run.ghCalls(), calls)
  run.queue.stop()
  assert.deepEqual(run.pending(), [])
  await run.worker.deactivate()
})
