// The project's settings: the file .agent-queue.json in the project's repository (TZ «Данные»). The connection wizard
// (task `connect`) writes it, then the owner edits it; a queue task never changes it. This module is its format — the
// fields, their types and defaults, the check that names the field at fault — and its reading from the project's base
// branch (./base-branch.ts). README «Настройки проекта» describes the format for the plugin's users.
//
// Defaults are those of the connection form (Ф1, point 3): the base branch is the repository's default branch, the
// agents are Claude, Codex, Claude and Claude, one task in work at once, worktree dependencies `shared`.
import { GITHUB_LANGUAGES, isGithubLanguage, type GithubLanguage } from '../github-texts/catalog'
import { errorMessage, type Machine } from '../platform/machine'
import type { ProjectTestSettings } from '../platform/run'
import {
  branchNameProblem,
  defaultBranch,
  readBaseBranchFile,
  REMOTE,
  remoteBranches,
  textsInCommits,
  type BaseBranchCommit,
} from './base-branch'

export const SETTINGS_FILE = '.agent-queue.json'

// The format version this plugin reads and writes.
export const SETTINGS_VERSION = 1

// The roles an agent of the project's settings plays (TZ «Пользователи и роли»), by their field in `agents`.
export const AGENT_ROLES = ['implementer', 'reviewer', 'solver', 'start'] as const
export type AgentRole = (typeof AGENT_ROLES)[number]
// Orca's agent ids (`agent.launch`): one for each role.
export type ProjectAgents = { readonly [R in AgentRole]: string }

// `own`: a task's worktree installs its own dependencies with its setup; `shared`: it shares them with the main checkout.
export const WORKTREE_DEPENDENCY_MODES = ['own', 'shared'] as const
export type WorktreeDependencyMode = (typeof WORKTREE_DEPENDENCY_MODES)[number]

export type WorktreeDependencies = {
  readonly mode: WorktreeDependencyMode
  // The project's dependency directories, from the repository's root (e.g. node_modules, vendor).
  readonly directories: readonly string[]
}

// A step after a merge: a command in the main checkout, and the name GitHub texts give the step (none: its number).
export type AfterMergeStep = { readonly command: string; readonly name: string | null }

// The MVP acceptance stand (Ф13): `setup` and `up` raise it in a worktree of the base branch, `url` answers once it is
// up, `down` takes it down.
export type AcceptanceStand = { readonly setup: string; readonly up: string; readonly url: string; readonly down: string }

// The settings as the plugin uses them, every default filled in. The test commands are run.ts's ProjectTestSettings:
// settings go to runProjectTests() as they are.
export type ProjectSettings = Required<ProjectTestSettings> & {
  readonly version: typeof SETTINGS_VERSION
  readonly baseBranch: string
  readonly agents: ProjectAgents
  // The language of the texts the plugin writes to GitHub (src/github-texts/).
  readonly language: GithubLanguage
  // What never goes to GitHub: a text every agent's task carries.
  readonly dataRule: string
  // How many of the project's tasks are in work at once.
  readonly maxInProgress: number
  readonly worktreeDependencies: WorktreeDependencies
  readonly afterMerge: readonly AfterMergeStep[]
  // Regular expressions of the data that never goes to GitHub, on top of the data rule (forbiddenPatternRegExps).
  readonly forbiddenPatterns: readonly string[]
  // null: the project has no acceptance stand.
  readonly acceptanceStand: AcceptanceStand | null
}

export const DEFAULT_AGENTS: ProjectAgents = { implementer: 'claude', reviewer: 'codex', solver: 'claude', start: 'claude' }
export const DEFAULT_MAX_IN_PROGRESS = 1
export const DEFAULT_WORKTREE_DEPENDENCY_MODE: WorktreeDependencyMode = 'shared'

// One thing wrong with the file: the field at fault — its path, such as `agents.reviewer` or `afterMerge[1].command` —
// or null for the file as a whole (not JSON, not an object), and what is wrong with it.
export type SettingsProblem = { readonly field: string | null; readonly message: string }

