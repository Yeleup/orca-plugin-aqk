// Connecting a project of this computer to the queue (Ф1, points 1–4, without the path through a PR): the worker's side
// of the wizard «Подключение проекта». The panel asks for the projects not connected, runs the checks of step 2 one by
// one and sends the form of step 3; «Подключить» lands here.
//
// «Подключить» checks everything again before it writes anything — the project (not on agent-queue-kit, no other
// connection of it running in this worker), git and its GitHub repository, gh with its login and write access, the
// agents Orca knows (read again: each role's agent must be one of them), the fields of the form — then fetches
// `origin` and connects only when the main checkout is on the base branch, without changes, and its HEAD equals
// origin/<base> (neither behind nor ahead); otherwise it writes nothing and names the reason. Then, in this order:
//
// 1. the intent in the journal of operations (./journal.ts): the operation's id (a new UUID), the source commit, the
//    four paths and the hash (git blob id) of the expected content of each;
// 2. the plugin's labels GitHub lacks (src/github/: the check before every write and the mask; a repeat creates only
//    the missing ones);
// 3. .agent-queue.json (the settings of the form), .agent-queue.md (the rules for tasks of the form) and the block of
//    the entry rule between the plugin's markers in CLAUDE.md and AGENTS.md (src/project/entry-rule.ts: a missing file
//    is created, the rest of the text stays, the block is there once);
// 4. a commit of only these four files, the operation's id in its message (`Agent-Queue-Operation: <id>`);
// 5. a push to the base branch. Rejected — the local commit is undone, the checkout is on the source commit again, and
//    the answer is `pushRejected` with git's reason; a repeated «Подключить» is a new operation.
//
// A failure after the intent (labels, files, commit) puts the written paths back as the source commit has them; each
// step is recorded in the journal. A push that gave no answer in time is left as it is (it may have reached origin):
// the interrupted connection — `connect-recovery` — tells its state from the journal and git, as it does after a stop
// of the worker. Connected: open panels hear `projects.changed`.
import { randomUUID } from 'node:crypto'
import type { HostApi } from 'orca/host'
import { githubText } from '../github-texts/catalog'
import type { Repository } from '../github/gh'
import { GitHub } from '../github/github'
import { errorMessage, type Machine } from '../platform/machine'
import type { OrcaAgent } from '../platform/orca-agents'
import { branchNameProblem } from '../project/base-branch'
import { entryRuleBlock, ENTRY_RULE_FILES, placeEntryRule } from '../project/entry-rule'
import {
  AGENT_ROLES,
  formatProjectSettings,
  parseProjectSettings,
  SETTINGS_FILE,
  SETTINGS_VERSION,
  type ProjectSettings,
} from '../project/settings'
import { TASK_RULES_FILE } from '../project/task-rules'
import type {
  AgentsCheck,
  ConnectCandidate,
  ConnectField,
  ConnectForm,
  ConnectResult,
  ConnectTarget,
  FieldError,
  GhCheck,
  GitCheck,
} from '../protocol'
import { checkAgents, checkGh, checkGit, originRepository, repositoryName } from './checks'
import { Checkout } from './checkout'
import { OperationJournal, type JournalPath, type JournalStep } from './journal'
import { connectCandidates, connectedProjects, findProject, isOnKit, type OrcaProject } from './projects'

type Host = Pick<HostApi<'worker'>, 'call'>

// The four paths the connection writes, in the order of the commit.
export const CONNECT_PATHS = [SETTINGS_FILE, TASK_RULES_FILE, ...ENTRY_RULE_FILES] as const

// The trailer of the connection commit that carries the operation's id.
export const OPERATION_TRAILER = 'Agent-Queue-Operation'

export type ConnectorOptions = {
  readonly host: Host
  readonly machine: Machine
  readonly dataDir: string
  readonly log: (message: string) => void
  // Tells open panels the connected projects changed (`projects.changed`).
  readonly post: (projects: Awaited<ReturnType<typeof connectedProjects>>) => void
}

export class Connector {
  // The projects whose connection runs now, by id and host.
  private readonly running = new Set<string>()

  constructor(private readonly options: ConnectorOptions) {}

  connected() {
    return connectedProjects(this.options.host, this.options.machine)
  }

  candidates(): Promise<ConnectCandidate[]> {
    return connectCandidates(this.options.host, this.options.machine)
  }

  async checkGit(input: unknown): Promise<GitCheck> {
    const project = await this.project(input, 'connect.checkGit')
    return (await checkGit(this.options.machine, project.path)).check
  }

