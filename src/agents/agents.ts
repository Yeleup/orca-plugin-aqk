// The agents of the queue (TZ «Пользователи и роли»): the implementer, the reviewer, the solver and the MVP start agent
// are the Orca agents of the project's settings (`agents` of .agent-queue.json). This is the worker's common layer for
// all of them:
//
// - launch: the agent of a role starts through Orca's API (`agent.launch`) in a workspace — a task's worktree, or the
//   main checkout for the start agent — in a new background terminal Orca opens there. Its task is a file in the
//   plugin's data directory; the one-line prompt names that file and the report file beside it. Orca returns once the
//   terminal exists and sends the prompt by itself once the agent is ready (Orca 1.4.274 only logs a prompt that does
//   not get through), so the launch is not yet the task's delivery.
// - delivery: an input of the plugin — the task, then each message — has reached the agent once Orca shows the agent
//   start a turn (`working`) after it, the CLI saw the turn start, or the input's report file appears; the plugin keeps
//   that on disk (started-<n>), so a restart of the worker does not forget it — also for a turn heard in the launch's
//   terminal before Orca answered the launch. An input the agent has not started on DELIVERY_DEADLINE_MS after it — the
//   launch for the task, the terminal taking the line for a message — is reported with what Orca shows of the agent
//   (`blocked` — it waits for a person; anything else — the input did not reach it), the reason for «сбой агента».
// - state: working, blocked, waiting or done. When `agents.list` lists the agent, its answer is Orca's current state and
//   counts (with `stateStartedAt`); otherwise the latest `agent.status.changed`, whose start is known only from the
//   main agent's state (`mainAgent.stateStartedAt`).
// - report: each input names a report file of its own. The report is ready only when the agent is in a «done» that
//   began after the last input — or, for an event without its start, that Orca reported after the agent's turn on the
//   input — AND that input's report file exists; a report of an earlier input never counts for a later one. The last
//   input is read again after the wait for `agents.list`, so a message sent meanwhile is the input the report is about.
//   For an agent `agents.list` does not name, only the events this very worker heard confirm a report: after a restart
//   of the worker such a report is not confirmed — that is the case «the agent is gone from Orca» (Ф10, the watchdog).
// - message: its text goes into a file; one line naming that file and the report file is typed into the agent's
//   terminal through Orca's CLI (src/platform/orca-terminal.ts) — one way for every terminal of an agent, in a
//   background worktree or the active one; the host API's `terminal.sendText` is never called, and the focus of
//   Orca's window never moves for a message. Only into the terminal of an agent the plugin launched: before every run of
//   the CLI — the first send and every asking again — the terminal must be the one of the launch's record and not
//   closed by the plugin, or nothing runs. The send is recorded with its request id before the line is typed. Not sent
//   — proven nothing was typed: the CLI not found or not started, Orca refusing the line itself, or Orca's receipt
//   saying the terminal did not take it. Otherwise (Orca unreachable, no answer, asking again refused) the outcome is
//   unknown: the report waits, and the next report asks Orca again with the same request id, which replays the outcome
//   — or types the line then, if Orca never saw the request — instead of typing it twice. Either way message() is an
//   error with the reason.
// - stop: closes the terminals the plugin opened for this task, and no other terminal; it waits for the task's launches
//   still waiting for Orca, and a launch of the task asked for while the stop runs is refused.
// - an agent Orca does not know, or a launch that fails: an error naming the agent and the reason (by it the later
//   tasks block the task with «сбой агента»); for an agent Orca does not know Orca starts nothing.
//
// What each launch leaves in the data directory, <data>/projects/<project>/<task>/agents/<n>/ (n = 1, 2, … in the order
// of the task's launches):
// - task.md — the task the agent got, and report.md — its report, which the agent writes;
// - launching.json — role, agent, language, workspace and time, written before Orca is asked; launch.json — Orca's
//   answer: the terminal it opened, or null and the error;
// - message-<k>.md — a message's text, report-<k>.md — the agent's report on it; sending-<k>.json — the line, its
//   request id and time, written before the line is typed; message-<k>.json — the outcome: whether the terminal took
//   it, whether Orca saw a turn start, and when it was recorded;
// - started-0 (the task), started-<k> (message k) — when the agent was seen starting on that input;
// - closed — the plugin has closed the agent's terminal.
// Every file is created once and never rewritten, so the records survive a restart of the worker: a new worker stops
// the agents an earlier one launched.
import { randomUUID } from 'node:crypto'
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

