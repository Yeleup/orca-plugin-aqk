// The coordinator of this computer (TZ Ф4, the introduction, «Захват и перехват — один протокол отсчётов», «Право на
// действие» — without the branch and the worktree). One check of the queue of a project (`checkProject`) — the worker
// runs it once per interval for every connected project (./schedule.ts), a test calls it itself:
//
// 1. reads the project's settings from origin/<base branch> and the owner's open tasks (label `agent-queue`) with
//    their comments; a failure of either ends the check of this project — it never counts as an empty queue;
// 2. checks the tasks this coordinator leads — also when the project's queue is stopped (Ф9): the label `working` is
//    set when the write after its claim failed, and released when the owner took it off; `blocked` and `split` come
//    off (the labels of its stage); a count it led and lost to a newer one is given up, writing nothing;
// 3. unless the queue is stopped, takes the oldest task it may take (`choose`) by the protocol of counts (`claimTask`):
//    the claim with the next count, the label `agent-queue:working`, the re-read REREAD_AFTER_MS later. The task is
//    led by the author of the first claim of the highest count in GitHub's order; the others write «Задачу ведёт <id>»
//    once and nothing more.
//
// The agents of the task are not this module's: the hooks (`started`, `leading`, `lost`) are where the next tasks of
// the plan start and continue them (`executor`, `watchdog`) and stop them and save their work (`saved-work`).
import type { ProjectRef } from '../agents/agents'
import { field, type ProjectGitHubSettings, type Stage } from '../github/check'
import type { Repository } from '../github/gh'
import { GitHub, type Comment, type Issue } from '../github/github'
import type { PluginLabel } from '../github/labels'
import { parseTaskLines } from '../github/task-lines'
import { githubSegments } from '../github-texts/catalog'
import { errorMessage, type Machine } from '../platform/machine'
import { readProjectSettings, type ProjectSettings } from '../project/settings'
import type { Project } from '../protocol'
import {
  ACTIVE_LABELS,
  BLOCKED,
  claimBar,
  hasLabel,
  isClaimKind,
  isReleaseKind,
  QUEUED,
  readClaims,
  REREAD_AFTER_MS,
  RIGHT_VALID_MS,
  SPLIT,
  stageOf,
  WORKING,
  type ClaimBar,
  type ClaimKind,
  type Claims,
} from './claims'
import { ClaimJournal, type JournalRecord } from './journal'
import { Right } from './right'

// A project connected to the queue, as the coordinator needs it: the panel's project (Orca's id and host, its name),
// its main checkout — the settings are read from origin/<base branch> through it — and its GitHub repository.
export type QueueProject = Project & {
  readonly checkout: string
  readonly repository: Repository
}

export type SettingsRead =
  | { readonly ok: true; readonly settings: ProjectSettings }
  | { readonly ok: false; readonly error: string }

// A task this coordinator leads: the count, its stage by the comments of that count alone, the project's settings, the
// GitHub layer and the right to act (every write on the task goes through `right`).
export type LedTask = {
  readonly project: QueueProject
  readonly issue: Issue
  readonly count: number
  readonly kind: ClaimKind
  readonly stage: Stage | null
  readonly settings: ProjectSettings
  readonly github: GitHub
  readonly right: Right
}

// A count this coordinator led and does not lead any more: a newer count (another coordinator leads it — `leader`), or
// its own release after the owner took `working` off.
export type LostTask = {
  readonly project: QueueProject
  readonly issue: Issue
  readonly count: number
  readonly reason: 'newer-count' | 'released-by-owner'
  readonly leader: string | null
}

export type CoordinatorHooks = {
  // The re-read after the claim decided that this coordinator leads the task: the point where the agents of the task
  // start (the task `executor`). Called once per count.
  readonly started?: (task: LedTask) => void | Promise<void>
  // Every later check of a task this coordinator leads, after its labels are brought to its stage: the stage goes on
  // here (`executor`, `watchdog`).
  readonly leading?: (task: LedTask) => void | Promise<void>
  // A count this coordinator led is lost or released: its agents of the task stop and their work is saved here
  // (`saved-work`). Called once per count. Nothing on the task is written for it here.
  readonly lost?: (task: LostTask) => void | Promise<void>
}

// A task of the check: the issue, its comments (the owner's, in GitHub's order) and its claims.
export type TaskView = { readonly issue: Issue; readonly comments: readonly Comment[]; readonly claims: Claims }

