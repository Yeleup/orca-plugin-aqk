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

// Every `terminal send` the fake computer ran, as the file and its arguments.
function cliSends(orca: FakeOrca): string[][] {
  return orca.machine.starts.filter((start) => start.args[0] === 'terminal').map((start) => [start.file, ...start.args])
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
  const notReady = { ready: false, reportFile: launch.reportFile, unresolved: null, failure: null }
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
    unresolved: null,
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
    unresolved: null,
    failure: null,
  })
  r.orca.clock.advance(1)
  const late = await r.agents.report(launch)
  assert.ok(!late.ready)
  assert.deepEqual(late.failure, {
    state: 'waiting',
    error: 'the task did not start a turn of the agent "codex" in terminal terminal-1 in 10 minutes (Orca shows it waiting)',
  })

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
    outcome: 'not-sent',
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
  // Through Orca's CLI found on the computer, by the terminal's handle, with Enter, as the request recorded before the
  // line was typed, waiting to see the turn start.
  const recorded = JSON.parse(orca.machine.files.get(dataPath(orca.machine, launch.dir, 'sending-1.json')) ?? '{}') as { requestId: string }
  assert.match(recorded.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.deepEqual(cliSends(orca), [
    [orca.cli, 'terminal', 'send', '--terminal', 'terminal-1', '--text', messageLine('ru', messageFile, reportFile), '--enter', '--retry-request', recorded.requestId, '--wait-submit', '30', '--json'],
  ])
  // The plugin API was called once — by this test, above — never by the agents layer.
  assert.equal(orca.host.callsOf('terminal.sendText').length, 1)

  // The second message has files of its own; a CLI that sees no turn start yet still delivers it.
  orca.turnStarts = false
  assert.deepEqual(await r.agents.message(launch, 'Ещё: обновите README.'), {
    ok: true,
    reportFile: dataPath(orca.machine, launch.dir, 'report-2.md'),
    started: false,
  })
  assert.deepEqual(await r.agents.message(launch, '  '), { ok: false, outcome: 'not-sent', error: 'the message is empty' })

  // A terminal Orca no longer has (the owner closed it, the plugin did not): the CLI's refusal is the error.
  const gone = orca.terminals.get(launch.terminalId)
  assert.ok(gone)
  gone.open = false
  assert.deepEqual(await r.agents.message(launch, 'Продолжайте'), {
    ok: false,
    outcome: 'not-sent',
    error: "message 3 into the agent's terminal terminal-1: orca terminal send: terminal_handle_stale terminal-1 (exit 1): not sent",
  })
  await r.worker.deactivate()
})

// The send of message k as the plugin recorded it before typing.
function sendingOf(orca: FakeOrca, launch: AgentLaunch, k: number): { sentAt: number; line: string; requestId: string; reportFile: string } {
  const text = orca.machine.files.get(dataPath(orca.machine, launch.dir, `sending-${k}.json`))
  assert.ok(text !== undefined, `no sending-${k}.json`)
  return JSON.parse(text) as { sentAt: number; line: string; requestId: string; reportFile: string }
}

async function settle(): Promise<void> {
  // No timer: every pending promise gets the turns it needs.
  for (let turn = 0; turn < 100; turn++) await Promise.resolve()
}

test('Сообщение агенту, когда активен worktree самого агента, — тем же вызовом CLI Orca; terminal.sendText, terminal.focus и workspace.open не вызываются', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)
  const launch = await launched(r, 33, 'implementer')
  orca.focused = launch.workspaceId
  const sent = await r.agents.message(launch, 'Замечание: обновите README.')
  assert.ok(sent.ok, JSON.stringify(sent))
  const recorded = sendingOf(orca, launch, 1)
  assert.deepEqual(cliSends(orca), [
    [orca.cli, 'terminal', 'send', '--terminal', launch.terminalId, '--text', recorded.line, '--enter', '--retry-request', recorded.requestId, '--wait-submit', '30', '--json'],
  ])
  assert.deepEqual(orca.terminals.get(launch.terminalId)?.typed, [recorded.line])
  for (const method of ['terminal.sendText', 'terminal.focus', 'workspace.open']) assert.deepEqual(orca.host.callsOf(method), [], method)
  await r.worker.deactivate()
})

