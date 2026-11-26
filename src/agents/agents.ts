// The agents of the queue (TZ «Пользователи и роли»): the implementer, the reviewer, the solver and the MVP start agent
// are the Orca agents of the project's settings (`agents` of .agent-queue.json). This is the worker's common layer for
// all of them — launching the agent of a role, its files in the data directory and stopping the agents of a task:
//
// - launch: the agent of a role starts through Orca's API (`agent.launch`) in the workspace the caller names — a
//   task's worktree, or the main checkout for the start agent — in a new background terminal Orca opens there. Its
//   task is a file in the plugin's data directory; the one-line prompt, in the project's language, names that file and
//   the report file beside it. Orca returns once the terminal exists and sends the prompt by itself once the agent is
//   ready, so a launch that succeeded is an open terminal, not yet the task's delivery.
// - an agent Orca does not know, or a launch that fails: an error naming the agent, its field in .agent-queue.json and
//   the reason (by it the caller blocks the task with «сбой агента»); for an agent Orca does not know Orca starts
//   nothing. A terminal Orca opened whose answer the plugin could not record is closed again at once: without its
//   record the plugin could never stop it.
// - stop: closes the terminals the plugin opened for this task and has not closed yet, by the launch records, and no
//   other terminal. It waits for the task's launches under way: one that has not asked Orca yet is refused, the
//   terminal of one Orca is launching is closed once Orca answers; a launch of the task asked for while the stop runs
//   is refused.
//
// The agent's state, the task's delivery, the report's readiness and messages to the agent come with the next tasks of
// this layer; the worker starts the layer together with them.
//
// What each launch leaves in the data directory, <data>/projects/<project>/<task>/agents/<n>/ (n = 1, 2, … in the order
// of the task's launches: the next number is one more than the largest launch directory of the task):
// - task.md — the task the agent got, and report.md — its report, which the agent writes;
// - launching.json — role, agent, language, workspace and time, written before Orca is asked; launch.json — Orca's
//   answer: the terminal it opened, or null and the error (also the plugin's own reason when Orca was not asked);
// - closed — the plugin has closed the agent's terminal.
// Every file is created once and never rewritten, so the records survive a restart of the worker: a new worker stops
// the agents an earlier one launched. A stop reads each launch's records by themselves: a launch whose task file is
// gone is still stopped, and one whose records cannot be read is reported with the reason while the others are stopped.
import type { OrcaWorkerApi } from 'orca/worker'
import type { GithubLanguage } from '../github-texts/catalog'
import { errorCode, errorMessage, type Machine } from '../platform/machine'
import { dataName, dataPath } from '../platform/paths'
import type { Project } from '../protocol'
import { AGENT_ROLES, SETTINGS_FILE, type AgentRole, type ProjectAgents } from '../project/settings'
import { launchPrompt } from './task-text'

// The most characters Orca takes in a prompt of `agent.launch`.
export const ORCA_TEXT_MAX = 4096

// How many times a launch looks for a free number while other launches of the task take the ones it found.
const RESERVE_ATTEMPTS = 100

const AGENTS_DIR = 'agents'
const TASK_FILE = 'task.md'
const LAUNCHING_FILE = 'launching.json'
const LAUNCH_FILE = 'launch.json'
const REPORT_FILE = 'report.md'
const CLOSED_FILE = 'closed'

// A project of the queue as Orca knows it (`project.list`): its id and its host. One id can name copies of a project
// on two hosts (src/protocol.ts); each copy has agents and launch records of its own.
export type ProjectRef = Pick<Project, 'id' | 'hostId'>

// The work the agents serve: a project of the queue and, inside it, a task — `issue-<N>` for a queue task (issueTask),
// a key of lower-case words joined by hyphens for other work (`mvp-start`).
export type TaskRef = { readonly project: ProjectRef; readonly key: string }

// The two forms of a task key, each checked by itself: `issue-<N>` (N a whole number from 1, no leading zero), or
// lower-case words (letters only) joined by hyphens. Any other key is an error, never a path.
function isTaskKey(key: string): boolean {
  return /^issue-[1-9][0-9]*$/.test(key) || /^[a-z]+(?:-[a-z]+)*$/.test(key)
}

