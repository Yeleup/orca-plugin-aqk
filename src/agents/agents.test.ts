// The agents layer of the worker (src/agents/agents.ts) over a fake Orca (src/testing/fake-orca.ts: Orca's mock host
// with the refusals of Orca 1.4.274, on a fake computer): which agent is launched where and with which prompt, what
// each launch leaves in the data directory, which errors a launch gives, what a stop closes and what it leaves, what
// state of the agent Orca shows, when the task counts as delivered and when the report on it is ready. The layer runs
// in a worker as Orca runs it (`mountWorker`: the host refuses what the manifest's capabilities do not allow, and
// delivers the events the manifest lists); the clock moves only when the test moves it, and a file's time of last write
// is the clock's reading when it was written. Invented project, issues, terminals and workspaces only.
import { assert, hostError, mountWorker, test, type TestWorker } from 'orca/testing'
import type { PluginEvents } from 'orca/worker'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realMachine, realPlatform, type Machine } from '../platform/machine'
import { dataDirectory, dataName, dataPath } from '../platform/paths'
import { DEFAULT_AGENTS, type AgentRole, type ProjectAgents } from '../project/settings'
import { fakeOrca, type FakeOrca } from '../testing/fake-orca'
import {
  DELIVERY_DEADLINE_MS,
  issueTask,
  ORCA_TEXT_MAX,
  startAgents,
  type AgentLaunch,
  type Agents,
  type AgentState,
  type LaunchFiles,
  type LaunchRequest,
  type ProjectRef,
  type ReportReading,
  type StopResult,
  type TaskRef,
} from './agents'
import { implementerTask, launchPrompt, reviewerTask } from './task-text'

const PROJECT: ProjectRef = { id: 'Example-Org/Sample-Shop', hostId: 'local' }
const DATA_RULE = 'Никаких данных покупателей: имён, телефонов, адресов, токенов и ключей.'
// Agents of the settings other than the defaults: each role gets the agent of its own field.
const AGENTS: ProjectAgents = { implementer: 'codex', reviewer: 'claude', solver: 'gemini', start: 'opencode' }

type Rig = { readonly orca: FakeOrca; readonly worker: TestWorker; readonly agents: Agents; readonly dataDir: string }

// A worker with the agents layer on the fake Orca, as the worker starts it (startAgents: Orca's agent.status.changed
// goes to it): its host is the worker's, the computer the fake one (or `machine`, which wraps it), the data directory
// the one of that computer unless the test names another.
async function mount(orca: FakeOrca, options: { readonly machine?: Machine; readonly dataDir?: string } = {}): Promise<Rig> {
  const dataDir = options.dataDir ?? dataDirectory(orca.machine)
  let agents: Agents | undefined
  const worker = await mountWorker(
    {
      default: (api) => {
        agents = startAgents(api, options.machine ?? orca.machine, dataDir)
      },
    },
    { host: orca.host },
  )
  assert.ok(agents)
  return { orca, worker, agents, dataDir }
}

// The task of a queue issue for `role`, in its own worktree.
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

// The name of a project's directory in the data directory: from its id and its host.
function projectName(project: ProjectRef): string {
  return dataName(JSON.stringify([project.id, project.hostId]))
}

// The directory of launch `n` of a task in the data directory.
function launchDir(rig: Rig, key: string, n: number, project: ProjectRef = PROJECT): string {
  return dataPath(rig.orca.machine, rig.dataDir, 'projects', projectName(project), key, 'agents', String(n))
}

function json(orca: FakeOrca, path: string): unknown {
  const text = orca.machine.files.get(path)
  return text === undefined ? undefined : JSON.parse(text)
}

// The directory a path is in.
function parent(path: string): string {
  return path.slice(0, path.lastIndexOf('/'))
}

// The ids of the terminals `terminal.close` was asked to close, in order.
function closes(orca: FakeOrca): string[] {
  return orca.host.callsOf('terminal.close').map((params) => (params as { terminalId: string }).terminalId)
}

