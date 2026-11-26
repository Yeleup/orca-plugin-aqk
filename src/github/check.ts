// The check before every write to GitHub (TZ «Данные», «Проверка перед каждой записью в GitHub»). A text for GitHub is
// built from segments, and each kind of segment has its own rule:
//
// - text (a plain string: the plugin's wording, an agent's text, a task's text) — the mask acts on it (mask.ts);
// - a coordinator field (`field.*`): an issue or PR number, a SHA, an exit code, a time, a duration, a coordinator id,
//   a stage, a round, a claim count, an operation id, a count, a line or step number — only in its fixed form. A value
//   of another form (a local path, a computer name …) is refused and nothing is written. These fields are never masked
//   and never change, even where a forbidden-data pattern or the phone or token rule would match them;
// - a file path (`field.path`): only a path of the diff being checked (its base side or its changed side); a path
//   outside it is refused, a path the mask matches anywhere becomes «[скрыто]» as a whole.
//
// The mask is applied to the whole rendered text, so a match that runs over several segments is found too: its text
// parts are hidden, a path it touches is hidden whole, coordinator fields stay as they are.
import { isCoordinatorId } from '../platform/coordinator-id'
import { CheckError, compileMask, HIDDEN, type Mask, type MaskMatch } from './mask'

export { CheckError, HIDDEN } from './mask'

export type GitHubLanguage = 'ru' | 'en'

// What the check needs from the project's settings. The task `project-config` reads them from `.agent-queue.json`; its
// result fits this type, and tests pass their own.
export type ProjectGitHubSettings = {
  // The language of the plugin's texts in GitHub.
  readonly language: GitHubLanguage
  // The forbidden-data patterns: JavaScript regular expressions (flag `u`).
  readonly forbiddenPatterns: readonly string[]
}

export type DiffSide = 'base' | 'head'

// The file paths of the diff being checked (repository paths, `/` between directories): those of its base side and
// those of its changed side.
export type DiffPaths = { readonly base: readonly string[]; readonly head: readonly string[] }

// The stages of a task (TZ Ф4, Ф5, Ф10). Later tasks add theirs here.
export const STAGES = ['executor', 'tests', 'review', 'merge', 'post-merge-check', 'cleanup', 'merged'] as const
export type Stage = (typeof STAGES)[number]

export type FixedKind =
  | 'issue'
  | 'pr'
  | 'sha'
  | 'exitCode'
  | 'time'
  | 'duration'
  | 'coordinator'
  | 'stage'
  | 'round'
  | 'claim'
  | 'operation'
  | 'count'
  | 'line'
  | 'step'

export type FixedField = { readonly field: FixedKind; readonly value: string | number }
export type PathField = { readonly field: 'path'; readonly value: string; readonly side: DiffSide | null }
export type Segment = string | FixedField | PathField
export type GitHubText = readonly Segment[]

// The segments of fixed form and paths.
export const field = {
  issue: (value: number): FixedField => ({ field: 'issue', value }),
  pr: (value: number): FixedField => ({ field: 'pr', value }),
  sha: (value: string): FixedField => ({ field: 'sha', value }),
  exitCode: (value: number): FixedField => ({ field: 'exitCode', value }),
  // A time as ISO 8601 UTC (Date.prototype.toISOString).
  time: (value: string): FixedField => ({ field: 'time', value }),
  // A duration in milliseconds.
  duration: (value: number): FixedField => ({ field: 'duration', value }),
  coordinator: (value: string): FixedField => ({ field: 'coordinator', value }),
  stage: (value: Stage): FixedField => ({ field: 'stage', value }),
  round: (value: number): FixedField => ({ field: 'round', value }),
  claim: (value: number): FixedField => ({ field: 'claim', value }),
  operation: (value: string): FixedField => ({ field: 'operation', value }),
  // How many of something (commits, files, findings): 0 or more.
  count: (value: number): FixedField => ({ field: 'count', value }),
  // A line of a file.
  line: (value: number): FixedField => ({ field: 'line', value }),
  // The number of a post-merge step in the settings, from 1.
  step: (value: number): FixedField => ({ field: 'step', value }),
  path: (value: string, side: DiffSide | null = null): PathField => ({ field: 'path', value, side }),
}

const SHA_FORM = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const TIME_FORM = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/