export function issueTask(project: ProjectRef, issue: number): TaskRef {
  if (!Number.isInteger(issue) || issue < 1) throw new Error(`not an issue number: ${issue}`)
  return { project, key: `issue-${issue}` }
}

export type LaunchFiles = {
  // The launch's directory in the data directory.
  readonly dir: string
  readonly taskFile: string
  // Where the agent writes its report on the task.
  readonly reportFile: string
}

export type LaunchRequest = {
  readonly task: TaskRef
  readonly role: AgentRole
  // The project's agents (settings): the role's agent is launched.
  readonly agents: ProjectAgents
  // The project's language: the prompt's language.
  readonly language: GithubLanguage
  // Orca's id of the workspace the agent works in: the task's worktree, or the main checkout.
  readonly workspaceId: string
  // The task's text; it names the report file, so it is written once the launch's files are known.
  readonly taskText: (files: LaunchFiles) => string
}

// An agent Orca started: `terminalId` is the handle of the terminal Orca opened for it.
export type AgentLaunch = LaunchFiles & {
  readonly task: TaskRef
  // The launch's number among the task's launches.
  readonly number: number
  readonly role: AgentRole
  readonly agent: string
  readonly language: GithubLanguage
  readonly workspaceId: string
  // When the plugin asked Orca for it (the machine's clock, milliseconds since the epoch).
  readonly launchedAt: number
  readonly terminalId: string
}

// A launch as the data directory keeps it; a directory where Orca was never asked (only a task file) is none.
export type LaunchRecord = LaunchFiles & {
  readonly task: TaskRef
  readonly number: number
  // What launching.json says; null when it is missing or cannot be read.
  readonly role: AgentRole | null
  readonly agent: string | null
  readonly language: GithubLanguage | null
  readonly workspaceId: string | null
  readonly launchedAt: number | null
  // `launched` / `failed`: launch.json names the terminal Orca opened, or the error. `pending`: Orca was asked and its
  // answer is not recorded — the launch is under way, the worker stopped meanwhile, or the answer could not be
  // written. `unreadable`: a record of the launch cannot be read (`error` says why). For the last two the terminal, if
  // any, is unknown.
  readonly outcome: 'launched' | 'failed' | 'pending' | 'unreadable'
  readonly terminalId: string | null
  readonly error: string | null
  readonly closed: boolean
}

export type LaunchFailure = {
  readonly ok: false
  // `unknown-agent`: Orca does not know the agent of the settings and started nothing; `launch-failed`: Orca or the
  // plugin could not start it, or a stop of the task refused it (the reason is in `error`).
  readonly kind: 'unknown-agent' | 'launch-failed'
  readonly role: AgentRole
  readonly agent: string
  // Names the agent, its field in .agent-queue.json and the reason.
  readonly error: string
}

export type LaunchResult = { readonly ok: true; readonly launch: AgentLaunch } | LaunchFailure

export type StopResult = {
  // The terminals closed now (or found already gone), in the order of their launches.
  readonly closed: readonly string[]
  // What could not be stopped, and why: a terminal Orca did not close, a launch whose terminal is unknown, or — `launch`
  // null — the task's launches, which could not be listed.
  readonly failed: readonly { readonly launch: number | null; readonly terminalId: string | null; readonly error: string }[]
}

type WorkerHost = OrcaWorkerApi['host']

type LaunchingJson = { role: AgentRole; agent: string; language: GithubLanguage; workspaceId: string; launchedAt: number }
type LaunchJson = { terminalId: string | null; error: string | null }

export type AgentsOptions = {
  readonly host: WorkerHost
  // The worker's computer: its clock and the files of the data directory.
  readonly machine: Machine
  // The plugin's data directory (src/platform/paths.ts).
  readonly dataDir: string
}

// The agents layer of one worker.
export class Agents {
  private readonly host: WorkerHost
  private readonly machine: Machine
  private readonly dataDir: string
  // The launches under way, and the stops under way, by the task's directory (its project's id and host, its key).
  private readonly pending = new Map<string, Set<Promise<LaunchResult>>>()
  private readonly stopping = new Map<string, number>()