// A promise the test settles when it wants.
function gate(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

async function settle(): Promise<void> {
  // No timer: every pending promise gets the turns it needs.
  for (let turn = 0; turn < 100; turn++) await Promise.resolve()
}

// Orca's event for the agent of `launch`: its state, when Orca got it, and — `since` given — the main agent's same
// state since then (without it Orca does not say when the state began).
function status(
  launch: Pick<AgentLaunch, 'workspaceId' | 'terminalId'>,
  state: AgentState,
  receivedAt: number,
  since?: number,
): PluginEvents['agent.status.changed'] {
  return {
    workspaceId: launch.workspaceId,
    paneKey: `pane-${launch.terminalId}`,
    terminalId: launch.terminalId,
    state,
    receivedAt,
    ...(since === undefined ? {} : { mainAgent: { state, stateStartedAt: since } }),
  }
}

// The reading «not ready» of the launch's report: Orca shows nothing, the agent has not started, no report file —
// unless `fields` say otherwise.
function notReady(launch: AgentLaunch, fields: Partial<Extract<ReportReading, { ready: false }>> = {}): ReportReading {
  return {
    ready: false,
    state: null,
    listed: false,
    started: false,
    reportFile: launch.reportFile,
    reportExists: false,
    writtenAfterDone: false,
    failure: null,
    ...fields,
  }
}

// Launch `number` of the task as a new worker knows it: from its records in the data directory.
function recorded(rig: Rig, task: TaskRef, number: number): AgentLaunch {
  const record = rig.agents.launches(task).find((each) => each.number === number)
  assert.ok(
    record !== undefined &&
      record.outcome === 'launched' &&
      record.terminalId !== null &&
      record.role !== null &&
      record.agent !== null &&
      record.language !== null &&
      record.workspaceId !== null &&
      record.launchedAt !== null,
    JSON.stringify(record),
  )
  const { dir, taskFile, reportFile, role, agent, language, workspaceId, launchedAt, terminalId } = record
  return { dir, taskFile, reportFile, task: record.task, number, role, agent, language, workspaceId, launchedAt, terminalId }
}

// The start of the launch's task, as the data directory keeps it.
function startMark(orca: FakeOrca, launch: Pick<AgentLaunch, 'dir'>): string {
  return dataPath(orca.machine, launch.dir, 'started-0')
}

test('Запуски решателя и агента старта берут агентов своих ролей из настроек проекта; каждый запуск задачи — свой номер и каталог с заданием, записью до запроса к Orca и записью её ответа; подсказка длиннее 4096 знаков — ошибка, Orca не вызвана', async () => {
  const orca = fakeOrca()
  const first = dataPath(orca.machine, dataDirectory(orca.machine), 'projects', projectName(PROJECT), 'issue-12', 'agents', '1')
  const firstFiles: LaunchFiles = { dir: first, taskFile: `${first}/task.md`, reportFile: `${first}/report.md` }
  // The disk takes its time with launch 1's record before the request.
  const recordWrite = gate()
  const machine: Machine = {
    ...orca.machine,
    createText: async (path, text) => {
      if (path === `${first}/launching.json`) await recordWrite.promise
      return orca.machine.createText(path, text)
    },
  }
  const r = await mount(orca, { machine })
  const t0 = orca.clock.now()

  // The implementer of issue 12. Until the record before the request is written, Orca is not asked; the moment Orca
  // gets the call, the task file and that record are on disk, and Orca's answer is not. Orca then holds its answer
  // back, and the launch is pending.
  const atCall: unknown[] = []
  orca.onLaunch = () => {
    atCall.push({
      task: orca.machine.files.get(firstFiles.taskFile),
      launching: json(orca, `${first}/launching.json`),
      answer: orca.machine.files.has(`${first}/launch.json`),
    })
  }
  const held = gate()
  orca.launchGate = held.promise
  const implementing = r.agents.launch(request(12, 'implementer'))
  await settle()
  assert.equal(orca.machine.files.get(firstFiles.taskFile), request(12, 'implementer').taskText(firstFiles))
  assert.deepEqual(orca.host.calls, [])
  recordWrite.open()
  await settle()
  assert.deepEqual(atCall, [
    {
      task: request(12, 'implementer').taskText(firstFiles),
      launching: { role: 'implementer', agent: 'codex', language: 'ru', workspaceId: 'workspace-issue-12', launchedAt: t0 },
      answer: false,
    },
  ])
  orca.onLaunch = null
  assert.deepEqual(json(orca, `${first}/launching.json`), {
    role: 'implementer',
    agent: 'codex',
    language: 'ru',
    workspaceId: 'workspace-issue-12',
    launchedAt: t0,
  })
  assert.equal(orca.machine.files.get(`${first}/launch.json`), undefined)
  assert.deepEqual(
    r.agents.launches(issueTask(PROJECT, 12)).map((record) => [record.number, record.outcome, record.terminalId]),
    [[1, 'pending', null]],
  )
  orca.launchGate = null
  held.open()
  const implementer = await implementing
  assert.ok(implementer.ok, JSON.stringify(implementer))
  assert.deepEqual(json(orca, `${first}/launch.json`), { terminalId: 'terminal-1', error: null })

  // The solver of the same task: the solver's agent of the settings, launch 2 in a directory of its own.
  orca.clock.advance(60_000)
  const solver = await r.agents.launch(request(12, 'solver'))
  assert.ok(solver.ok, JSON.stringify(solver))
  const second = launchDir(r, 'issue-12', 2)
  const solverFiles: LaunchFiles = { dir: second, taskFile: `${second}/task.md`, reportFile: `${second}/report.md` }
  assert.deepEqual(solver.launch, {
    ...solverFiles,
    task: { project: PROJECT, key: 'issue-12' },
    number: 2,
    role: 'solver',
    agent: 'gemini',
    language: 'ru',
    workspaceId: 'workspace-issue-12',
    launchedAt: t0 + 60_000,
    terminalId: 'terminal-2',
  })
  // Its task file is the caller's text for its paths, and names the report file beside it.
  assert.equal(orca.machine.files.get(solverFiles.taskFile), request(12, 'solver').taskText(solverFiles))
  assert.ok(orca.machine.files.get(solverFiles.taskFile)?.includes(solverFiles.reportFile))
  assert.equal(orca.machine.files.get(solverFiles.reportFile), undefined)
  assert.deepEqual(json(orca, `${second}/launching.json`), {
    role: 'solver',
    agent: 'gemini',
    language: 'ru',
    workspaceId: 'workspace-issue-12',
    launchedAt: t0 + 60_000,
  })
  assert.deepEqual(json(orca, `${second}/launch.json`), { terminalId: 'terminal-2', error: null })

  // The start agent: the start agent of the settings, in the main checkout, for the project's work `mvp-start`, with a
  // prompt in the project's language.
  const startTask: TaskRef = { project: PROJECT, key: 'mvp-start' }
  const start = await r.agents.launch({
    task: startTask,
    role: 'start',
    agents: AGENTS,
    language: 'en',
    workspaceId: 'workspace-main-checkout',
    taskText: (files) => `# MVP start\n\nWrite the report to ${files.reportFile}.\n`,
  })
  assert.ok(start.ok, JSON.stringify(start))
  const startDir = launchDir(r, 'mvp-start', 1)
  assert.deepEqual(
    [start.launch.number, start.launch.agent, start.launch.role, start.launch.language, start.launch.workspaceId, start.launch.dir],
    [1, 'opencode', 'start', 'en', 'workspace-main-checkout', startDir],
  )
  assert.equal(orca.machine.files.get(`${startDir}/task.md`), `# MVP start\n\nWrite the report to ${startDir}/report.md.\n`)

  // What Orca was asked: each role's agent, in the workspace the caller named, with the one-line prompt naming the
  // launch's task and report files.
  assert.deepEqual(orca.host.calls, [
    {
      method: 'agent.launch',
      params: { workspaceId: 'workspace-issue-12', agent: 'codex', prompt: launchPrompt('ru', `${first}/task.md`, `${first}/report.md`) },
    },
    {
      method: 'agent.launch',
      params: { workspaceId: 'workspace-issue-12', agent: 'gemini', prompt: launchPrompt('ru', solverFiles.taskFile, solverFiles.reportFile) },
    },
    {
      method: 'agent.launch',
      params: {
        workspaceId: 'workspace-main-checkout',
        agent: 'opencode',
        prompt: launchPrompt('en', `${startDir}/task.md`, `${startDir}/report.md`),
      },
    },
  ])
  assert.equal(orca.terminals.get('terminal-3')?.prompt, launchPrompt('en', `${startDir}/task.md`, `${startDir}/report.md`))
  assert.deepEqual(
    r.agents.launches(issueTask(PROJECT, 12)).map((record) => [record.number, record.role, record.agent, record.outcome, record.terminalId]),
    [
      [1, 'implementer', 'codex', 'launched', 'terminal-1'],
      [2, 'solver', 'gemini', 'launched', 'terminal-2'],
    ],
  )
  assert.deepEqual(r.worker.refusals, [])
  await r.worker.deactivate()

  // A data directory whose paths make the prompt longer than Orca takes: an error, and Orca is not asked. The prompt
  // grows by two characters for each character of the directory (the task file and the report file).
  const promptOf = (dataDir: string) => {
    const dir = dataPath(orca.machine, dataDir, 'projects', projectName(PROJECT), 'issue-7', 'agents', '1')
    return launchPrompt('ru', `${dir}/task.md`, `${dir}/report.md`)
  }
  let longest = '/data/'
  while (promptOf(`${longest}d`).length <= ORCA_TEXT_MAX) longest += 'd'
  assert.ok(promptOf(longest).length <= ORCA_TEXT_MAX && promptOf(`${longest}d`).length > ORCA_TEXT_MAX)
  const fits = await mount(fakeOrca(), { dataDir: longest })
  assert.ok((await fits.agents.launch(request(7, 'implementer'))).ok)
  assert.equal(fits.orca.host.callsOf('agent.launch').length, 1)
  await fits.worker.deactivate()

  const tooLong = await mount(fakeOrca(), { dataDir: `${longest}d` })
  const refused = await tooLong.agents.launch(request(7, 'implementer'))
  const length = promptOf(`${longest}d`).length
  const error = `the agent "codex" (agents.implementer in .agent-queue.json) was not launched: the paths of its task and report files make a prompt of ${length} characters, Orca takes 4096`
  assert.deepEqual(refused, { ok: false, kind: 'launch-failed', role: 'implementer', agent: 'codex', error })
  assert.deepEqual(tooLong.orca.host.calls, [])
  assert.equal(tooLong.orca.terminals.size, 0)
  // The launch is on disk as failed, with the reason, and a stop has nothing to close.
  const dir = launchDir(tooLong, 'issue-7', 1)
  assert.deepEqual(json(tooLong.orca, `${dir}/launch.json`), { terminalId: null, error })
  assert.deepEqual(tooLong.agents.launches(issueTask(PROJECT, 7)).map((record) => [record.outcome, record.error]), [['failed', error]])
  assert.deepEqual(await tooLong.agents.stop(issueTask(PROJECT, 7)), { closed: [], failed: [] })
  await tooLong.worker.deactivate()
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

test('Ошибка Orca при запуске → ошибка с именем агента и причиной от Orca; ответ Orca записать не удалось → открытый терминал закрыт сразу, запуск — ошибка; файл задания не записался — ошибка с причиной', async () => {
  const failing = await mount(
    fakeOrca({
      results: {
        'agent.launch': () => {
          throw hostError('action_failed', 'the workspace is gone')
        },
      },
    }),
  )
  const result = await failing.agents.launch(request(13, 'reviewer'))
  const reason = 'Orca could not launch the agent "claude" (agents.reviewer in .agent-queue.json): action_failed: the workspace is gone'
  assert.deepEqual(result, { ok: false, kind: 'launch-failed', role: 'reviewer', agent: 'claude', error: reason })
  assert.deepEqual(failing.agents.launches(issueTask(PROJECT, 13)).map((record) => [record.outcome, record.error]), [['failed', reason]])
  await failing.worker.deactivate()

  // Orca opened the terminal, but launch.json could not be written: the plugin could never stop that agent, so its
  // terminal is closed at once and the launch is an error.
  const orca = fakeOrca()
  const diskFull = new Error('ENOSPC: no space left on device')
  const machine: Machine = {
    ...orca.machine,
    createText: (path, text) => (path.endsWith('/launch.json') ? Promise.reject(diskFull) : orca.machine.createText(path, text)),
  }
  const r = await mount(orca, { machine })
  const unrecorded = await r.agents.launch(request(14, 'implementer'))
  assert.deepEqual(unrecorded, {
    ok: false,
    kind: 'launch-failed',
    role: 'implementer',
    agent: 'codex',
    error:
      'the agent "codex" (agents.implementer in .agent-queue.json) was launched, but its launch could not be recorded (ENOSPC: no space left on device); its terminal terminal-1 is closed',
  })
  assert.deepEqual(
    orca.host.calls.map((call) => call.method),
    ['agent.launch', 'terminal.close'],
  )
  assert.deepEqual(closes(orca), ['terminal-1'])
  assert.equal(orca.terminals.get('terminal-1')?.open, false)
  // Its terminal is not on record: a stop says so instead of reporting the task stopped.
  const stopped = await r.agents.stop(issueTask(PROJECT, 14))
  assert.deepEqual(stopped.closed, [])
  assert.deepEqual(
    stopped.failed.map((failure) => [failure.launch, failure.terminalId]),
    [[1, null]],
  )
  // The terminal could not be closed either: the error says that it is still open.
  orca.host.respond('terminal.close', () => {
    throw hostError('action_failed', 'the terminal did not close')
  })
  const leftOpen = await r.agents.launch(request(15, 'implementer'))
  assert.ok(!leftOpen.ok)
  assert.equal(
    leftOpen.error,
    'the agent "codex" (agents.implementer in .agent-queue.json) was launched, but its launch could not be recorded (ENOSPC: no space left on device); its terminal terminal-2 could not be closed: action_failed: the terminal did not close',
  )
  // Orca refused the launch, and its refusal could not be recorded either: the error gives both, keeps the kind of an
  // agent Orca does not know, and says that a stop will report the launch's terminal as unknown.
  const refusedUnrecorded = await r.agents.launch(request(19, 'implementer', { ...AGENTS, implementer: 'nosuch-agent' }))
  assert.deepEqual(refusedUnrecorded, {
    ok: false,
    kind: 'unknown-agent',
    role: 'implementer',
    agent: 'nosuch-agent',
    error:
      'Orca does not know the agent "nosuch-agent" (agents.implementer in .agent-queue.json); and this could not be recorded (ENOSPC: no space left on device): a stop reports launch 1 as one whose terminal is unknown',
  })
  assert.deepEqual(
    (await r.agents.stop(issueTask(PROJECT, 19))).failed.map((failure) => [failure.launch, failure.terminalId]),
    [[1, null]],
  )
  await r.worker.deactivate()

  // The task file could not be written: an error with the reason, and Orca is not asked.
  const readOnly = fakeOrca()
  const blocked = await mount(readOnly, {
    machine: { ...readOnly.machine, createText: () => Promise.reject(new Error('EACCES: permission denied')) },
  })
  assert.deepEqual(await blocked.agents.launch(request(16, 'implementer')), {
    ok: false,
    kind: 'launch-failed',
    role: 'implementer',
    agent: 'codex',
    error: 'the agent "codex" (agents.implementer in .agent-queue.json) was not launched: its task file: EACCES: permission denied',
  })
  assert.deepEqual(readOnly.host.calls, [])
  await blocked.worker.deactivate()
})

test('Запись запуска создаётся один раз: запись, которая уже есть, не переписывается — запуск — ошибка, Orca не вызвана', async () => {
  const orca = fakeOrca()
  // Another writer puts a launching.json into the launch's directory right after the launch took its number.
  const foreign = '{"role":"implementer","agent":"claude","language":"en","workspaceId":"workspace-elsewhere","launchedAt":1}\n'
  const machine: Machine = {
    ...orca.machine,
    createText: async (path, text) => {
      const created = await orca.machine.createText(path, text)
      if (path.endsWith('/task.md')) orca.machine.files.set(path.replace(/task\.md$/, 'launching.json'), foreign)
      return created
    },
  }
  const r = await mount(orca, { machine })
  const dir = launchDir(r, 'issue-18', 1)
  const result = await r.agents.launch(request(18, 'implementer'))
  assert.deepEqual(result, {
    ok: false,
    kind: 'launch-failed',
    role: 'implementer',
    agent: 'codex',
    error: `the agent "codex" (agents.implementer in .agent-queue.json) was not launched: its launch could not be recorded: ${dir}/launching.json is already there`,
  })
  assert.equal(orca.machine.files.get(`${dir}/launching.json`), foreign)
  assert.deepEqual(orca.host.calls, [])
  await r.worker.deactivate()
})

test('Остановка агентов задачи закрывает только терминалы, которые плагин открыл для этой задачи', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)
  const implementer = await launched(r, 12, 'implementer')
  const reviewer = await launched(r, 12, 'reviewer')
  const other = await launched(r, 13, 'implementer')
  // The owner's own terminal in the task's worktree — the focused one, which Orca would let the plugin close — and a
  // launch of the same task that Orca refused (no terminal).
  const owners = orca.ownerTerminal('workspace-issue-12')
  orca.focused = 'workspace-issue-12'
  assert.equal((await r.agents.launch(request(12, 'solver', { ...AGENTS, solver: 'nosuch-agent' }))).ok, false)
  assert.deepEqual([implementer.terminalId, reviewer.terminalId, other.terminalId], ['terminal-1', 'terminal-2', 'terminal-3'])

  assert.deepEqual(await r.agents.stop(issueTask(PROJECT, 12)), { closed: ['terminal-1', 'terminal-2'], failed: [] })
  assert.deepEqual(closes(orca), ['terminal-1', 'terminal-2'])
  assert.deepEqual(
    [...orca.terminals.values()].map((terminal) => [terminal.id, terminal.open]),
    [
      ['terminal-1', false],
      ['terminal-2', false],
      ['terminal-3', true],
      [owners, true],
    ],
  )
  // Each closed launch is marked on disk once.
  assert.ok(orca.machine.files.has(`${implementer.dir}/closed`))
  assert.ok(orca.machine.files.has(`${reviewer.dir}/closed`))
  assert.ok(!orca.machine.files.has(`${other.dir}/closed`))
  assert.deepEqual(
    r.agents.launches(issueTask(PROJECT, 12)).map((record) => [record.number, record.outcome, record.closed]),
    [
      [1, 'launched', true],
      [2, 'launched', true],
      [3, 'failed', false],
    ],
  )
  // Closed once: a second stop closes nothing.
  assert.deepEqual(await r.agents.stop(issueTask(PROJECT, 12)), { closed: [], failed: [] })
  assert.equal(closes(orca).length, 2)
  await r.worker.deactivate()

  // After a restart of the worker the records of the data directory are enough: issue 13's terminal is closed, issue
  // 12's are not closed again, the owner's stays open.
  const restarted = await mount(orca)
  assert.deepEqual(await restarted.agents.stop(issueTask(PROJECT, 12)), { closed: [], failed: [] })
  assert.deepEqual(await restarted.agents.stop(issueTask(PROJECT, 13)), { closed: ['terminal-3'], failed: [] })
  assert.deepEqual(closes(orca), ['terminal-1', 'terminal-2', 'terminal-3'])
  assert.equal(orca.terminals.get(owners)?.open, true)
  // The host's refusals: only the launch of the unknown agent, before the restart.
  assert.deepEqual(restarted.worker.refusals, [{ method: 'agent.launch', code: 'invalid_params', message: 'unknown agent' }])
  await restarted.worker.deactivate()
})

test('Остановка во время запуска дожидается ответа Orca и закрывает открытый терминал; запуск без записанного ответа Orca — ошибка остановки', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)
  const held = gate()
  orca.launchGate = held.promise
  const launching = r.agents.launch(request(16, 'implementer'))
  // The stop begins once Orca has the request (a launch that has not asked Orca yet is refused instead).
  await settle()
  assert.equal(orca.host.callsOf('agent.launch').length, 1)
  let stopped = false
  const stopping = r.agents.stop(issueTask(PROJECT, 16)).then((result) => {
    stopped = true
    return result
  })
  // Orca has not answered: the launch is on disk without its answer, and the stop waits.
  await settle()
  assert.equal(stopped, false)
  assert.deepEqual(r.agents.launches(issueTask(PROJECT, 16)).map((record) => record.outcome), ['pending'])
  assert.deepEqual(orca.host.callsOf('terminal.close'), [])
  orca.launchGate = null
  held.open()
  const result = await launching
  assert.ok(result.ok)
  assert.deepEqual(await stopping, { closed: ['terminal-1'], failed: [] })
  assert.equal(orca.terminals.get('terminal-1')?.open, false)
  await r.worker.deactivate()

  // A worker that stopped while Orca was launching left the launch without its answer: a new worker cannot know its
  // terminal, and says so instead of reporting the task stopped; the launch after it is closed as usual.
  const first = launchDir(r, 'issue-17', 1)
  orca.machine.files.set(`${first}/task.md`, '# Задание\n')
  orca.machine.files.set(
    `${first}/launching.json`,
    JSON.stringify({ role: 'implementer', agent: 'codex', language: 'ru', workspaceId: 'workspace-issue-17', launchedAt: 1 }),
  )
  const restarted = await mount(orca)
  const reviewer = await launched(restarted, 17, 'reviewer')
  assert.equal(reviewer.number, 2)
  assert.deepEqual(await restarted.agents.stop(issueTask(PROJECT, 17)), {
    closed: [reviewer.terminalId],
    failed: [
      {
        launch: 1,
        terminalId: null,
        error:
          'Orca\'s answer to launch 1 (the agent "codex") is not recorded — the worker stopped while Orca was launching it, or the answer could not be written: its terminal, if any, is unknown',
      },
    ],
  })
  await restarted.worker.deactivate()
})