// What the choice knows of the project in this check.
export type ChoiceContext = {
  readonly project: QueueProject
  readonly settings: ProjectSettings
  readonly tasks: readonly TaskView[]
  // Tasks with an active claim (in work), by any coordinator.
  readonly inWork: readonly number[]
  readonly now: number
}

// One more condition of the choice: why `task` is not taken now, or null. The tasks `operations` (a task created by
// an unfinished operation), `mvp-lead` (the limits of MVP tasks) and `merge` (no claims during a merge attempt) add
// theirs here.
export type ChoiceRule = (task: TaskView, context: ChoiceContext) => string | null | Promise<string | null>

export type ClaimOutcome =
  // This coordinator leads the task (count `count`); the hook `started` ran.
  | { readonly kind: 'leads'; readonly issue: number; readonly count: number }
  // Another claim of the same count came first in GitHub's order: «Задачу ведёт <leader>» written, nothing more.
  | { readonly kind: 'lost'; readonly issue: number; readonly count: number; readonly leader: string }
  // A newer count was opened meanwhile: nothing more written.
  | { readonly kind: 'yielded'; readonly issue: number; readonly count: number; readonly leader: string | null }
  // The claim is not seen in the re-read (yet): the next check decides by GitHub.
  | { readonly kind: 'unconfirmed'; readonly issue: number; readonly count: number }
  // The task cannot be claimed now (its labels or claims).
  | { readonly kind: 'not-free'; readonly issue: number; readonly reason: string }
  // A write or read failed; what was written stays, the next check goes on from GitHub.
  | { readonly kind: 'failed'; readonly issue: number; readonly error: string }

export type ProjectCheck = {
  readonly project: QueueProject
  // Why this project was not checked (its settings or GitHub could not be read); null when it was.
  readonly error: string | null
  // Open tasks with an active claim (in work), by any coordinator, after the tasks this coordinator leads were checked
  // (a count it released in this check is not in work).
  readonly inWork: readonly number[]
  // The tasks this coordinator leads after the check.
  readonly led: readonly number[]
  // The claim of this check, if one was made.
  readonly claimed: ClaimOutcome | null
  // The tasks not taken, each with why (oldest first).
  readonly skipped: readonly { readonly issue: number; readonly reason: string }[]
}

export type CoordinatorOptions = {
  readonly machine: Machine
  readonly dataDir: string
  readonly coordinatorId: string
  readonly hooks?: CoordinatorHooks
  // The project's settings; by default .agent-queue.json of origin/<base branch> of its main checkout.
  readonly readSettings?: (project: QueueProject) => Promise<SettingsRead>
  // The wait of the protocol (REREAD_AFTER_MS); tests move a fake clock instead of waiting.
  readonly sleep?: (ms: number) => Promise<void>
  // Whether the project's queue is stopped on this computer («Остановить», Ф9) or paused (the pause issue): the task
  // `stop-start` gives it. Until then never. A stopped queue takes no new task; the tasks it leads go on.
  readonly queueStopped?: (project: QueueProject) => boolean | Promise<boolean>
  readonly rules?: readonly ChoiceRule[]
  readonly log?: (line: string) => void
}

type Pass = {
  readonly project: QueueProject
  readonly settings: ProjectSettings
  readonly github: GitHub
}

export class Coordinator {
  readonly id: string
  private readonly machine: Machine
  private readonly journal: ClaimJournal
  private readonly hooks: CoordinatorHooks
  private readonly options: CoordinatorOptions

  constructor(options: CoordinatorOptions) {
    this.options = options
    this.id = options.coordinatorId
    this.machine = options.machine
    this.journal = new ClaimJournal(options.machine, options.dataDir)
    this.hooks = options.hooks ?? {}
  }

  // One check of the queue: every project in turn.
  async checkQueue(projects: readonly QueueProject[]): Promise<ProjectCheck[]> {
    const checks: ProjectCheck[] = []
    for (const project of projects) checks.push(await this.checkProject(project))
    return checks
  }

