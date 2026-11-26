// The agents of the queue (TZ «Пользователи и роли»): the implementer, the reviewer, the solver and the MVP start agent
// are the Orca agents of the project's settings (`agents` of .agent-queue.json). This is the worker's common layer for
// all of them:
//
// - launch: the agent of a role starts through Orca's API (`agent.launch`) in a workspace — a task's worktree, or the
//   main checkout for the start agent — in a new background terminal Orca opens there. Its task is a file in the
//   plugin's data directory; the one-line prompt names that file and the report file beside it. Orca returns once the
//   terminal exists and sends the prompt by itself once the agent is ready (Orca 1.4.274 only logs a prompt that does
//   not get through), so the launch is not yet the task's delivery: the task has reached the agent once Orca reports a
//   turn start (`working`) after the launch, or the report file appears.
// - state: working, blocked, waiting or done — the newest by the time the state began: `agents.list` gives it
//   (`stateStartedAt`), `agent.status.changed` gives the main agent's (`mainAgent.stateStartedAt`) and otherwise only
//   when Orca got the status (`receivedAt`).
// - report: each input of the plugin — the task, then each message — names a report file of its own. The report is
//   ready only when the agent is in Orca's «done» that began after the last input AND that input's report file exists;
//   a report of an earlier input never counts for a later one.
// - delivery: an input the agent has not started on (no turn start seen, no report file) DELIVERY_DEADLINE_MS after it
//   was given counts as not delivered: the report says so, the reason for «сбой агента».
// - message: typed into the agent's terminal through Orca's CLI (src/platform/orca-terminal.ts) — the plugin API types
//   only into a terminal of the focused worktree — as one line naming the message's file and its report file.
// - stop: closes the terminals the plugin opened for this task, and no other terminal; it waits for the task's launches
//   still waiting for Orca, so an agent being launched cannot outlive the stop.
// - an agent Orca does not know, or a launch that fails: an error naming the agent and the reason (by it the later
//   tasks block the task with «сбой агента»); for an agent Orca does not know Orca starts nothing.
//
// What each launch leaves in the data directory, <data>/projects/<project>/<task>/agents/<n>/ (n = 1, 2, … in the order
// of the task's launches):
// - task.md — the task the agent got, and report.md — its report, which the agent writes;
// - launching.json — role, agent, language, workspace and time, written before Orca is asked; launch.json — Orca's
//   answer: the terminal it opened, or null and the error;
// - message-<k>.md — a message's text, report-<k>.md — the agent's report on it; message-<k>.json — the message's time,
//   files and whether Orca saw it start a turn, once the agent's terminal took it;
// - closed — the plugin has closed the agent's terminal.
// Every file is created once and never rewritten, so the records survive a restart of the worker: a new worker stops
// the agents an earlier one launched.
import type { OrcaWorkerApi, PluginEvents } from 'orca/worker'
import type { GithubLanguage } from '../github-texts/catalog'
import { errorCode, errorMessage, type Machine } from '../platform/machine'
import { orcaCliTerminalInput, type TerminalInput } from '../platform/orca-terminal'
import { dataName, dataPath } from '../platform/paths'
import { AGENT_ROLES, SETTINGS_FILE, type AgentRole, type ProjectAgents } from '../project/settings'
import { launchPrompt, messageLine } from './task-text'

export const AGENT_STATES = ['working', 'blocked', 'waiting', 'done'] as const
export type AgentState = (typeof AGENT_STATES)[number]

// The most characters Orca takes in a prompt of `agent.launch`.
export const ORCA_TEXT_MAX = 4096

// How long the agent may take to start on an input — its task, a message — before the input counts as not delivered.
export const DELIVERY_DEADLINE_MS = 10 * 60 * 1000

// The most launches of one task, and the most messages to one agent, the data directory keeps.
const MAX_RECORDS = 1000

const TASK_FILE = 'task.md'
const LAUNCHING_FILE = 'launching.json'
const LAUNCH_FILE = 'launch.json'
const REPORT_FILE = 'report.md'
const CLOSED_FILE = 'closed'

// The work the agents serve: a project of the queue and, inside it, a task — `issue-<N>` for a queue task (issueTask),
// another key of lower-case words for other work (`mvp-start`).
export type TaskRef = { readonly project: string; readonly key: string }

