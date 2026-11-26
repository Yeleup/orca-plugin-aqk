// The agents layer of the worker (src/agents/agents.ts) over a fake Orca (src/testing/fake-orca.ts: Orca's mock host
// with the refusals of Orca 1.4.274, and its CLI on a fake computer): what is launched and with which params, when the
// task counts as delivered and a report as ready, what goes into an agent's terminal and how, what a stop closes and
// what it leaves. The worker runs as Orca runs it (`mountWorker`: the manifest's capabilities and events); the clock
// moves only when the test moves it. Invented project, issues, terminals and workspaces only.
import { assert, hostError, mountWorker, test, type TestWorker } from 'orca/testing'
import type { OrcaWorkerApi, PluginEvents } from 'orca/worker'
import { dataDirectory, dataName, dataPath } from '../platform/paths'
import { DEFAULT_AGENTS, type AgentRole, type ProjectAgents } from '../project/settings'
import { fakeOrca, type FakeOrca } from '../testing/fake-orca'
import { DELIVERY_DEADLINE_MS, issueTask, startAgents, type AgentLaunch, type Agents, type LaunchRequest } from './agents'
import { implementerTask, launchPrompt, messageLine, reviewerTask } from './task-text'

const PROJECT = 'example-org/sample-shop'
const DATA_RULE = 'Никаких данных покупателей: имён, телефонов, адресов, токенов и ключей.'
// Agents of the settings other than the defaults: each role gets the agent of its own field.
const AGENTS: ProjectAgents = { implementer: 'codex', reviewer: 'claude', solver: 'gemini', start: 'opencode' }

type AgentState = PluginEvents['agent.status.changed']['state']
type Rig = { readonly orca: FakeOrca; readonly worker: TestWorker; readonly agents: Agents; readonly host: OrcaWorkerApi['host'] }

// A worker with the agents layer on the fake Orca, as the worker starts it (its CLI input included).
async function mount(orca: FakeOrca): Promise<Rig> {
  let agents: Agents | undefined
  let host: OrcaWorkerApi['host'] | undefined
  const worker = await mountWorker(
    {
      default: (api) => {
        host = api.host
        agents = startAgents(api, orca.machine, dataDirectory(orca.machine))
      },
    },
    { host: orca.host },
  )
  assert.ok(agents && host)
  return { orca, worker, agents, host }
}

function request(issue: number, role: AgentRole, agents: ProjectAgents = AGENTS): LaunchRequest {
  const task = role === 'reviewer' ? reviewerTask : implementerTask
  return {
    task: issueTask(PROJECT, issue),
    role,
    agents,
    language: 'ru',
    workspaceId: `workspace-issue-${issue}`,
    taskText: (files) =>
      task({
        settings: { language: 'ru', dataRule: DATA_RULE },
        issue: { number: issue, title: `Задача ${issue}`, body: 'Добавить фильтр каталога по цвету.', ownerComments: [] },
        taskRules: null,
        reportFile: files.reportFile,
      }),
  }
}

async function launched(rig: Rig, issue: number, role: AgentRole, agents?: ProjectAgents): Promise<AgentLaunch> {
  const result = await rig.agents.launch(request(issue, role, agents))
  assert.ok(result.ok, JSON.stringify(result))
  return result.launch
}

// Orca's event for the agent of `launch`: its state, when the main agent's state began, and when Orca got it.
function status(launch: AgentLaunch, state: AgentState, startedAt: number, receivedAt = startedAt): PluginEvents['agent.status.changed'] {
  return {
    workspaceId: launch.workspaceId,
    paneKey: `pane-${launch.terminalId}`,
    terminalId: launch.terminalId,
    state,
    receivedAt,
    mainAgent: { state, stateStartedAt: startedAt },
  }
}