test('Запуск той же задачи во время остановки отклонён с причиной, запуск другой задачи проходит, после остановки запуск снова возможен', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)
  await launched(r, 41, 'implementer')
  const held = gate()
  orca.closeGate = held.promise
  const stopping = r.agents.stop(issueTask(PROJECT, 41))
  await settle()
  // Orca has not yet answered the close of terminal-1.
  assert.deepEqual(closes(orca), ['terminal-1'])
  assert.deepEqual(await r.agents.launch(request(41, 'reviewer')), {
    ok: false,
    kind: 'launch-failed',
    role: 'reviewer',
    agent: 'claude',
    error: 'the agent "claude" (agents.reviewer in .agent-queue.json) was not launched: the agents of issue-41 are being stopped',
  })
  // Another task launches as usual.
  assert.ok((await r.agents.launch(request(42, 'implementer'))).ok)
  assert.deepEqual(orca.host.callsOf('agent.launch').length, 2)
  orca.closeGate = null
  held.open()
  assert.deepEqual(await stopping, { closed: ['terminal-1'], failed: [] })
  // The refused launch left nothing: no task file, no terminal of the task alive.
  assert.deepEqual(r.agents.launches(issueTask(PROJECT, 41)).map((record) => record.number), [1])
  assert.ok(!orca.machine.files.has(`${launchDir(r, 'issue-41', 2)}/task.md`))
  assert.deepEqual(
    [...orca.terminals.values()].filter((terminal) => terminal.workspaceId === 'workspace-issue-41' && terminal.open),
    [],
  )
  // Once the stop is over, the task launches again.
  const again = await r.agents.launch(request(41, 'reviewer'))
  assert.ok(again.ok && again.launch.number === 2, JSON.stringify(again))
  await r.worker.deactivate()
})

test('Orca отказалась закрыть терминал: он ещё есть в workspace — ошибка остановки с причиной, его уже нет — считается закрытым; после перезапуска воркера остановка закрывает терминалы, открытые прежним воркером', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)
  await launched(r, 21, 'implementer')
  await launched(r, 21, 'reviewer')
  await launched(r, 22, 'implementer')
  orca.ownerTerminal('workspace-issue-21')
  const refused = 'action_failed: the terminal did not close'
  orca.host.respond('terminal.close', () => {
    throw hostError('action_failed', 'the terminal did not close')
  })
  assert.deepEqual(await r.agents.stop(issueTask(PROJECT, 21)), {
    closed: [],
    failed: [
      { launch: 1, terminalId: 'terminal-1', error: refused },
      { launch: 2, terminalId: 'terminal-2', error: refused },
    ],
  })
  // After each refusal the plugin read its workspace's terminals.
  assert.deepEqual(orca.host.callsOf('terminal.list'), [{ workspaceId: 'workspace-issue-21' }, { workspaceId: 'workspace-issue-21' }])
  // The owner closed terminal-1 by hand: it is gone, so it counts as closed; terminal-2 is still there.
  const closedByHand = orca.terminals.get('terminal-1')
  assert.ok(closedByHand)
  closedByHand.open = false
  assert.deepEqual(await r.agents.stop(issueTask(PROJECT, 21)), {
    closed: ['terminal-1'],
    failed: [{ launch: 2, terminalId: 'terminal-2', error: refused }],
  })
  assert.deepEqual(closes(orca), ['terminal-1', 'terminal-2', 'terminal-1', 'terminal-2'])
  // A list cut short does not show a terminal gone: terminal-2, closed by hand too, is still an error then.
  const second = orca.terminals.get('terminal-2')
  assert.ok(second)
  second.open = false
  orca.listTruncated = true
  assert.deepEqual(await r.agents.stop(issueTask(PROJECT, 21)), {
    closed: [],
    failed: [{ launch: 2, terminalId: 'terminal-2', error: refused }],
  })
  // Nor does a list Orca could not give.
  orca.listTruncated = false
  orca.host.respond('terminal.list', () => {
    throw hostError('unavailable', 'Orca is restarting')
  })
  assert.deepEqual(await r.agents.stop(issueTask(PROJECT, 21)), {
    closed: [],
    failed: [{ launch: 2, terminalId: 'terminal-2', error: refused }],
  })
  await r.worker.deactivate()

  // A new worker, with Orca closing again: from the records on disk it closes what the earlier worker opened and did
  // not close — terminal-2 (now gone) and issue 22's terminal-3 — and not terminal-1, closed already.
  orca.host.respond('terminal.list', (params: { workspaceId: string }) => ({
    terminals: [...orca.terminals.values()].filter((t) => t.open && t.workspaceId === params.workspaceId).map((t) => ({ id: t.id })),
    truncated: false,
  }))
  orca.host.respond('terminal.close', (params: { terminalId: string }) => {
    const terminal = orca.terminals.get(params.terminalId)
    if (terminal === undefined || !terminal.open) throw hostError('action_failed', 'no such terminal')
    terminal.open = false
    return { closed: true }
  })
  const restarted = await mount(orca)
  assert.deepEqual(await restarted.agents.stop(issueTask(PROJECT, 21)), { closed: ['terminal-2'], failed: [] })
  assert.deepEqual(await restarted.agents.stop(issueTask(PROJECT, 22)), { closed: ['terminal-3'], failed: [] })
  assert.equal(orca.terminals.get('terminal-3')?.open, false)
  assert.deepEqual(closes(orca).slice(6), ['terminal-2', 'terminal-3'])
  assert.deepEqual(restarted.worker.refusals, [])
  await restarted.worker.deactivate()
})

test('Ключ задачи не из слов и не issue-<N> — ошибка, а не путь вне каталога задачи', async () => {
  const r = await mount(fakeOrca())
  assert.throws(() => issueTask(PROJECT, 0), /not an issue number: 0/)
  assert.throws(() => issueTask(PROJECT, 1.5), /not an issue number/)
  // Neither `issue-<N>` (N from 1, no leading zero) nor lower-case words of letters joined by hyphens.
  const keys = ['../issue-1', 'Issue-1', 'issue 1', 'issue_1', '-issue', 'issue-', 'issue--1', '', 'mvp/start', '..']
  for (const key of [...keys, '42', 'issue-0', 'issue-007', 'mvp-2']) {
    assert.throws(() => r.agents.launches({ project: PROJECT, key }), /not a task key/)
    await assert.rejects(r.agents.stop({ project: PROJECT, key }), /not a task key/)
    const failed = await r.agents.launch({ ...request(1, 'implementer'), task: { project: PROJECT, key } })
    assert.ok(!failed.ok && failed.kind === 'launch-failed' && failed.error.includes('not a task key'), JSON.stringify(failed))
  }
  assert.deepEqual(r.orca.host.calls, [])
  assert.deepEqual([...r.orca.machine.files.keys()], [])
  // Both forms pass: a queue task's `issue-<N>`, and words — also words that begin with `issue`. Any project id and
  // host give a plain directory name.
  const odd: ProjectRef = { id: '../../C:\\Other Project', hostId: 'ssh:Build Box' }
  const start = await r.agents.launch({ ...request(1, 'start'), task: { project: odd, key: 'mvp-start' } })
  assert.ok(start.ok, JSON.stringify(start))
  assert.equal(start.launch.agent, 'opencode')
  assert.equal(start.launch.dir, `${r.dataDir}/projects/${projectName(odd)}/mvp-start/agents/1`)
  assert.match(projectName(odd), /^c-other-project-ssh-build-box-[0-9a-f]{12}$/)
  const triage = await r.agents.launch({ ...request(1, 'solver'), task: { project: PROJECT, key: 'issue-triage' } })
  assert.ok(triage.ok && triage.launch.dir === launchDir(r, 'issue-triage', 1), JSON.stringify(triage))
  const queued = await r.agents.launch(request(1, 'implementer'))
  assert.ok(queued.ok && queued.launch.dir === launchDir(r, 'issue-1', 1), JSON.stringify(queued))
  await r.worker.deactivate()
})

