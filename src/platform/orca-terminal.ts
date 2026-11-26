// Typing a line into an Orca terminal by its handle through Orca's CLI (`terminal send`). Every message of the plugin
// to an agent goes this one way, whether the agent's worktree is in the background or the active one (decision «🤖
// Решение по #10: вопрос», variant A): the host API's `terminal.sendText` of Orca 1.4.274 types only into a terminal
// of the active worktree and does not tell whether the agent started a turn, so the plugin never calls it, and never
// moves the focus of Orca's window for a message. The CLI's `terminal send` reaches any live terminal by the handle
// Orca's runtime issued — the very id `agent.launch` returns — and, for an agent, reports whether the text started a
// turn. Since it reaches any terminal, the agents layer types only into the terminals of the agents it launched
// (src/agents/agents.ts). The CLI is the one the plugin finds by Ф14 (src/platform/orca-cli.ts); without it nothing is
// typed and the result says why.
//
// `orca terminal send --terminal <handle> --text <line> --enter --retry-request <id> --wait-submit <s> --json` answers
// `{ ok: true, result: { send: { handle, accepted, refusedReason?, prompt?: { requestId, stages, … } }, mutation: {
// requestId, replayed } } }` — the stages are `input_accepted`, then `turn_started` once Orca saw the agent start a turn
// — or `{ ok: false, error: { code, message, data? } }` with exit 1. The request id is the plugin's own UUID: the same
// command with the same id again replays the first one's outcome instead of typing the line twice (`replayed: true`),
// or types the line then if Orca never saw the request, so a send whose answer was lost is asked about again safely.
// Every call is one run of the CLI, always with the request id: there is no send without it. An Orca that cannot honor
// --retry-request or --wait-submit refuses before typing anything (`incompatible_runtime`): the line is not sent, and
// on such an Orca the plugin's messages do not reach agents.
//
// Not sent — proven that the line of the request was not typed: the CLI is not found or did not start, or Orca refused
// the line itself (`terminal_handle_stale`, `invalid_argument`, `agent_prompt_blocked`, `incompatible_runtime`).
// Unknown — anything else: no JSON, a timeout, `runtime_unavailable` (Orca's CLI answers it both before the request
// leaves and after the connection closed behind it), any other refusal, every answer in which Orca itself calls the
// outcome unknown (`error.data.deliveryOutcome: "unknown"`), and an answer without the terminal's receipt (no
// `result.send.accepted` true or false).
import type { Machine } from './machine'
import { findOrcaCli } from './orca-cli'
import { runProgram, type RunResult } from './run'

// How long `terminal send` waits to see the line start a turn.
export const WAIT_SUBMIT_SECONDS = 30

// Orca's refusals of the line itself, after which nothing was typed: the terminal is gone, the request is wrong, the
// agent shows a permission or trust prompt that only a person answers, or the host cannot honor the request id.
const NOT_SENT_CODES = new Set(['terminal_handle_stale', 'invalid_argument', 'agent_prompt_blocked', 'incompatible_runtime'])

export type TerminalSendResult =
  | {
      readonly ok: true
      // Whether the terminal took the line; when not, Orca's reason.
      readonly accepted: boolean
      readonly refusedReason: string | null
      // Whether Orca saw the agent start a turn on the line within the wait.
      readonly turnStarted: boolean
      // Whether Orca replayed the outcome of a request it had seen before (`mutation.replayed`): the line was typed by
      // an earlier run with this request id, not by this one.
      readonly replayed: boolean
    }
  // `not-sent`: proven that nothing was typed (no CLI, Orca refused the line). `unknown`: the line may have been typed —
  // the answer was lost, or Orca failed or could not be reached; the same request id asks about it again.
  | { readonly ok: false; readonly delivery: 'not-sent' | 'unknown'; readonly error: string }

// Types `line` and Enter into the terminal `terminalId` as the request `requestId` (a UUID).
export type TerminalInput = (terminalId: string, line: string, requestId: string) => Promise<TerminalSendResult>

