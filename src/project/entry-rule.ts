// The entry rule (TZ Ф3, «Данные»): the block the plugin keeps between its own markers in CLAUDE.md and AGENTS.md of a
// connected project. It speaks only to entry sessions — agents in the project's main checkout: a change of the code
// goes to the queue as an issue of the project's repository with the label `agent-queue`, made by `gh issue create`,
// in the plugin's format (the user's request, the user's decisions and the session's proposals apart; a dependency as
// the line «Зависит от #N»); open questions are settled with the user first; «сделай сам» and «без очереди» let the
// session make the change itself; only the owner changes the queue's settings; no production data in a task. An agent
// in a task's worktree does not follow it. The text is in the project's language (`language`), from the catalogs of
// src/github-texts/.
//
// The plugin writes only between its markers; the rest of the file is the project's and stays as it is. The markers
// are the plugin's own, not those of agent-queue-kit (`<!-- agent-queue:begin … -->`): a project on the kit is never
// connected (Ф1), and its block is never touched. Plain functions with no file or process: the connection
// (src/connect/) reads the files and writes what these return.
import { githubText, type GithubLanguage } from '../github-texts/catalog'
import { fencedBlock, inlineCode } from '../markdown'

// The lines that open and close the plugin's block. A line that starts with ENTRY_RULE_BEGIN opens it (the rest of the
// line is a note for people), the line ENTRY_RULE_END closes it.
export const ENTRY_RULE_BEGIN = '<!-- orca-agent-queue:begin'
export const ENTRY_RULE_END = '<!-- orca-agent-queue:end -->'
const BEGIN_LINE = `${ENTRY_RULE_BEGIN} (Agent Queue writes this block; the rest of the file is the project's) -->`

// The files the block goes into.
export const ENTRY_RULE_FILES = ['CLAUDE.md', 'AGENTS.md'] as const

// The block, markers included, without a line break after its last line: `repository` is the project's repository as
// `gh --repo` takes it (`owner/name`, or `host/owner/name` off github.com).
export function entryRuleBlock(language: GithubLanguage, repository: string): string {
  const text = (key: Parameters<typeof githubText>[1], params = {}) => githubText(language, key, params)
  const command = text('entryRule.command', { repository })
  return [
    BEGIN_LINE,
    `## ${text('entryRule.title')}`,
    '',
    text('entryRule.who'),
    '',
    text('entryRule.queue'),
    '',
    `- ${text('entryRule.questions')}`,
    `- ${text('entryRule.create', { repository: inlineCode(repository) })}`,
    '',
    ...fencedBlock(command, 'sh')
      .split('\n')
      .map((line) => `  ${line}`),
    '',
    `- ${text('entryRule.format')}`,
    `- ${text('entryRule.depends')}`,
    `- ${text('entryRule.data')}`,
    `- ${text('entryRule.answer')}`,
    '',
    text('entryRule.self'),
    '',
    text('entryRule.settings'),
    ENTRY_RULE_END,
  ].join('\n')
}

// Why the block cannot be placed: an opening marker again before the closing one, a closing marker with no opening one
// before it, an opening marker with no closing one after it.
export type UnpairedMarker = 'begin-again' | 'end-alone' | 'begin-alone'

export type PlacedEntryRule = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly problem: UnpairedMarker }

// A line of a text with its own line ending ('' for a last line without one).
type Line = { readonly body: string; readonly end: string }

function linesOf(text: string): Line[] {
  const lines: Line[] = []
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/g
  let at = 0
  while (at < text.length) {
    pattern.lastIndex = at
    const match = pattern.exec(text)
    if (match === null) break
    lines.push({ body: match[1] ?? '', end: match[2] ?? '' })
    at = pattern.lastIndex
  }
  return lines
}

// The file's text with the block in it exactly once. `current` is the file's text, or null when there is no file — then
// the file is the block alone. Every byte of the file outside the plugin's blocks stays as it is (a byte order mark and
// line endings, mixed ones too): a block of the plugin already there is replaced in its place (several — the first is
// replaced, the others go), otherwise the block is added at the end after a blank line. Only the block's own lines get
// a line ending chosen: that of its opening marker it replaces, or that of the file's last line (its first line ending
// when the last has none, LF in a file without any). A marker without its pair (an opening line without its closing
// one after it, or a closing line without an opening one before it) is a problem: what belongs to the block cannot be
// told, and nothing is written. A UTF-8 byte order mark is the file's prefix, not part of its first line: it stays first
// also when the block it replaces opens the file.
export function placeEntryRule(current: string | null, block: string): PlacedEntryRule {
  if (current === null || current === '') return { ok: true, text: `${block}\n` }
  if (current.startsWith('\uFEFF')) {
    const placed = placeEntryRule(current.slice(1), block)
    return placed.ok ? { ok: true, text: `\uFEFF${placed.text}` } : placed
  }
  const lines = linesOf(current)
  const blockLines = block.split('\n')
  const withEnding = (end: string) => blockLines.map((line) => `${line}${end}`).join('')
  let out = ''
  let inside: Line | null = null
  let placed = false
  for (const line of lines) {
    const trimmed = line.body.trim()
    if (trimmed.startsWith(ENTRY_RULE_BEGIN)) {
      if (inside !== null) return { ok: false, problem: 'begin-again' }
      inside = line
      continue
    }
    if (trimmed === ENTRY_RULE_END) {
      if (inside === null) return { ok: false, problem: 'end-alone' }
      // The block takes the line ending of its opening marker; its last line keeps the closing marker's own.
      if (!placed) out += withEnding(inside.end || '\n').slice(0, -(inside.end || '\n').length) + line.end
      placed = true
      inside = null
      continue
    }
    if (inside === null) out += line.body + line.end
  }
  if (inside !== null) return { ok: false, problem: 'begin-alone' }
  if (placed) return { ok: true, text: out }
  const last = lines[lines.length - 1]
  const eol = last?.end || lines.find((line) => line.end !== '')?.end || '\n'
  // The file's last line ends now; a blank line, unless the file ends with one; then the block.
  const ended = last === undefined || last.end !== '' ? current : `${current}${eol}`
  const blank = last !== undefined && (last.end === '' || last.body.trim() !== '') ? eol : ''
  return { ok: true, text: `${ended}${blank}${withEnding(eol)}` }
}

// The block of `text` between the plugin's markers, markers included, or null when the file has none.
export function entryRuleIn(text: string): string | null {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim().startsWith(ENTRY_RULE_BEGIN))
  if (start < 0) return null
  const end = lines.findIndex((line, at) => at > start && line.trim() === ENTRY_RULE_END)
  return end < 0 ? null : lines.slice(start, end + 1).join('\n')
}