test('Две копии проекта с одним id на разных хостах: у каждой свои записи запусков, остановка закрывает только терминалы своей копии и не ждёт запусков другой', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)
  const remote: ProjectRef = { id: PROJECT.id, hostId: 'ssh:build-box' }
  const onRemote = (issue: number, role: AgentRole): LaunchRequest => ({
    ...request(issue, role),
    task: issueTask(remote, issue),
    workspaceId: `workspace-remote-issue-${issue}`,
  })
  const local = await launched(r, 12, 'implementer')
  const copy = await r.agents.launch(onRemote(12, 'implementer'))
  assert.ok(copy.ok, JSON.stringify(copy))
  // The same task number on both hosts: each copy its own launch 1, in its own directory.
  assert.deepEqual([local.number, copy.launch.number], [1, 1])
  assert.equal(local.dir, launchDir(r, 'issue-12', 1))
  assert.equal(copy.launch.dir, launchDir(r, 'issue-12', 1, remote))
  assert.notEqual(local.dir, copy.launch.dir)

  assert.deepEqual(await r.agents.stop(issueTask(remote, 12)), { closed: [copy.launch.terminalId], failed: [] })
  assert.equal(orca.terminals.get(local.terminalId)?.open, true)
  assert.deepEqual(
    r.agents.launches(issueTask(PROJECT, 12)).map((record) => [record.number, record.outcome, record.closed]),
    [[1, 'launched', false]],
  )

  // The bookkeeping of launches and stops is per copy too: while Orca holds a launch of the local copy, a stop of the
  // other copy does not wait for it, and a launch of the other copy is not refused by the local copy's stop.
  const held = gate()
  orca.launchGate = held.promise
  const waiting = r.agents.launch(request(12, 'reviewer'))
  await settle()
  let remoteStopped = false
  const remoteStop = r.agents.stop(issueTask(remote, 12)).then((result) => {
    remoteStopped = true
    return result
  })
  await settle()
  assert.equal(remoteStopped, true)
  assert.deepEqual(await remoteStop, { closed: [], failed: [] })
  const localStop = r.agents.stop(issueTask(PROJECT, 12))
  orca.launchGate = null
  const other = await r.agents.launch(onRemote(12, 'reviewer'))
  assert.ok(other.ok, JSON.stringify(other))
  held.open()
  const reviewer = await waiting
  assert.ok(reviewer.ok, JSON.stringify(reviewer))
  assert.deepEqual(await localStop, { closed: [local.terminalId, reviewer.launch.terminalId], failed: [] })
  assert.equal(orca.terminals.get(other.launch.terminalId)?.open, true)
  await r.worker.deactivate()
})

test('Записи запуска читаются каждая сама по себе: без task.md запуск останавливается, нечитаемая запись — ошибка этого запуска, а остальные терминалы закрыты, и после перезапуска воркера', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)
  const task = issueTask(PROJECT, 30)
  const first = await launched(r, 30, 'implementer')
  const second = await launched(r, 30, 'reviewer')
  const third = await launched(r, 30, 'solver')
  assert.deepEqual([first.terminalId, second.terminalId, third.terminalId], ['terminal-1', 'terminal-2', 'terminal-3'])
  await r.worker.deactivate()

  // The task's launch directories cannot be listed: the stop says so and closes nothing; it does not reject.
  const agentsDir = first.dir.slice(0, first.dir.lastIndexOf('/'))
  const unlisted = await mount(orca, {
    machine: {
      ...orca.machine,
      listEntries: (path) => {
        if (path === agentsDir) throw new Error(`EACCES: permission denied, scandir '${path}'`)
        return orca.machine.listEntries(path)
      },
    },
  })
  assert.throws(() => unlisted.agents.launches(task), /EACCES/)
  assert.deepEqual(await unlisted.agents.stop(task), {
    closed: [],
    failed: [
      { launch: null, terminalId: null, error: `the launches of issue-30 could not be listed: EACCES: permission denied, scandir '${agentsDir}'` },
    ],
  })
  assert.deepEqual(closes(orca), [])
  await unlisted.worker.deactivate()

  // Launch 1 lost its task file, launch 2's answer cannot be read: launch 1 and 3 are stopped all the same, launch 2
  // is an error with the reason.
  const firstLaunching = orca.machine.files.get(`${first.dir}/launching.json`)
  orca.machine.files.delete(first.taskFile)
  const denied = `EACCES: permission denied, open '${second.dir}/launch.json'`
  const machine: Machine = {
    ...orca.machine,
    readText: (path) => {
      if (path === `${second.dir}/launch.json`) throw new Error(denied)
      return orca.machine.readText(path)
    },
  }
  const restarted = await mount(orca, { machine })
  assert.deepEqual(
    restarted.agents.launches(task).map((record) => [record.number, record.outcome, record.terminalId, record.agent]),
    [
      [1, 'launched', 'terminal-1', 'codex'],
      [2, 'unreadable', null, 'claude'],
      [3, 'launched', 'terminal-3', 'gemini'],
    ],
  )
  assert.deepEqual(await restarted.agents.stop(task), {
    closed: ['terminal-1', 'terminal-3'],
    failed: [
      {
        launch: 2,
        terminalId: null,
        error: `the records of launch 2 (the agent "claude") cannot be read: launch.json: ${denied}: its terminal, if any, is unknown`,
      },
    ],
  })
  assert.equal(orca.terminals.get('terminal-2')?.open, true)
  // A new launch takes the number after the largest launch directory, not the one whose task file is gone; launch
  // 1's records stay as they were.
  const fourth = await restarted.agents.launch(request(30, 'implementer'))
  assert.ok(fourth.ok && fourth.launch.number === 4, JSON.stringify(fourth))
  assert.equal(orca.machine.files.get(`${first.dir}/launching.json`), firstLaunching)
  assert.ok(!orca.machine.files.has(first.taskFile))
  await restarted.worker.deactivate()

  // Readable again after a restart: the stop closes launch 2's terminal and the new one, and not 1 and 3 again.
  const again = await mount(orca)
  assert.deepEqual(await again.agents.stop(task), { closed: ['terminal-2', 'terminal-4'], failed: [] })
  assert.deepEqual(closes(orca), ['terminal-1', 'terminal-3', 'terminal-2', 'terminal-4'])
  await again.worker.deactivate()
})

test('Остановка, которую начал taskText запуска, отклоняет этот запуск до запроса к Orca: терминал не открыт, после остановки задача запускается снова', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)
  const task = issueTask(PROJECT, 43)
  const stops: Promise<StopResult>[] = []
  const result = await r.agents.launch({
    ...request(43, 'implementer'),
    taskText: (files) => {
      // The caller's own code starts a stop of the task while the launch writes its task file.
      stops.push(r.agents.stop(task))
      return request(43, 'implementer').taskText(files)
    },
  })
  const error = 'the agent "codex" (agents.implementer in .agent-queue.json) was not launched: the agents of issue-43 are being stopped'
  assert.deepEqual(result, { ok: false, kind: 'launch-failed', role: 'implementer', agent: 'codex', error })
  assert.equal(stops.length, 1)
  assert.deepEqual(await stops[0], { closed: [], failed: [] })
  assert.deepEqual(orca.host.callsOf('agent.launch'), [])
  assert.equal(orca.terminals.size, 0)
  assert.deepEqual(r.agents.launches(task).map((record) => [record.number, record.outcome, record.error]), [[1, 'failed', error]])
  // After the stop the task launches again, as launch 2.
  const again = await r.agents.launch(request(43, 'implementer'))
  assert.ok(again.ok && again.launch.number === 2, JSON.stringify(again))
  await r.worker.deactivate()
})

test('Номер запуска — следующий после наибольшего каталога запусков задачи: после 1000 запусков, отказы в том числе, задача запускается снова; два запуска сразу — два номера', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)
  const task: TaskRef = { project: PROJECT, key: 'mvp-start' }
  // 1000 earlier launches of the start agent, every one refused by Orca.
  for (let n = 1; n <= 1000; n++) {
    const dir = launchDir(r, 'mvp-start', n)
    orca.machine.files.set(`${dir}/task.md`, '# Старт MVP\n')
    orca.machine.files.set(
      `${dir}/launching.json`,
      JSON.stringify({ role: 'start', agent: 'opencode', language: 'ru', workspaceId: 'workspace-main-checkout', launchedAt: n }),
    )
    orca.machine.files.set(`${dir}/launch.json`, JSON.stringify({ terminalId: null, error: 'action_failed: Orca is busy' }))
  }
  const start = await r.agents.launch({
    task,
    role: 'start',
    agents: AGENTS,
    language: 'ru',
    workspaceId: 'workspace-main-checkout',
    taskText: () => '# Старт MVP\n',
  })
  assert.ok(start.ok, JSON.stringify(start))
  assert.equal(start.launch.number, 1001)
  assert.equal(start.launch.dir, launchDir(r, 'mvp-start', 1001))
  const records = r.agents.launches(task)
  assert.equal(records.length, 1001)
  assert.deepEqual(
    records.slice(-2).map((record) => [record.number, record.outcome, record.terminalId]),
    [
      [1000, 'failed', null],
      [1001, 'launched', 'terminal-1'],
    ],
  )
  assert.deepEqual(await r.agents.stop(task), { closed: ['terminal-1'], failed: [] })
  await r.worker.deactivate()

  // Two launches of one task at once, on a disk that takes its time: both find number 1 free, one creates its task
  // file there, the other finds it taken and takes number 2 — each with its own task file.
  const slow: Machine = {
    ...orca.machine,
    createText: async (path, text) => {
      await settle()
      return orca.machine.createText(path, text)
    },
  }
  const racing = await mount(orca, { machine: slow })
  const results = await Promise.all([racing.agents.launch(request(5, 'implementer')), racing.agents.launch(request(5, 'reviewer'))])
  const launches = results.map((result) => {
    assert.ok(result.ok, JSON.stringify(result))
    return result.launch
  })
  assert.deepEqual(launches.map((launch) => launch.number).sort(), [1, 2])
  for (const launch of launches) {
    assert.equal(orca.machine.files.get(launch.taskFile), request(5, launch.role).taskText(launch))
  }
  assert.deepEqual(
    racing.agents.launches(issueTask(PROJECT, 5)).map((record) => [record.number, record.outcome]),
    [
      [1, 'launched'],
      [2, 'launched'],
    ],
  )
  await racing.worker.deactivate()
})