// The terminal input of this computer's Orca CLI, found once (src/platform/orca-cli.ts) and kept while it runs.
export function orcaCliTerminalInput(machine: Machine): TerminalInput {
  let cli: string | null = null
  return async (terminalId, line, requestId) => {
    if (cli === null) {
      const search = await findOrcaCli(machine)
      if (!search.found) return { ok: false, delivery: 'not-sent', error: `Orca's CLI is not found: ${search.reason}` }
      cli = search.file
    }
    const answer = parseSend(
      await runProgram(
        machine,
        cli,
        ['terminal', 'send', '--terminal', terminalId, '--text', line, '--enter', '--retry-request', requestId, '--wait-submit', String(WAIT_SUBMIT_SECONDS), '--json'],
        { timeoutMs: (WAIT_SUBMIT_SECONDS + 60) * 1000 },
      ),
    )
    if (answer.ok) return { ok: true, accepted: answer.accepted, refusedReason: answer.refusedReason, turnStarted: answer.turnStarted, replayed: answer.replayed }
    // A CLI that could not be started is looked for again next time.
    if (answer.code === null && answer.delivery === 'not-sent') cli = null
    return { ok: false, delivery: answer.delivery, error: answer.error }
  }
}

// The CLI's answer; `code` is Orca's error code, null when the CLI itself failed.
type Parsed =
  | {
      readonly ok: true
      readonly accepted: boolean
      readonly refusedReason: string | null
      readonly turnStarted: boolean
      readonly replayed: boolean
    }
  | { readonly ok: false; readonly delivery: 'not-sent' | 'unknown'; readonly error: string; readonly code: string | null }

function parseSend(result: RunResult): Parsed {
  if (result.error !== null) {
    // Not started: nothing typed. Stopped after the wait: it may have typed.
    const delivery = result.error.kind === 'not_found' || result.error.kind === 'start_failed' ? 'not-sent' : 'unknown'
    return { ok: false, delivery, error: `orca terminal send: ${result.error.reason}`, code: null }
  }
  let answer: unknown
  try {
    answer = JSON.parse(result.stdout)
  } catch {
    const said = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/)[0] ?? ''
    return {
      ok: false,
      delivery: 'unknown',
      error: `orca terminal send answered no JSON (exit ${result.code})${said ? `: ${said}` : ''}`,
      code: null,
    }
  }
  const field = (value: unknown, key: string): unknown =>
    typeof value === 'object' && value !== null && key in value ? (value as Record<string, unknown>)[key] : undefined
  if (field(answer, 'ok') !== true) {
    const code = field(field(answer, 'error'), 'code')
    const message = field(field(answer, 'error'), 'message')
    const known = typeof code === 'string' ? code : 'unknown'
    const orcaUnknown = field(field(field(answer, 'error'), 'data'), 'deliveryOutcome') === 'unknown'
    return {
      ok: false,
      delivery: NOT_SENT_CODES.has(known) && !orcaUnknown ? 'not-sent' : 'unknown',
      error: `orca terminal send: ${typeof message === 'string' ? message : 'not ok'} (exit ${result.code})`,
      code: known,
    }
  }
  const send = field(field(answer, 'result'), 'send')
  const accepted = field(send, 'accepted')
  // Only Orca's explicit receipt decides: without a yes or no of the terminal the outcome is not known.
  if (typeof accepted !== 'boolean') {
    return { ok: false, delivery: 'unknown', error: `orca terminal send answered without the terminal's receipt (exit ${result.code})`, code: null }
  }
  const reason = field(send, 'refusedReason')
  const stages = field(field(send, 'prompt'), 'stages')
  return {
    ok: true,
    accepted,
    refusedReason: accepted ? null : typeof reason === 'string' ? reason : 'no reason given',
    turnStarted: Array.isArray(stages) && stages.includes('turn_started'),
    replayed: field(field(field(answer, 'result'), 'mutation'), 'replayed') === true,
  }
}
