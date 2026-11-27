// The coordinator of this computer (TZ Ф4, the introduction, «Захват и перехват — один протокол отсчётов», «Право на
// действие» — without the branch and the worktree). One check of the queue of a project (`checkProject`) — the worker
// runs it once per interval for every connected project (./schedule.ts), a test calls it itself:
//
// 1. reads the project's settings from origin/<base branch> and the owner's open tasks (label `agent-queue`) with
//    their comments; a failure of either ends the check of this project — it never counts as an empty queue;
// 2. checks its own claims and counts, task by task — also when the project's queue is stopped (Ф9): a claim of the
//    queue not complete yet is completed (the label, the wait, the re-read, the labels of its stage, the start); a
//    claim that lost its count gets the notice of its leader, once; a count it leads through this project (`led`) gets
//    a release decided already first, then the labels of its stage, and is released when the owner took `working` off
//    (removalOrigin decides who did); a count it led and lost (or released) gets its local handling (the hook `lost`)
//    until that is done. A count led through another connected copy of the same repository is not this project's;
// 3. unless the queue is stopped or the coordinator was switched off meanwhile, takes the oldest task it may take: the
//    choice on the reading of step 1, then the claim on a fresh reading of the task, which admits it again (its
//    labels, claims, dependencies and the rules of the choice) — refused, the choice goes on with the next one, and a
//    task the fresh reading showed taken counts in work.
//
// The protocol of counts (`claimTask`) is the same for every target: how the claim goes on (who completes it after a
// failure, the labels of its stage) is kept before it; the claim with the next count; the first label of the target's
// stage while the count is the last, active one and this coordinator one of its claimants; the re-read REREAD_AFTER_MS
// after the label was on; the leader — the author of the first claim of the highest count in GitHub's order — brings
// the labels to its stage and only then starts, once per count; the others write the notice «Задачу ведёт <id>» once
// and nothing more. What may be claimed is the caller's: the strict rules of the queue by default, the caller's own
// check on the fresh reading otherwise (a closed task with a merge attempt, the «MVP» issue — the tasks `watchdog`,
// `merge`, `mvp-lead`). A switched-off coordinator writes nothing new: the switch is asked before every action.
//
// The agents of the task are not this module's: the hooks (`started`, `leading`, `lost`) are where the next tasks of
// the plan start and continue them (`executor`, `watchdog`) and stop them and save their work (`saved-work`).
import type { ProjectRef } from '../agents/agents'
import { field, type ProjectGitHubSettings, type Stage } from '../github/check'
import { repositoryRef, type Repository } from '../github/gh'
import { GitHub, type Comment, type Issue } from '../github/github'
import { isPluginLabel } from '../github/labels'
import { parseTaskLines } from '../github/task-lines'
import { githubSegments } from '../github-texts/catalog'
import { errorMessage, type Machine } from '../platform/machine'
import { readProjectSettings, type ProjectSettings } from '../project/settings'
import type { Project } from '../protocol'
import {
  ACTIVE_LABELS,
  BLOCKED,
  changedSince,
  claimBar,
  claimOf,
  expectationOf,
  hasLabel,
  isClaimKind,
  isReleaseKind,
  QUEUED,
  readClaims,
  removalOrigin,
  REREAD_AFTER_MS,
  RIGHT_VALID_MS,
  SPLIT,
  stageOf,
  WORKING,
  type ClaimBar,
  type ClaimKind,
  type Claims,
  type Expectation,
  type MarkedComment,
  type RemovalOrigin,
  type StageLabels,
} from './claims'
import { ClaimJournal, type JournalRecord } from './journal'
import { fresh, Right, TaskGate, type Refused, type RightCheck } from './right'

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
  // The claim is complete and this coordinator leads the task: the point where the agents of the task start (the task
  // `executor`). Called at most once per count — by the completion that created `led`, for the Orca project kept there —
  // after the labels of its stage are set and the right is confirmed by a fresh read of the claims; the task (its
  // stage) is of that confirming reading. Every action of the hook on the task goes through `task.right`.
  readonly started?: (task: LedTask) => void | Promise<void>
  // Every later check of a task this coordinator leads through this project, after its labels are brought to its stage
  // and the right is confirmed by a fresh read of the claims: the stage goes on here (`executor`, `watchdog`).
  readonly leading?: (task: LedTask) => void | Promise<void>
  // A count this coordinator led is lost or released: its agents of the task stop and their work is saved here
  // (`saved-work`). Called at every check until it ends without an error — it must be safe to repeat. Nothing on the
  // task is written for it here.
  readonly lost?: (task: LostTask) => void | Promise<void>
}

// A task of the check: the issue, its comments (the owner's, in GitHub's order) and its claims; `readAt` — when its
// labels were read (the machine's clock, before the read).
export type TaskView = {
  readonly issue: Issue
  readonly comments: readonly Comment[]
  readonly claims: Claims
  readonly readAt: number
}

// What the choice knows of the project. `phase`: `choice` — on the reading at the start of the check; `claim` — again,
// on the fresh reading of the one task right before its claim (`tasks` and `inWork` are still those of the check).
export type ChoiceContext = {
  readonly project: QueueProject
  readonly settings: ProjectSettings
  readonly tasks: readonly TaskView[]
  // Tasks with an active claim (in work), by any coordinator.
  readonly inWork: readonly number[]
  readonly now: number
  readonly phase: 'choice' | 'claim'
}

// One more condition of the choice: why `task` is not taken now, or null. Asked on the reading of the check and again
// on the fresh reading right before the claim. The tasks `operations` (a task created by an unfinished operation),
// `mvp-lead` (the limits of MVP tasks) and `merge` (no claims during a merge attempt) add theirs here.
export type ChoiceRule = (task: TaskView, context: ChoiceContext) => string | null | Promise<string | null>

// The fresh reading of a target right before its claim: the issue (state, labels, body), its comments and claims;
// `readAt` (and `now`) — when the reading began.
export type ClaimTarget = {
  readonly issue: Issue
  readonly comments: readonly Comment[]
  readonly claims: Claims
  readonly now: number
  readonly readAt: number
}