test('CLI Orca на компьютере нет, worktree агента активен — сообщение не отправлено, ошибка с причиной поиска CLI, в терминал ничего не введено', async () => {
  const orca = fakeOrca({ cli: false })
  const r = await mount(orca)
  const launch = await launched(r, 34, 'implementer')
  orca.focused = launch.workspaceId
  const sent = await r.agents.message(launch, 'Продолжайте')
  assert.ok(!sent.ok && sent.outcome === 'not-sent', JSON.stringify(sent))
  assert.ok(sent.error.startsWith(`message 1 into the agent's terminal ${launch.terminalId}: Orca's CLI is not found: `), sent.error)
  // The reason names where the CLI was looked for.
  assert.ok(sent.error.includes('orca-ide: not in PATH') && sent.error.includes(`${orca.cli}: no such file`), sent.error)
  assert.deepEqual(orca.terminals.get(launch.terminalId)?.typed, [])
  assert.deepEqual(orca.host.callsOf('terminal.sendText'), [])
  assert.deepEqual(cliSends(orca), [])
  // The message is not the agent's last input: its task still is.
  const report = await r.agents.report(launch)
  assert.ok(!report.ready && report.reportFile === launch.reportFile, JSON.stringify(report))
  await r.worker.deactivate()
})

test('Сообщение в терминал не из записи запуска (терминал владельца) — ошибка, CLI не запускается, в терминал ничего не введено', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)
  const launch = await launched(r, 35, 'implementer')
  const owners = orca.ownerTerminal(launch.workspaceId)
  assert.deepEqual(await r.agents.message({ ...launch, terminalId: owners }, 'Продолжайте'), {
    ok: false,
    outcome: 'not-sent',
    error: `the terminal ${owners} is not the terminal of the plugin's launch in ${launch.dir}: nothing is typed into it`,
  })
  // A launch the data directory has no answer of Orca for is refused the same way.
  const elsewhere = dataPath(orca.machine, dataDirectory(orca.machine), 'projects', dataName(PROJECT), 'issue-35', 'agents', '9')
  assert.deepEqual(await r.agents.message({ ...launch, dir: elsewhere }, 'Продолжайте'), {
    ok: false,
    outcome: 'not-sent',
    error: `the terminal ${launch.terminalId} is not the terminal of the plugin's launch in ${elsewhere} (the launch has no record): nothing is typed into it`,
  })
  // The CLI was not even looked for, and nothing went into any terminal.
  assert.deepEqual(orca.machine.starts, [])
  assert.deepEqual(orca.terminals.get(owners)?.typed, [])
  assert.deepEqual(orca.terminals.get(launch.terminalId)?.typed, [])
  await r.worker.deactivate()
})

test('Повторный запрос исхода сверяет терминал с записью запуска: с handle владельца CLI не запускается и исход ждёт с причиной; со своим — строка вводится один раз', async () => {
  const orca = fakeOrca()
  const first = await mount(orca)
  const launch = await launched(first, 43, 'implementer')
  await first.worker.deactivate()
  // A worker that stopped after recording the send of message 1 and before running the CLI.
  const messageFile = dataPath(orca.machine, launch.dir, 'message-1.md')
  const reportFile = dataPath(orca.machine, launch.dir, 'report-1.md')
  const line = messageLine('ru', messageFile, reportFile)
  const requestId = '3c9e7a52-1f4b-4d6a-8e2c-5b7d9f1a3e64'
  orca.machine.files.set(messageFile, 'Замечание: обновите README.')
  orca.machine.files.set(
    dataPath(orca.machine, launch.dir, 'sending-1.json'),
    JSON.stringify({ sentAt: orca.clock.now(), line, requestId, reportFile }),
  )
  const owners = orca.ownerTerminal(launch.workspaceId)

  const restarted = await mount(orca)
  assert.deepEqual(await restarted.agents.report({ ...launch, terminalId: owners }), {
    ready: false,
    state: null,
    started: false,
    reportFile,
    reportExists: false,
    unresolved: `the outcome of message 1 is unknown: the terminal ${owners} is not the terminal of the plugin's launch in ${launch.dir}: nothing is typed into it`,
    failure: null,
  })
  assert.deepEqual(orca.machine.starts, [])
  assert.deepEqual(orca.terminals.get(owners)?.typed, [])
  assert.equal(orca.machine.files.has(dataPath(orca.machine, launch.dir, 'message-1.json')), false)

  // With its own handle the report asks Orca, which never saw the request: the line is typed once, into the launch's
  // terminal.
  const own = await restarted.agents.report(launch)
  assert.ok(!own.ready && own.reportFile === reportFile && own.unresolved === null, JSON.stringify(own))
  assert.deepEqual(orca.terminals.get(launch.terminalId)?.typed, [line])
  assert.deepEqual(orca.terminals.get(owners)?.typed, [])
  assert.deepEqual(
    cliSends(orca).map((args) => args[args.indexOf('--retry-request') + 1]),
    [requestId],
  )
  await restarted.worker.deactivate()
})

