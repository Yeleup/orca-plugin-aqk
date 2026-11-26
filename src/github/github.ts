// The GitHub layer of the worker (TZ «Интеграции»: GitHub через gh): issues, comments, labels and PRs of one project's
// repository, read and written through `gh` (gh.ts) with gh's own login.
//
// - Only the queue owner's texts. The owner is the GitHub user gh runs as (`gh api user`). Issues and comments of other
//   users are never returned — so they never reach an agent's task; an issue of another user looked up by its number
//   gives only its number and state. Not knowing the owner (that call failed) is an error, never «all users».
// - Every write runs the check before it (check.ts, mark.ts): texts come as GitHubText (segments) and service marks,
//   never as a ready body, so nothing reaches GitHub around the check. Each write answers with what it wrote and how
//   many parts the mask hid.
// - Labels the plugin writes are only its seven (labels.ts).
import type { Machine } from '../platform/machine'
import {
  checkContext,
  checkText,
  type CheckContext,
  type CheckedText,
  type DiffPaths,
  type GitHubText,
  type ProjectGitHubSettings,
} from './check'
import { GitHubError, ghArray, ghJson, ghList, isObject, repositoryPath, repositorySlug, runGh, type Repository } from './gh'
import { LABEL_LOOK, PLUGIN_LABELS, type PluginLabel } from './labels'
import { checkMark, composeBody, findByOperation, type Mark } from './mark'
import { CheckError } from './mask'

export type IssueState = 'open' | 'closed'

// An issue of the queue owner.
export type Issue = {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly state: IssueState
  // GitHub's reason for the state (`completed`, `not_planned`, `reopened`), or null.
  readonly stateReason: string | null
  readonly labels: readonly string[]
  readonly author: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly closedAt: string | null
  readonly url: string
}

// An issue looked up by its number: the owner's, or only the number and state of someone else's issue or of a pull
// request.
export type IssueLookup =
  | { readonly found: 'owner'; readonly issue: Issue }
  | { readonly found: 'other'; readonly number: number; readonly state: IssueState; readonly pullRequest: boolean }

// A comment of the queue owner.
export type Comment = {
  readonly id: number
  readonly issue: number
  readonly body: string
  readonly author: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly url: string
}

export type Label = { readonly name: string; readonly color: string; readonly description: string }

// A pull request: its state and branches, no texts.
export type PullRequest = {
  readonly number: number
  readonly state: IssueState
  readonly draft: boolean
  readonly merged: boolean
  readonly mergedAt: string | null
  readonly mergeCommitSha: string | null
  readonly base: string
  readonly head: string
  readonly headSha: string
  // `owner/name` of the head's repository; null when it was deleted.
  readonly headRepository: string | null
  readonly author: string
  readonly url: string
}

// What a write wrote, and how many parts of it the mask hid (with the rules that hid them).
export type Written<T> = { readonly result: T; readonly hidden: number; readonly rules: readonly string[] }

// The content of a comment or an issue body: an optional service mark and the text for a human. `diff` — the diff the
// paths in them come from.
export type BodyContent = {
  readonly mark?: Mark | null
  readonly text: GitHubText
  readonly diff?: DiffPaths | null
}

export type CheckedBody = { readonly body: string; readonly hidden: number; readonly rules: readonly string[] }

// The body GitHub would get for `content`, after the check — what every write of a body sends.
export function checkBody(content: BodyContent, settings: ProjectGitHubSettings): CheckedBody {
  const context = checkContext(settings, content.diff ?? null)
  return bodyOf(content, context)
}

function bodyOf(content: BodyContent, context: CheckContext): CheckedBody {
  const mark = content.mark ? checkMark(content.mark, context) : null
  const text = checkText(content.text, context)
  return {
    body: composeBody(mark?.mark ?? null, text.text),
    hidden: (mark?.hidden ?? 0) + text.hidden,
    rules: [...new Set([...(mark?.rules ?? []), ...text.rules])],
  }
}

export type GitHubOptions = {
  readonly machine: Machine
  readonly repository: Repository
  readonly settings: ProjectGitHubSettings
}