export type ClaimOptions = {
  // `takeover` for a new count of a task another coordinator leads (the decision is the watchdog's, Ф10).
  readonly kind?: ClaimKind
  // The reading the caller's decision was made on (expectationOf): the claim goes on only when the fresh reading shows
  // the same last count, its activity and its progress — otherwise `changed`, and the caller decides again.
  readonly expect?: Expectation
  // Whether the target may be claimed, on the fresh reading: why not, or null. Without it, the rules of the queue: an
  // open task with `agent-queue`, without `blocked` and `split`; for a claim no active claim (claimBar), no open
  // dependency in its fresh text and every rule of the choice; for a takeover an active count of another coordinator.
  readonly admit?: (target: ClaimTarget) => string | null | Promise<string | null>
  // The labels of the target's stage (the first of `on` is set right after the claim); the queue's by default.
  readonly labels?: StageLabels
  // Whether the coordinator of this computer is still on: asked right before the claim is written and before every
  // later write of its completion and the start of its agents.
  readonly enabled?: () => Promise<boolean>
  // Who completes and leads the claim after a failure or a restart: `queue` (by default) — the check of the queue, for
  // a task of its list; `caller` — the code that claimed it, by calling claimTask again for the same target (a closed
  // task, the «MVP» issue): the check of the queue then leaves that count alone. Kept with the claim, with `labels`.
  readonly recovery?: 'queue' | 'caller'
}

export type ClaimOutcome =
  // This coordinator leads the target (count `count`); the hook `started` ran.
  | { readonly kind: 'leads'; readonly issue: number; readonly count: number }
  // Another claim of the same count came first in GitHub's order: the notice «Задачу ведёт <leader>» is on GitHub
  // (`noticed`) or is written at the next check; nothing more.
  | {
      readonly kind: 'lost'
      readonly issue: number
      readonly count: number
      readonly leader: string
      readonly noticed: boolean
    }
  // The count ended or a newer one was opened before this claim was complete: nothing more written.
  | { readonly kind: 'yielded'; readonly issue: number; readonly count: number; readonly leader: string | null }
  // The owner took `working` off before the claim was complete: the count is released, no agents started.
  | { readonly kind: 'released'; readonly issue: number; readonly count: number }
  // The claim is written, but not complete (its label or its re-read failed): the next check of the queue completes it.
  | { readonly kind: 'incomplete'; readonly issue: number; readonly count: number; readonly error: string }
  // The claim is not seen in the reading (yet): the next check decides by GitHub.
  | { readonly kind: 'unconfirmed'; readonly issue: number; readonly count: number }
  // The target may not be claimed now (its admission on the fresh reading).
  | { readonly kind: 'not-free'; readonly issue: number; readonly reason: string }
  // The fresh reading differs from the one the caller decided on: nothing written.
  | { readonly kind: 'changed'; readonly issue: number; readonly reason: string }
  // A read or the claim's own write failed before the claim was on GitHub (or with its answer lost: the next check
  // finds it there).
  | { readonly kind: 'failed'; readonly issue: number; readonly error: string }

export type ProjectCheck = {
  readonly project: QueueProject
  // Why this project was not checked (its settings or GitHub could not be read); null when it was.
  readonly error: string | null
  // Open tasks with an active claim (in work), by any coordinator, after this coordinator's own were checked (a count
  // it released in this check is not in work).
  readonly inWork: readonly number[]
  // The tasks this coordinator leads after the check.
  readonly led: readonly number[]
  // The claim of this check, if one was made.
  readonly claimed: ClaimOutcome | null
  // The tasks not taken, each with why (oldest first).
  readonly skipped: readonly { readonly issue: number; readonly reason: string }[]
}

export type CheckOptions = {
  // Whether the coordinator of this computer is still on: asked before each project and each task, before each new
  // claim and right before every new action on a task (a label, a release, a notice, the start of agents, the next
  // step of a stage). Off — the check ends there; a write already sent may finish, and a claim written already is
  // completed (and its agents start) once the coordinator is on again.
  readonly enabled?: () => Promise<boolean>
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
  // Whether the coordinator is still on (CheckOptions.enabled), when the caller asks.
  readonly enabled?: () => Promise<boolean>
}

type Step<T> = { readonly done: ClaimOutcome } | { readonly next: T }

export class Coordinator {
  readonly id: string
  private readonly machine: Machine
  private readonly journal: ClaimJournal
  private readonly hooks: CoordinatorHooks
  private readonly options: CoordinatorOptions
  // The checks and writes of each task, one at a time (right.ts) — for every coordinator of this worker on the same
  // computer and data directory: they share the journal, so they share the queue of each task too.
  private readonly gates: Map<string, TaskGate>
  // The completions of claims under way, by task and count: one at a time.
  private readonly completions = new Map<string, Promise<ClaimOutcome>>()

  constructor(options: CoordinatorOptions) {
    this.options = options
    this.id = options.coordinatorId
    this.machine = options.machine
    this.journal = new ClaimJournal(options.machine, options.dataDir)
    this.hooks = options.hooks ?? {}
    this.gates = gatesOf(options.machine, options.dataDir)
  }

  // One check of the queue: every project in turn, while the coordinator is on.
  async checkQueue(projects: readonly QueueProject[], options: CheckOptions = {}): Promise<ProjectCheck[]> {
    const checks: ProjectCheck[] = []
    for (const project of projects) {
      if (!(await this.isOn(options.enabled))) {
        this.log('switched off: the check of the queue ends here')
        break
      }
      checks.push(await this.checkProject(project, options))
    }
    return checks
  }

