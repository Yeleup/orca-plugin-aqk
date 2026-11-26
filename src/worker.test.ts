// Runs src/worker.ts's activate(orca) over Orca's mock host (`orca plugin test`): the worker settles the plugin's data
// directory and the coordinator id of this computer. The real worker module runs with its home directory and the data
// variables of each system (XDG_DATA_HOME, LOCALAPPDATA) pointed into a temporary directory: the real data directory of
// this computer is never touched, and no system folder is looked up.
import { assert, mountWorker, test } from 'orca/testing'
import { readFileSync, statSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import { platform } from 'node:process'
import * as main from './worker'
import { startPlugin, startWorker } from './worker'
import { issueTask } from './agents/agents'
import { COORDINATOR_ID_FILE, ensureCoordinatorId, isCoordinatorId } from './platform/coordinator-id'
import { realPlatform } from './platform/machine'
import { dataDirectory, dataPath } from './platform/paths'
import { DEFAULT_AGENTS } from './project/settings'
import { fakeMachine } from './testing/fake-machine'
import { fakeOrca } from './testing/fake-orca'
import { withTemporaryHome } from './testing/temporary-home'

const STARTED = /^agent-queue: worker started, coordinator ([0-9a-f-]{36})$/

// The coordinator id file under `home` by the rules of this computer's system.
function idFileUnder(home: string): string {
  const system = realPlatform(platform)
  const dir =
    system === 'win32'
      ? join(home, 'local')
      : system === 'darwin'
        ? join(home, 'Library', 'Application Support')
        : join(home, 'data')
  return join(dir, 'orca-agent-queue', COORDINATOR_ID_FILE)
}

function coordinatorOf(logs: readonly string[]): string {
  assert.equal(logs.length, 1, JSON.stringify(logs))
  const match = STARTED.exec(logs[0] ?? '')
  assert.ok(match, logs[0])
  return match[1] ?? ''
}

// Names of the computer and the user to look for in an id. A name of hex digits only, shorter than 8, could appear in a
// random id by chance; such a name is left out of the check.
function identityNames(...more: string[]): string[] {
  return [hostname(), userInfo().username, ...more]
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '' && !(name.length < 8 && /^[0-9a-f-]+$/.test(name)))
}

test('id координатора создаётся один раз, после перезапуска воркера тот же, не содержит имени компьютера и имени пользователя', async () => {
  await withTemporaryHome(async (home) => {
    const file = idFileUnder(home)

    const first = await mountWorker(main)
    const id = coordinatorOf(first.logs)
    assert.ok(isCoordinatorId(id), id)
    assert.equal(readFileSync(file, 'utf8'), `${id}\n`)
    const created = statSync(file)
    await first.deactivate()

    const second = await mountWorker(main)
    assert.equal(coordinatorOf(second.logs), id)
    const kept = statSync(file)
    assert.equal(readFileSync(file, 'utf8'), `${id}\n`)
    assert.equal(kept.ino, created.ino, 'the id file was created again')
    assert.equal(kept.mtimeMs, created.mtimeMs, 'the id file was written again')
    await second.deactivate()

    for (const name of identityNames()) assert.ok(!id.includes(name), `the id holds «${name}»`)
  })

  // An invented computer and user: their names reach the worker through its environment and home directory.
  const machine = fakeMachine({
    platform: 'linux',
    homedir: '/home/juniper-wren',
    env: { USER: 'juniper-wren', LOGNAME: 'juniper-wren', HOSTNAME: 'quokka-desk', NAME: 'quokka-desk' },
  })
  const context = await startWorker({ log: () => {} }, machine)
  assert.ok(context.coordinatorId !== null && isCoordinatorId(context.coordinatorId))
  for (const name of identityNames('juniper-wren', 'quokka-desk', 'juniper', 'quokka')) {
    assert.ok(!context.coordinatorId.includes(name), `the id holds «${name}»`)
  }
})