export type ParsedSettings =
  | { readonly ok: true; readonly settings: ProjectSettings }
  | { readonly ok: false; readonly problems: readonly SettingsProblem[] }

// The fields of the file, in the order the plugin writes them.
const FIELDS = [
  'version',
  'baseBranch',
  'testCommand',
  'testCommandWindows',
  'agents',
  'language',
  'dataRule',
  'maxInProgress',
  'worktreeDependencies',
  'afterMerge',
  'forbiddenPatterns',
  'acceptanceStand',
] as const satisfies readonly (keyof ProjectSettings)[]

// The flags a forbidden pattern is compiled with; the check of the file compiles each the same way.
const PATTERN_FLAGS = 'u'

// Checks the text of .agent-queue.json and fills in the defaults; `repositoryDefaultBranch` is the base branch when the
// file names none. Every problem is reported, each with its field.
export function parseProjectSettings(text: string, repositoryDefaultBranch: string): ParsedSettings {
  const checked = checkSettingsText(text)
  if (!checked.ok) return checked
  return { ok: true, settings: { ...checked.settings, baseBranch: checked.settings.baseBranch ?? repositoryDefaultBranch } }
}

// The text of .agent-queue.json with these settings, every field written out: what the connection wizard commits.
export function formatProjectSettings(settings: ProjectSettings): string {
  const file: Record<(typeof FIELDS)[number], unknown> = {
    version: settings.version,
    baseBranch: settings.baseBranch,
    testCommand: settings.testCommand,
    testCommandWindows: settings.testCommandWindows,
    agents: Object.fromEntries(AGENT_ROLES.map((role) => [role, settings.agents[role]])),
    language: settings.language,
    dataRule: settings.dataRule,
    maxInProgress: settings.maxInProgress,
    worktreeDependencies: {
      mode: settings.worktreeDependencies.mode,
      directories: [...settings.worktreeDependencies.directories],
    },
    afterMerge: settings.afterMerge.map((step) => ({ command: step.command, name: step.name })),
    forbiddenPatterns: [...settings.forbiddenPatterns],
    acceptanceStand:
      settings.acceptanceStand === null
        ? null
        : {
            setup: settings.acceptanceStand.setup,
            up: settings.acceptanceStand.up,
            url: settings.acceptanceStand.url,
            down: settings.acceptanceStand.down,
          },
  }
  return `${JSON.stringify(file, null, 2)}\n`
}

// The forbidden patterns of the settings, ready to find every match in a text.
export function forbiddenPatternRegExps(settings: Pick<ProjectSettings, 'forbiddenPatterns'>): RegExp[] {
  return settings.forbiddenPatterns.map((pattern) => new RegExp(pattern, `${PATTERN_FLAGS}g`))
}

// The problems as one line, for a log or a row of «Проверка проекта».
export function describeProblems(problems: readonly SettingsProblem[]): string {
  return problems.map((problem) => (problem.field === null ? problem.message : `${problem.field}: ${problem.message}`)).join('; ')
}

export type ReadSettingsResult =
  | { readonly ok: true; readonly settings: ProjectSettings; readonly source: BaseBranchCommit }
  // No .agent-queue.json: the project is not connected. Read from the caller's branch: that branch has none; otherwise
  // neither the default branch (`source`) nor any other branch of origin has a file that names its own branch.
  | { readonly ok: false; readonly kind: 'missing'; readonly error: string; readonly source: BaseBranchCommit }
  // The file is there but wrong: `problems` names each field at fault.
  | {
      readonly ok: false
      readonly kind: 'invalid'
      readonly error: string
      readonly problems: readonly SettingsProblem[]
      readonly source: BaseBranchCommit
    }
  // The default branch has no file, and several branches of origin each have one that names its own branch: which of
  // them is the base branch is not known.
  | { readonly ok: false; readonly kind: 'ambiguous'; readonly error: string; readonly branches: readonly string[] }
  // git failed, or the clone lacks the branch: nothing is known about the file.
  | { readonly ok: false; readonly kind: 'unreadable'; readonly error: string }