  async checkProject(project: QueueProject, options: CheckOptions = {}): Promise<ProjectCheck> {
    const failed = (error: string): ProjectCheck => {
      this.log(`${project.name}: the queue was not checked: ${error}`)
      return { project, error, inWork: [], led: [], claimed: null, skipped: [] }
    }
    let pass: Pass
    let tasks: TaskView[]
    try {
      pass = await this.pass(project, options.enabled)
      tasks = await this.readTasks(pass)
    } catch (error) {
      return failed(errorMessage(error))
    }
    const touched = new Set<number>()
    // The active counts this check released (the owner took `working` off): no longer in work.
    const released = new Set<number>()
    const led: number[] = []
    let off = false
    await this.checkOutside(pass, tasks)
    for (const task of tasks) {
      // Switched off meanwhile: the check ends between two tasks.
      if (!(await this.isOn(pass.enabled))) {
        off = true
        break
      }
      try {
        const own = await this.checkOwn(pass, task, touched)
        if (own === 'leads') led.push(task.issue.number)
        if (own === 'released') released.add(task.issue.number)
      } catch (error) {
        touched.add(task.issue.number)
        this.log(`${project.name} #${task.issue.number}: ${errorMessage(error)}`)
      }
    }
    // In work: the tasks with an active claim, by any coordinator — but an active count this check released.
    const occupied = new Set(
      tasks.filter((task) => task.claims.active && !released.has(task.issue.number)).map((task) => task.issue.number),
    )
    const result = (claimed: ClaimOutcome | null, skipped: { issue: number; reason: string }[]): ProjectCheck => ({
      project,
      error: null,
      inWork: [...occupied],
      led,
      claimed,
      skipped,
    })
    if (off) {
      this.log(`${project.name}: switched off: the check ends here`)
      return result(null, [])
    }
    if (await this.queueStopped(project)) return result(null, [])
    const skipped: { issue: number; reason: string }[] = []
    const max = pass.settings.maxInProgress
    const choice: ChoiceContext = {
      project,
      settings: pass.settings,
      tasks,
      inWork: [...occupied],
      now: this.machine.now(),
      phase: 'choice',
    }
    const candidates: TaskView[] = []
    const dependencies = new Map<number, string | null>()
    for (const task of tasks) {
      const reason = touched.has(task.issue.number)
        ? 'checked as its own by this coordinator in this check'
        : await this.notChosen(pass, task, choice, dependencies)
      if (reason === null) candidates.push(task)
      else skipped.push({ issue: task.issue.number, reason })
    }
    // The tasks read again before their claims in this check: the context of every next candidate has them.
    const reread = new Map<number, TaskView>()
    for (const task of candidates) {
      const number = task.issue.number
      // The limit again: a fresh reading of an earlier candidate may have shown it taken meanwhile.
      const others = [...occupied].filter((one) => one !== number).length
      if (others >= max) {
        skipped.push({ issue: number, reason: `limit: ${others} of ${max} in work` })
        continue
      }
      // The context of this candidate: the tasks in work now, and the tasks with those read again.
      const context: ChoiceContext = {
        project,
        settings: pass.settings,
        tasks: tasks.map((one) => reread.get(one.issue.number) ?? one),
        inWork: [...occupied],
        now: this.machine.now(),
        phase: 'claim',
      }
      // The claim on a fresh reading of the task: admitted again there, or the choice goes on with the next one.
      const expect = expectationOf(task.claims)
      const claimed = await this.runClaim(pass, number, { kind: 'claim', expect }, context, (target) => {
        reread.set(number, { issue: target.issue, comments: target.comments, claims: target.claims, readAt: target.readAt })
        // A count the fresh reading showed active is in work from now on.
        if (target.claims.active) occupied.add(number)
      })
      if (claimed.kind === 'not-free' || claimed.kind === 'changed') {
        skipped.push({ issue: number, reason: claimed.reason })
        if (claimed.reason === SWITCHED_OFF) break
        continue
      }
      if (claimed.kind === 'leads') led.push(claimed.issue)
      return result(claimed, skipped)
    }
    return result(null, skipped)
  }

  // A claim of task #number by the protocol of counts (see the header): `options.kind`, `expect`, `admit`, `labels`,
  // `recovery`. When this coordinator already leads the target's last count through this project (or nobody completed
  // it yet), nothing new is written: a claim of its not complete yet is completed — with the labels kept with that
  // claim —, a complete one answers `leads`. So the caller that owns the recovery of its claim (`recovery: 'caller'`)
  // completes it after a failure or a restart by asking again.
  async claimTask(project: QueueProject, number: number, options: ClaimOptions = {}): Promise<ClaimOutcome> {
    let pass: Pass
    try {
      pass = await this.pass(project, options.enabled)
    } catch (error) {
      return { kind: 'failed', issue: number, error: errorMessage(error) }
    }
    const context: ChoiceContext = {
      project,
      settings: pass.settings,
      tasks: [],
      inWork: [],
      now: this.machine.now(),
      phase: 'claim',
    }
    return this.runClaim(pass, number, options, context)
  }

  // ── The protocol of counts ────────────────────────────────────────────────────────────────────────────────────────

  // `seen` — every fresh reading of the target, for the choice (the tasks read again; a count found active is in work).
  private async runClaim(
    pass: Pass,
    number: number,
    options: ClaimOptions,
    context: ChoiceContext,
    seen?: (target: ClaimTarget) => void,
  ): Promise<ClaimOutcome> {
    const { github, project, settings } = pass
    const repository = project.repository
    const kind = options.kind ?? 'claim'
    const requested = options.labels ?? ACTIVE_LABELS
    const gate = this.gate(pass, number)
    let step: Step<number>
    try {
      // The fresh reading, the admission on it and the claim: no other step of this task between them.
      step = await gate.run(async (): Promise<Step<number>> => {
        const target = await this.read(pass, number)
        if ('refused' in target) return { done: { kind: 'not-free', issue: number, reason: target.refused } }
        seen?.(target)
        let claims = target.claims
        // This coordinator leads the last count already: nothing new is written; a claim nobody completed yet is
        // completed; one another project of this repository completed is not this project's.
        if (claims.active && claims.leader === this.id) {
          const owner = this.ownerOf(pass, number, claims.last)
          if (owner === 'none') return { next: claims.last }
          if (owner === 'mine') return { done: { kind: 'leads', issue: number, count: claims.last } }
          return { done: { kind: 'not-free', issue: number, reason: LED_ELSEWHERE } }
        }
        if (options.expect) {
          const changed = changedSince(options.expect, claims)
          if (changed !== null) return { done: { kind: 'changed', issue: number, reason: changed } }
        }
        const reason = options.admit
          ? await options.admit(target)
          : await this.queueAdmission(pass, target, kind, { ...context, phase: 'claim', now: target.now })
        if (reason !== null) return { done: { kind: 'not-free', issue: number, reason } }
        if (!(await this.isOn(pass.enabled))) return { done: { kind: 'not-free', issue: number, reason: SWITCHED_OFF } }
        const count = claims.last + 1
        // How this attempt goes on is kept before its POST: who completes it, the labels of its stage.
        await this.journal.writeProfile(repository, number, count, {
          recovery: options.recovery ?? 'queue',
          on: requested.on,
          off: requested.off,
        })
        // The reading the count was taken from must hold right before the POST: an older one is read again once.
        if (!fresh(target.readAt, this.machine.now())) {
          const at = this.machine.now()
          const comments = await github.listComments(number)
          const again = readClaims(comments)
          seen?.({ ...target, comments, claims: again, readAt: at, now: at })
          const changed = changedSince(expectationOf(claims), again)
          if (changed !== null) {
            return { done: { kind: 'changed', issue: number, reason: `changed during the admission: ${changed}` } }
          }
          if (!fresh(at, this.machine.now())) {
            return { done: { kind: 'changed', issue: number, reason: 'the claims could not be read within 30 seconds' } }
          }
          claims = again
        }
        gate.writes++
        await github.comment(number, {
          mark: { kind, coordinator: this.id, claim: count },
          text: githubSegments(settings.language, kind === 'claim' ? 'claim.claim' : 'claim.takeover', {
            coordinator: field.coordinator(this.id),
            claim: field.claim(count),
          }),
        })
        await this.record(repository, number, count, 'claimed')
        this.log(`${project.name} #${number}: ${kind} of count ${count} written`)
        return { next: count }
      })
    } catch (error) {
      // The answer may have been lost after GitHub wrote the claim: the next check finds it there and completes it.
      this.log(`${project.name} #${number}: the claim did not go through: ${errorMessage(error)}`)
      return { kind: 'failed', issue: number, error: errorMessage(error) }
    }
    if ('done' in step) return step.done
    return this.completeClaim(pass, number, step.next, requested)
  }