test('Проект и ключ задачи берутся в момент вызова: ProjectRef, изменённый потом, не переносит ни запуск, ни остановку в каталог другой копии проекта', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)
  const remote: ProjectRef = { id: PROJECT.id, hostId: 'ssh:build-box' }
  // The caller changes its project object right after asking for the launch: the launch stays the local copy's.
  const project = { id: PROJECT.id, hostId: 'local' }
  const launching = r.agents.launch({ ...request(12, 'implementer'), task: { project, key: 'issue-12' } })
  project.hostId = 'ssh:build-box'
  const result = await launching
  assert.ok(result.ok, JSON.stringify(result))
  assert.deepEqual(result.launch.task, { project: PROJECT, key: 'issue-12' })
  assert.equal(result.launch.dir, launchDir(r, 'issue-12', 1))
  assert.deepEqual(r.agents.launches(issueTask(remote, 12)), [])
  assert.deepEqual(await r.agents.stop(issueTask(remote, 12)), { closed: [], failed: [] })
  assert.equal(orca.terminals.get(result.launch.terminalId)?.open, true)

  // A stop of the remote copy whose project object turns local while the stop waits: it stays the remote copy's.
  const turning = { id: PROJECT.id, hostId: 'ssh:build-box' }
  const stopping = r.agents.stop({ project: turning, key: 'issue-12' })
  turning.hostId = 'local'
  assert.deepEqual(await stopping, { closed: [], failed: [] })
  assert.equal(orca.terminals.get(result.launch.terminalId)?.open, true)
  // Nor does a key changed after the call move a stop to another task.
  const task = { project: { ...PROJECT }, key: 'issue-12' }
  const stoppingLocal = r.agents.stop(task)
  task.key = 'issue-13'
  assert.deepEqual(await stoppingLocal, { closed: [result.launch.terminalId], failed: [] })
  await r.worker.deactivate()
})

test('В каталоге запусков задачи запуски — только настоящие каталоги с номером: ссылка с номером на запись другой задачи и файл с номером — не запуски, но их номера заняты; ссылка на пути к запускам задачи — ошибка, а не чужие записи', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)
  const mine = await launched(r, 12, 'implementer')
  const foreign = await launched(r, 13, 'implementer')
  assert.deepEqual([mine.terminalId, foreign.terminalId], ['terminal-1', 'terminal-2'])
  // Restored by hand: issue 12's agents/7 is a link to issue 13's launch 1 (its terminal open), agents/9 a file.
  const agents12 = parent(mine.dir)
  orca.machine.links.set(`${agents12}/7`, foreign.dir)
  orca.machine.files.set(`${agents12}/9`, 'not a launch\n')
  // Through the link the disk shows issue 13's records.
  assert.equal(orca.machine.readText(`${agents12}/7/launch.json`), orca.machine.files.get(`${foreign.dir}/launch.json`))
  assert.deepEqual(r.agents.launches(issueTask(PROJECT, 12)).map((record) => record.number), [1])
  // A new launch takes a number no entry has: after 9.
  const next = await launched(r, 12, 'reviewer')
  assert.equal(next.number, 10)
  assert.equal(next.dir, `${agents12}/10`)
  assert.deepEqual(await r.agents.stop(issueTask(PROJECT, 12)), { closed: ['terminal-1', 'terminal-3'], failed: [] })
  assert.equal(orca.terminals.get('terminal-2')?.open, true)
  assert.ok(!orca.machine.files.has(`${foreign.dir}/closed`))

  // Issue 14's task directory is a link to issue 13's: its launches are an error, a stop closes nothing, and a launch
  // writes nothing through the link.
  const task14 = parent(parent(launchDir(r, 'issue-14', 1)))
  orca.machine.links.set(task14, parent(parent(foreign.dir)))
  const linked = `${task14} is a link or a file, not a directory: the plugin reads no launches through it`
  assert.throws(() => r.agents.launches(issueTask(PROJECT, 14)), /is a link or a file, not a directory/)
  assert.deepEqual(await r.agents.stop(issueTask(PROJECT, 14)), {
    closed: [],
    failed: [{ launch: null, terminalId: null, error: `the launches of issue-14 could not be listed: ${linked}` }],
  })
  const refused = await r.agents.launch(request(14, 'implementer'))
  assert.deepEqual(refused, {
    ok: false,
    kind: 'launch-failed',
    role: 'implementer',
    agent: 'codex',
    error: `the agent "codex" (agents.implementer in .agent-queue.json) was not launched: its task file: ${linked}`,
  })
  assert.equal(orca.host.callsOf('agent.launch').length, 3)
  assert.deepEqual(r.agents.launches(issueTask(PROJECT, 13)).map((record) => record.number), [1])
  assert.equal(orca.terminals.get('terminal-2')?.open, true)
  await r.worker.deactivate()
})

test('Повторная остановка: запуск с меткой closed — не ошибка, даже если его launch.json не прочитать или он испорчен; есть ли метка, не узнать — ошибка этого запуска; другие открытые терминалы закрыты', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)
  const task = issueTask(PROJECT, 31)
  const first = await launched(r, 31, 'implementer')
  assert.deepEqual(await r.agents.stop(task), { closed: [first.terminalId], failed: [] })
  assert.ok(orca.machine.files.has(`${first.dir}/closed`))
  const second = await launched(r, 31, 'reviewer')
  await r.worker.deactivate()

  // Launch 1's answer can no longer be read; its mark is there: the stop closes launch 2 and reports nothing else.
  const denied: Machine = {
    ...orca.machine,
    readText: (path) => {
      if (path === `${first.dir}/launch.json`) throw new Error(`EACCES: permission denied, open '${path}'`)
      return orca.machine.readText(path)
    },
  }
  const unreadable = await mount(orca, { machine: denied })
  assert.deepEqual(
    unreadable.agents.launches(task).map((record) => [record.number, record.outcome, record.closed]),
    [
      [1, 'unreadable', true],
      [2, 'launched', false],
    ],
  )
  assert.deepEqual(await unreadable.agents.stop(task), { closed: [second.terminalId], failed: [] })
  const third = await launched(unreadable, 31, 'solver')
  await unreadable.worker.deactivate()

  // Launch 1's answer damaged: the same.
  orca.machine.files.set(`${first.dir}/launch.json`, '{ "terminalId": ')
  const damaged = await mount(orca)
  assert.deepEqual(await damaged.agents.stop(task), { closed: [third.terminalId], failed: [] })
  const fourth = await launched(damaged, 31, 'implementer')
  await damaged.worker.deactivate()

  // Launch 1's directory cannot be listed, so whether its mark is there is not known: an error for launch 1, with the
  // reason; launch 4's terminal is closed all the same.
  const reason = `EACCES: permission denied, scandir '${first.dir}'`
  const unlisted = await mount(orca, {
    machine: {
      ...orca.machine,
      listEntries: (path) => {
        if (path === first.dir) throw new Error(reason)
        return orca.machine.listEntries(path)
      },
    },
  })
  assert.deepEqual(await unlisted.agents.stop(task), {
    closed: [fourth.terminalId],
    failed: [
      {
        launch: 1,
        terminalId: null,
        error: `the records of launch 1 cannot be read: its directory: ${reason}: its terminal, if any, is unknown`,
      },
    ],
  })
  assert.deepEqual(closes(orca), [first.terminalId, second.terminalId, third.terminalId, fourth.terminalId])
  await unlisted.worker.deactivate()
})

test('Запуск исполнителя через поддельный хост → agent.launch с агентом из настроек, worktree задачи и заданием; отчёт готов только после состояния «done» и появления файла отчёта', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)
  const launch = await launched(r, 12, 'implementer')

  // agent.launch: the implementer's agent of the settings, in the task's worktree, with the prompt naming the task file
  // and the report file; the task file is the implementer's task, and it names the report file.
  const dir = launchDir(r, 'issue-12', 1)
  assert.deepEqual([launch.taskFile, launch.reportFile, launch.terminalId], [`${dir}/task.md`, `${dir}/report.md`, 'terminal-1'])
  assert.deepEqual(orca.host.calls, [
    {
      method: 'agent.launch',
      params: { workspaceId: 'workspace-issue-12', agent: 'codex', prompt: launchPrompt('ru', launch.taskFile, launch.reportFile) },
    },
  ])
  assert.equal(orca.machine.files.get(launch.taskFile), request(12, 'implementer').taskText(launch))
  assert.ok(orca.machine.files.get(launch.taskFile)?.startsWith('# Задание исполнителя: задача #12\n'))
  assert.ok(orca.machine.files.get(launch.taskFile)?.includes(launch.reportFile))

  // Orca has said nothing of the agent yet: the terminal is there, the agent has not started.
  assert.deepEqual(await r.agents.report(launch), notReady(launch))
  // The agent works on its task (Orca lists it and tells it) and writes its report, still in its turn: not ready.
  orca.clock.advance(1_000)
  orca.list(launch.terminalId, 'working', orca.clock.now())
  await r.worker.emit('agent.status.changed', status(launch, 'working', orca.clock.now(), orca.clock.now()))
  assert.deepEqual(await r.agents.report(launch), notReady(launch, { state: 'working', listed: true, started: true }))
  orca.clock.advance(60_000)
  orca.machine.files.set(launch.reportFile, 'Черновик отчёта.\n')
  assert.deepEqual(await r.agents.report(launch), notReady(launch, { state: 'working', listed: true, started: true, reportExists: true }))
  // It ends its turn with the report: ready, with the file's text.
  orca.clock.advance(30_000)
  orca.finishTurn(launch, 'Сделано: фильтр по цвету.\n')
  assert.deepEqual(await r.agents.report(launch), { ready: true, text: 'Сделано: фильтр по цвету.\n', reportFile: launch.reportFile })

  // The reviewer of the same task ends a turn without a report: «done» without the file is not ready.
  const reviewer = await launched(r, 12, 'reviewer')
  assert.equal(reviewer.agent, 'claude')
  orca.list(reviewer.terminalId, 'done', orca.clock.now())
  assert.deepEqual(await r.agents.report(reviewer), notReady(reviewer, { state: 'done', listed: true }))
  // Orca was asked only its list of the task's workspace.
  assert.deepEqual(orca.host.callsOf('agents.list'), Array(5).fill({ workspaceId: 'workspace-issue-12' }))
  assert.deepEqual(r.worker.refusals, [])
  await r.worker.deactivate()
})