test('Orca без поддержки id запроса отказывает (incompatible_runtime) — сообщение не отправлено, в терминале пусто, один запуск CLI с --retry-request; отчёт читается по заданию', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)
  const launch = await launched(r, 44, 'implementer')
  const incompatible = 'This Orca host cannot honor --retry-request and never recorded this request ID. This attempt sent no input.'
  orca.cliRefusals.push({ code: 'incompatible_runtime', message: incompatible })
  assert.deepEqual(await r.agents.message(launch, 'Замечание: обновите README.'), {
    ok: false,
    outcome: 'not-sent',
    error: `message 1 into the agent's terminal terminal-1: orca terminal send: ${incompatible} (exit 1): not sent`,
  })
  assert.deepEqual(orca.terminals.get(launch.terminalId)?.typed, [])
  const sends = cliSends(orca)
  assert.equal(sends.length, 1)
  assert.equal(sends[0]?.[sends[0].indexOf('--retry-request') + 1], sendingOf(orca, launch, 1).requestId)

  // The message is not the agent's last input: the report is the task's, and no CLI runs for it.
  await r.worker.emit('agent.status.changed', status(launch, 'working', launch.launchedAt + 1_000))
  orca.machine.files.set(launch.reportFile, 'Отчёт на задание.\n')
  await r.worker.emit('agent.status.changed', status(launch, 'done', launch.launchedAt + 2_000))
  assert.deepEqual(await r.agents.report(launch), { ready: true, text: 'Отчёт на задание.\n', reportFile: launch.reportFile })
  assert.equal(cliSends(orca).length, 1)
  await r.worker.deactivate()
})

test('Повторный запрос исхода с отказом Orca, без ответа или без CLI исхода не решает: отчёт ждёт файл отчёта сообщения; когда Orca отвечает — строка одна, id запроса один', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)
  const launch = await launched(r, 45, 'implementer')
  const t0 = orca.clock.now()
  await r.worker.emit('agent.status.changed', status(launch, 'working', t0 + 1_000))
  orca.machine.files.set(launch.reportFile, 'Отчёт на задание.\n')
  await r.worker.emit('agent.status.changed', status(launch, 'done', t0 + 2_000))
  assert.equal((await r.agents.report(launch)).ready, true)
  orca.clock.advance(5_000)

  // The line is typed, and the CLI's answer is lost.
  orca.loseAnswers = 1
  const sent = await r.agents.message(launch, 'Замечание: фильтр не сбрасывается.')
  assert.ok(!sent.ok && sent.outcome === 'unknown', JSON.stringify(sent))
  const sending = sendingOf(orca, launch, 1)
  // The agent goes «done» again without writing the report on the message.
  await r.worker.emit('agent.status.changed', status(launch, 'done', orca.clock.now() + 100))

  const asks: [string, () => void][] = [
    ['Orca closed the connection before responding', () => orca.cliRefusals.push({ code: 'runtime_unavailable', message: 'Orca closed the connection before responding' })],
    ['terminal_handle_stale terminal-1', () => orca.cliRefusals.push({ code: 'terminal_handle_stale', message: 'terminal_handle_stale terminal-1' })],
    [`${orca.cli}: no such program`, () => (orca.cliPresent = false)],
  ]
  for (const [reason, refuse] of asks) {
    refuse()
    const waiting = await r.agents.report(launch)
    assert.ok(!waiting.ready, JSON.stringify(waiting))
    assert.equal(waiting.reportFile, sending.reportFile)
    assert.equal(waiting.reportExists, false)
    assert.ok(waiting.unresolved?.startsWith('the outcome of message 1 is unknown: ') && waiting.unresolved.includes(reason), waiting.unresolved ?? '')
    assert.equal(orca.machine.files.has(dataPath(orca.machine, launch.dir, 'message-1.json')), false)
  }

  // Orca answers: it replays the outcome of the request; the line was typed once, every run had the same request id.
  orca.cliPresent = true
  const answered = await r.agents.report(launch)
  assert.ok(!answered.ready && answered.unresolved === null && answered.reportFile === sending.reportFile, JSON.stringify(answered))
  assert.deepEqual(orca.terminals.get(launch.terminalId)?.typed, [sending.line])
  const ids = cliSends(orca).map((args) => args[args.indexOf('--retry-request') + 1])
  assert.ok(ids.length >= 3 && ids.every((id) => id === sending.requestId), JSON.stringify(ids))
  orca.machine.files.set(sending.reportFile, 'Отчёт на замечание.\n')
  await r.worker.emit('agent.status.changed', status(launch, 'done', orca.clock.now() + 1_000))
  assert.deepEqual(await r.agents.report(launch), { ready: true, text: 'Отчёт на замечание.\n', reportFile: sending.reportFile })
  await r.worker.deactivate()
})

