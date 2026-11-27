// The right to act on a task (TZ Ф4, «Право на действие»): before every action on a task — a comment, a label, the
// start or the next step of its agents (the hooks `started` and `leading`), and, with the next tasks, a message to an
// agent, a PR, a merge, the removal of a worktree — the coordinator re-reads the claims. A check holds RIGHT_VALID_MS
// from the start of its read, and it admits one write: a write whose check is older than that, whose check already
// admitted a write, or after whose check another write on the task went out, re-reads first. The age is checked last,
// synchronously, right before the write is called: nothing is awaited between them, so a long read of the switch or a
// long local step comes before the check, never between the check and the write; a read that itself took longer than
// RIGHT_VALID_MS writes nothing (RightExpired — for the caller a failed read of the claims). Not the leader of its count
// — the action writes nothing, and no later action of that count writes anything either: the count is lost for good
// once a newer one exists. A coordinator switched off writes nothing either: the switch is asked before the check.
//
// On one coordinator the checks and writes of one task go one at a time (TaskGate), whichever `Right` they come
// through: two actions started together cannot both pass a check made before a takeover. GitHub gives no conditional
// write, so the window between a check and its write stays: after a takeover the former leader manages at most the one
// write whose check came before it. That is why the leader of a new count takes its stage only from the comments of its
// own count (claims.ts, stageOf) and brings the labels to its stage itself.
import type { GitHub } from '../github/github'
import { readClaims, RIGHT_VALID_MS, type Claims } from './claims'

export type RightCheck = {
  // When the read of the claims began (the machine's clock): the check holds RIGHT_VALID_MS from here.
  readonly at: number
  // This coordinator is the leader of the right's count, and that count is the task's last one.
  readonly mine: boolean
  // The count is not released.
  readonly active: boolean
  readonly claims: Claims
}

// The action did not write: this coordinator does not lead the count (any more). `leader` and `last` — who leads the
// last count of the task now, and its number.
export type Refused = { readonly ok: false; readonly leader: string | null; readonly last: number }
// The action did not write: the coordinator of this computer is off.
export type SwitchedOff = { readonly ok: false; readonly off: true }
// The action did not write: the release of the count is decided (the journal's `releasing`); only the release goes on.
export type Releasing = { readonly ok: false; readonly releasing: true }
export type Acted<T> = { readonly ok: true; readonly value: T } | Refused | SwitchedOff | Releasing

// A check of the right whose read of the claims took longer than RIGHT_VALID_MS: nothing is written or started on it.
export class RightExpired extends Error {
  constructor() {
    super(`the check of the right took longer than ${RIGHT_VALID_MS / 1000} seconds; nothing was written`)
    this.name = 'RightExpired'
  }
}

// Whether a reading that began at `at` still holds at `now`.
export function fresh(at: number, now: number): boolean {
  return now - at <= RIGHT_VALID_MS
}

export type WriteOptions = {
  // Allow the write on the count this coordinator released itself — the label writes that finish its own release (a
  // block, a deferral). Without it a released count writes nothing.
  readonly released?: boolean
  // The write is the release the journal's `releasing` decided: the one write that decision admits.
  readonly release?: boolean
}

// The checks and writes of one task on one coordinator, one at a time, and what they know: how many writes went out (a
// check older than the last write is made again) and the counts lost for good.
export class TaskGate {
  private chain: Promise<unknown> = Promise.resolve()
  writes = 0
  readonly lost = new Map<number, Refused>()