  // The completion of a claim of this coordinator — right after it, and later when it was not complete (a failed label,
  // a failed re-read, a restart of the worker). One completion of a count at a time on this coordinator: a second one
  // asked while it runs gets its outcome.
  // The completion is shared by the repository, task and count, so a call of another connected copy of the repository
  // can join it: each caller gets the outcome for its own project — `leads` only for the project kept in `led`.
  private async completeClaim(pass: Pass, number: number, count: number, requested: StageLabels): Promise<ClaimOutcome> {
    const key = `${this.gateKey(pass, number)}:${count}`
    let completion = this.completions.get(key)
    if (completion === undefined) {
      completion = this.runCompletion(pass, number, count, requested).finally(() => {
        this.completions.delete(key)
      })
      this.completions.set(key, completion)
    }
    const outcome = await completion
    if (outcome.kind === 'leads' && this.ownerOf(pass, number, count) !== 'mine') {
      return { kind: 'not-free', issue: number, reason: LED_ELSEWHERE }
    }
    return outcome
  }

  // The completion: with the labels kept with the claim (its profile; `requested` when none is kept) —
  // 1. on a fresh reading, while the count is the last, active one and this coordinator one of its claimants: a release
  //    decided already (`releasing`) is written first and ends it; otherwise `agent-queue:working` — when it is among the
  //    labels of the stage — is set when it was never on for this count (`labelled`); on, but gone since — left for
  //    step 3;
  // 2. the wait REREAD_AFTER_MS after the label was on;
  // 3. the re-read: another claimant leads — the notice; this coordinator leads — `working` gone meanwhile is decided by
  //    removalOrigin: the owner's — the count is released, no agents; a former leader's late write — set again; not
  //    known — the next check decides;
  // 4. the labels of its stage, the switch, the right confirmed, `led` — only the one that creates it, keeping this
  //    project — and the start, synchronously on the confirming reading.
  private async runCompletion(
    pass: Pass,
    number: number,
    count: number,
    requested: StageLabels,
  ): Promise<ClaimOutcome> {
    const { github, project } = pass
    const repository = project.repository
    const gate = this.gate(pass, number)
    const profile = this.keptStage(repository, number, count) ?? requested
    // The label of the protocol: `agent-queue:working`, wherever it stands among the labels of the stage.
    const label = profile.on.includes(WORKING) ? WORKING : null
    const right = this.right(pass, number, count)
    let first: Step<{ readonly release: boolean; readonly issue: Issue }>
    try {
      first = await gate.run(async (): Promise<Step<{ readonly release: boolean; readonly issue: Issue }>> => {
        const target = await this.read(pass, number)
        if ('refused' in target) return { done: { kind: 'not-free', issue: number, reason: target.refused } }
        const ended = this.ended(target.claims, number, count)
        if (ended !== null) return { done: ended }
        if (this.has(repository, number, count, 'releasing')) return { next: { release: true, issue: target.issue } }
        if (label === null || hasLabel(target.issue.labels, label)) {
          await this.record(repository, number, count, 'labelled')
        } else if (!this.has(repository, number, count, 'labelled')) {
          if (!(await this.isOn(pass.enabled))) return { done: this.incomplete(project, number, count, SWITCHED_OFF) }
          if (!fresh(target.readAt, this.machine.now())) {
            return { done: this.incomplete(project, number, count, STALE_READING) }
          }
          gate.writes++
          await github.addLabels(number, [label])
          await this.record(repository, number, count, 'labelled')
          this.log(`${project.name} #${number}: ${label} set for the claim of count ${count}`)
        }
        return { next: { release: false, issue: target.issue } }
      })
    } catch (error) {
      // The claim without its label: completed at the next check; the others do not take the task meanwhile (claimBar).
      return this.incomplete(project, number, count, `the label after the claim was not set: ${errorMessage(error)}`)
    }
    if ('done' in first) return first.done
    if (first.next.release) return this.releaseClaim(pass, first.next.issue, count, right)
    const since = this.journal.time(repository, number, count, 'labelled') ?? this.machine.now()
    const wait = since + REREAD_AFTER_MS - this.machine.now()
    if (wait > 0) await this.sleep(wait)
    let target: ClaimTarget | { readonly refused: string }
    try {
      target = await this.read(pass, number)
    } catch (error) {
      return this.incomplete(project, number, count, `the re-read after the claim failed: ${errorMessage(error)}`)
    }
    if ('refused' in target) return { kind: 'not-free', issue: number, reason: target.refused }
    const ended = this.ended(target.claims, number, count)
    if (ended !== null) return ended
    if (target.claims.leader !== this.id) {
      const leader = target.claims.leader as string
      const noticed = await this.noticeLeader(pass, number, count, leader)
      this.log(`${project.name} #${number}: count ${count} is led by ${leader}`)
      return { kind: 'lost', issue: number, count, leader, noticed }
    }
    let issue = target.issue
    try {
      // A release decided while it waited (by another worker of this journal) comes first here too.
      if (this.has(repository, number, count, 'releasing')) return this.releaseClaim(pass, issue, count, right)
      if (label === WORKING && !hasLabel(issue.labels, WORKING)) {
        // Gone while it waited (or since a restart).
        const origin = await this.removedBy(pass, target.claims, number, count)
        if (origin === 'unknown') return this.incomplete(project, number, count, 'who took working off is not known yet')
        if (origin === 'manual') return this.releaseClaim(pass, issue, count, right)
        this.log(`${project.name} #${number}: ${WORKING} was taken off by a late write of a former leader; set again`)
      }
      const brought = await this.bringLabels(pass, right, issue, profile)
      if (brought === 'off') return this.incomplete(project, number, count, SWITCHED_OFF)
      if (brought === 'refused') return { kind: 'yielded', issue: number, count, leader: null }
      issue = brought
    } catch (error) {
      return this.incomplete(project, number, count, `the labels of the stage were not set: ${errorMessage(error)}`)
    }
    // Switched off meanwhile: no agents start; the claim is completed when the coordinator is on again.
    if (!(await this.isOn(pass.enabled))) return this.incomplete(project, number, count, SWITCHED_OFF)
    // The start is an action on the task: the right is confirmed by a fresh read of the claims first.
    let confirmed: RightCheck | Refused
    try {
      confirmed = await right.confirm()
    } catch (error) {
      return this.incomplete(project, number, count, `the right was not confirmed: ${errorMessage(error)}`)
    }
    if ('ok' in confirmed) return { kind: 'yielded', issue: number, count, leader: confirmed.leader }
    const lead = await this.recordLed(pass, number, count)
    if (lead === 'failed') {
      return this.incomplete(project, number, count, 'the journal did not take the record of the lead')
    }
    // Another completion of this count recorded the lead first: it starts the agents, not this one.
    if (lead === 'mine') return { kind: 'leads', issue: number, count }
    if (lead === 'foreign') return { kind: 'not-free', issue: number, reason: LED_ELSEWHERE }
    if (!fresh(confirmed.at, this.machine.now())) {
      // The record took long: the right is confirmed again; refused or failed — no start (a lost count gets `lost` at
      // the next check, an active one goes on through `leading`).
      try {
        confirmed = await right.confirm()
      } catch (error) {
        return this.incomplete(project, number, count, `the right was not confirmed: ${errorMessage(error)}`)
      }
      if ('ok' in confirmed) return { kind: 'yielded', issue: number, count, leader: confirmed.leader }
    }
    this.log(`${project.name} #${number}: leads count ${count}`)
    const led = this.ledTask(pass, issue, confirmed.claims, count, right)
    await this.callHook('started', project, number, () => this.hooks.started?.(led))
    return { kind: 'leads', issue: number, count }
  }

