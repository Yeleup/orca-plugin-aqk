// The plugin's service mark (TZ «Данные», «Комментарии хода»): what the coordinator needs to read back from a comment or
// an issue — its kind, the coordinator id, the claim count, the operation id, the stage, the round, the SHA; for a
// review round the verdict and the findings; for a test run its SHA, exit code, start, duration and whether the tree
// was clean. It sits next to the text for a human, which never affects it.
//
// Format: the first line of the body is an HTML comment — invisible on GitHub —
//
//   <!-- agent-queue:mark {"v":1,"kind":"claim","coordinator":"…","claim":1} -->
//
// followed by a line break and the text for a human. The JSON is on one line (line breaks in strings are escaped), and
// `<` and `>` in it are written as < and >, so nothing in it can end the HTML comment. Only the first line
// is read as a mark, and only when it starts the body exactly so. The text for a human is written after it with every
// `<!-- agent-queue:` turned into `<!-- agent-queue (text):` — so a text that looks like a mark, or holds its
// delimiters, never becomes one, in this comment or any other.
import {
  checkPath,
  fixedValue,
  hasFixedForm,
  maskText,
  type CheckContext,
  type CheckedText,
  type DiffSide,
  type Stage,
} from './check'
import { CheckError } from './mask'

export const MARK_KINDS = [
  'claim',
  'takeover',
  'stage',
  'review-round',
  'test-run',
  'block',
  'deferred',
  'release',
  'operation-start',
  'operation-end',
  'result',
] as const
export type MarkKind = (typeof MARK_KINDS)[number]

export const VERDICTS = ['approve', 'changes', 'head-mismatch'] as const
export type Verdict = (typeof VERDICTS)[number]

export const SEVERITIES = ['critical', 'major', 'minor', 'nit'] as const
export type Severity = (typeof SEVERITIES)[number]

// One finding of a review round, one line: severity, the file of the diff and its side, the line, the summary.
export type Finding = {
  readonly severity: Severity
  readonly path: string
  readonly side: DiffSide
  readonly line: number | null
  readonly summary: string
}

export type ReviewRound = { readonly verdict: Verdict; readonly findings: readonly Finding[] }

export type TestRun = {
  readonly sha: string
  // Null when the run gave no exit code (stopped by a signal, or it did not start).
  readonly exitCode: number | null
  readonly startedAt: string
  readonly durationMs: number
  // Whether the tree was clean: nothing uncommitted or untracked.
  readonly clean: boolean
}

export type Mark = {
  readonly kind: MarkKind
  readonly coordinator?: string
  readonly claim?: number
  readonly operation?: string
  readonly stage?: Stage
  readonly round?: number
  readonly sha?: string
  // Only in a mark of kind `review-round`, and there always.
  readonly review?: ReviewRound
  // Only in a mark of kind `test-run`, and there always.
  readonly test?: TestRun
}

export const MARK_VERSION = 1
export const MARK_PREFIX = '<!-- agent-queue:mark '
const MARK_SUFFIX = ' -->'

export type CheckedMark = { readonly mark: Mark; readonly hidden: number; readonly rules: readonly string[] }

// The mark as it may go to GitHub: every coordinator field in its fixed form (CheckError `bad_field` otherwise), every
// finding path from the diff (hidden whole when the mask matches it), every summary through the mask.
export function checkMark(mark: Mark, context: CheckContext): CheckedMark {
  const shape = validMark(mark)
  let hidden = 0
  const rules = new Set<string>()
  const count = (checked: CheckedText): string => {
    hidden += checked.hidden
    for (const rule of checked.rules) rules.add(rule)
    return checked.text
  }
  if (shape.review === undefined) return { mark: shape, hidden, rules: [] }
  const findings = shape.review.findings.map((finding) => ({
    severity: finding.severity,
    path: count(checkPath(finding.path, finding.side, context)),
    side: finding.side,
    line: finding.line,
    summary: count(maskText(finding.summary, context.mask)),
  }))
  return { mark: { ...shape, review: { verdict: shape.review.verdict, findings } }, hidden, rules: [...rules] }
}

// The mark line of a checked mark.
export function markLine(mark: Mark): string {
  const json = JSON.stringify({ v: MARK_VERSION, ...validMark(mark) })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
  return `${MARK_PREFIX}${json}${MARK_SUFFIX}`
}

// The text for a human with every mark opener made harmless (see the header).
export function neutralizeText(text: string): string {
  return text.replace(/<!--(\s*)agent-queue:/gi, '<!--$1agent-queue (text):')
}

// The body GitHub gets: the mark line (if any), then the text for a human.
export function composeBody(mark: Mark | null, text: string): string {
  const human = neutralizeText(text)
  const body = mark === null ? human : `${markLine(mark)}\n${human}`
  if (body.trim() === '') throw new CheckError('empty', 'the body is empty; nothing was written')
  return body
}

export type ParsedBody = {
  // The mark of the body, or null when it has none (or none that can be read: see `problem`).
  readonly mark: Mark | null
  // The text for a human: everything after the mark line, or the whole body without a mark.
  readonly text: string
  // Why a first line that opens like a mark is not one (broken JSON, a field out of form, a newer format).
  readonly problem: string | null
}

