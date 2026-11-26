// The project's rules for tasks: the file .agent-queue.md in the project's repository (TZ «Данные»): what to read before
// a task, the project's commands, what a worktree must never do. The plugin puts it whole into the tasks it gives its
// agents (TZ Ф4: the implementer's task carries it). The connection wizard (task `connect`) writes it from the template below, in the
// project's language; then the owner edits it, and a queue task never changes it. It is read, like the settings, from
// the project's base branch (./base-branch.ts).
import type { GithubLanguage } from '../github-texts/catalog'
import { errorMessage, type Machine } from '../platform/machine'
import { readBaseBranchFile, REMOTE, type BaseBranchCommit } from './base-branch'
import type { ProjectSettings } from './settings'

export const TASK_RULES_FILE = '.agent-queue.md'

export type TaskRulesTemplateInput = Pick<ProjectSettings, 'language' | 'testCommand'> & {
  readonly testCommandWindows?: string | null
}

// The text of .agent-queue.md the connection wizard offers: the project's test commands filled in, the rest — what to
// read, the other commands, what a worktree must never do — places in angle brackets for the owner to fill.
export function taskRulesTemplate(input: TaskRulesTemplateInput): string {
  const text = TEMPLATES[input.language]
  const windows = input.testCommandWindows?.trim()
  const commands = [text.tests(inlineCode(input.testCommand))]
  if (windows) commands.push(text.testsWindows(inlineCode(windows)))
  return [
    `# ${text.title}`,
    '',
    `<!-- ${text.comment} -->`,
    '',
    `## ${text.read}`,
    '',
    `- ${text.readPlaceholder}`,
    '',
    `## ${text.commands}`,
    '',
    ...commands.map((line) => `- ${line}`),
    `- ${text.commandsPlaceholder}`,
    '',
    `## ${text.never}`,
    '',
    `- ${text.neverPlaceholder}`,
    '',
  ].join('\n')
}

type TemplateText = {
  readonly title: string
  readonly comment: string
  readonly read: string
  readonly readPlaceholder: string
  readonly commands: string
  readonly tests: (command: string) => string
  readonly testsWindows: (command: string) => string
  readonly commandsPlaceholder: string
  readonly never: string
  readonly neverPlaceholder: string
}

const TEMPLATES: { readonly [L in GithubLanguage]: TemplateText } = {
  en: {
    title: 'Rules for the tasks of the queue',
    comment:
      'Agent Queue puts this whole file into the tasks it gives agents. Write rules for them: what to read before a task, which commands to use, what a worktree must never do. Only the owner changes this file.',
    read: 'Read before a task',
    readPlaceholder: '<documents of the project: specification, business rules, descriptions of the modules>',
    commands: 'Commands of the project',
    tests: (command) => `Full tests: ${command}.`,
    testsWindows: (command) => `Full tests on Windows: ${command}.`,
    commandsPlaceholder: '<other commands: build, linter, a single test>',
    never: 'Never in a worktree',
    neverPlaceholder: '<commands that touch a shared stand, the main checkout or a production server>',
  },
  ru: {
    title: 'Правила для заданий очереди',
    comment:
      'Agent Queue вставляет этот файл целиком в задания агентам очереди. Пишите правила для них: что читать перед задачей, какими командами пользоваться, чего в worktree делать нельзя. Меняет файл только владелец.',
    read: 'Что читать перед задачей',
    readPlaceholder: '<документы проекта: ТЗ, бизнес-правила, описания модулей>',
    commands: 'Команды проекта',
    tests: (command) => `Полные тесты: ${command}.`,
    testsWindows: (command) => `Полные тесты на Windows: ${command}.`,
    commandsPlaceholder: '<другие команды: сборка, линтер, один тест>',
    never: 'Чего нельзя в worktree',
    neverPlaceholder: '<команды, которые трогают общий стенд, основной чекаут или боевой сервер>',
  },
}

// `text` as a Markdown code span: fenced by more backticks than any run of them inside, padded when it starts or ends
// with one.
function inlineCode(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length))
  const fence = '`'.repeat(longest + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

export type ReadTaskRulesResult =
  | { readonly ok: true; readonly text: string; readonly source: BaseBranchCommit }
  // The base branch has no .agent-queue.md.
  | { readonly ok: false; readonly kind: 'missing'; readonly error: string; readonly source: BaseBranchCommit }
  // git failed, or the clone lacks the branch: nothing is known about the file.
  | { readonly ok: false; readonly kind: 'unreadable'; readonly error: string }

// The committed .agent-queue.md of origin/<baseBranch> (the base branch of the project's settings), as it is.
export async function readTaskRules(machine: Machine, checkout: string, baseBranch: string): Promise<ReadTaskRulesResult> {
  try {
    const file = await readBaseBranchFile(machine, checkout, baseBranch, TASK_RULES_FILE)
    const source = { branch: file.branch, commit: file.commit }
    if (!file.found) return { ok: false, kind: 'missing', error: `${REMOTE}/${baseBranch} has no ${TASK_RULES_FILE}`, source }
    return { ok: true, text: file.text, source }
  } catch (error) {
    return { ok: false, kind: 'unreadable', error: `${TASK_RULES_FILE}: ${errorMessage(error)}` }
  }
}