  async checkGh(input: unknown): Promise<GhCheck> {
    const project = await this.project(input, 'connect.checkGh')
    const repository = await originRepository(this.options.machine, project.path)
    if (repository === null) return { status: 'unchecked', error: 'the project has no GitHub repository as its origin' }
    return checkGh(this.options.machine, repository)
  }

  async checkAgents(input: unknown): Promise<AgentsCheck> {
    await this.project(input, 'connect.checkAgents')
    return (await checkAgents(this.options.machine)).check
  }

  async connect(input: unknown): Promise<ConnectResult> {
    const form = parseForm(input)
    const project = await this.project(input, 'connect.connect')
    const key = JSON.stringify([project.id, project.hostId])
    if (this.running.has(key)) return { status: 'refused', refusal: { reason: 'busy' } }
    this.running.add(key)
    try {
      return await this.connectProject(project, form)
    } finally {
      this.running.delete(key)
    }
  }

  private async connectProject(project: OrcaProject, form: ConnectForm): Promise<ConnectResult> {
    const { machine } = this.options
    if (isOnKit(machine, project)) return { status: 'refused', refusal: { reason: 'kit' } }

    // Everything the wizard checked, again.
    const git = await checkGit(machine, project.path)
    if (git.check.status !== 'ok' || git.repository === null) return { status: 'refused', refusal: { reason: 'git', check: git.check } }
    const repository = git.repository
    const gh = await checkGh(machine, repository)
    if (gh.status !== 'ok') return { status: 'refused', refusal: { reason: 'gh', check: gh } }
    const agents = await checkAgents(machine)
    if (agents.agents === null || agents.agents.length === 0) return { status: 'refused', refusal: { reason: 'agents', check: agents.check } }

    const fields = settingsOf(form, agents.agents)
    if (!fields.ok) return { status: 'fields', errors: fields.errors }

    const checkout = new Checkout(machine, project.path)
    const fetched = await checkout.fetch()
    if (fetched !== null) return { status: 'refused', refusal: { reason: 'fetch', error: fetched } }
    if (!(await checkout.hasRemoteBranch(form.baseBranch))) {
      return { status: 'fields', errors: [{ field: 'baseBranch', code: 'branch', detail: `origin has no branch ${form.baseBranch}` }] }
    }
    const { refusal, head: source } = await checkout.readiness(form.baseBranch)
    if (refusal !== null) return { status: 'refused', refusal }

    // The content of the four files, from the source commit and the form.
    const block = entryRuleBlock(form.language, repositoryName(repository))
    const files: { readonly path: string; readonly text: string; readonly existed: boolean }[] = []
    const paths: JournalPath[] = []
    for (const path of CONNECT_PATHS) {
      const at = await checkout.fileAt(source, path)
      if ('problem' in at) return { status: 'refused', refusal: { reason: 'file', file: path, problem: at.problem } }
      let text: string
      if (path === SETTINGS_FILE) text = formatProjectSettings(fields.settings)
      else if (path === TASK_RULES_FILE) text = fields.taskRules
      else {
        const placed = placeEntryRule(at.file?.text ?? null, block)
        if (!placed.ok) return { status: 'refused', refusal: { reason: 'file', file: path, problem: placed.problem } }
        text = placed.text
      }
      files.push({ path, text, existed: at.file !== null })
      paths.push({ path, sourceBlob: at.file?.blob ?? null, expectedBlob: await checkout.blobId(text) })
    }

    // 1. The intent.
    const operation = randomUUID()
    const journal = new OperationJournal(machine, this.options.dataDir, project, operation)
    try {
      await journal.record('intent', {
        kind: 'connect',
        project: { id: project.id, hostId: project.hostId },
        checkout: project.path,
        repository: repositoryName(repository),
        baseBranch: form.baseBranch,
        sourceCommit: source,
        paths,
      })
    } catch (error) {
      return { status: 'refused', refusal: { reason: 'journal', error: errorMessage(error) } }
    }
    const step = async (name: JournalStep, data: Record<string, unknown>) => {
      try {
        await journal.record(name, data)
      } catch (error) {
        this.options.log(`agent-queue: connect ${operation}: the journal did not take ${name}: ${errorMessage(error)}`)
      }
    }
    const failed = async (name: string, error: string): Promise<ConnectResult> => {
      await step('failed', { failedStep: name, error })
      return { status: 'failed', error, operation }
    }
    try {
      return await this.write({ project, form, repository, checkout, source, files, operation, step, failed })
    } catch (error) {
      // git itself failed where no answer was expected: the state is left for the interrupted connection to tell.
      return failed('unexpected', errorMessage(error))
    }
  }