const TASK_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function issueTask(project: string, issue: number): TaskRef {
  if (!Number.isInteger(issue) || issue < 1) throw new Error(`not an issue number: ${issue}`)
  return { project, key: `issue-${issue}` }
}

export type LaunchFiles = {
  // The launch's directory in the data directory.
  readonly dir: string
  readonly taskFile: string
  // The report on the task; a message names a report file of its own.
  readonly reportFile: string
}

export type LaunchRequest = {
  readonly task: TaskRef
  readonly role: AgentRole
  // The project's agents (settings): the role's agent is launched.
  readonly agents: ProjectAgents
  // The project's language: the prompt's and the messages' language.
  readonly language: GithubLanguage
  // Orca's id of the workspace the agent works in: the task's worktree, or the main checkout.
  readonly workspaceId: string
  // The task's text; it names the report file, so it is written once the launch's files are known.
  readonly taskText: (files: LaunchFiles) => string
}

type LaunchBase = LaunchFiles & {
  readonly task: TaskRef
  // The launch's number among the task's launches.
  readonly number: number
  readonly role: AgentRole
  readonly agent: string
  readonly language: GithubLanguage
  readonly workspaceId: string
  // When the plugin asked Orca for it (the machine's clock, milliseconds since the epoch).
  readonly launchedAt: number
}

// An agent Orca started: `terminalId` is the handle of the terminal Orca opened for it.
export type AgentLaunch = LaunchBase & { readonly terminalId: string }

// A launch as the data directory keeps it.
export type LaunchRecord = LaunchBase & {
  // `pending`: Orca was asked and its answer is not recorded — the launch is under way, or the worker stopped meanwhile.
  readonly outcome: 'launched' | 'failed' | 'pending'
  readonly terminalId: string | null
  readonly error: string | null
  readonly closed: boolean
}

export type LaunchFailure = {
  readonly ok: false
  // `unknown-agent`: Orca does not know the agent of the settings and started nothing; `launch-failed`: Orca or the
  // plugin could not start it (the reason is in `error`).
  readonly kind: 'unknown-agent' | 'launch-failed'
  readonly role: AgentRole
  readonly agent: string
  // Names the agent, its field in .agent-queue.json and the reason.
  readonly error: string
}

export type LaunchResult = { readonly ok: true; readonly launch: AgentLaunch } | LaunchFailure

// An agent's state and when it began (Orca's clock; for an event without the main agent's state, when Orca got it).
export type StateReading = { readonly state: AgentState; readonly since: number }

export type ReportReading =
  | { readonly ready: true; readonly text: string; readonly reportFile: string }
  | {
      readonly ready: false
      // The agent's state in Orca; null when Orca has said nothing about it (no event, not in agents.list).
      readonly state: AgentState | null
      // Whether the agent has started on the last input: Orca saw a turn start after it, or its report file is there.
      readonly started: boolean
      // The report file of the last input, and whether it exists.
      readonly reportFile: string
      readonly reportExists: boolean
      // Set when the agent has not started on the last input DELIVERY_DEADLINE_MS after it: it did not reach the agent.
      readonly failure: string | null
    }

export type MessageResult =
  // `reportFile`: where the agent writes its report on this message; `started`: Orca saw it start a turn on it.
  | { readonly ok: true; readonly reportFile: string; readonly started: boolean }
  | { readonly ok: false; readonly error: string }

export type StopResult = {
  // The terminals closed now (or found already gone), in the order of their launches.
  readonly closed: readonly string[]
  // What could not be stopped, and why: a terminal Orca did not close, or a launch whose terminal is unknown.
  readonly failed: readonly { readonly launch: number; readonly terminalId: string | null; readonly error: string }[]
}

type WorkerHost = OrcaWorkerApi['host']

type LaunchingJson = { role: AgentRole; agent: string; language: GithubLanguage; workspaceId: string; launchedAt: number }
type LaunchJson = { terminalId: string | null; error: string | null }
type MessageJson = { sentAt: number; messageFile: string; reportFile: string; turnStarted: boolean }

// An input of the plugin to the agent: its task, or a message.
type Input = { readonly what: 'task' | 'message'; readonly at: number; readonly reportFile: string; readonly turnStarted: boolean }

