// The claims of a task, read from its comments (TZ Ф4, «Захват и перехват — один протокол отсчётов»). GitHub gives no
// atomic lock and no conditional write of comments and labels, so the order of the comments decides who leads a task;
// every coordinator reads the same order and decides alike. Only the service marks of the owner's comments count
// (src/github/mark.ts), in GitHub's order:
//
// - a claim (`claim`) or a takeover (`takeover`) opens a count: the number of the last count in the task + 1, the first
//   is 1. The task is led by the author (the coordinator id of the mark) of the first claim, in GitHub's order, of the
//   highest count;
// - the active claim is the claim of the last count with no release comment of that count after it — a block, a
//   deferral or a release (RELEASE_KINDS), written by the leader of that count. A comment of another count releases
//   nothing: a comment the former leader writes after a takeover names its own count;
// - the progress of a count is the service comments of its leader with its number, from its claim on: a comment of an
//   earlier count of the same coordinator is no progress of the new one;
// - `agent-queue:working` is only a reflection for the panel and the filter: who leads, and whether a task is taken, is
//   decided by the claims alone.
import type { Stage } from '../github/check'
import { GH_TIMEOUT_MS } from '../github/gh'
import type { Comment, Issue } from '../github/github'
import type { PluginLabel } from '../github/labels'
import { parseBody, type Mark, type MarkKind } from '../github/mark'

export const WORKING: PluginLabel = 'agent-queue:working'
export const QUEUED: PluginLabel = 'agent-queue'
export const BLOCKED: PluginLabel = 'agent-queue:blocked'
export const SPLIT: PluginLabel = 'agent-queue:split'

// The kinds that open a count.
export const CLAIM_KINDS = ['claim', 'takeover'] as const satisfies readonly MarkKind[]
export type ClaimKind = (typeof CLAIM_KINDS)[number]

// The kinds that end the count they name: a block (Ф6), a deferral (Ф10) and a release. The split (Ф12) releases a
// count too: the task `split` adds the kind of its comment here.
export const RELEASE_KINDS = ['block', 'deferred', 'release'] as const satisfies readonly MarkKind[]
export type ReleaseKind = (typeof RELEASE_KINDS)[number]

// How long the protocol waits (TZ Ф4).
// The claimant re-reads the comments this long after its label is on.
export const REREAD_AFTER_MS = 60_000
// A check of the right to act holds this long; an older one is made again before a write.
export const RIGHT_VALID_MS = 30_000
// A claim without `working` and without a new progress comment of its claimant, and `working` left on a released
// count: after this long the task may be taken with a new count.
export const UNSETTLED_MS = 10 * 60_000
// A deferral (Ф10, «Отложено до <время + 1 ч>») holds this long from its comment.
export const DEFERRAL_MS = 60 * 60_000
// How long after a claim a write of a former leader may still land: one admitted by a check made before the claim is
// sent within RIGHT_VALID_MS and ends with its gh call (GH_TIMEOUT_MS at most), with a minute to spare. Until then a
// label that disappears may be that write; after it, only a person changes the labels.
export const LATE_WRITE_MS = RIGHT_VALID_MS + GH_TIMEOUT_MS + 60_000

// A comment of the owner with a service mark, in GitHub's order.
export type MarkedComment = {
  readonly comment: Comment
  readonly mark: Mark
  // Its place in GitHub's order of the task's comments.
  readonly index: number
  // When GitHub created it, in milliseconds since the epoch.
  readonly at: number
}

export type Release = { readonly kind: ReleaseKind; readonly at: number; readonly index: number }

export type Claims = {
  // The number of the last count in the task; 0 when nobody ever claimed it.
  readonly last: number
  // The leader of the last count: the coordinator of its first claim in GitHub's order; null without a count.
  readonly leader: string | null
  // Whether the leader opened the count with a claim or a takeover.
  readonly kind: ClaimKind | null
  // When the leader's claim of the last count was created, and its place in the order.
  readonly claimAt: number | null
  readonly claimIndex: number | null
  // Every claimant of the last count in GitHub's order (the leader first).
  readonly claimants: readonly string[]
  // The release of the last count by its leader, or null.
  readonly release: Release | null
  // The progress of the last count: its leader's latest service comment of that count since its claim (the claim at
  // the least).
  readonly leaderLastAt: number | null
  // The last count is claimed and not released.
  readonly active: boolean
  // Every marked comment, in GitHub's order.
  readonly marked: readonly MarkedComment[]
}

// The marked comments of a task in GitHub's order (comments as the GitHub layer lists them: the owner's alone).
export function markedComments(comments: readonly Comment[]): MarkedComment[] {
  const marked: MarkedComment[] = []
  comments.forEach((comment, index) => {
    const { mark } = parseBody(comment.body)
    const at = Date.parse(comment.createdAt)
    if (mark !== null && Number.isFinite(at)) marked.push({ comment, mark, index, at })
  })
  return marked
}

