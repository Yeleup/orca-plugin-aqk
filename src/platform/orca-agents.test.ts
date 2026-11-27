// The agents Orca knows on this computer come from Orca's CLI, `agent installed --json` (decision «🤖 Решение по #11:
// вопрос», variant A), on the fake computer of each system with the fake CLI of Orca (src/testing/fake-orca.ts).
import { assert, test } from 'orca/testing'
import { fakeOrca } from '../testing/fake-orca'
import { AGENTS_ARGS, orcaAgentsOutcome, readOrcaAgents } from './orca-agents'
import type { RunResult } from './run'

test('агенты Orca: список — ответ CLI agent installed --json (агент, которого нет в коде плагина, тоже), в порядке Orca, с именами Orca; на linux — orca-ide, голый orca не запускается, без --worktree', async () => {
  const orca = fakeOrca({ platform: 'linux' })
  orca.installedAgents = [
    { id: 'claude', name: 'Claude', default: true },
    { id: 'future-agent', name: 'Future Agent' },
    { id: 'codex', name: 'Codex' },
    // Without a name: its id names it. Again: counted once.
    { id: 'opencode' },
    { id: 'future-agent', name: 'Future Agent again' },
  ]
  const reading = await readOrcaAgents(orca.machine)
  assert.deepEqual(reading, {
    ok: true,
    agents: [
      { id: 'claude', name: 'Claude' },
      { id: 'future-agent', name: 'Future Agent' },
      { id: 'codex', name: 'Codex' },
      { id: 'opencode', name: 'opencode' },
    ],
  })
  const runs = orca.machine.starts.map((start) => ({ file: start.file, args: start.args }))
  assert.deepEqual(runs, [
    { file: orca.cli, args: ['status', '--json'] },
    { file: orca.cli, args: ['agent', 'installed', '--json'] },
  ])
  assert.ok(orca.cli.endsWith('/orca-ide'), orca.cli)
  for (const start of orca.machine.starts) {
    assert.notEqual(start.file, 'orca', 'голый orca на linux')
    assert.ok(!/(^|\/)orca$/.test(start.file), `запущен голый orca: ${start.file}`)
    assert.ok(!start.args.some((arg) => /^--(worktree|environment|pairing-code)$/.test(arg)), start.args.join(' '))
  }
  assert.deepEqual([...AGENTS_ARGS], ['agent', 'installed', '--json'])
})

test('агенты Orca: на macOS и Windows CLI — orca по известному пути, тот же список', async () => {
  for (const platform of ['darwin', 'win32'] as const) {
    const orca = fakeOrca({ platform })
    const reading = await readOrcaAgents(orca.machine)
    assert.deepEqual(reading, { ok: true, agents: [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' }] }, platform)
    assert.ok(/[\\/]orca(\.exe)?$/.test(orca.cli), orca.cli)
    assert.deepEqual(orca.machine.starts.at(-1)?.args, ['agent', 'installed', '--json'])
  }
})

test('агенты Orca: CLI нет на компьютере → список не прочитан, причина поиска; ничего не запущено, кроме поиска', async () => {
  const orca = fakeOrca({ platform: 'linux', cli: false })
  const reading = await readOrcaAgents(orca.machine)
  assert.equal(reading.ok, false)
  if (reading.ok) return
  assert.equal(reading.failure.kind, 'cli-not-found')
  assert.match(reading.failure.kind === 'cli-not-found' ? reading.failure.search : '', /orca-ide/)
  assert.ok(!orca.machine.starts.some((start) => start.args[0] === 'agent'), 'agent installed без CLI')
})

test('агенты Orca: CLI найден, а agent installed не дал списка (отказ Orca, не JSON, нет ответа в срок, другой вид ответа) → список не прочитан: код причины, файл CLI, ответ CLI или Orca', async () => {
  const cases: [string, (orca: ReturnType<typeof fakeOrca>) => void, string, string][] = [
    ['отказ Orca', (orca) => (orca.installedRefusal = { code: 'runtime_unavailable', message: 'Orca is not running' }), 'refused', 'runtime_unavailable: Orca is not running (exit 1)'],
    ['не JSON', (orca) => (orca.installedAnswer = { code: 0, stdout: 'Claude, Codex\n' }), 'no-json', 'exit 0: Claude, Codex'],
    ['нет ответа в срок', (orca) => (orca.installedAnswer = { timedOut: true, signal: 'SIGKILL' }), 'timed-out', 'stopped after 30000 ms without an answer'],
    ['без списка агентов', (orca) => (orca.installedAnswer = { code: 0, stdout: JSON.stringify({ ok: true, result: {} }) }), 'no-list', 'result.agents'],
    [
      'агент без id',
      (orca) => (orca.installedAnswer = { code: 0, stdout: JSON.stringify({ ok: true, result: { agents: [{ id: '', name: 'Nobody' }] } }) }),
      'no-id',
      '"Nobody"',
    ],
    ['ok: true с кодом выхода 1', (orca) => (orca.installedAnswer = { code: 1, stdout: JSON.stringify({ ok: true, result: { agents: [] } }) }), 'not-ok', 'exit 1'],
  ]
  for (const [what, steer, kind, detail] of cases) {
    const orca = fakeOrca({ platform: 'linux' })
    steer(orca)
    const reading = await readOrcaAgents(orca.machine)
    assert.equal(reading.ok, false, what)
    if (reading.ok) continue
    assert.deepEqual(reading.failure, { kind, cli: orca.cli, detail }, what)
    assert.ok(orca.cli.endsWith('/orca-ide'), `${what}: ${orca.cli}`)
  }
})

test('агенты Orca: пустой список — прочитан и пуст', () => {
  const result: RunResult = {
    command: 'orca-ide',
    file: '/usr/bin/orca-ide',
    args: [...AGENTS_ARGS],
    startedAt: '2026-01-15T09:30:00.000Z',
    durationMs: 0,
    code: 0,
    signal: null,
    stdout: JSON.stringify({ id: 'cli-1', ok: true, result: { agents: [] } }),
    stderr: '',
    truncated: false,
    error: null,
  }
  assert.deepEqual(orcaAgentsOutcome('/usr/bin/orca-ide', result), { ok: true, agents: [] })
})
