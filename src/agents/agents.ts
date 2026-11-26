// The agents of the queue (TZ «Пользователи и роли»): the implementer, the reviewer, the solver and the MVP start agent
// are the Orca agents of the project's settings (`agents` of .agent-queue.json). This is the worker's common layer for
// all of them — launching the agent of a role, its files in the data directory, the agent's state in Orca, the task's
// delivery, the readiness of the report on it and stopping the agents of a task:
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
// - state: working, blocked, waiting or done. When `agents.list` of the launch's workspace names the launch's terminal,
//   its answer is Orca's current state and since when (`stateStartedAt`); otherwise the latest `agent.status.changed`
//   of that terminal this worker heard, whose start is known only when the event carries the main agent's state equal
//   to its own (`mainAgent.stateStartedAt`) — a late event of an earlier state, both starts known, does not replace the
//   later one. Orca has said nothing of the agent: no state. A list that cannot be read is an error, never «no state».
//   The state is a reading for the screens and the watchdog: the report's readiness has its own rule (below).
// - delivery: a launch is not yet the delivery. The task has reached the agent once Orca showed the agent's turn in the
//   launch's terminal — `working`, in an event or in the list — or the report file appeared. The plugin keeps that on
//   disk, once (started-0): a worker started later does not count an agent that started and now waits (`blocked`) as a
//   failed delivery. A turn heard in the terminal before Orca answered the launch is the start too: the mark is written
//   once the launch is recorded, before the launch's result — when the disk refuses it, the launch is an error naming
//   the terminal Orca opened (a stop of the task closes it). A reading of the report keeps the start it knows on disk
//   before it asks Orca; a mark that cannot be read or kept makes the reading an error, never a failed delivery. No
//   turn DELIVERY_DEADLINE_MS after the launch: the reading of the report names the failed delivery with what Orca
//   shows of the agent (`blocked`: it waits for a person — a permission, a trust prompt; anything else or nothing: the
//   task did not reach it), by which the caller blocks the task with «сбой агента». A turn seen in time is no failure,
//   however long the agent then works.
// - report: ready only when the launch's report file (report.md) is there, `agents.list` names the agent in «done», and
//   that «done» began (`stateStartedAt`) no earlier than the file's last write, as precise as the file system keeps it
//   (a fraction of a millisecond is not dropped) — an equal time is ready. The agent writes its report during its turn,
//   so the «done» of that turn begins after the file's last write; an earlier «done» — of an earlier turn, from a late
//   answer of the list, shown with an old start — began before it, and a file written after the «done» began is the
//   draft of a turn still going on. Only the list confirms: an event never makes a report ready (it may lack the start,
//   come late, or tell the end of the agent's session rather than of a turn), and an agent the list does not name has
//   no confirmed report — the case «the agent is gone from Orca» of the watchdog (Ф10), after a restart of the worker
//   as before. The text and the time of the file are read after Orca's answer, with nothing waited for or written
//   between them and the reply, the time after the text — a file changed in between has the later time, so «not ready»
//   — and the text read is the one returned. The rule assumes one computer: the data directory and Orca on it, so the
//   file's time and `stateStartedAt` come from one clock; the report is written by the agent itself.
// After a restart of the worker only the disk is kept: the events the former worker heard are gone, and an event of a
// launch the new worker does not know yet (before its first reading of that launch's state or report) leaves no mark.
//
// Messages to the agent come with the next task of this layer.
//
// What each launch leaves in the data directory, <data>/projects/<project>/<task>/agents/<n>/ (n = 1, 2, … in the order
// of the task's launches: the next number is one more than the largest number in the task's agents directory):
// - task.md — the task the agent got, and report.md — its report, which the agent writes;
// - launching.json — role, agent, language, workspace and time, written before Orca is asked; launch.json — Orca's
//   answer: the terminal it opened, or null and the error (also the plugin's own reason when Orca was not asked);
// - started-0 — the agent has started on its task (the time the plugin saw it);
// - closed — the plugin has closed the agent's terminal.
// Every file is created once and never rewritten, so the records survive a restart of the worker: a new worker stops
// the agents an earlier one launched. A stop reads each launch's records by themselves: a launch whose task file is
// gone is still stopped, one the plugin has closed (its `closed` mark is in its directory) is done whatever its other
// records say, and one whose records cannot be read is reported with the reason while the others are stopped.
// Launches are the real directories with a number for a name: a link (or a junction) or a file there is none — its
// number stays taken — and a link or a file on the way from the data directory to them is an error, so that the
// records of another place are never taken for the task's. The task's identity is copied when a launch or a stop is
// asked for.
import type { OrcaWorkerApi, PluginEvents } from 'orca/worker'
import type { GithubLanguage } from '../github-texts/catalog'
import { errorCode, errorMessage, type DirectoryEntry, type Machine } from '../platform/machine'
import { dataName, dataPath } from '../platform/paths'
import type { Project } from '../protocol'
import { AGENT_ROLES, SETTINGS_FILE, type AgentRole, type ProjectAgents } from '../project/settings'
import { launchPrompt } from './task-text'