const DESCRIPTION: Record<FixedKind, string> = {
  issue: 'an issue number (an integer from 1)',
  pr: 'a PR number (an integer from 1)',
  sha: 'a full commit SHA (40 or 64 lower-case hex digits)',
  exitCode: 'an exit code (an integer)',
  time: 'a time in ISO 8601 UTC (YYYY-MM-DDTHH:MM:SS[.mmm]Z)',
  duration: 'a duration in milliseconds (an integer from 0)',
  coordinator: 'a coordinator id (a random UUID v4)',
  stage: `a stage (${STAGES.join(', ')})`,
  round: 'a round (an integer from 1)',
  claim: 'a claim count (an integer from 1)',
  operation: 'an operation id (a random UUID v4)',
  count: 'a count (an integer from 0)',
  line: 'a line number (an integer from 1)',
  step: 'a step number (an integer from 1)',
}

// Whether `value` has the fixed form of `kind`.
export function hasFixedForm(kind: FixedKind, value: unknown): boolean {
  const integer = typeof value === 'number' && Number.isSafeInteger(value)
  switch (kind) {
    case 'issue':
    case 'pr':
    case 'round':
    case 'claim':
    case 'line':
    case 'step':
      return integer && (value as number) >= 1
    case 'count':
    case 'duration':
      return integer && (value as number) >= 0
    case 'exitCode':
      return integer
    case 'sha':
      return typeof value === 'string' && SHA_FORM.test(value)
    case 'time':
      return typeof value === 'string' && TIME_FORM.test(value) && !Number.isNaN(Date.parse(value))
    case 'coordinator':
    case 'operation':
      return typeof value === 'string' && isCoordinatorId(value)
    case 'stage':
      return typeof value === 'string' && (STAGES as readonly string[]).includes(value)
  }
}

// The value itself when it has the form of `kind`; otherwise CheckError `bad_field`. The message names the field and
// the form it needs, not the refused value (which may be just what must not reach GitHub).
export function fixedValue<T extends string | number>(kind: FixedKind, value: T, name: string = kind): T {
  if (!hasFixedForm(kind, value)) {
    throw new CheckError('bad_field', `field ${name} is not ${DESCRIPTION[kind]}; nothing was written`)
  }
  return value
}

// How a coordinator field reads in a text.
export function renderFixed(segment: FixedField): string {
  const { field: kind, value } = segment
  if (kind === 'issue' || kind === 'pr') return `#${value}`
  if (kind === 'duration') return formatDuration(value as number)
  return String(value)
}