test('Запуск исполнителя через поддельный хост → agent.launch с агентом из настроек, worktree задачи и заданием; отчёт готов только после состояния «done» и появления файла отчёта', async () => {
  const r = await mount(fakeOrca())
  const launch = await launched(r, 12, 'implementer')

  // agent.launch: the implementer's agent of the settings, in the task's worktree, with the prompt naming the task file.
  const dir = dataPath(r.orca.machine, dataDirectory(r.orca.machine), 'projects', dataName(PROJECT), 'issue-12', 'agents', '1')
  assert.equal(launch.taskFile, `${dir}/task.md`)
  assert.equal(launch.reportFile, `${dir}/report.md`)
  assert.deepEqual(r.orca.host.calls, [
    {
      method: 'agent.launch',
      params: { workspaceId: 'workspace-issue-12', agent: 'codex', prompt: launchPrompt('ru', launch.taskFile, launch.reportFile) },
    },
  ])
  assert.deepEqual(r.worker.refusals, [])
  assert.equal(launch.terminalId, 'terminal-1')
  // The task file is the implementer's task, and it names the report file.
  assert.equal(r.orca.machine.files.get(launch.taskFile), request(12, 'implementer').taskText(launch))
  assert.ok(r.orca.machine.files.get(launch.taskFile)?.startsWith('# Задание исполнителя: задача #12\n'))
  assert.ok(r.orca.machine.files.get(launch.taskFile)?.includes(launch.reportFile))

  const t0 = r.orca.clock.now()
  const notReady = { ready: false, reportFile: launch.reportFile, failure: null }
  // Orca has said nothing yet: the terminal is there, but the agent has not started on the task.
  assert.deepEqual(await r.agents.report(launch), { ...notReady, state: null, started: false, reportExists: false })
  await r.worker.emit('agent.status.changed', status(launch, 'working', t0 + 1_000))
  assert.deepEqual(await r.agents.report(launch), { ...notReady, state: 'working', started: true, reportExists: false })
  // The report file is there, but the agent is still working (it may be writing it): not ready.
  r.orca.machine.files.set(launch.reportFile, 'Сделано: фильтр по цвету.\n')
  assert.deepEqual(await r.agents.report(launch), { ...notReady, state: 'working', started: true, reportExists: true })
  await r.worker.emit('agent.status.changed', status(launch, 'waiting', t0 + 2_000))
  assert.deepEqual(await r.agents.report(launch), { ...notReady, state: 'waiting', started: true, reportExists: true })
  // An older state arriving late does not replace the newer one.
  await r.worker.emit('agent.status.changed', status(launch, 'done', t0 + 1_500, t0 + 2_500))
  assert.deepEqual(await r.agents.report(launch), { ...notReady, state: 'waiting', started: true, reportExists: true })
  await r.worker.emit('agent.status.changed', status(launch, 'done', t0 + 3_000))
  assert.deepEqual(await r.agents.report(launch), { ready: true, text: 'Сделано: фильтр по цвету.\n', reportFile: launch.reportFile })

  // «done» first, the report file later: ready only once the file appears.
  const reviewer = await launched(r, 12, 'reviewer')
  assert.equal(reviewer.agent, 'claude')
  assert.equal(reviewer.number, 2)
  await r.worker.emit('agent.status.changed', status(reviewer, 'working', t0 + 3_500))
  await r.worker.emit('agent.status.changed', status(reviewer, 'done', t0 + 4_000))
  assert.deepEqual(await r.agents.report(reviewer), {
    ready: false,
    state: 'done',
    started: true,
    reportFile: reviewer.reportFile,
    reportExists: false,
    failure: null,
  })
  r.orca.machine.files.set(reviewer.reportFile, 'VERDICT: approve\n')
  assert.deepEqual(await r.agents.report(reviewer), { ready: true, text: 'VERDICT: approve\n', reportFile: reviewer.reportFile })
  // A state of another terminal changes nothing for these two.
  await r.worker.emit('agent.status.changed', { ...status(launch, 'working', t0 + 5_000), terminalId: 'terminal-of-someone-else' })
  assert.equal((await r.agents.report(launch)).ready, true)
  assert.deepEqual(r.worker.refusals, [])
  await r.worker.deactivate()
})

test('Задание не дошло до агента: терминал Orca открыла, а хода агент не начал — через 10 минут отчёт называет сбой доставки', async () => {
  const r = await mount(fakeOrca())
  const launch = await launched(r, 14, 'implementer')
  // Orca opened the terminal; its prompt did not get through (a hook refused it, the agent never became ready): Orca
  // reports the agent idle and nothing else.
  r.orca.list(launch.terminalId, 'waiting', launch.launchedAt + 2_000)
  r.orca.clock.advance(DELIVERY_DEADLINE_MS - 1)
  assert.deepEqual(await r.agents.report(launch), {
    ready: false,
    state: 'waiting',
    started: false,
    reportFile: launch.reportFile,
    reportExists: false,
    failure: null,
  })
  r.orca.clock.advance(1)
  const late = await r.agents.report(launch)
  assert.ok(!late.ready)
  assert.equal(
    late.failure,
    'the task did not reach the agent "codex" in terminal terminal-1: Orca saw it start no turn in 10 minutes (its state: waiting)',
  )

  // A turn start seen in time is the delivery: no failure however long the agent then works.
  const other = await launched(r, 15, 'implementer')
  await r.worker.emit('agent.status.changed', status(other, 'working', other.launchedAt + 3_000))
  r.orca.clock.advance(3 * DELIVERY_DEADLINE_MS)
  const working = await r.agents.report(other)
  assert.ok(!working.ready && working.started && working.failure === null, JSON.stringify(working))
  await r.worker.deactivate()
})