// The most characters Orca takes in a prompt of `agent.launch`.
export const ORCA_TEXT_MAX = 4096

// How long after its launch the agent may take to start on its task before the task counts as not delivered.
export const DELIVERY_DEADLINE_MS = 10 * 60 * 1000

// How many times a launch looks for a free number while other launches of the task take the ones it found.
const RESERVE_ATTEMPTS = 100

const AGENTS_DIR = 'agents'
const TASK_FILE = 'task.md'
const LAUNCHING_FILE = 'launching.json'
const LAUNCH_FILE = 'launch.json'
const REPORT_FILE = 'report.md'
const STARTED_FILE = 'started-0'
const CLOSED_FILE = 'closed'

type StatusEvent = PluginEvents['agent.status.changed']

// An agent's state in Orca.
export type AgentState = StatusEvent['state']

// An agent's state and when it began; `since` is null when Orca did not say (an event without the main agent's state).
export type StateReading = { readonly state: AgentState; readonly since: number | null }

// The reading of the report on the launch's task.
export type ReportReading =
  | { readonly ready: true; readonly text: string; readonly reportFile: string }
  | {
      readonly ready: false
      // The agent's state as `state` reads it; null when Orca has said nothing of the agent.
      readonly state: AgentState | null
      // Whether `agents.list` names the agent: only the list confirms a report.
      readonly listed: boolean
      // Whether the agent has started on its task: Orca showed its turn in the launch's terminal, or the report file
      // is there.
      readonly started: boolean
      readonly reportFile: string
      readonly reportExists: boolean
      // The report file was last written after the «done» the list shows began: the draft of a turn still going on, or
      // a file written after the turn — not confirmed until the agent ends a new turn.
      readonly writtenAfterDone: boolean
      // When the agent has not started on its task DELIVERY_DEADLINE_MS after the launch: what Orca shows of the agent
      // (`blocked`: it waits for a person; anything else or null: the task did not reach it) and the reason in words.
      readonly failure: { readonly state: AgentState | null; readonly error: string } | null
    }

// What Orca shows of an agent now: its state, since when (null: not said), and whether `agents.list` named it.
type Seen = StateReading & { readonly listed: boolean }

// An agent as `agents.list` names it.
type ListedAgent = { readonly terminalId: string | null; readonly state: AgentState; readonly stateStartedAt: number }

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
  // plugin could not start it, a stop of the task refused it, or the start of its task, heard before Orca answered the
  // launch, could not be kept on disk — then its terminal is open, named in `error` (the reason is in `error`).
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

// Where a task's launches live, worked out once for each launch, stop or reading from a copy of the task's identity:
// what the caller changes in its objects afterwards moves nothing.
type TaskPlace = {
  // The copy of the task's identity.
  readonly task: TaskRef
  // The names below the data directory: projects/<project>/<task>/agents.
  readonly names: readonly string[]
  // The task's agents directory: <data>/projects/<project>/<task>/agents.
  readonly dir: string
}