test('Первая отправка без ответа Orca (runtime_unavailable) — исход неизвестен, в терминале пусто; следующий отчёт вводит строку один раз тем же id запроса', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)
  const launch = await launched(r, 48, 'implementer')
  orca.cliRefusals.push({ code: 'runtime_unavailable', message: 'Orca is not reachable' })
  assert.deepEqual(await r.agents.message(launch, 'Замечание.'), {
    ok: false,
    outcome: 'unknown',
    error: "the outcome of message 1 into the agent's terminal terminal-1: orca terminal send: Orca is not reachable (exit 1) is unknown",
  })
  assert.deepEqual(orca.terminals.get(launch.terminalId)?.typed, [])
  const sending = sendingOf(orca, launch, 1)
  const report = await r.agents.report(launch)
  assert.ok(!report.ready && report.unresolved === null && report.reportFile === sending.reportFile, JSON.stringify(report))
  assert.deepEqual(orca.terminals.get(launch.terminalId)?.typed, [sending.line])
  assert.deepEqual(
    cliSends(orca).map((args) => args[args.indexOf('--retry-request') + 1]),
    [sending.requestId, sending.requestId],
  )
  await r.worker.deactivate()
})

test('Срок доставки сообщения считается от ввода строки: строка введена позже 10 минут после записи отправки — сбоя нет, через 10 минут после ввода без хода — сбой', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)
  const launch = await launched(r, 49, 'implementer')
  orca.turnStarts = false
  orca.cliRefusals.push({ code: 'runtime_unavailable', message: 'Orca is not reachable' })
  const sent = await r.agents.message(launch, 'Замечание.')
  assert.ok(!sent.ok && sent.outcome === 'unknown')
  orca.clock.advance(DELIVERY_DEADLINE_MS + 60_000)
  const typed = await r.agents.report(launch)
  assert.ok(!typed.ready && !typed.started && typed.failure === null && typed.unresolved === null, JSON.stringify(typed))
  assert.equal(orca.terminals.get(launch.terminalId)?.typed.length, 1)
  orca.clock.advance(DELIVERY_DEADLINE_MS - 1)
  const before = await r.agents.report(launch)
  assert.ok(!before.ready && before.failure === null, JSON.stringify(before))
  orca.clock.advance(1)
  const late = await r.agents.report(launch)
  assert.ok(!late.ready)
  assert.deepEqual(late.failure, {
    state: null,
    error: 'message 1 did not start a turn of the agent "codex" in terminal terminal-1 in 10 minutes (Orca shows it nowhere)',
  })
  await r.worker.deactivate()
})

test('Сообщение, отправленное, пока отчёт ждёт ответа agents.list, — вход этого отчёта: прежний файл отчёта не засчитывается', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)
  const launch = await launched(r, 50, 'implementer')
  await r.worker.emit('agent.status.changed', status(launch, 'working', launch.launchedAt + 1_000))
  orca.machine.files.set(launch.reportFile, 'Отчёт на задание.\n')
  orca.clock.advance(5_000)

  let release = () => {}
  orca.listGate = new Promise<void>((resolve) => {
    release = resolve
  })
  const reading = r.agents.report(launch)
  await settle()
  // Meanwhile a message goes out and the terminal takes it (no turn on it seen yet), and Orca lists a «done» that began
  // after the message.
  orca.turnStarts = false
  const sent = await r.agents.message(launch, 'Замечание: фильтр не сбрасывается.')
  assert.ok(sent.ok, JSON.stringify(sent))
  orca.list(launch.terminalId, 'done', sendingOf(orca, launch, 1).sentAt + 100)
  orca.listGate = null
  release()
  assert.deepEqual(await reading, {
    ready: false,
    state: 'done',
    started: false,
    reportFile: sent.reportFile,
    reportExists: false,
    unresolved: null,
    failure: null,
  })
  orca.machine.files.set(sent.reportFile, 'Отчёт на замечание.\n')
  assert.deepEqual(await r.agents.report(launch), { ready: true, text: 'Отчёт на замечание.\n', reportFile: sent.reportFile })
  await r.worker.deactivate()
})

