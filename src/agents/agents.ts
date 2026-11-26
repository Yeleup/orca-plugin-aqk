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
//   other terminal. It waits for the task's launches still waiting for Orca, and a launch of the task asked for while
//   the stop runs is refused.
//
// The agent's state, the task's delivery, the report's readiness and messages to the agent come with the next tasks of
// this layer; the worker starts the layer together with them.
//
// What each launch leaves in the data directory, <data>/projects/<project>/<task>/agents/<n>/ (n = 1, 2, … in the order
// of the task's launches):
// - task.md — the task the agent got, and report.md — its report, which the agent writes;
// - launching.json — role, agent, language, workspace and time, written before Orca is asked; launch.json — Orca's
//   answer: the terminal it opened, or null and the error;
// - closed — the plugin has closed the agent's terminal.
// Every file is created once and never rewritten, so the records survive a restart of the worker: a new worker stops
// the agents an earlier one launched.
import type { OrcaWorkerApi } from 'orca/worker'
import type { GithubLanguage } from '../github-texts/catalog'
import { errorCode, errorMessage, type Machine } from '../platform/machine'
import { dataName, dataPath } from '../platform/paths'
import { AGENT_ROLES, SETTINGS_FILE, type AgentRole, type ProjectAgents } from '../project/settings'
import { launchPrompt } from './task-text'

// The most characters Orca takes in a prompt of `agent.launch`.
export const ORCA_TEXT_MAX = 4096

// The most launches of one task the data directory keeps.
const MAX_RECORDS = 1000

const TASK_FILE = 'task.md'
const LAUNCHING_FILE = 'launching.json'
const LAUNCH_FILE = 'launch.json'
const REPORT_FILE = 'report.md'
const CLOSED_FILE = 'closed'

// The work the agents serve: a project of the queue and, inside it, a task — `issue-<N>` for a queue task (issueTask),
// another key of lower-case words joined by hyphens for other work (`mvp-start`).
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
  // `pending`: Orca was asked and its answer is not recorded — the launch is under way, the worker stopped meanwhile,
  // or the answer could not be written.
  readonly outcome: 'launched' | 'failed' | 'pending'
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
  // What could not be stopped, and why: a terminal Orca did not close, or a launch whose terminal is unknown.
  readonly failed: readonly { readonly launch: number; readonly terminalId: string | null; readonly error: string }[]
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
  // The launches still waiting for Orca, and the stops under way, by the task's directory.
  private readonly pending = new Map<string, Set<Promise<LaunchResult>>>()
  private readonly stopping = new Map<string, number>()

  constructor(options: AgentsOptions) {
    this.host = options.host
    this.machine = options.machine
    this.dataDir = options.dataDir
  }

  // Launches the agent of `request.role` from the project's agents. Until it settles, a stop of the task waits for it;
  // while a stop of the task runs, it is refused.
  launch(request: LaunchRequest): Promise<LaunchResult> {
    const agent = request.agents[request.role]
    const refuse = (reason: string): Promise<LaunchResult> =>
      Promise.resolve({
        ok: false,
        kind: 'launch-failed',
        role: request.role,
        agent,
        error: `the agent "${agent}" (agents.${request.role} in ${SETTINGS_FILE}) was not launched: ${reason}`,
      })
    let key: string
    try {
      key = this.taskDir(request.task)
    } catch (error) {
      return refuse(errorMessage(error))
    }
    if ((this.stopping.get(key) ?? 0) > 0) return refuse(`the agents of ${request.task.key} are being stopped`)
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

  // Stops the agents of the task: refuses its new launches while it runs, waits for its launches still waiting for
  // Orca, then closes every terminal the plugin opened for the task and has not closed yet — and no other terminal. A
  // terminal Orca refuses to close counts as closed when a complete list of its workspace no longer names it. A launch
  // whose answer from Orca is not recorded (the worker stopped while it was being launched) is reported: its terminal
  // is unknown. Rejects only for a task key that is not one.
  async stop(task: TaskRef): Promise<StopResult> {
    const key = this.taskDir(task)
    this.stopping.set(key, (this.stopping.get(key) ?? 0) + 1)
    try {
      await Promise.all([...(this.pending.get(key) ?? [])].map((running) => running.catch(() => undefined)))
      const closed: string[] = []
      const failed: { launch: number; terminalId: string | null; error: string }[] = []
      for (const record of this.launches(task)) {
        if (record.outcome === 'pending') {
          failed.push({
            launch: record.number,
            terminalId: null,
            error: `Orca's answer to launch ${record.number} (the agent "${record.agent}") is not recorded — the worker stopped while Orca was launching it, or the answer could not be written: its terminal, if any, is unknown`,
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
    } finally {
      const left = (this.stopping.get(key) ?? 1) - 1
      if (left > 0) this.stopping.set(key, left)
      else this.stopping.delete(key)
    }
  }

  // Every launch of the task the data directory keeps, in order. Throws for a task key that is not one.
  launches(task: TaskRef): LaunchRecord[] {
    const records: LaunchRecord[] = []
    for (let number = 1; number <= MAX_RECORDS; number++) {
      const files = this.launchFiles(task, number)
      if (this.machine.readText(files.taskFile) === null) break
      const launching = parseLaunching(this.machine.readText(dataPath(this.machine, files.dir, LAUNCHING_FILE)))
      // The worker stopped between the task file and asking Orca, or the launch was refused before: nothing launched.
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
    const answer = (terminalId: string | null, error: string | null) => this.createRecord(files.dir, LAUNCH_FILE, { terminalId, error })

    // One line: a line break would submit the prompt before its end.
    const prompt = launchPrompt(language, files.taskFile, files.reportFile)
    const unfit =
      prompt.length > ORCA_TEXT_MAX
        ? `the paths of its task and report files make a prompt of ${prompt.length} characters, Orca takes ${ORCA_TEXT_MAX}`
        : /[\r\n]/.test(prompt)
          ? 'the paths of its task and report files break the one-line prompt'
          : null
    if (unfit !== null) {
      const error = `the agent "${agent}" (${field}) was not launched: ${unfit}`
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

  // Creates a record of the launch once: a record already there is not this launch's, and is an error.
  private async createRecord(dir: string, name: string, value: LaunchingJson | LaunchJson): Promise<void> {
    const path = dataPath(this.machine, dir, name)
    if (!(await this.machine.createText(path, `${JSON.stringify(value, null, 2)}\n`))) throw new Error(`${path} is already there`)
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