  async checkProject(project: QueueProject): Promise<ProjectCheck> {
    const failed = (error: string): ProjectCheck => {
      this.log(`${project.name}: the queue was not checked: ${error}`)
      return { project, error, inWork: [], led: [], claimed: null, skipped: [] }
    }
    let pass: Pass
    let tasks: TaskView[]
    try {
      pass = await this.pass(project)
      tasks = await this.readTasks(pass)
    } catch (error) {
      return failed(errorMessage(error))
    }
    const touched = new Set<number>()
    const released = new Set<number>()
    const led: number[] = []
    for (const task of tasks) {
      try {
        const kept = await this.keepLeading(pass, task, touched)
        if (kept === 'leads') led.push(task.issue.number)
        if (kept === 'released') released.add(task.issue.number)
      } catch (error) {
        touched.add(task.issue.number)
        this.log(`${project.name} #${task.issue.number}: ${errorMessage(error)}`)
      }
    }
    // In work: the tasks with an active claim, by any coordinator — but a count this check released.
    const inWork = tasks
      .filter((task) => task.claims.active && !released.has(task.issue.number))
      .map((task) => task.issue.number)
    if (await this.queueStopped(project)) {
      return { project, error: null, inWork, led, claimed: null, skipped: [] }
    }
    const skipped: { issue: number; reason: string }[] = []
    const context: ChoiceContext = { project, settings: pass.settings, tasks, inWork, now: this.machine.now() }
    const chosen = await this.choose(pass, context, touched, skipped)
    if (chosen === null) return { project, error: null, inWork, led, claimed: null, skipped }
    const claimed = await this.runClaim(pass, chosen.issue.number, 'claim')
    if (claimed.kind === 'leads') led.push(claimed.issue)
    return { project, error: null, inWork, led, claimed, skipped }
  }

  // A claim of task #number by the protocol of counts — `takeover` for a new count of a task another coordinator leads
  // (the decision to take it over is the watchdog's, Ф10; the protocol is the same).
  async claimTask(project: QueueProject, number: number, kind: ClaimKind = 'claim'): Promise<ClaimOutcome> {
    let pass: Pass
    try {
      pass = await this.pass(project)
    } catch (error) {
      return { kind: 'failed', issue: number, error: errorMessage(error) }
    }
    return this.runClaim(pass, number, kind)
  }

  // ── The protocol of counts ────────────────────────────────────────────────────────────────────────────────────────

  private async runClaim(pass: Pass, number: number, kind: ClaimKind): Promise<ClaimOutcome> {
    const { github, project, settings } = pass
    const ref = projectRef(project)
    let issue: Issue
    let before: Claims
    let readAt: number
    try {
      // The task read right before the claim: its state and labels, and its claims.
      const lookup = await github.getIssue(number)
      if (lookup.found !== 'owner') {
        return { kind: 'not-free', issue: number, reason: `not the owner's task (${lookup.reason})` }
      }
      issue = lookup.issue
      before = readClaims(await github.listComments(number))
      readAt = this.machine.now()
    } catch (error) {
      return this.failedClaim(project, number, error)
    }
    const bar = issueBar(issue, kind) ?? (kind === 'claim' ? claimBar(before, issue.labels, readAt) : null)
    if (bar !== null) return { kind: 'not-free', issue: number, reason: bar }
    const count = before.last + 1
    let labels = issue.labels
    try {
      await github.comment(number, {
        mark: { kind, coordinator: this.id, claim: count },
        text: githubSegments(settings.language, kind === 'claim' ? 'claim.claim' : 'claim.takeover', {
          coordinator: field.coordinator(this.id),
          claim: field.claim(count),
        }),
      })
    } catch (error) {
      // The answer may have been lost after GitHub wrote it: the next check finds the claim by GitHub.
      return this.failedClaim(project, number, error)
    }
    await this.record(ref, number, count, 'claimed')
    this.log(`${project.name} #${number}: ${kind} of count ${count} written`)
    // The label, right after the claim. The read before the claim is its check while it is RIGHT_VALID_MS fresh; an
    // older one is made again, and a newer count by then means no label.
    try {
      if (this.machine.now() - readAt > RIGHT_VALID_MS) {
        const now = readClaims(await github.listComments(number))
        if (now.last > count) return { kind: 'yielded', issue: number, count, leader: now.leader }
      }
      labels = await github.addLabels(number, [WORKING])
      await this.record(ref, number, count, 'labelled')
    } catch (error) {
      // The claim without the label: this coordinator sets it at its next check (by its journal, keepLeading); the
      // others do not take the task meanwhile (claimBar).
      const why = errorMessage(error)
      this.log(`${project.name} #${number}: the label ${WORKING} was not set after the claim of count ${count}: ${why}`)
    }
    await this.sleep(REREAD_AFTER_MS)
    let after: Claims
    try {
      after = readClaims(await github.listComments(number))
    } catch (error) {
      return this.failedClaim(project, number, error)
    }
    if (after.last === count && after.leader === this.id && after.active) {
      await this.record(ref, number, count, 'led')
      this.log(`${project.name} #${number}: leads count ${count}`)
      await this.callHook('started', project, number, () =>
        this.hooks.started?.(this.ledTask(pass, { ...issue, labels }, after, count)),
      )
      return { kind: 'leads', issue: number, count }
    }
    if (after.last === count && after.leader !== null && after.leader !== this.id) {
      // The loser of the count: one comment naming the leader, then nothing more on the task.
      try {
        await github.comment(number, {
          text: githubSegments(settings.language, 'claim.ledBy', { coordinator: field.coordinator(after.leader) }),
        })
      } catch (error) {
        this.log(`${project.name} #${number}: «led by ${after.leader}» was not written: ${errorMessage(error)}`)
      }
      this.log(`${project.name} #${number}: count ${count} is led by ${after.leader}`)
      return { kind: 'lost', issue: number, count, leader: after.leader }
    }
    if (after.last > count) return { kind: 'yielded', issue: number, count, leader: after.leader }
    return { kind: 'unconfirmed', issue: number, count }
  }