export type IssueFilter = {
  // `open` by default.
  readonly state?: IssueState | 'all'
  // Only issues with all of these labels.
  readonly labels?: readonly string[]
}

export type PullRequestFilter = {
  readonly state?: IssueState | 'all'
  // The head branch in this repository.
  readonly head?: string
  readonly base?: string
}

const BRANCH_FORM = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)(?!.*\/$)[A-Za-z0-9._/-]{1,255}$/

export class GitHub {
  readonly machine: Machine
  readonly repository: Repository
  readonly settings: ProjectGitHubSettings
  private ownerLogin: Promise<string> | null = null

  constructor(options: GitHubOptions) {
    this.machine = options.machine
    this.repository = options.repository
    this.settings = options.settings
  }

  // The login of the GitHub user gh runs as: the queue owner. Asked once; a failure is GitHubError `owner_unknown`
  // with gh's text, and the next call asks again.
  owner(): Promise<string> {
    this.ownerLogin ??= this.askOwner().catch((error: unknown) => {
      this.ownerLogin = null
      throw error
    })
    return this.ownerLogin
  }

  private async askOwner(): Promise<string> {
    const args = ['api', 'user']
    let answer: Record<string, unknown>
    try {
      answer = await ghJson({ machine: this.machine, args })
    } catch (error) {
      // gh not installed or not answering: that, as it is. gh answered, but not with the user: the owner is unknown.
      if (error instanceof GitHubError && (error.kind === 'gh_not_started' || error.kind === 'gh_timed_out')) throw error
      const said = error instanceof GitHubError ? error.ghText : String(error)
      throw new GitHubError('owner_unknown', args, {
        code: error instanceof GitHubError ? error.code : null,
        ghText: said,
        what: `the GitHub user gh runs as is unknown, so no texts can be told apart: ${said}`,
      })
    }
    const login = answer.login
    if (typeof login !== 'string' || login === '') {
      throw new GitHubError('owner_unknown', args, { ghText: JSON.stringify(answer), what: 'gh api user gave no login' })
    }
    return login
  }

  // ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────────

  // The owner's issues (not pull requests), oldest first, read whole.
  async listIssues(filter: IssueFilter = {}): Promise<Issue[]> {
    const owner = await this.owner()
    const query = [`state=${filter.state ?? 'open'}`, 'sort=created', 'direction=asc', 'per_page=100']
    if (filter.labels && filter.labels.length > 0) {
      query.push(`labels=${filter.labels.map((label) => encodeURIComponent(label)).join(',')}`)
    }
    const items = await this.list(`issues?${query.join('&')}`)
    return items.filter((item) => !('pull_request' in item) && isAuthor(item, owner)).map((item) => this.issueOf(item))
  }

  async getIssue(number: number): Promise<IssueLookup> {
    const owner = await this.owner()
    const item = await this.get(`issues/${positive(number)}`)
    const pullRequest = 'pull_request' in item && item.pull_request !== null && item.pull_request !== undefined
    if (pullRequest || !isAuthor(item, owner)) {
      return { found: 'other', number, state: this.shape(item, () => stateOf(item.state)), pullRequest }
    }
    return { found: 'owner', issue: this.issueOf(item) }
  }

  // The owner's comments of an issue, in their order, read whole.
  async listComments(issue: number): Promise<Comment[]> {
    const owner = await this.owner()
    const items = await this.list(`issues/${positive(issue)}/comments?per_page=100`)
    return items.filter((item) => isAuthor(item, owner)).map((item) => this.commentOf(item, issue))
  }

  async listLabels(): Promise<Label[]> {
    const items = await this.list('labels?per_page=100')
    return items.map((item) =>
      this.shape(item, () => ({
        name: text(item.name),
        color: text(item.color),
        description: typeof item.description === 'string' ? item.description : '',
      })),
    )
  }

  async listPullRequests(filter: PullRequestFilter = {}): Promise<PullRequest[]> {
    const query = [`state=${filter.state ?? 'open'}`, 'per_page=100']
    if (filter.head !== undefined) query.push(`head=${encodeURIComponent(`${this.repository.owner}:${branch(filter.head)}`)}`)
    if (filter.base !== undefined) query.push(`base=${encodeURIComponent(branch(filter.base))}`)
    const items = await this.list(`pulls?${query.join('&')}`)
    return items.map((item) => this.pullOf(item))
  }

