// Connecting a project of this computer to the queue (Ф1, points 1–4, without the path through a PR): the worker's side
// of the wizard «Подключение проекта». The panel asks for the projects, runs the checks of step 2 one by one and sends
// the form of step 3; «Подключить» lands here. A project of another host is refused (`invalid_params`) before any
// process runs (./projects.ts).
//
// «Подключить» checks everything again before it writes anything, and writes nothing when one check fails, naming why:
// the project (not on agent-queue-kit, no other connection of it running in this worker); git and its GitHub
// repository, fetched from and pushed to alike; gh with its login and write access; the agents Orca knows, read again —
// a list that cannot be read is a refusal, while an agent of a role missing from the list read (an empty one included)
// is an error at that role's field, sent back with the list; the fields of the form, the mask of the plugin over every
// text the owner typed (data that never goes to GitHub is an error at its field, its text never quoted); then a fetch
// of the base branch itself, and the main checkout must be on that branch, without changes, its HEAD equal to the
// commit this fetch brought (neither behind nor ahead, nor apart); the project must not be connected already (another
// panel may have connected it meanwhile); and each of the four files must take the change: a path the source commit
// lacks has nothing in the working tree (an ignored file, a file made meanwhile) and is not ignored by git, a path it
// has holds its content there, `git add` would not change the new content (attributes, filters), the source content is
// text the plugin can keep byte for byte, the plugin's markers come in pairs, and the entry rule's block passes the
// mask. Then, in this order:
//
// 1. the intent in the journal of operations (./journal.ts): the operation's id (a new UUID), the source commit, the
//    four paths and the hash (git blob id) of the expected content of each;
// 2. the plugin's labels GitHub lacks (src/github/: the check before every write and the mask; a repeat creates only
//    the missing ones);
// 3. the checkout checked again — HEAD, branch, no changes, each of the four paths as the checks saw it — then
//    .agent-queue.json (the settings of the form), .agent-queue.md (the rules for tasks of the form) and the block of
//    the entry rule between the plugin's markers in CLAUDE.md and AGENTS.md (src/project/entry-rule.ts): a new path is
//    created and never replaces anything, an existing one is replaced only while it holds the source content;
// 4. a commit of only these four files, its message exactly the title and `Agent-Queue-Operation: <id>`, and its check
//    against the intent before anything leaves the computer: its parent is the source commit, it changes exactly the
//    four paths, each to the blob the journal names, and its message is that one;
// 5. a push of that very commit to the base branch. `origin` or git refused it — the local commit is undone, the
//    checkout is on the source commit again, `pushRejected` with git's reason; a repeated «Подключить» is a new
//    operation. No certain answer (a timeout, a connection lost) — the commit stays: it may be on origin already; the
//    interrupted connection (task `connect-recovery`) tells its state from the journal and git.
//
// No hook of the project's git runs for any of it (./checkout.ts). A failure after the intent undoes only the
// operation's own changes: a written path goes back only while it holds what the operation wrote, the commit is undone
// only while HEAD is that commit on the base branch; what changed meanwhile stays and is named. Each step is recorded
// in the journal. Connected: open panels hear `projects.changed`.
//
// The panel's request lasts at most two minutes, while a connection can take longer (GitHub and the network may be
// slow). «Подключить» therefore answers within CONNECT_ANSWER_MS: the result when the connection ended by then, or
// `running` — and `connect.wait` waits for the end of the same connection again the same way. The connection itself
// goes on regardless of the panel.
import { randomUUID } from 'node:crypto'
import type { HostApi } from 'orca/host'
import { githubText } from '../github-texts/catalog'
import { compileMask } from '../github/mask'
import type { Repository } from '../github/gh'
import { GitHub } from '../github/github'
import { errorMessage, type Machine } from '../platform/machine'
import type { OrcaAgent } from '../platform/orca-agents'
import { dataPath } from '../platform/paths'
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
import {
  CONNECT_ANSWER_MS,
  type AgentsCheck,
  type ConnectCandidate,
  type ConnectFailure,
  type ConnectField,
  type ConnectForm,
  type ConnectRefusal,
  type ConnectResult,
  type ConnectTarget,
  type FieldError,
  type GhCheck,
  type GitCheck,
} from '../protocol'
import { checkAgents, checkGh, checkGit, originRepository, originUrls, repositoryName, type OriginUrls } from './checks'
import { Checkout, type OperationFile } from './checkout'
import { OperationJournal, type JournalStep } from './journal'
import { connectCandidates, connectedProjects, findProject, isConnected, kitOf, type OrcaProject } from './projects'