  // The release of a count whose claim was not complete: no agents were started, so no local handling; `released`, or
  // `incomplete` when it was not written (the next check writes it).
  private async releaseClaim(pass: Pass, issue: Issue, count: number, right: Right): Promise<ClaimOutcome> {
    try {
      if (await this.release(pass, issue, count, right, false)) return { kind: 'released', issue: issue.number, count }
      return this.incomplete(pass.project, issue.number, count, 'the release was not written')
    } catch (error) {
      return this.incomplete(pass.project, issue.number, count, `the release was not written: ${errorMessage(error)}`)
    }
  }

  // The outcome when count `count` is no claim of this coordinator to complete any more — a newer count, the count
  // released, this coordinator's claim not seen — or null when it is the last, active one with this claim.
  private ended(claims: Claims, number: number, count: number): ClaimOutcome | null {
    if (claims.last > count) return { kind: 'yielded', issue: number, count, leader: claims.leader }
    if (claims.last < count || claimOf(claims, count, this.id) === undefined) {
      return { kind: 'unconfirmed', issue: number, count }
    }
    if (!claims.active) return { kind: 'yielded', issue: number, count, leader: claims.leader }
    return null
  }

  // The notice of a claimant that lost count `count`: «Задачу ведёт <leader>» with the mark `yield` of this coordinator
  // and that count — written once: a notice already on GitHub (also one whose answer was lost) is not written again,
  // and none is needed when the count is no longer the last, active one of that leader. True when no notice is
  // missing; false when it was not written (a failure, the coordinator is off, or its reading got older than
  // RIGHT_VALID_MS: the next check writes it).
  private async noticeLeader(pass: Pass, number: number, count: number, leader: string): Promise<boolean> {
    const { github, settings, project } = pass
    const gate = this.gate(pass, number)
    try {
      return await gate.run(async () => {
        const at = this.machine.now()
        const claims = readClaims(await github.listComments(number))
        if (hasNotice(claims, count, this.id)) return true
        if (claims.last !== count || !claims.active || claims.leader !== leader) return true
        if (!(await this.isOn(pass.enabled))) return false
        if (!fresh(at, this.machine.now())) return false
        gate.writes++
        await github.comment(number, {
          mark: { kind: 'yield', coordinator: this.id, claim: count },
          text: githubSegments(settings.language, 'claim.ledBy', { coordinator: field.coordinator(leader) }),
        })
        return true
      })
    } catch (error) {
      this.log(`${project.name} #${number}: the notice «led by ${leader}» was not written: ${errorMessage(error)}`)
      return false
    }
  }

  // The labels of the stage of the count `right` stands for, each write through the right; the issue as it is after
  // them — `refused` when another coordinator leads, `off` when the coordinator was switched off.
  private async bringLabels(
    pass: Pass,
    right: Right,
    issue: Issue,
    profile: StageLabels,
  ): Promise<Issue | 'refused' | 'off'> {
    const { github, project } = pass
    let labels = [...issue.labels]
    for (const label of profile.on) {
      if (hasLabel(labels, label)) continue
      const set = await right.act(() => github.addLabels(issue.number, [label]))
      if (!set.ok) return 'off' in set ? 'off' : 'refused'
      labels = set.value
      this.log(`${project.name} #${issue.number}: ${label} set: the labels of count ${right.count}`)
    }
    for (const label of profile.off) {
      if (!hasLabel(labels, label)) continue
      const removed = await right.act(() => github.removeLabel(issue.number, label))
      if (!removed.ok) return 'off' in removed ? 'off' : 'refused'
      labels = labels.filter((one) => one.toLowerCase() !== label.toLowerCase())
      this.log(`${project.name} #${issue.number}: ${label} taken off: count ${right.count} is in work`)
    }
    return { ...issue, labels }
  }

