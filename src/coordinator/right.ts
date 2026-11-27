// The right to act on a task (TZ Ф4, «Право на действие»): before every action on a task — a comment, a label, and,
// with the next tasks, an agent's launch or message, a PR, a merge, the removal of a worktree — the coordinator re-reads
// the claims. A check holds RIGHT_VALID_MS: an action whose write comes later than that after its check (a sleep of the
// computer, a long call) re-reads before the write. Not the leader of its count — the action writes nothing, and no
// later action of this right writes anything either: the count is lost for good once a newer one exists.
//
// GitHub gives no conditional write, so the window between the check and the write stays: after a takeover the former
// leader manages at most the one write whose check came before it. That is why the leader of a new count takes its
// stage only from the comments of its own count (claims.ts, stageOf) and brings the labels to its stage itself.
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
export type Acted<T> = { readonly ok: true; readonly value: T } | Refused

export type WriteOptions = {
  // Allow the write on the count this coordinator released itself — the label writes that finish its own release (a
  // block, a deferral). Without it a released count writes nothing.
  readonly released?: boolean
}

export class Right {
  private lostTo: Refused | null = null

  constructor(
    private readonly options: {
      readonly github: Pick<GitHub, 'listComments'>
      readonly issue: number
      // The count this coordinator leads.
      readonly count: number
      readonly coordinatorId: string
      readonly now: () => number
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
    const claims = readClaims(await this.options.github.listComments(this.options.issue))
    const mine = claims.last === this.options.count && claims.leader === this.options.coordinatorId
    return { at: this.options.now(), mine, active: claims.active, claims }
  }

  // The write of an action whose check is `check`: made again first when it is older than RIGHT_VALID_MS. Refused —
  // nothing written — when this coordinator does not lead the count.
  async write<T>(check: RightCheck, write: () => Promise<T>, options: WriteOptions = {}): Promise<Acted<T>> {
    if (this.lostTo !== null) return this.lostTo
    let current = check
    if (this.options.now() - current.at > RIGHT_VALID_MS) current = await this.check()
    if (!current.mine || (!current.active && !options.released)) {
      const refused: Refused = { ok: false, leader: current.claims.leader, last: current.claims.last }
      if (current.claims.last > this.options.count || (current.claims.last === this.options.count && !current.mine)) {
        this.lostTo = refused
      }
      return refused
    }
    return { ok: true, value: await write() }
  }

  // One action that is only a write: its check now, then the write.
  async act<T>(write: () => Promise<T>, options: WriteOptions = {}): Promise<Acted<T>> {
    if (this.lostTo !== null) return this.lostTo
    return this.write(await this.check(), write, options)
  }
}