type Host = Pick<HostApi<'worker'>, 'call'>

// The four paths the connection writes, in the order of the commit.
export const CONNECT_PATHS = [SETTINGS_FILE, TASK_RULES_FILE, ...ENTRY_RULE_FILES] as const

// The trailer of the connection commit that carries the operation's id.
export const OPERATION_TRAILER = 'Agent-Queue-Operation'

// The directory every git process of the connection takes as its `core.hooksPath`: the plugin never creates it, so no
// hook is there.
export const NO_HOOKS_DIR = 'no-git-hooks'

// A wait the worker can stop: the panel's answer window. Tests give their own time.
export type AnswerTimer = (ms: number) => { readonly elapsed: Promise<void>; cancel(): void }

export const realTimer: AnswerTimer = (ms) => {
  let handle: ReturnType<typeof setTimeout> | undefined
  const elapsed = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms)
  })
  return { elapsed, cancel: () => clearTimeout(handle) }
}

export type ConnectorOptions = {
  readonly host: Host
  readonly machine: Machine
  readonly dataDir: string
  readonly log: (message: string) => void
  // Tells open panels the connected projects changed (`projects.changed`).
  readonly post: (projects: Awaited<ReturnType<typeof connectedProjects>>) => void
  // The answer window of «Подключить» and `connect.wait`; real time by default.
  readonly timer?: AnswerTimer
}

// An attempt of «Подключить»: under way (`result` null) or ended, its answer not taken yet; `project` — the project's
// key.
type Attempt = { readonly done: Promise<ConnectResult>; result: ConnectResult | null; readonly project: string }

export class Connector {
  // The attempts by their id (a UUID given before anything is written): running, or ended and not answered yet. A wait
  // gets the answer of its own attempt only.
  private readonly attempts = new Map<string, Attempt>()
  private readonly timer: AnswerTimer
  private readonly hooksOff: string

