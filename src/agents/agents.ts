// The agents of the queue (TZ «Пользователи и роли»): the implementer, the reviewer, the solver and the MVP start agent
// are the Orca agents of the project's settings (`agents` of .agent-queue.json). This is the worker's common layer for
// all of them:
//
// - launch: the agent of a role starts through Orca's API (`agent.launch`) in a workspace — a task's worktree, or the
//   main checkout for the start agent — in a new terminal Orca opens there. Its task is a file in the plugin's data
//   directory; the one-line prompt names that file and the report file beside it.
// - state: working, blocked, waiting or done — the newest of Orca's event `agent.status.changed` and `agents.list`.
// - report: ready only when the agent has finished in Orca («done») after the plugin's last word to it — the launch or
//   a message — AND its report file exists.
// - message: text into the agent's terminal; a message of several lines or longer than Orca takes goes into a file,
//   and the terminal gets one line naming it.
// - stop: closes the terminals the plugin opened for this task, and no other terminal.
// - an agent Orca does not know, or a launch that fails: an error naming the agent and the reason (by it the later
//   tasks block the task with «сбой агента»); for an agent Orca does not know Orca starts nothing.
//
// What each launch leaves in the data directory, <data>/projects/<project>/<task>/agents/<n>/ (n = 1, 2, … in the order
// of the task's launches):
// - task.md — the task the agent got;
// - launch.json — role, agent, workspace, the terminal Orca opened (null and the error when the launch failed), time;
// - report.md — the agent's report, which the agent writes;
// - message-<k>.json — each message the agent's terminal took, with its time and text; message-<k>.md — the text of a
//   message that went through a file;
// - closed — the plugin has closed the agent's terminal.
// Every file is created once and never rewritten, so the records survive a restart of the worker: a new worker stops
// the agents an earlier one launched.
import type { OrcaWorkerApi, PluginEvents } from 'orca/worker'
import type { GithubLanguage } from '../github-texts/catalog'
import { errorCode, errorMessage, type Machine } from '../platform/machine'
import { dataName, dataPath } from '../platform/paths'
import { AGENT_ROLES, SETTINGS_FILE, type AgentRole, type ProjectAgents } from '../project/settings'
import { launchPrompt, messageFileLine } from './task-text'

export const AGENT_STATES = ['working', 'blocked', 'waiting', 'done'] as const
export type AgentState = (typeof AGENT_STATES)[number]

// The most characters Orca takes in a prompt of `agent.launch` and in a text of `terminal.sendText`.
export const ORCA_TEXT_MAX = 4096

// The most launches of one task, and the most messages to one agent, the data directory keeps.
const MAX_RECORDS = 1000

const TASK_FILE = 'task.md'
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
  // When the plugin launched it (the machine's clock, milliseconds since the epoch).
  readonly launchedAt: number
}

// An agent Orca started: `terminalId` is the terminal Orca opened for it.
export type AgentLaunch = LaunchBase & { readonly terminalId: string }