  // ── The tasks this coordinator leads ─────────────────────────────────────────────────────────────────────────────

  // Checks `task` for this coordinator: a lost count is given up; a count it leads gets the labels of its stage, a
  // release when the owner took `working` off, the decision of a claim this worker did not finish (a restart), and the
  // hook of its stage. `leads` when this coordinator leads the task after it, `released` when it released its count.
  private async keepLeading(pass: Pass, task: TaskView, touched: Set<number>): Promise<'leads' | 'released' | 'none'> {
    const { project, github, settings } = pass
    const ref = projectRef(project)
    const { claims } = task
    const number = task.issue.number
    for (const count of this.journal.counts(ref, number)) {
      const done = this.has(ref, number, count, 'yielded') || this.has(ref, number, count, 'released')
      if (!this.has(ref, number, count, 'led') || done) continue
      if (claims.last === count && claims.leader === this.id) continue
      // A count this coordinator ended itself (its block, deferral or release came before any newer claim) is not lost.
      if (endedByItself(claims, count, this.id)) continue
      touched.add(number)
      await this.record(ref, number, count, 'yielded')
      const to = `count ${claims.last} of ${claims.leader ?? '?'}`
      this.log(`${project.name} #${number}: count ${count} is lost to ${to}; nothing more is written`)
      await this.callHook('lost', project, number, () =>
        this.hooks.lost?.({ project, issue: task.issue, count, reason: 'newer-count', leader: claims.leader }),
      )
    }
    if (!claims.active || claims.leader !== this.id) return 'none'
    touched.add(number)
    const count = claims.last
    const right = this.right(github, number, count)
    let issue = task.issue
    if (hasLabel(issue.labels, WORKING)) {
      await this.record(ref, number, count, 'labelled')
    } else {
      // The labels read with the list may be older: the task is read again before deciding.
      const lookup = await github.getIssue(number)
      if (lookup.found !== 'owner') return 'none'
      issue = lookup.issue
      if (hasLabel(issue.labels, WORKING)) {
        await this.record(ref, number, count, 'labelled')
      } else if (this.has(ref, number, count, 'labelled')) {
        // The label was on for this count and is gone: the owner took it off. The count is released.
        const released = await right.act(() =>
          github.comment(number, {
            mark: { kind: 'release', coordinator: this.id, claim: count },
            text: githubSegments(settings.language, 'claim.released', {
              coordinator: field.coordinator(this.id),
              claim: field.claim(count),
            }),
          }),
        )
        if (!released.ok) return 'none'
        await this.record(ref, number, count, 'released')
        this.log(`${project.name} #${number}: ${WORKING} was taken off; count ${count} released`)
        await this.callHook('lost', project, number, () =>
          this.hooks.lost?.({ project, issue, count, reason: 'released-by-owner', leader: this.id }),
        )
        return 'released'
      } else {
        // The write of the label after the claim failed: it is set now.
        const set = await right.act(() => github.addLabels(number, [WORKING]))
        if (!set.ok) return 'none'
        await this.record(ref, number, count, 'labelled')
        issue = { ...issue, labels: [...issue.labels, WORKING] }
        this.log(`${project.name} #${number}: ${WORKING} set for count ${count}`)
      }
    }
    // The other labels of its stage: a block and a split end a count, so a count in work has neither.
    for (const label of ACTIVE_LABELS.off) {
      if (!hasLabel(issue.labels, label)) continue
      const removed = await right.act(() => github.removeLabel(number, label as PluginLabel))
      if (!removed.ok) return 'none'
      issue = { ...issue, labels: issue.labels.filter((one) => one.toLowerCase() !== label.toLowerCase()) }
      this.log(`${project.name} #${number}: ${label} taken off: count ${count} is in work`)
    }
    const led = this.ledTask(pass, issue, claims, count, right)
    if (!this.has(ref, number, count, 'led')) {
      // The claim was written by this coordinator, and the worker stopped before its re-read decided.
      if (this.machine.now() - (claims.claimAt ?? 0) < REREAD_AFTER_MS) return 'leads'
      await this.record(ref, number, count, 'led')
      await this.callHook('started', project, number, () => this.hooks.started?.(led))
      return 'leads'
    }
    await this.callHook('leading', project, number, () => this.hooks.leading?.(led))
    return 'leads'
  }

