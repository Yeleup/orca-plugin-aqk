// Typing a line into an Orca terminal through Orca's CLI (src/platform/orca-terminal.ts), on a fake computer whose CLI
// answers as Orca 1.4.274's `terminal send --json` does: which run of the CLI, and what each answer means — accepted
// (with or without the start of a turn), not sent, or unknown. Invented handles and request ids only.
import { assert, test } from 'orca/testing'
import { fakeMachine, orcaStatusAnswer, type FakeAnswer } from '../testing/fake-machine'
import type { StartRequest } from './machine'
import { orcaCliTerminalInput, TERMINAL_SEND_TIMEOUT_MS, WAIT_SUBMIT_SECONDS } from './orca-terminal'

const CLI = '/home/avery/.local/bin/orca-ide'
const REQUEST = '6f1c2a4e-8b3d-4c5e-9a7b-1c2d3e4f5a6b'

// A computer whose Orca CLI answers `status` as a running Orca and `terminal send` as the test says.
function machineWith(send: (request: StartRequest) => FakeAnswer, executables: string[] = [CLI]) {
  return fakeMachine({
    platform: 'linux',
    executables,
    answer: (request) => (request.args[0] === 'status' ? orcaStatusAnswer('1.4.274') : send(request)),
  })
}

// Orca's receipt of the line: accepted or not, with the stages Orca saw.
function receipt(stages: string[], accepted = true, refusedReason?: string): FakeAnswer {
  return {
    code: 0,
    stdout: JSON.stringify({
      id: 'cli-1',
      ok: true,
      result: {
        send: { handle: 'term_1', accepted, ...(refusedReason ? { refusedReason } : {}), prompt: { requestId: REQUEST, stages } },
        mutation: { requestId: REQUEST, replayed: false },
      },
    }),
  }
}

// Orca's refusal with its code, and Orca's own data.
function refusal(code: string, message: string, data?: Record<string, unknown>): FakeAnswer {
  return { code: 1, stdout: JSON.stringify({ id: 'cli-1', ok: false, error: { code, message, ...(data ? { data } : {}) } }) }
}

async function sendWith(answer: FakeAnswer) {
  return orcaCliTerminalInput(machineWith(() => answer))('term_1', 'x', REQUEST)
}

test('CLI Orca вводит строку в терминал по handle как запрос плагина с id и ждёт начала хода: квитанция с turn_started — ход начат, без него — ещё нет, accepted false — терминал не принял с причиной Orca', async () => {
  const started = machineWith(() => receipt(['input_accepted', 'turn_started']))
  assert.deepEqual(await orcaCliTerminalInput(started)('term_1', 'Прочитайте файл `/data/message-1.md`.', REQUEST), {
    ok: true,
    accepted: true,
    refusedReason: null,
    turnStarted: true,
  })
  // The CLI found by Ф14 (its `status` first), then one run of `terminal send` with the request id and the wait.
  assert.deepEqual(started.starts.map((start) => [start.file, ...start.args]), [
    [CLI, 'status', '--json'],
    [
      CLI,
      'terminal',
      'send',
      '--terminal',
      'term_1',
      '--text',
      'Прочитайте файл `/data/message-1.md`.',
      '--enter',
      '--retry-request',
      REQUEST,
      '--wait-submit',
      String(WAIT_SUBMIT_SECONDS),
      '--json',
    ],
  ])
  assert.equal(WAIT_SUBMIT_SECONDS, 30)
  assert.equal(started.starts[1]?.timeoutMs, TERMINAL_SEND_TIMEOUT_MS)
  // The CLI found once serves the next sends of the same input: one search, one run per send.
  const input = orcaCliTerminalInput(started)
  await input('term_1', 'a', REQUEST)
  await input('term_1', 'b', REQUEST)
  assert.deepEqual(started.starts.slice(2).map((start) => start.args.slice(0, 2).join(' ')), ['status --json', 'terminal send', 'terminal send'])

  assert.deepEqual(await sendWith(receipt(['input_accepted'])), { ok: true, accepted: true, refusedReason: null, turnStarted: false })
  assert.deepEqual(await sendWith(receipt(['input_accepted', 'turn_started'], false, 'the terminal is read-only')), {
    ok: true,
    accepted: false,
    refusedReason: 'the terminal is read-only',
    turnStarted: false,
  })
  assert.deepEqual(await sendWith(receipt([], false)), { ok: true, accepted: false, refusedReason: 'Orca gave no reason', turnStarted: false })
})