test('Ход в терминале запуска, услышанный до ответа Orca на запуск, — начало задания на диске: после перезапуска «blocked» без отчёта за сроком — не сбой', async () => {
  const orca = fakeOrca()
  const first = await mount(orca)
  let release = () => {}
  orca.launchGate = new Promise<void>((resolve) => {
    release = resolve
  })
  const launching = first.agents.launch(request(46, 'implementer'))
  await settle()
  // Orca reports the agent of the terminal it opens (terminal-1) working before it answers the launch. The test worker's
  // emit settles once the host has no call pending: its handler runs at once, and the emit is awaited after the gate.
  const startedAt = orca.clock.now() + 500
  const emitted = first.worker.emit('agent.status.changed', {
    workspaceId: 'workspace-issue-46',
    paneKey: 'pane-terminal-1',
    terminalId: 'terminal-1',
    state: 'working',
    receivedAt: startedAt,
    mainAgent: { state: 'working', stateStartedAt: startedAt },
  })
  orca.launchGate = null
  release()
  await emitted
  const result = await launching
  assert.ok(result.ok && result.launch.terminalId === 'terminal-1', JSON.stringify(result))
  assert.ok(orca.machine.files.has(dataPath(orca.machine, result.launch.dir, 'started-0')))
  await first.worker.deactivate()

  orca.list('terminal-1', 'blocked', startedAt + 1_000)
  orca.clock.advance(DELIVERY_DEADLINE_MS + 1)
  const restarted = await mount(orca)
  const [record] = restarted.agents.launches(issueTask(PROJECT, 46))
  assert.ok(record && record.terminalId !== null)
  const again: AgentLaunch = { ...record, terminalId: record.terminalId }
  assert.deepEqual(await restarted.agents.report(again), {
    ready: false,
    state: 'blocked',
    started: true,
    reportFile: again.reportFile,
    reportExists: false,
    unresolved: null,
    failure: null,
  })
  await restarted.worker.deactivate()
})

test('Агент вне списка Orca после перезапуска воркера: «done» без mainAgent отчёт не подтверждает; список Orca с «done» после задания — подтверждает', async () => {
  const orca = fakeOrca()
  const first = await mount(orca)
  const launch = await launched(first, 47, 'implementer')
  await first.worker.emit('agent.status.changed', status(launch, 'working', launch.launchedAt + 1_000))
  await settle()
  assert.ok(orca.machine.files.has(dataPath(orca.machine, launch.dir, 'started-0')))
  orca.machine.files.set(launch.reportFile, 'Отчёт на задание.\n')
  await first.worker.deactivate()

  const restarted = await mount(orca)
  const [record] = restarted.agents.launches(issueTask(PROJECT, 47))
  assert.ok(record && record.terminalId !== null)
  const again: AgentLaunch = { ...record, terminalId: record.terminalId }
  await restarted.worker.emit('agent.status.changed', {
    workspaceId: launch.workspaceId,
    paneKey: `pane-${launch.terminalId}`,
    terminalId: launch.terminalId,
    state: 'done',
    receivedAt: launch.launchedAt + 2_000,
  })
  assert.deepEqual(await restarted.agents.report(again), {
    ready: false,
    state: 'done',
    started: true,
    reportFile: launch.reportFile,
    reportExists: true,
    unresolved: null,
    failure: null,
  })
  orca.list(launch.terminalId, 'done', launch.launchedAt + 3_000)
  assert.deepEqual(await restarted.agents.report(again), { ready: true, text: 'Отчёт на задание.\n', reportFile: launch.reportFile })
  await restarted.worker.deactivate()
})