export type AgentsOptions = {
  readonly host: WorkerHost
  readonly machine: Machine
  readonly dataDir: string
  // Typing into an agent's terminal (by default through this computer's Orca CLI).
  readonly terminalInput: TerminalInput
}

// The layer for one worker: `onStatus` takes Orca's `agent.status.changed` (startAgents subscribes it).
export class Agents {
  private readonly host: WorkerHost
  private readonly machine: Machine
  private readonly dataDir: string
  private readonly terminalInput: TerminalInput
  // The newest state Orca has reported for each terminal.
  private readonly states = new Map<string, StateReading>()
  // When the agent of each terminal last started a turn: the start of the newest «working» Orca reported.
  private readonly turns = new Map<string, number>()
  // The launches still waiting for Orca, by the task's directory.
  private readonly pending = new Map<string, Set<Promise<LaunchResult>>>()

  constructor(options: AgentsOptions) {
    this.host = options.host
    this.machine = options.machine
    this.dataDir = options.dataDir
    this.terminalInput = options.terminalInput
  }

  // Launches the agent of `request.role` from the project's agents. Until it settles, a stop of the task waits for it.
  launch(request: LaunchRequest): Promise<LaunchResult> {
    let key: string
    try {
      key = this.taskDir(request.task)
    } catch (error) {
      const agent = request.agents[request.role]
      return Promise.resolve({
        ok: false,
        kind: 'launch-failed',
        role: request.role,
        agent,
        error: `the agent "${agent}" (agents.${request.role} in ${SETTINGS_FILE}) was not launched: ${errorMessage(error)}`,
      })
    }
    const running = this.runLaunch(request)
    const set = this.pending.get(key) ?? new Set<Promise<LaunchResult>>()
    set.add(running)
    this.pending.set(key, set)
    const settle = () => {
      set.delete(running)
      if (set.size === 0 && this.pending.get(key) === set) this.pending.delete(key)
    }
    running.then(settle, settle)
    return running
  }

  // Orca's event `agent.status.changed`: the state of the agent in the event's terminal, with the time the main agent's
  // state began when the event has it.
  onStatus(event: PluginEvents['agent.status.changed']): void {
    if (!event.terminalId) return
    const main = event.mainAgent
    const since = main !== undefined && main.state === event.state ? main.stateStartedAt : event.receivedAt
    this.remember(event.terminalId, { state: event.state, since })
  }

  // The agent's state: the newest, by the time it began, of what Orca reported in its events and what `agents.list` of
  // the agent's workspace says now (an event may come without the terminal, an agent may leave the list once it ends).
  // Null: Orca has said nothing about it. Rejects with Orca's error when the list cannot be read.
  async state(launch: AgentLaunch): Promise<StateReading | null> {
    const { agents } = await this.host.call('agents.list', { workspaceId: launch.workspaceId })
    const listed = agents.find((agent) => agent.terminalId === launch.terminalId)
    if (listed !== undefined) this.remember(launch.terminalId, { state: listed.state, since: listed.stateStartedAt })
    return this.states.get(launch.terminalId) ?? null
  }

  // The report on the plugin's last input to the agent (its task, or the last message): ready only when the agent is
  // in a «done» that began after that input and that input's report file exists.
  async report(launch: AgentLaunch): Promise<ReportReading> {
    const input = this.lastInput(launch)
    const reading = await this.state(launch)
    const text = this.machine.readText(input.reportFile)
    if (text !== null && reading !== null && reading.state === 'done' && reading.since >= input.at) {
      return { ready: true, text, reportFile: input.reportFile }
    }
    const turn = this.turns.get(launch.terminalId)
    const started = input.turnStarted || (turn !== undefined && turn >= input.at) || text !== null
    const late = !started && this.machine.now() - input.at >= DELIVERY_DEADLINE_MS
    const failure = late
      ? `${input.what === 'task' ? 'the task' : 'the message'} did not reach the agent "${launch.agent}" in terminal ${launch.terminalId}: Orca saw it start no turn in ${DELIVERY_DEADLINE_MS / 60_000} minutes (its state: ${reading?.state ?? 'none'})`
      : null
    return { ready: false, state: reading?.state ?? null, started, reportFile: input.reportFile, reportExists: text !== null, failure }
  }