  async getPullRequest(number: number): Promise<PullRequest> {
    return this.pullOf(await this.get(`pulls/${positive(number)}`))
  }

  // ── Writing (each through the check) ─────────────────────────────────────────────────────────────────────────────

  // Creates the plugin's labels the repository lacks; one that appeared meanwhile (gh failed because it exists) is
  // not a failure. Labels are compared without case, as GitHub does.
  async ensureLabels(): Promise<{ readonly created: PluginLabel[]; readonly present: PluginLabel[] }> {
    const known = new Set((await this.listLabels()).map((label) => label.name.toLowerCase()))
    const created: PluginLabel[] = []
    const present: PluginLabel[] = []
    for (const label of PLUGIN_LABELS) {
      if (known.has(label)) {
        present.push(label)
        continue
      }
      const look = LABEL_LOOK[label]
      try {
        await this.send('POST', 'labels', { name: label, color: look.color, description: look[this.settings.language] })
        created.push(label)
      } catch (error) {
        // Whether it exists now; a failed re-read leaves gh's own error of the creation.
        const now = await this.listLabels().catch(() => [])
        if (!now.some((one) => one.name.toLowerCase() === label)) throw error
        present.push(label)
      }
    }
    return { created, present }
  }

  // A comment on an issue (or PR).
  async comment(issue: number, content: BodyContent): Promise<Written<Comment>> {
    const checked = this.check(content)
    const answer = await this.send('POST', `issues/${positive(issue)}/comments`, { body: checked.body })
    return { result: this.commentOf(answer, issue), hidden: checked.hidden, rules: checked.rules }
  }

  // A comment that belongs to an operation (its mark has `operation`): written only when the owner's comments of the
  // issue have none with this operation and kind yet. A repeat after a lost GitHub answer finds the comment written
  // the first time and writes no second one (`existed: true`).
  async commentOnce(issue: number, content: BodyContent): Promise<Written<Comment> & { readonly existed: boolean }> {
    const checked = this.check(content)
    const mark = content.mark
    if (!mark?.operation) throw new CheckError('bad_field', 'commentOnce needs a mark with an operation id')
    const found = findByOperation(await this.listComments(issue), { operation: mark.operation, kind: mark.kind })
    if (found !== null) return { result: found, hidden: checked.hidden, rules: checked.rules, existed: true }
    const answer = await this.send('POST', `issues/${positive(issue)}/comments`, { body: checked.body })
    return { result: this.commentOf(answer, issue), hidden: checked.hidden, rules: checked.rules, existed: false }
  }

  // An issue with the plugin's labels.
  async createIssue(content: BodyContent & { readonly title: GitHubText; readonly labels?: readonly PluginLabel[] }): Promise<Written<Issue>> {
    const context = checkContext(this.settings, content.diff ?? null)
    const title = this.titleOf(content.title, context)
    const body = bodyOf(content, context)
    const labels = [...(content.labels ?? [])].map(pluginLabel)
    const answer = await this.send('POST', 'issues', { title: title.text, body: body.body, labels })
    return { result: this.issueOf(answer), ...sum(title, body) }
  }

  // Changes an issue: its title, its whole body (mark and text), its state.
  async updateIssue(
    number: number,
    change: {
      readonly title?: GitHubText
      readonly body?: BodyContent
      readonly state?: IssueState
      readonly stateReason?: 'completed' | 'not_planned' | 'reopened'
    },
  ): Promise<Written<Issue>> {
    const context = checkContext(this.settings, change.body?.diff ?? null)
    const title = change.title === undefined ? null : this.titleOf(change.title, context)
    const body = change.body === undefined ? null : bodyOf(change.body, context)
    const payload: Record<string, unknown> = {}
    if (title) payload.title = title.text
    if (body) payload.body = body.body
    if (change.state) payload.state = change.state
    if (change.stateReason) payload.state_reason = change.stateReason
    const answer = await this.send('PATCH', `issues/${positive(number)}`, payload)
    return { result: this.issueOf(answer), ...sum(title, body) }
  }