  // Who took `working` off (claims.ts, removalOrigin), on the events of the label read now; `unknown` when they could
  // not be read. A release decided already (`releasing`) is written to the end.
  private async removedBy(pass: Pass, claims: Claims, number: number, count: number): Promise<RemovalOrigin> {
    if (this.has(pass.project.repository, number, count, 'releasing')) return 'manual'
    try {
      return removalOrigin(claims, count, await pass.github.labelEvents(number, WORKING))
    } catch (error) {
      this.log(`${pass.project.name} #${number}: the events of ${WORKING} were not read: ${errorMessage(error)}`)
      return 'unknown'
    }
  }

  // ── Its own claims and counts ─────────────────────────────────────────────────────────────────────────────────────

  // Checks `task` for this coordinator (step 2 of the header). `leads` when it leads the task through this project after
  // it, `released` when it released the task's active count in this check.
  private async checkOwn(pass: Pass, task: TaskView, touched: Set<number>): Promise<'leads' | 'released' | 'none'> {
    const { project, github } = pass
    const repository = project.repository
    const { claims } = task
    const number = task.issue.number
    await this.handleLost(pass, task, touched)
    // A claim of its that lost the last count: the notice of the leader, once.
    if (claims.active && claims.leader !== this.id && claimOf(claims, claims.last, this.id) !== undefined) {
      touched.add(number)
      if (!hasNotice(claims, claims.last, this.id)) {
        await this.noticeLeader(pass, number, claims.last, claims.leader as string)
      }
    }
    if (!claims.active || claims.leader !== this.id) return 'none'
    touched.add(number)
    const count = claims.last
    const owner = this.ownerOf(pass, number, count)
    // Another Orca project of this repository completed the claim: it leads the count on this computer, not this one.
    if (owner === 'foreign') return 'none'
    const kept = this.journal.profile(repository, number, count)
    // A claim whose caller completes and leads it (recovery `caller`) is not the queue's: the caller asks again.
    if (kept?.recovery === 'caller') return owner === 'mine' ? 'leads' : 'none'
    // A claim of its not complete yet: the same completion as right after a claim.
    if (owner === 'none') {
      const completed = await this.completeClaim(pass, number, count, ACTIVE_LABELS)
      return completed.kind === 'leads' ? 'leads' : completed.kind === 'released' ? 'released' : 'none'
    }
    const right = this.right(pass, number, count)
    // A release decided already comes before everything else of the count, whatever the label is now.
    if (this.has(repository, number, count, 'releasing')) {
      return (await this.release(pass, task.issue, count, right, true)) ? 'released' : 'none'
    }
    const profile = this.keptStage(repository, number, count) ?? ACTIVE_LABELS
    let issue = task.issue
    if (profile.on.includes(WORKING)) {
      if (!hasLabel(issue.labels, WORKING)) {
        // The labels read with the list may be older: the task is read again before deciding.
        const lookup = await github.getIssue(number)
        if (lookup.found !== 'owner') return 'none'
        issue = lookup.issue
      }
      if (hasLabel(issue.labels, WORKING)) {
        await this.record(repository, number, count, 'labelled')
      } else if (!this.has(repository, number, count, 'labelled')) {
        // Never on for this count (the write after the claim failed): it is set now.
        const set = await right.act(() => github.addLabels(number, [WORKING]))
        if (!set.ok) return 'none'
        await this.record(repository, number, count, 'labelled')
        issue = { ...issue, labels: set.value }
      } else {
        const origin = await this.removedBy(pass, claims, number, count)
        // Not known now: nothing is done on the task in this check — the next one decides.
        if (origin === 'unknown') return 'none'
        if (origin === 'manual') {
          return (await this.release(pass, issue, count, right, true)) ? 'released' : 'none'
        }
        // A former leader's late write: the label of its stage is set again, no comment.
        const set = await right.act(() => github.addLabels(number, [WORKING]))
        if (!set.ok) return 'none'
        issue = { ...issue, labels: set.value }
        this.log(`${project.name} #${number}: ${WORKING} was taken off by a late write of a former leader; set again`)
      }
    }
    const brought = await this.bringLabels(pass, right, issue, profile)
    if (typeof brought === 'string') return brought === 'off' ? 'leads' : 'none'
    // The stage goes on only while the coordinator is on, and on a fresh confirmation of the right.
    if (!(await this.isOn(pass.enabled))) return 'leads'
    const confirmed = await right.confirm()
    if ('ok' in confirmed) return 'none'
    const led = this.ledTask(pass, brought, confirmed.claims, count, right)
    await this.callHook('leading', project, number, () => this.hooks.leading?.(led))
    return 'leads'
  }

  // Counts it led through this project that are lost or released: their local handling, until it has ended. A count it
  // ended itself by a block or a deferral needs none (their tasks handle its agents): it is marked handled at once.
  private async handleLost(pass: Pass, task: TaskView, touched: Set<number>): Promise<void> {
    const repository = pass.project.repository
    const { claims } = task
    const number = task.issue.number
    for (const count of this.journal.counts(repository, number)) {
      if (this.ownerOf(pass, number, count) !== 'mine' || this.has(repository, number, count, 'handled')) continue
      if (claims.last === count && claims.leader === this.id && claims.active) continue
      const end = ownEnd(claims, count, this.id)
      const releasedByOwner = end?.mark.kind === 'release' && this.has(repository, number, count, 'releasing')
      if (end !== undefined && !releasedByOwner) {
        await this.record(repository, number, count, 'handled')
        continue
      }
      touched.add(number)
      if (!releasedByOwner) await this.record(repository, number, count, 'yielded')
      await this.handleLoss(pass, task.issue, count, releasedByOwner ? 'released-by-owner' : 'newer-count', claims.leader)
    }
  }

  // The pending local handling of counts this project led, of tasks no longer among the open tasks of the queue
  // (closed, or taken out of the queue): read by their number from the journal.
  private async checkOutside(pass: Pass, tasks: readonly TaskView[]): Promise<void> {
    const repository = pass.project.repository
    for (const number of this.journal.issues(repository)) {
      if (tasks.some((task) => task.issue.number === number)) continue
      const pending = this.journal
        .counts(repository, number)
        .some((count) => this.ownerOf(pass, number, count) === 'mine' && !this.has(repository, number, count, 'handled'))
      if (!pending) continue
      try {
        const target = await this.read(pass, number)
        if ('refused' in target) continue
        const { issue, comments, claims, readAt } = target
        const task: TaskView = { issue, comments, claims, readAt }
        await this.handleLost(pass, task, new Set())
      } catch (error) {
        this.log(`${pass.project.name} #${number}: ${errorMessage(error)}`)
      }
    }
  }