  // A message to the agent: its text goes into the file message-<k>.md of the launch, and the agent's terminal gets
  // one line — typed through Orca's CLI, with Enter — naming that file and the report file report-<k>.md.
  async message(launch: AgentLaunch, text: string): Promise<MessageResult> {
    if (text.trim() === '') return { ok: false, error: 'the message is empty' }
    if (this.isClosed(launch)) return { ok: false, error: `the plugin has closed the agent's terminal ${launch.terminalId}` }
    let k: number
    try {
      k = await this.reserve(launch.dir, (n) => `message-${n}.md`, () => text)
    } catch (error) {
      return { ok: false, error: `the message could not be written to the data directory: ${errorMessage(error)}` }
    }
    const messageFile = dataPath(this.machine, launch.dir, `message-${k}.md`)
    const reportFile = dataPath(this.machine, launch.dir, `report-${k}.md`)
    // Any turn the agent starts from now on may be on this message.
    const sentAt = this.machine.now()
    const sent = await this.terminalInput(launch.terminalId, messageLine(launch.language, messageFile, reportFile))
    if (!sent.ok) return { ok: false, error: `the message did not go into the agent's terminal ${launch.terminalId}: ${sent.error}` }
    if (!sent.accepted) {
      return { ok: false, error: `the agent's terminal ${launch.terminalId} did not take the message: ${sent.refusedReason}` }
    }
    try {
      await this.createJson(launch.dir, `message-${k}.json`, { sentAt, messageFile, reportFile, turnStarted: sent.turnStarted })
    } catch (error) {
      // Without its record the message is not the agent's last input, and an earlier report would count for it.
      return { ok: false, error: `the message went into the agent's terminal, but could not be recorded: ${errorMessage(error)}` }
    }
    return { ok: true, reportFile, started: sent.turnStarted }
  }

  // Stops the agents of the task: first waits for the task's launches still waiting for Orca, then closes every
  // terminal the plugin opened for the task and has not closed yet — and no other terminal. A terminal Orca refuses to
  // close counts as closed when its workspace no longer lists it. A launch whose answer from Orca was never recorded
  // (the worker stopped while it was being launched) is reported: its terminal, if any, is unknown.
  async stop(task: TaskRef): Promise<StopResult> {
    await Promise.all([...(this.pending.get(this.taskDir(task)) ?? [])])
    const closed: string[] = []
    const failed: { launch: number; terminalId: string | null; error: string }[] = []
    for (const record of this.launches(task)) {
      if (record.outcome === 'pending') {
        failed.push({
          launch: record.number,
          terminalId: null,
          error: `Orca's answer to launch ${record.number} (the agent "${record.agent}") is not recorded: the worker stopped while it was being launched, and its terminal, if any, is unknown`,
        })
        continue
      }
      if (record.terminalId === null || record.closed) continue
      const terminalId = record.terminalId
      try {
        await this.host.call('terminal.close', { terminalId })
      } catch (error) {
        if (!(await this.isGone(record.workspaceId, terminalId))) {
          failed.push({ launch: record.number, terminalId, error: hostErrorText(error) })
          continue
        }
      }
      try {
        await this.machine.createText(dataPath(this.machine, record.dir, CLOSED_FILE), `${this.machine.now()}\n`)
      } catch {
        // The terminal is closed all the same; the next stop finds it gone.
      }
      closed.push(terminalId)
    }
    return { closed, failed }
  }

  // Every launch of the task the data directory keeps, in order.
  launches(task: TaskRef): LaunchRecord[] {
    const records: LaunchRecord[] = []
    for (let number = 1; number <= MAX_RECORDS; number++) {
      const files = this.launchFiles(task, number)
      if (this.machine.readText(files.taskFile) === null) break
      const launching = parseLaunching(this.machine.readText(dataPath(this.machine, files.dir, LAUNCHING_FILE)))
      // The worker stopped between the task file and asking Orca: nothing was launched.
      if (launching === null) continue
      const answer = parseLaunch(this.machine.readText(dataPath(this.machine, files.dir, LAUNCH_FILE)))
      const closed = this.machine.readText(dataPath(this.machine, files.dir, CLOSED_FILE)) !== null
      const outcome = answer === null ? 'pending' : answer.terminalId === null ? 'failed' : 'launched'
      records.push({ ...files, ...launching, task, number, outcome, terminalId: answer?.terminalId ?? null, error: answer?.error ?? null, closed })
    }
    return records
  }