  // Adds plugin labels to an issue (one it already has stays); answers with the issue's labels after it.
  async addLabels(issue: number, labels: readonly PluginLabel[]): Promise<string[]> {
    const input = { labels: labels.map(pluginLabel) }
    const args = ['api', '--method', 'POST', repositoryPath(this.repository, `issues/${positive(issue)}/labels`), '--input', '-']
    const answer = await ghArray({ machine: this.machine, args, input })
    return this.shape({}, () => labelNames(answer))
  }

  // Removes a plugin label from an issue; a label that is not there (also after a lost answer) is not a failure.
  async removeLabel(issue: number, label: PluginLabel): Promise<void> {
    const name = pluginLabel(label)
    try {
      await this.run(['api', '--method', 'DELETE', repositoryPath(this.repository, `issues/${positive(issue)}/labels/${encodeURIComponent(name)}`)])
    } catch (error) {
      // Whether the issue still has it; a failed re-read leaves gh's own error of the removal.
      const item = await this.get(`issues/${issue}`).catch(() => null)
      const labels = item === null ? null : this.shape(item, () => labelNames(item.labels))
      if (labels === null || labels.some((one) => one.toLowerCase() === name)) throw error
    }
  }

  async createPullRequest(content: {
    readonly head: string
    readonly base: string
    readonly title: GitHubText
    readonly text: GitHubText
    readonly mark?: Mark | null
    readonly diff?: DiffPaths | null
    readonly draft: boolean
  }): Promise<Written<PullRequest>> {
    const context = checkContext(this.settings, content.diff ?? null)
    const title = this.titleOf(content.title, context)
    const body = bodyOf(content, context)
    const answer = await this.send('POST', 'pulls', {
      title: title.text,
      head: branch(content.head),
      base: branch(content.base),
      body: body.body,
      draft: content.draft,
    })
    return { result: this.pullOf(answer), ...sum(title, body) }
  }

  // Changes a PR: its title, its whole body, its base branch, its state (closed without a merge, or open again).
  async updatePullRequest(
    number: number,
    change: { readonly title?: GitHubText; readonly body?: BodyContent; readonly base?: string; readonly state?: IssueState },
  ): Promise<Written<PullRequest>> {
    const context = checkContext(this.settings, change.body?.diff ?? null)
    const title = change.title === undefined ? null : this.titleOf(change.title, context)
    const body = change.body === undefined ? null : bodyOf(change.body, context)
    const payload: Record<string, unknown> = {}
    if (title) payload.title = title.text
    if (body) payload.body = body.body
    if (change.base !== undefined) payload.base = branch(change.base)
    if (change.state) payload.state = change.state
    const answer = await this.send('PATCH', `pulls/${positive(number)}`, payload)
    return { result: this.pullOf(answer), ...sum(title, body) }
  }

  // A draft PR becomes ready for review, or (draft: true) a draft again: `gh pr ready` — GitHub's REST has no call.
  async setPullRequestDraft(number: number, draft: boolean): Promise<void> {
    const args = ['pr', 'ready', String(positive(number)), '--repo', repositorySlug(this.repository)]
    await this.run(draft ? [...args, '--undo'] : args)
  }

  // ── Inside ───────────────────────────────────────────────────────────────────────────────────────────────────────

  private check(content: BodyContent): CheckedBody {
    return checkBody(content, this.settings)
  }

  private titleOf(title: GitHubText, context: CheckContext): CheckedText {
    const checked = checkText(title, context)
    if (checked.text.trim() === '') throw new CheckError('empty', 'the title is empty; nothing was written')
    if (/[\r\n]/.test(checked.text)) throw new CheckError('bad_field', 'a title is one line; nothing was written')
    return checked
  }

  private run(args: readonly string[]) {
    return runGh({ machine: this.machine, args })
  }

  private get(rest: string): Promise<Record<string, unknown>> {
    return ghJson({ machine: this.machine, args: ['api', repositoryPath(this.repository, rest)] })
  }

  private list(rest: string): Promise<Record<string, unknown>[]> {
    return ghList({ machine: this.machine, args: ['api', '--paginate', repositoryPath(this.repository, rest)] })
  }

