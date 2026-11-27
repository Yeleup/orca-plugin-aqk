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

export type PlacedEntryRule = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly problem: string }

// The file's text with the block in it exactly once. `current` is the file's text, or null when there is no file — then
// the file is the block alone. The file's own text stays as it is: a block of the plugin already there is replaced in
// its place (several — the first is replaced, the others go), otherwise the block is added at the end after a blank
// line. A marker without its pair (an opening line without its closing one after it, or a closing line without an
// opening one before it) is a problem: what belongs to the block cannot be told, and nothing is written. The block's
// lines end the way the file's do (CRLF when the file has it).
export function placeEntryRule(current: string | null, block: string): PlacedEntryRule {
  if (current === null || current === '') return { ok: true, text: `${block}\n` }
  const eol = current.includes('\r\n') ? '\r\n' : '\n'
  const lines = current.split(/\r?\n/)
  const blockLines = block.split('\n')
  const kept: string[] = []
  let inside = false
  let placed = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith(ENTRY_RULE_BEGIN)) {
      if (inside) return { ok: false, problem: 'the opening line of the Agent Queue block comes again before its closing line' }
      inside = true
      continue
    }
    if (trimmed === ENTRY_RULE_END) {
      if (!inside) return { ok: false, problem: 'the closing line of the Agent Queue block has no opening line before it' }
      inside = false
      if (!placed) kept.push(...blockLines)
      placed = true
      continue
    }
    if (!inside) kept.push(line)
  }
  if (inside) return { ok: false, problem: 'the opening line of the Agent Queue block has no closing line after it' }
  if (placed) return { ok: true, text: kept.join(eol) }
  // `lines` ends with '' when the file ends with a line break.
  const body = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
  const blank = body.length > 0 && body[body.length - 1]?.trim() !== '' ? [''] : []
  return { ok: true, text: [...body, ...blank, ...blockLines, ''].join(eol) }
}

// The block of `text` between the plugin's markers, markers included, or null when the file has none.
export function entryRuleIn(text: string): string | null {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim().startsWith(ENTRY_RULE_BEGIN))
  if (start < 0) return null
  const end = lines.findIndex((line, at) => at > start && line.trim() === ENTRY_RULE_END)
  return end < 0 ? null : lines.slice(start, end + 1).join('\n')
}
