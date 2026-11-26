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
  blobText,
  branchNameProblem,
  commitEntry,
  defaultBranch,
  MAX_FILE_BYTES,
  REMOTE,
  remoteBranches,
  type BaseBranchCommit,
  type CommitEntry,
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
  // neither the default branch (`source`) nor any other branch of origin known to this clone has a copy of the file.
  | { readonly ok: false; readonly kind: 'missing'; readonly error: string; readonly source: BaseBranchCommit }
  // The file is there but wrong: `problems` names each field at fault.
  | {
      readonly ok: false
      readonly kind: 'invalid'
      readonly error: string
      readonly problems: readonly SettingsProblem[]
      readonly source: BaseBranchCommit
    }
  // The default branch has no file, and several branches of origin could be the base: each names itself, or none
  // does and each has a copy that may be the base's own, broken. None is chosen; `error` gives each one's reason.
  | { readonly ok: false; readonly kind: 'ambiguous'; readonly error: string; readonly branches: readonly string[] }
  // git failed, the clone lacks the branch, or the file is not a readable file: nothing is known about the settings.
  | { readonly ok: false; readonly kind: 'unreadable'; readonly error: string }

// How many branches are looked at, at once, when the base branch is searched for.
const SEARCH_CONCURRENCY = 8

// Reads the project's settings from its base branch: the committed .agent-queue.json of origin/<branch>, never the
// working tree of the checkout. Everything is decided from one picture of origin's branches as the clone knows them,
// and each copy of the file is read once, exactly (./base-branch.ts): the result's settings come from the very commit
// in `source` that the choice was made on.
// - A caller that knows the base branch names it (`options.branch`), and reading starts there.
// - Otherwise reading starts at the repository's default branch. When that branch has no file, the project may be
//   connected on another base branch (the connection commit goes only to the branch the owner chose, Ф1): the base
//   branch is then the branch of origin whose copy names that very branch in `baseBranch` — the file the connection
//   wizard wrote there. A copy on any other branch (a task's branch, a branch made from the base) names the base, not
//   its own branch, and does not count. When no copy names its own branch, the base branch's own file may be broken:
//   a copy that names a branch which has a copy defers to it, and the others — a copy whose base branch cannot be told
//   (not JSON, `baseBranch` not a branch name, not a readable file), a copy that names a branch without a copy — may be
//   the base's own. One is reported with its problems (a wrong field named), several are `ambiguous`.
// A copy that names another base branch hands over to that branch by its `baseBranch` alone — its other fields are
// not checked, it is not the base branch's file — and the file of that branch must name its own branch: the settings
// are always those of the base branch they name.
export async function readProjectSettings(
  machine: Machine,
  checkout: string,
  options: { readonly branch?: string } = {},
): Promise<ReadSettingsResult> {
  try {
    return await new SettingsReader(machine, checkout).read(options.branch)
  } catch (error) {
    return { ok: false, kind: 'unreadable', error: `${SETTINGS_FILE}: ${errorMessage(error)}` }
  }
}

// One copy of the settings file on a branch, at the commit of the picture: its text, why it is not a readable file,
// or none.
type Copy = BaseBranchCommit &
  (
    | { readonly state: 'file'; readonly text: string }
    | { readonly state: 'unreadable'; readonly reason: string }
    | { readonly state: 'none' }
  )
type FileCopy = Extract<Copy, { state: 'file' }>

// Where a copy says the base branch is, from its `baseBranch` alone: a branch it names, the repository's default branch
// when it names none, or `unknown` when that cannot be told — the text is not a JSON object, or its `baseBranch` is not
// a branch name.
type NamedBase = { readonly kind: 'named'; readonly branch: string } | { readonly kind: 'default' } | { readonly kind: 'unknown' }

function namedBase(text: string): NamedBase {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { kind: 'unknown' }
  }
  if (!isObject(json)) return { kind: 'unknown' }
  if (!Object.hasOwn(json, 'baseBranch')) return { kind: 'default' }
  const branch = json.baseBranch
  return typeof branch === 'string' && branchNameProblem(branch) === null ? { kind: 'named', branch } : { kind: 'unknown' }
}