  private async runLaunch(request: LaunchRequest): Promise<LaunchResult> {
    const { role, language, workspaceId } = request
    const agent = request.agents[role]
    const field = `agents.${role} in ${SETTINGS_FILE}`
    const failure = (kind: LaunchFailure['kind'], error: string): LaunchFailure => ({ ok: false, kind, role, agent, error })

    let reserved: LaunchFiles & { readonly number: number }
    try {
      reserved = await this.reserveLaunch(request)
    } catch (error) {
      return failure('launch-failed', `the agent "${agent}" (${field}) was not launched: its task file: ${errorMessage(error)}`)
    }
    const { number, ...files } = reserved
    const launchedAt = this.machine.now()
    try {
      await this.createJson(files.dir, LAUNCHING_FILE, { role, agent, language, workspaceId, launchedAt })
    } catch (error) {
      return failure('launch-failed', `the agent "${agent}" (${field}) was not launched: its launch could not be recorded: ${errorMessage(error)}`)
    }
    const answer = (terminalId: string | null, error: string | null) => this.createJson(files.dir, LAUNCH_FILE, { terminalId, error })

    const prompt = launchPrompt(language, files.taskFile, files.reportFile)
    if (prompt.length > ORCA_TEXT_MAX) {
      const error = `the agent "${agent}" (${field}) was not launched: the paths of its task and report files make a prompt of ${prompt.length} characters, Orca takes ${ORCA_TEXT_MAX}`
      await answer(null, error).catch(() => {})
      return failure('launch-failed', error)
    }

    let terminalId: string
    try {
      terminalId = (await this.host.call('agent.launch', { workspaceId, agent, prompt })).terminalId
    } catch (error) {
      const unknown = errorCode(error) === 'invalid_params' && /unknown agent/i.test(errorMessage(error))
      const message = unknown
        ? `Orca does not know the agent "${agent}" (${field})`
        : `Orca could not launch the agent "${agent}" (${field}): ${hostErrorText(error)}`
      await answer(null, message).catch(() => {})
      return failure(unknown ? 'unknown-agent' : 'launch-failed', message)
    }

    try {
      await answer(terminalId, null)
    } catch (error) {
      // An agent without its record could never be stopped by the plugin: it is closed again at once.
      const closing = await this.host.call('terminal.close', { terminalId }).then(
        () => 'its terminal is closed',
        (closeError: unknown) => `its terminal ${terminalId} could not be closed: ${hostErrorText(closeError)}`,
      )
      return failure(
        'launch-failed',
        `the agent "${agent}" (${field}) was launched, but its launch could not be recorded (${errorMessage(error)}); ${closing}`,
      )
    }
    return { ok: true, launch: { ...files, task: request.task, number, role, agent, language, workspaceId, launchedAt, terminalId } }
  }

  private remember(terminalId: string, reading: StateReading): void {
    const known = this.states.get(terminalId)
    if (known === undefined || reading.since >= known.since) this.states.set(terminalId, reading)
    if (reading.state === 'working') this.turns.set(terminalId, Math.max(this.turns.get(terminalId) ?? reading.since, reading.since))
  }

  // The plugin's last input to the agent: the newest message its terminal took, or else the task.
  private lastInput(launch: AgentLaunch): Input {
    let last: Input = { what: 'task', at: launch.launchedAt, reportFile: launch.reportFile, turnStarted: false }
    for (let n = 1; n <= MAX_RECORDS; n++) {
      if (this.machine.readText(dataPath(this.machine, launch.dir, `message-${n}.md`)) === null) break
      const json = parseMessage(this.machine.readText(dataPath(this.machine, launch.dir, `message-${n}.json`)))
      if (json !== null) last = { what: 'message', at: json.sentAt, reportFile: json.reportFile, turnStarted: json.turnStarted }
    }
    return last
  }

  private isClosed(launch: AgentLaunch): boolean {
    return this.machine.readText(dataPath(this.machine, launch.dir, CLOSED_FILE)) !== null
  }

  // Whether Orca no longer lists the terminal in its workspace (a complete list without it).
  private async isGone(workspaceId: string, terminalId: string): Promise<boolean> {
    try {
      const { terminals, truncated } = await this.host.call('terminal.list', { workspaceId })
      return !truncated && !terminals.some((terminal) => terminal.id === terminalId)
    } catch {
      return false
    }
  }