// An agent's state and when it began; null when Orca did not say (an event without the main agent's state).
export type StateReading = { readonly state: AgentState; readonly since: number | null }

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
      // While the last message's outcome is unknown — the plugin is still typing it, or Orca's answer was lost and
      // asking again failed — why; the report waits until Orca answers.
      readonly unresolved: string | null
      // When the agent has not started on the last input DELIVERY_DEADLINE_MS after it: what Orca shows of the agent
      // (`blocked`: it waits for a person, e.g. a permission or trust prompt; anything else or null: the input did not
      // reach it) and the reason in words.
      readonly failure: { readonly state: AgentState | null; readonly error: string } | null
    }

export type MessageResult =
  // `reportFile`: where the agent writes its report on this message; `started`: Orca saw it start a turn on it.
  | { readonly ok: true; readonly reportFile: string; readonly started: boolean }
  // `not-sent`: nothing was typed. `unknown`: the line may have been typed; the report waits, and the plugin asks Orca
  // again with the same request id (report) — it is not to be sent anew.
  | { readonly ok: false; readonly outcome: 'not-sent' | 'unknown'; readonly error: string }

export type StopResult = {
  // The terminals closed now (or found already gone), in the order of their launches.
  readonly closed: readonly string[]
  // What could not be stopped, and why: a terminal Orca did not close, or a launch whose terminal is unknown.
  readonly failed: readonly { readonly launch: number; readonly terminalId: string | null; readonly error: string }[]
}

type WorkerHost = OrcaWorkerApi['host']

type LaunchingJson = { role: AgentRole; agent: string; language: GithubLanguage; workspaceId: string; launchedAt: number }
type LaunchJson = { terminalId: string | null; error: string | null }
type SendingJson = { sentAt: number; line: string; requestId: string; reportFile: string }
// `at`: when the outcome was recorded — for a message the terminal took, when it took the line.
type OutcomeJson = { taken: boolean; turnStarted: boolean; at: number; error: string | null }

// An input of the plugin to the agent: its task (n = 0) or message n.
type Input = {
  readonly n: number
  // When it was given: a turn from then on may be on it.
  readonly at: number
  // Since when its delivery is timed: the launch for the task, the terminal taking the line for a message.
  readonly deadlineFrom: number
  readonly reportFile: string
  // Message: its send, and whether its outcome is recorded.
  readonly sending: SendingJson | null
  readonly resolved: boolean
  // Whether the agent was seen starting on it: the CLI's receipt, or the started-<n> mark.
  readonly started: boolean
}

// What the worker last heard of an agent's state: `since` — when the state began, null when Orca did not say;
// `seq` — the order in which this worker heard it.
type Observation = { readonly state: AgentState; readonly since: number | null; readonly seq: number }

export type AgentsOptions = {
  readonly host: WorkerHost
  readonly machine: Machine
  readonly dataDir: string
  // Typing a line into an agent's terminal (by default through this computer's Orca CLI).
  readonly terminalInput: TerminalInput
  // The request id of a message's send (by default a random UUID).
  readonly newRequestId?: () => string
}