test('Отчёт: файл есть, а агент working, blocked или waiting → не готов; «done» без файла → не готов; файл записан позже начала «done» → не готов, и ответ это называет; «done», начавшийся не раньше последней записи файла, → готов с текстом файла', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)
  const launch = await launched(r, 30, 'implementer')
  orca.clock.advance(1_000)
  orca.list(launch.terminalId, 'working', orca.clock.now())
  orca.clock.advance(60_000)
  orca.machine.files.set(launch.reportFile, 'Отчёт: фильтр по цвету.\n')
  // The report file is there, and the agent is still in its turn: working, waiting for a permission, idle.
  for (const state of ['working', 'blocked', 'waiting'] as const) {
    orca.clock.advance(1_000)
    orca.list(launch.terminalId, state, orca.clock.now())
    assert.deepEqual(await r.agents.report(launch), notReady(launch, { state, listed: true, started: true, reportExists: true }))
  }

  // «done» without the report file: not ready.
  const silent = await launched(r, 31, 'implementer')
  orca.list(silent.terminalId, 'done', orca.clock.now())
  assert.deepEqual(await r.agents.report(silent), notReady(silent, { state: 'done', listed: true }))

  // The agent is «done», and its report file is written after that «done» began — by one millisecond: not ready, and
  // the reading says the file was written after it.
  orca.clock.advance(1_000)
  const doneAt = orca.clock.now()
  orca.list(launch.terminalId, 'done', doneAt)
  orca.clock.advance(1)
  orca.machine.files.set(launch.reportFile, 'Отчёт: фильтр по цвету и размеру.\n')
  assert.equal(orca.machine.modifiedAt(launch.reportFile), doneAt + 1)
  assert.deepEqual(
    await r.agents.report(launch),
    notReady(launch, { state: 'done', listed: true, started: true, reportExists: true, writtenAfterDone: true }),
  )
  // A «done» that began at the very time of the file's last write: ready, with the text of the file.
  orca.list(launch.terminalId, 'done', doneAt + 1)
  assert.deepEqual(await r.agents.report(launch), {
    ready: true,
    text: 'Отчёт: фильтр по цвету и размеру.\n',
    reportFile: launch.reportFile,
  })
  // And one that began later.
  orca.list(launch.terminalId, 'done', doneAt + 5_000)
  assert.equal((await r.agents.report(launch)).ready, true)
  assert.deepEqual(r.worker.refusals, [])
  await r.worker.deactivate()
})

test('Агент закончил ход без отчёта, начал новый ход и записал черновик, а задержанный ответ agents.list несёт снимок прежнего «done» → не готов, с событием нового working до ответа и без него', async () => {
  for (const event of [false, true]) {
    const orca = fakeOrca()
    const r = await mount(orca)
    const launch = await launched(r, 33, 'implementer')
    // Turn 1: the agent works, then ends its turn without a report.
    orca.clock.advance(1_000)
    orca.list(launch.terminalId, 'working', orca.clock.now())
    assert.deepEqual(await r.agents.report(launch), notReady(launch, { state: 'working', listed: true, started: true }))
    orca.clock.advance(60_000)
    const firstDone = orca.clock.now()
    orca.list(launch.terminalId, 'done', firstDone)
    assert.deepEqual(await r.agents.report(launch), notReady(launch, { state: 'done', listed: true, started: true }))

    // The report is asked for: Orca answers with that «done», and its answer reaches the worker late.
    const held = gate()
    orca.listGate = held.promise
    const reading = r.agents.report(launch)
    await settle()
    // Meanwhile the agent starts a new turn — Orca tells it to the worker or not — and writes a draft of its report.
    orca.clock.advance(5_000)
    orca.list(launch.terminalId, 'working', orca.clock.now())
    // The test worker's emit settles once the host has no call pending: its handler runs at once, and the emit is
    // awaited after the list's answer is let go.
    const emitted = event ? r.worker.emit('agent.status.changed', status(launch, 'working', orca.clock.now(), orca.clock.now())) : null
    orca.clock.advance(5_000)
    orca.machine.files.set(launch.reportFile, 'Черновик отчёта.\n')
    orca.listGate = null
    held.open()
    await emitted
    // The late answer's «done» began before the draft was written: not ready.
    assert.deepEqual(
      await reading,
      notReady(launch, { state: 'done', listed: true, started: true, reportExists: true, writtenAfterDone: true }),
      `the event of the new turn ${event ? 'heard' : 'not heard'}`,
    )
    // Orca's current list: the new turn.
    assert.deepEqual(await r.agents.report(launch), notReady(launch, { state: 'working', listed: true, started: true, reportExists: true }))
    // The agent ends the new turn with its report: ready, with that text.
    orca.clock.advance(30_000)
    orca.finishTurn(launch, 'Отчёт: фильтр по цвету.\n')
    assert.deepEqual(await r.agents.report(launch), { ready: true, text: 'Отчёт: фильтр по цвету.\n', reportFile: launch.reportFile })
    assert.deepEqual(r.worker.refusals, [])
    await r.worker.deactivate()
  }
})

test('При файле отчёта событие «done», с временем начала и без него, не делает отчёт готовым, когда список Orca называет агента working или не называет его вовсе; ответ говорит, называет ли агента список; список с «done» не раньше записи файла → готов', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)
  const launch = await launched(r, 34, 'implementer')
  orca.clock.advance(1_000)
  orca.list(launch.terminalId, 'working', orca.clock.now())
  orca.clock.advance(60_000)
  orca.machine.files.set(launch.reportFile, 'Отчёт: фильтр по цвету.\n')
  orca.clock.advance(1_000)
  const after = orca.clock.now()

  // Orca tells «done» — with the main agent's start after the file's last write, then without a start — while its list
  // names the agent working: the list's state, not ready.
  const working = notReady(launch, { state: 'working', listed: true, started: true, reportExists: true })
  await r.worker.emit('agent.status.changed', status(launch, 'done', after, after))
  assert.deepEqual(await r.agents.report(launch), working)
  await r.worker.emit('agent.status.changed', status(launch, 'done', after + 1_000))
  assert.deepEqual(await r.agents.report(launch), working)

  // The list no longer names the agent: its state is the latest event's, and the report is not confirmed — with the
  // start of «done» after the file and without it.
  orca.unlist(launch.terminalId)
  const unlisted = notReady(launch, { state: 'done', listed: false, started: true, reportExists: true })
  assert.deepEqual(await r.agents.report(launch), unlisted)
  assert.deepEqual(await r.agents.state(launch), { state: 'done', since: null })
  await r.worker.emit('agent.status.changed', status(launch, 'done', after + 2_000, after + 2_000))
  assert.deepEqual(await r.agents.state(launch), { state: 'done', since: after + 2_000 })
  assert.deepEqual(await r.agents.report(launch), unlisted)
  // A late event of an earlier state, both starts known, does not replace the later one.
  await r.worker.emit('agent.status.changed', status(launch, 'working', after + 3_000, after - 30_000))
  assert.deepEqual(await r.agents.state(launch), { state: 'done', since: after + 2_000 })

  // After a restart of the worker the same: a «done» the new worker hears for an agent the list does not name confirms
  // nothing.
  await r.worker.deactivate()
  const restarted = await mount(orca)
  const again = recorded(restarted, issueTask(PROJECT, 34), 1)
  await restarted.worker.emit('agent.status.changed', status(again, 'done', after + 4_000))
  assert.deepEqual(await restarted.agents.report(again), unlisted)

  // The list names the agent «done», begun after the file's last write: ready.
  orca.list(launch.terminalId, 'done', after + 5_000)
  assert.deepEqual(await restarted.agents.report(again), { ready: true, text: 'Отчёт: фильтр по цвету.\n', reportFile: launch.reportFile })
  assert.deepEqual(restarted.worker.refusals, [])
  await restarted.worker.deactivate()
})

test('Терминал открыт, хода нет → через 10 минут после запуска ответ называет сбой доставки с состоянием Orca, для blocked — что агент ждёт человека; working, увиденный вовремя, → сбоя нет и через несколько сроков', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)
  // Orca opened the terminals; the prompts did not get through. One agent Orca lists idle, one waits for a person
  // (a trust prompt) before its first turn, of one Orca says nothing.
  const idle = await launched(r, 40, 'implementer')
  orca.list(idle.terminalId, 'waiting', idle.launchedAt + 2_000)
  const blocked = await launched(r, 41, 'implementer')
  orca.list(blocked.terminalId, 'blocked', blocked.launchedAt + 2_000)
  const silent = await launched(r, 42, 'implementer')
  // One agent starts its turn in time: Orca tells it in an event.
  const working = await launched(r, 43, 'implementer')
  await r.worker.emit('agent.status.changed', status(working, 'working', working.launchedAt + 3_000, working.launchedAt + 3_000))
  assert.ok(orca.machine.files.has(startMark(orca, working)))

  orca.clock.advance(DELIVERY_DEADLINE_MS - 1)
  assert.deepEqual(await r.agents.report(idle), notReady(idle, { state: 'waiting', listed: true }))
  assert.deepEqual(await r.agents.report(silent), notReady(silent))

  orca.clock.advance(1)
  assert.deepEqual(
    await r.agents.report(idle),
    notReady(idle, {
      state: 'waiting',
      listed: true,
      failure: {
        state: 'waiting',
        error: 'the task did not reach the agent "codex" in terminal terminal-1: no turn in 10 minutes after the launch (Orca shows it waiting)',
      },
    }),
  )
  assert.deepEqual(
    await r.agents.report(blocked),
    notReady(blocked, {
      state: 'blocked',
      listed: true,
      failure: {
        state: 'blocked',
        error:
          'the agent "codex" in terminal terminal-2 has not started on its task in 10 minutes after the launch: Orca shows it blocked — it waits for a person (a permission, a trust prompt)',
      },
    }),
  )
  assert.deepEqual(
    await r.agents.report(silent),
    notReady(silent, {
      failure: {
        state: null,
        error: 'the task did not reach the agent "codex" in terminal terminal-3: no turn in 10 minutes after the launch (Orca shows nothing of it)',
      },
    }),
  )
  for (const launch of [idle, blocked, silent]) assert.equal(orca.machine.files.has(startMark(orca, launch)), false)

  // The turn seen in time: no failure several deadlines later, also while the agent now waits for a permission.
  orca.clock.advance(3 * DELIVERY_DEADLINE_MS)
  assert.deepEqual(await r.agents.report(working), notReady(working, { state: 'working', started: true }))
  orca.list(working.terminalId, 'blocked', orca.clock.now())
  assert.deepEqual(await r.agents.report(working), notReady(working, { state: 'blocked', listed: true, started: true }))
  assert.deepEqual(r.worker.refusals, [])
  await r.worker.deactivate()
})

