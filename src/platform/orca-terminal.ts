// Typing one line into an Orca terminal by its handle through Orca's CLI (`terminal send`). Every message of the plugin
// to an agent goes this one way, whether the agent's worktree is in the background or the active one (the autopilot's
// decision on the original task of the agents layer, variant A): the host API's `terminal.sendText` of Orca 1.4.274
// types only into a terminal of the active worktree and does not tell whether the agent started a turn, so the plugin
// never calls it, has no fallback through the API, and never moves the active worktree or the focus of Orca's window
// for a message (`terminal.focus`, `workspace.open`). The CLI's `terminal send` reaches any live terminal by the handle
// Orca's runtime issued — the very id `agent.launch` returns — and, for an agent, reports whether the line started a
// turn. Since it reaches any terminal, the agents layer types only into the terminals of the agents it launched
// (src/agents/agents.ts). The CLI is the one the plugin finds by Ф14 (src/platform/orca-cli.ts), once, and looked for
// again after it could not be started. A search hands its caller the CLI it found, pinned: the sends of that CLI run
// that very file at once, never looking for a CLI again — a later failure to start it in another send makes only the
// next search look again.
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
// and the line is not sent (the agents layer checks there that the terminal is still its own when it asks again about
// a send). A first send looks for the CLI itself (`find`), checks its terminal after the search, writes its records and
// then runs the CLI it found, with no search between that check and the run.
//
// The outcome of one run:
// - any answer in which Orca itself calls the outcome unknown (`error.data.deliveryOutcome: "unknown"`, whatever else
//   it says) — unknown, before anything else;
// - accepted — Orca's receipt, in the form of a success (`ok: true`, no error): `result.send.accepted` true (and
//   whether `turn_started` is among its stages), or false with Orca's reason: the terminal did not take the line;
// - not sent — proven that the line of this request was not typed: the CLI is not found or did not start, the
//   caller's check refused, or Orca refused the line itself in the form of Orca's refusal (`ok: false`, an `error`
//   with its code and message, a non-zero exit, no `result`) with one of `terminal_handle_stale`, `invalid_argument`,
//   `agent_prompt_blocked`, `incompatible_runtime`;
// - unknown — anything else: no JSON, a timeout, `runtime_unavailable` (Orca's CLI answers it both before the request
//   leaves and after the connection closed behind it), any other refusal, an answer in neither form (no boolean `ok`,
//   a success with an error, a refusal without its code or with exit 0, a refusal with a receipt — receipt and refusal
//   exclude each other), a success without a true or false `accepted`.
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

// The CLI one search found, pinned for its caller's attempt.
export type TerminalCli = {
  readonly found: true
  // Types `line` and Enter into the terminal `terminalId` as the request `requestId` (a UUID): one run of this very CLI,
  // started at once — nothing is looked for or waited for before it starts.
  send(terminalId: string, line: string, requestId: string): Promise<TerminalSendResult>
}

// What a search for the CLI gives: the CLI found, pinned, or why there is none.
export type TerminalCliSearch = TerminalCli | { readonly found: false; readonly reason: string }

// Typing into an Orca terminal through the CLI of this computer.
export type TerminalInput = {
  // Finds Orca's CLI by Ф14 unless it is found already: the CLI found, pinned (its sends never look for a CLI again),
  // or why there is none. A first send looks for it before it writes anything, so that it can check again after the
  // search before writing, record a send without a CLI as not sent without running anything, and run the CLI it found
  // once its records are written.
  find(): Promise<TerminalCliSearch>
  // Types `line` and Enter into the terminal `terminalId` as the request `requestId` (a UUID): one run of the CLI,
  // looked for first when it is not found yet. `check` runs once the CLI is found, right before `terminal send` starts,
  // with nothing waited for between them: a reason it returns means nothing runs and the line is not sent with that
  // reason; null lets the send go.
  send(terminalId: string, line: string, requestId: string, check: () => string | null): Promise<TerminalSendResult>
}

// The terminal input of this computer's Orca CLI, found by Ф14 when first needed and kept while it starts.
export function orcaCliTerminalInput(machine: Machine): TerminalInput {
  // The CLI found, kept for the next searches.
  let kept: string | null = null
  const pinned = (file: string): TerminalCli => ({
    found: true,
    send: async (terminalId, line, requestId) => {
      const result = await runProgram(machine, file, terminalSendArgs(terminalId, line, requestId), {
        timeoutMs: TERMINAL_SEND_TIMEOUT_MS,
      })
      // A CLI that could not be started is looked for again by the next search; a send that holds it runs it still.
      const unstarted = result.error !== null && (result.error.kind === 'not_found' || result.error.kind === 'start_failed')
      if (unstarted && kept === file) kept = null
      return terminalSendOutcome(result)
    },
  })
  const find = async (): Promise<TerminalCliSearch> => {
    if (kept !== null) return pinned(kept)
    const search = await findOrcaCli(machine)
    if (!search.found) return { found: false, reason: `Orca's CLI is not found: ${search.reason}` }
    kept = search.file
    return pinned(search.file)
  }
  return {
    find,
    send: async (terminalId, line, requestId, check) => {
      const cli = await find()
      if (!cli.found) return { ok: false, delivery: 'not-sent', error: cli.reason }
      // Nothing waits between the caller's check and the start of `terminal send`.
      const refused = check()
      if (refused !== null) return { ok: false, delivery: 'not-sent', error: refused }
      return cli.send(terminalId, line, requestId)
    },
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
    // Only Orca's refusal in its own form — its code and message, a failed exit, and no receipt beside it — proves
    // anything: an answer that is a refusal and a receipt at once is neither.
    const refusal = typeof code === 'string' && typeof message === 'string' && result.code !== 0 && field(answer, 'result') === undefined
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