test('Начало хода хранится на диске: после перезапуска воркера «blocked» без отчёта — не сбой доставки; агент, не начавший ход, — сбой с состоянием Orca', async () => {
  const orca = fakeOrca()
  const first = await mount(orca)
  const launch = await launched(first, 36, 'implementer')
  await first.worker.emit('agent.status.changed', status(launch, 'working', launch.launchedAt + 1_000))
  await settle()
  await first.worker.deactivate()
  assert.ok(orca.machine.files.has(dataPath(orca.machine, launch.dir, 'started-0')))

  // After the restart the agent waits for a person's permission: blocked, no report yet, the deadline long past.
  orca.list(launch.terminalId, 'blocked', launch.launchedAt + 2_000)
  orca.clock.advance(DELIVERY_DEADLINE_MS + 1)
  const restarted = await mount(orca)
  const [record] = restarted.agents.launches(issueTask(PROJECT, 36))
  assert.ok(record && record.terminalId !== null)
  const again: AgentLaunch = { ...record, terminalId: record.terminalId }
  assert.deepEqual(await restarted.agents.report(again), {
    ready: false,
    state: 'blocked',
    started: true,
    reportFile: launch.reportFile,
    reportExists: false,
    unresolved: null,
    failure: null,
  })

  // An agent that never started its task — blocked before its first turn — is reported with what Orca shows of it.
  const other = await launched(restarted, 37, 'implementer')
  orca.list(other.terminalId, 'blocked', other.launchedAt + 500)
  orca.clock.advance(DELIVERY_DEADLINE_MS)
  const late = await restarted.agents.report(other)
  assert.ok(!late.ready)
  assert.deepEqual(late.failure, {
    state: 'blocked',
    error: 'the task did not start a turn of the agent "codex" in terminal terminal-2 in 10 minutes (Orca shows it blocked: it waits for a person)',
  })
  await restarted.worker.deactivate()
})

test('Сообщение с отложенной или потерянной квитанцией CLI: отчёт ждёт исхода и прежний отчёт не принимает; повтор с тем же id запроса не вводит строку второй раз', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)
  const launch = await launched(r, 38, 'implementer')
  const t0 = orca.clock.now()
  await r.worker.emit('agent.status.changed', status(launch, 'working', t0 + 1_000))
  orca.machine.files.set(launch.reportFile, 'Отчёт на задание.\n')
  await r.worker.emit('agent.status.changed', status(launch, 'done', t0 + 2_000))
  assert.equal((await r.agents.report(launch)).ready, true)
  orca.clock.advance(5_000)

  // Orca takes the line at once; the CLI's answer is held back.
  let release = () => {}
  orca.cliGate = new Promise<void>((resolve) => {
    release = resolve
  })
  const sending = r.agents.message(launch, 'Замечание 1.')
  await settle()
  const first = sendingOf(orca, launch, 1)
  assert.deepEqual(orca.terminals.get(launch.terminalId)?.typed, [first.line])
  assert.deepEqual(await r.agents.report(launch), {
    ready: false,
    state: 'done',
    started: false,
    reportFile: first.reportFile,
    reportExists: false,
    unresolved: "message 1 is being typed into the agent's terminal",
    failure: null,
  })
  orca.cliGate = null
  release()
  assert.ok((await sending).ok)

  // The CLI types the line and dies without an answer, and so does the first time the report asks again.
  orca.loseAnswers = 2
  const lost = await r.agents.message(launch, 'Замечание 2.')
  assert.ok(!lost.ok && lost.outcome === 'unknown' && lost.error.startsWith("the outcome of message 2 into the agent's terminal terminal-1: orca terminal send: stopped after"), JSON.stringify(lost))
  const second = sendingOf(orca, launch, 2)
  await r.worker.emit('agent.status.changed', status(launch, 'done', orca.clock.now() + 100))
  const waiting = await r.agents.report(launch)
  assert.ok(!waiting.ready && waiting.reportFile === second.reportFile && waiting.unresolved?.startsWith('the outcome of message 2 is unknown: '), JSON.stringify(waiting))
  await r.worker.deactivate()

  // After a restart of the worker the report asks Orca again with the same request id: Orca replays the outcome, and
  // the line is not typed a second time.
  const restarted = await mount(orca)
  const resolved = await restarted.agents.report(launch)
  assert.deepEqual(resolved, {
    ready: false,
    state: null,
    started: true,
    reportFile: second.reportFile,
    reportExists: false,
    unresolved: null,
    failure: null,
  })
  assert.deepEqual(orca.terminals.get(launch.terminalId)?.typed, [first.line, second.line])
  assert.deepEqual(
    cliSends(orca).map((args) => args[args.indexOf('--retry-request') + 1]),
    [first.requestId, second.requestId, second.requestId, second.requestId],
  )
  orca.machine.files.set(second.reportFile, 'Отчёт на замечание 2.\n')
  await restarted.worker.emit('agent.status.changed', status(launch, 'done', orca.clock.now() + 1_000))
  assert.deepEqual(await restarted.agents.report(launch), { ready: true, text: 'Отчёт на замечание 2.\n', reportFile: second.reportFile })
  await restarted.worker.deactivate()
})