// Reads the mark of a body (a comment's or an issue's). Only the first line counts; GitHub's \r\n is read like \n.
export function parseBody(body: string): ParsedBody {
  if (!body.startsWith(MARK_PREFIX)) return { mark: null, text: body, problem: null }
  const end = body.indexOf('\n')
  const line = (end === -1 ? body : body.slice(0, end)).replace(/\r$/, '')
  const text = end === -1 ? '' : body.slice(end + 1)
  if (!line.endsWith(MARK_SUFFIX)) return { mark: null, text, problem: 'the mark line does not end with -->' }
  let value: unknown
  try {
    value = JSON.parse(line.slice(MARK_PREFIX.length, line.length - MARK_SUFFIX.length))
  } catch (error) {
    return { mark: null, text, problem: `the mark is not JSON (${error instanceof Error ? error.message : String(error)})` }
  }
  if (!isRecord(value)) return { mark: null, text, problem: 'the mark is not a JSON object' }
  if (value.v !== MARK_VERSION) return { mark: null, text, problem: `unknown mark format ${JSON.stringify(value.v)}` }
  try {
    return { mark: validMark(value), text, problem: null }
  } catch (error) {
    return { mark: null, text, problem: error instanceof Error ? error.message : String(error) }
  }
}

// The first of `items` (comments or issues, in their order) whose body has a mark of this operation — and of this
// kind, when given. A repeat after a lost GitHub answer finds what was already written this way.
export function findByOperation<T extends { readonly body: string }>(
  items: readonly T[],
  query: { readonly operation: string; readonly kind?: MarkKind },
): T | null {
  return (
    items.find((item) => {
      const { mark } = parseBody(item.body)
      return mark !== null && mark.operation === query.operation && (query.kind === undefined || mark.kind === query.kind)
    }) ?? null
  )
}

// A mark with exactly the fields of the format, each of its form, in a fixed order; CheckError `bad_field` otherwise.
// Unknown fields of a newer plugin are left out.
function validMark(value: Mark | Record<string, unknown>): Mark {
  const source = value as Record<string, unknown>
  const kind = source.kind
  if (typeof kind !== 'string' || !(MARK_KINDS as readonly string[]).includes(kind)) {
    throw new CheckError('bad_field', `field kind is not a mark kind (${MARK_KINDS.join(', ')}); nothing was written`)
  }
  const mark: Record<string, unknown> = { kind }
  const fixed = [
    ['coordinator', 'coordinator'],
    ['claim', 'claim'],
    ['operation', 'operation'],
    ['stage', 'stage'],
    ['round', 'round'],
    ['sha', 'sha'],
  ] as const
  for (const [name, form] of fixed) {
    if (source[name] !== undefined) mark[name] = fixedValue(form, source[name] as string | number, name)
  }
  const review = source.review
  if ((kind === 'review-round') !== (review !== undefined)) {
    throw new CheckError('bad_field', 'field review: a review-round mark has it, other marks do not; nothing was written')
  }
  if (review !== undefined) mark.review = validReview(review)
  const test = source.test
  if ((kind === 'test-run') !== (test !== undefined)) {
    throw new CheckError('bad_field', 'field test: a test-run mark has it, other marks do not; nothing was written')
  }
  if (test !== undefined) mark.test = validTest(test)
  return mark as Mark
}

function validReview(value: unknown): ReviewRound {
  if (!isRecord(value) || !Array.isArray(value.findings)) {
    throw new CheckError('bad_field', 'field review is not a verdict with findings; nothing was written')
  }
  const verdict = value.verdict
  if (typeof verdict !== 'string' || !(VERDICTS as readonly string[]).includes(verdict)) {
    throw new CheckError('bad_field', `field review.verdict is not ${VERDICTS.join(', ')}; nothing was written`)
  }
  const findings = value.findings.map((finding: unknown, index: number): Finding => {
    const name = `review.findings[${index}]`
    if (!isRecord(finding)) throw new CheckError('bad_field', `field ${name} is not a finding; nothing was written`)
    const { severity, path, side, line, summary } = finding
    if (typeof severity !== 'string' || !(SEVERITIES as readonly string[]).includes(severity)) {
      throw new CheckError('bad_field', `field ${name}.severity is not ${SEVERITIES.join(', ')}; nothing was written`)
    }
    if (side !== 'base' && side !== 'head') {
      throw new CheckError('bad_field', `field ${name}.side is not base or head; nothing was written`)
    }
    if (typeof path !== 'string' || path === '' || typeof summary !== 'string') {
      throw new CheckError('bad_field', `field ${name} needs a path and a summary (text); nothing was written`)
    }
    if (line !== null && !hasFixedForm('line', line)) {
      throw new CheckError('bad_field', `field ${name}.line is not a line number (from 1) or null; nothing was written`)
    }
    return { severity: severity as Severity, path, side, line: line as number | null, summary }
  })
  return { verdict: verdict as Verdict, findings }
}

function validTest(value: unknown): TestRun {
  if (!isRecord(value)) throw new CheckError('bad_field', 'field test is not a test run; nothing was written')
  const { sha, exitCode, startedAt, durationMs, clean } = value
  if (typeof clean !== 'boolean') throw new CheckError('bad_field', 'field test.clean is not true or false; nothing was written')
  return {
    sha: fixedValue('sha', sha as string, 'test.sha'),
    exitCode: exitCode === null ? null : fixedValue('exitCode', exitCode as number, 'test.exitCode'),
    startedAt: fixedValue('time', startedAt as string, 'test.startedAt'),
    durationMs: fixedValue('duration', durationMs as number, 'test.durationMs'),
    clean,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