test('Агента из настроек Orca не знает → ошибка с именем агента, ничего не запущено', async () => {
  const r = await mount(fakeOrca())
  const result = await r.agents.launch(request(12, 'implementer', { ...AGENTS, implementer: 'nosuch-agent' }))
  assert.deepEqual(result, {
    ok: false,
    kind: 'unknown-agent',
    role: 'implementer',
    agent: 'nosuch-agent',
    error: 'Orca does not know the agent "nosuch-agent" (agents.implementer in .agent-queue.json)',
  })
  // Orca refused the launch before starting anything: no terminal, no other call.
  assert.deepEqual(r.worker.refusals, [{ method: 'agent.launch', code: 'invalid_params', message: 'unknown agent' }])
  assert.deepEqual(
    r.orca.host.calls.map((call) => call.method),
    ['agent.launch'],
  )
  assert.equal(r.orca.terminals.size, 0)
  const records = r.agents.launches(issueTask(PROJECT, 12))
  assert.deepEqual(
    records.map((record) => [record.outcome, record.terminalId, record.error]),
    [['failed', null, result.ok ? null : result.error]],
  )
  // Nothing to stop.
  assert.deepEqual(await r.agents.stop(issueTask(PROJECT, 12)), { closed: [], failed: [] })
  assert.deepEqual(r.orca.host.callsOf('terminal.close'), [])
  await r.worker.deactivate()
})

test('Запуск с ошибкой Orca → ошибка с именем агента и причиной', async () => {
  const r = await mount(
    fakeOrca({
      results: {
        'agent.launch': () => {
          throw hostError('action_failed', 'the workspace is gone')
        },
      },
    }),
  )
  const result = await r.agents.launch(request(13, 'reviewer'))
  assert.deepEqual(result, {
    ok: false,
    kind: 'launch-failed',
    role: 'reviewer',
    agent: 'claude',
    error: 'Orca could not launch the agent "claude" (agents.reviewer in .agent-queue.json): action_failed: the workspace is gone',
  })
  assert.deepEqual(r.agents.launches(issueTask(PROJECT, 13)).map((record) => record.outcome), ['failed'])
  await r.worker.deactivate()
})

test('Остановка агентов задачи закрывает только терминалы, которые плагин открыл для этой задачи', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)
  const implementer = await launched(r, 12, 'implementer')
  const reviewer = await launched(r, 12, 'reviewer')
  const other = await launched(r, 13, 'implementer')
  // The owner's own terminal in the task's worktree, and a launch of the same task that Orca refused (no terminal).
  const owners = orca.ownerTerminal('workspace-issue-12')
  assert.equal((await r.agents.launch(request(12, 'solver', { ...AGENTS, solver: 'nosuch-agent' }))).ok, false)
  assert.deepEqual([implementer.terminalId, reviewer.terminalId, other.terminalId], ['terminal-1', 'terminal-2', 'terminal-3'])

  assert.deepEqual(await r.agents.stop(issueTask(PROJECT, 12)), { closed: ['terminal-1', 'terminal-2'], failed: [] })
  assert.deepEqual(orca.host.callsOf('terminal.close'), [{ terminalId: 'terminal-1' }, { terminalId: 'terminal-2' }])
  assert.deepEqual(
    [...orca.terminals.values()].map((terminal) => [terminal.id, terminal.open]),
    [
      ['terminal-1', false],
      ['terminal-2', false],
      ['terminal-3', true],
      [owners, true],
    ],
  )
  // Closed once: a second stop closes nothing, and the closed agent takes no message.
  assert.deepEqual(await r.agents.stop(issueTask(PROJECT, 12)), { closed: [], failed: [] })
  assert.equal(orca.host.callsOf('terminal.close').length, 2)
  assert.deepEqual(await r.agents.message(implementer, 'Продолжайте'), {
    ok: false,
    error: "the plugin has closed the agent's terminal terminal-1",
  })
  assert.deepEqual(orca.terminals.get('terminal-1')?.typed, [])
  await r.worker.deactivate()

  // After a restart of the worker the records of the data directory are enough: issue 13's terminal is closed, issue
  // 12's are not closed again.
  const restarted = await mount(orca)
  assert.deepEqual(await restarted.agents.stop(issueTask(PROJECT, 12)), { closed: [], failed: [] })
  assert.deepEqual(await restarted.agents.stop(issueTask(PROJECT, 13)), { closed: ['terminal-3'], failed: [] })
  assert.deepEqual(orca.host.callsOf('terminal.close').slice(2), [{ terminalId: 'terminal-3' }])
  assert.equal(orca.terminals.get(owners)?.open, true)
  // The host's refusals: only the launch of the unknown agent, before the restart.
  assert.deepEqual(restarted.worker.refusals, [{ method: 'agent.launch', code: 'invalid_params', message: 'unknown agent' }])
  await restarted.worker.deactivate()
})