  // The release of count `count` after the owner took `working` off: the decision is kept (`releasing`) before the
  // release is written, so a write whose answer was lost is found at the next check — the release there — or written
  // again; then, for a count it led (`hook`), the local handling of the count. True when the release is on GitHub.
  private async release(pass: Pass, issue: Issue, count: number, right: Right, hook: boolean): Promise<boolean> {
    const { github, settings, project } = pass
    if (!(await this.record(project.repository, issue.number, count, 'releasing'))) return false
    const released = await right.act(() =>
      github.comment(issue.number, {
        mark: { kind: 'release', coordinator: this.id, claim: count },
        text: githubSegments(settings.language, 'claim.released', {
          coordinator: field.coordinator(this.id),
          claim: field.claim(count),
        }),
      }),
    )
    if (!released.ok) return false
    this.log(`${project.name} #${issue.number}: ${WORKING} was taken off by the owner; count ${count} released`)
    if (hook) await this.handleLoss(pass, issue, count, 'released-by-owner', this.id)
    return true
  }

  // The local handling of a count this coordinator led and lost or released: the hook `lost`, then `handled`. A hook
  // that fails is run again at the next check.
  private async handleLoss(
    pass: Pass,
    issue: Issue,
    count: number,
    reason: LostTask['reason'],
    leader: string | null,
  ): Promise<void> {
    if (reason === 'newer-count') {
      this.log(`${pass.project.name} #${issue.number}: count ${count} is lost to ${leader ?? '?'}; nothing more is written`)
    }
    try {
      await this.hooks.lost?.({ project: pass.project, issue, count, reason, leader })
    } catch (error) {
      const why = errorMessage(error)
      this.log(`${pass.project.name} #${issue.number}: the handling of count ${count} failed; it runs again: ${why}`)
      return
    }
    await this.record(pass.project.repository, issue.number, count, 'handled')
  }

  // ── The choice ───────────────────────────────────────────────────────────────────────────────────────────────────