class SettingsReader {
  private branches: Map<string, string> | null = null
  private repositoryDefault: Promise<string> | null = null
  private readonly entries = new Map<string, Promise<CommitEntry>>()
  private readonly texts = new Map<string, Promise<string>>()

  constructor(
    private readonly machine: Machine,
    private readonly checkout: string,
  ) {}

  async read(branch: string | undefined): Promise<ReadSettingsResult> {
    if (branch !== undefined) {
      const notBranch = branchNameProblem(branch)
      if (notBranch !== null) throw new Error(`${JSON.stringify(branch)} is not a branch name: ${notBranch}`)
    }
    const start = branch ?? (await this.defaultBranch())
    const commit = (await this.picture()).get(start)
    if (commit === undefined) {
      if (branch !== undefined) {
        throw new Error(`this clone has no ${REMOTE}/${start}: there is no such branch, or it was not fetched yet`)
      }
      // Reading starts at the default branch, whose copy decides first: the base branch is not chosen from the other
      // branches without it.
      throw new Error(
        `this clone has no ${REMOTE}/${start}, the repository's default branch, where reading starts: the clone does not fetch it (a clone of one branch), or it was not fetched yet`,
      )
    }
    const copy = await this.copyAt(start, commit)
    if (copy.state === 'file') return this.handOver(copy)
    if (copy.state === 'unreadable') throw new Error(`${REMOTE}/${start}: ${copy.reason}`)
    const error = `${REMOTE}/${start} has no ${SETTINGS_FILE}`
    const missing = { ok: false, kind: 'missing', error, source: { branch: start, commit } } as const
    return branch === undefined ? this.search(missing) : missing
  }

  // The default branch has no file: the branch of origin whose copy is the base branch's own.
  private async search(missing: Extract<ReadSettingsResult, { kind: 'missing' }>): Promise<ReadSettingsResult> {
    const others = [...(await this.picture())].filter(([branch]) => branch !== missing.source.branch)
    const copies = await mapLimit(others, SEARCH_CONCURRENCY, ([branch, commit]) => this.copyAt(branch, commit))
    const own = copies.filter((copy): copy is FileCopy => {
      if (copy.state !== 'file') return false
      const base = namedBase(copy.text)
      return base.kind === 'named' && base.branch === copy.branch
    })
    if (own.length === 1 && own[0] !== undefined) return this.settle(own[0])
    if (own.length > 1) return ambiguous(own.map((copy) => [copy.branch, 'names its own branch as baseBranch']))
    // No copy names its own branch: the base branch's own file may be broken. A copy that names a branch which has a
    // copy itself defers to that branch (a task's branch made from the base names the base). The rest may be the
    // base's own: a copy whose base branch cannot be told, or one that names a branch without a copy (a mistyped
    // baseBranch). If every copy names another one, they all are.
    const copied = copies.filter((copy): copy is Exclude<Copy, { state: 'none' }> => copy.state !== 'none')
    const branches = new Set(copied.map((copy) => copy.branch))
    const defers = (copy: (typeof copied)[number]): boolean => {
      if (copy.state !== 'file') return false
      const base = namedBase(copy.text)
      if (base.kind === 'unknown') return false
      const target = base.kind === 'named' ? base.branch : missing.source.branch
      return target !== copy.branch && branches.has(target)
    }
    const undeferred = copied.filter((copy) => !defers(copy))
    const candidates = undeferred.length > 0 ? undeferred : copied
    const [only] = candidates
    if (only === undefined) {
      const error = `${missing.error}, and no other branch of ${REMOTE} known to this clone has one`
      return { ...missing, error }
    }
    if (candidates.length === 1) {
      if (only.state === 'file') return this.handOver(only)
      throw new Error(`${REMOTE}/${only.branch}: ${only.reason}`)
    }
    return ambiguous(
      await Promise.all(
        candidates.map(async (copy): Promise<[string, string]> => {
          if (copy.state === 'unreadable') return [copy.branch, copy.reason]
          const result = await this.handOver(copy)
          return [copy.branch, result.ok ? `reads as the settings of ${REMOTE}/${result.source.branch}` : result.error]
        }),
      ),
    )
  }