test('Событие без mainAgent не перекрывает текущий список агентов Orca; без времени начала «done» засчитывается только после увиденного хода на последнее слово', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)
  const launch = await launched(r, 39, 'implementer')
  const t0 = orca.clock.now()
  await r.worker.emit('agent.status.changed', status(launch, 'working', t0 + 1_000))
  orca.machine.files.set(launch.reportFile, 'Отчёт круга 1.\n')
  await r.worker.emit('agent.status.changed', status(launch, 'done', t0 + 2_000))
  orca.clock.advance(10_000)
  const sentAt = orca.clock.now()
  orca.turnStarts = false
  const sent = await r.agents.message(launch, 'Замечание: фильтр не сбрасывается.')
  assert.ok(sent.ok)

  // Orca lists the new turn; the agent has written its new report and goes on working. A late «done» without the main
  // agent's state arrives, which Orca got after that turn began.
  const noMain = (state: AgentState, receivedAt: number): PluginEvents['agent.status.changed'] => ({
    workspaceId: launch.workspaceId,
    paneKey: `pane-${launch.terminalId}`,
    terminalId: launch.terminalId,
    state,
    receivedAt,
  })
  orca.list(launch.terminalId, 'working', sentAt + 100)
  orca.machine.files.set(sent.reportFile, 'Отчёт круга 2 (черновик).\n')
  await r.worker.emit('agent.status.changed', noMain('done', sentAt + 200))
  const listed = await r.agents.report(launch)
  assert.ok(!listed.ready && listed.state === 'working', JSON.stringify(listed))

  // Orca no longer lists the agent: only its events are left. That «done» came before the turn the worker saw, so it
  // is not the end of it; a «done» Orca reports after it is.
  orca.unlist(launch.terminalId)
  const unlisted = await r.agents.report(launch)
  assert.ok(!unlisted.ready && unlisted.state === 'done' && unlisted.started, JSON.stringify(unlisted))
  await r.worker.emit('agent.status.changed', noMain('done', sentAt + 5_000))
  assert.deepEqual(await r.agents.report(launch), { ready: true, text: 'Отчёт круга 2 (черновик).\n', reportFile: sent.reportFile })
  await r.worker.deactivate()
})

test('Запуск, начатый во время остановки той же задачи, отклоняется: после остановки у задачи нет живых терминалов', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)
  await launched(r, 41, 'implementer')
  let release = () => {}
  orca.closeGate = new Promise<void>((resolve) => {
    release = resolve
  })
  const stopping = r.agents.stop(issueTask(PROJECT, 41))
  await settle()
  // Orca has not yet answered the close of terminal-1.
  assert.deepEqual(orca.host.callsOf('terminal.close'), [{ terminalId: 'terminal-1' }])
  assert.deepEqual(await r.agents.launch(request(41, 'reviewer')), {
    ok: false,
    kind: 'launch-failed',
    role: 'reviewer',
    agent: 'claude',
    error: 'the agent "claude" (agents.reviewer in .agent-queue.json) was not launched: the agents of issue-41 are being stopped',
  })
  // Another task launches as usual.
  assert.ok((await r.agents.launch(request(42, 'implementer'))).ok)
  orca.closeGate = null
  release()
  assert.deepEqual(await stopping, { closed: ['terminal-1'], failed: [] })
  assert.deepEqual(
    [...orca.terminals.values()].filter((terminal) => terminal.workspaceId === 'workspace-issue-41' && terminal.open),
    [],
  )
  // Once the stop is over, the task launches again.
  assert.ok((await r.agents.launch(request(41, 'reviewer'))).ok)
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
    unresolved: null,
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
    unresolved: null,
    failure: null,
  })
  // The agent ends its turn: Orca lists it «done» and reports it.
  orca.list(launch.terminalId, 'done', sentAt + 5_000)
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
