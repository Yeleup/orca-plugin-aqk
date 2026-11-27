// The templates of the connection wizard (Ф1, point 3) for the project's two files the owner then edits: the rules for
// tasks (.agent-queue.md, ./task-rules.ts) and the data rule of the settings (`dataRule` of .agent-queue.json,
// ./settings.ts), in the project's language (`language`, `ru` or `en`). Plain functions with no file or process: the
// panel's form fills its fields from them, and what the owner sees there is what the wizard commits.
import type { GithubLanguage } from '../github-texts/catalog'
import { inlineCode } from '../markdown'

export type TaskRulesTemplateInput = {
  readonly language: GithubLanguage
  readonly testCommand: string
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

// The data rule the wizard offers: what never goes to GitHub — the owner adds the project's own kinds of data.
export function dataRuleTemplate(language: GithubLanguage): string {
  return DATA_RULES[language]
}

const DATA_RULES: { readonly [L in GithubLanguage]: string } = {
  en: 'Tasks, comments and pull requests never get the names, phone numbers and addresses of customers, nor keys and tokens.',
  ru: 'В задачи, комментарии и PR не попадают имена, телефоны и адреса клиентов, ключи и токены.',
}