// A duration for people: 850 ms, 12.5 s, 3 min 20 s, 1 h 5 min.
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${Number((ms / 1000).toFixed(1))} s`
  const seconds = Math.round(ms / 1000)
  const parts: string[] = []
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  if (hours > 0) parts.push(`${hours} h`)
  if (minutes > 0) parts.push(`${minutes} min`)
  if (rest > 0 && hours === 0) parts.push(`${rest} s`)
  return parts.join(' ')
}

// A path of the diff, as it is; CheckError `path_outside_diff` when it is not one (or there is no diff). `side` narrows
// it to one side of the diff.
export function diffPath(path: string, side: DiffSide | null, diff: DiffPaths | null | undefined): string {
  const sides = side === null ? (['base', 'head'] as const) : [side]
  const inDiff = diff != null && typeof path === 'string' && sides.some((one) => diff[one].includes(path))
  if (!inDiff) {
    const where = diff == null ? 'there is no diff to check it against' : `it is not a path of the diff${side ? ` (${side} side)` : ''}`
    throw new CheckError('path_outside_diff', `a file path was refused: ${where}; nothing was written`)
  }
  return path
}

export type CheckContext = {
  readonly mask: Mask
  // The diff the paths come from; without it no path can be written.
  readonly diff?: DiffPaths | null
}

export type CheckedText = {
  readonly text: string
  // How many parts became «[скрыто]».
  readonly hidden: number
  // The mask rules that hid them (mask.ts, Masked.rules).
  readonly rules: readonly string[]
}

// The context of a check from the project's settings: the mask with its patterns (CheckError `invalid_pattern` for a
// pattern that is not a valid regular expression) and the diff, if any.
export function checkContext(settings: ProjectGitHubSettings, diff: DiffPaths | null = null): CheckContext {
  return { mask: compileMask(settings.forbiddenPatterns), diff }
}

type Placed = { readonly segment: Segment; readonly start: number; readonly end: number }

// The checked text: every coordinator field in its form, every path from the diff, the mask over the whole.
export function checkText(text: GitHubText, context: CheckContext): CheckedText {
  const segments = joinStrings(text)
  for (const segment of segments) {
    if (typeof segment === 'string') continue
    if (segment.field === 'path') diffPath(segment.value, segment.side, context.diff)
    else fixedValue(segment.field, segment.value)
  }
  const placed: Placed[] = []
  let rendered = ''
  for (const segment of segments) {
    const piece = typeof segment === 'string' ? segment : segment.field === 'path' ? segment.value : renderFixed(segment)
    placed.push({ segment, start: rendered.length, end: rendered.length + piece.length })
    rendered += piece
  }
  const matches = context.mask.find(rendered)
  let out = ''
  let hidden = 0
  const rules = new Set<string>()
  for (const { segment, start, end } of placed) {
    const touching = matches.filter((match) => match.start < end && match.end > start)
    if (typeof segment !== 'string' && segment.field !== 'path') {
      out += rendered.slice(start, end)
      continue
    }
    if (typeof segment !== 'string') {
      // A path is hidden whole when a match of the whole text touches it — or the mask matches the path on its own (a
      // pattern for a whole path, `^src/private\.ts$`, does not match it inside a text).
      const own = context.mask.find(segment.value)
      if (touching.length === 0 && own.length === 0) out += segment.value
      else {
        out += HIDDEN
        hidden++
        for (const match of [...touching, ...own]) for (const rule of match.rules) rules.add(rule)
      }
      continue
    }
    let at = start
    for (const match of touching) {
      const from = Math.max(match.start, start)
      const to = Math.min(match.end, end)
      out += rendered.slice(at, from) + HIDDEN
      at = to
      hidden++
      for (const rule of match.rules) rules.add(rule)
    }
    out += rendered.slice(at, end)
  }
  return { text: out, hidden, rules: [...rules] }
}

// A free text (one string) through the mask alone: for text fields outside a GitHubText, such as the summary of a
// review finding in a service mark.
export function maskText(text: string, mask: Mask): CheckedText {
  const masked = mask.apply(text)
  return { text: masked.text, hidden: masked.hidden, rules: masked.rules }
}

// A path of the diff, or «[скрыто]» as a whole when the mask matches anywhere in it.
export function checkPath(path: string, side: DiffSide | null, context: CheckContext): CheckedText {
  diffPath(path, side, context.diff)
  const found: MaskMatch[] = context.mask.find(path)
  if (found.length === 0) return { text: path, hidden: 0, rules: [] }
  return { text: HIDDEN, hidden: 1, rules: [...new Set(found.flatMap((match) => match.rules))] }
}

function joinStrings(text: GitHubText): Segment[] {
  const joined: Segment[] = []
  for (const segment of text) {
    const last = joined[joined.length - 1]
    if (typeof segment === 'string' && typeof last === 'string') joined[joined.length - 1] = last + segment
    else joined.push(segment)
  }
  return joined
}

// Saved unpushed work in a GitHub text: only the numbers (commits, changed files, new files) and «сохранено на
// компьютере <id>»; the names of the files are shown by the panel on that computer.
export function savedWorkText(
  work: { readonly commits: number; readonly changed: number; readonly untracked: number },
  coordinatorId: string,
  language: GitHubLanguage,
): GitHubText {
  const words =
    language === 'ru'
      ? ['коммитов: ', ', изменённых файлов: ', ', новых файлов: ', ' — сохранено на компьютере ']
      : ['commits: ', ', changed files: ', ', new files: ', ' — saved on computer ']
  return [
    words[0] ?? '',
    field.count(work.commits),
    words[1] ?? '',
    field.count(work.changed),
    words[2] ?? '',
    field.count(work.untracked),
    words[3] ?? '',
    field.coordinator(coordinatorId),
  ]
}

// A post-merge step in a GitHub text: its name from the settings — or its number, when it has no name or the mask
// matches the name — and its exit code. Never the command or its output: this takes neither.
export function postMergeStepText(
  step: { readonly number: number; readonly name?: string | null },
  exitCode: number,
  settings: ProjectGitHubSettings,
): GitHubText {
  const mask = compileMask(settings.forbiddenPatterns)
  const name = step.name?.trim() ?? ''
  const named = name !== '' && !mask.matches(name)
  const ru = settings.language === 'ru'
  const label: Segment[] = named
    ? [ru ? `Шаг после мержа «${name}»` : `Post-merge step "${name}"`]
    : [ru ? 'Шаг после мержа ' : 'Post-merge step ', field.step(step.number)]
  return [...label, ru ? ': код выхода ' : ': exit code ', field.exitCode(exitCode)]
}