  constructor(options: AgentsOptions) {
    this.host = options.host
    this.machine = options.machine
    this.dataDir = options.dataDir
  }

  // Launches the agent of `request.role` from the project's agents. It is under way from this call on: a stop of the
  // task that begins before it asks Orca refuses it, a later one waits for Orca's answer and closes its terminal. While
  // a stop of the task runs, it is refused at once.
  launch(request: LaunchRequest): Promise<LaunchResult> {
    let key: string
    try {
      key = this.taskDir(request.task)
    } catch (error) {
      return Promise.resolve(refusal(request, errorMessage(error)))
    }
    if (this.isStopping(key)) return Promise.resolve(refusal(request, stoppingReason(request.task)))
    // Registered before any code of the caller runs (its taskText, which may start a stop of the task).
    const running = Promise.resolve().then(() => this.runLaunch(request, key))
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

  // Stops the agents of the task: refuses its new launches while it runs, waits for its launches under way, then
  // closes every terminal the plugin opened for the task and has not closed yet — and no other terminal. A terminal
  // Orca refuses to close counts as closed when a complete list of its workspace no longer names it. A launch whose
  // terminal is unknown — Orca's answer not recorded, or its records unreadable — is reported with the reason, and the
  // other launches are stopped all the same. Rejects only for a task key that is not one.
  async stop(task: TaskRef): Promise<StopResult> {
    const key = this.taskDir(task)
    this.stopping.set(key, (this.stopping.get(key) ?? 0) + 1)
    try {
      await Promise.all([...(this.pending.get(key) ?? [])].map((running) => running.catch(() => undefined)))
      let records: LaunchRecord[]
      try {
        records = this.launches(task)
      } catch (error) {
        const reason = `the launches of ${task.key} could not be listed: ${errorMessage(error)}`
        return { closed: [], failed: [{ launch: null, terminalId: null, error: reason }] }
      }
      const closed: string[] = []
      const failed: { launch: number; terminalId: string | null; error: string }[] = []
      for (const record of records) {
        if (record.outcome === 'pending' || record.outcome === 'unreadable') {
          const agent = record.agent === null ? '' : ` (the agent "${record.agent}")`
          const why =
            record.outcome === 'pending'
              ? `Orca's answer to launch ${record.number}${agent} is not recorded — the worker stopped while Orca was launching it, or the answer could not be written`
              : `the records of launch ${record.number}${agent} cannot be read: ${record.error ?? ''}`
          failed.push({ launch: record.number, terminalId: null, error: `${why}: its terminal, if any, is unknown` })
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
    } finally {
      const left = (this.stopping.get(key) ?? 1) - 1
      if (left > 0) this.stopping.set(key, left)
      else this.stopping.delete(key)
    }
  }

  // Every launch of the task the data directory keeps, in the order of their numbers: each launch directory read by
  // itself, whatever is missing or unreadable in the others. Throws for a task key that is not one, and when the task's
  // launch directories cannot be listed.
  launches(task: TaskRef): LaunchRecord[] {
    const records: LaunchRecord[] = []
    for (const number of this.launchNumbers(task)) {
      const record = this.readRecord(task, number)
      if (record !== null) records.push(record)
    }
    return records
  }

  private async runLaunch(request: LaunchRequest, key: string): Promise<LaunchResult> {
    const { role, language, workspaceId } = request
    const agent = request.agents[role]
    const field = `agents.${role} in ${SETTINGS_FILE}`
    const failure = (kind: LaunchFailure['kind'], error: string): LaunchFailure => ({ ok: false, kind, role, agent, error })
    const notLaunched = (reason: string) => failure('launch-failed', `the agent "${agent}" (${field}) was not launched: ${reason}`)

    let reserved: LaunchFiles & { readonly number: number }
    try {
      reserved = await this.reserveLaunch(request)
    } catch (error) {
      return notLaunched(`its task file: ${errorMessage(error)}`)
    }
    const { number, ...files } = reserved
    const launchedAt = this.machine.now()
    try {
      await this.createRecord(files.dir, LAUNCHING_FILE, { role, agent, language, workspaceId, launchedAt })
    } catch (error) {
      return notLaunched(`its launch could not be recorded: ${errorMessage(error)}`)
    }
    // A launch that ends without a terminal records why; when even that cannot be written, the error says so too.
    const ended = async (kind: LaunchFailure['kind'], error: string): Promise<LaunchFailure> => {
      try {
        await this.createRecord(files.dir, LAUNCH_FILE, { terminalId: null, error })
        return failure(kind, error)
      } catch (recordError) {
        return failure(
          kind,
          `${error}; and this could not be recorded (${errorMessage(recordError)}): a stop reports launch ${number} as one whose terminal is unknown`,
        )
      }
    }

    // One line: a line break would submit the prompt before its end.
    const prompt = launchPrompt(language, files.taskFile, files.reportFile)
    const unfit = this.isStopping(key)
      ? stoppingReason(request.task)
      : prompt.length > ORCA_TEXT_MAX
        ? `the paths of its task and report files make a prompt of ${prompt.length} characters, Orca takes ${ORCA_TEXT_MAX}`
        : /[\r\n]/.test(prompt)
          ? 'the paths of its task and report files break the one-line prompt'
          : null
    if (unfit !== null) return ended('launch-failed', `the agent "${agent}" (${field}) was not launched: ${unfit}`)

    let terminalId: string
    try {
      terminalId = (await this.host.call('agent.launch', { workspaceId, agent, prompt })).terminalId
    } catch (error) {
      const unknown = errorCode(error) === 'invalid_params' && /unknown agent/i.test(errorMessage(error))
      const message = unknown
        ? `Orca does not know the agent "${agent}" (${field})`
        : `Orca could not launch the agent "${agent}" (${field}): ${hostErrorText(error)}`
      return ended(unknown ? 'unknown-agent' : 'launch-failed', message)
    }

    try {
      await this.createRecord(files.dir, LAUNCH_FILE, { terminalId, error: null })
    } catch (error) {
      // An agent without its record could never be stopped by the plugin: it is closed again at once.
      const closing = await this.host.call('terminal.close', { terminalId }).then(
        () => `its terminal ${terminalId} is closed`,
        (closeError: unknown) => `its terminal ${terminalId} could not be closed: ${hostErrorText(closeError)}`,
      )
      return failure(
        'launch-failed',
        `the agent "${agent}" (${field}) was launched, but its launch could not be recorded (${errorMessage(error)}); ${closing}`,
      )
    }
    return { ok: true, launch: { ...files, task: request.task, number, role, agent, language, workspaceId, launchedAt, terminalId } }
  }

  // The records of launch `number`, each file read by itself; null when Orca was never asked for it (no launch record).
  private readRecord(task: TaskRef, number: number): LaunchRecord | null {
    const files = this.launchFiles(task, number)
    const read = (name: string): { readonly text: string | null; readonly error: string | null } => {
      try {
        return { text: this.machine.readText(dataPath(this.machine, files.dir, name)), error: null }
      } catch (error) {
        return { text: null, error: `${name}: ${errorMessage(error)}` }
      }
    }
    const launchingRead = read(LAUNCHING_FILE)
    const answerRead = read(LAUNCH_FILE)
    const launching = parseLaunching(launchingRead.text)
    const answer = parseLaunch(answerRead.text)
    const notRecord = (name: string) => `${name} is not a launch record`

    let outcome: LaunchRecord['outcome']
    let error: string | null = null
    if (answerRead.error !== null || (answerRead.text !== null && answer === null)) {
      outcome = 'unreadable'
      error = answerRead.error ?? notRecord(LAUNCH_FILE)
    } else if (answer !== null) {
      outcome = answer.terminalId === null ? 'failed' : 'launched'
      error = answer.error
    } else if (launchingRead.error !== null || (launchingRead.text !== null && launching === null)) {
      // Orca may have been asked: what for is not known.
      outcome = 'unreadable'
      error = launchingRead.error ?? notRecord(LAUNCHING_FILE)
    } else if (launching !== null) {
      outcome = 'pending'
    } else {
      // Only the task file, or not even that: the launch ended before asking Orca.
      return null
    }
    // A mark that cannot be read counts as not closed: closing again is harmless (Orca's refusal, then its list).
    const closed = read(CLOSED_FILE).text !== null
    return {
      ...files,
      task,
      number,
      role: launching?.role ?? null,
      agent: launching?.agent ?? null,
      language: launching?.language ?? null,
      workspaceId: launching?.workspaceId ?? null,
      launchedAt: launching?.launchedAt ?? null,
      outcome,
      terminalId: answer?.terminalId ?? null,
      error,
      closed,
    }
  }

  // Whether Orca no longer lists the terminal in its workspace (a complete list without it). Unknown workspace: no.
  private async isGone(workspaceId: string | null, terminalId: string): Promise<boolean> {
    if (workspaceId === null) return false
    try {
      const { terminals, truncated } = await this.host.call('terminal.list', { workspaceId })
      return !truncated && !terminals.some((terminal) => terminal.id === terminalId)
    } catch {
      return false
    }
  }

  private isStopping(key: string): boolean {
    return (this.stopping.get(key) ?? 0) > 0
  }

  // The task's directory: the project's own name — from its id and its host, so that copies of one project on two hosts
  // never share it — and the task's key.
  private taskDir(task: TaskRef): string {
    if (!isTaskKey(task.key)) throw new Error(`not a task key: ${JSON.stringify(task.key)}`)
    const project = dataName(JSON.stringify([task.project.id, task.project.hostId]))
    return dataPath(this.machine, this.dataDir, 'projects', project, task.key)
  }

  private launchFiles(task: TaskRef, number: number): LaunchFiles {
    const dir = dataPath(this.machine, this.taskDir(task), AGENTS_DIR, String(number))
    return { dir, taskFile: dataPath(this.machine, dir, TASK_FILE), reportFile: dataPath(this.machine, dir, REPORT_FILE) }
  }

  // The numbers of the task's launch directories, in order; other names there are not launches.
  private launchNumbers(task: TaskRef): number[] {
    const names = this.machine.listNames(dataPath(this.machine, this.taskDir(task), AGENTS_DIR)) ?? []
    return names
      .filter((name) => /^[1-9][0-9]*$/.test(name))
      .map(Number)
      .filter((number) => Number.isSafeInteger(number))
      .sort((a, b) => a - b)
  }

  // The next launch of the task: one more than its largest launch directory, taken by creating the task file there
  // (only one launch can create it); when another launch took that number meanwhile, the next one.
  private async reserveLaunch(request: LaunchRequest): Promise<LaunchFiles & { readonly number: number }> {
    for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt++) {
      const number = this.launchNumbers(request.task).reduce((largest, each) => Math.max(largest, each), 0) + 1
      const files = this.launchFiles(request.task, number)
      if (await this.machine.createText(files.taskFile, request.taskText(files))) return { ...files, number }
    }
    throw new Error(`no free launch number for ${request.task.key} in ${RESERVE_ATTEMPTS} attempts`)
  }

  // Creates a record of the launch once: a record already there is not this launch's, and is an error.
  private async createRecord(dir: string, name: string, value: LaunchingJson | LaunchJson): Promise<void> {
    const path = dataPath(this.machine, dir, name)
    if (!(await this.machine.createText(path, `${JSON.stringify(value, null, 2)}\n`))) throw new Error(`${path} is already there`)
  }
}

function stoppingReason(task: TaskRef): string {
  return `the agents of ${task.key} are being stopped`
}

// A launch refused before anything of it is written.
function refusal(request: LaunchRequest, reason: string): LaunchFailure {
  const agent = request.agents[request.role]
  return {
    ok: false,
    kind: 'launch-failed',
    role: request.role,
    agent,
    error: `the agent "${agent}" (agents.${request.role} in ${SETTINGS_FILE}) was not launched: ${reason}`,
  }
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
