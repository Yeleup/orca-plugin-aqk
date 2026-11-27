// Typing a line into an Orca terminal through Orca's CLI (src/platform/orca-terminal.ts), on a fake computer whose CLI
// answers as Orca 1.4.274's `terminal send --json` does: which run of the CLI, and what each answer means — accepted
// (with or without the start of a turn), not sent, or unknown. Invented handles and request ids only.
import { assert, test } from 'orca/testing'
import { fakeMachine, orcaStatusAnswer, type FakeAnswer } from '../testing/fake-machine'
import type { StartRequest } from './machine'
import { orcaCliTerminalInput, TERMINAL_SEND_TIMEOUT_MS, WAIT_SUBMIT_SECONDS } from './orca-terminal'

const CLI = '/home/avery/.local/bin/orca-ide'
const REQUEST = '6f1c2a4e-8b3d-4c5e-9a7b-1c2d3e4f5a6b'

// The caller's check right before `terminal send`: the send may go.
const go = () => null

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
      },
    }),
  }
}

// Orca's refusal with its code, and Orca's own data.
function refusal(code: string, message: string, data?: Record<string, unknown>): FakeAnswer {
  return { code: 1, stdout: JSON.stringify({ id: 'cli-1', ok: false, error: { code, message, ...(data ? { data } : {}) } }) }
}

async function sendWith(answer: FakeAnswer) {
  return orcaCliTerminalInput(machineWith(() => answer)).send('term_1', 'x', REQUEST, go)
}