test('CLI Orca: отказ Orca в самой строке (incompatible_runtime, terminal_handle_stale, agent_prompt_blocked, invalid_argument) — не отправлено, ровно один запуск terminal send и с id запроса; CLI не найден или не запустился — не отправлено', async () => {
  const codes = ['incompatible_runtime', 'terminal_handle_stale', 'agent_prompt_blocked', 'invalid_argument']
  for (const code of codes) {
    const machine = machineWith(() => refusal(code, `Orca refused: ${code}. This attempt sent no input.`))
    assert.deepEqual(await orcaCliTerminalInput(machine)('term_1', 'x', REQUEST), {
      ok: false,
      delivery: 'not-sent',
      error: `orca terminal send: ${code}: Orca refused: ${code}. This attempt sent no input. (exit 1)`,
    })
    const sends = machine.starts.filter((start) => start.args[0] === 'terminal')
    assert.equal(sends.length, 1, code)
    assert.equal(sends[0]?.args[sends[0].args.indexOf('--retry-request') + 1], REQUEST, code)
  }

  // No CLI on the computer: nothing runs, the reason names where it was looked for.
  const none = machineWith(() => receipt(['input_accepted']), [])
  const missing = await orcaCliTerminalInput(none)('term_1', 'x', REQUEST)
  assert.ok(!missing.ok && missing.delivery === 'not-sent' && missing.error.startsWith("Orca's CLI is not found: "), JSON.stringify(missing))
  assert.ok(!missing.ok && missing.error.includes(`${CLI}: no such file`), JSON.stringify(missing))
  assert.deepEqual(none.starts, [])

  // The CLI found, then gone or not startable when it is to send: not sent, and it is looked for again next time.
  let present = true
  const base = machineWith(() => receipt(['input_accepted']))
  const flaky = { ...base, isRunnableFile: (path: string) => present && base.isRunnableFile(path) }
  const input = orcaCliTerminalInput(flaky)
  assert.ok((await input('term_1', 'a', REQUEST)).ok)
  present = false
  assert.deepEqual(await input('term_1', 'b', REQUEST), { ok: false, delivery: 'not-sent', error: `orca terminal send: ${CLI}: no such program` })
  present = true
  assert.ok((await input('term_1', 'c', REQUEST)).ok)
  assert.equal(base.starts.filter((start) => start.args[0] === 'status').length, 2)
  const denied = machineWith(() => ({ startError: { code: 'EACCES', message: 'spawn EACCES' } }))
  assert.deepEqual(await orcaCliTerminalInput(denied)('term_1', 'x', REQUEST), {
    ok: false,
    delivery: 'not-sent',
    error: `orca terminal send: ${CLI}: spawn EACCES`,
  })
})

test('CLI Orca: runtime_unavailable, deliveryOutcome unknown при любом коде, другой отказ, ответ без JSON, таймаут и ответ без логического accepted — исход неизвестен', async () => {
  const unknown = async (answer: FakeAnswer) => {
    const result = await sendWith(answer)
    assert.ok(!result.ok && result.delivery === 'unknown', JSON.stringify(result))
    return result.error
  }
  // Orca's CLI answers runtime_unavailable both before the request leaves and after the connection closed behind it.
  assert.equal(
    await unknown(refusal('runtime_unavailable', 'Orca closed the connection before responding')),
    'orca terminal send: runtime_unavailable: Orca closed the connection before responding (exit 1)',
  )
  // Orca itself calls the outcome unknown: unknown whatever the code, a refusal of the line itself included.
  for (const code of ['terminal_handle_stale', 'incompatible_runtime', 'runtime_error']) {
    await unknown(refusal(code, 'Orca cannot prove whether the prompt was delivered', { deliveryOutcome: 'unknown' }))
  }
  assert.equal(await unknown(refusal('runtime_error', 'the connection to Orca dropped')), 'orca terminal send: runtime_error: the connection to Orca dropped (exit 1)')
  assert.equal(await unknown({ code: 1, stdout: JSON.stringify({ ok: false }) }), 'orca terminal send: not ok (exit 1)')
  assert.equal(await unknown({ code: 2, stderr: 'segmentation fault\n' }), 'orca terminal send answered no JSON (exit 2): segmentation fault')
  assert.equal(await unknown({ code: 0, stdout: '' }), 'orca terminal send answered no JSON (exit 0)')
  // Stopped at its timeout: it may have typed.
  const timedOut = await unknown({ timedOut: true, signal: 'SIGKILL' })
  assert.ok(timedOut.startsWith(`orca terminal send: stopped after ${TERMINAL_SEND_TIMEOUT_MS} ms without an answer`), timedOut)
  // An answer without the terminal's yes or no.
  for (const result of [{}, { send: {} }, { send: { accepted: 'yes' } }, { send: { accepted: null } }, { send: [true] }]) {
    assert.equal(
      await unknown({ code: 0, stdout: JSON.stringify({ ok: true, result }) }),
      "orca terminal send answered without the terminal's receipt (exit 0)",
      JSON.stringify(result),
    )
  }
})
