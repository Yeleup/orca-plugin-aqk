// The agents layer of the worker (src/agents/agents.ts) over Orca's mock host: what is launched and with which params,
// when a report counts as ready, what goes into an agent's terminal, what a stop closes and what it leaves. The worker
// runs as Orca runs it (`mountWorker`: the manifest's capabilities and events); the computer is a fake one with files in
// memory and a clock that moves only when the test moves it. Invented project, issues, terminals and workspaces only.
import { assert, hostError, mockHost, mountWorker, test, type MockHost, type TestWorker } from 'orca/testing'
import type { PluginEvents } from 'orca/worker'
import { dataDirectory, dataName, dataPath } from '../platform/paths'
import { DEFAULT_AGENTS, type AgentRole, type ProjectAgents } from '../project/settings'
import { fakeMachine, type FakeMachine } from '../testing/fake-machine'
import { Agents, issueTask, startAgents, type AgentLaunch, type LaunchRequest } from './agents'
import { implementerTask, launchPrompt, messageFileLine, reviewerTask } from './task-text'

const PROJECT = 'example-org/sample-shop'
const DATA_RULE = 'Никаких данных покупателей: имён, телефонов, адресов, токенов и ключей.'
// Agents of the settings other than the defaults: each role gets the agent of its own field.
const AGENTS: ProjectAgents = { implementer: 'codex', reviewer: 'claude', solver: 'gemini', start: 'opencode' }

type Rig = { readonly machine: FakeMachine; readonly worker: TestWorker; readonly host: MockHost; readonly agents: Agents }

// The worker's agents layer on a mock host whose `agent.launch` opens terminal-1, terminal-2 … and whose terminals take
// every text; `results` adds or replaces answers.
async function rig(results: Record<string, unknown> = {}, machine: FakeMachine = fakeMachine({ platform: 'linux' })): Promise<Rig> {
  let opened = 0
  const host = mockHost({
    results: {
      'agent.launch': () => ({ terminalId: `terminal-${++opened}` }),
      'terminal.sendText': { accepted: true },
      ...results,
    },
  })
  let agents: Agents | undefined
  const worker = await mountWorker(
    {
      default: (orca) => {
        agents = startAgents(orca, machine, dataDirectory(machine))
      },
    },
    { host },
  )
  assert.ok(agents)
  return { machine, worker, host, agents }
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

function status(launch: AgentLaunch, state: AgentState, receivedAt: number): PluginEvents['agent.status.changed'] {
  return { workspaceId: launch.workspaceId, paneKey: `pane-${launch.terminalId}`, terminalId: launch.terminalId, state, receivedAt }
}

type AgentState = PluginEvents['agent.status.changed']['state']

test('Запуск исполнителя через поддельный хост → agent.launch с агентом из настроек, worktree задачи и заданием; отчёт готов только после состояния «done» и появления файла отчёта', async () => {
  const r = await rig()
  const launch = await launched(r, 12, 'implementer')

  // agent.launch: the implementer's agent of the settings, in the task's worktree, with the prompt naming the task file.
  const dir = dataPath(r.machine, dataDirectory(r.machine), 'projects', dataName(PROJECT), 'issue-12', 'agents', '1')
  assert.equal(launch.taskFile, `${dir}/task.md`)
  assert.equal(launch.reportFile, `${dir}/report.md`)
  assert.deepEqual(r.host.calls, [
    {
      method: 'agent.launch',
      params: { workspaceId: 'workspace-issue-12', agent: 'codex', prompt: launchPrompt('ru', launch.taskFile, launch.reportFile) },
    },
  ])
  assert.deepEqual(r.worker.refusals, [])
  assert.equal(launch.terminalId, 'terminal-1')
  // The task file is the implementer's task, and it names the report file.
  assert.equal(r.machine.files.get(launch.taskFile), request(12, 'implementer').taskText(launch))
  assert.ok(r.machine.files.get(launch.taskFile)?.startsWith('# Задание исполнителя: задача #12\n'))
  assert.ok(r.machine.files.get(launch.taskFile)?.includes(launch.reportFile))
  assert.equal(r.machine.readText(launch.reportFile), null)

  const t0 = r.machine.now()
  // Nothing from Orca yet: agents.list does not list it.
  assert.deepEqual(await r.agents.report(launch), { ready: false, state: null, finished: false, reportFile: false })
  await r.worker.emit('agent.status.changed', status(launch, 'working', t0 + 1_000))
  assert.deepEqual(await r.agents.report(launch), { ready: false, state: 'working', finished: false, reportFile: false })
  // The report file is there, but the agent is still working (it may be writing it): not ready.
  r.machine.files.set(launch.reportFile, 'Сделано: фильтр по цвету.\n')
  assert.deepEqual(await r.agents.report(launch), { ready: false, state: 'working', finished: false, reportFile: true })
  await r.worker.emit('agent.status.changed', status(launch, 'waiting', t0 + 2_000))
  assert.deepEqual(await r.agents.report(launch), { ready: false, state: 'waiting', finished: false, reportFile: true })
  // An older status arriving late does not replace the newer one.
  await r.worker.emit('agent.status.changed', status(launch, 'done', t0 + 1_500))
  assert.deepEqual(await r.agents.report(launch), { ready: false, state: 'waiting', finished: false, reportFile: true })
  await r.worker.emit('agent.status.changed', status(launch, 'done', t0 + 3_000))
  assert.deepEqual(await r.agents.report(launch), { ready: true, text: 'Сделано: фильтр по цвету.\n' })

  // «done» first, the report file later: ready only once the file appears.
  const reviewer = await launched(r, 12, 'reviewer')
  assert.equal(reviewer.agent, 'claude')
  assert.equal(reviewer.number, 2)
  await r.worker.emit('agent.status.changed', status(reviewer, 'done', t0 + 4_000))
  assert.deepEqual(await r.agents.report(reviewer), { ready: false, state: 'done', finished: true, reportFile: false })
  r.machine.files.set(reviewer.reportFile, 'VERDICT: approve\n')
  assert.deepEqual(await r.agents.report(reviewer), { ready: true, text: 'VERDICT: approve\n' })
  // A status of another terminal changes nothing for these two.
  await r.worker.emit('agent.status.changed', { ...status(launch, 'working', t0 + 5_000), terminalId: 'terminal-of-someone-else' })
  assert.equal((await r.agents.report(launch)).ready, true)
  assert.deepEqual(r.worker.refusals, [])
  await r.worker.deactivate()
})

test('Агента из настроек Orca не знает → ошибка с именем агента, ничего не запущено', async () => {
  const r = await rig()
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
    r.host.calls.map((call) => call.method),
    ['agent.launch'],
  )
  const [record] = r.agents.launches(issueTask(PROJECT, 12))
  assert.equal(r.agents.launches(issueTask(PROJECT, 12)).length, 1)
  assert.equal(record?.terminalId, null)
  assert.equal(record?.error, result.ok ? null : result.error)
  // Nothing to stop.
  assert.deepEqual(await r.agents.stop(issueTask(PROJECT, 12)), { closed: [], failed: [] })
  assert.deepEqual(r.host.callsOf('terminal.close'), [])
  await r.worker.deactivate()
})

