// Typing one line into an Orca terminal by its handle through Orca's CLI (`terminal send`). Every message of the plugin
// to an agent goes this one way, whether the agent's worktree is in the background or the active one (the autopilot's
// decision on the original task of the agents layer, variant A): the host API's `terminal.sendText` of Orca 1.4.274
// types only into a terminal of the active worktree and does not tell whether the agent started a turn, so the plugin
// never calls it, has no fallback through the API, and never moves the active worktree or the focus of Orca's window
// for a message (`terminal.focus`, `workspace.open`). The CLI's `terminal send` reaches any live terminal by the handle
// Orca's runtime issued — the very id `agent.launch` returns — and, for an agent, reports whether the line started a
// turn. Since it reaches any terminal, the agents layer types only into the terminals of the agents it launched
// (src/agents/agents.ts). The CLI is the one the plugin finds by Ф14 (src/platform/orca-cli.ts), once, and looked for
// again after it could not be started.
//
// `<cli> terminal send --terminal <handle> --text <line> --enter --retry-request <id> --wait-submit 30 --json` answers
// `{ ok: true, result: { send: { handle, accepted, refusedReason?, prompt?: { requestId, stages, … } }, … } }` — the
// stages are `input_accepted`, then `turn_started` once Orca saw the agent start a turn on the line — or `{ ok: false,
// error: { code, message, data? } }` with exit 1. Each call is one run of the CLI, always with the request id — the
// plugin's own UUID: the same request id again makes Orca repeat the first outcome instead of typing the line twice, or
// type the line then if it never saw the request, so a send whose answer was lost is asked about again safely. There is
// no send without the request id: an Orca that cannot honor it refuses before typing anything (`incompatible_runtime`),
// and on such an Orca the plugin's messages do not reach agents.
//
// The caller's own check runs once the CLI is found, right before `terminal send` starts: when it refuses, nothing runs
// and the line is not sent (the agents layer checks there that the terminal is still its own).
//
// The outcome of one run:
// - any answer in which Orca itself calls the outcome unknown (`error.data.deliveryOutcome: "unknown"`, whatever else
//   it says) — unknown, before anything else;
// - accepted — Orca's receipt, in the form of a success (`ok: true`, no error): `result.send.accepted` true (and
//   whether `turn_started` is among its stages), or false with Orca's reason: the terminal did not take the line;
// - not sent — proven that the line of this request was not typed: the CLI is not found or did not start, the
//   caller's check refused, or Orca refused the line itself in the form of Orca's refusal (`ok: false`, an `error`
//   with its code and message, a non-zero exit) with one of `terminal_handle_stale`, `invalid_argument`,
//   `agent_prompt_blocked`, `incompatible_runtime`;
// - unknown — anything else: no JSON, a timeout, `runtime_unavailable` (Orca's CLI answers it both before the request
//   leaves and after the connection closed behind it), any other refusal, an answer in neither form (no boolean `ok`,
//   a success with an error, a refusal without its code or with exit 0), a success without a true or false `accepted`.
//   When this run asked again about an earlier one, only a receipt decides: the agents layer reads every refusal of it
//   as «unknown».
import type { Machine } from './machine'
import { findOrcaCli } from './orca-cli'
import { runProgram, type RunResult } from './run'

// How long `terminal send` waits to see the line start a turn, in seconds.
export const WAIT_SUBMIT_SECONDS = 30

// How long one run of `terminal send` may take before it counts as not answering: the wait for the turn and a minute.
export const TERMINAL_SEND_TIMEOUT_MS = (WAIT_SUBMIT_SECONDS + 60) * 1000

// Orca's refusals of the line itself, after which nothing was typed: the terminal is gone, the request is wrong, the
// agent shows a permission or trust prompt only a person answers, or this Orca cannot honor the request id.
const NOT_SENT_CODES: ReadonlySet<string> = new Set([
  'terminal_handle_stale',
  'invalid_argument',
  'agent_prompt_blocked',
  'incompatible_runtime',
])

export type TerminalSendResult =
  | {
      readonly ok: true
      // Whether the terminal took the line; when not, Orca's reason.
      readonly accepted: boolean
      readonly refusedReason: string | null
      // Whether Orca saw the agent start a turn on the line within the wait (`turn_started`).
      readonly turnStarted: boolean
    }
  // `not-sent`: proven that nothing of this request was typed. `unknown`: the line may have been typed — the answer was
  // lost, or Orca failed or could not be reached; the same request id asks about it again.
  | { readonly ok: false; readonly delivery: 'not-sent' | 'unknown'; readonly error: string }

