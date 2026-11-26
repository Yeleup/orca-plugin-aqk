// The agents of the queue (TZ «Пользователи и роли»): the implementer, the reviewer, the solver and the MVP start agent
// are the Orca agents of the project's settings (`agents` of .agent-queue.json). This is the worker's common layer for
// all of them — launching the agent of a role, its files in the data directory, the agent's state in Orca, messages to
// the agent, the delivery of the task and of each message, the readiness of the report on the last of them and
// stopping the agents of a task:
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
//   is refused. The same for the sends to the task's agents (a message, or asking Orca again about one): one asked for
//   before the stop that has not written anything yet is refused, one under way ends before the stop closes its
//   terminal, and while the stop runs a message is an error with nothing written and Orca is not asked again.
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
//   the terminal Orca opened (a stop of the task closes it). A reading of the report settles the start after Orca's
//   answer, before it reads the report file for its reply: when the agent has started — a turn the worker saw, or the
//   report file there (a file to read; a directory there is an error, never a start) — and the mark is not on disk yet,
//   the mark is written first and the file read again, so a reading that says «started» has the mark on disk; a mark
//   that cannot be read or kept makes the reading an error, never a failed delivery. No turn DELIVERY_DEADLINE_MS after
//   the launch: the reading of the report names the failed delivery with what Orca shows of the agent (`blocked`: it
//   waits for a person — a permission, a trust prompt; anything else or nothing: the task did not reach it), by which
//   the caller blocks the task with «сбой агента». A turn seen in time is no failure, however long the agent then
//   works. A message is delivered the same way, with a mark of its own (started-<k>): its turn started when Orca's
//   receipt said so (`turn_started`), when Orca showed a `working` that began after the message's send was recorded —
//   later than its millisecond (its start known: the list, or an event with the main agent's state) —, or when the
//   message's report file appeared; no turn DELIVERY_DEADLINE_MS after its terminal took the line (the time its outcome
//   was recorded) — the failed delivery with what Orca shows of the agent, as for the task.
// - message: its text goes into the file message-<k>.md of the launch, and one line in the project's language naming
//   that file and its own report file report-<k>.md is typed with Enter into the agent's terminal — only through Orca's
//   CLI (src/platform/orca-terminal.ts), one way for any terminal of an agent, in a background worktree or the active
//   one. The host API's `terminal.sendText` is never called (Orca 1.4.274 refuses it a terminal outside the active
//   worktree and does not tell whether the agent started a turn) and there is no fallback through it; the active
//   worktree and the focus of Orca's window never move for a message (`terminal.focus`, `workspace.open`). Each run of
//   the CLI carries the request id of the message, a UUID of the plugin: the same id again makes Orca repeat the
//   outcome, or type the line then if it never saw the request, never twice. Only into the terminal of an agent the
//   plugin launched: before every run of the CLI — the first send and every asking again, before the search for the CLI
//   (its `status` is a run too) and again right before `terminal send` — one check: the launch's directory is the real
//   directory of its task and number in the data directory (no link or file on the way or in its place), its record
//   (launch.json) a regular file there naming this terminal, and the plugin has not closed it — its `closed` mark, or a
//   close Orca confirmed to this worker when the disk refused the mark (written again at the next check); otherwise the
//   CLI does not run. A first send looks for the CLI first, checks again after the search and only then writes the
//   message's files: no CLI, or the check failing, leaves no file of the message. An empty message is an error, and
//   nothing is written. The send is recorded (sending-<k>.json) before the line is typed; its outcome
//   (message-<k>.json) once it is known. «Not sent» only on proof that the line of this request was not typed: the CLI
//   not found or not started, or Orca refusing the line itself (in the form of Orca's refusal, with no receipt beside
//   it) on the first send; a receipt saying the terminal did not take it, in any attempt; the check failing on the
//   first send. Anything else is unknown, also every refusal of asking again: nothing is recorded, the message stays
//   the last input, and the next reading of the report asks Orca again with the same id, unless a send of it runs in
//   this worker now. The sends of one launch and the askings again run one at a time, in the order of their numbers;
//   while the outcome of a message is unknown, a new one is an error and nothing of it is written. A send is under way
//   in this worker from before its record can be seen until its outcome is settled. The caller gets «taken» with the
//   message's report file and whether the turn started, or an error with the reason and its kind: not sent, or unknown.
//   A stop of the task waits for a send that writes its files, and the data directory has one worker of the plugin on
//   the computer, so once the files are written the check right before `terminal send` does not change. The files of a
//   message (its records, its report, its start mark) are read only as regular files of the launch's directory: a link
//   or a directory in their place is an error, never another file's text nor a fall back to an earlier input; a send
//   record is asked about again only with this message's line and report file and a UUID of the plugin.
// - report: on the plugin's last input to the agent — the last message whose send is recorded and is not proven unsent,
//   else the task. While that message's outcome is not known, the reading says why and waits — its start still kept on
//   disk when its report file is there or a turn began after its send. The report is read only from the last input's
//   report file (report.md of the task, report-<k>.md of message k), by one rule: ready only when that report file is
//   there, `agents.list` names the agent in «done», and that «done» began (`stateStartedAt`) no earlier than the file's
//   last write, as precise as the file system keeps it (a fraction of a millisecond is not dropped) — an equal time is
//   ready. The agent writes its report during its turn, so the «done» of that turn begins after the file's last write;
//   an earlier «done» — of an earlier turn, from a late answer of the list, shown with an old start — began before it,
//   and a file written after the «done» began is the draft of a turn still going on. Only the list confirms: an event
//   never makes a report ready (it may lack the start, come late, or tell the end of the agent's session rather than of
//   a turn), and an agent the list does not name has no confirmed report — the case «the agent is gone from Orca» of
//   the watchdog (Ф10), after a restart of the worker as before. The text and the time of the file are read after
//   Orca's answer, with nothing waited for or written between them and the reply, the time after the text — a file
//   changed in between has the later time, so «not ready» — and the text read is the one returned. The rule assumes one
//   computer: the data directory and Orca on it, so the file's time and `stateStartedAt` come from one clock; the
//   report is written by the agent itself. Readiness is a reading at the moment of Orca's answer: the answer of
//   `agents.list` this reading got and the report file read after it (the text, then the time) decide — nothing is
//   waited for or written between that read of the file and the reply, a wait between Orca's answer and the last read
//   of the file is allowed — and what Orca shows after its answer (the agent gone from the list, a new turn that left
//   the file as it was) does not change it: the next reading shows it. The last input is read again after the last wait
//   of the reading — Orca's answer, or a start mark it kept — so a message sent meanwhile is the input of this report
//   (its outcome not recorded yet: the reading waits for it, with no new request to Orca), and from that read to the
//   reply nothing is waited for. When the line was typed the layer does not find out: readiness does not depend on it.
//   A message taken while the agent was still in its earlier turn does not make that turn's «done» confirm it: that
//   «done» began before the last write of the message's report file.
// After a restart of the worker only the disk is kept: the events the former worker heard are gone, and an event of a
// launch the new worker does not know yet (before its first reading of that launch's state or report) leaves no mark.
//
// What each launch leaves in the data directory, <data>/projects/<project>/<task>/agents/<n>/ (n = 1, 2, … in the order
// of the task's launches: the next number is one more than the largest number in the task's agents directory):
// - task.md — the task the agent got, and report.md — its report, which the agent writes;
// - launching.json — role, agent, language, workspace and time, written before Orca is asked; launch.json — Orca's
//   answer: the terminal it opened, or null and the error (also the plugin's own reason when Orca was not asked);
// - message-<k>.md — message k to the agent (k = 1, 2, … in the order of the launch's messages), and report-<k>.md — the
//   agent's report on it; sending-<k>.json — its send: the line, the request id, the time and its report file, written
//   before the line is typed; message-<k>.json — its outcome once known: whether the terminal took the line, whether
//   Orca saw the turn start, when the outcome was recorded, and why it was not taken;
// - started-0 — the agent has started on its task, started-<k> — on message k (the time the plugin saw it);
// - closed — the plugin has closed the agent's terminal.
// Every file is created once and never rewritten, so the records survive a restart of the worker: a new worker stops
// the agents an earlier one launched. A stop reads each launch's records by themselves: a launch whose task file is
// gone is still stopped, one the plugin has closed (its `closed` mark is in its directory) is done whatever its other
// records say, and one whose records cannot be read is reported with the reason while the others are stopped.
// Launches are the real directories with a number for a name: a link (or a junction) or a file there is none — its
// number stays taken — and a link or a file on the way from the data directory to them is an error, so that the
// records of another place are never taken for the task's. The task's identity is copied when a launch or a stop is
// asked for.
import { randomUUID } from 'node:crypto'
import type { OrcaWorkerApi, PluginEvents } from 'orca/worker'
import type { GithubLanguage } from '../github-texts/catalog'
import { errorCode, errorMessage, type DirectoryEntry, type Machine } from '../platform/machine'
import { orcaCliTerminalInput, type TerminalInput } from '../platform/orca-terminal'
import { dataName, dataPath } from '../platform/paths'
import type { Project } from '../protocol'
import { AGENT_ROLES, SETTINGS_FILE, type AgentRole, type ProjectAgents } from '../project/settings'
import { launchPrompt, messageLine } from './task-text'