// The layer for one worker: `onStatus` takes Orca's `agent.status.changed` (startAgents subscribes it).
export class Agents {
  private readonly host: WorkerHost
  private readonly machine: Machine
  private readonly dataDir: string
  private readonly terminalInput: TerminalInput
  private readonly newRequestId: () => string
  private seq = 0
  // The latest state Orca reported in an event, for each terminal.
  private readonly events = new Map<string, Observation>()
  // The newest turn start the worker saw for each terminal (`working`: when it began, or when Orca got it), and when.
  private readonly turns = new Map<string, { readonly at: number; readonly seq: number }>()
  // The launches this worker knows, by terminal: a turn start seen in an event is kept on disk for the right input.
  private readonly known = new Map<string, AgentLaunch>()
  // The messages being typed now (their directory and number).
  private readonly sending = new Set<string>()
  // The launches still waiting for Orca, and the stops under way, by the task's directory.
  private readonly pending = new Map<string, Set<Promise<LaunchResult>>>()
  private readonly stopping = new Map<string, number>()

  constructor(options: AgentsOptions) {
    this.host = options.host
    this.machine = options.machine
    this.dataDir = options.dataDir
    this.terminalInput = options.terminalInput
    this.newRequestId = options.newRequestId ?? randomUUID
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

  // Orca's event `agent.status.changed`: the state of the agent in the event's terminal. A turn start of a launch the
  // worker knows is kept on disk at once.
  onStatus(event: PluginEvents['agent.status.changed']): void {
    if (!event.terminalId) return
    const main = event.mainAgent
    const since = main !== undefined && main.state === event.state ? main.stateStartedAt : null
    const heard: Observation = { state: event.state, since, seq: ++this.seq }
    const latest = this.events.get(event.terminalId)
    // A state that began before the one already heard, both with their starts, is an old one arriving late.
    if (latest === undefined || latest.since === null || since === null || since >= latest.since) {
      this.events.set(event.terminalId, heard)
    }
    if (event.state === 'working') this.noteTurn(event.terminalId, since ?? event.receivedAt, heard.seq)
  }

  // The agent's state: what `agents.list` of its workspace says now when it lists the agent — Orca's current state —
  // otherwise the latest state of Orca's events (an agent may leave the list once it ends). Null: Orca has said nothing
  // about it. Rejects with Orca's error when the list cannot be read.
  async state(launch: AgentLaunch): Promise<StateReading | null> {
    const seen = await this.observe(launch)
    return seen === null ? null : { state: seen.state, since: seen.since }
  }

  // The report on the plugin's last input to the agent (its task, or the last message whose terminal took it): ready
  // only when the agent is in a «done» after that input and that input's report file exists. While the last message's
  // outcome is unknown, the report waits; when no send of it is under way, Orca is asked again with the same request id.
  async report(launch: AgentLaunch): Promise<ReportReading> {
    this.learn(launch)
    const before = this.lastInput(launch)
    if (before.sending !== null && !before.resolved) {
      if (this.sending.has(`${launch.dir}#${before.n}`)) {
        return this.held(launch, before, `message ${before.n} is being typed into the agent's terminal`)
      }
      const asked = await this.deliver(launch, before.n, before.sending, 'again')
      const after = this.lastInput(launch)
      if (after.sending !== null && !after.resolved) {
        const why = after.n === before.n && !asked.ok ? asked.error : 'not recorded'
        return this.held(launch, after, `the outcome of message ${after.n} is unknown: ${why}`)
      }
    }
    const seen = await this.observe(launch)
    // The last input read again after the last wait: a message sent meanwhile is the input this report is about. From
    // here to the answer nothing waits.
    const input = this.lastInput(launch)
    if (input.sending !== null && !input.resolved) {
      const typing = this.sending.has(`${launch.dir}#${input.n}`)
      return this.held(
        launch,
        input,
        typing ? `message ${input.n} is being typed into the agent's terminal` : `the outcome of message ${input.n} is not recorded yet`,
      )
    }
    const text = this.machine.readText(input.reportFile)
    const turn = this.turns.get(launch.terminalId)
    const turnAfter = turn !== undefined && turn.at >= input.at
    const started = input.started || turnAfter || text !== null
    if (started && !input.started) void this.markStarted(launch, input.n)
    const done =
      seen !== null &&
      seen.state === 'done' &&
      (seen.since !== null ? seen.since >= input.at : turnAfter && turn !== undefined && seen.seq > turn.seq)
    if (text !== null && done) return { ready: true, text, reportFile: input.reportFile }
    const late = !started && this.machine.now() - input.deadlineFrom >= DELIVERY_DEADLINE_MS
    const state = seen?.state ?? null
    const failure = late
      ? {
          state,
          error: `${input.n === 0 ? 'the task' : `message ${input.n}`} did not start a turn of the agent "${launch.agent}" in terminal ${launch.terminalId} in ${DELIVERY_DEADLINE_MS / 60_000} minutes (Orca shows it ${state ?? 'nowhere'}${state === 'blocked' ? ': it waits for a person' : ''})`,
        }
      : null
    return { ready: false, state, started, reportFile: input.reportFile, reportExists: text !== null, unresolved: null, failure }
  }

  // A message to the agent: its text goes into the file message-<k>.md of the launch, and one line naming that file
  // and the report file report-<k>.md is typed into the agent's terminal through Orca's CLI, with Enter. Only into the
  // terminal of this launch's record: another terminal (the owner's, another agent's) is an error, and nothing runs.
  async message(launch: AgentLaunch, text: string): Promise<MessageResult> {
    const notSent = (error: string): MessageResult => ({ ok: false, outcome: 'not-sent', error })
    if (text.trim() === '') return notSent('the message is empty')
    const foreign = this.notOwnTerminal(launch)
    if (foreign !== null) return notSent(foreign)
    this.known.set(launch.terminalId, launch)
    let k: number
    try {
      k = await this.reserve(launch.dir, (n) => `message-${n}.md`, () => text)
    } catch (error) {
      return notSent(`the message could not be written to the data directory: ${errorMessage(error)}`)
    }
    const reportFile = dataPath(this.machine, launch.dir, `report-${k}.md`)
    const line = messageLine(launch.language, dataPath(this.machine, launch.dir, `message-${k}.md`), reportFile)
    // Any turn the agent starts from now on may be on this message.
    const sending: SendingJson = { sentAt: this.machine.now(), line, requestId: this.newRequestId(), reportFile }
    try {
      await this.createJson(launch.dir, `sending-${k}.json`, sending)
    } catch (error) {
      return notSent(`the message's send could not be recorded: ${errorMessage(error)}`)
    }
    return this.deliver(launch, k, sending, 'first')
  }

  // Stops the agents of the task: refuses its new launches while it runs, waits for its launches still waiting for
  // Orca, then closes every terminal the plugin opened for the task and has not closed yet — and no other terminal. A
  // terminal Orca refuses to close counts as closed when its workspace no longer lists it. A launch whose answer from
  // Orca was never recorded (the worker stopped while it was being launched) is reported: its terminal is unknown.
  async stop(task: TaskRef): Promise<StopResult> {
    const key = this.taskDir(task)
    this.stopping.set(key, (this.stopping.get(key) ?? 0) + 1)
    try {
      await Promise.all([...(this.pending.get(key) ?? [])])
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
    } finally {
      const left = (this.stopping.get(key) ?? 1) - 1
      if (left > 0) this.stopping.set(key, left)
      else this.stopping.delete(key)
    }
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
    const launch: AgentLaunch = { ...files, task: request.task, number, role, agent, language, workspaceId, launchedAt, terminalId }
    this.known.set(terminalId, launch)
    // Orca opened this terminal for this launch: a turn heard in it before Orca's answer is a turn on its task.
    if (this.turns.has(terminalId)) await this.markStarted(launch, 0)
    return { ok: true, launch }
  }

  // Types the recorded line of message k into the agent's terminal as its request, and records the outcome Orca gives:
  // the first send (from message), or asking again after an outcome that is not known (from report: the same request
  // id replays the outcome, or types the line then if Orca never saw the request). `taken: false` is recorded only on
  // proof that the line of this request was not typed: on the first send, the boundary failing before the CLI runs, the
  // CLI not found or not started, or Orca refusing the line itself; and, in any attempt, Orca's receipt saying the
  // terminal did not take it. Asking again, no refusal decides the outcome: it stays unknown, and the report waits.
  private async deliver(launch: AgentLaunch, k: number, sending: SendingJson, attempt: 'first' | 'again'): Promise<MessageResult> {
    const key = `${launch.dir}#${k}`
    this.sending.add(key)
    try {
      const outcome = (value: Omit<OutcomeJson, 'at'>) => this.createJson(launch.dir, `message-${k}.json`, { ...value, at: this.machine.now() })
      // The boundary of every input through the CLI, checked before each run of it.
      const foreign = this.notOwnTerminal(launch)
      if (foreign !== null) {
        if (attempt === 'again') return { ok: false, outcome: 'unknown', error: foreign }
        await outcome({ taken: false, turnStarted: false, error: foreign }).catch(() => false)
        return { ok: false, outcome: 'not-sent', error: foreign }
      }
      const sent = await this.terminalInput(launch.terminalId, sending.line, sending.requestId)
      if (!sent.ok) {
        const error = `message ${k} into the agent's terminal ${launch.terminalId}: ${sent.error}`
        if (attempt === 'again' || sent.delivery === 'unknown') return { ok: false, outcome: 'unknown', error: `the outcome of ${error} is unknown` }
        await outcome({ taken: false, turnStarted: false, error: sent.error }).catch(() => false)
        return { ok: false, outcome: 'not-sent', error: `${error}: not sent` }
      }
      if (!sent.accepted) {
        await outcome({ taken: false, turnStarted: false, error: sent.refusedReason }).catch(() => false)
        return { ok: false, outcome: 'not-sent', error: `the agent's terminal ${launch.terminalId} did not take message ${k}: ${sent.refusedReason}` }
      }
      try {
        await outcome({ taken: true, turnStarted: sent.turnStarted, error: null })
      } catch (error) {
        // Unrecorded, the message is not the agent's last input; the report waits and asks Orca again.
        return { ok: false, outcome: 'unknown', error: `message ${k} went into the agent's terminal, but its outcome could not be recorded: ${errorMessage(error)}` }
      }
      if (sent.turnStarted) await this.markStarted(launch, k)
      return { ok: true, reportFile: sending.reportFile, started: sent.turnStarted }
    } finally {
      this.sending.delete(key)
    }
  }

  private held(launch: AgentLaunch, input: Input, why: string): ReportReading {
    const text = this.machine.readText(input.reportFile)
    return {
      ready: false,
      state: this.events.get(launch.terminalId)?.state ?? null,
      started: input.started,
      reportFile: input.reportFile,
      reportExists: text !== null,
      unresolved: why,
      failure: null,
    }
  }

  // What Orca shows of the agent now: its entry in `agents.list`, else the latest event.
  private async observe(launch: AgentLaunch): Promise<Observation | null> {
    this.learn(launch)
    const { agents } = await this.host.call('agents.list', { workspaceId: launch.workspaceId })
    const listed = agents.find((agent) => agent.terminalId === launch.terminalId)
    if (listed === undefined) return this.events.get(launch.terminalId) ?? null
    const seen: Observation = { state: listed.state, since: listed.stateStartedAt, seq: ++this.seq }
    if (listed.state === 'working') this.noteTurn(launch.terminalId, listed.stateStartedAt, seen.seq)
    return seen
  }

  private noteTurn(terminalId: string, at: number, seq: number): void {
    // The same turn seen again keeps the order in which it was first heard.
    const known = this.turns.get(terminalId)
    if (known === undefined || at > known.at) this.turns.set(terminalId, { at, seq })
    const launch = this.known.get(terminalId)
    if (launch === undefined) return
    const input = this.lastInput(launch)
    if (!input.started && (input.sending === null || input.resolved) && at >= input.at) void this.markStarted(launch, input.n)
  }

  // Keeps on disk that the agent was seen starting on input n.
  private async markStarted(launch: AgentLaunch, n: number): Promise<void> {
    try {
      await this.machine.createText(dataPath(this.machine, launch.dir, `started-${n}`), `${this.machine.now()}\n`)
    } catch {
      // Not kept: the next report sees the start again, or the report file.
    }
  }

  // The plugin's last input to the agent: the newest message whose send is recorded and not refused, or else the task.
  private lastInput(launch: AgentLaunch): Input {
    const started = (n: number) => this.machine.readText(dataPath(this.machine, launch.dir, `started-${n}`)) !== null
    let last: Input = {
      n: 0,
      at: launch.launchedAt,
      deadlineFrom: launch.launchedAt,
      reportFile: launch.reportFile,
      sending: null,
      resolved: true,
      started: started(0),
    }
    for (let n = 1; n <= MAX_RECORDS; n++) {
      if (this.machine.readText(dataPath(this.machine, launch.dir, `message-${n}.md`)) === null) break
      const sending = parseSending(this.machine.readText(dataPath(this.machine, launch.dir, `sending-${n}.json`)))
      if (sending === null) continue
      const outcome = parseOutcome(this.machine.readText(dataPath(this.machine, launch.dir, `message-${n}.json`)))
      if (outcome !== null && !outcome.taken) continue
      last = {
        n,
        at: sending.sentAt,
        deadlineFrom: outcome?.at ?? sending.sentAt,
        reportFile: sending.reportFile,
        sending,
        resolved: outcome !== null,
        started: (outcome?.turnStarted ?? false) || started(n),
      }
    }
    return last
  }

  // The boundary of every input through Orca's CLI: the terminal is the one Orca opened for this launch (its
  // launch.json) and the plugin has not closed it. Null when it holds; otherwise why nothing may be typed into it.
  private notOwnTerminal(launch: AgentLaunch): string | null {
    const recorded = parseLaunch(this.machine.readText(dataPath(this.machine, launch.dir, LAUNCH_FILE)))
    if (recorded === null || recorded.terminalId !== launch.terminalId) {
      return `the terminal ${launch.terminalId} is not the terminal of the plugin's launch in ${launch.dir}${recorded === null ? ' (the launch has no record)' : ''}: nothing is typed into it`
    }
    if (this.isClosed(launch)) return `the plugin has closed the agent's terminal ${launch.terminalId}`
    return null
  }

  // Keeps a launch by its terminal, so that a turn heard in an event is kept on disk for its input — only a launch
  // whose terminal is its own.
  private learn(launch: AgentLaunch): void {
    if (this.notOwnTerminal(launch) === null) this.known.set(launch.terminalId, launch)
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

  private createJson(dir: string, name: string, value: LaunchingJson | LaunchJson | SendingJson | OutcomeJson): Promise<boolean> {
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

function parseSending(text: string | null): SendingJson | null {
  const json = parseJson(text)
  if (json === null) return null
  const { sentAt, line, requestId, reportFile } = json
  if (typeof sentAt !== 'number' || typeof line !== 'string' || typeof requestId !== 'string' || typeof reportFile !== 'string') {
    return null
  }
  return { sentAt, line, requestId, reportFile }
}

function parseOutcome(text: string | null): OutcomeJson | null {
  const json = parseJson(text)
  if (json === null) return null
  const { taken, turnStarted, at, error } = json
  if (typeof taken !== 'boolean' || typeof turnStarted !== 'boolean' || typeof at !== 'number' || (error !== null && typeof error !== 'string')) {
    return null
  }
  return { taken, turnStarted, at, error }
}