test('working до перезапуска воркера, после него blocked без отчёта за сроком → не сбой; working, услышанный до ответа Orca на запуск, оставляет ту же отметку на диске', async () => {
  // The agent starts its task (Orca tells it), then the worker restarts. The start is on disk.
  const orca = fakeOrca()
  const first = await mount(orca)
  const launch = await launched(first, 50, 'implementer')
  assert.equal(orca.machine.files.has(startMark(orca, launch)), false)
  await first.worker.emit('agent.status.changed', status(launch, 'working', launch.launchedAt + 1_000, launch.launchedAt + 1_000))
  assert.equal(orca.machine.files.get(startMark(orca, launch)), `${launch.launchedAt}\n`)
  await first.worker.deactivate()

  // After the restart the agent waits for a person's permission: blocked, no report, the deadline long past — no
  // failure.
  orca.list(launch.terminalId, 'blocked', launch.launchedAt + 2_000)
  orca.clock.advance(DELIVERY_DEADLINE_MS + 1)
  const restarted = await mount(orca)
  const again = recorded(restarted, issueTask(PROJECT, 50), 1)
  assert.deepEqual(await restarted.agents.report(again), notReady(again, { state: 'blocked', listed: true, started: true }))
  // An agent of the new worker that never started — blocked before its first turn — is the failed delivery.
  const other = await launched(restarted, 51, 'implementer')
  orca.list(other.terminalId, 'blocked', other.launchedAt + 500)
  orca.clock.advance(DELIVERY_DEADLINE_MS)
  const late = await restarted.agents.report(other)
  assert.ok(!late.ready && late.failure?.state === 'blocked', JSON.stringify(late))
  await restarted.worker.deactivate()

  // Orca tells the turn of the agent in the terminal it opens (terminal-1) before it answers the launch.
  const early = fakeOrca()
  const r = await mount(early)
  const held = gate()
  early.launchGate = held.promise
  const launching = r.agents.launch(request(52, 'implementer'))
  await settle()
  const startedAt = early.clock.now() + 500
  // The test worker's emit settles once the host has no call pending: its handler runs at once, and the emit is
  // awaited after Orca's answer is let go.
  const emitted = r.worker.emit('agent.status.changed', {
    workspaceId: 'workspace-issue-52',
    paneKey: 'pane-terminal-1',
    terminalId: 'terminal-1',
    state: 'working',
    receivedAt: startedAt,
    mainAgent: { state: 'working', stateStartedAt: startedAt },
  })
  early.launchGate = null
  held.open()
  await emitted
  const result = await launching
  assert.ok(result.ok && result.launch.terminalId === 'terminal-1', JSON.stringify(result))
  // The same mark, there when the launch's result is.
  assert.ok(early.machine.files.has(startMark(early, result.launch)))
  await r.worker.deactivate()
  early.list('terminal-1', 'blocked', startedAt + 1_000)
  early.clock.advance(DELIVERY_DEADLINE_MS + 1)
  const later = await mount(early)
  const relaunch = recorded(later, issueTask(PROJECT, 52), 1)
  assert.deepEqual(await later.agents.report(relaunch), notReady(relaunch, { state: 'blocked', listed: true, started: true }))
  assert.deepEqual(later.worker.refusals, [])
  await later.worker.deactivate()
})

test('Запуск прежнего воркера новый воркер знает с первого чтения его состояния или отчёта: ход, услышанный до чтения, отмечается на диске при чтении, после чтения — сразу; до чтения отметки нет', async () => {
  const orca = fakeOrca()
  const first = await mount(orca)
  const heardBefore = await launched(first, 70, 'implementer')
  const heardAfter = await launched(first, 71, 'implementer')
  await first.worker.deactivate()

  const restarted = await mount(orca)
  const before = recorded(restarted, issueTask(PROJECT, 70), 1)
  const after = recorded(restarted, issueTask(PROJECT, 71), 1)
  // A turn of launch 70 before the new worker has read anything of it: no mark yet.
  orca.clock.advance(1_000)
  await restarted.worker.emit('agent.status.changed', status(before, 'working', orca.clock.now(), orca.clock.now()))
  assert.equal(orca.machine.files.has(startMark(orca, heardBefore)), false)
  // Its first reading — of the state — keeps that turn on disk.
  assert.deepEqual(await restarted.agents.state(before), { state: 'working', since: orca.clock.now() })
  assert.equal(orca.machine.files.get(startMark(orca, heardBefore)), `${orca.clock.now()}\n`)
  // Launch 71: read first, its turn heard later — on disk at once, with no reading after it.
  assert.equal(await restarted.agents.state(after), null)
  orca.clock.advance(1_000)
  await restarted.worker.emit('agent.status.changed', status(after, 'working', orca.clock.now(), orca.clock.now()))
  assert.equal(orca.machine.files.get(startMark(orca, heardAfter)), `${orca.clock.now()}\n`)
  await restarted.worker.deactivate()

  // A worker started later sees both started, though Orca now shows them blocked and the deadline is long past.
  orca.list(before.terminalId, 'blocked', orca.clock.now())
  orca.list(after.terminalId, 'blocked', orca.clock.now())
  orca.clock.advance(DELIVERY_DEADLINE_MS)
  const third = await mount(orca)
  for (const launch of [before, after]) {
    assert.deepEqual(await third.agents.report(launch), notReady(launch, { state: 'blocked', listed: true, started: true }))
  }
  assert.deepEqual(third.worker.refusals, [])
  await third.worker.deactivate()
})

test('После перезапуска воркера без единого события список Orca с «done» не раньше записи файла → готов; список не читается → ошибка, а не «не готов»', async () => {
  const orca = fakeOrca({ platform: 'win32' })
  const first = await mount(orca)
  const launch = await launched(first, 60, 'implementer', DEFAULT_AGENTS)
  assert.equal(launch.agent, 'claude')
  assert.ok(launch.reportFile.startsWith('C:\\Users\\Avery\\AppData\\Local\\orca-agent-queue\\projects\\'), launch.reportFile)
  await first.worker.deactivate()
  // While no worker runs the agent works and ends its turn with its report.
  orca.clock.advance(5 * 60_000)
  orca.finishTurn(launch, 'Готово.\n')
  orca.ownerTerminal('workspace-issue-60')

  // The new worker has heard no event: Orca's list gives the state, and confirms the report.
  const restarted = await mount(orca)
  const again = recorded(restarted, issueTask(PROJECT, 60), 1)
  assert.deepEqual(await restarted.agents.state(again), { state: 'done', since: orca.clock.now() })
  assert.deepEqual(await restarted.agents.report(again), { ready: true, text: 'Готово.\n', reportFile: launch.reportFile })

  // Orca cannot give its list: an error, neither «not ready» nor «no state».
  orca.listError = { code: 'unavailable', message: 'Orca is restarting' }
  const unreadable = (error: unknown) =>
    error instanceof Error &&
    error.message === "Orca's list of the agents of workspace workspace-issue-60 could not be read: unavailable: Orca is restarting"
  await assert.rejects(restarted.agents.report(again), unreadable)
  await assert.rejects(restarted.agents.state(again), unreadable)
  orca.listError = null

  // Orca no longer names the agent and this worker heard nothing of it: no state, the report not confirmed.
  orca.unlist(launch.terminalId)
  assert.equal(await restarted.agents.state(again), null)
  assert.deepEqual(await restarted.agents.report(again), notReady(again, { started: true, reportExists: true }))
  assert.deepEqual(restarted.worker.refusals, [])
  await restarted.worker.deactivate()
})