test('Запуск с ошибкой Orca → ошибка с именем агента и причиной', async () => {
  const r = await rig({
    'agent.launch': () => {
      throw hostError('action_failed', 'the workspace is gone')
    },
  })
  const result = await r.agents.launch(request(13, 'reviewer'))
  assert.deepEqual(result, {
    ok: false,
    kind: 'launch-failed',
    role: 'reviewer',
    agent: 'claude',
    error: 'Orca could not launch the agent "claude" (agents.reviewer in .agent-queue.json): action_failed: the workspace is gone',
  })
  assert.deepEqual(r.agents.launches(issueTask(PROJECT, 13)).map((record) => record.terminalId), [null])
  await r.worker.deactivate()
})

test('Остановка агентов задачи закрывает только терминалы, которые плагин открыл для этой задачи', async () => {
  const machine = fakeMachine({ platform: 'linux' })
  const r = await rig({}, machine)
  const implementer = await launched(r, 12, 'implementer')
  const reviewer = await launched(r, 12, 'reviewer')
  const other = await launched(r, 13, 'implementer')
  // A launch of the same task that Orca refused: it has no terminal.
  assert.equal((await r.agents.launch(request(12, 'solver', { ...AGENTS, solver: 'nosuch-agent' }))).ok, false)
  assert.deepEqual([implementer.terminalId, reviewer.terminalId, other.terminalId], ['terminal-1', 'terminal-2', 'terminal-3'])

  assert.deepEqual(await r.agents.stop(issueTask(PROJECT, 12)), { closed: ['terminal-1', 'terminal-2'], failed: [] })
  assert.deepEqual(r.host.callsOf('terminal.close'), [{ terminalId: 'terminal-1' }, { terminalId: 'terminal-2' }])
  // Closed once: a second stop closes nothing, and the closed agent takes no message.
  assert.deepEqual(await r.agents.stop(issueTask(PROJECT, 12)), { closed: [], failed: [] })
  assert.equal(r.host.callsOf('terminal.close').length, 2)
  assert.deepEqual(await r.agents.message(implementer, 'Продолжайте'), {
    ok: false,
    error: "the plugin has closed the agent's terminal terminal-1",
  })
  assert.deepEqual(r.host.callsOf('terminal.sendText'), [])
  // The other task's agent and every terminal the plugin did not open are left as they are.
  assert.ok(r.host.calls.every((call) => call.method !== 'terminal.close' || (call.params as { terminalId: string }).terminalId !== 'terminal-3'))
  await r.worker.deactivate()

  // After a restart of the worker the records of the data directory are enough: issue 13's terminal is closed, issue
  // 12's are not closed again.
  const restarted = await rig({}, machine)
  assert.deepEqual(await restarted.agents.stop(issueTask(PROJECT, 12)), { closed: [], failed: [] })
  assert.deepEqual(await restarted.agents.stop(issueTask(PROJECT, 13)), { closed: ['terminal-3'], failed: [] })
  assert.deepEqual(restarted.host.callsOf('terminal.close'), [{ terminalId: 'terminal-3' }])
  assert.deepEqual(restarted.worker.refusals, [])
  await restarted.worker.deactivate()
})