  private taskDir(task: TaskRef): string {
    if (!TASK_KEY.test(task.key)) throw new Error(`not a task key: ${JSON.stringify(task.key)}`)
    return dataPath(this.machine, this.dataDir, 'projects', dataName(task.project), task.key)
  }

  private launchFiles(task: TaskRef, number: number): LaunchFiles {
    const dir = dataPath(this.machine, this.taskDir(task), 'agents', String(number))
    return { dir, taskFile: dataPath(this.machine, dir, TASK_FILE), reportFile: dataPath(this.machine, dir, REPORT_FILE) }
  }

  // The next launch of the task: the first number whose task file is free, taken by creating the task file there.
  private async reserveLaunch(request: LaunchRequest): Promise<LaunchFiles & { readonly number: number }> {
    for (let number = 1; number <= MAX_RECORDS; number++) {
      const files = this.launchFiles(request.task, number)
      if (this.machine.readText(files.taskFile) !== null) continue
      if (await this.machine.createText(files.taskFile, request.taskText(files))) return { ...files, number }
    }
    throw new Error(`more than ${MAX_RECORDS} launches of ${request.task.key}`)
  }

  // The first free number n, taken by creating the file `name(n)` in `dir` with `text(n)`.
  private async reserve(dir: string, name: (n: number) => string, text: (n: number) => string): Promise<number> {
    for (let n = 1; n <= MAX_RECORDS; n++) {
      const file = dataPath(this.machine, dir, name(n))
      if (this.machine.readText(file) !== null) continue
      if (await this.machine.createText(file, text(n))) return n
    }
    throw new Error(`more than ${MAX_RECORDS} files in ${dir}`)
  }

  private createJson(dir: string, name: string, value: LaunchingJson | LaunchJson | MessageJson): Promise<boolean> {
    return this.machine.createText(dataPath(this.machine, dir, name), `${JSON.stringify(value, null, 2)}\n`)
  }
}

// The agents layer of the worker, with Orca's `agent.status.changed` going to it. The event arrives only because the
// manifest lists it in `contributes.events` (with the capability `agent:read`).
export function startAgents(
  orca: Pick<OrcaWorkerApi, 'host' | 'events'>,
  machine: Machine,
  dataDir: string,
  terminalInput: TerminalInput = orcaCliTerminalInput(machine),
): Agents {
  const agents = new Agents({ host: orca.host, machine, dataDir, terminalInput })
  orca.events.on('agent.status.changed', (event) => agents.onStatus(event))
  return agents
}

// A refusal of Orca with its code: `action_failed: workspace not found`.
function hostErrorText(error: unknown): string {
  const code = errorCode(error)
  const message = errorMessage(error)
  return code === null ? message : `${code}: ${message}`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(text: string | null): Record<string, unknown> | null {
  if (text === null) return null
  try {
    const json: unknown = JSON.parse(text)
    return isObject(json) ? json : null
  } catch {
    return null
  }
}

function isAgentRole(value: unknown): value is AgentRole {
  return AGENT_ROLES.some((role) => role === value)
}

function parseLaunching(text: string | null): LaunchingJson | null {
  const json = parseJson(text)
  if (json === null) return null
  const { role, agent, language, workspaceId, launchedAt } = json
  if (
    !isAgentRole(role) ||
    typeof agent !== 'string' ||
    (language !== 'ru' && language !== 'en') ||
    typeof workspaceId !== 'string' ||
    typeof launchedAt !== 'number'
  ) {
    return null
  }
  return { role, agent, language, workspaceId, launchedAt }
}

function parseLaunch(text: string | null): LaunchJson | null {
  const json = parseJson(text)
  if (json === null) return null
  const { terminalId, error } = json
  if ((terminalId !== null && typeof terminalId !== 'string') || (error !== null && typeof error !== 'string')) return null
  return { terminalId, error }
}

function parseMessage(text: string | null): MessageJson | null {
  const json = parseJson(text)
  if (json === null) return null
  const { sentAt, messageFile, reportFile, turnStarted } = json
  if (typeof sentAt !== 'number' || typeof messageFile !== 'string' || typeof reportFile !== 'string' || typeof turnStarted !== 'boolean') {
    return null
  }
  return { sentAt, messageFile, reportFile, turnStarted }
}