  constructor(private readonly options: ConnectorOptions) {
    this.timer = options.timer ?? realTimer
    this.hooksOff = dataPath(options.machine, options.dataDir, NO_HOOKS_DIR)
  }

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
    if ([...this.attempts.values()].some((one) => one.project === key && one.result === null)) {
      return { status: 'refused', refusal: { reason: 'busy' } }
    }
    const id = randomUUID()
    const state: { result: ConnectResult | null } = { result: null }
    const done = this.run(project, form).then((result) => {
      state.result = result
      return result
    })
    const attempt: Attempt = Object.assign(state, { done, project: key })
    this.attempts.set(id, attempt)
    return this.answer(id, attempt)
  }

  // The end of the attempt the request names, within the answer window; `lost` when this worker knows no such attempt
  // of the project.
  async wait(input: unknown): Promise<ConnectResult> {
    const project = await this.project(input, 'connect.wait')
    const id = isObject(input) ? input.attempt : undefined
    if (typeof id !== 'string' || id === '') throw invalidParams('connect.wait: no attempt')
    const attempt = this.attempts.get(id)
    if (attempt === undefined || attempt.project !== JSON.stringify([project.id, project.hostId])) {
      return { status: 'failed', failure: { step: 'lost' }, operation: null }
    }
    return this.answer(id, attempt)
  }

  private async answer(id: string, attempt: Attempt): Promise<ConnectResult> {
    const window = this.timer(CONNECT_ANSWER_MS)
    const result = await Promise.race([attempt.done, window.elapsed.then(() => null)])
    window.cancel()
    if (result === null) return { status: 'running', attempt: id }
    this.attempts.delete(id)
    return result
  }

  private async run(project: OrcaProject, form: ConnectForm): Promise<ConnectResult> {
    try {
      return await this.connectProject(project, form)
    } catch (error) {
      return { status: 'failed', failure: { step: 'unexpected', detail: errorMessage(error) }, operation: null }
    }
  }

  private async connectProject(project: OrcaProject, form: ConnectForm): Promise<ConnectResult> {
    const { machine } = this.options
    const refused = (refusal: ConnectRefusal): ConnectResult => ({ status: 'refused', refusal })
    const kit = kitOf(machine, project)
    if (kit === 'yes') return refused({ reason: 'kit' })
    if (kit === 'unknown') return refused({ reason: 'kit-unknown' })

    // Everything the wizard checked, again.
    const git = await checkGit(machine, project.path)
    if (git.check.status !== 'ok' || git.repository === null || git.urls === null) return refused({ reason: 'git', check: git.check })
    const repository = git.repository
    const urls = git.urls
    const gh = await checkGh(machine, repository)
    if (gh.status !== 'ok') return refused({ reason: 'gh', check: gh })
    const agents = await checkAgents(machine)
    if (agents.agents === null) {
      if (agents.check.status === 'unchecked') return refused({ reason: 'agents', failure: agents.check.failure })
      throw new Error('the agents of Orca are neither read nor unread')
    }
    const fields = settingsOf(form, agents.agents)
    if (!fields.ok) {
      const agentError = fields.errors.some((error) => error.field.startsWith('agents.'))
      return { status: 'fields', errors: fields.errors, agents: agentError ? agents.check : null }
    }

    // The base branch, as origin has it now, and the checkout against it.
    const checkout = new Checkout(machine, project.path, this.hooksOff)
    const fetched = await checkout.fetchBase(urls.fetch, form.baseBranch)
    if ('error' in fetched) {
      if (fetched.missing) return { status: 'fields', errors: [{ field: 'baseBranch', code: 'no-branch', detail: form.baseBranch }], agents: null }
      return refused({ reason: 'fetch', error: fetched.error })
    }
    const { refusal, head: source } = await checkout.readiness(form.baseBranch, fetched.commit)
    if (refusal !== null) return refused(refusal)
    if (await isConnected(machine, project)) return refused({ reason: 'connected' })

    // The four files: their content from the source commit and the form, and whether each can take it.
    const block = entryRuleBlock(form.language, repositoryName(repository))
    const blockRules = maskRules(block)
    if (blockRules !== null) return refused({ reason: 'file', file: ENTRY_RULE_FILES[0], problem: 'masked', detail: blockRules })
    const files: OperationFile[] = []
    for (const path of CONNECT_PATHS) {
      const at = await checkout.fileAt(source, path)
      if ('problem' in at) return refused({ reason: 'file', file: path, problem: at.problem, detail: '' })
      if (path === SETTINGS_FILE && at.file !== null) return refused({ reason: 'connected' })
      let text: string
      if (path === SETTINGS_FILE) text = formatProjectSettings(fields.settings)
      else if (path === TASK_RULES_FILE) text = fields.taskRules
      else {
        const placed = placeEntryRule(at.file?.text ?? null, block)
        if (!placed.ok) return refused({ reason: 'file', file: path, problem: 'unpaired', detail: placed.problem })
        text = placed.text
      }
      const blob = await checkout.blobId(text)
      if ((await checkout.addedBlobId(path, text)) !== blob) return refused({ reason: 'file', file: path, problem: 'transformed', detail: '' })
      files.push({ path, text, blob, source: at.file })
    }
    for (const file of files) {
      if (file.source === null) {
        if (checkout.worktree(file.path).kind !== 'none') return refused({ reason: 'file', file: file.path, problem: 'present', detail: '' })
        if (await checkout.isIgnored(file.path)) return refused({ reason: 'file', file: file.path, problem: 'ignored', detail: '' })
      } else if ((await checkout.snapshot(file.path, file.source.blob)) === null) {
        return refused({ reason: 'file', file: file.path, problem: 'differs', detail: '' })
      }
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
        paths: files.map((file) => ({ path: file.path, sourceBlob: file.source?.blob ?? null, expectedBlob: file.blob })),
      })
    } catch (error) {
      return refused({ reason: 'journal', error: errorMessage(error) })
    }
    const step = async (name: JournalStep, data: Record<string, unknown>) => {
      try {
        await journal.record(name, data)
      } catch (error) {
        this.options.log(`agent-queue: connect ${operation}: the journal did not take ${name}: ${errorMessage(error)}`)
      }
    }
    const failed = async (failure: ConnectFailure): Promise<ConnectResult> => {
      await step('failed', { failure })
      return { status: 'failed', failure, operation }
    }
    try {
      return await this.write({ project, form, repository, urls, checkout, source, files, operation, step, failed })
    } catch (error) {
      // git itself failed where no answer was expected: the state is left for the interrupted connection to tell.
      return failed({ step: 'unexpected', detail: errorMessage(error) })
    }
  }

  // Steps 2–5, once the intent is in the journal.
  private async write(op: {
    readonly project: OrcaProject
    readonly form: ConnectForm
    readonly repository: Repository
    readonly urls: OriginUrls
    readonly checkout: Checkout
    readonly source: string
    readonly files: readonly OperationFile[]
    readonly operation: string
    readonly step: (name: JournalStep, data: Record<string, unknown>) => Promise<void>
    readonly failed: (failure: ConnectFailure) => Promise<ConnectResult>
  }): Promise<ConnectResult> {
    const { machine } = this.options
    const { project, form, repository, urls, checkout, source, files, operation, step, failed } = op
    const base = form.baseBranch

    // 2. The labels.
    const github = new GitHub({ machine, repository, settings: { language: form.language, forbiddenPatterns: [] } })
    try {
      const labels = await github.ensureLabels()
      await step('labels', { created: labels.created, present: labels.present })
    } catch (error) {
      return failed({ step: 'labels', detail: errorMessage(error) })
    }

    // 3. The checkout as the checks saw it, then the files — never over what is not the source commit's.
    const change = await checkout.changeSince(source, base, files)
    if (change !== null) return failed({ step: 'changed', change })
    const written: OperationFile[] = []
    const putBack = async (failure: (left: string[]) => ConnectFailure): Promise<ConnectResult> => {
      const left = await checkout.restore(written, false)
      await step('undo', { restored: written.map((file) => file.path).filter((path) => !left.includes(path)), left })
      return failed(failure(left))
    }
    for (const file of files) {
      let wrote: boolean
      try {
        wrote = await checkout.writeFile(file)
      } catch (error) {
        return putBack((left) => ({ step: 'files', reason: 'error', file: file.path, detail: errorMessage(error), left }))
      }
      if (!wrote) return putBack((left) => ({ step: 'files', reason: 'changed', file: file.path, detail: null, left }))
      written.push(file)
    }
    await step('files', { written: files.map((file) => file.path) })

    // 4. The operation's commit, its check against the intent, and the base branch moved to it from the source commit
    //    only; then its index entries.
    const title = githubText(form.language, 'connect.commitTitle')
    const trailer = `${OPERATION_TRAILER}: ${operation}`
    let commit: string
    try {
      commit = await checkout.commitOf(source, files, [title, trailer])
    } catch (error) {
      return putBack((left) => ({ step: 'commit', reason: 'error', detail: errorMessage(error), left }))
    }
    const mismatch = await checkout.verify(commit, source, files, `${title}\n\n${trailer}\n`)
    if (mismatch !== null) {
      await step('commit', { commit, verified: false })
      return putBack((left) => ({ step: 'verify', what: mismatch.what, file: mismatch.file, left }))
    }
    const moved = await checkout.moveRef(`refs/heads/${base}`, commit, source, `Agent Queue: connect the project (${operation})`)
    if (moved !== null) {
      await step('commit', { commit, onBranch: false, error: moved.detail })
      return putBack((left) => ({ step: 'commit', reason: moved.reason, detail: moved.reason === 'error' ? moved.detail : null, left }))
    }
    await step('commit', { commit })
    // The index is HEAD's: it gets the four entries only while HEAD is still on the base branch.
    if ((await checkout.state()).branch !== base) {
      const back = await checkout.moveRef(`refs/heads/${base}`, source, commit, 'Agent Queue: the connection commit undone')
      await step('undo', back === null ? { head: source } : { error: back.detail })
      if (back !== null) return failed({ step: 'undo', push: null, reason: back.reason, detail: back.reason === 'error' ? back.detail : null })
      return putBack(() => ({ step: 'changed', change: { kind: 'branch' } }))
    }
    await checkout.stage(files)

    // 5. The push of that commit, to the address confirmed again now.
    const now = await originUrls(machine, project.path, repository)
    if (now === null || now === 'elsewhere' || now.push !== urls.push) {
      await step('push', { outcome: 'not-sent', error: 'the push address of origin changed after the checks' })
      const undone = await checkout.undoCommit(commit, source, base, files)
      await step('undo', 'refusal' in undone ? { error: undone.refusal.detail } : { head: source, left: undone.left })
      if ('refusal' in undone) {
        const { reason, detail } = undone.refusal
        return failed({ step: 'undo', push: null, reason, detail: reason === 'error' ? detail : null })
      }
      return failed({ step: 'push-address', left: undone.left })
    }
    const pushed = await checkout.push(urls.push, commit, base, source)
    if (pushed.outcome === 'unknown') {
      await step('push', { outcome: 'unknown', error: pushed.error })
      return failed({ step: 'push-unknown', detail: pushed.error })
    }
    if (pushed.outcome !== 'pushed') {
      await step('push', { outcome: pushed.outcome, error: pushed.error })
      const undone = await checkout.undoCommit(commit, source, base, files)
      await step('undo', 'refusal' in undone ? { error: undone.refusal.detail } : { head: source, left: undone.left })
      if ('refusal' in undone) {
        const { reason, detail } = undone.refusal
        return failed({ step: 'undo', push: pushed.error, reason, detail: reason === 'error' ? detail : null })
      }
      return { status: 'pushRejected', error: pushed.error, operation }
    }
    await step('push', { outcome: 'pushed' })
    await checkout.trackPushed(base, commit)
    this.options.log(`agent-queue: connected ${project.name} (operation ${operation}, commit ${commit})`)
    try {
      this.options.post(await this.connected())
    } catch (error) {
      this.options.log(`agent-queue: the connected projects could not be read after connecting: ${errorMessage(error)}`)
    }
    return { status: 'connected', project: { id: project.id, hostId: project.hostId, name: project.name }, operation, commit }
  }

  // The Orca project of the request, on this computer; anything else — a project of another host too — is refused with
  // `invalid_params`, before any process runs.
  private async project(input: unknown, request: string): Promise<OrcaProject> {
    const { projectId, hostId } = (isObject(input) ? input : {}) as Partial<ConnectTarget>
    if (typeof projectId !== 'string' || projectId === '') throw invalidParams(`${request}: no projectId`)
    if (typeof hostId !== 'string' || hostId === '') throw invalidParams(`${request}: no hostId`)
    const project = await findProject(this.options.host, projectId, hostId)
    if (project === null) throw invalidParams(`${request}: Orca has no git project ${projectId} on ${hostId} of this computer`)
    return project
  }
}