  // ── The choice ───────────────────────────────────────────────────────────────────────────────────────────────────

  // The oldest task that may be taken now (TZ Ф4): the owner's, labelled `agent-queue`, without `blocked` and `split`,
  // without an active claim (or with one left unsettled UNSETTLED_MS), not deferred, without open dependencies, with
  // fewer tasks in work than the project's limit — and every rule of `options.rules`.
  private async choose(
    pass: Pass,
    context: ChoiceContext,
    touched: ReadonlySet<number>,
    skipped: { issue: number; reason: string }[],
  ): Promise<TaskView | null> {
    const dependencies = new Map<number, string | null>()
    for (const task of context.tasks) {
      const reason = touched.has(task.issue.number)
        ? 'checked as led by this coordinator in this check'
        : await this.notChosen(pass, task, context, dependencies)
      if (reason === null) return task
      skipped.push({ issue: task.issue.number, reason })
    }
    return null
  }

  private async notChosen(
    pass: Pass,
    task: TaskView,
    context: ChoiceContext,
    dependencies: Map<number, string | null>,
  ): Promise<string | null> {
    const bar = issueBar(task.issue, 'claim') ?? claimBar(task.claims, task.issue.labels, context.now)
    if (bar !== null) return bar
    // In work: tasks with an active claim. A task taken again with a new count is one of them already.
    const others = context.inWork.filter((number) => number !== task.issue.number).length
    if (others >= context.settings.maxInProgress) return `limit: ${others} of ${context.settings.maxInProgress} in work`
    const lines = parseTaskLines(task.issue.body)
    if (lines.problems.length > 0) return `task lines: ${lines.problems.join('; ')}`
    for (const dependency of lines.dependsOn) {
      if (!dependencies.has(dependency)) {
        dependencies.set(dependency, await this.openDependency(pass, context, dependency))
      }
      const open = dependencies.get(dependency)
      if (open) return `depends on #${dependency}: ${open}`
    }
    for (const rule of this.options.rules ?? []) {
      const reason = await rule(task, context)
      if (reason !== null) return reason
    }
    return null
  }

  // Why the dependency #number holds the task (open, or its state unknown), or null when it is closed.
  private async openDependency(pass: Pass, context: ChoiceContext, number: number): Promise<string | null> {
    if (context.tasks.some((task) => task.issue.number === number)) return 'open'
    try {
      const lookup = await pass.github.getIssue(number)
      const state = lookup.found === 'owner' ? lookup.issue.state : lookup.state
      return state === 'open' ? 'open' : null
    } catch (error) {
      return `not read: ${errorMessage(error)}`
    }
  }

  // ── Inside ───────────────────────────────────────────────────────────────────────────────────────────────────────