// Types `line` and Enter into the terminal `terminalId` as the request `requestId` (a UUID): one run of the CLI. `check`
// runs once the CLI is found, right before `terminal send`: a reason it returns means nothing runs and the line is not
// sent with that reason; null lets the send go.
export type TerminalInput = (
  terminalId: string,
  line: string,
  requestId: string,
  check: () => string | null,
) => Promise<TerminalSendResult>

// The terminal input of this computer's Orca CLI, found by Ф14 at the first call and kept while it starts.
export function orcaCliTerminalInput(machine: Machine): TerminalInput {
  let cli: string | null = null
  return async (terminalId, line, requestId, check) => {
    if (cli === null) {
      const search = await findOrcaCli(machine)
      if (!search.found) return { ok: false, delivery: 'not-sent', error: `Orca's CLI is not found: ${search.reason}` }
      cli = search.file
    }
    // Nothing waits between the caller's check and the start of `terminal send`.
    const refused = check()
    if (refused !== null) return { ok: false, delivery: 'not-sent', error: refused }
    const result = await runProgram(machine, cli, terminalSendArgs(terminalId, line, requestId), {
      timeoutMs: TERMINAL_SEND_TIMEOUT_MS,
    })
    // A CLI that could not be started is looked for again next time.
    if (result.error !== null && (result.error.kind === 'not_found' || result.error.kind === 'start_failed')) cli = null
    return terminalSendOutcome(result)
  }
}

// The arguments of one `terminal send`.
export function terminalSendArgs(terminalId: string, line: string, requestId: string): string[] {
  return [
    'terminal',
    'send',
    '--terminal',
    terminalId,
    '--text',
    line,
    '--enter',
    '--retry-request',
    requestId,
    '--wait-submit',
    String(WAIT_SUBMIT_SECONDS),
    '--json',
  ]
}

// The outcome of one run of `terminal send` (the rules at the top of this file).
export function terminalSendOutcome(result: RunResult): TerminalSendResult {
  if (result.error !== null) {
    // Not started: nothing typed. Stopped while waiting, or its output not kept: it may have typed.
    const notStarted = result.error.kind === 'not_found' || result.error.kind === 'start_failed'
    return { ok: false, delivery: notStarted ? 'not-sent' : 'unknown', error: `orca terminal send: ${result.error.reason}` }
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
    }
  }
  const ok = field(answer, 'ok')
  const error = field(answer, 'error')
  const code = field(error, 'code')
  const message = field(error, 'message')
  const exit = `(exit ${result.code})`
  const said = `${typeof code === 'string' ? `${code}: ` : ''}${typeof message === 'string' ? message : 'not ok'}`
  // Orca itself calls the outcome unknown: unknown, whatever else the answer says.
  if (field(field(error, 'data'), 'deliveryOutcome') === 'unknown') {
    return { ok: false, delivery: 'unknown', error: `orca terminal send: ${said} ${exit}` }
  }
  if (ok === false) {
    // Only Orca's refusal in its own form — its code and message, a failed exit — proves anything.
    const refusal = typeof code === 'string' && typeof message === 'string' && result.code !== 0
    return {
      ok: false,
      delivery: refusal && NOT_SENT_CODES.has(code) ? 'not-sent' : 'unknown',
      error: `orca terminal send: ${said} ${exit}`,
    }
  }
  if (ok !== true || error !== undefined) {
    return { ok: false, delivery: 'unknown', error: `orca terminal send answered neither a receipt nor a refusal of Orca ${exit}` }
  }
  const send = field(field(answer, 'result'), 'send')
  const accepted = field(send, 'accepted')
  // Only Orca's receipt decides: without a yes or no of the terminal the outcome is not known.
  if (typeof accepted !== 'boolean') {
    return { ok: false, delivery: 'unknown', error: `orca terminal send answered without the terminal's receipt ${exit}` }
  }
  const reason = field(send, 'refusedReason')
  const stages = field(field(send, 'prompt'), 'stages')
  return {
    ok: true,
    accepted,
    refusedReason: accepted ? null : typeof reason === 'string' && reason !== '' ? reason : 'Orca gave no reason',
    turnStarted: accepted && Array.isArray(stages) && stages.includes('turn_started'),
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined
}
