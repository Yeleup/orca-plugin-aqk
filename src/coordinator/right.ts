// The right to act on a task (TZ Ф4, «Право на действие»): before every action on a task — a comment, a label, and,
// with the next tasks, an agent's launch or message, a PR, a merge, the removal of a worktree — the coordinator re-reads
// the claims. A check holds RIGHT_VALID_MS, and it admits one write: a write whose check is older than that (a sleep of
// the computer, a long call), whose check already admitted a write, or after whose check another write on the task went
// out, re-reads first. Not the leader of its count — the action writes nothing, and no later action of that count
// writes anything either: the count is lost for good once a newer one exists. A coordinator switched off writes nothing
// either: the switch is asked right before every write.
//
// On one coordinator the checks and writes of one task go one at a time (TaskGate), whichever `Right` they come
// through: two actions started together cannot both pass a check made before a takeover. GitHub gives no conditional
// write, so the window between a check and its write stays: after a takeover the former leader manages at most the one
// write whose check came before it. That is why the leader of a new count takes its stage only from the comments of its
// own count (claims.ts, stageOf) and brings the labels to its stage itself.
import type { GitHub } from '../github/github'
import { readClaims, RIGHT_VALID_MS, type Claims } from './claims'

export type RightCheck = {
  // When the claims were read (the machine's clock).
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
export type Acted<T> = { readonly ok: true; readonly value: T } | Refused | SwitchedOff

export type WriteOptions = {
  // Allow the write on the count this coordinator released itself — the label writes that finish its own release (a
  // block, a deferral). Without it a released count writes nothing.
  readonly released?: boolean
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
    },
  ) {}

  get issue(): number {
    return this.options.issue
  }

  get count(): number {
    return this.options.count
  }

  // A check: the task's claims read now.
  async check(): Promise<RightCheck> {
    const writes = this.options.gate.writes
    const claims = readClaims(await this.options.github.listComments(this.options.issue))
    const mine = claims.last === this.options.count && claims.leader === this.options.coordinatorId
    const check = { at: this.options.now(), mine, active: claims.active, claims }
    this.made.set(check, { writes, used: false })
    return check
  }

  // The write of an action whose check is `check`. The check is made again first when it is older than RIGHT_VALID_MS,
  // admitted a write already, is not this right's, or another write on the task went out after it. Refused — nothing
  // written — when this coordinator does not lead the count.
  write<T>(check: RightCheck, write: () => Promise<T>, options: WriteOptions = {}): Promise<Acted<T>> {
    return this.options.gate.run(() => this.admitted(check, write, options))
  }

  // One action that is only a write: its check now, then the write, with no other step of the task between them.
  act<T>(write: () => Promise<T>, options: WriteOptions = {}): Promise<Acted<T>> {
    return this.options.gate.run(async () => this.admitted(await this.freshCheck(), write, options))
  }

  private async isOn(): Promise<boolean> {
    try {
      return (await this.options.enabled?.()) ?? true
    } catch {
      return false
    }
  }

  private async freshCheck(): Promise<RightCheck | Refused> {
    const lost = this.options.gate.lost.get(this.options.count)
    return lost ?? this.check()
  }

  private async admitted<T>(
    given: RightCheck | Refused,
    write: () => Promise<T>,
    options: WriteOptions,
  ): Promise<Acted<T>> {
    const gate = this.options.gate
    const lost = gate.lost.get(this.options.count)
    if (lost !== undefined) return lost
    if ('ok' in given) return given
    let current = given
    const made = this.made.get(current)
    if (made === undefined || made.used || made.writes !== gate.writes || this.options.now() - current.at > RIGHT_VALID_MS) {
      current = await this.check()
    }
    if (!current.mine || (!current.active && !options.released)) {
      const refused: Refused = { ok: false, leader: current.claims.leader, last: current.claims.last }
      if (current.claims.last > this.options.count || (current.claims.last === this.options.count && !current.mine)) {
        gate.lost.set(this.options.count, refused)
      }
      return refused
    }
    if (!(await this.isOn())) return { ok: false, off: true }
    const record = this.made.get(current)
    if (record) record.used = true
    gate.writes++
    return { ok: true, value: await write() }
  }
}