// Reads the project's settings from its base branch: the committed .agent-queue.json of origin/<branch>, never the
// working tree of the checkout.
// - A caller that knows the base branch names it (`options.branch`), and reading starts there.
// - Otherwise reading starts at the repository's default branch. When that branch has no file, the project may be
//   connected on another base branch (the connection commit goes only to the branch the owner chose, Ф1): the base
//   branch is then the branch of origin whose file names that very branch (`baseBranch`) — the file the connection
//   wizard wrote there. A file on any other branch (a task's branch, a branch made from the base) names the base, not
//   its own branch, and does not count.
// A file that names another base branch hands over to the file of that branch, which must name its own branch: the
// settings are always those of the base branch they name.
export async function readProjectSettings(
  machine: Machine,
  checkout: string,
  options: { readonly branch?: string } = {},
): Promise<ReadSettingsResult> {
  let repositoryDefault: Promise<string> | null = null
  const fallback = () => (repositoryDefault ??= defaultBranch(machine, checkout))
  const readFrom = async (branch: string): Promise<ReadSettingsResult> => {
    const file = await readBaseBranchFile(machine, checkout, branch, SETTINGS_FILE)
    const source = { branch: file.branch, commit: file.commit }
    if (!file.found) {
      return { ok: false, kind: 'missing', error: `${REMOTE}/${branch} has no ${SETTINGS_FILE}`, source }
    }
    const checked = checkSettingsText(file.text)
    if (!checked.ok) return invalid(source, checked.problems)
    return { ok: true, settings: { ...checked.settings, baseBranch: checked.settings.baseBranch ?? (await fallback()) }, source }
  }
  // The default branch has no file: the branch of origin whose file names it.
  const discover = async (missing: Extract<ReadSettingsResult, { kind: 'missing' }>): Promise<ReadSettingsResult> => {
    const branches = (await remoteBranches(machine, checkout)).filter(({ branch }) => branch !== missing.source.branch)
    const texts = await textsInCommits(machine, checkout, branches.map(({ commit }) => commit), SETTINGS_FILE)
    const named = branches
      .filter(({ branch, commit }) => namesOwnBranch(texts.get(commit), branch))
      .map(({ branch }) => branch)
      .sort()
    const [only] = named
    if (only === undefined) {
      const error = `${missing.error}, and no other branch of ${REMOTE} has one that names its own branch as baseBranch`
      return { ...missing, error }
    }
    if (named.length > 1) {
      const list = named.map((branch) => `${REMOTE}/${branch}`).join(', ')
      const error = `${SETTINGS_FILE}: ${list} each have one that names its own branch as baseBranch; which one is the base branch is not known`
      return { ok: false, kind: 'ambiguous', error, branches: named }
    }
    return readFrom(only)
  }
  try {
    const start = options.branch ?? (await fallback())
    const first = await readFrom(start)
    if (!first.ok && first.kind === 'missing' && options.branch === undefined) return await discover(first)
    if (!first.ok || first.settings.baseBranch === start) return first
    const base = first.settings.baseBranch
    const second = await readFrom(base)
    if (!second.ok && second.kind === 'missing') {
      return invalid(first.source, [
        { field: 'baseBranch', message: `names the base branch ${base}, but ${REMOTE}/${base} has no ${SETTINGS_FILE}` },
      ])
    }
    if (second.ok && second.settings.baseBranch !== base) {
      return invalid(second.source, [
        {
          field: 'baseBranch',
          message: `names the base branch ${second.settings.baseBranch}, while the file of ${REMOTE}/${start} names ${base}: the base branch's own file must name it`,
        },
      ])
    }
    return second
  } catch (error) {
    return { ok: false, kind: 'unreadable', error: `${SETTINGS_FILE}: ${errorMessage(error)}` }
  }
}

