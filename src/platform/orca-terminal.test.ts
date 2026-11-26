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
    replayed: false,
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
  assert.deepEqual(await orcaCliTerminalInput(queued)('term_1', 'x', REQUEST), { ok: true, accepted: true, refusedReason: null, turnStarted: false, replayed: false })
  const refused = machineWith(() => receipt(['input_accepted'], false, 'the terminal is read-only'))
  assert.deepEqual(await orcaCliTerminalInput(refused)('term_1', 'x', REQUEST), {
    ok: true,
    accepted: false,
    refusedReason: 'the terminal is read-only',
    turnStarted: false,
    replayed: false,
  })
})

test('CLI Orca: Orca без --retry-request и --wait-submit отказывает — строка не отправлена, с текстом Orca, ровно один запуск CLI и с --retry-request; прочие отказы, потерянный ответ, нет CLI', async () => {
  const incompatible = 'This Orca host cannot honor --retry-request and never recorded this request ID. This attempt sent no input.'
  const old = machineWith(() => refusal('incompatible_runtime', incompatible))
  assert.deepEqual(await orcaCliTerminalInput(old)('term_1', 'x', REQUEST), {
    ok: false,
    delivery: 'not-sent',
    error: `orca terminal send: ${incompatible} (exit 1)`,
  })
  const sends = old.starts.filter((start) => start.args[0] === 'terminal')
  assert.equal(sends.length, 1)
  assert.ok(sends[0]?.args.includes('--retry-request') && sends[0].args[sends[0].args.indexOf('--retry-request') + 1] === REQUEST)

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

test('CLI Orca: отказ в самой строке — не отправлено; Orca недоступна или сама называет исход неизвестным — исход неизвестен', async () => {
  const delivery = async (answer: FakeAnswer) => {
    const result = await orcaCliTerminalInput(machineWith(() => answer))('term_1', 'x', REQUEST)
    assert.ok(!result.ok, JSON.stringify(result))
    return result.delivery
  }
  assert.equal(await delivery(refusal('incompatible_runtime', 'This Orca host does not support --wait-submit. No input was sent.')), 'not-sent')
  assert.equal(await delivery(refusal('agent_prompt_blocked', 'the agent shows a permission prompt')), 'not-sent')
  assert.equal(await delivery(refusal('terminal_handle_stale', 'terminal_handle_stale term_1')), 'not-sent')
  assert.equal(await delivery(refusal('invalid_argument', '--text is empty')), 'not-sent')
  // Orca's CLI answers runtime_unavailable both before the request leaves and after the connection closed behind it.
  assert.equal(await delivery(refusal('runtime_unavailable', 'Orca closed the connection before responding')), 'unknown')
  // Orca itself calls the outcome unknown: unknown whatever the code.
  assert.equal(
    await delivery({
      code: 1,
      stdout: JSON.stringify({
        ok: false,
        error: { code: 'terminal_handle_stale', message: 'Orca cannot prove whether the prompt was delivered', data: { deliveryOutcome: 'unknown' } },
      }),
    }),
    'unknown',
  )
})

test('CLI Orca: ответ без квитанции терминала (нет accepted да или нет) — исход неизвестен; повтор, который Orca отыграла, называет это', async () => {
  for (const result of [{}, { send: {} }, { send: { accepted: 'yes' } }, { send: { accepted: null } }]) {
    const answer = await orcaCliTerminalInput(machineWith(() => ({ code: 0, stdout: JSON.stringify({ ok: true, result }) })))('term_1', 'x', REQUEST)
    assert.deepEqual(answer, { ok: false, delivery: 'unknown', error: "orca terminal send answered without the terminal's receipt (exit 0)" }, JSON.stringify(result))
  }
  const replayed = machineWith(() => ({
    code: 0,
    stdout: JSON.stringify({
      ok: true,
      result: { send: { handle: 'term_1', accepted: true, prompt: { requestId: REQUEST, stages: ['input_accepted'] } }, mutation: { requestId: REQUEST, replayed: true } },
    }),
  }))
  assert.deepEqual(await orcaCliTerminalInput(replayed)('term_1', 'x', REQUEST), {
    ok: true,
    accepted: true,
    refusedReason: null,
    turnStarted: false,
    replayed: true,
  })
})