export function readClaims(comments: readonly Comment[]): Claims {
  const marked = markedComments(comments)
  const last = marked.reduce((highest, one) => (isClaim(one) ? Math.max(highest, one.mark.claim ?? 0) : highest), 0)
  const ofLast = claimsOfCount(marked, last)
  const first = ofLast[0]
  if (first === undefined) {
    return {
      last: 0,
      leader: null,
      kind: null,
      claimAt: null,
      claimIndex: null,
      claimants: [],
      release: null,
      leaderLastAt: null,
      active: false,
      marked,
    }
  }
  const leader = first.mark.coordinator ?? null
  const claimants: string[] = []
  for (const one of ofLast) {
    if (one.mark.coordinator && !claimants.includes(one.mark.coordinator)) claimants.push(one.mark.coordinator)
  }
  // The leader's comments of this count since its claim: its progress, and what may end it.
  const own = marked.filter((one) => one.index > first.index && one.mark.coordinator === leader && one.mark.claim === last)
  const releasing = own.find((one) => isReleaseKind(one.mark.kind))
  const release = releasing
    ? { kind: releasing.mark.kind as ReleaseKind, at: releasing.at, index: releasing.index }
    : null
  const leaderLastAt = own.reduce((latest, one) => Math.max(latest, one.at), first.at)
  return {
    last,
    leader,
    kind: first.mark.kind as ClaimKind,
    claimAt: first.at,
    claimIndex: first.index,
    claimants,
    release,
    leaderLastAt,
    active: release === null,
    marked,
  }
}

// The claims (and takeovers) of count `count`, in GitHub's order.
export function claimsOfCount(marked: readonly MarkedComment[], count: number): MarkedComment[] {
  return marked.filter((one) => isClaim(one) && one.mark.claim === count)
}

// The first claim of `coordinator` of count `count`, or undefined.
export function claimOf(claims: Claims, count: number, coordinator: string): MarkedComment | undefined {
  return claimsOfCount(claims.marked, count).find((one) => one.mark.coordinator === coordinator)
}

// What a decision about a task was made on: its last count, whether that count was active, and its progress. A claim
// made for that decision goes on only when a fresh reading of the task shows the same (Coordinator.claimTask).
export type Expectation = { readonly last: number; readonly active: boolean; readonly progressAt: number | null }

export function expectationOf(claims: Claims): Expectation {
  return { last: claims.last, active: claims.active, progressAt: claims.leaderLastAt }
}

// Why the fresh claims do not match the decision's, or null when they do.
export function changedSince(expected: Expectation, claims: Claims): string | null {
  if (claims.last !== expected.last) return `the last count is ${claims.last}, not ${expected.last}`
  if (claims.active !== expected.active) return `count ${claims.last} is ${claims.active ? 'active' : 'released'} now`
  if (claims.leaderLastAt !== expected.progressAt) return `count ${claims.last} has new progress`
  return null
}

// Why a task cannot be claimed now (with a new count), by its claims and its `working` label — or null when it can.
export type ClaimBar =
  // The last count is claimed and not released.
  | 'claimed'
  // The last count was released, `working` is still on: its leader takes the label off; until UNSETTLED_MS after the
  // release nobody takes the task.
  | 'released-recently'
  // The last count was deferred (Ф10): nobody takes the task until DEFERRAL_MS after the deferral.
  | 'deferred'

export function claimBar(claims: Claims, labels: readonly string[], now: number): ClaimBar | null {
  if (claims.last === 0) return null
  const working = hasLabel(labels, WORKING)
  if (claims.active) {
    // A claim without `working` (a failure between the two writes): its claimant sets the label at its next check.
    // Without the label and without a new progress comment of the claimant for UNSETTLED_MS, a new count may take it.
    if (!working && now - (claims.leaderLastAt ?? 0) >= UNSETTLED_MS) return null
    return 'claimed'
  }
  const release = claims.release as Release
  if (release.kind === 'deferred' && now < release.at + DEFERRAL_MS) return 'deferred'
  if (working && now - release.at < UNSETTLED_MS) return 'released-recently'
  return null
}

// The stage of a count, by the comments of that count alone (TZ Ф4, «Право на действие»): the stage of the latest
// stage comment of its leader with its number. A comment of another count — the former leader's, written after a
// takeover — never counts. Null: no stage comment of this count yet (the count has just been claimed).
export function stageOf(claims: Claims, count: number, leader: string): Stage | null {
  let stage: Stage | null = null
  for (const one of claims.marked) {
    if (one.mark.kind === 'stage' && one.mark.claim === count && one.mark.coordinator === leader && one.mark.stage) {
      stage = one.mark.stage
    }
  }
  return stage
}

// The plugin's labels of a claimed target while its count is active: `on` — set (the first of them right after the
// claim), `off` — taken off. The leader brings the labels to this before its step.
export type StageLabels = { readonly on: readonly PluginLabel[]; readonly off: readonly PluginLabel[] }

// A task of the queue at any stage of its work: `working` on, `blocked` and `split` off — a block and a split end a
// count.
export const ACTIVE_LABELS: StageLabels = { on: [WORKING], off: [BLOCKED, SPLIT] }

export function hasLabel(labels: readonly string[], label: string): boolean {
  return labels.some((one) => one.toLowerCase() === label.toLowerCase())
}

export function isOpenTask(issue: Issue): boolean {
  return issue.state === 'open' && hasLabel(issue.labels, QUEUED)
}

export function isClaimKind(kind: MarkKind): kind is ClaimKind {
  return (CLAIM_KINDS as readonly string[]).includes(kind)
}

export function isReleaseKind(kind: MarkKind): kind is ReleaseKind {
  return (RELEASE_KINDS as readonly string[]).includes(kind)
}

function isClaim(one: MarkedComment): boolean {
  return isClaimKind(one.mark.kind) && one.mark.claim !== undefined
}