// The most characters Orca takes in a prompt of `agent.launch`.
export const ORCA_TEXT_MAX = 4096

// How long the agent may take to start on an input of the plugin before the input counts as not delivered: on its task
// from the launch, on a message from the moment its terminal took the line.
export const DELIVERY_DEADLINE_MS = 10 * 60 * 1000

// A request id of the plugin: a random UUID (version 4, as node:crypto's randomUUID makes it).
const PLUGIN_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// How many times a launch, or a message, looks for a free number while others take the ones it found.
const RESERVE_ATTEMPTS = 100

const AGENTS_DIR = 'agents'
const TASK_FILE = 'task.md'
const LAUNCHING_FILE = 'launching.json'
const LAUNCH_FILE = 'launch.json'
const REPORT_FILE = 'report.md'
const CLOSED_FILE = 'closed'

// The files of message k of a launch, and the start marks: started-0 of the task, started-<k> of message k.
const messageFileName = (k: number) => `message-${k}.md`
const messageReportName = (k: number) => `report-${k}.md`
const sendingName = (k: number) => `sending-${k}.json`
const outcomeName = (k: number) => `message-${k}.json`
const startedName = (n: number) => `started-${n}`

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
      // Whether the agent has started on the plugin's last input to it (its task, or the last message): the start mark
      // of that input is on disk.
      readonly started: boolean
      // The report file of the last input — report.md of the task, report-<k>.md of message k — and whether it is there.
      readonly reportFile: string
      readonly reportExists: boolean
      // The report file was last written after the «done» the list shows began: the draft of a turn still going on, or
      // a file written after the turn — not confirmed until the agent ends a new turn.
      readonly writtenAfterDone: boolean
      // While the outcome of the last message is not known — its line is being typed in this worker now, or Orca's
      // answer was lost and asking again did not settle it — why: the report waits for that outcome. Null otherwise.
      readonly unresolved: string | null
      // When the agent has not started on the last input DELIVERY_DEADLINE_MS after the launch (the task) or after its
      // terminal took the line (a message): what Orca shows of the agent (`blocked`: it waits for a person; anything
      // else or null: the input did not reach it) and the reason in words.
      readonly failure: { readonly state: AgentState | null; readonly error: string } | null
    }