// The one test on the real disk (the exception of the tests' rule for the time of a file's last write): the layer reads
// the report file and its time with the real computer's file operations, in a temporary data directory.
test('Время записи файла отчёта — с долей миллисекунды, как его хранит файловая система: «done», начавшийся в ту же миллисекунду раньше записи черновика, отчёт не подтверждает; «done» не раньше записи — подтверждает (настоящий диск, временный каталог)', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-queue-report-time-'))
  try {
    const orca = fakeOrca({ platform: realPlatform() })
    const real = realMachine()
    const machine: Machine = {
      ...orca.machine,
      readText: real.readText,
      modifiedAt: real.modifiedAt,
      listEntries: real.listEntries,
      createText: real.createText,
    }
    const r = await mount(orca, { machine, dataDir })
    const launch = await launched(r, 80, 'implementer')
    const seconds = (ms: number) => ms / 1000
    // The agent's earlier turn ended at doneAt — Orca keeps the start in whole milliseconds — and the draft of its new
    // turn is written 0.7 ms later.
    const doneAt = Date.UTC(2026, 0, 15, 9, 40, 0)
    orca.list(launch.terminalId, 'done', doneAt)
    writeFileSync(launch.reportFile, 'Черновик отчёта.\n')
    utimesSync(launch.reportFile, seconds(doneAt + 0.7), seconds(doneAt + 0.7))
    assert.deepEqual(
      await r.agents.report(launch),
      notReady(launch, { state: 'done', listed: true, started: true, reportExists: true, writtenAfterDone: true }),
    )
    // A «done» that began the next millisecond: ready.
    orca.list(launch.terminalId, 'done', doneAt + 1)
    assert.deepEqual(await r.agents.report(launch), { ready: true, text: 'Черновик отчёта.\n', reportFile: launch.reportFile })
    // The file written at the very millisecond the «done» began: ready.
    orca.list(launch.terminalId, 'done', doneAt)
    utimesSync(launch.reportFile, seconds(doneAt), seconds(doneAt))
    assert.deepEqual(await r.agents.report(launch), { ready: true, text: 'Черновик отчёта.\n', reportFile: launch.reportFile })
    assert.deepEqual(r.worker.refusals, [])
    await r.worker.deactivate()
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('Отметку начала чтение отчёта пишет до чтения файла отчёта: черновик нового хода, записанный, пока пишется отметка, даёт «не готов», а не прежний текст', async () => {
  const orca = fakeOrca()
  const first = await mount(orca)
  const launch = await launched(first, 81, 'implementer')
  await first.worker.deactivate()
  // While no worker runs, the agent ends its turn with its report: no start mark is on disk yet.
  orca.clock.advance(5 * 60_000)
  orca.finishTurn(launch, 'Отчёт.\n')
  const mark = startMark(orca, launch)
  assert.equal(orca.machine.files.has(mark), false)

  // The new worker's disk takes its time with the mark, and meanwhile the agent starts a new turn and writes a draft.
  const machine: Machine = {
    ...orca.machine,
    createText: async (path, text) => {
      if (path === mark) {
        orca.clock.advance(1)
        orca.machine.files.set(launch.reportFile, 'Черновик нового хода.\n')
      }
      return orca.machine.createText(path, text)
    },
  }
  const restarted = await mount(orca, { machine })
  const again = recorded(restarted, issueTask(PROJECT, 81), 1)
  assert.deepEqual(
    await restarted.agents.report(again),
    notReady(again, { state: 'done', listed: true, started: true, reportExists: true, writtenAfterDone: true }),
  )
  assert.ok(orca.machine.files.has(mark))
  // The agent ends that turn with its report: ready, with that text.
  orca.clock.advance(30_000)
  orca.finishTurn(launch, 'Отчёт нового хода.\n')
  assert.deepEqual(await restarted.agents.report(again), { ready: true, text: 'Отчёт нового хода.\n', reportFile: launch.reportFile })
  assert.deepEqual(restarted.worker.refusals, [])
  await restarted.worker.deactivate()
})

test('Отметка начала, которую диск не принял или не отдаёт: ранний working до ответа Orca — запуск с ошибкой хранения, его терминал назван и открыт; чтение отчёта — ошибка с причиной, а не «не начал» и не сбой доставки', async () => {
  const orca = fakeOrca()
  // The disk refuses to write the start marks, or to read them, while the test says so.
  let refuse: 'write' | 'read' | null = null
  const isMark = (path: string) => path.endsWith('/started-0')
  const machine: Machine = {
    ...orca.machine,
    createText: async (path, text) => {
      if (refuse === 'write' && isMark(path)) throw new Error('ENOSPC: no space left on device')
      return orca.machine.createText(path, text)
    },
    readText: (path) => {
      if (refuse === 'read' && isMark(path)) throw new Error('EACCES: permission denied')
      return orca.machine.readText(path)
    },
  }
  const r = await mount(orca, { machine })

  // Orca tells the turn of the agent in the terminal it opens before it answers the launch; the mark cannot be written.
  refuse = 'write'
  const held = gate()
  orca.launchGate = held.promise
  const launching = r.agents.launch(request(90, 'implementer'))
  await settle()
  const turnAt = orca.clock.now() + 500
  // The test worker's emit settles once the host has no call pending: it is awaited after Orca's answer is let go.
  const emitted = r.worker.emit('agent.status.changed', status({ workspaceId: 'workspace-issue-90', terminalId: 'terminal-1' }, 'working', turnAt, turnAt))
  orca.launchGate = null
  held.open()
  await emitted
  const dir = launchDir(r, 'issue-90', 1)
  assert.deepEqual(await launching, {
    ok: false,
    kind: 'launch-failed',
    role: 'implementer',
    agent: 'codex',
    error: `the agent "codex" (agents.implementer in .agent-queue.json) was launched in terminal terminal-1 and started its task before Orca answered the launch, but the start of the task of launch 1 could not be kept in ${dir}/started-0: ENOSPC: no space left on device; the terminal stays open, and a stop of the task closes it`,
  })
  assert.equal(orca.terminals.get('terminal-1')?.open, true)
  assert.deepEqual(json(orca, `${dir}/launch.json`), { terminalId: 'terminal-1', error: null })
  assert.equal(orca.machine.files.has(`${dir}/started-0`), false)
  assert.deepEqual(await r.agents.stop(issueTask(PROJECT, 90)), { closed: ['terminal-1'], failed: [] })

  // A turn of a launch the worker knows, the mark refused: the reading of the report is an error with the reason —
  // not «started» without the mark — until the disk takes it.
  const launch = await launched(r, 91, 'implementer')
  const mark = startMark(orca, launch)
  await r.worker.emit('agent.status.changed', status(launch, 'working', orca.clock.now(), orca.clock.now()))
  assert.equal(orca.machine.files.has(mark), false)
  const notKept = `the start of the task of launch 1 could not be kept in ${mark}: ENOSPC: no space left on device`
  await assert.rejects(r.agents.report(launch), (error) => error instanceof Error && error.message === notKept)
  refuse = null
  assert.deepEqual(await r.agents.report(launch), notReady(launch, { state: 'working', started: true }))
  assert.ok(orca.machine.files.has(mark))
  await r.worker.deactivate()

  // After a restart the agent waits for a permission past the deadline, and its mark cannot be read: an error with the
  // reason, not a failed delivery.
  orca.list(launch.terminalId, 'blocked', orca.clock.now())
  orca.clock.advance(DELIVERY_DEADLINE_MS)
  const restarted = await mount(orca, { machine })
  const again = recorded(restarted, issueTask(PROJECT, 91), 1)
  refuse = 'read'
  const unreadable = `the start of the task of launch 1 cannot be read from ${mark}: EACCES: permission denied`
  await assert.rejects(restarted.agents.report(again), (error) => error instanceof Error && error.message === unreadable)
  refuse = null
  assert.deepEqual(await restarted.agents.report(again), notReady(again, { state: 'blocked', listed: true, started: true }))
  assert.deepEqual(restarted.worker.refusals, [])
  await restarted.worker.deactivate()
})

test('Файл отчёта, впервые появившийся, пока Orca отвечает на agents.list, без хода в событиях — начало задания: одно чтение отчёта оставляет started-0 и при «не готов», и при «готов»; отметка, которую другое чтение записало, пока это ждало Orca, — начало, а не сбой доставки', async () => {
  const orca = fakeOrca()
  const r = await mount(orca)

  // The agent writes its report while Orca answers the list, which shows it idle; Orca tells no turn: not ready, and
  // the start is on disk after this one reading.
  const idle = await launched(r, 82, 'implementer')
  orca.list(idle.terminalId, 'waiting', orca.clock.now())
  const held = gate()
  orca.listGate = held.promise
  const reading = r.agents.report(idle)
  await settle()
  orca.clock.advance(1_000)
  orca.machine.files.set(idle.reportFile, 'Черновик отчёта.\n')
  orca.listGate = null
  held.open()
  assert.deepEqual(await reading, notReady(idle, { state: 'waiting', listed: true, started: true, reportExists: true }))
  assert.ok(orca.machine.files.has(startMark(orca, idle)))

  // Orca's answer names a «done» that began after the report the agent writes while Orca answers: ready, and the start
  // is on disk too.
  const done = await launched(r, 83, 'implementer')
  orca.list(done.terminalId, 'done', orca.clock.now() + 2_000)
  const heldDone = gate()
  orca.listGate = heldDone.promise
  const readingDone = r.agents.report(done)
  await settle()
  orca.clock.advance(1_000)
  orca.machine.files.set(done.reportFile, 'Отчёт: фильтр по цвету.\n')
  orca.listGate = null
  heldDone.open()
  assert.deepEqual(await readingDone, { ready: true, text: 'Отчёт: фильтр по цвету.\n', reportFile: done.reportFile })
  assert.ok(orca.machine.files.has(startMark(orca, done)))

  // Past the deadline, nothing seen of the agent's turn. One reading waits for Orca; meanwhile another one, answered at
  // once, finds the report file and keeps the start, and then the file is gone. The first reading's answer: started —
  // the mark on disk — and no failed delivery.
  const raced = await launched(r, 84, 'implementer')
  orca.list(raced.terminalId, 'waiting', orca.clock.now())
  orca.clock.advance(DELIVERY_DEADLINE_MS)
  const heldRaced = gate()
  orca.listGate = heldRaced.promise
  const waiting = r.agents.report(raced)
  await settle()
  orca.listGate = null
  orca.machine.files.set(raced.reportFile, 'Черновик отчёта.\n')
  assert.deepEqual(await r.agents.report(raced), notReady(raced, { state: 'waiting', listed: true, started: true, reportExists: true }))
  orca.machine.files.delete(raced.reportFile)
  heldRaced.open()
  assert.deepEqual(await waiting, notReady(raced, { state: 'waiting', listed: true, started: true }))
  assert.deepEqual(r.worker.refusals, [])
  await r.worker.deactivate()
})

test('Ход, впервые показанный списком Orca или событием, пока чтение отчёта ждёт Orca, а отметку диск не принял: чтение отчёта — ошибка хранения с причиной, а не «начал» без отметки', async () => {
  const orca = fakeOrca()
  // The disk refuses to write the start marks while the test says so.
  let refuse = true
  const machine: Machine = {
    ...orca.machine,
    createText: async (path, text) => {
      if (refuse && path.endsWith('/started-0')) throw new Error('ENOSPC: no space left on device')
      return orca.machine.createText(path, text)
    },
  }
  const r = await mount(orca, { machine })
  const notKept = (launch: AgentLaunch) => (error: unknown) =>
    error instanceof Error &&
    error.message === `the start of the task of launch 1 could not be kept in ${startMark(orca, launch)}: ENOSPC: no space left on device`

  // The turn first shows in Orca's answer to the list.
  const listed = await launched(r, 85, 'implementer')
  orca.list(listed.terminalId, 'working', orca.clock.now())
  await assert.rejects(r.agents.report(listed), notKept(listed))

  // The turn is told by an event while the reading waits for Orca, whose answer shows the agent idle.
  const told = await launched(r, 86, 'implementer')
  orca.list(told.terminalId, 'waiting', orca.clock.now())
  const held = gate()
  orca.listGate = held.promise
  const reading = r.agents.report(told)
  await settle()
  // The test worker's emit settles once the host has no call pending: it is awaited after the list's answer is let go.
  const emitted = r.worker.emit('agent.status.changed', status(told, 'working', orca.clock.now(), orca.clock.now()))
  orca.listGate = null
  held.open()
  await assert.rejects(reading, notKept(told))
  await emitted

  // The disk takes the marks again: started, and kept.
  refuse = false
  assert.deepEqual(await r.agents.report(listed), notReady(listed, { state: 'working', listed: true, started: true }))
  assert.deepEqual(await r.agents.report(told), notReady(told, { state: 'waiting', listed: true, started: true }))
  for (const launch of [listed, told]) assert.ok(orca.machine.files.has(startMark(orca, launch)))
  assert.deepEqual(r.worker.refusals, [])
  await r.worker.deactivate()
})

test('Каталог на месте файла отчёта — не начало задания: чтение отчёта — ошибка с причиной, started-0 не записан; когда каталога нет, а хода не было, за сроком — сбой доставки', async () => {
  const orca = fakeOrca()
  // A directory where the report file should be, as the real computer sees it: reading it as a text fails, its
  // metadata has a time.
  let directory = true
  const isReport = (path: string) => path.endsWith('/report.md')
  const machine: Machine = {
    ...orca.machine,
    readText: (path) => {
      if (directory && isReport(path)) throw new Error('EISDIR: illegal operation on a directory, read')
      return orca.machine.readText(path)
    },
    modifiedAt: (path) => (directory && isReport(path) ? orca.clock.now() : orca.machine.modifiedAt(path)),
  }
  const r = await mount(orca, { machine })
  const launch = await launched(r, 87, 'implementer')
  orca.list(launch.terminalId, 'waiting', orca.clock.now())
  await assert.rejects(r.agents.report(launch), /EISDIR: illegal operation on a directory, read/)
  assert.equal(orca.machine.files.has(startMark(orca, launch)), false)

  // The directory is gone; the agent never started its task: past the deadline, a failed delivery.
  directory = false
  orca.clock.advance(DELIVERY_DEADLINE_MS)
  const late = await r.agents.report(launch)
  assert.ok(!late.ready && !late.started && late.failure?.state === 'waiting', JSON.stringify(late))
  assert.deepEqual(r.worker.refusals, [])
  await r.worker.deactivate()
})
