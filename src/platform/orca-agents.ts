// The agents Orca knows on this computer, read from Orca itself (decision «🤖 Решение по #11: вопрос», variant A): the
// plugin API has no method that lists the agents Orca can launch (`agents.list` names running agents, `agent.launch`
// takes any string), so the plugin asks Orca's CLI — `<cli> agent installed --json`, the agent CLIs Orca detects on this
// host that can start: the agents of Orca's catalog it found here and that are not turned off in its Settings → Agents.
// The plugin keeps no list of agents of its own (only the defaults of the roles, DEFAULT_AGENTS of
// src/project/settings.ts). An agent «Orca knows» is one whose id is in this list, matched exactly.
//
// The CLI is the one the plugin finds by Ф14 (./orca-cli.ts); the command runs without `--worktree`, `--environment`
// and `--pairing-code` — the agents of this computer — and may take AGENTS_TIMEOUT_MS. Orca answers
// `{ ok: true, result: { agents: [{ id, name, default }] } }`, or `{ ok: false, error: { code, message } }` with exit 1.
// The list is read when the exit code is 0, the output is JSON with `ok: true`, and `result.agents` is a list of
// entries each with a non-empty text `id`: an agent's name is its `name`, or its `id` when it has none; the order is
// Orca's, an id that comes again counts once, and Orca's `default` is not used. Anything else is «the list is not read»
// with its reason as a code, the CLI file that ran and what it said: the CLI is not found (the reason of the search),
// did not start, did not answer in time, Orca refused (its `error.code` and `error.message`), or answered in another
// form. The panel words the reason in its language and names the CLI by the file that ran — never a bare `orca` on
// Linux. Nothing keeps the list: every check of the connection wizard and every «Подключить» reads it again.
import type { AgentsFailure } from '../protocol'
import type { Machine } from './machine'
import { findOrcaCli } from './orca-cli'
import { runProgram, type RunResult } from './run'

// How long `agent installed` may take before it counts as not answering.
export const AGENTS_TIMEOUT_MS = 30_000

// An agent as Orca names it: the id `agent.launch` and .agent-queue.json take, and its name for people.
export type OrcaAgent = { readonly id: string; readonly name: string }

export type OrcaAgentsReading =
  | { readonly ok: true; readonly agents: readonly OrcaAgent[] }
  // Why the list is not read: AgentsFailure of src/protocol.ts — a code, the CLI run, and what the CLI or Orca said;
  // the panel words it in its own language.
  | { readonly ok: false; readonly failure: AgentsFailure }

// The arguments of the one command.
export const AGENTS_ARGS: readonly string[] = ['agent', 'installed', '--json']

// Reads the agents Orca knows on this computer: the CLI is looked for, then asked.
export async function readOrcaAgents(machine: Machine): Promise<OrcaAgentsReading> {
  const search = await findOrcaCli(machine)
  if (!search.found) return { ok: false, failure: { kind: 'cli-not-found', search: search.reason } }
  const result = await runProgram(machine, search.file, AGENTS_ARGS, { timeoutMs: AGENTS_TIMEOUT_MS })
  return orcaAgentsOutcome(search.file, result)
}

// What one run of `agent installed --json` by the CLI `cli` gave.
export function orcaAgentsOutcome(cli: string, result: RunResult): OrcaAgentsReading {
  const failed = (kind: Exclude<AgentsFailure['kind'], 'cli-not-found'>, detail: string): OrcaAgentsReading => ({
    ok: false,
    failure: { kind, cli, detail },
  })
  if (result.error !== null) return failed(result.error.kind === 'timed_out' ? 'timed-out' : 'not-started', result.error.reason)
  let answer: unknown
  try {
    answer = JSON.parse(result.stdout)
  } catch {
    const said = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/)[0] ?? ''
    return failed('no-json', `exit ${result.code}${said ? `: ${said}` : ''}`)
  }
  if (field(answer, 'ok') === false) {
    const error = field(answer, 'error')
    const code = field(error, 'code')
    const message = field(error, 'message')
    const said = [typeof code === 'string' ? code : null, typeof message === 'string' ? message : null].filter((part) => part !== null)
    return failed('refused', `${said.join(': ') || 'no reason'} (exit ${result.code})`)
  }
  if (result.code !== 0 || field(answer, 'ok') !== true) return failed('not-ok', `exit ${result.code}`)
  const entries = field(field(answer, 'result'), 'agents')
  if (!Array.isArray(entries)) return failed('no-list', 'result.agents')
  const agents: OrcaAgent[] = []
  for (const entry of entries) {
    const id = field(entry, 'id')
    if (typeof id !== 'string' || id.trim() === '') return failed('no-id', JSON.stringify(field(entry, 'name') ?? null))
    if (agents.some((agent) => agent.id === id)) continue
    const name = field(entry, 'name')
    agents.push({ id, name: typeof name === 'string' && name.trim() !== '' ? name : id })
  }
  return { ok: true, agents }
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined
}
