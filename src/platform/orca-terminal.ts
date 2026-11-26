// Typing into an Orca terminal by its handle through Orca's CLI (`terminal send`). The plugin API cannot do it for the
// agents of the queue: in Orca 1.4.274 the host's `terminal.sendText` takes only a terminal of the focused worktree
// and refuses any other with «terminal is outside the active worktree», while every agent the plugin launches runs in
// the background, in a worktree the owner is usually not looking at. The CLI's `terminal send` reaches any live
// terminal by the handle Orca's runtime issued — the very id `agent.launch` returns — and, for an agent, reports
// whether the prompt started a turn (TZ «Интеграции»: the CLI covers what the plugin API of 1.4.273 lacks).
//
// `orca terminal send --terminal <handle> --text <text> --enter --wait-submit <s> --json` answers
// `{ ok: true, result: { send: { handle, accepted, refusedReason?, prompt?: { stages, observation, … } } } }` — the
// stages are `input_accepted`, then `turn_started` once Orca saw the agent start a turn — or `{ ok: false, error: {
// code, message } }` with exit 1 (for example `terminal_handle_stale` for a handle no terminal has). An Orca without
// --wait-submit refuses it with `incompatible_runtime` before sending anything; the text then goes without it.
import type { Machine } from './machine'
import { findOrcaCli } from './orca-cli'
import { runProgram, type RunResult } from './run'

// How long `terminal send` waits to see the prompt start a turn.
export const WAIT_SUBMIT_SECONDS = 30

export type TerminalSendResult =
  | {
      readonly ok: true
      // Whether the terminal took the text; when not, Orca's reason.
      readonly accepted: boolean
      readonly refusedReason: string | null
      // Whether Orca saw the agent start a turn on the text within the wait.
      readonly turnStarted: boolean
    }
  // The CLI could not be found or run, or Orca refused the request: nothing is known to have been typed.
  | { readonly ok: false; readonly error: string }

// Types `text` and Enter into the terminal `terminalId`.
export type TerminalInput = (terminalId: string, text: string) => Promise<TerminalSendResult>

// The terminal input of this computer's Orca CLI, found once (src/platform/orca-cli.ts) and kept while it answers.
export function orcaCliTerminalInput(machine: Machine): TerminalInput {
  let cli: string | null = null
  return async (terminalId, text) => {
    if (cli === null) {
      const search = await findOrcaCli(machine)
      if (!search.found) return { ok: false, error: `Orca's CLI is not found: ${search.reason}` }
      cli = search.file
    }
    const send = (wait: boolean) =>
      runProgram(
        machine,
        cli ?? '',
        ['terminal', 'send', '--terminal', terminalId, '--text', text, '--enter', ...(wait ? ['--wait-submit', String(WAIT_SUBMIT_SECONDS)] : []), '--json'],
        { timeoutMs: (WAIT_SUBMIT_SECONDS + 60) * 1000 },
      )
    let answer = parseSend(await send(true))
    if (!answer.ok && answer.code === 'incompatible_runtime' && /--wait-submit/.test(answer.error)) answer = parseSend(await send(false))
    if (!answer.ok) {
      // A CLI that could not run is looked for again next time.
      if (answer.code === null) cli = null
      return { ok: false, error: answer.error }
    }
    return { ok: true, accepted: answer.accepted, refusedReason: answer.refusedReason, turnStarted: answer.turnStarted }
  }
}

// The CLI's answer; `code` is Orca's error code, null when the CLI itself failed (not started, no JSON).
type Parsed =
  | { readonly ok: true; readonly accepted: boolean; readonly refusedReason: string | null; readonly turnStarted: boolean }
  | { readonly ok: false; readonly error: string; readonly code: string | null }

function parseSend(result: RunResult): Parsed {
  if (result.error !== null) return { ok: false, error: `orca terminal send: ${result.error.reason}`, code: null }
  let answer: unknown
  try {
    answer = JSON.parse(result.stdout)
  } catch {
    const said = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/)[0] ?? ''
    return { ok: false, error: `orca terminal send answered no JSON (exit ${result.code})${said ? `: ${said}` : ''}`, code: null }
  }
  const field = (value: unknown, key: string): unknown =>
    typeof value === 'object' && value !== null && key in value ? (value as Record<string, unknown>)[key] : undefined
  if (field(answer, 'ok') !== true) {
    const code = field(field(answer, 'error'), 'code')
    const message = field(field(answer, 'error'), 'message')
    return {
      ok: false,
      error: `orca terminal send: ${typeof message === 'string' ? message : 'not ok'} (exit ${result.code})`,
      code: typeof code === 'string' ? code : 'unknown',
    }
  }
  const send = field(field(answer, 'result'), 'send')
  const accepted = field(send, 'accepted') === true
  const reason = field(send, 'refusedReason')
  const stages = field(field(send, 'prompt'), 'stages')
  return {
    ok: true,
    accepted,
    refusedReason: accepted ? null : typeof reason === 'string' ? reason : 'no reason given',
    turnStarted: Array.isArray(stages) && stages.includes('turn_started'),
  }
}