  private async pass(project: QueueProject): Promise<Pass> {
    const read = await (this.options.readSettings ?? ((one) => defaultSettings(this.machine, one)))(project)
    if (!read.ok) throw new Error(read.error)
    const github: ProjectGitHubSettings = {
      language: read.settings.language,
      forbiddenPatterns: read.settings.forbiddenPatterns,
    }
    return {
      project,
      settings: read.settings,
      github: new GitHub({ machine: this.machine, repository: project.repository, settings: github }),
    }
  }

  // The owner's open tasks of the queue, oldest first, each with its comments.
  private async readTasks(pass: Pass): Promise<TaskView[]> {
    const issues = await pass.github.listIssues({ state: 'open', labels: [QUEUED] })
    const tasks: TaskView[] = []
    for (const issue of issues) {
      const comments = await pass.github.listComments(issue.number)
      tasks.push({ issue, comments, claims: readClaims(comments) })
    }
    return tasks
  }

  private right(github: GitHub, issue: number, count: number): Right {
    return new Right({ github, issue, count, coordinatorId: this.id, now: () => this.machine.now() })
  }

  private ledTask(pass: Pass, issue: Issue, claims: Claims, count: number, right?: Right): LedTask {
    return {
      project: pass.project,
      issue,
      count,
      kind: claims.kind ?? 'claim',
      stage: stageOf(claims, count, this.id),
      settings: pass.settings,
      github: pass.github,
      right: right ?? this.right(pass.github, issue.number, count),
    }
  }

  private has(project: ProjectRef, issue: number, count: number, record: JournalRecord): boolean {
    return this.journal.has(project, issue, count, record)
  }

  // A record of the journal; a disk that refuses it is logged, and the protocol goes on by GitHub.
  private async record(project: ProjectRef, issue: number, count: number, record: JournalRecord): Promise<void> {
    try {
      await this.journal.write(project, issue, count, record)
    } catch (error) {
      this.log(`#${issue}: the journal record ${record} of count ${count} was not written: ${errorMessage(error)}`)
    }
  }

  private async callHook(name: string, project: QueueProject, issue: number, run: () => unknown): Promise<void> {
    try {
      await run()
    } catch (error) {
      this.log(`${project.name} #${issue}: ${name}: ${errorMessage(error)}`)
    }
  }

  private failedClaim(project: QueueProject, number: number, error: unknown): ClaimOutcome {
    this.log(`${project.name} #${number}: the claim did not go through: ${errorMessage(error)}`)
    return { kind: 'failed', issue: number, error: errorMessage(error) }
  }

  private async queueStopped(project: QueueProject): Promise<boolean> {
    return (await this.options.queueStopped?.(project)) ?? false
  }

  private sleep(ms: number): Promise<void> {
    return this.options.sleep ? this.options.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms))
  }

  private log(line: string): void {
    this.options.log?.(`agent-queue: coordinator: ${line}`)
  }
}

// Why the issue itself cannot be claimed: closed, not a task of the queue, or — for a claim — blocked or given to
// splitting; null when it can.
function issueBar(issue: Issue, kind: ClaimKind): string | null {
  if (issue.state !== 'open') return 'closed'
  if (!hasLabel(issue.labels, QUEUED)) return `no label ${QUEUED}`
  if (kind === 'claim' && hasLabel(issue.labels, BLOCKED)) return 'blocked'
  if (kind === 'claim' && hasLabel(issue.labels, SPLIT)) return 'split'
  return null
}

// Whether `coordinator` ended its count `count` itself: its release comment of that count comes before the first claim
// of a newer count in GitHub's order. A release written after a newer claim — in the window after a takeover — does not
// make the count its own to end: it was lost first.
function endedByItself(claims: Claims, count: number, coordinator: string): boolean {
  const release = claims.marked.find(
    (one) => one.mark.claim === count && one.mark.coordinator === coordinator && isReleaseKind(one.mark.kind),
  )
  if (release === undefined) return false
  const newer = claims.marked.find((one) => isClaimKind(one.mark.kind) && (one.mark.claim ?? 0) > count)
  return newer === undefined || release.index < newer.index
}

function projectRef(project: QueueProject): ProjectRef {
  return { id: project.id, hostId: project.hostId }
}

async function defaultSettings(machine: Machine, project: QueueProject): Promise<SettingsRead> {
  const read = await readProjectSettings(machine, project.checkout)
  return read.ok ? { ok: true, settings: read.settings } : { ok: false, error: read.error }
}

export type { ClaimBar }