test('Остановка: терминал, который Orca не закрыла, — ошибка с причиной, если он ещё есть, и закрыт, если его уже нет', async () => {
  let listed = [{ id: 'terminal-1' }, { id: 'terminal-2' }, { id: 'terminal-of-the-owner' }]
  const r = await rig({
    'terminal.close': () => {
      throw hostError('action_failed', 'the terminal did not close')
    },
    'terminal.list': () => ({ terminals: listed, truncated: false }),
  })
  await launched(r, 21, 'implementer')
  await launched(r, 21, 'reviewer')
  assert.deepEqual(await r.agents.stop(issueTask(PROJECT, 21)), {
    closed: [],
    failed: [
      { terminalId: 'terminal-1', error: 'action_failed: the terminal did not close' },
      { terminalId: 'terminal-2', error: 'action_failed: the terminal did not close' },
    ],
  })
  // The owner closed terminal-1 by hand: it is gone, so it counts as closed; terminal-2 is still there.
  listed = [{ id: 'terminal-2' }, { id: 'terminal-of-the-owner' }]
  assert.deepEqual(await r.agents.stop(issueTask(PROJECT, 21)), {
    closed: ['terminal-1'],
    failed: [{ terminalId: 'terminal-2', error: 'action_failed: the terminal did not close' }],
  })
  assert.deepEqual(
    r.host.callsOf('terminal.close').map((params) => (params as { terminalId: string }).terminalId),
    ['terminal-1', 'terminal-2', 'terminal-1', 'terminal-2'],
  )
  await r.worker.deactivate()
})

test('Сообщение агенту — в его терминал; несколько строк — через файл; «done» до сообщения — не ответ на него', async () => {
  let listed: { terminalId: string; title: null; agent: string; state: AgentState; stateStartedAt: number }[] = []
  const r = await rig({ 'agents.list': () => ({ agents: listed }) })
  const launch = await launched(r, 30, 'implementer')
  const t0 = r.machine.now()
  r.machine.files.set(launch.reportFile, 'Отчёт круга 1.\n')
  await r.worker.emit('agent.status.changed', status(launch, 'done', t0 + 1_000))
  assert.equal((await r.agents.report(launch)).ready, true)

  r.machine.clock.advance(2_000)
  assert.deepEqual(await r.agents.message(launch, 'Замечание: добавьте тест на сброс фильтра.'), { ok: true })
  assert.deepEqual(r.host.callsOf('terminal.sendText'), [
    { terminalId: 'terminal-1', text: 'Замечание: добавьте тест на сброс фильтра.', enter: true },
  ])
  // The «done» Orca reported before the message is no answer to it; agents.list has nothing newer either.
  listed = [{ terminalId: 'terminal-1', title: null, agent: 'codex', state: 'done', stateStartedAt: t0 + 1_000 }]
  assert.deepEqual(await r.agents.report(launch), { ready: false, state: 'done', finished: false, reportFile: true })
  await r.worker.emit('agent.status.changed', status(launch, 'working', t0 + 2_500))
  assert.deepEqual(await r.agents.report(launch), { ready: false, state: 'working', finished: false, reportFile: true })
  await r.worker.emit('agent.status.changed', status(launch, 'done', t0 + 9_000))
  assert.equal((await r.agents.report(launch)).ready, true)

  // Several lines go into a file of the launch; the terminal gets one line naming it.
  const findings = 'Замечания круга 2:\n- major: src/catalog.ts:10 — фильтр не сбрасывается\n- nit: опечатка в README'
  assert.deepEqual(await r.agents.message(launch, findings), { ok: true })
  const file = dataPath(r.machine, launch.dir, 'message-2.md')
  assert.equal(r.machine.files.get(file), findings)
  assert.deepEqual(r.host.callsOf('terminal.sendText')[1], { terminalId: 'terminal-1', text: messageFileLine('ru', file), enter: true })
  // So does one line longer than Orca takes.
  const long = 'x'.repeat(4_097)
  assert.deepEqual(await r.agents.message(launch, long), { ok: true })
  assert.equal(r.machine.files.get(dataPath(r.machine, launch.dir, 'message-3.md')), long)
  assert.equal((r.host.callsOf('terminal.sendText')[2] as { text: string }).text, messageFileLine('ru', dataPath(r.machine, launch.dir, 'message-3.md')))
  assert.deepEqual(await r.agents.message(launch, '  '), { ok: false, error: 'the message is empty' })
  assert.equal(r.host.callsOf('terminal.sendText').length, 3)
  assert.deepEqual(r.worker.refusals, [])
  await r.worker.deactivate()

  // A terminal that does not take the text: an error, and its time does not count as a word to the agent.
  const refusing = await rig({ 'terminal.sendText': { accepted: false } })
  const agent = await launched(refusing, 31, 'implementer')
  refusing.machine.clock.advance(1_000)
  assert.deepEqual(await refusing.agents.message(agent, 'Продолжайте'), {
    ok: false,
    error: "the agent's terminal terminal-1 did not take the message",
  })
  // «done» between the launch and the message that did not arrive still answers the launch.
  await refusing.worker.emit('agent.status.changed', status(agent, 'done', agent.launchedAt + 500))
  refusing.machine.files.set(agent.reportFile, 'Отчёт.\n')
  assert.equal((await refusing.agents.report(agent)).ready, true)
  await refusing.worker.deactivate()
})