  // Steps 2–5, once the intent is in the journal.
  private async write(op: {
    readonly project: OrcaProject
    readonly form: ConnectForm
    readonly repository: Repository
    readonly checkout: Checkout
    readonly source: string
    readonly files: readonly { readonly path: string; readonly text: string; readonly existed: boolean }[]
    readonly operation: string
    readonly step: (name: JournalStep, data: Record<string, unknown>) => Promise<void>
    readonly failed: (name: string, error: string) => Promise<ConnectResult>
  }): Promise<ConnectResult> {
    const { machine } = this.options
    const { project, form, repository, checkout, source, files, operation, step, failed } = op

    // 2. The labels.
    const github = new GitHub({ machine, repository, settings: { language: form.language, forbiddenPatterns: [] } })
    try {
      const labels = await github.ensureLabels()
      await step('labels', { created: labels.created, present: labels.present })
    } catch (error) {
      return failed('labels', `GitHub labels: ${errorMessage(error)}`)
    }

    // 3–4. The files and their commit.
    const putBack = async (name: string, error: string): Promise<ConnectResult> => {
      const undone = await checkout.restore(source, files)
      await step('undo', undone === null ? { restored: files.map((file) => file.path) } : { error: undone })
      return failed(name, undone === null ? error : `${error}; the files could not be put back: ${undone}`)
    }
    try {
      await checkout.writeFiles(files)
    } catch (error) {
      return putBack('files', `writing the files: ${errorMessage(error)}`)
    }
    await step('files', { written: files.map((file) => file.path) })
    const title = githubText(form.language, 'connect.commitTitle')
    const committed = await checkout.commit(
      files.map((file) => file.path),
      [title, `${OPERATION_TRAILER}: ${operation}`],
      source,
    )
    if ('error' in committed) return putBack('commit', committed.error)
    await step('commit', { commit: committed.commit })

    // 5. The push.
    const pushed = await checkout.push(form.baseBranch)
    if (pushed.outcome === 'unknown') {
      await step('push', { outcome: 'unknown', error: pushed.error })
      return failed('push', `the push gave no answer, it may have reached origin: ${pushed.error}`)
    }
    if (pushed.outcome === 'rejected') {
      await step('push', { outcome: 'rejected', error: pushed.error })
      const undone = await checkout.undoCommit(source)
      await step('undo', undone === null ? { head: source } : { error: undone })
      if (undone !== null) return failed('undo', `the push was rejected (${pushed.error}), and the commit could not be undone: ${undone}`)
      return { status: 'pushRejected', error: pushed.error, operation }
    }
    await step('push', { outcome: 'pushed' })
    this.options.log(`agent-queue: connected ${project.name} (operation ${operation}, commit ${committed.commit})`)
    try {
      this.options.post(await this.connected())
    } catch (error) {
      this.options.log(`agent-queue: the connected projects could not be read after connecting: ${errorMessage(error)}`)
    }
    return {
      status: 'connected',
      project: { id: project.id, hostId: project.hostId, name: project.name },
      operation,
      commit: committed.commit,
    }
  }

  // The Orca project of the request, on this computer; anything else is refused with `invalid_params`.
  private async project(input: unknown, request: string): Promise<OrcaProject> {
    const { projectId, hostId } = (isObject(input) ? input : {}) as Partial<ConnectTarget>
    if (typeof projectId !== 'string' || projectId === '') throw invalidParams(`${request}: no projectId`)
    if (typeof hostId !== 'string' || hostId === '') throw invalidParams(`${request}: no hostId`)
    const project = await findProject(this.options.host, projectId, hostId)
    if (project === null) throw invalidParams(`${request}: Orca has no git project ${projectId} on ${hostId} of this computer`)
    return project
  }
}

// ── The form ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const FORM_TEXTS = ['baseBranch', 'testCommand', 'testCommandWindows', 'dataRule', 'taskRules', 'maxInProgress', 'directories'] as const

// The form of the request, in its shape; anything else is refused with `invalid_params`.
function parseForm(input: unknown): ConnectForm {
  const form = isObject(input) ? input.form : undefined
  if (!isObject(form)) throw invalidParams('connect.connect: no form')
  for (const key of FORM_TEXTS) {
    if (typeof form[key] !== 'string') throw invalidParams(`connect.connect: form.${key} is not a text`)
  }
  if (form.language !== 'ru' && form.language !== 'en') throw invalidParams('connect.connect: form.language is not ru or en')
  if (form.worktreeMode !== 'own' && form.worktreeMode !== 'shared') throw invalidParams('connect.connect: form.worktreeMode is not own or shared')
  const agents = form.agents
  if (!isObject(agents)) throw invalidParams('connect.connect: no form.agents')
  for (const role of AGENT_ROLES) {
    if (agents[role] !== null && typeof agents[role] !== 'string') throw invalidParams(`connect.connect: form.agents.${role} is not an agent id`)
  }
  return form as ConnectForm
}