// The delivery tests (tests/delivery.test.mjs) find this test by its name in a nested `make test`: keep the name.
test('the worker starts without host calls or refusals', async () => {
  const machine = fakeMachine({ platform: 'linux' })
  const worker = await mountWorker({ default: (orca) => startWorker(orca, machine) })
  coordinatorOf(worker.logs)
  assert.deepEqual(worker.host.calls, [])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

// Connecting projects is a later task (`connect`): until then the worker knows of none. The real worker module creates
// the data directory and the coordinator id: it runs with the temporary home.
test('Каркас панели: воркер отвечает панели на projects.list — подключённых проектов пока нет', async () => {
  await withTemporaryHome(async () => {
    const worker = await mountWorker(main)
    assert.deepEqual(await worker.request('projects.list', undefined, { panel: 'agent-queue' }), { projects: [] })
    assert.deepEqual(worker.host.calls, [])
    assert.deepEqual(worker.refusals, [])
    assert.deepEqual(worker.posts, [])
    await worker.deactivate()
  })
})

// The manifest lists Orca's agent.status.changed (with agent:read): Orca delivers no event a manifest does not list,
// and the mock host refuses to emit it. The worker is started as activate starts it (startPlugin), on a fake computer
// and a fake Orca: files in memory, a clock that moves only when told.
test('Воркер, запущенный так же, как в activate, получает agent.status.changed, и состояние агента в слое меняется; событие чужого терминала ничего не меняет', async () => {
  const orca = fakeOrca()
  let started: Awaited<ReturnType<typeof startPlugin>> | undefined
  const worker = await mountWorker(
    {
      default: async (api) => {
        started = await startPlugin(api, orca.machine)
      },
    },
    { host: orca.host },
  )
  assert.ok(started)
  assert.ok(started.coordinatorId !== null && isCoordinatorId(started.coordinatorId))
  coordinatorOf(worker.logs)
  const result = await started.agents.launch({
    task: issueTask({ id: 'example-org/sample-shop', hostId: 'local' }, 7),
    role: 'implementer',
    agents: DEFAULT_AGENTS,
    language: 'en',
    workspaceId: 'workspace-issue-7',
    taskText: () => '# Task\n',
  })
  assert.ok(result.ok, JSON.stringify(result))
  const { launch } = result
  assert.equal(await started.agents.state(launch), null)
  const event = (terminalId: string, state: 'working' | 'blocked' | 'done', since?: number) => ({
    workspaceId: 'workspace-issue-7',
    paneKey: `pane-${terminalId}`,
    terminalId,
    state,
    receivedAt: orca.clock.now(),
    ...(since === undefined ? {} : { mainAgent: { state, stateStartedAt: since } }),
  })

  // Another terminal's agent: nothing changes for this one.
  await worker.emit('agent.status.changed', event('terminal-of-someone-else', 'working', orca.clock.now()))
  assert.equal(await started.agents.state(launch), null)
  // Its own terminal: the state Orca tells, since when the main agent's state began.
  orca.clock.advance(1_000)
  await worker.emit('agent.status.changed', event(launch.terminalId, 'working', orca.clock.now()))
  assert.deepEqual(await started.agents.state(launch), { state: 'working', since: orca.clock.now() })
  const startMark = dataPath(orca.machine, launch.dir, 'started-0')
  assert.equal(orca.machine.files.get(startMark), `${orca.clock.now()}\n`)
  // Without the main agent's state Orca does not say when the state began.
  orca.clock.advance(1_000)
  await worker.emit('agent.status.changed', event(launch.terminalId, 'blocked'))
  assert.deepEqual(await started.agents.state(launch), { state: 'blocked', since: null })
  await worker.emit('agent.status.changed', event('terminal-of-someone-else', 'done', orca.clock.now()))
  assert.deepEqual(await started.agents.state(launch), { state: 'blocked', since: null })
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('id координатора: проигравший одновременный запуск берёт id победителя; файл без id не заменяется', async () => {
  const machine = fakeMachine({ platform: 'linux' })
  const dataDir = dataDirectory(machine)
  const file = dataPath(machine, dataDir, COORDINATOR_ID_FILE)
  const winner = '0f6c1e8a-3b2d-4c5e-9f7a-1b2c3d4e5f60'
  // Another worker creates the file between this one's read and its create.
  const racing = {
    ...machine,
    createText: async (path: string) => {
      machine.files.set(path, `${winner}\n`)
      return false
    },
  }
  assert.equal(await ensureCoordinatorId(racing, dataDir), winner)

  const damaged = fakeMachine({ platform: 'linux', files: { [file]: 'not an id\n' } })
  const logs: string[] = []
  const context = await startWorker({ log: (line) => logs.push(line) }, damaged)
  assert.equal(context.coordinatorId, null)
  assert.deepEqual(logs, [`agent-queue: worker started without a coordinator id: ${file} holds no coordinator id; it is kept as it is`])
  assert.equal(damaged.files.get(file), 'not an id\n')
})

test('каталог данных недоступен → воркер всё равно стартует и пишет причину в журнал', async () => {
  const machine = fakeMachine({ platform: 'darwin', createError: new Error('EACCES: permission denied') })
  const worker = await mountWorker({ default: (orca) => startWorker(orca, machine) })
  assert.deepEqual(worker.logs, ['agent-queue: worker started without a coordinator id: EACCES: permission denied'])
  await worker.deactivate()
})