  // Runs `step` after every step started before it has ended.
  run<T>(step: () => Promise<T>): Promise<T> {
    const result = this.chain.then(step)
    this.chain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

type Made = { readonly writes: number; used: boolean }

export class Right {
  // What each check of this right knew when it was made: the writes on the task before it, and whether it admitted one.
  private readonly made = new WeakMap<RightCheck, Made>()

  constructor(
    private readonly options: {
      readonly github: Pick<GitHub, 'listComments'>
      readonly issue: number
      // The count this coordinator leads.
      readonly count: number
      readonly coordinatorId: string
      readonly now: () => number
      // The task's gate of this coordinator: shared by every Right of the task.
      readonly gate: TaskGate
      // Whether the coordinator of this computer is still on: asked right before every write; off — nothing written.
      readonly enabled?: () => Promise<boolean>
      // Whether the release of the count is decided (the journal's `releasing`, read synchronously): then no action of
      // the count is admitted but the release itself. Asked in the same step of the task's queue as the read of the
      // claims, and that decision is recorded in a step of the same queue.
      readonly releasing?: () => boolean
    },
  ) {}

  get issue(): number {
    return this.options.issue
  }

  get count(): number {
    return this.options.count
  }

  // A check: the task's claims read now; its time is taken before the read.
  async check(): Promise<RightCheck> {
    const writes = this.options.gate.writes
    const at = this.options.now()
    const claims = readClaims(await this.options.github.listComments(this.options.issue))
    const mine = claims.last === this.options.count && claims.leader === this.options.coordinatorId
    const check = { at, mine, active: claims.active, claims }
    this.made.set(check, { writes, used: false })
    return check
  }

  // The write of an action whose check is `check` (see the header).
  write<T>(check: RightCheck, write: () => Promise<T>, options: WriteOptions = {}): Promise<Acted<T>> {
    return this.options.gate.run(() => this.admitted(check, write, options))
  }

  // One action that is only a write: its check is read right here, after the switch, then the write, with no other
  // step of the task between them.
  act<T>(write: () => Promise<T>, options: WriteOptions = {}): Promise<Acted<T>> {
    return this.options.gate.run(() => this.admitted(null, write, options))
  }

  // The right confirmed by a fresh read of the claims, for an action that is no write — the start or the next step of
  // the agents (the hooks): the check, or the refusal when this coordinator does not lead its active count. Throws
  // RightExpired when the read took longer than RIGHT_VALID_MS. The caller calls the action synchronously after it, or
  // confirms again when RIGHT_VALID_MS has passed since `at`.
  confirm(): Promise<RightCheck | Refused | Releasing> {
    return this.options.gate.run(async () => {
      const lost = this.options.gate.lost.get(this.options.count)
      if (lost !== undefined) return lost
      const current = await this.check()
      if (!current.mine || !current.active) return this.refuse(current)
      if (this.options.releasing?.()) return { ok: false, releasing: true }
      if (!fresh(current.at, this.options.now())) throw new RightExpired()
      return current
    })
  }

  private async isOn(): Promise<boolean> {
    try {
      return (await this.options.enabled?.()) ?? true
    } catch {
      return false
    }
  }

  // In order: a count lost for good; the switch; the check — the given one when it still holds, otherwise read now; the
  // leader of an active count (or of its own released one, with `released`); a release decided (only the release
  // itself goes on); the age of the check, synchronously; the write.
  private async admitted<T>(given: RightCheck | null, write: () => Promise<T>, options: WriteOptions): Promise<Acted<T>> {
    const gate = this.options.gate
    const lost = gate.lost.get(this.options.count)
    if (lost !== undefined) return lost
    if (!(await this.isOn())) return { ok: false, off: true }
    let current = given
    const made = current === null ? undefined : this.made.get(current)
    const holds = made !== undefined && !made.used && made.writes === gate.writes
    if (current === null || !holds || !fresh(current.at, this.options.now())) {
      current = await this.check()
    }
    if (!current.mine || (!current.active && !options.released)) return this.refuse(current)
    if (!options.release && this.options.releasing?.()) return { ok: false, releasing: true }
    if (!fresh(current.at, this.options.now())) throw new RightExpired()
    const record = this.made.get(current)
    if (record) record.used = true
    gate.writes++
    return { ok: true, value: await write() }
  }

  // The refusal of a check that is not this right's; a newer count, or the same count led by another, is lost for good.
  private refuse(current: RightCheck): Refused {
    const refused: Refused = { ok: false, leader: current.claims.leader, last: current.claims.last }
    if (current.claims.last > this.options.count || (current.claims.last === this.options.count && !current.mine)) {
      this.options.gate.lost.set(this.options.count, refused)
    }
    return refused
  }
}