type SettingsOfForm =
  | { readonly ok: true; readonly settings: ProjectSettings; readonly taskRules: string }
  | { readonly ok: false; readonly errors: FieldError[] }

// The settings the form describes, with every field the owner must fix: required texts, one-line commands, agents Orca
// knows, a whole number from 1, a branch name — then the check of .agent-queue.json itself on the text the wizard
// would commit, its problems at their fields.
export function settingsOf(form: ConnectForm, agents: readonly OrcaAgent[]): SettingsOfForm {
  const errors: FieldError[] = []
  const error = (field: ConnectField, code: FieldError['code'], detail: string) => {
    if (!errors.some((one) => one.field === field)) errors.push({ field, code, detail })
  }
  const testCommand = form.testCommand.trim()
  const testCommandWindows = form.testCommandWindows.trim()
  if (testCommand === '') error('testCommand', 'required', 'the command of the full tests is required')
  else if (/[\r\n]/.test(testCommand)) error('testCommand', 'oneLine', 'a command is one line')
  if (/[\r\n]/.test(testCommandWindows)) error('testCommandWindows', 'oneLine', 'a command is one line')
  const chosen = {} as Record<(typeof AGENT_ROLES)[number], string>
  for (const role of AGENT_ROLES) {
    const id = form.agents[role]
    if (id === null || id === '') error(`agents.${role}`, 'agent', 'no agent chosen')
    else if (!agents.some((agent) => agent.id === id)) error(`agents.${role}`, 'agent', `Orca does not know the agent ${id} on this computer`)
    else chosen[role] = id
  }
  const notBranch = branchNameProblem(form.baseBranch)
  if (notBranch !== null) error('baseBranch', 'branch', `not a branch name: ${notBranch}`)
  const dataRule = form.dataRule.trim()
  if (dataRule === '') error('dataRule', 'required', 'the data rule is required')
  const taskRules = form.taskRules.trim() === '' ? '' : form.taskRules.endsWith('\n') ? form.taskRules : `${form.taskRules}\n`
  if (taskRules === '') error('taskRules', 'required', 'the rules for tasks are required')
  const max = form.maxInProgress.trim()
  const maxInProgress = /^[0-9]+$/.test(max) ? Number(max) : NaN
  if (!Number.isSafeInteger(maxInProgress) || maxInProgress < 1) error('maxInProgress', 'number', 'a whole number of 1 or more')
  if (errors.length > 0) return { ok: false, errors }

  const settings: ProjectSettings = {
    version: SETTINGS_VERSION,
    baseBranch: form.baseBranch,
    testCommand,
    testCommandWindows: testCommandWindows === '' ? null : testCommandWindows,
    agents: chosen,
    language: form.language,
    dataRule,
    maxInProgress,
    worktreeDependencies: {
      mode: form.worktreeMode,
      directories: form.directories
        .split(/[,\n]/)
        .map((directory) => directory.trim())
        .filter((directory) => directory !== ''),
    },
    afterMerge: [],
    forbiddenPatterns: [],
    acceptanceStand: null,
  }
  // The file the wizard commits must pass the plugin's own check of it.
  const parsed = parseProjectSettings(formatProjectSettings(settings), form.baseBranch)
  if (!parsed.ok) {
    for (const problem of parsed.problems) error(formFieldOf(problem.field), 'invalid', problem.message)
    return { ok: false, errors }
  }
  return { ok: true, settings: parsed.settings, taskRules }
}

// The field of the form a problem of .agent-queue.json belongs to.
function formFieldOf(field: string | null): ConnectField {
  if (field === null) return 'testCommand'
  if (field.startsWith('worktreeDependencies.directories')) return 'directories'
  if (field === 'worktreeDependencies.mode') return 'worktreeMode'
  const known: readonly ConnectField[] = [
    'baseBranch',
    'testCommand',
    'testCommandWindows',
    'agents.implementer',
    'agents.reviewer',
    'agents.solver',
    'agents.start',
    'language',
    'dataRule',
    'maxInProgress',
  ]
  return known.find((one) => one === field) ?? 'testCommand'
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// An error the panel's request rejects with, code included (a host error code reaches the panel).
function invalidParams(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'invalid_params' })
}