test('Остановка во время запуска ждёт ответа Orca и закрывает открытый им терминал; запуск без записанного ответа — ошибка остановки', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)
  let release = () => {}
  orca.launchGate = new Promise<void>((resolve) => {
    release = resolve
  })
  const launching = r.agents.launch(request(16, 'implementer'))
  let stopped = false
  const stopping = r.agents.stop(issueTask(PROJECT, 16)).then((result) => {
    stopped = true
    return result
  })
  // Orca has not answered: the launch is on disk without its answer, and the stop waits (no timer: the pending
  // promises get every turn they need).
  for (let turn = 0; turn < 100; turn++) await Promise.resolve()
  assert.equal(stopped, false)
  assert.deepEqual(r.agents.launches(issueTask(PROJECT, 16)).map((record) => record.outcome), ['pending'])
  orca.launchGate = null
  release()
  const result = await launching
  assert.ok(result.ok)
  assert.deepEqual(await stopping, { closed: ['terminal-1'], failed: [] })
  assert.equal(orca.terminals.get('terminal-1')?.open, false)
  await r.worker.deactivate()

  // A worker that stopped while Orca was launching left the launch without its answer: a new worker cannot know its
  // terminal, and says so instead of reporting the task stopped.
  const dir = dataPath(orca.machine, dataDirectory(orca.machine), 'projects', dataName(PROJECT), 'issue-17', 'agents', '1')
  orca.machine.files.set(`${dir}/task.md`, '# Задание\n')
  orca.machine.files.set(
    `${dir}/launching.json`,
    JSON.stringify({ role: 'implementer', agent: 'codex', language: 'ru', workspaceId: 'workspace-issue-17', launchedAt: 1 }),
  )
  const restarted = await mount(orca)
  assert.deepEqual(await restarted.agents.stop(issueTask(PROJECT, 17)), {
    closed: [],
    failed: [
      {
        launch: 1,
        terminalId: null,
        error: 'Orca\'s answer to launch 1 (the agent "codex") is not recorded: the worker stopped while it was being launched, and its terminal, if any, is unknown',
      },
    ],
  })
  await restarted.worker.deactivate()
})

test('Остановка: терминал, который Orca не закрыла, — ошибка с причиной, если он ещё есть, и закрыт, если его уже нет', async () => {
  const orca = fakeOrca({
    results: {
      'terminal.close': () => {
        throw hostError('action_failed', 'the terminal did not close')
      },
    },
  })
  const r = await mount(orca)
  await launched(r, 21, 'implementer')
  await launched(r, 21, 'reviewer')
  orca.ownerTerminal('workspace-issue-21')
  const refused = 'action_failed: the terminal did not close'
  assert.deepEqual(await r.agents.stop(issueTask(PROJECT, 21)), {
    closed: [],
    failed: [
      { launch: 1, terminalId: 'terminal-1', error: refused },
      { launch: 2, terminalId: 'terminal-2', error: refused },
    ],
  })
  // The owner closed terminal-1 by hand: it is gone, so it counts as closed; terminal-2 is still there.
  const closedByHand = orca.terminals.get('terminal-1')
  assert.ok(closedByHand)
  closedByHand.open = false
  assert.deepEqual(await r.agents.stop(issueTask(PROJECT, 21)), {
    closed: ['terminal-1'],
    failed: [{ launch: 2, terminalId: 'terminal-2', error: refused }],
  })
  assert.deepEqual(
    orca.host.callsOf('terminal.close').map((params) => (params as { terminalId: string }).terminalId),
    ['terminal-1', 'terminal-2', 'terminal-1', 'terminal-2'],
  )
  await r.worker.deactivate()
})

