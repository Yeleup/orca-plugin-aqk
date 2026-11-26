// Typing a line into an Orca terminal through Orca's CLI (src/platform/orca-terminal.ts), on a fake computer whose CLI
// answers as Orca 1.4.274's `terminal send --json` does. Invented handles and request ids only.
import { assert, test } from 'orca/testing'
import { fakeMachine, orcaStatusAnswer, type FakeAnswer } from '../testing/fake-machine'
import type { StartRequest } from './machine'
import { orcaCliTerminalInput, WAIT_SUBMIT_SECONDS } from './orca-terminal'

const CLI = '/home/avery/.local/bin/orca-ide'
const REQUEST = '6f1c2a4e-8b3d-4c5e-9a7b-1c2d3e4f5a6b'

function machineWith(send: (request: StartRequest) => FakeAnswer, executables: string[] = [CLI]) {
  return fakeMachine({
    platform: 'linux',
    executables,
    answer: (request) => (request.args[0] === 'status' ? orcaStatusAnswer('1.4.274') : send(request)),
  })
}

function receipt(stages: string[], accepted = true, refusedReason?: string): FakeAnswer {
  return {
    code: accepted ? 0 : 1,
    stdout: JSON.stringify({
      id: 'cli-1',
      ok: true,
      result: { send: { handle: 'term_1', accepted, ...(refusedReason ? { refusedReason } : {}), prompt: { requestId: REQUEST, stages } } },
    }),
  }
}

function refusal(code: string, message: string): FakeAnswer {
  return { code: 1, stdout: JSON.stringify({ ok: false, error: { code, message } }) }
}

test('CLI Orca вводит строку в терминал по его handle как запрос плагина и ждёт начала хода: turn_started — ход начат, только input_accepted — ещё нет', async () => {
  const started = machineWith(() => receipt(['input_accepted', 'turn_started']))
  assert.deepEqual(await orcaCliTerminalInput(started)('term_1', 'Прочитайте файл.', REQUEST), {
    ok: true,
    accepted: true,
    refusedReason: null,
    turnStarted: true,
  })
  assert.deepEqual(started.starts.map((start) => [start.file, ...start.args]), [
    [CLI, 'status', '--json'],
    [
      CLI,
      'terminal',
      'send',
      '--terminal',
      'term_1',
      '--text',
      'Прочитайте файл.',
      '--enter',
      '--retry-request',
      REQUEST,
      '--wait-submit',
      String(WAIT_SUBMIT_SECONDS),
      '--json',
    ],
  ])
  // The CLI found once serves the next sends of the same input.
  const input = orcaCliTerminalInput(started)
  await input('term_1', 'a', REQUEST)
  await input('term_1', 'b', REQUEST)
  assert.equal(started.starts.filter((start) => start.args[0] === 'status').length, 2)

  const queued = machineWith(() => receipt(['input_accepted']))
  assert.deepEqual(await orcaCliTerminalInput(queued)('term_1', 'x', REQUEST), { ok: true, accepted: true, refusedReason: null, turnStarted: false })
  const refused = machineWith(() => receipt(['input_accepted'], false, 'the terminal is read-only'))
  assert.deepEqual(await orcaCliTerminalInput(refused)('term_1', 'x', REQUEST), {
    ok: true,
    accepted: false,
    refusedReason: 'the terminal is read-only',
    turnStarted: false,
  })
})

test('CLI Orca: без --retry-request и --wait-submit у Orca — та же строка без них; отказ, после которого ничего не введено, — not-sent; потерянный ответ — unknown', async () => {
  const old = machineWith((request) =>
    request.args.includes('--retry-request')
      ? refusal('incompatible_runtime', 'This Orca host cannot honor --retry-request and never recorded this request ID. This attempt sent no input.')
      : receipt(['input_accepted']),
  )
  assert.deepEqual(await orcaCliTerminalInput(old)('term_1', 'x', REQUEST), { ok: true, accepted: true, refusedReason: null, turnStarted: false })
  assert.deepEqual(
    old.starts.filter((start) => start.args[0] === 'terminal').map((start) => start.args.includes('--retry-request')),
    [true, false],
  )

  const stale = machineWith(() => refusal('terminal_handle_stale', 'terminal_handle_stale term_9'))
  assert.deepEqual(await orcaCliTerminalInput(stale)('term_9', 'x', REQUEST), {
    ok: false,
    delivery: 'not-sent',
    error: 'orca terminal send: terminal_handle_stale term_9 (exit 1)',
  })
  const failed = machineWith(() => refusal('runtime_error', 'the connection to Orca dropped'))
  assert.deepEqual(await orcaCliTerminalInput(failed)('term_1', 'x', REQUEST), {
    ok: false,
    delivery: 'unknown',
    error: 'orca terminal send: the connection to Orca dropped (exit 1)',
  })
  const garbled = machineWith(() => ({ code: 2, stderr: 'segmentation fault\n' }))
  assert.deepEqual(await orcaCliTerminalInput(garbled)('term_1', 'x', REQUEST), {
    ok: false,
    delivery: 'unknown',
    error: 'orca terminal send answered no JSON (exit 2): segmentation fault',
  })
  const lost = machineWith(() => ({ timedOut: true, signal: 'SIGKILL' }))
  const timedOut = await orcaCliTerminalInput(lost)('term_1', 'x', REQUEST)
  assert.ok(!timedOut.ok && timedOut.delivery === 'unknown' && /stopped after \d+ ms without an answer/.test(timedOut.error), JSON.stringify(timedOut))

  const none = machineWith(() => receipt(['input_accepted']), [])
  const missing = await orcaCliTerminalInput(none)('term_1', 'x', REQUEST)
  assert.ok(!missing.ok && missing.delivery === 'not-sent' && missing.error.startsWith("Orca's CLI is not found: "), JSON.stringify(missing))
  assert.deepEqual(none.starts, [])
})