// Whether a settings file's text names `branch` as its base branch: the mark of the base branch's own file. Only its
// `baseBranch` counts here; the whole file is checked when it is read.
function namesOwnBranch(text: string | undefined, branch: string): boolean {
  if (text === undefined) return false
  try {
    const json: unknown = JSON.parse(text.replace(/^\uFEFF/, ''))
    return isObject(json) && json.baseBranch === branch
  } catch {
    return false
  }
}

function invalid(source: BaseBranchCommit, problems: readonly SettingsProblem[]): ReadSettingsResult {
  const error = `${SETTINGS_FILE} in ${REMOTE}/${source.branch}: ${describeProblems(problems)}`
  return { ok: false, kind: 'invalid', error, problems, source }
}

// --- The check of the file ---------------------------------------------------------------------------------------

type CheckedSettings = Omit<ProjectSettings, 'baseBranch'> & { readonly baseBranch: string | null }

type Checked = { readonly ok: true; readonly settings: CheckedSettings } | { readonly ok: false; readonly problems: SettingsProblem[] }

function checkSettingsText(text: string): Checked {
  let json: unknown
  try {
    json = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (error) {
    return { ok: false, problems: [{ field: null, message: `not valid JSON: ${errorMessage(error)}` }] }
  }
  const problems: SettingsProblem[] = []
  if (!isObject(json)) {
    return { ok: false, problems: [{ field: null, message: `must hold a JSON object, got ${described(json)}` }] }
  }
  // Another version is another format: its other fields are not checked against this one.
  const version = json.version
  if (version === undefined) {
    return { ok: false, problems: [{ field: 'version', message: `missing: the format version (${SETTINGS_VERSION})` }] }
  }
  if (version !== SETTINGS_VERSION) {
    const message =
      typeof version === 'number'
        ? `format version ${version} is not known to this plugin, which reads version ${SETTINGS_VERSION}`
        : `must be the number ${SETTINGS_VERSION}, got ${described(version)}`
    return { ok: false, problems: [{ field: 'version', message }] }
  }
  unknownFields(json, FIELDS, '', problems)
  const check = new FieldCheck(problems)
  const settings: CheckedSettings = {
    version: SETTINGS_VERSION,
    baseBranch: check.optional(json, 'baseBranch', '', null, (value, field) => check.branchName(value, field)),
    testCommand: check.required(json, 'testCommand', '', '', (value, field) => check.command(value, field)),
    testCommandWindows: check.optional(json, 'testCommandWindows', '', null, (value, field) =>
      value === null ? null : check.command(value, field),
    ),
    agents: check.optional(json, 'agents', '', DEFAULT_AGENTS, (value, field) => check.agents(value, field)),
    language: check.required(json, 'language', '', 'en', (value, field) => check.language(value, field)),
    dataRule: check.required(json, 'dataRule', '', '', (value, field) => check.text(value, field)),
    maxInProgress: check.optional(json, 'maxInProgress', '', DEFAULT_MAX_IN_PROGRESS, (value, field) =>
      check.positiveInteger(value, field),
    ),
    worktreeDependencies: check.optional(
      json,
      'worktreeDependencies',
      '',
      { mode: DEFAULT_WORKTREE_DEPENDENCY_MODE, directories: [] },
      (value, field) => check.worktreeDependencies(value, field),
    ),
    afterMerge: check.optional(json, 'afterMerge', '', [], (value, field) =>
      check.list(value, field, (step, stepField) => check.afterMergeStep(step, stepField)),
    ),
    forbiddenPatterns: check.optional(json, 'forbiddenPatterns', '', [], (value, field) =>
      check.list(value, field, (pattern, patternField) => check.pattern(pattern, patternField)),
    ),
    acceptanceStand: check.optional(json, 'acceptanceStand', '', null, (value, field) =>
      value === null ? null : check.stand(value, field),
    ),
  }
  return problems.length === 0 ? { ok: true, settings } : { ok: false, problems }
}

// The checks of single fields. A check that finds a problem records it and returns its fallback, so the rest of the
// file is still checked; the fallback itself is never used, since a file with a problem is refused as a whole.
class FieldCheck {
  constructor(private readonly problems: SettingsProblem[]) {}

  private problem<T>(field: string, message: string, fallback: T): T {
    this.problems.push({ field, message })
    return fallback
  }

  required<T>(
    object: Record<string, unknown>,
    key: string,
    parent: string,
    fallback: T,
    check: (value: unknown, field: string) => T,
  ): T {
    const field = fieldPath(parent, key)
    if (!Object.hasOwn(object, key)) return this.problem(field, 'missing', fallback)
    return check(object[key], field)
  }

  optional<T>(
    object: Record<string, unknown>,
    key: string,
    parent: string,
    fallback: T,
    check: (value: unknown, field: string) => T,
  ): T {
    return Object.hasOwn(object, key) ? check(object[key], fieldPath(parent, key)) : fallback
  }

  text(value: unknown, field: string): string {
    if (typeof value !== 'string') return this.problem(field, `must be a string, got ${described(value)}`, '')
    if (value.trim() === '') return this.problem(field, 'must not be empty', '')
    return value
  }

  // A command line for the system's shell: one line, not empty.
  command(value: unknown, field: string): string {
    const text = this.text(value, field)
    if (/[\r\n\0]/.test(text)) return this.problem(field, 'must be one line: a command for the shell', '')
    return text
  }

  branchName(value: unknown, field: string): string | null {
    const text = this.text(value, field)
    if (text === '') return null
    const reason = branchNameProblem(text)
    return reason === null ? text : this.problem(field, `${JSON.stringify(text)} is not a branch name: ${reason}`, null)
  }

  language(value: unknown, field: string): GithubLanguage {
    if (isGithubLanguage(value)) return value
    const known = GITHUB_LANGUAGES.map((language) => `"${language}"`).join(' or ')
    return this.problem(field, `must be ${known}, got ${described(value)}`, 'en')
  }

  positiveInteger(value: unknown, field: string): number {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value
    return this.problem(field, `must be a whole number of 1 or more, got ${described(value)}`, 1)
  }

  agents(value: unknown, field: string): ProjectAgents {
    const object = this.object(value, field)
    if (object === null) return DEFAULT_AGENTS
    unknownFields(object, AGENT_ROLES, field, this.problems)
    const agents: Partial<Record<AgentRole, string>> = {}
    for (const role of AGENT_ROLES) {
      agents[role] = this.optional(object, role, field, DEFAULT_AGENTS[role], (id, idField) => this.agentId(id, idField))
    }
    return { ...DEFAULT_AGENTS, ...agents }
  }

  // An Orca agent id (`claude`, `codex` …): whether Orca knows it is checked where agents start and in «Проверка
  // проекта», not here.
  agentId(value: unknown, field: string): string {
    const text = this.text(value, field)
    if (/\s/.test(text)) return this.problem(field, `must be an Orca agent id such as "claude", got ${described(value)}`, '')
    return text
  }

  worktreeDependencies(value: unknown, field: string): WorktreeDependencies {
    const fallback: WorktreeDependencies = { mode: DEFAULT_WORKTREE_DEPENDENCY_MODE, directories: [] }
    const object = this.object(value, field)
    if (object === null) return fallback
    unknownFields(object, ['mode', 'directories'], field, this.problems)
    return {
      mode: this.optional(object, 'mode', field, DEFAULT_WORKTREE_DEPENDENCY_MODE, (mode, modeField) => {
        if (mode === 'own' || mode === 'shared') return mode
        return this.problem(modeField, `must be "own" or "shared", got ${described(mode)}`, DEFAULT_WORKTREE_DEPENDENCY_MODE)
      }),
      directories: this.optional(object, 'directories', field, [], (list, listField) =>
        this.list(list, listField, (dir, dirField) => this.repositoryPath(dir, dirField)),
      ),
    }
  }

  // A path inside the repository, from its root: not absolute, never above the root.
  repositoryPath(value: unknown, field: string): string {
    const text = this.text(value, field)
    if (text === '') return ''
    if (/^([\\/]|[A-Za-z]:)/.test(text)) {
      return this.problem(field, `must be a path inside the repository, from its root, got the absolute ${JSON.stringify(text)}`, '')
    }
    if (text.split(/[\\/]/).includes('..')) {
      return this.problem(field, `must stay inside the repository, got ${JSON.stringify(text)}`, '')
    }
    return text
  }

  afterMergeStep(value: unknown, field: string): AfterMergeStep {
    const object = this.object(value, field)
    if (object === null) return { command: '', name: null }
    unknownFields(object, ['command', 'name'], field, this.problems)
    return {
      command: this.required(object, 'command', field, '', (command, commandField) => this.command(command, commandField)),
      name: this.optional(object, 'name', field, null, (name, nameField) => (name === null ? null : this.text(name, nameField))),
    }
  }

  // A regular expression (JavaScript, Unicode mode) that cannot match an empty text: such a pattern would mark every
  // place of every text.
  pattern(value: unknown, field: string): string {
    const text = this.text(value, field)
    if (text === '') return ''
    let pattern: RegExp
    try {
      pattern = new RegExp(text, PATTERN_FLAGS)
    } catch (error) {
      return this.problem(field, `not a regular expression: ${errorMessage(error)}`, '')
    }
    if (pattern.test('')) return this.problem(field, `matches an empty text: ${JSON.stringify(text)}`, '')
    return text
  }

  stand(value: unknown, field: string): AcceptanceStand {
    const fallback: AcceptanceStand = { setup: '', up: '', url: '', down: '' }
    const object = this.object(value, field)
    if (object === null) return fallback
    unknownFields(object, ['setup', 'up', 'url', 'down'], field, this.problems)
    const command = (key: 'setup' | 'up' | 'down') =>
      this.required(object, key, field, '', (line, lineField) => this.command(line, lineField))
    return {
      setup: command('setup'),
      up: command('up'),
      url: this.required(object, 'url', field, '', (url, urlField) => this.httpUrl(url, urlField)),
      down: command('down'),
    }
  }

  httpUrl(value: unknown, field: string): string {
    const text = this.text(value, field)
    if (text === '') return ''
    let protocol: string | null
    try {
      protocol = new URL(text).protocol
    } catch {
      protocol = null
    }
    if (protocol === 'http:' || protocol === 'https:') return text
    return this.problem(field, `must be an http:// or https:// address, got ${described(value)}`, '')
  }

  list<T>(value: unknown, field: string, check: (item: unknown, itemField: string) => T): T[] {
    if (!Array.isArray(value)) return this.problem(field, `must be a list, got ${described(value)}`, [])
    return value.map((item: unknown, index) => check(item, `${field}[${index}]`))
  }

  object(value: unknown, field: string): Record<string, unknown> | null {
    return isObject(value) ? value : this.problem(field, `must be an object, got ${described(value)}`, null)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unknownFields(
  object: Record<string, unknown>,
  known: readonly string[],
  parent: string,
  problems: SettingsProblem[],
): void {
  for (const key of Object.keys(object)) {
    if (!known.includes(key)) problems.push({ field: fieldPath(parent, key), message: 'unknown field' })
  }
}

// The path of a field: `agents.reviewer`; a key that is not a plain name goes in brackets (`agents["review er"]`).
function fieldPath(parent: string, key: string): string {
  if (!/^[A-Za-z_$][\w$]*$/.test(key)) return `${parent}[${JSON.stringify(key)}]`
  return parent === '' ? key : `${parent}.${key}`
}

// A value as an error names it: its type, and a short form of a string or a number.
function described(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'a list'
  if (typeof value === 'object') return 'an object'
  if (typeof value === 'string') return `the text ${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)}`
  return `${typeof value === 'number' ? 'the number' : typeof value} ${String(value)}`
}