// A launch as the data directory keeps it: also one that failed (no terminal, its error), and whether the plugin has
// closed its terminal.
export type LaunchRecord = LaunchBase & {
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

// An agent's state and since when Orca has it (Orca's time: when it got the status, or when the state began).
export type StateReading = { readonly state: AgentState; readonly since: number }

export type ReportReading =
  | { readonly ready: true; readonly text: string }
  | {
      readonly ready: false
      // The agent's state in Orca; null when Orca has said nothing about it (no event, not in agents.list).
      readonly state: AgentState | null
      // Whether the agent has finished («done») after the plugin's last word to it.
      readonly finished: boolean
      // Whether the report file exists.
      readonly reportFile: boolean
    }

export type MessageResult = { readonly ok: true } | { readonly ok: false; readonly error: string }

export type StopResult = {
  // The terminals closed now (or found already gone), in the order of their launches.
  readonly closed: readonly string[]
  // The terminals that could not be closed, and why.
  readonly failed: readonly { readonly terminalId: string; readonly error: string }[]
}

type WorkerHost = OrcaWorkerApi['host']

type LaunchJson = {
  role: AgentRole
  agent: string
  language: GithubLanguage
  workspaceId: string
  terminalId: string | null
  launchedAt: number
  error: string | null
}

type MessageJson = { sentAt: number; text: string }

// The layer for one worker: `onStatus` takes Orca's `agent.status.changed` (startAgents subscribes it).
export class Agents {
  // The newest state Orca has reported for each terminal.
  private readonly states = new Map<string, StateReading>()

  constructor(
    private readonly host: WorkerHost,
    private readonly machine: Machine,
    private readonly dataDir: string,
  ) {}

  // Launches the agent of `request.role` from the project's agents.
  async launch(request: LaunchRequest): Promise<LaunchResult> {
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
    const record = (terminalId: string | null, error: string | null) =>
      this.createJson(files.dir, LAUNCH_FILE, { role, agent, language, workspaceId, terminalId, launchedAt, error })

    const prompt = launchPrompt(language, files.taskFile, files.reportFile)
    if (prompt.length > ORCA_TEXT_MAX) {
      const error = `the agent "${agent}" (${field}) was not launched: the paths of its task and report files make a prompt of ${prompt.length} characters, Orca takes ${ORCA_TEXT_MAX}`
      await record(null, error).catch(() => {})
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
      await record(null, message).catch(() => {})
      return failure(unknown ? 'unknown-agent' : 'launch-failed', message)
    }

    try {
      await record(terminalId, null)
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

  // Orca's event `agent.status.changed`: the state of the agent in the event's terminal.
  onStatus(event: PluginEvents['agent.status.changed']): void {
    if (event.terminalId) this.remember(event.terminalId, { state: event.state, since: event.receivedAt })
  }

  // The agent's state: the newer of what Orca reported in its events and what `agents.list` of the agent's workspace
  // says now (an event may come without the terminal, an agent may leave the list once it ends). Null: Orca has said
  // nothing about it. Rejects with Orca's error when the list cannot be read.
  async state(launch: AgentLaunch): Promise<StateReading | null> {
    const { agents } = await this.host.call('agents.list', { workspaceId: launch.workspaceId })
    const listed = agents.find((agent) => agent.terminalId === launch.terminalId)
    if (listed !== undefined) this.remember(launch.terminalId, { state: listed.state, since: listed.stateStartedAt })
    return this.states.get(launch.terminalId) ?? null
  }

  // The agent's report: ready only when the agent has finished in Orca after the plugin's last word to it and its
  // report file exists.
  async report(launch: AgentLaunch): Promise<ReportReading> {
    const reading = await this.state(launch)
    const finished = reading !== null && reading.state === 'done' && reading.since >= this.lastInput(launch)
    const text = this.machine.readText(launch.reportFile)
    if (finished && text !== null) return { ready: true, text }
    return { ready: false, state: reading?.state ?? null, finished, reportFile: text !== null }
  }

  // A message into the agent's terminal, as if typed and sent with Enter. One line of at most ORCA_TEXT_MAX characters
  // goes as it is; another goes into the file message-<k>.md of the launch, and the terminal gets one line naming it.
  async message(launch: AgentLaunch, text: string): Promise<MessageResult> {
    if (text.trim() === '') return { ok: false, error: 'the message is empty' }
    if (this.isClosed(launch)) return { ok: false, error: `the plugin has closed the agent's terminal ${launch.terminalId}` }
    const direct = !/[\r\n]/.test(text) && text.length <= ORCA_TEXT_MAX
    let k: number
    let sent = text
    try {
      if (direct) {
        k = this.freeMessageNumber(launch)
      } else {
        k = await this.reserve(launch.dir, (n) => `message-${n}.md`, () => text, (n) => this.messageTaken(launch, n))
        sent = messageFileLine(launch.language, dataPath(this.machine, launch.dir, `message-${k}.md`))
      }
    } catch (error) {
      return { ok: false, error: `the message could not be written to the data directory: ${errorMessage(error)}` }
    }
    // Any state Orca reports from now on may answer the message.
    const sentAt = this.machine.now()
    let accepted: boolean
    try {
      accepted = (await this.host.call('terminal.sendText', { terminalId: launch.terminalId, text: sent, enter: true })).accepted
    } catch (error) {
      return { ok: false, error: `Orca could not send the message: ${hostErrorText(error)}` }
    }
    if (!accepted) return { ok: false, error: `the agent's terminal ${launch.terminalId} did not take the message` }
    // The time of the message: a «done» before it is not the answer to it (report). Written after Orca took the
    // message; a lost record only lets an earlier «done» count after a restart of the worker.
    const record: MessageJson = { sentAt, text }
    for (let n = k; n <= MAX_RECORDS; n++) {
      if (n !== k && this.messageTaken(launch, n)) continue
      if (await this.createJson(launch.dir, `message-${n}.json`, record).catch(() => true)) break
    }
    return { ok: true }
  }

  // Stops the agents of the task: closes every terminal the plugin opened for it and has not closed yet — and no other
  // terminal. A terminal Orca refuses to close counts as closed when its workspace no longer lists it.
  async stop(task: TaskRef): Promise<StopResult> {
    const closed: string[] = []
    const failed: { terminalId: string; error: string }[] = []
    for (const record of this.launches(task)) {
      if (record.terminalId === null || record.closed) continue
      const terminalId = record.terminalId
      try {
        await this.host.call('terminal.close', { terminalId })
      } catch (error) {
        if (!(await this.isGone(record.workspaceId, terminalId))) {
          failed.push({ terminalId, error: hostErrorText(error) })
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
      const json = parseLaunch(this.machine.readText(dataPath(this.machine, files.dir, LAUNCH_FILE)))
      // The plugin stopped between the task file and the launch: it did not ask Orca for the agent, or never heard.
      if (json === null) continue
      const closed = this.machine.readText(dataPath(this.machine, files.dir, CLOSED_FILE)) !== null
      records.push({ ...files, ...json, task, number, closed })
    }
    return records
  }

  private remember(terminalId: string, reading: StateReading): void {
    const known = this.states.get(terminalId)
    if (known === undefined || reading.since >= known.since) this.states.set(terminalId, reading)
  }

  // When the plugin last gave the agent something to do: its launch, or the newest message its terminal took.
  private lastInput(launch: AgentLaunch): number {
    let last = launch.launchedAt
    for (let n = 1; n <= MAX_RECORDS && this.messageTaken(launch, n); n++) {
      const json = parseMessage(this.machine.readText(dataPath(this.machine, launch.dir, `message-${n}.json`)))
      if (json !== null) last = Math.max(last, json.sentAt)
    }
    return last
  }

  private messageTaken(launch: AgentLaunch, n: number): boolean {
    return (
      this.machine.readText(dataPath(this.machine, launch.dir, `message-${n}.json`)) !== null ||
      this.machine.readText(dataPath(this.machine, launch.dir, `message-${n}.md`)) !== null
    )
  }

  private freeMessageNumber(launch: AgentLaunch): number {
    for (let n = 1; n <= MAX_RECORDS; n++) if (!this.messageTaken(launch, n)) return n
    throw new Error(`more than ${MAX_RECORDS} messages to the agent of ${launch.dir}`)
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

  private launchFiles(task: TaskRef, number: number): LaunchFiles {
    if (!TASK_KEY.test(task.key)) throw new Error(`not a task key: ${JSON.stringify(task.key)}`)
    const dir = dataPath(this.machine, this.dataDir, 'projects', dataName(task.project), task.key, 'agents', String(number))
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

  // The first free number n by `taken`, taken by creating the file `name(n)` in `dir` with `text(n)`.
  private async reserve(
    dir: string,
    name: (n: number) => string,
    text: (n: number) => string,
    taken: (n: number) => boolean,
  ): Promise<number> {
    for (let n = 1; n <= MAX_RECORDS; n++) {
      if (taken(n)) continue
      if (await this.machine.createText(dataPath(this.machine, dir, name(n)), text(n))) return n
    }
    throw new Error(`more than ${MAX_RECORDS} files in ${dir}`)
  }

  private createJson(dir: string, name: string, value: LaunchJson | MessageJson): Promise<boolean> {
    return this.machine.createText(dataPath(this.machine, dir, name), `${JSON.stringify(value, null, 2)}\n`)
  }
}

// The agents layer of the worker, with Orca's `agent.status.changed` going to it. The event arrives only because the
// manifest lists it in `contributes.events` (with the capability `agent:read`).
export function startAgents(orca: Pick<OrcaWorkerApi, 'host' | 'events'>, machine: Machine, dataDir: string): Agents {
  const agents = new Agents(orca.host, machine, dataDir)
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

function parseJson(text: string | null): unknown {
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function isAgentRole(value: unknown): value is AgentRole {
  return AGENT_ROLES.some((role) => role === value)
}

function parseLaunch(text: string | null): LaunchJson | null {
  const json = parseJson(text)
  if (!isObject(json)) return null
  const { role, agent, language, workspaceId, terminalId, launchedAt, error } = json
  if (
    !isAgentRole(role) ||
    typeof agent !== 'string' ||
    (language !== 'ru' && language !== 'en') ||
    typeof workspaceId !== 'string' ||
    (terminalId !== null && typeof terminalId !== 'string') ||
    typeof launchedAt !== 'number' ||
    (error !== null && typeof error !== 'string')
  ) {
    return null
  }
  return { role, agent, language, workspaceId, terminalId, launchedAt, error }
}

function parseMessage(text: string | null): MessageJson | null {
  const json = parseJson(text)
  if (!isObject(json) || typeof json.sentAt !== 'number' || typeof json.text !== 'string') return null
  return { sentAt: json.sentAt, text: json.text }
}