  // A copy that names another base branch hands over to that branch's own file, by its `baseBranch` alone.
  private async handOver(copy: FileCopy): Promise<ReadSettingsResult> {
    const named = namedBase(copy.text)
    if (named.kind === 'unknown') return this.settle(copy)
    const base = named.kind === 'named' ? named.branch : await this.defaultBranch()
    if (base === copy.branch) return this.settle(copy)
    const naming =
      named.kind === 'named' ? `names the base branch ${base}` : `names no base branch, so it is the default branch ${base}`
    const source = { branch: copy.branch, commit: copy.commit }
    const commit = (await this.picture()).get(base)
    if (commit === undefined) {
      return invalid(source, [{ field: 'baseBranch', message: `${naming}, but this clone has no ${REMOTE}/${base}` }])
    }
    const target = await this.copyAt(base, commit)
    if (target.state === 'none') {
      return invalid(source, [{ field: 'baseBranch', message: `${naming}, but ${REMOTE}/${base} has no ${SETTINGS_FILE}` }])
    }
    if (target.state === 'unreadable') throw new Error(`${REMOTE}/${base}: ${target.reason}`)
    const result = await this.settle(target)
    if (result.ok && result.settings.baseBranch !== base) {
      const message = `names the base branch ${result.settings.baseBranch}, while the file of ${REMOTE}/${copy.branch} names ${base}: the base branch's own file must name it`
      return invalid(result.source, [{ field: 'baseBranch', message }])
    }
    return result
  }

  // The whole check of a copy, the defaults filled in.
  private async settle(copy: FileCopy): Promise<ReadSettingsResult> {
    const source = { branch: copy.branch, commit: copy.commit }
    const checked = checkSettingsText(copy.text)
    if (!checked.ok) return invalid(source, checked.problems)
    const baseBranch = checked.settings.baseBranch ?? (await this.defaultBranch())
    return { ok: true, settings: { ...checked.settings, baseBranch }, source }
  }

  private async copyAt(branch: string, commit: string): Promise<Copy> {
    let entry = this.entries.get(commit)
    if (entry === undefined) {
      entry = commitEntry(this.machine, this.checkout, commit, SETTINGS_FILE)
      this.entries.set(commit, entry)
    }
    const found = await entry
    if (found.kind === 'none') return { branch, commit, state: 'none' }
    if (found.kind === 'other') return { branch, commit, state: 'unreadable', reason: `${SETTINGS_FILE} is ${found.what}, not a file` }
    if (found.size > MAX_FILE_BYTES) {
      const reason = `${SETTINGS_FILE} is ${found.size} bytes, more than the ${MAX_FILE_BYTES} read`
      return { branch, commit, state: 'unreadable', reason }
    }
    let text = this.texts.get(found.blob)
    if (text === undefined) {
      text = blobText(this.machine, this.checkout, found)
      this.texts.set(found.blob, text)
    }
    return { branch, commit, state: 'file', text: await text }
  }

  // origin's branches and their commits, read once.
  private async picture(): Promise<Map<string, string>> {
    this.branches ??= new Map(
      (await remoteBranches(this.machine, this.checkout)).map(({ branch, commit }) => [branch, commit] as const),
    )
    return this.branches
  }

  private defaultBranch(): Promise<string> {
    this.repositoryDefault ??= defaultBranch(this.machine, this.checkout)
    return this.repositoryDefault
  }
}

function ambiguous(branches: readonly (readonly [string, string])[]): ReadSettingsResult {
  const sorted = [...branches].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const reasons = sorted.map(([branch, reason]) => `${REMOTE}/${branch}: ${reason}`).join('; ')
  const error = `${SETTINGS_FILE}: which branch of ${REMOTE} is the base branch is not known — ${reasons}`
  return { ok: false, kind: 'ambiguous', error, branches: sorted.map(([branch]) => branch) }
}

// `work` for each item, at most `limit` at a time; the results in the items' order.
async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
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