test('Состояние агента из agents.list, когда событий не было: после перезапуска воркера отчёт готов по списку агентов Orca', async () => {
  const machine = fakeMachine({ platform: 'win32' })
  const first = await rig({}, machine)
  const launch = await launched(first, 40, 'implementer', DEFAULT_AGENTS)
  assert.equal(launch.agent, 'claude')
  assert.ok(launch.taskFile.startsWith('C:\\Users\\Avery\\AppData\\Local\\orca-agent-queue\\projects\\'), launch.taskFile)
  await first.worker.deactivate()
  machine.files.set(launch.reportFile, 'Готово.\n')

  let listed = [
    { terminalId: 'terminal-of-the-owner', title: null, agent: 'claude', state: 'done' as AgentState, stateStartedAt: launch.launchedAt + 10 },
    { terminalId: launch.terminalId, title: null, agent: 'claude', state: 'working' as AgentState, stateStartedAt: launch.launchedAt + 5 },
  ]
  const restarted = await rig({ 'agents.list': () => ({ agents: listed }) }, machine)
  const [record] = restarted.agents.launches(issueTask(PROJECT, 40))
  assert.ok(record && record.terminalId !== null)
  const again: AgentLaunch = { ...record, terminalId: record.terminalId }
  assert.deepEqual(await restarted.agents.state(again), { state: 'working', since: launch.launchedAt + 5 })
  assert.deepEqual(await restarted.agents.report(again), { ready: false, state: 'working', finished: false, reportFile: true })
  assert.deepEqual(restarted.host.callsOf('agents.list'), [{ workspaceId: 'workspace-issue-40' }, { workspaceId: 'workspace-issue-40' }])
  listed = [{ ...listed[1]!, state: 'done', stateStartedAt: launch.launchedAt + 60_000 }]
  assert.deepEqual(await restarted.agents.report(again), { ready: true, text: 'Готово.\n' })
  // A worker that heard nothing about the agent, while Orca no longer lists it (its terminal is gone): no state, no
  // report.
  listed = []
  const restartedAgain = await rig({ 'agents.list': () => ({ agents: listed }) }, machine)
  assert.deepEqual(await restartedAgain.agents.report(again), { ready: false, state: null, finished: false, reportFile: true })
  await restarted.worker.deactivate()
  await restartedAgain.worker.deactivate()
})

test('Задачи с ключом не из слов и не с номером issue — ошибка, а не путь вне каталога задачи', async () => {
  const r = await rig()
  assert.throws(() => issueTask(PROJECT, 0), /not an issue number: 0/)
  assert.throws(() => issueTask(PROJECT, 1.5), /not an issue number/)
  assert.throws(() => r.agents.launches({ project: PROJECT, key: '../issue-1' }), /not a task key/)
  const failed = await r.agents.launch({ ...request(1, 'implementer'), task: { project: PROJECT, key: 'Issue 1' } })
  assert.ok(!failed.ok && failed.kind === 'launch-failed' && /not a task key/.test(failed.error), JSON.stringify(failed))
  assert.deepEqual(r.host.calls, [])
  // The start agent's own work in the project has a key of words.
  const start = await r.agents.launch({ ...request(1, 'start'), task: { project: PROJECT, key: 'mvp-start' } })
  assert.ok(start.ok && start.launch.agent === 'opencode' && start.launch.taskFile.includes('/mvp-start/agents/1/'), JSON.stringify(start))
  await r.worker.deactivate()
})