test('CLI Orca вводит строку в терминал по handle как запрос плагина с id и ждёт начала хода: квитанция с turn_started — ход начат, без него — ещё нет, accepted false — терминал не принял с причиной Orca', async () => {
  const started = machineWith(() => receipt(['input_accepted', 'turn_started']))
  assert.deepEqual(await orcaCliTerminalInput(started).send('term_1', 'Прочитайте файл `/data/message-1.md`.', REQUEST, go), {
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
  await input.send('term_1', 'a', REQUEST, go)
  await input.send('term_1', 'b', REQUEST, go)
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
    assert.deepEqual(await orcaCliTerminalInput(machine).send('term_1', 'x', REQUEST, go), {
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
  const missing = await orcaCliTerminalInput(none).send('term_1', 'x', REQUEST, go)
  assert.ok(!missing.ok && missing.delivery === 'not-sent' && missing.error.startsWith("Orca's CLI is not found: "), JSON.stringify(missing))
  assert.ok(!missing.ok && missing.error.includes(`${CLI}: no such file`), JSON.stringify(missing))
  assert.deepEqual(none.starts, [])
  // Looked for by itself, before anything of a send: the same reason, nothing run; once found, it stays found.
  const search = await orcaCliTerminalInput(none).find()
  assert.ok(!search.found && search.reason.startsWith("Orca's CLI is not found: ") && search.reason.includes(`${CLI}: no such file`), JSON.stringify(search))
  const found = machineWith(() => receipt(['input_accepted']))
  const prepared = orcaCliTerminalInput(found)
  assert.equal((await prepared.find()).found, true)
  assert.equal((await prepared.find()).found, true)
  assert.ok((await prepared.send('term_1', 'x', REQUEST, go)).ok)
  assert.deepEqual(found.starts.map((start) => start.args.slice(0, 2).join(' ')), ['status --json', 'terminal send'])

  // The CLI found, then gone or not startable when it is to send: not sent, and it is looked for again next time.
  let present = true
  const base = machineWith(() => receipt(['input_accepted']))
  const flaky = { ...base, isRunnableFile: (path: string) => present && base.isRunnableFile(path) }
  const input = orcaCliTerminalInput(flaky)
  assert.ok((await input.send('term_1', 'a', REQUEST, go)).ok)
  present = false
  assert.deepEqual(await input.send('term_1', 'b', REQUEST, go), { ok: false, delivery: 'not-sent', error: `orca terminal send: ${CLI}: no such program` })
  present = true
  assert.ok((await input.send('term_1', 'c', REQUEST, go)).ok)
  assert.equal(base.starts.filter((start) => start.args[0] === 'status').length, 2)
  const denied = machineWith(() => ({ startError: { code: 'EACCES', message: 'spawn EACCES' } }))
  assert.deepEqual(await orcaCliTerminalInput(denied).send('term_1', 'x', REQUEST, go), {
    ok: false,
    delivery: 'not-sent',
    error: `orca terminal send: ${CLI}: spawn EACCES`,
  })
})

test('CLI Orca: CLI, найденный поиском, закреплён за вызывающим — его отправка сразу запускает этот самый файл, без нового поиска и status, и тогда, когда другая отправка не смогла запустить CLI и сбросила найденный; следующий поиск ищет заново', async () => {
  let present = true
  const base = machineWith(() => receipt(['input_accepted']))
  const flaky = { ...base, isRunnableFile: (path: string) => present && base.isRunnableFile(path) }
  const input = orcaCliTerminalInput(flaky)
  const pinned = await input.find()
  assert.ok(pinned.found)
  assert.deepEqual(base.starts.map((start) => start.args.slice(0, 2).join(' ')), ['status --json'])
  // Another send finds the CLI gone when it is to run it: not sent, and the CLI it found is forgotten.
  present = false
  assert.deepEqual(await input.send('term_2', 'b', REQUEST, go), { ok: false, delivery: 'not-sent', error: `orca terminal send: ${CLI}: no such program` })
  present = true
  // The pinned CLI runs at once, by itself: one run of `terminal send` with that very file, no `status`.
  const before = base.starts.length
  assert.deepEqual(await pinned.send('term_1', 'a', REQUEST), { ok: true, accepted: true, refusedReason: null, turnStarted: false })
  assert.deepEqual(base.starts.slice(before).map((start) => [start.file, ...start.args.slice(0, 4)]), [[CLI, 'terminal', 'send', '--terminal', 'term_1']])
  // The next search looks for the CLI again.
  assert.ok((await input.find()).found)
  assert.deepEqual(base.starts.slice(before).map((start) => start.args.slice(0, 2).join(' ')), ['terminal send', 'status --json'])
})

test('CLI Orca: проверка вызывающего — после поиска CLI и его status, прямо перед terminal send: отказ — terminal send не запускается, строка не отправлена с причиной проверки', async () => {
  const machine = machineWith(() => receipt(['input_accepted', 'turn_started']))
  const order: string[] = []
  const recorded = { ...machine, start: (request: StartRequest) => (order.push(request.args.slice(0, 2).join(' ')), machine.start(request)) }
  const input = orcaCliTerminalInput(recorded)
  const refuse = () => {
    order.push('check')
    return 'the plugin has closed the terminal'
  }
  assert.deepEqual(await input.send('term_1', 'x', REQUEST, refuse), { ok: false, delivery: 'not-sent', error: 'the plugin has closed the terminal' })
  assert.deepEqual(order, ['status --json', 'check'])
  // The same input once the check lets it go: the CLI found before, then the check, then the one run.
  const pass = () => {
    order.push('check')
    return null
  }
  assert.ok((await input.send('term_1', 'x', REQUEST, pass)).ok)
  assert.deepEqual(order, ['status --json', 'check', 'check', 'terminal send'])
})

test('CLI Orca: runtime_unavailable, deliveryOutcome unknown при любом коде и в любом ответе, другой отказ, ответ не в форме отказа Orca (без логического ok, код без сообщения, выход 0, успех с ошибкой, отказ с квитанцией), ответ без JSON, таймаут и ответ без логического accepted — исход неизвестен', async () => {
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
  // Orca itself calls the outcome unknown: unknown whatever the code, a refusal of the line itself included — and also
  // in an answer that otherwise reads as the terminal's no.
  for (const code of ['terminal_handle_stale', 'incompatible_runtime', 'runtime_error']) {
    assert.equal(
      await unknown(refusal(code, 'Orca cannot prove whether the prompt was delivered', { deliveryOutcome: 'unknown' })),
      `orca terminal send: ${code}: Orca cannot prove whether the prompt was delivered (exit 1)`,
    )
  }
  const contradictory = JSON.stringify({
    ok: true,
    result: { send: { handle: 'term_1', accepted: false, refusedReason: 'the terminal is read-only' } },
    error: { code: 'runtime_error', message: 'Orca cannot prove whether the prompt was delivered', data: { deliveryOutcome: 'unknown' } },
  })
  assert.equal(await unknown({ code: 1, stdout: contradictory }), 'orca terminal send: runtime_error: Orca cannot prove whether the prompt was delivered (exit 1)')
  // A refusal of the line itself proves nothing outside the form of Orca's refusal: no boolean `ok`, a code without
  // its message, a failed answer with exit 0, a success that carries an error.
  const malformed: FakeAnswer[] = [
    { code: 1, stdout: JSON.stringify({ error: { code: 'invalid_argument', message: '--text is empty' } }) },
    { code: 1, stdout: JSON.stringify({ ok: 'false', error: { code: 'invalid_argument', message: '--text is empty' } }) },
    { code: 1, stdout: JSON.stringify({ ok: false, error: { code: 'terminal_handle_stale' } }) },
    { code: 0, stdout: JSON.stringify({ ok: false, error: { code: 'agent_prompt_blocked', message: 'the agent shows a permission prompt' } }) },
    { code: 1, stdout: JSON.stringify({ ok: false, error: 'incompatible_runtime' }) },
    {
      code: 0,
      stdout: JSON.stringify({ ok: true, result: { send: { accepted: false } }, error: { code: 'invalid_argument', message: '--text is empty' } }),
    },
  ]
  for (const answer of malformed) await unknown(answer)
  // A refusal of the line itself that carries a receipt of the terminal too: receipt and refusal exclude each other —
  // neither proves anything.
  for (const accepted of [true, false]) {
    await unknown({
      code: 1,
      stdout: JSON.stringify({
        ok: false,
        error: { code: 'terminal_handle_stale', message: 'terminal_handle_stale term_1' },
        result: { send: { handle: 'term_1', accepted, prompt: { requestId: REQUEST, stages: ['input_accepted'] } } },
      }),
    })
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
