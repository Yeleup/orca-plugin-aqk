// The agents layer of the worker (src/agents/agents.ts) over a fake Orca (src/testing/fake-orca.ts: Orca's mock host
// with the refusals of Orca 1.4.274, on a fake computer): which agent is launched where and with which prompt, what each
// launch leaves in the data directory, which errors a launch gives, and what a stop closes and what it leaves. The layer
// runs in a worker as Orca runs it (`mountWorker`: the host refuses what the manifest's capabilities do not allow); the
// clock moves only when the test moves it. Invented project, issues, terminals and workspaces only.
import { assert, hostError, mountWorker, test, type TestWorker } from 'orca/testing'
import type { Machine } from '../platform/machine'
import { dataDirectory, dataName, dataPath } from '../platform/paths'
import type { AgentRole, ProjectAgents } from '../project/settings'
import { fakeOrca, type FakeOrca } from '../testing/fake-orca'
import {
  Agents,
  issueTask,
  ORCA_TEXT_MAX,
  type AgentLaunch,
  type LaunchFiles,
  type LaunchRequest,
  type ProjectRef,
  type StopResult,
  type TaskRef,
} from './agents'
import { implementerTask, launchPrompt, reviewerTask } from './task-text'

const PROJECT: ProjectRef = { id: 'Example-Org/Sample-Shop', hostId: 'local' }
const DATA_RULE = 'Никаких данных покупателей: имён, телефонов, адресов, токенов и ключей.'
// Agents of the settings other than the defaults: each role gets the agent of its own field.
const AGENTS: ProjectAgents = { implementer: 'codex', reviewer: 'claude', solver: 'gemini', start: 'opencode' }

type Rig = { readonly orca: FakeOrca; readonly worker: TestWorker; readonly agents: Agents; readonly dataDir: string }

// A worker with the agents layer on the fake Orca: its host is the worker's, the computer the fake one (or `machine`,
// which wraps it), the data directory the one of that computer unless the test names another.
async function mount(orca: FakeOrca, options: { readonly machine?: Machine; readonly dataDir?: string } = {}): Promise<Rig> {
  const dataDir = options.dataDir ?? dataDirectory(orca.machine)
  let agents: Agents | undefined
  const worker = await mountWorker(
    {
      default: (api) => {
        agents = new Agents({ host: api.host, machine: options.machine ?? orca.machine, dataDir })
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
      listNames: (path) => {
        throw new Error(`EACCES: permission denied, scandir '${path}'`)
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

test('Номер запуска — следующий после наибольшего каталога запусков задачи: после 1000 запусков, отказы в том числе, задача запускается снова', async () => {
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
})