test('Сообщение агенту в фоновом worktree — в его терминал через CLI Orca (API плагина печатает только в активный worktree), одной строкой с файлом сообщения и своим файлом отчёта', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)
  const launch = await launched(r, 30, 'implementer')
  // The owner looks at another worktree: the plugin API refuses to type into the agent's terminal there.
  orca.focused = 'workspace-of-the-main-checkout'
  await assert.rejects(
    r.host.call('terminal.sendText', { terminalId: launch.terminalId, text: 'x', enter: true }),
    /terminal is outside the active worktree/,
  )

  const findings = 'Замечания круга 1:\n- major: src/catalog.ts:10 — фильтр не сбрасывается\n- nit: опечатка в README'
  const sent = await r.agents.message(launch, findings)
  const messageFile = dataPath(orca.machine, launch.dir, 'message-1.md')
  const reportFile = dataPath(orca.machine, launch.dir, 'report-1.md')
  assert.deepEqual(sent, { ok: true, reportFile, started: true })
  assert.equal(orca.machine.files.get(messageFile), findings)
  assert.deepEqual(orca.terminals.get(launch.terminalId)?.typed, [messageLine('ru', messageFile, reportFile)])
  // Through Orca's CLI found on the computer, by the terminal's handle, with Enter, waiting to see the turn start.
  const sends = orca.machine.starts.filter((start) => start.args[0] === 'terminal')
  assert.deepEqual(
    sends.map((start) => [start.file, ...start.args]),
    [[orca.cli, 'terminal', 'send', '--terminal', 'terminal-1', '--text', messageLine('ru', messageFile, reportFile), '--enter', '--wait-submit', '30', '--json']],
  )
  assert.deepEqual(orca.host.callsOf('terminal.sendText').length, 1)

  // The second message has files of its own; a CLI that sees no turn start yet still delivers it.
  orca.turnStarts = false
  assert.deepEqual(await r.agents.message(launch, 'Ещё: обновите README.'), {
    ok: true,
    reportFile: dataPath(orca.machine, launch.dir, 'report-2.md'),
    started: false,
  })
  assert.deepEqual(await r.agents.message(launch, '  '), { ok: false, error: 'the message is empty' })

  // A terminal Orca no longer has (the owner closed it, the plugin did not): the CLI's refusal is the error.
  const gone = orca.terminals.get(launch.terminalId)
  assert.ok(gone)
  gone.open = false
  const refused = await r.agents.message(launch, 'Продолжайте')
  assert.ok(!refused.ok && /^the message did not go into the agent's terminal terminal-1: orca terminal send: terminal_handle_stale terminal-1 \(exit 1\)$/.test(refused.error), JSON.stringify(refused))
  await r.worker.deactivate()
})

test('Отчёт после сообщения — только из файла отчёта этого сообщения: прежний отчёт после нового «done» не принимается', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)
  const launch = await launched(r, 31, 'implementer')
  const t0 = orca.clock.now()
  await r.worker.emit('agent.status.changed', status(launch, 'working', t0 + 1_000))
  orca.machine.files.set(launch.reportFile, 'Отчёт круга 1.\n')
  await r.worker.emit('agent.status.changed', status(launch, 'done', t0 + 2_000))
  assert.equal((await r.agents.report(launch)).ready, true)

  orca.clock.advance(5_000)
  const sent = await r.agents.message(launch, 'Замечание: добавьте тест на сброс фильтра.')
  assert.ok(sent.ok)
  // The agent answered and went «done» again without writing the new report: the report of round 1 does not count.
  await r.worker.emit('agent.status.changed', status(launch, 'working', t0 + 6_000))
  await r.worker.emit('agent.status.changed', status(launch, 'done', t0 + 9_000))
  assert.deepEqual(await r.agents.report(launch), {
    ready: false,
    state: 'done',
    started: true,
    reportFile: sent.reportFile,
    reportExists: false,
    failure: null,
  })
  orca.machine.files.set(sent.reportFile, 'Отчёт круга 2.\n')
  assert.deepEqual(await r.agents.report(launch), { ready: true, text: 'Отчёт круга 2.\n', reportFile: sent.reportFile })
  await r.worker.deactivate()
})