  // Why the task is not taken on the reading of the check (TZ Ф4): the owner's, labelled `agent-queue`, without
  // `blocked` and `split`, without an active claim (or with one left unsettled UNSETTLED_MS), not deferred, without
  // open dependencies, with fewer tasks in work than the project's limit — and every rule of `options.rules`.
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
    return this.linesAndRules(pass, task, context, dependencies)
  }

  // The admission of the queue on the fresh reading right before a claim (ClaimOptions.admit, when the caller gives
  // none). The project's limit stays as the check read it: re-reading it would need every task again.
  private async queueAdmission(
    pass: Pass,
    target: ClaimTarget,
    kind: ClaimKind,
    context: ChoiceContext,
  ): Promise<string | null> {
    const { issue, claims } = target
    const bar = issueBar(issue, kind)
    if (bar !== null) return bar
    if (kind === 'takeover') {
      if (!claims.active) return 'no active count to take over'
      return claims.leader === this.id ? 'led by this coordinator' : null
    }
    const free = claimBar(claims, issue.labels, target.now)
    if (free !== null) return free
    const task: TaskView = { issue, comments: target.comments, claims, readAt: target.now }
    return this.linesAndRules(pass, task, context, new Map())
  }

  // The task's lines (dependencies, read from its text) and the rules of the choice.
  private async linesAndRules(
    pass: Pass,
    task: TaskView,
    context: ChoiceContext,
    dependencies: Map<number, string | null>,
  ): Promise<string | null> {
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

  // Why the dependency #number holds the task (open, or its state unknown), or null when it is closed. On the reading
  // of the check an open task of the list is open; right before a claim every dependency is read afresh.
  private async openDependency(pass: Pass, context: ChoiceContext, number: number): Promise<string | null> {
    if (context.phase === 'choice' && context.tasks.some((task) => task.issue.number === number)) return 'open'
    try {
      const lookup = await pass.github.getIssue(number)
      const state = lookup.found === 'owner' ? lookup.issue.state : lookup.state
      return state === 'open' ? 'open' : null
    } catch (error) {
      return `not read: ${errorMessage(error)}`
    }
  }

  // ── Inside ───────────────────────────────────────────────────────────────────────────────────────────────────────

  private async pass(project: QueueProject, enabled?: () => Promise<boolean>): Promise<Pass> {
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
      ...(enabled ? { enabled } : {}),
    }
  }

  // The owner's open tasks of the queue, oldest first, each with its comments.
  private async readTasks(pass: Pass): Promise<TaskView[]> {
    const readAt = this.machine.now()
    const issues = await pass.github.listIssues({ state: 'open', labels: [QUEUED] })
    const tasks: TaskView[] = []
    for (const issue of issues) {
      const comments = await pass.github.listComments(issue.number)
      tasks.push({ issue, comments, claims: readClaims(comments), readAt })
    }
    return tasks
  }

  // A fresh reading of the target: the owner's issue and its comments; its time is taken before the read.
  private async read(pass: Pass, number: number): Promise<ClaimTarget | { readonly refused: string }> {
    const readAt = this.machine.now()
    const lookup = await pass.github.getIssue(number)
    if (lookup.found !== 'owner') return { refused: `not the owner's task (${lookup.reason})` }
    const comments = await pass.github.listComments(number)
    return { issue: lookup.issue, comments, claims: readClaims(comments), now: readAt, readAt }
  }

  // Which Orca project leads count `count` on this computer, by its record `led`: this pass's project (`mine`),
  // another one (`foreign` — also a record from which no project can be read: the count is nobody's), or none yet.
  private ownerOf(pass: Pass, number: number, count: number): 'mine' | 'foreign' | 'none' {
    const led = this.journal.ledBy(pass.project.repository, number, count)
    if (led === null) return 'none'
    if (led === 'unreadable') {
      this.log(`${pass.project.name} #${number}: the record of the lead of count ${count} names no project; nobody leads it`)
      return 'foreign'
    }
    return led.id === pass.project.id && led.hostId === pass.project.hostId ? 'mine' : 'foreign'
  }

  // The record `led` with this pass's project: `created` by this call, or already there — `mine` or `foreign`.
  private async recordLed(pass: Pass, number: number, count: number): Promise<'created' | 'mine' | 'foreign' | 'failed'> {
    try {
      if (await this.journal.writeLed(pass.project.repository, number, count, projectRef(pass.project))) return 'created'
      return this.ownerOf(pass, number, count) === 'mine' ? 'mine' : 'foreign'
    } catch (error) {
      const why = errorMessage(error)
      this.log(`${pass.project.name} #${number}: the journal record led of count ${count} was not written: ${why}`)
      return 'failed'
    }
  }

  private gateKey(pass: Pass, issue: number): string {
    return `${repositoryRef(pass.project.repository).toLowerCase()}#${issue}`
  }

  private gate(pass: Pass, issue: number): TaskGate {
    const key = this.gateKey(pass, issue)
    let gate = this.gates.get(key)
    if (gate === undefined) {
      gate = new TaskGate()
      this.gates.set(key, gate)
    }
    return gate
  }

  private right(pass: Pass, issue: number, count: number): Right {
    return new Right({
      github: pass.github,
      issue,
      count,
      coordinatorId: this.id,
      now: () => this.machine.now(),
      gate: this.gate(pass, issue),
      ...(pass.enabled ? { enabled: pass.enabled } : {}),
    })
  }

  // The labels of the stage kept with the claim of the count, or null when none are kept.
  private keptStage(repository: Repository, issue: number, count: number): StageLabels | null {
    const kept = this.journal.profile(repository, issue, count)
    if (kept === null) return null
    return { on: kept.on.filter(isPluginLabel), off: kept.off.filter(isPluginLabel) }
  }

  private ledTask(pass: Pass, issue: Issue, claims: Claims, count: number, right: Right): LedTask {
    return {
      project: pass.project,
      issue,
      count,
      kind: claims.kind ?? 'claim',
      stage: stageOf(claims, count, this.id),
      settings: pass.settings,
      github: pass.github,
      right,
    }
  }

  private has(repository: Repository, issue: number, count: number, record: JournalRecord): boolean {
    return this.journal.has(repository, issue, count, record)
  }

  // A record of the journal; a disk that refuses it is logged (false), and the protocol goes on by GitHub.
  private async record(repository: Repository, issue: number, count: number, record: JournalRecord): Promise<boolean> {
    try {
      await this.journal.write(repository, issue, count, record)
      return true
    } catch (error) {
      this.log(`#${issue}: the journal record ${record} of count ${count} was not written: ${errorMessage(error)}`)
      return false
    }
  }

  private incomplete(project: QueueProject, number: number, count: number, error: string): ClaimOutcome {
    this.log(`${project.name} #${number}: the claim of count ${count} is not complete: ${error}`)
    return { kind: 'incomplete', issue: number, count, error }
  }

  private async callHook(name: string, project: QueueProject, issue: number, run: () => unknown): Promise<void> {
    try {
      await run()
    } catch (error) {
      this.log(`${project.name} #${issue}: ${name}: ${errorMessage(error)}`)
    }
  }

  // Whether the coordinator is still on; a switch that cannot be read counts as off.
  private async isOn(enabled: (() => Promise<boolean>) | undefined): Promise<boolean> {
    if (enabled === undefined) return true
    try {
      return await enabled()
    } catch (error) {
      this.log(`the plugin's settings were not read; nothing new is taken: ${errorMessage(error)}`)
      return false
    }
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

// The queues of the tasks of each computer (the worker's Machine) and data directory: every coordinator on them takes
// the queues from here, so two coordinators of one journal (an old one still checking while a new one starts) never
// interleave their steps of one task — the reading, the choice of a claim's profile, its POST and its record are one
// step. Two worker processes on one data directory are no mode of the plugin (README «Агенты»).
const GATES = new WeakMap<object, Map<string, Map<string, TaskGate>>>()

function gatesOf(machine: Machine, dataDir: string): Map<string, TaskGate> {
  let byDir = GATES.get(machine)
  if (byDir === undefined) {
    byDir = new Map()
    GATES.set(machine, byDir)
  }
  let gates = byDir.get(dataDir)
  if (gates === undefined) {
    gates = new Map()
    byDir.set(dataDir, gates)
  }
  return gates
}

// The reason a claim gives when the coordinator was switched off before it was written.
export const SWITCHED_OFF = 'the coordinator of this computer is off'
// The reason when another Orca project of the same repository completed the claim: it leads the count on this computer.
export const LED_ELSEWHERE = 'led on this computer through another Orca project of this repository'
// The reason a write was not made: its reading of the claims began more than RIGHT_VALID_MS ago.
export const STALE_READING = 'the reading of the claims is older than 30 seconds; the next check writes it'

// Why the issue itself cannot be claimed by the rules of the queue: closed, not a task of the queue, or — for a claim —
// blocked or given to splitting; null when it can.
function issueBar(issue: Issue, kind: ClaimKind): string | null {
  if (issue.state !== 'open') return 'closed'
  if (!hasLabel(issue.labels, QUEUED)) return `no label ${QUEUED}`
  if (kind === 'claim' && hasLabel(issue.labels, BLOCKED)) return 'blocked'
  if (kind === 'claim' && hasLabel(issue.labels, SPLIT)) return 'split'
  return null
}

// The release comment (block, deferral, release) by which `coordinator` ended its count `count` itself: one that comes
// before the first claim of a newer count in GitHub's order. A release written after a newer claim — in the window
// after a takeover — does not count: the count was lost first.
function ownEnd(claims: Claims, count: number, coordinator: string): MarkedComment | undefined {
  const release = claims.marked.find(
    (one) => one.mark.claim === count && one.mark.coordinator === coordinator && isReleaseKind(one.mark.kind),
  )
  if (release === undefined) return undefined
  const newer = claims.marked.find((one) => isClaimKind(one.mark.kind) && (one.mark.claim ?? 0) > count)
  return newer === undefined || release.index < newer.index ? release : undefined
}

// Whether `coordinator` wrote its notice (`yield`) of count `count`.
function hasNotice(claims: Claims, count: number, coordinator: string): boolean {
  return claims.marked.some(
    (one) => one.mark.kind === 'yield' && one.mark.claim === count && one.mark.coordinator === coordinator,
  )
}

function projectRef(project: QueueProject): ProjectRef {
  return { id: project.id, hostId: project.hostId }
}

async function defaultSettings(machine: Machine, project: QueueProject): Promise<SettingsRead> {
  const read = await readProjectSettings(machine, project.checkout)
  return read.ok ? { ok: true, settings: read.settings } : { ok: false, error: read.error }
}

export type { ClaimBar }