// The rules of the mask of the plugin (src/github/mask.ts, the built-in ones: the form sets no patterns of its own) that
// find something in `text`, or null when none does. The text itself is never given.
function maskRules(text: string): string | null {
  const found = compileMask([]).find(text)
  return found.length === 0 ? null : [...new Set(found.flatMap((match) => match.rules))].join(', ')
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

// The fields of the form the mask looks at: every text the owner typed that goes into the commit.
const MASKED_FIELDS = ['baseBranch', 'testCommand', 'testCommandWindows', 'dataRule', 'taskRules', 'directories'] as const

// The settings the form describes, with every field the owner must fix: required texts, one-line commands, agents of
// `agents` (what Orca knows now; an empty list leaves every role wrong), a whole number from 1, a branch name, the mask
// over the texts — then the check of .agent-queue.json itself on the text the wizard would commit, its problems at
// their fields.
export function settingsOf(form: ConnectForm, agents: readonly OrcaAgent[]): SettingsOfForm {
  const errors: FieldError[] = []
  const error = (field: ConnectField, code: FieldError['code'], detail: string) => {
    if (!errors.some((one) => one.field === field)) errors.push({ field, code, detail })
  }
  for (const field of MASKED_FIELDS) {
    const rules = maskRules(form[field])
    if (rules !== null) error(field, 'masked', rules)
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
    else if (!agents.some((agent) => agent.id === id)) error(`agents.${role}`, 'agent', id)
    else {
      // An agent's id is any text Orca gives: it goes into .agent-queue.json, so the mask looks at it too.
      const rules = maskRules(id)
      if (rules !== null) error(`agents.${role}`, 'masked', rules)
      else chosen[role] = id
    }
  }
  for (const directory of directoriesOf(form.directories)) {
    if (/^([\\/]|[A-Za-z]:)/.test(directory) || directory.split(/[\\/]/).includes('..')) {
      error('directories', 'directory', directory)
    }
  }
  const notBranch = branchNameProblem(form.baseBranch)
  if (notBranch !== null) error('baseBranch', 'branch-name', notBranch)
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
      directories: directoriesOf(form.directories),
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

// The dependency directories of the form: separated by commas or lines, blanks around them dropped.
function directoriesOf(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((directory) => directory.trim())
    .filter((directory) => directory !== '')
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
