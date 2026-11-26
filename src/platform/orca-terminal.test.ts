// Typing into an Orca terminal through Orca's CLI (src/platform/orca-terminal.ts), on a fake computer whose CLI answers
// as Orca 1.4.274's `terminal send --json` does. Invented handles only.
import { assert, test } from 'orca/testing'
import { fakeMachine, orcaStatusAnswer, type FakeAnswer } from '../testing/fake-machine'
import type { StartRequest } from './machine'
import { orcaCliTerminalInput, WAIT_SUBMIT_SECONDS } from './orca-terminal'

const CLI = '/home/avery/.local/bin/orca-ide'

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
      result: { send: { handle: 'term_1', accepted, ...(refusedReason ? { refusedReason } : {}), prompt: { requestId: 'r-1', stages } } },
    }),
  }
}

test('CLI Orca печатает в терминал по его handle и ждёт начала хода: turn_started — ход начат, только input_accepted — ещё нет', async () => {
  const started = machineWith(() => receipt(['input_accepted', 'turn_started']))
  assert.deepEqual(await orcaCliTerminalInput(started)('term_1', 'Прочитайте файл.'), {
    ok: true,
    accepted: true,
    refusedReason: null,
    turnStarted: true,
  })
  assert.deepEqual(started.starts.map((start) => [start.file, ...start.args]), [
    [CLI, 'status', '--json'],
    [CLI, 'terminal', 'send', '--terminal', 'term_1', '--text', 'Прочитайте файл.', '--enter', '--wait-submit', String(WAIT_SUBMIT_SECONDS), '--json'],
  ])
  // The CLI found once serves the next sends of the same input.
  const input = orcaCliTerminalInput(started)
  await input('term_1', 'a')
  await input('term_1', 'b')
  assert.equal(started.starts.filter((start) => start.args[0] === 'status').length, 2)

  const queued = machineWith(() => receipt(['input_accepted']))
  assert.deepEqual(await orcaCliTerminalInput(queued)('term_1', 'x'), { ok: true, accepted: true, refusedReason: null, turnStarted: false })
  const refused = machineWith(() => receipt(['input_accepted'], false, 'the terminal is read-only'))
  assert.deepEqual(await orcaCliTerminalInput(refused)('term_1', 'x'), {
    ok: true,
    accepted: false,
    refusedReason: 'the terminal is read-only',
    turnStarted: false,
  })
})

test('CLI Orca без --wait-submit — тот же текст без ожидания; отказ Orca, нет CLI или ответ не JSON — ошибка с причиной', async () => {
  const old = machineWith((request) =>
    request.args.includes('--wait-submit')
      ? {
          code: 1,
          stdout: JSON.stringify({
            ok: false,
            error: { code: 'incompatible_runtime', message: 'This Orca host does not support --wait-submit. No input was sent.' },
          }),
        }
      : receipt(['input_accepted']),
  )
  assert.deepEqual(await orcaCliTerminalInput(old)('term_1', 'x'), { ok: true, accepted: true, refusedReason: null, turnStarted: false })
  assert.deepEqual(
    old.starts.filter((start) => start.args[0] === 'terminal').map((start) => start.args.includes('--wait-submit')),
    [true, false],
  )

  const stale = machineWith(() => ({
    code: 1,
    stdout: JSON.stringify({ ok: false, error: { code: 'terminal_handle_stale', message: 'terminal_handle_stale term_9' } }),
  }))
  assert.deepEqual(await orcaCliTerminalInput(stale)('term_9', 'x'), {
    ok: false,
    error: 'orca terminal send: terminal_handle_stale term_9 (exit 1)',
  })

  const garbled = machineWith(() => ({ code: 2, stderr: 'segmentation fault\n' }))
  assert.deepEqual(await orcaCliTerminalInput(garbled)('term_1', 'x'), {
    ok: false,
    error: 'orca terminal send answered no JSON (exit 2): segmentation fault',
  })

  const none = machineWith(() => receipt(['input_accepted']), [])
  const missing = await orcaCliTerminalInput(none)('term_1', 'x')
  assert.ok(!missing.ok && missing.error.startsWith("Orca's CLI is not found: "), JSON.stringify(missing))
  assert.deepEqual(none.starts, [])
})