// The outcome of a message to the agent.
export type MessageResult =
  // Its terminal took the line: where the agent writes its report on the message, and whether Orca saw the agent
  // start a turn on it.
  | { readonly ok: true; readonly reportFile: string; readonly started: boolean }
  // `not-sent`: proven that nothing of it was typed (or there was nothing to send). `unknown`: the line may have been
  // typed — the report waits, and a reading of the report asks Orca again with the same request id; it is not to be
  // sent anew.
  | { readonly ok: false; readonly outcome: 'not-sent' | 'unknown'; readonly error: string }

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
// The send of message k, written before its line is typed: the line, its request id, when the send was recorded, and
// the report file of the message.
type SendingJson = { line: string; requestId: string; sentAt: number; reportFile: string }
// The outcome of message k, once known: whether its terminal took the line, whether Orca saw the agent start a turn on
// it, when the outcome was recorded — for a line taken, when the terminal took it — and why it was not taken.
type OutcomeJson = { accepted: boolean; turnStarted: boolean; at: number; error: string | null }

// An input of the plugin to the agent: its task (n = 0), or message n, whose send is recorded and not proven unsent.
type Input = {
  readonly n: number
  readonly reportFile: string
  // Message n: its send, and its outcome (null while not known).
  readonly message: { readonly sending: SendingJson; readonly outcome: OutcomeJson | null } | null
}

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
  // The latest start of a turn Orca showed in each terminal, when its start is known (`agents.list`, or an event with
  // the main agent's state): a turn on a message is one that began after the message's send was recorded.
  private readonly turnFrom = new Map<string, number>()
  // The launches this worker knows, by their terminal: a turn heard in one is kept on disk at once.
  private readonly known = new Map<string, AgentLaunch>()
  // Typing a line into an agent's terminal: through this computer's Orca CLI (src/platform/orca-terminal.ts).
  private readonly terminalInput: TerminalInput
  // The launches whose terminal this worker closed (by their directory), Orca having confirmed it: a send's check
  // refuses them even when the disk did not take their `closed` mark, which is then tried again.
  private readonly closedHere = new Set<string>()
  // The messages whose line is being typed — a first send or asking again — in this worker now, by launch and number.
  private readonly typing = new Set<string>()
  // The sends of each launch (a message, or asking again about one), one at a time in the order asked, by its
  // directory: the tail of its queue, and the task's agents directory (a stop of the task waits for them).
  private readonly sends = new Map<string, { readonly task: string; readonly tail: Promise<void> }>()

  constructor(options: AgentsOptions) {
    this.host = options.host
    this.machine = options.machine
    this.dataDir = options.dataDir
    this.terminalInput = orcaCliTerminalInput(options.machine)
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

  // Stops the agents of the task (taken as it is now): refuses its new launches and messages while it runs, waits for
  // its launches under way and for the sends to its agents asked for before it (a message, or asking Orca again about
  // one: one that has not written anything yet is refused, one under way ends first), then closes every terminal the
  // plugin opened for the task and has not closed yet — and no other terminal. A launch the plugin has closed (its
  // `closed` mark is there) is done, whatever else its records say. A terminal Orca refuses to close counts as closed
  // when a complete list of its workspace no longer names it. A launch whose terminal is unknown — Orca's answer not
  // recorded, its records unreadable — is reported with the reason, and the other launches are stopped all the same. A
  // close Orca confirmed counts for the checks of this worker's sends even when the disk refuses the `closed` mark.
  // Rejects only for a task key that is not one.
  async stop(task: TaskRef): Promise<StopResult> {
    const place = this.place(task)
    const key = place.dir
    this.stopping.set(key, (this.stopping.get(key) ?? 0) + 1)
    try {
      await Promise.all([...(this.pending.get(key) ?? [])].map((running) => running.catch(() => undefined)))
      await Promise.all([...this.sends.values()].filter((queue) => queue.task === key).map((queue) => queue.tail))
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
        // Orca confirmed the close (or the terminal is gone): this worker knows it before, and whether or not, the disk
        // keeps the mark — the check of every send sees either.
        this.closedHere.add(record.dir)
        await this.keepClosed(record.dir).catch(() => undefined)
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
  // at once as the start of its task — and of its last message, when the turn began after that message's send was
  // recorded.
  onStatus(event: StatusEvent): void {
    const terminalId = event.terminalId
    if (terminalId === undefined || terminalId === '') return
    const main = event.mainAgent
    const since = main !== undefined && main.state === event.state ? main.stateStartedAt : null
    const latest = this.heard.get(terminalId)
    if (latest === undefined || latest.since === null || since === null || since >= latest.since) {
      this.heard.set(terminalId, { state: event.state, since })
    }
    if (event.state === 'working') this.turnSeen(terminalId, since)
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

  // The report on the plugin's last input to the agent — its task, or the last message whose send is recorded and not
  // proven unsent: ready only when that input's report file is there, `agents.list` names the agent in «done», and that
  // «done» began no earlier than the file's last write; then with the file's text. Otherwise what is missing, the
  // failed delivery when the agent has not started on the input DELIVERY_DEADLINE_MS after the launch (the task) or
  // after its terminal took the line (a message), and — while the last message's outcome is not known — why: then the
  // report waits, and, unless a send of that message runs in this worker now, Orca is first asked again with the same
  // request id. Rejects when Orca's list cannot be read, and when the plugin's records of the inputs, or a start mark,
  // cannot be read from the disk or kept there.
  async report(launch: AgentLaunch): Promise<ReportReading> {
    this.know(launch)
    const asked = await this.askAgain(launch)
    let agents: ListedAgent[]
    try {
      agents = (await this.host.call('agents.list', { workspaceId: launch.workspaceId })).agents
    } catch (error) {
      throw unreadableList(launch, error)
    }
    const seen = this.seen(launch, agents)
    const doneSince = seen !== null && seen.listed && seen.state === 'done' ? seen.since : null
    const state = seen?.state ?? null
    const listed = seen?.listed ?? false
    // The start marks this reading kept: on disk.
    const kept = new Set<number>()
    for (;;) {
      // The last input is read after the last wait — Orca's answer, or a start mark this reading kept: a message sent
      // meanwhile is the input this report is about. From this read to the reply nothing waits.
      const input = this.lastInput(launch)
      if (input.message !== null && input.message.outcome === null) {
        // Its outcome is not known: the report waits for it, with no new request to Orca in this reading. The start of
        // the agent on it — its report file there, or a turn begun after its send was recorded — is kept on disk all
        // the same, and then the last input and its file are read again.
        const started = kept.has(input.n) || this.startedOnDisk(launch, input.n)
        const file = this.readInputReport(launch, input)
        if (!started && (file.text !== null || this.turnOn(launch, input))) {
          await this.keepStarted(launch, input.n)
          kept.add(input.n)
          continue
        }
        return {
          ready: false,
          state,
          listed,
          started,
          reportFile: input.reportFile,
          reportExists: file.text !== null && file.writtenAt !== null,
          writtenAfterDone: false,
          unresolved: this.unresolved(launch, input.n, asked),
          failure: null,
        }
      }
      // The start of the input is settled after Orca's answer and before its report file is read for the reply. On
      // disk already: started. Not yet, while the agent has started on it — a turn this worker saw (Orca's answer
      // included; for a message, one that began after its send was recorded, or the start in Orca's receipt),
      // or the report file read here — it is kept on disk first (a mark that cannot be read or kept is an error), and
      // the last input and its file are read again. So the reply's `started` is the mark on disk, and from the reads it
      // is given on to the reply nothing waits and nothing is written: the text first, then the time of the file's last
      // write — a file changed between the two reads has the later time.
      const started = kept.has(input.n) || this.startedOnDisk(launch, input.n)
      const { text, writtenAt } = this.readInputReport(launch, input)
      if (!started && (text !== null || this.turnOn(launch, input))) {
        await this.keepStarted(launch, input.n)
        kept.add(input.n)
        continue
      }
      const exists = text !== null && writtenAt !== null
      if (exists && doneSince !== null && doneSince >= writtenAt) return { ready: true, text, reportFile: input.reportFile }
      // The deadline counts from the launch for the task, from the moment its terminal took the line for a message.
      const outcome = input.message?.outcome ?? null
      const from = outcome === null ? launch.launchedAt : outcome.at
      const late = !started && this.machine.now() - from >= DELIVERY_DEADLINE_MS
      return {
        ready: false,
        state,
        listed,
        started,
        reportFile: input.reportFile,
        reportExists: exists,
        writtenAfterDone: exists && doneSince !== null && writtenAt > doneSince,
        unresolved: null,
        failure: late ? { state, error: notDelivered(launch, input.n, state) } : null,
      }
    }
  }

  // A message to the agent: its text goes into the file message-<k>.md of the launch (k = 1, 2, … in order), and one
  // line in the project's language naming that file and its own report file report-<k>.md is typed with Enter into the
  // launch's terminal — only through Orca's CLI, as the request of a new id, with the send recorded (sending-<k>.json)
  // before the line is typed and its outcome (message-<k>.json) once known. Only into the terminal of this launch's
  // record that the plugin has not closed: another terminal (the owner's, another agent's) is an error, nothing is
  // written and nothing runs. The sends of one launch run one at a time in the order asked; while the outcome of the
  // previous message is not known, a new one is an error and nothing of it is written. While a stop of the task runs, a
  // message is an error and nothing of it is written; a stop begun once it has written its files waits for it. An empty
  // message is an error.
  message(launch: AgentLaunch, text: string): Promise<MessageResult> {
    if (text.trim() === '') return Promise.resolve(unsent('the message is empty'))
    const taskDir = this.taskDir(launch)
    if (taskDir === null) return Promise.resolve(unsent(this.notOwnTerminal(launch) ?? `not a launch of the plugin: ${launch.dir}`))
    if (this.isStopping(taskDir)) return Promise.resolve(unsent(stoppingMessages(launch)))
    return this.oneAtATime(launch, taskDir, async () => {
      const refused = this.mayNotSend(launch, taskDir)
      if (refused !== null) return unsent(refused)
      this.know(launch)
      // Orca's CLI is looked for before anything of the message is written: without it, nothing is.
      const missing = await this.terminalInput.ready()
      if (missing !== null) return unsent(`a message to the agent "${launch.agent}" in terminal ${launch.terminalId} was not sent: ${missing}`)
      // Checked again after the search, with nothing waited for between this check and the start of the first write: a
      // stop of the task begun meanwhile, or the terminal closed by the plugin, leaves no file of the message.
      const changed = this.mayNotSend(launch, taskDir)
      if (changed !== null) return unsent(changed)
      return this.send(launch, text)
    })
  }

  // Why no new message may be sent to the launch's agent now, or null: a stop of its task runs (begun while this
  // waited for the sends before it), the terminal is not one the plugin may type into, or the outcome of the previous
  // message is not known (or its records cannot be read).
  private mayNotSend(launch: AgentLaunch, taskDir: string): string | null {
    if (this.isStopping(taskDir)) return stoppingMessages(launch)
    const foreign = this.notOwnTerminal(launch)
    if (foreign !== null) return foreign
    let last: Input
    try {
      last = this.lastInput(launch)
    } catch (error) {
      return errorMessage(error)
    }
    if (last.message !== null && last.message.outcome === null) {
      return `the outcome of message ${last.n} to the agent is not known yet: a new message goes only once it is known (a reading of the report asks Orca again)`
    }
    return null
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
        await this.keepStarted(launch, 0)
      } catch (error) {
        return failure(
          'launch-failed',
          `the agent "${agent}" (${field}) was launched in terminal ${terminalId} and started its task before Orca answered the launch, but ${errorMessage(error)}; the terminal stays open, and a stop of the task closes it`,
        )
      }
    }
    return { ok: true, launch }
  }

  // Message k: reserves its number with its file, records its send — the line, a new request id, the time and its
  // report file — and types the line (deliver).
  private async send(launch: AgentLaunch, text: string): Promise<MessageResult> {
    let k: number
    try {
      k = await this.reserveMessage(launch, text)
    } catch (error) {
      return unsent(`the message could not be written to the data directory: ${errorMessage(error)}`)
    }
    const reportFile = dataPath(this.machine, launch.dir, messageReportName(k))
    const line = messageLine(launch.language, dataPath(this.machine, launch.dir, messageFileName(k)), reportFile)
    // One line: a line break would submit it before its end. Without its send recorded, message k is no input.
    if (/[\r\n]/.test(line)) return unsent(`message ${k}: the paths of its files break the one-line message`)
    const sending: SendingJson = { line, requestId: randomUUID(), sentAt: this.machine.now(), reportFile }
    // Under way in this worker from before its send record can be seen until its outcome is settled: a reading of the
    // report meanwhile waits for the outcome, and does not ask Orca itself.
    const key = typingKey(launch, k)
    this.typing.add(key)
    try {
      try {
        await this.createRecord(launch.dir, sendingName(k), sending)
      } catch (error) {
        return unsent(`the send of message ${k} could not be recorded: ${errorMessage(error)}`)
      }
      return await this.deliver(launch, k, sending, 'first')
    } finally {
      this.typing.delete(key)
    }
  }

  // Types the recorded line of message k into the launch's terminal as its request, and records the outcome once it is
  // known: the first send (from message), or asking again about a send whose outcome is not known (from report — the
  // same request id makes Orca repeat the outcome, or type the line then if it never saw the request). The boundary is
  // checked before every run of the CLI: before its search (whose `status` is a run too), and again once it is found,
  // right before `terminal send`. «Not taken» is recorded only on proof that the line of this request was not
  // typed: on the first send, the boundary failing, the CLI not found or not started, or Orca refusing the line itself;
  // in any attempt, Orca's receipt saying the terminal did not take it. Asking again, no refusal decides anything: the
  // outcome stays unknown and nothing is written.
  private async deliver(launch: AgentLaunch, k: number, sending: SendingJson, attempt: 'first' | 'again'): Promise<MessageResult> {
    const target = `message ${k} to the agent "${launch.agent}" in terminal ${launch.terminalId}`
    const unknown = (reason: string): MessageResult => ({ ok: false, outcome: 'unknown', error: `the outcome of ${target} is unknown: ${reason}` })
    const notTaken = async (reason: string): Promise<MessageResult> => {
      try {
        await this.createRecord(launch.dir, outcomeName(k), { accepted: false, turnStarted: false, at: this.machine.now(), error: reason })
      } catch (error) {
        return unknown(`it was not sent (${reason}), but this could not be recorded (${errorMessage(error)}), so a reading of the report asks Orca about it again`)
      }
      return unsent(`${target} was not sent: ${reason}`)
    }
    const foreign = this.notOwnTerminal(launch)
    if (foreign !== null) return attempt === 'first' ? notTaken(foreign) : unknown(foreign)
    const sent = await this.terminalInput.send(launch.terminalId, sending.line, sending.requestId, () => this.notOwnTerminal(launch))
    if (!sent.ok) return attempt === 'first' && sent.delivery === 'not-sent' ? notTaken(sent.error) : unknown(sent.error)
    if (!sent.accepted) return notTaken(`the terminal did not take the line: ${sent.refusedReason ?? 'Orca gave no reason'}`)
    try {
      await this.createRecord(launch.dir, outcomeName(k), { accepted: true, turnStarted: sent.turnStarted, at: this.machine.now(), error: null })
    } catch (error) {
      return unknown(`its terminal took the line, but this could not be recorded (${errorMessage(error)}), so a reading of the report asks Orca about it again`)
    }
    // The start Orca saw, kept as a mark too; when the disk refuses it, a reading of the report keeps it or says why.
    if (sent.turnStarted) await this.keepStarted(launch, k).catch(() => undefined)
    return { ok: true, reportFile: sending.reportFile, started: sent.turnStarted }
  }

  // The last message's outcome not known and no send of it running in this worker now: Orca is asked again with its
  // request id, after the sends of the launch before it. What asking again left unknown, and why; null otherwise.
  private async askAgain(launch: AgentLaunch): Promise<{ readonly n: number; readonly error: string } | null> {
    const before = this.lastInput(launch)
    const message = before.message
    const key = typingKey(launch, before.n)
    if (message === null || message.outcome !== null || this.typing.has(key)) return null
    // While a stop of the task runs, Orca is not asked: the stop closes the terminal.
    const taskDir = this.taskDir(launch)
    const stopping = { n: before.n, error: `the outcome of message ${before.n} to the agent is not known yet: ${stoppingMessages(launch)}` }
    if (taskDir !== null && this.isStopping(taskDir)) return stopping
    const result = await this.oneAtATime(launch, taskDir ?? launch.dir, async (): Promise<MessageResult | null> => {
      if (taskDir !== null && this.isStopping(taskDir)) return { ok: false, outcome: 'unknown', error: stopping.error }
      // Settled, or being typed, while this waited for the sends before it: nothing to ask.
      const current = this.lastInput(launch)
      if (current.n !== before.n || current.message === null || current.message.outcome !== null || this.typing.has(key)) return null
      this.typing.add(key)
      try {
        return await this.deliver(launch, before.n, message.sending, 'again')
      } finally {
        this.typing.delete(key)
      }
    })
    return result !== null && !result.ok ? { n: before.n, error: result.error } : null
  }

  // Why the report waits for the outcome of message n.
  private unresolved(launch: AgentLaunch, n: number, asked: { readonly n: number; readonly error: string } | null): string {
    if (this.typing.has(typingKey(launch, n))) return `message ${n} is being typed into the agent's terminal`
    if (asked !== null && asked.n === n) return asked.error
    return `the outcome of message ${n} to the agent is not known yet: the next reading of the report asks Orca again`
  }

  // The plugin's last input to the agent: the message of the largest number whose send is recorded (sending-<k>.json)
  // and whose outcome is not «not taken» — taken, or not known yet — otherwise its task. A send record must hold the
  // very line and report file the plugin makes for message k of this launch: asking again types its line. Throws when
  // a record of the messages cannot be read or is not one: the last input is then not known.
  private lastInput(launch: AgentLaunch): Input {
    const entries = this.messageEntries(launch)
    const numbers = entries
      .map((entry) => this.numberOf(entry.name, 'sending-', '.json'))
      .filter((k): k is number => k !== null)
      .sort((a, b) => b - a)
    for (const k of numbers) {
      const sending = parseSending(this.readMessageRecord(launch, entries, sendingName(k)))
      const reportFile = dataPath(this.machine, launch.dir, messageReportName(k))
      const line = messageLine(launch.language, dataPath(this.machine, launch.dir, messageFileName(k)), reportFile)
      if (sending === null || sending.reportFile !== reportFile || sending.line !== line || !PLUGIN_UUID.test(sending.requestId)) {
        throw new Error(`${dataPath(this.machine, launch.dir, sendingName(k))} is not the plugin's record of the send of message ${k}`)
      }
      const outcomeText = this.readMessageRecord(launch, entries, outcomeName(k))
      const outcome = parseOutcome(outcomeText)
      if (outcomeText !== null && outcome === null) {
        throw new Error(`${dataPath(this.machine, launch.dir, outcomeName(k))} is not the record of a message's outcome`)
      }
      if (outcome !== null && !outcome.accepted) continue
      return { n: k, reportFile: sending.reportFile, message: { sending, outcome } }
    }
    return { n: 0, reportFile: launch.reportFile, message: null }
  }

  // What the launch's directory holds, as the directory has it (a link is a link). Throws when it cannot be listed.
  private messageEntries(launch: AgentLaunch): DirectoryEntry[] {
    try {
      return this.machine.listEntries(launch.dir) ?? []
    } catch (error) {
      throw new Error(`the messages of launch ${launch.number} cannot be listed in ${launch.dir}: ${errorMessage(error)}`)
    }
  }

  // A record of the plugin's messages in the launch's directory, read only as a regular file of that directory: null
  // when there is none; a link, a directory or anything else in its place is an error — never another file's text, and
  // never a reason to fall back to an earlier input. A file that cannot be read is an error too.
  private readMessageRecord(launch: AgentLaunch, entries: readonly DirectoryEntry[], name: string): string | null {
    const path = dataPath(this.machine, launch.dir, name)
    const entry = entries.find((each) => this.sameName(each.name, name))
    if (entry === undefined) return null
    if (entry.kind !== 'file') throw new Error(`${path} is a link or a directory, not a record of the plugin's messages: it is not read`)
    try {
      return this.machine.readText(path)
    } catch (error) {
      throw new Error(`${path} cannot be read: ${errorMessage(error)}`)
    }
  }

  // The report file of the input: of the task by the rule of report.md; of message k only as a regular file of the
  // launch's directory (a link in its place is an error, never the text of another report), then its text and time.
  private readInputReport(launch: AgentLaunch, input: Input): { readonly text: string | null; readonly writtenAt: number | null } {
    if (input.message !== null) {
      const name = messageReportName(input.n)
      const entry = this.messageEntries(launch).find((each) => this.sameName(each.name, name))
      if (entry === undefined) return { text: null, writtenAt: null }
      if (entry.kind !== 'file') {
        throw new Error(`${input.reportFile} is a link or a directory, not the report on message ${input.n}: it is not read`)
      }
    }
    return this.readReportFile(input.reportFile)
  }

  // The number k of a file name `<prefix><k><suffix>` (k a whole number from 1, no leading zero), as the system's file
  // names compare; null for any other name.
  private numberOf(name: string, prefix: string, suffix: string): number | null {
    const same = (a: string, b: string) => this.sameName(a, b)
    if (name.length <= prefix.length + suffix.length) return null
    if (!same(name.slice(0, prefix.length), prefix) || !same(name.slice(name.length - suffix.length), suffix)) return null
    return launchNumber(name.slice(prefix.length, name.length - suffix.length))
  }

  // The next message of the launch: one more than the largest number any file of a message has there — its text, send,
  // outcome, report or start mark — taken by creating its message file with the text (only one send can create it);
  // when another took that number meanwhile, the next one. So a message never finds a report file it did not ask for.
  private async reserveMessage(launch: AgentLaunch, text: string): Promise<number> {
    const named: readonly (readonly [string, string])[] = [
      ['message-', '.md'],
      ['sending-', '.json'],
      ['message-', '.json'],
      ['report-', '.md'],
      ['started-', ''],
    ]
    for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt++) {
      const largest = (this.machine.listEntries(launch.dir) ?? []).reduce(
        (most, entry) => Math.max(most, ...named.map(([prefix, suffix]) => this.numberOf(entry.name, prefix, suffix) ?? 0)),
        0,
      )
      const k = largest + 1
      if (await this.machine.createText(dataPath(this.machine, launch.dir, messageFileName(k)), text)) return k
    }
    throw new Error(`no free message number in ${launch.dir} in ${RESERVE_ATTEMPTS} attempts`)
  }

  // The boundary of every line typed through Orca's CLI, checked before each run of it (the first send and every
  // asking again, before the search for the CLI and right before `terminal send`): the launch is the plugin's — its
  // directory is the one of its task and number in the data directory, reached through real directories only (a link
  // or a file on the way, or a link in place of the launch's directory, is none of the plugin's launches), its record
  // of Orca's answer (launch.json) a regular file there naming this very terminal — and the plugin has not closed it
  // (no `closed` mark there). Null when it holds; otherwise why nothing may be typed into the terminal.
  private notOwnTerminal(launch: AgentLaunch): string | null {
    const refused = (why: string) => `the terminal ${launch.terminalId} is not one the plugin may type into: ${why}; nothing is typed into it`
    const which = `launch ${launch.number} of ${launch.task.key}`
    let place: TaskPlace
    let dir: string
    try {
      place = this.place(launch.task)
      dir = this.launchFiles(place, launch.number).dir
    } catch (error) {
      return refused(errorMessage(error))
    }
    if (dir !== launch.dir) return refused(`the launch's directory ${launch.dir} is not the one of ${which} (${dir})`)
    let entries: DirectoryEntry[] | null
    try {
      const entry = this.agentsEntries(place)?.find((each) => this.sameName(each.name, String(launch.number)))
      if (entry === undefined) return refused(`${which} has no record of a terminal Orca opened`)
      if (entry.kind !== 'directory') return refused(`${dir} is a link or a file, not the directory of ${which}`)
      entries = this.machine.listEntries(dir)
    } catch (error) {
      return refused(`the records of ${which} cannot be read: ${errorMessage(error)}`)
    }
    const has = (name: string) => (entries ?? []).find((each) => this.sameName(each.name, name))
    const record = has(LAUNCH_FILE)
    if (record === undefined) return refused(`${which} has no record of a terminal Orca opened`)
    const path = dataPath(this.machine, dir, LAUNCH_FILE)
    if (record.kind !== 'file') return refused(`${path} is a link or a directory, not the record of ${which}`)
    let recorded: LaunchJson | null
    try {
      recorded = parseLaunch(this.machine.readText(path))
    } catch (error) {
      return refused(`the record of ${which} cannot be read: ${errorMessage(error)}`)
    }
    if (recorded === null) return refused(`${which} has no record of a terminal Orca opened`)
    if (recorded.terminalId !== launch.terminalId) {
      return refused(`it is not the terminal of ${which}, which is ${recorded.terminalId ?? 'none'}`)
    }
    if (has(CLOSED_FILE) !== undefined) return refused(`the plugin has closed it (${which})`)
    if (this.closedHere.has(dir)) {
      // Closed by this worker, its mark not on disk: tried again, with no caller to tell.
      this.keepClosed(dir).catch(() => undefined)
      return refused(`the plugin has closed it (${which})`)
    }
    return null
  }

  // Keeps on disk, once, that the plugin has closed the terminal of the launch in `dir`.
  private async keepClosed(dir: string): Promise<void> {
    await this.machine.createText(dataPath(this.machine, dir, CLOSED_FILE), `${this.machine.now()}\n`)
  }

  // Runs `body` once every earlier send of the launch has ended: the sends of one launch — messages, and asking again
  // about one — never overlap, and go in the order asked.
  private async oneAtATime<T>(launch: AgentLaunch, task: string, body: () => Promise<T>): Promise<T> {
    const previous = this.sends.get(launch.dir)?.tail ?? Promise.resolve()
    let release = () => {}
    const done = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => done)
    this.sends.set(launch.dir, { task, tail })
    await previous
    try {
      return await body()
    } finally {
      release()
      if (this.sends.get(launch.dir)?.tail === tail) this.sends.delete(launch.dir)
    }
  }

  // The agents directory of the launch's task, or null when its task is no task of the plugin.
  private taskDir(launch: AgentLaunch): string | null {
    try {
      return this.place(launch.task).dir
    } catch {
      return null
    }
  }

  // From now on the worker knows the launch: a turn already heard in its terminal, and every later one, is kept on disk
  // as the start of the inputs it is on.
  private know(launch: AgentLaunch): void {
    this.known.set(launch.terminalId, launch)
    this.keepTurnLater(launch)
  }

  // What Orca shows of the launch's agent, from Orca's answer to `agents.list` of its workspace: its entry there, else
  // the latest event this worker heard for its terminal; null when there is neither.
  private seen(launch: AgentLaunch, agents: readonly ListedAgent[]): Seen | null {
    const entry = agents.find((agent) => agent.terminalId === launch.terminalId)
    if (entry === undefined) {
      const heard = this.heard.get(launch.terminalId)
      return heard === undefined ? null : { ...heard, listed: false }
    }
    if (entry.state === 'working') this.turnSeen(launch.terminalId, entry.stateStartedAt)
    return { state: entry.state, since: entry.stateStartedAt, listed: true }
  }

  // Orca showed an agent's turn in the terminal, begun at `since` (null: not said): for a launch the worker knows, the
  // inputs it is on have started.
  private turnSeen(terminalId: string, since: number | null): void {
    this.turns.add(terminalId)
    const latest = this.turnFrom.get(terminalId)
    if (since !== null && (latest === undefined || since > latest)) this.turnFrom.set(terminalId, since)
    const launch = this.known.get(terminalId)
    if (launch !== undefined) this.keepTurnLater(launch)
  }

  // Whether a turn of the agent on the input is known besides its mark: for the task, any turn Orca showed in the
  // launch's terminal; for a message, the start in Orca's receipt, or a turn that began after the message's send was
  // recorded — later than its millisecond: one begun in the same millisecond may have begun before the record.
  private turnOn(launch: AgentLaunch, input: Input): boolean {
    if (input.message === null) return this.turns.has(launch.terminalId)
    const from = this.turnFrom.get(launch.terminalId)
    return input.message.outcome?.turnStarted === true || (from !== undefined && from > input.message.sending.sentAt)
  }

  // The turns Orca showed in the launch's terminal, kept on disk with no caller to tell: the start of the task, and of
  // the last message when a turn began after its send was recorded (or Orca's receipt saw it start). A record
  // that cannot be read leaves the marks to the next reading of the report.
  private keepTurnLater(launch: AgentLaunch): void {
    if (!this.turns.has(launch.terminalId)) return
    this.keepStartedLater(launch, 0)
    let input: Input
    try {
      input = this.lastInput(launch)
    } catch {
      return
    }
    if (input.message !== null && this.turnOn(launch, input)) this.keepStartedLater(launch, input.n)
  }

  // A report file: its text — a directory or anything else that is not a file to read there is an error, never a
  // report — then the time of its last write.
  private readReportFile(reportFile: string): { readonly text: string | null; readonly writtenAt: number | null } {
    const text = this.machine.readText(reportFile)
    return { text, writtenAt: text === null ? null : this.machine.modifiedAt(reportFile) }
  }

  // Whether the start of input n — the task (0) or message n — is on disk (started-<n>). A mark that cannot be read is
  // an error, never «not started»: it may be there.
  private startedOnDisk(launch: AgentLaunch, n: number): boolean {
    const path = dataPath(this.machine, launch.dir, startedName(n))
    // The mark of a message: only a regular file of the launch's directory.
    if (n > 0) {
      const entry = this.messageEntries(launch).find((each) => this.sameName(each.name, startedName(n)))
      if (entry === undefined) return false
      if (entry.kind !== 'file') {
        throw new Error(`the start of message ${n} of launch ${launch.number} cannot be read from ${path}: a link or a directory is no mark`)
      }
    }
    try {
      return this.machine.readText(path) !== null
    } catch (error) {
      throw new Error(`the start of ${inputName(n)} of launch ${launch.number} cannot be read from ${path}: ${errorMessage(error)}`)
    }
  }

  // Keeps on disk, once, that the agent has started on input n. Rejects when the mark can be neither read nor written.
  private async keepStarted(launch: AgentLaunch, n: number): Promise<void> {
    if (this.startedOnDisk(launch, n)) return
    const path = dataPath(this.machine, launch.dir, startedName(n))
    try {
      await this.machine.createText(path, `${this.machine.now()}\n`)
    } catch (error) {
      throw new Error(`the start of ${inputName(n)} of launch ${launch.number} could not be kept in ${path}: ${errorMessage(error)}`)
    }
  }

  // The same for a turn Orca reports with no caller to tell: when the disk refuses it, the worker still knows the turn,
  // and the next reading of the report keeps it on disk or rejects with the reason.
  private keepStartedLater(launch: AgentLaunch, n: number): void {
    this.keepStarted(launch, n).catch(() => undefined)
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
  private async createRecord(dir: string, name: string, value: LaunchingJson | LaunchJson | SendingJson | OutcomeJson): Promise<void> {
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

// The failed delivery of input n — the task (0) or message n — with what Orca shows of the agent.
function notDelivered(launch: AgentLaunch, n: number, state: AgentState | null): string {
  const minutes = DELIVERY_DEADLINE_MS / 60_000
  const agent = `the agent "${launch.agent}" in terminal ${launch.terminalId}`
  const after = n === 0 ? 'after the launch' : 'after its terminal took the line'
  if (state === 'blocked') {
    return `${agent} has not started on ${n === 0 ? 'its task' : `message ${n}`} in ${minutes} minutes ${after}: Orca shows it blocked — it waits for a person (a permission, a trust prompt)`
  }
  const shows = state === null ? 'Orca shows nothing of it' : `Orca shows it ${state}`
  return `${n === 0 ? 'the task' : `message ${n}`} did not reach ${agent}: no turn in ${minutes} minutes ${after} (${shows})`
}

// Input n in words: the task (0), or message n.
function inputName(n: number): string {
  return n === 0 ? 'the task' : `message ${n}`
}

// A message that was not sent: nothing of it was typed.
function unsent(error: string): MessageResult {
  return { ok: false, outcome: 'not-sent', error }
}

// A message of a launch, as the sends under way in this worker know it.
function typingKey(launch: AgentLaunch, k: number): string {
  return `${launch.dir}#${k}`
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

// A message, or asking Orca again about one, while a stop of the launch's task runs.
function stoppingMessages(launch: AgentLaunch): string {
  return `${stoppingReason(launch.task)}: nothing more is typed into their terminals`
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

function parseSending(text: string | null): SendingJson | null {
  const json = parseJson(text)
  if (json === null) return null
  const { line, requestId, sentAt, reportFile } = json
  if (typeof line !== 'string' || typeof requestId !== 'string' || typeof sentAt !== 'number' || typeof reportFile !== 'string') {
    return null
  }
  return { line, requestId, sentAt, reportFile }
}

function parseOutcome(text: string | null): OutcomeJson | null {
  const json = parseJson(text)
  if (json === null) return null
  const { accepted, turnStarted, at, error } = json
  if (typeof accepted !== 'boolean' || typeof turnStarted !== 'boolean' || typeof at !== 'number' || (error !== null && typeof error !== 'string')) {
    return null
  }
  return { accepted, turnStarted, at, error }
}