  private send(method: 'POST' | 'PATCH', rest: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const args = ['api', '--method', method, repositoryPath(this.repository, rest), '--input', '-']
    return ghJson({ machine: this.machine, args, input })
  }

  // Reads GitHub's answer into the plugin's shape; a field missing or of another type is GitHubError `bad_answer`.
  private shape<T>(item: Record<string, unknown>, read: () => T): T {
    try {
      return read()
    } catch (error) {
      throw new GitHubError('bad_answer', ['api', repositorySlug(this.repository)], {
        ghText: '',
        what: `gh answered JSON of another shape: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  private issueOf(item: Record<string, unknown>): Issue {
    return this.shape(item, () => ({
      number: integer(item.number),
      title: text(item.title),
      body: typeof item.body === 'string' ? item.body : '',
      state: stateOf(item.state),
      stateReason: typeof item.state_reason === 'string' ? item.state_reason : null,
      labels: labelNames(item.labels),
      author: login(item.user),
      createdAt: text(item.created_at),
      updatedAt: text(item.updated_at),
      closedAt: typeof item.closed_at === 'string' ? item.closed_at : null,
      url: text(item.html_url),
    }))
  }

  private commentOf(item: Record<string, unknown>, issue: number): Comment {
    return this.shape(item, () => ({
      id: integer(item.id),
      issue,
      body: typeof item.body === 'string' ? item.body : '',
      author: login(item.user),
      createdAt: text(item.created_at),
      updatedAt: text(item.updated_at),
      url: text(item.html_url),
    }))
  }

  private pullOf(item: Record<string, unknown>): PullRequest {
    return this.shape(item, () => {
      const base = item.base
      const head = item.head
      if (!isObject(base) || !isObject(head)) throw new Error('no base or head')
      const repo = head.repo
      const mergedAt = typeof item.merged_at === 'string' ? item.merged_at : null
      return {
        number: integer(item.number),
        state: stateOf(item.state),
        draft: item.draft === true,
        merged: item.merged === true || mergedAt !== null,
        mergedAt,
        mergeCommitSha: typeof item.merge_commit_sha === 'string' ? item.merge_commit_sha : null,
        base: text(base.ref),
        head: text(head.ref),
        headSha: text(head.sha),
        headRepository: isObject(repo) && typeof repo.full_name === 'string' ? repo.full_name : null,
        author: login(item.user),
        url: text(item.html_url),
      }
    })
  }
}

function sum(...parts: ({ readonly hidden: number; readonly rules: readonly string[] } | null)[]) {
  const present = parts.filter((part) => part !== null)
  return {
    hidden: present.reduce((total, part) => total + part.hidden, 0),
    rules: [...new Set(present.flatMap((part) => part.rules))],
  }
}

function isAuthor(item: Record<string, unknown>, owner: string): boolean {
  const user = item.user
  return isObject(user) && typeof user.login === 'string' && user.login.toLowerCase() === owner.toLowerCase()
}

function positive(number: number): number {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`not an issue or PR number: ${number}`)
  return number
}

function branch(name: string): string {
  if (!BRANCH_FORM.test(name)) throw new CheckError('bad_field', 'a branch name is not of the form of a git branch')
  return name
}

function pluginLabel(label: string): PluginLabel {
  if (!(PLUGIN_LABELS as readonly string[]).includes(label)) {
    throw new CheckError('bad_field', 'only the plugin labels are written')
  }
  return label as PluginLabel
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error(`expected text, got ${JSON.stringify(value)}`)
  return value
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`expected an integer, got ${JSON.stringify(value)}`)
  return value
}

function stateOf(value: unknown): IssueState {
  if (value !== 'open' && value !== 'closed') throw new Error(`expected open or closed, got ${JSON.stringify(value)}`)
  return value
}

function login(user: unknown): string {
  if (!isObject(user) || typeof user.login !== 'string') throw new Error('no user login')
  return user.login
}

function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) throw new Error('labels is not a list')
  return labels.map((label) => (typeof label === 'string' ? label : text(isObject(label) ? label.name : undefined)))
}