test('Запоздалое событие старого «done» после сообщения не перекрывает начатый ход: время сравнивается по началу состояния', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)
  const launch = await launched(r, 32, 'implementer')
  const t0 = orca.clock.now()
  await r.worker.emit('agent.status.changed', status(launch, 'working', t0 + 1_000))
  orca.machine.files.set(launch.reportFile, 'Отчёт круга 1.\n')
  await r.worker.emit('agent.status.changed', status(launch, 'done', t0 + 2_000))

  orca.clock.advance(10_000)
  const sentAt = orca.clock.now()
  const sent = await r.agents.message(launch, 'Замечание: фильтр не сбрасывается.')
  assert.ok(sent.ok)
  // Orca lists the new turn; the agent has already written its new report and goes on working.
  orca.list(launch.terminalId, 'working', sentAt + 100)
  orca.machine.files.set(sent.reportFile, 'Отчёт круга 2 (черновик).\n')
  // A late update of the old «done»: Orca got it after the message, but that «done» began before it.
  await r.worker.emit('agent.status.changed', status(launch, 'done', t0 + 2_000, sentAt + 200))
  assert.deepEqual(await r.agents.report(launch), {
    ready: false,
    state: 'working',
    started: true,
    reportFile: sent.reportFile,
    reportExists: true,
    failure: null,
  })
  await r.worker.emit('agent.status.changed', status(launch, 'done', sentAt + 5_000))
  assert.equal((await r.agents.report(launch)).ready, true)
  await r.worker.deactivate()
})

test('Состояние агента из agents.list, когда событий не было: после перезапуска воркера отчёт готов по списку агентов Orca', async () => {
  const orca = fakeOrca({ platform: 'win32' })
  const first = await mount(orca)
  const launch = await launched(first, 40, 'implementer', DEFAULT_AGENTS)
  assert.equal(launch.agent, 'claude')
  assert.ok(launch.taskFile.startsWith('C:\\Users\\Avery\\AppData\\Local\\orca-agent-queue\\projects\\'), launch.taskFile)
  await first.worker.deactivate()
  orca.machine.files.set(launch.reportFile, 'Готово.\n')
  orca.ownerTerminal('workspace-issue-40')

  orca.list(launch.terminalId, 'working', launch.launchedAt + 5)
  const restarted = await mount(orca)
  const [record] = restarted.agents.launches(issueTask(PROJECT, 40))
  assert.ok(record && record.terminalId !== null && record.outcome === 'launched')
  const again: AgentLaunch = { ...record, terminalId: record.terminalId }
  assert.deepEqual(await restarted.agents.state(again), { state: 'working', since: launch.launchedAt + 5 })
  assert.equal((await restarted.agents.report(again)).ready, false)
  orca.list(launch.terminalId, 'done', launch.launchedAt + 60_000)
  assert.deepEqual(await restarted.agents.report(again), { ready: true, text: 'Готово.\n', reportFile: launch.reportFile })
  // A worker that heard nothing about the agent, while Orca no longer lists it (its terminal is gone): no state, no
  // report.
  orca.unlist(launch.terminalId)
  const restartedAgain = await mount(orca)
  const unknown = await restartedAgain.agents.report(again)
  assert.ok(!unknown.ready && unknown.state === null && unknown.reportExists, JSON.stringify(unknown))
  await restarted.worker.deactivate()
  await restartedAgain.worker.deactivate()
})

test('Задачи с ключом не из слов и не с номером issue — ошибка, а не путь вне каталога задачи', async () => {
  const r = await mount(fakeOrca())
  assert.throws(() => issueTask(PROJECT, 0), /not an issue number: 0/)
  assert.throws(() => issueTask(PROJECT, 1.5), /not an issue number/)
  assert.throws(() => r.agents.launches({ project: PROJECT, key: '../issue-1' }), /not a task key/)
  const failed = await r.agents.launch({ ...request(1, 'implementer'), task: { project: PROJECT, key: 'Issue 1' } })
  assert.ok(!failed.ok && failed.kind === 'launch-failed' && /not a task key/.test(failed.error), JSON.stringify(failed))
  assert.deepEqual(r.orca.host.calls, [])
  // The start agent's own work in the project has a key of words.
  const start = await r.agents.launch({ ...request(1, 'start'), task: { project: PROJECT, key: 'mvp-start' } })
  assert.ok(start.ok && start.launch.agent === 'opencode' && start.launch.taskFile.includes('/mvp-start/agents/1/'), JSON.stringify(start))
  await r.worker.deactivate()
})