// A launch as asked for, copied when it is asked for.
type Launching = {
  readonly place: TaskPlace
  readonly role: AgentRole
  readonly agent: string
  readonly language: GithubLanguage
  readonly workspaceId: string
  readonly taskText: (files: LaunchFiles) => string
}

// The agents layer of one worker: `onStatus` takes Orca's `agent.status.changed` (startAgents subscribes it).
export class Agents {
  private readonly host: WorkerHost
  private readonly machine: Machine
  private readonly dataDir: string
  // The launches under way, and the stops under way, by the task's agents directory (its project's id and host, its
  // key).
  private readonly pending = new Map<string, Set<Promise<LaunchResult>>>()
  private readonly stopping = new Map<string, number>()
  // The latest state Orca's events gave for each terminal, and since when.
  private readonly heard = new Map<string, StateReading>()
  // The terminals in which Orca has shown an agent's turn (`working`, in an event or in `agents.list`).
  private readonly turns = new Set<string>()
  // The launches this worker knows, by their terminal: a turn heard in one is kept on disk at once.
  private readonly known = new Map<string, AgentLaunch>()

  constructor(options: AgentsOptions) {
    this.host = options.host
    this.machine = options.machine
    this.dataDir = options.dataDir
  }

  // Launches the agent of `request.role` from the project's agents. The request's values are taken now. It is under
  // way from this call on: a stop of the task that begins before it asks Orca refuses it, a later one waits for Orca's
  // answer and closes its terminal. While a stop of the task runs, it is refused at once.
  launch(request: LaunchRequest): Promise<LaunchResult> {
    const { role, language, workspaceId, taskText } = request
    const agent = request.agents[role]
    let place: TaskPlace
    try {
      place = this.place(request.task)
    } catch (error) {
      return Promise.resolve(refusal(role, agent, errorMessage(error)))
    }
    const key = place.dir
    if (this.isStopping(key)) return Promise.resolve(refusal(role, agent, stoppingReason(place.task)))
    const launching: Launching = { place, role, agent, language, workspaceId, taskText }
    // Registered before any code of the caller runs (its taskText, which may start a stop of the task).
    const running = Promise.resolve().then(() => this.runLaunch(launching))
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

  // Stops the agents of the task (taken as it is now): refuses its new launches while it runs, waits for its launches
  // under way, then closes every terminal the plugin opened for the task and has not closed yet — and no other
  // terminal. A launch the plugin has closed (its `closed` mark is there) is done, whatever else its records say. A
  // terminal Orca refuses to close counts as closed when a complete list of its workspace no longer names it. A launch
  // whose terminal is unknown — Orca's answer not recorded, its records unreadable — is reported with the reason, and the
  // other launches are stopped all the same. Rejects only for a task key that is not one.
  async stop(task: TaskRef): Promise<StopResult> {
    const place = this.place(task)
    const key = place.dir
    this.stopping.set(key, (this.stopping.get(key) ?? 0) + 1)
    try {
      await Promise.all([...(this.pending.get(key) ?? [])].map((running) => running.catch(() => undefined)))
      let records: LaunchRecord[]
      try {
        records = this.records(place)
      } catch (error) {
        const reason = `the launches of ${place.task.key} could not be listed: ${errorMessage(error)}`
        return { closed: [], failed: [{ launch: null, terminalId: null, error: reason }] }
      }
      const closed: string[] = []
      const failed: { launch: number; terminalId: string | null; error: string }[] = []
      for (const record of records) {
        if (record.closed) continue
        if (record.outcome === 'pending' || record.outcome === 'unreadable') {
          const agent = record.agent === null ? '' : ` (the agent "${record.agent}")`
          const why =
            record.outcome === 'pending'
              ? `Orca's answer to launch ${record.number}${agent} is not recorded — the worker stopped while Orca was launching it, or the answer could not be written`
              : `the records of launch ${record.number}${agent} cannot be read: ${record.error ?? ''}`
          failed.push({ launch: record.number, terminalId: null, error: `${why}: its terminal, if any, is unknown` })
          continue
        }
        if (record.terminalId === null) continue
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

  // Orca's event `agent.status.changed`: the state of the agent in the event's terminal. Its start is known only from
  // the main agent's state equal to the event's; a late event of a state that began before the one already heard, both
  // starts known, does not replace it. A turn (`working`) in the terminal of a launch this worker knows is kept on disk
  // as the start of its task at once.
  onStatus(event: StatusEvent): void {
    const terminalId = event.terminalId
    if (terminalId === undefined || terminalId === '') return
    const main = event.mainAgent
    const since = main !== undefined && main.state === event.state ? main.stateStartedAt : null
    const latest = this.heard.get(terminalId)
    if (latest === undefined || latest.since === null || since === null || since >= latest.since) {
      this.heard.set(terminalId, { state: event.state, since })
    }
    if (event.state === 'working') this.turnSeen(terminalId)
  }

  // The agent's state in Orca: what `agents.list` of its workspace says now when it names the launch's terminal,
  // otherwise the latest event of that terminal this worker heard; null when Orca has said nothing of the agent.
  // Rejects when Orca's list cannot be read.
  async state(launch: AgentLaunch): Promise<StateReading | null> {
    this.know(launch)
    let agents: ListedAgent[]
    try {
      agents = (await this.host.call('agents.list', { workspaceId: launch.workspaceId })).agents
    } catch (error) {
      throw unreadableList(launch, error)
    }
    const seen = this.seen(launch, agents)
    return seen === null ? null : { state: seen.state, since: seen.since }
  }

  // The report on the launch's task: ready only when its report file is there, `agents.list` names the agent in «done»,
  // and that «done» began no earlier than the file's last write; then with the file's text. Otherwise what is missing,
  // and the failed delivery when the agent has not started on its task DELIVERY_DEADLINE_MS after the launch. Rejects
  // when Orca's list cannot be read, and when the start of the task cannot be read from the disk or kept there.
  async report(launch: AgentLaunch): Promise<ReportReading> {
    this.know(launch)
    // The start of the task as far as it is known before Orca is asked — the mark on disk, a turn this worker saw, the
    // report file there — is settled first: kept on disk when it is not there yet. Nothing is written after the reads
    // of the report file below.
    let started = this.startedOnDisk(launch)
    if (!started && (this.turns.has(launch.terminalId) || this.machine.modifiedAt(launch.reportFile) !== null)) {
      await this.keepStarted(launch)
      started = true
    }
    let agents: ListedAgent[]
    try {
      agents = (await this.host.call('agents.list', { workspaceId: launch.workspaceId })).agents
    } catch (error) {
      throw unreadableList(launch, error)
    }
    const seen = this.seen(launch, agents)
    // From Orca's answer to the reply nothing waits and nothing is written: the text first, then the time of the file's
    // last write — a file changed between the two reads has the later time.
    const text = this.machine.readText(launch.reportFile)
    const writtenAt = text === null ? null : this.machine.modifiedAt(launch.reportFile)
    const exists = text !== null && writtenAt !== null
    const doneSince = seen !== null && seen.listed && seen.state === 'done' ? seen.since : null
    if (exists && doneSince !== null && doneSince >= writtenAt) return { ready: true, text, reportFile: launch.reportFile }
    // A turn Orca's answer showed is being kept on disk (seen); a report file that appeared only now is kept by the
    // next reading — the file itself is there meanwhile.
    started = started || exists || this.turns.has(launch.terminalId)
    const state = seen?.state ?? null
    const late = !started && this.machine.now() - launch.launchedAt >= DELIVERY_DEADLINE_MS
    return {
      ready: false,
      state,
      listed: seen?.listed ?? false,
      started,
      reportFile: launch.reportFile,
      reportExists: exists,
      writtenAfterDone: exists && doneSince !== null && writtenAt > doneSince,
      failure: late ? { state, error: notDelivered(launch, state) } : null,
    }
  }

  // Every launch of the task the data directory keeps, in the order of their numbers: each launch directory read by
  // itself, whatever is missing or unreadable in the others. Throws for a task key that is not one, and when the task's
  // launch directories cannot be listed.
  launches(task: TaskRef): LaunchRecord[] {
    return this.records(this.place(task))
  }

  private records(place: TaskPlace): LaunchRecord[] {
    const records: LaunchRecord[] = []
    const numbers = (this.agentsEntries(place) ?? [])
      .filter((entry) => entry.kind === 'directory')
      .map((entry) => launchNumber(entry.name))
      .filter((number): number is number => number !== null)
      .sort((a, b) => a - b)
    for (const number of numbers) {
      const record = this.readRecord(place, number)
      if (record !== null) records.push(record)
    }
    return records
  }

  private async runLaunch(launching: Launching): Promise<LaunchResult> {
    const { place, role, agent, language, workspaceId } = launching
    const field = `agents.${role} in ${SETTINGS_FILE}`
    const failure = (kind: LaunchFailure['kind'], error: string): LaunchFailure => ({ ok: false, kind, role, agent, error })
    const notLaunched = (reason: string) => failure('launch-failed', `the agent "${agent}" (${field}) was not launched: ${reason}`)

    let reserved: LaunchFiles & { readonly number: number }
    try {
      reserved = await this.reserveLaunch(launching)
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
    const unfit = this.isStopping(place.dir)
      ? stoppingReason(place.task)
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
    const launch: AgentLaunch = { ...files, task: place.task, number, role, agent, language, workspaceId, launchedAt, terminalId }
    this.known.set(terminalId, launch)
    // Orca opened this terminal for this launch: a turn heard in it before Orca's answer is a turn on its task, kept on
    // disk before the result. When the disk refuses it, the launch is an error naming the terminal Orca opened: its
    // launch is recorded, so a stop of the task closes it.
    if (this.turns.has(terminalId)) {
      try {
        await this.keepStarted(launch)
      } catch (error) {
        return failure(
          'launch-failed',
          `the agent "${agent}" (${field}) was launched in terminal ${terminalId} and started its task before Orca answered the launch, but ${errorMessage(error)}; the terminal stays open, and a stop of the task closes it`,
        )
      }
    }
    return { ok: true, launch }
  }

  // From now on the worker knows the launch: a turn already heard in its terminal, and every later one, is kept on disk
  // as the start of its task.
  private know(launch: AgentLaunch): void {
    this.known.set(launch.terminalId, launch)
    if (this.turns.has(launch.terminalId)) this.keepStartedLater(launch)
  }

  // What Orca shows of the launch's agent, from Orca's answer to `agents.list` of its workspace: its entry there, else
  // the latest event this worker heard for its terminal; null when there is neither.
  private seen(launch: AgentLaunch, agents: readonly ListedAgent[]): Seen | null {
    const entry = agents.find((agent) => agent.terminalId === launch.terminalId)
    if (entry === undefined) {
      const heard = this.heard.get(launch.terminalId)
      return heard === undefined ? null : { ...heard, listed: false }
    }
    if (entry.state === 'working') this.turnSeen(launch.terminalId)
    return { state: entry.state, since: entry.stateStartedAt, listed: true }
  }

  // Orca showed an agent's turn in the terminal: for a launch the worker knows, its task has started.
  private turnSeen(terminalId: string): void {
    this.turns.add(terminalId)
    const launch = this.known.get(terminalId)
    if (launch !== undefined) this.keepStartedLater(launch)
  }

  // Whether the start of the launch's task is on disk (started-0). A mark that cannot be read is an error, never «not
  // started»: it may be there.
  private startedOnDisk(launch: AgentLaunch): boolean {
    const path = dataPath(this.machine, launch.dir, STARTED_FILE)
    try {
      return this.machine.readText(path) !== null
    } catch (error) {
      throw new Error(`the start of the task of launch ${launch.number} cannot be read from ${path}: ${errorMessage(error)}`)
    }
  }

  // Keeps on disk, once, that the agent has started on its task. Rejects when the mark can be neither read nor written.
  private async keepStarted(launch: AgentLaunch): Promise<void> {
    if (this.startedOnDisk(launch)) return
    const path = dataPath(this.machine, launch.dir, STARTED_FILE)
    try {
      await this.machine.createText(path, `${this.machine.now()}\n`)
    } catch (error) {
      throw new Error(`the start of the task of launch ${launch.number} could not be kept in ${path}: ${errorMessage(error)}`)
    }
  }

  // The same for a turn Orca reports with no caller to tell: when the disk refuses it, the worker still knows the turn,
  // and the next reading of the report keeps it on disk or rejects with the reason.
  private keepStartedLater(launch: AgentLaunch): void {
    this.keepStarted(launch).catch(() => undefined)
  }

  // The records of launch `number`: what its directory holds — whether the `closed` mark is there is seen in the
  // directory's list, not by reading the mark — and each record read by itself. Null when Orca was never asked for it
  // (no launch record).
  private readRecord(place: TaskPlace, number: number): LaunchRecord | null {
    const files = this.launchFiles(place, number)
    const base = { ...files, task: place.task, number, role: null, agent: null, language: null, workspaceId: null, launchedAt: null }
    let entries: DirectoryEntry[] | null
    try {
      entries = this.machine.listEntries(files.dir)
    } catch (error) {
      // Whether the plugin closed it is not known either.
      const reason = `its directory: ${errorMessage(error)}`
      return { ...base, outcome: 'unreadable', terminalId: null, error: reason, closed: false }
    }
    if (entries === null) return null
    const has = (name: string) => entries.some((entry) => this.sameName(entry.name, name))
    const read = (name: string): { readonly text: string | null; readonly error: string | null } => {
      if (!has(name)) return { text: null, error: null }
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
    return {
      ...base,
      role: launching?.role ?? null,
      agent: launching?.agent ?? null,
      language: launching?.language ?? null,
      workspaceId: launching?.workspaceId ?? null,
      launchedAt: launching?.launchedAt ?? null,
      outcome,
      terminalId: answer?.terminalId ?? null,
      error,
      closed: has(CLOSED_FILE),
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

  // The place of the task's launches, from a copy of its identity: the project's own name — from its id and its host,
  // so that copies of one project on two hosts never share it — and the task's key.
  private place(task: TaskRef): TaskPlace {
    const copy: TaskRef = { project: { id: task.project.id, hostId: task.project.hostId }, key: task.key }
    if (!isTaskKey(copy.key)) throw new Error(`not a task key: ${JSON.stringify(copy.key)}`)
    const names = ['projects', dataName(JSON.stringify([copy.project.id, copy.project.hostId])), copy.key, AGENTS_DIR]
    return { task: copy, names, dir: dataPath(this.machine, this.dataDir, ...names) }
  }

  // The entries of the task's agents directory, reached from the data directory through real directories only: null
  // when one on the way is not there (no launches yet). A link (or a junction) or a file on the way is an error: the
  // plugin never takes the records of another place for this task's.
  private agentsEntries(place: TaskPlace): DirectoryEntry[] | null {
    let dir = this.dataDir
    for (const name of place.names) {
      const entries = this.machine.listEntries(dir)
      const entry = entries?.find((each) => this.sameName(each.name, name))
      if (entry === undefined) return null
      dir = dataPath(this.machine, dir, name)
      if (entry.kind !== 'directory') throw new Error(`${dir} is a link or a file, not a directory: the plugin reads no launches through it`)
    }
    return this.machine.listEntries(dir)
  }

  // Names as the system's file names compare: without case on Windows and macOS.
  private sameName(a: string, b: string): boolean {
    return this.machine.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase()
  }

  private launchFiles(place: TaskPlace, number: number): LaunchFiles {
    const dir = dataPath(this.machine, place.dir, String(number))
    return { dir, taskFile: dataPath(this.machine, dir, TASK_FILE), reportFile: dataPath(this.machine, dir, REPORT_FILE) }
  }

  // The next launch of the task: one more than the largest number any entry of its agents directory has — a launch
  // directory, or a link or a file with a number for a name, which is no launch but keeps its number — taken by
  // creating the task file there (only one launch can create it); when another launch took that number meanwhile, the
  // next one.
  private async reserveLaunch(launching: Launching): Promise<LaunchFiles & { readonly number: number }> {
    for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt++) {
      const largest = (this.agentsEntries(launching.place) ?? []).reduce((most, entry) => Math.max(most, launchNumber(entry.name) ?? 0), 0)
      const files = this.launchFiles(launching.place, largest + 1)
      if (await this.machine.createText(files.taskFile, launching.taskText(files))) return { ...files, number: largest + 1 }
    }
    throw new Error(`no free launch number for ${launching.place.task.key} in ${RESERVE_ATTEMPTS} attempts`)
  }

  // Creates a record of the launch once: a record already there is not this launch's, and is an error.
  private async createRecord(dir: string, name: string, value: LaunchingJson | LaunchJson): Promise<void> {
    const path = dataPath(this.machine, dir, name)
    if (!(await this.machine.createText(path, `${JSON.stringify(value, null, 2)}\n`))) throw new Error(`${path} is already there`)
  }
}

// The agents layer of the worker, subscribed to Orca's `agent.status.changed`: the event reaches the worker only
// because the manifest lists it in `contributes.events` (with the capability `agent:read`).
export function startAgents(orca: Pick<OrcaWorkerApi, 'host' | 'events'>, machine: Machine, dataDir: string): Agents {
  const agents = new Agents({ host: orca.host, machine, dataDir })
  orca.events.on('agent.status.changed', (event) => agents.onStatus(event))
  return agents
}

// Orca's list of the agents could not be read: an error, never «no state» or «not ready».
function unreadableList(launch: AgentLaunch, error: unknown): Error {
  return new Error(`Orca's list of the agents of workspace ${launch.workspaceId} could not be read: ${hostErrorText(error)}`)
}

// The failed delivery of the task, with what Orca shows of the agent.
function notDelivered(launch: AgentLaunch, state: AgentState | null): string {
  const minutes = DELIVERY_DEADLINE_MS / 60_000
  const agent = `the agent "${launch.agent}" in terminal ${launch.terminalId}`
  if (state === 'blocked') {
    return `${agent} has not started on its task in ${minutes} minutes after the launch: Orca shows it blocked — it waits for a person (a permission, a trust prompt)`
  }
  const shows = state === null ? 'Orca shows nothing of it' : `Orca shows it ${state}`
  return `the task did not reach ${agent}: no turn in ${minutes} minutes after the launch (${shows})`
}

// The number of a launch directory's name: a whole number from 1 without leading zeros; null for any other name.
function launchNumber(name: string): number | null {
  if (!/^[1-9][0-9]*$/.test(name)) return null
  const number = Number(name)
  return Number.isSafeInteger(number) ? number : null
}

function stoppingReason(task: TaskRef): string {
  return `the agents of ${task.key} are being stopped`
}

// A launch refused before anything of it is written.
function refusal(role: AgentRole, agent: string, reason: string): LaunchFailure {
  return {
    ok: false,
    kind: 'launch-failed',
    role,
    agent,
    error: `the agent "${agent}" (agents.${role} in ${SETTINGS_FILE}) was not launched: ${reason}`,
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
