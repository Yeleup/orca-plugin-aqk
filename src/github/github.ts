// The GitHub layer of the worker (TZ «Интеграции»: GitHub через gh): issues, comments, labels and PRs of one project's
// repository, read and written through `gh` (gh.ts) with gh's own login. Every call names the host and the repository.
//
// - Only the queue owner's texts. The owner is the GitHub user gh runs as (GraphQL `viewer`), asked in the very call
//   that reads the texts — so a switch of gh's account (`gh auth switch`) counts from the next read on, and an account
//   that changes within one paginated read is an error. A text counts only when the owner wrote it and nobody else
//   changed it: its author is the owner, its last editor (if it was edited) is the owner, every entry of its edit
//   history is the owner's (read whole, page by page, and no shorter than GitHub counted with the text), and an
//   issue's title was renamed only by the owner. A text with
//   an edit by someone else, or by an editor GitHub no longer knows (a deleted account), does not count. Issues and
//   comments that do not count are never returned — so they never reach an agent's task; such an issue looked up by its
//   number gives only its number, state and why. Not knowing the owner is an error, never «all users».
// - Every write runs the check before it (check.ts, mark.ts) at this boundary: the project's patterns are compiled
//   first (an invalid one refuses every write, labels included), texts come as GitHubText (segments) and service
//   marks, never as a ready body, and every other field is checked by its form. Each write answers with what it wrote
//   and how many parts the mask hid.
// - Labels the plugin writes are only its seven (labels.ts); PRs only from the task's branch `agent-queue/issue-<N>`.
import type { Machine } from '../platform/machine'
import {
  checkContext,
  checkText,
  hasFixedForm,
  maskText,
  type CheckContext,
  type CheckedText,
  type DiffPaths,
  type GitHubText,
  type ProjectGitHubSettings,
} from './check'
import {
  GitHubError,
  apiArgs,
  ghArray,
  ghJson,
  ghList,
  ghPages,
  isObject,
  repositoryPath,
  repositoryRef,
  repositoryRoot,
  repositorySlug,
  runGh,
  type Repository,
} from './gh'
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
  // GitHub's reason for the state (`completed`, `not_planned`, `reopened`, `duplicate`), or null.
  readonly stateReason: string | null
  readonly labels: readonly string[]
  readonly author: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly closedAt: string | null
  readonly url: string
}

// What a change of an issue gives back: its state, never its texts (they may have changed since they were checked).
export type IssueChange = {
  readonly number: number
  readonly state: IssueState
  readonly stateReason: string | null
  readonly labels: readonly string[]
  readonly updatedAt: string
  readonly closedAt: string | null
  readonly url: string
}

// Why a text is not the owner's: someone else wrote it, or someone else (or an unknown editor) changed it.
export type NotOwner = 'author' | 'edited'

// An issue looked up by its number: the owner's, or only the number and state of an issue that is not the owner's
// text, or of a pull request.
export type IssueLookup =
  | { readonly found: 'owner'; readonly issue: Issue }
  | {
      readonly found: 'other'
      readonly number: number
      readonly state: IssueState
      readonly reason: NotOwner | 'pull-request'
    }

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

// The branch of a task's PR (TZ «Данные», «PR задачи»).
export function taskBranch(issue: number): string {
  return `agent-queue/issue-${positive(issue)}`
}

// A branch name by the rules of `git check-ref-format --branch`: no blanks, control characters, ~ ^ : ? * [ \, no
// `..`, `@{` or `//`, no part that starts with `.` or ends with `.lock`, not `@`, not starting with `-` or `/`, not
// ending with `/` or `.`.
export function isBranchName(name: string): boolean {
  if (typeof name !== 'string' || name === '' || name === '@' || name.length > 255) return false
  if (/^[-/]|[/.]$|\.\.|\/\/|@\{|[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false
  return name.split('/').every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'))
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

// ── GraphQL reads ───────────────────────────────────────────────────────────────────────────────────────────────────
// `viewer` is in every query: the owner is the user of the very call that reads the texts. The connection a read pages
// through has its `pageInfo` before its nodes (gh --paginate follows the first pageInfo it meets), and every page must
// say how it goes on: a cursor and `hasNextPage: true` on all but the last, `hasNextPage: false` on the last. Nested
// lists come with `totalCount`: an edit or rename history longer than the first 100 is read on by its own query
// (AqEdits, AqRenames) of that issue or comment — which names the repository and is checked to belong to it.

const EDIT_NODES = 'nodes { editor { login } deletedBy { login } }'
const RENAME_NODES = 'nodes { ... on RenamedTitleEvent { actor { login } } }'
const EDITS = `id author { login } editor { login } lastEditedAt userContentEdits(first: 100) { totalCount ${EDIT_NODES} }`
const ISSUE_FIELDS =
  `number title body state stateReason createdAt updatedAt closedAt url ${EDITS} ` +
  'labels(first: 100) { totalCount nodes { name } } ' +
  `timelineItems(itemTypes: [RENAMED_TITLE_EVENT], first: 100) { totalCount ${RENAME_NODES} }`
// A comment's REST id is read from its URL (…#issuecomment-<id>): GraphQL's `databaseId` is a 32-bit Int, which ids of
// comments outgrow.
const COMMENT_FIELDS = `body createdAt updatedAt url ${EDITS}`

export const Q_VIEWER =
  'query AqViewer($owner: String!, $name: String!) { viewer { login } repository(owner: $owner, name: $name) { nameWithOwner } }'
export const Q_ISSUES =
  'query AqIssues($owner: String!, $name: String!, $states: [IssueState!], $labels: [String!], $endCursor: String) ' +
  '{ viewer { login } repository(owner: $owner, name: $name) { issues(first: 100, after: $endCursor, states: $states, ' +
  'labels: $labels, orderBy: {field: CREATED_AT, direction: ASC}) { pageInfo { hasNextPage endCursor } ' +
  `nodes { ${ISSUE_FIELDS} } } } }`
export const Q_ISSUE =
  'query AqIssue($owner: String!, $name: String!, $number: Int!) { viewer { login } repository(owner: $owner, name: $name) ' +
  `{ issueOrPullRequest(number: $number) { __typename ... on Issue { ${ISSUE_FIELDS} } ... on PullRequest { number state } } } }`
// The comments of an issue or of a pull request (GitHub keeps both as IssueComment).
const COMMENTS = `comments(first: 100, after: $endCursor) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT_FIELDS} } }`
export const Q_COMMENTS =
  'query AqComments($owner: String!, $name: String!, $number: Int!, $endCursor: String) { viewer { login } ' +
  'repository(owner: $owner, name: $name) { issueOrPullRequest(number: $number) { __typename ' +
  `... on Issue { ${COMMENTS} } ... on PullRequest { ${COMMENTS} } } } }`
const PAGED_EDITS = `userContentEdits(first: 100, after: $endCursor) { pageInfo { hasNextPage endCursor } ${EDIT_NODES} }`
export const Q_EDITS =
  'query AqEdits($owner: String!, $name: String!, $id: ID!, $endCursor: String) { viewer { login } ' +
  'repository(owner: $owner, name: $name) { nameWithOwner } node(id: $id) { __typename ' +
  `... on Issue { repository { nameWithOwner } ${PAGED_EDITS} } ... on IssueComment { repository { nameWithOwner } ${PAGED_EDITS} } } }`
export const Q_RENAMES =
  'query AqRenames($owner: String!, $name: String!, $id: ID!, $endCursor: String) { viewer { login } ' +
  'repository(owner: $owner, name: $name) { nameWithOwner } node(id: $id) { __typename ... on Issue { repository { nameWithOwner } ' +
  `timelineItems(itemTypes: [RENAMED_TITLE_EVENT], first: 100, after: $endCursor) { pageInfo { hasNextPage endCursor } ${RENAME_NODES} } } } }`

type Variables = Record<string, string | number | readonly string[]>

// A GraphQL read: the user gh ran as, the `data` of every page (each with its `repository`), the arguments.
type Read = { readonly owner: string; readonly pages: Record<string, unknown>[]; readonly args: readonly string[] }

// A comment written by the owner and whether its text is still the owner's alone.
type OwnComment = { readonly comment: Comment; readonly origin: 'owner' | NotOwner }

export class GitHub {
  readonly machine: Machine
  readonly repository: Repository
  readonly settings: ProjectGitHubSettings

  constructor(options: GitHubOptions) {
    this.machine = options.machine
    this.repository = options.repository
    this.settings = options.settings
  }

  // The login of the GitHub user gh runs as now — the queue owner — asked together with the repository. Not kept:
  // every read of texts asks again in its own call. A failure is GitHubError `owner_unknown` with gh's text (gh not
  // installed or not answering keep their own kind).
  async owner(): Promise<string> {
    try {
      return (await this.read(Q_VIEWER, {}, false)).owner
    } catch (error) {
      if (!(error instanceof GitHubError) || error.kind === 'gh_not_started' || error.kind === 'gh_timed_out') throw error
      if (error.kind === 'owner_unknown') throw error
      throw new GitHubError('owner_unknown', error.args, {
        code: error.code,
        ghText: error.ghText,
        what: `the GitHub user gh runs as is unknown, so no texts can be told apart: ${error.ghText || error.message}`,
        refusal: error.refusal,
      })
    }
  }

  // ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────────

  // The owner's issues (not pull requests), oldest first, read whole.
  async listIssues(filter: IssueFilter = {}): Promise<Issue[]> {
    const state = oneOf(filter.state ?? 'open', ['open', 'closed', 'all'] as const, 'state')
    const labels = [...(filter.labels ?? [])]
    const variables: Record<string, readonly string[]> = {}
    if (state !== 'all') variables.states = [state.toUpperCase()]
    if (labels.length > 0) variables.labels = labels
    const read = await this.read(Q_ISSUES, variables, true)
    const issues: Issue[] = []
    for (const node of this.pagedNodes(read, (data) => field(data.repository, 'issues'))) {
      if ((await this.originOf(node, read, true)) !== 'owner') continue
      const issue = this.issueFromNode(node, read.args)
      // GitHub's label filter takes any of the labels: only issues with all of them are kept.
      if (labels.every((label) => issue.labels.some((one) => one.toLowerCase() === label.toLowerCase()))) {
        issues.push(issue)
      }
    }
    return issues
  }

  async getIssue(number: number): Promise<IssueLookup> {
    const read = await this.read(Q_ISSUE, { number: positive(number) }, false)
    const node = field(read.pages[0]?.repository, 'issueOrPullRequest')
    if (!isObject(node)) throw shapeError(read.args, `no issue or pull request #${number}`)
    const state = this.shape(read.args, () => graphState(node.state))
    if (node.__typename === 'PullRequest') return { found: 'other', number, state, reason: 'pull-request' }
    const origin = await this.originOf(node, read, true)
    if (origin !== 'owner') return { found: 'other', number, state, reason: origin }
    return { found: 'owner', issue: this.issueFromNode(node, read.args) }
  }

  // The owner's comments of an issue or a pull request, in their order, read whole.
  async listComments(issue: number): Promise<Comment[]> {
    return (await this.ownComments(issue)).filter((one) => one.origin === 'owner').map((one) => one.comment)
  }

  // The comments the owner wrote, each with whether its text is still the owner's alone.
  private async ownComments(issue: number): Promise<OwnComment[]> {
    const read = await this.read(Q_COMMENTS, { number: positive(issue) }, true)
    const comments: OwnComment[] = []
    const nodes = this.pagedNodes(read, (data) => field(field(data.repository, 'issueOrPullRequest'), 'comments'))
    for (const node of nodes) {
      const origin = await this.originOf(node, read, false)
      if (origin !== 'author') comments.push({ comment: this.commentFromNode(node, issue, read.args), origin })
    }
    return comments
  }

  async listLabels(): Promise<Label[]> {
    const args = [...apiArgs(this.repository), '--paginate', repositoryPath(this.repository, 'labels?per_page=100')]
    const items = await ghList({ machine: this.machine, args })
    return items.map((item) =>
      this.shape(args, () => ({
        name: text(item.name),
        color: text(item.color),
        description: typeof item.description === 'string' ? item.description : '',
      })),
    )
  }

  // What the GitHub user gh runs as may do in the repository, and the repository's default branch now: GitHub's
  // `permissions` of the repository for that user — write is `push`, `maintain` or `admin` — and its `default_branch`.
  // A repository gh cannot see (404) or a failure of gh is a GitHubError.
  async access(): Promise<{ readonly write: boolean; readonly defaultBranch: string | null }> {
    const args = [...apiArgs(this.repository), repositoryRoot(this.repository)]
    const answer = await ghJson({ machine: this.machine, args })
    const permissions = answer.permissions
    if (!isObject(permissions)) throw shapeError(args, 'the repository without its permissions for the user of gh')
    const main = answer.default_branch
    return {
      write: permissions.push === true || permissions.maintain === true || permissions.admin === true,
      defaultBranch: typeof main === 'string' && main !== '' ? main : null,
    }
  }

  async listPullRequests(filter: PullRequestFilter = {}): Promise<PullRequest[]> {
    const query = [`state=${oneOf(filter.state ?? 'open', ['open', 'closed', 'all'] as const, 'state')}`, 'per_page=100']
    if (filter.head !== undefined) {
      query.push(`head=${encodeURIComponent(`${this.repository.owner}:${branch(filter.head, 'head')}`)}`)
    }
    if (filter.base !== undefined) query.push(`base=${encodeURIComponent(branch(filter.base, 'base'))}`)
    const args = [...apiArgs(this.repository), '--paginate', repositoryPath(this.repository, `pulls?${query.join('&')}`)]
    const items = await ghList({ machine: this.machine, args })
    return items.map((item) => this.pullOf(item, args))
  }

  async getPullRequest(number: number): Promise<PullRequest> {
    const args = [...apiArgs(this.repository), repositoryPath(this.repository, `pulls/${positive(number)}`)]
    return this.pullOf(await ghJson({ machine: this.machine, args }), args)
  }

  // ── Writing (each through the check) ─────────────────────────────────────────────────────────────────────────────

  // Creates the plugin's labels the repository lacks, their descriptions through the mask. A label GitHub answers
  // «already exists» for (another computer created it meanwhile) is no failure; after an answer that never came (no
  // HTTP status: the network, a timeout) the labels are read again; any refusal of GitHub (access, validation) is an
  // error with gh's text. Labels are compared without case, as GitHub does.
  async ensureLabels(): Promise<{ readonly created: PluginLabel[]; readonly present: PluginLabel[] }> {
    const context = this.boundary()
    const known = new Set((await this.listLabels()).map((label) => label.name.toLowerCase()))
    const created: PluginLabel[] = []
    const present: PluginLabel[] = []
    for (const label of PLUGIN_LABELS) {
      if (known.has(label)) {
        present.push(label)
        continue
      }
      const look = LABEL_LOOK[label]
      const description = maskText(look[this.settings.language], context.mask).text
      try {
        await this.send('POST', 'labels', { name: label, color: look.color, description })
        created.push(label)
      } catch (error) {
        if (error instanceof GitHubError && error.status === 422 && error.refusal.codes.includes('already_exists')) {
          present.push(label)
          continue
        }
        if (!unanswered(error)) throw error
        const now = await this.listLabels().catch(() => null)
        if (now === null || !now.some((one) => one.name.toLowerCase() === label)) throw error
        present.push(label)
      }
    }
    return { created, present }
  }

  // A comment on an issue (or PR).
  async comment(issue: number, content: BodyContent): Promise<Written<Comment>> {
    const checked = bodyOf(content, this.boundary(content.diff))
    const answer = await this.send('POST', `issues/${positive(issue)}/comments`, { body: checked.body })
    return { result: this.commentOf(answer, issue), hidden: checked.hidden, rules: checked.rules }
  }

  // A comment that belongs to an operation (its mark has `operation`): written only when the owner's comments of the
  // issue or PR have none with this operation and kind yet. A repeat after a lost GitHub answer finds the comment
  // written the first time and writes no second one (`existed: true`) — also when changed comments are next to it.
  // Without such an unchanged comment, any comment of the owner that someone else changed stops the write: what it
  // holds now proves neither that the operation is there nor that it is not (a changed mark may even name another
  // operation) — GitHubError `unconfirmed`, nothing is written. The owner's way out: delete the changed comment.
  async commentOnce(issue: number, content: BodyContent): Promise<Written<Comment> & { readonly existed: boolean }> {
    const checked = bodyOf(content, this.boundary(content.diff))
    const mark = content.mark
    if (!mark?.operation) throw new CheckError('bad_field', 'commentOnce needs a mark with an operation id')
    const own = await this.ownComments(issue)
    const confirmed = own.filter((one) => one.origin === 'owner').map((one) => one.comment)
    const found = findByOperation(confirmed, { operation: mark.operation, kind: mark.kind })
    if (found !== null) return { result: found, hidden: checked.hidden, rules: checked.rules, existed: true }
    const doubtful = own.find((one) => one.origin !== 'owner')
    if (doubtful !== undefined) {
      throw new GitHubError('unconfirmed', ['api', 'graphql', 'AqComments'], {
        ghText: '',
        what:
          `the state of operation ${mark.operation} cannot be confirmed: comment ${doubtful.comment.url} of the owner ` +
          'was changed by someone else; nothing was written',
      })
    }
    const answer = await this.send('POST', `issues/${positive(issue)}/comments`, { body: checked.body })
    return { result: this.commentOf(answer, issue), hidden: checked.hidden, rules: checked.rules, existed: false }
  }

  // An issue with the plugin's labels.
  async createIssue(
    content: BodyContent & { readonly title: GitHubText; readonly labels?: readonly PluginLabel[] },
  ): Promise<Written<Issue>> {
    const context = this.boundary(content.diff)
    const title = titleOf(content.title, context)
    const body = bodyOf(content, context)
    const labels = [...(content.labels ?? [])].map(pluginLabel)
    const answer = await this.send('POST', 'issues', { title: title.text, body: body.body, labels })
    return { result: this.issueOf(answer), ...sum(title, body) }
  }

  // Changes an issue of the owner (its texts the owner's alone): its title, its whole body (mark and text), its state.
  // Anything else — someone else's issue, one edited by someone else, a pull request — is refused before the write
  // (CheckError `not_owner`). The answer gives the issue's state, never its texts: someone may have changed them
  // between the check and the write.
  async updateIssue(
    number: number,
    change: {
      readonly title?: GitHubText
      readonly body?: BodyContent
      readonly state?: IssueState
      readonly stateReason?: 'completed' | 'not_planned' | 'reopened'
    },
  ): Promise<Written<IssueChange>> {
    const context = this.boundary(change.body?.diff)
    const title = change.title === undefined ? null : titleOf(change.title, context)
    const body = change.body === undefined ? null : bodyOf(change.body, context)
    const payload: Record<string, unknown> = {}
    if (title) payload.title = title.text
    if (body) payload.body = body.body
    if (change.state !== undefined) payload.state = oneOf(change.state, ['open', 'closed'] as const, 'state')
    if (change.stateReason !== undefined) {
      payload.state_reason = oneOf(change.stateReason, ['completed', 'not_planned', 'reopened'] as const, 'stateReason')
    }
    const target = await this.getIssue(number)
    if (target.found !== 'owner') {
      const what = target.reason === 'pull-request' ? 'it is a pull request' : `its text is not the owner's (${target.reason})`
      throw new CheckError('not_owner', `issue #${number} is not changed: ${what}; nothing was written`)
    }
    const answer = await this.send('PATCH', `issues/${positive(number)}`, payload)
    const args = ['api', 'issues']
    const result = this.shape(args, () => ({
      number: integer(answer.number),
      state: restState(answer.state),
      stateReason: typeof answer.state_reason === 'string' ? answer.state_reason : null,
      labels: labelNames(answer.labels),
      updatedAt: text(answer.updated_at),
      closedAt: typeof answer.closed_at === 'string' ? answer.closed_at : null,
      url: text(answer.html_url),
    }))
    return { result, ...sum(title, body) }
  }

  // Adds plugin labels to an issue (one it already has stays); answers with the issue's labels after it.
  async addLabels(issue: number, labels: readonly PluginLabel[]): Promise<string[]> {
    this.boundary()
    const input = { labels: labels.map(pluginLabel) }
    const path = repositoryPath(this.repository, `issues/${positive(issue)}/labels`)
    const args = [...apiArgs(this.repository), '--method', 'POST', path, '--input', '-']
    const answer = await ghArray({ machine: this.machine, args, input })
    return this.shape(args, () => labelNames(answer))
  }

  // Removes a plugin label from an issue. GitHub's «Label does not exist» (it is not there, also after a lost answer)
  // is no failure; after an answer that never came the issue is read again; any other refusal is an error.
  async removeLabel(issue: number, label: PluginLabel): Promise<void> {
    this.boundary()
    const name = pluginLabel(label)
    const path = repositoryPath(this.repository, `issues/${positive(issue)}/labels/${encodeURIComponent(name)}`)
    try {
      await runGh({ machine: this.machine, args: [...apiArgs(this.repository), '--method', 'DELETE', path] })
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404 && error.refusal.message === 'Label does not exist') return
      if (!unanswered(error)) throw error
      const args = [...apiArgs(this.repository), repositoryPath(this.repository, `issues/${issue}`)]
      const item = await ghJson({ machine: this.machine, args }).catch(() => null)
      const labels = item === null ? null : this.shape(args, () => labelNames(item.labels))
      if (labels === null || labels.some((one) => one.toLowerCase() === name)) throw error
    }
  }

  // The PR of task #issue: from its branch `agent-queue/issue-<issue>` into `base`. The base is checked as a branch
  // name and by the mask — a match is refused, since hiding it would change what the PR targets.
  async createPullRequest(content: {
    readonly issue: number
    readonly base: string
    readonly title: GitHubText
    readonly text: GitHubText
    readonly mark?: Mark | null
    readonly diff?: DiffPaths | null
    readonly draft: boolean
  }): Promise<Written<PullRequest>> {
    const context = this.boundary(content.diff)
    const head = taskBranch(content.issue)
    const base = baseBranch(content.base, context)
    const title = titleOf(content.title, context)
    const body = bodyOf(content, context)
    if (typeof content.draft !== 'boolean') throw new CheckError('bad_field', 'field draft is not true or false')
    const answer = await this.send('POST', 'pulls', { title: title.text, head, base, body: body.body, draft: content.draft })
    return { result: this.pullOf(answer, ['api', 'pulls']), ...sum(title, body) }
  }

  // Changes a PR: its title, its whole body, its base branch (checked as in createPullRequest), its state (closed
  // without a merge, or open again).
  async updatePullRequest(
    number: number,
    change: { readonly title?: GitHubText; readonly body?: BodyContent; readonly base?: string; readonly state?: IssueState },
  ): Promise<Written<PullRequest>> {
    const context = this.boundary(change.body?.diff)
    const title = change.title === undefined ? null : titleOf(change.title, context)
    const body = change.body === undefined ? null : bodyOf(change.body, context)
    const payload: Record<string, unknown> = {}
    if (title) payload.title = title.text
    if (body) payload.body = body.body
    if (change.base !== undefined) payload.base = baseBranch(change.base, context)
    if (change.state !== undefined) payload.state = oneOf(change.state, ['open', 'closed'] as const, 'state')
    const answer = await this.send('PATCH', `pulls/${positive(number)}`, payload)
    return { result: this.pullOf(answer, ['api', 'pulls']), ...sum(title, body) }
  }

  // A draft PR becomes ready for review, or (draft: true) a draft again: `gh pr ready` — GitHub's REST has no call.
  async setPullRequestDraft(number: number, draft: boolean): Promise<void> {
    this.boundary()
    if (typeof draft !== 'boolean') throw new CheckError('bad_field', 'field draft is not true or false')
    const args = ['pr', 'ready', String(positive(number)), '--repo', repositoryRef(this.repository)]
    await runGh({ machine: this.machine, args: draft ? [...args, '--undo'] : args })
  }

  // ── Inside ───────────────────────────────────────────────────────────────────────────────────────────────────────

  // The start of every write: the project's patterns compiled (an invalid one refuses the write) with the diff.
  private boundary(diff?: DiffPaths | null): CheckContext {
    return checkContext(this.settings, diff ?? null)
  }

  private send(method: 'POST' | 'PATCH', rest: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const args = [...apiArgs(this.repository), '--method', method, repositoryPath(this.repository, rest), '--input', '-']
    return ghJson({ machine: this.machine, args, input })
  }

  // A GraphQL read of the repository: every page with its `viewer` (the same on all pages, or `owner_unknown`) and its
  // `repository` object.
  private async read(query: string, variables: Variables, paginate: boolean): Promise<Read> {
    const args = [...apiArgs(this.repository), 'graphql']
    if (paginate) args.push('--paginate')
    args.push('-f', `query=${query}`, '-f', `owner=${this.repository.owner}`, '-f', `name=${this.repository.name}`)
    for (const [key, value] of Object.entries(variables)) {
      if (typeof value === 'number') args.push('-F', `${key}=${value}`)
      else if (typeof value === 'string') args.push('-f', `${key}=${value}`)
      else for (const item of value) args.push('-f', `${key}[]=${item}`)
    }
    const pages = paginate
      ? await ghPages({ machine: this.machine, args }, 'object')
      : [await ghJson({ machine: this.machine, args })]
    let owner: string | null = null
    const datas: Record<string, unknown>[] = []
    for (const page of pages as Record<string, unknown>[]) {
      if (Array.isArray(page.errors) && page.errors.length > 0) {
        const said = page.errors
          .map((one) => (isObject(one) && typeof one.message === 'string' ? one.message : '?'))
          .join('; ')
        throw new GitHubError('bad_answer', args, { ghText: said, what: `GitHub answered with errors: ${said}` })
      }
      const data = page.data
      const viewer = isObject(data) && isObject(data.viewer) ? data.viewer.login : undefined
      if (typeof viewer !== 'string' || viewer === '') {
        throw new GitHubError('owner_unknown', args, {
          ghText: '',
          what: 'the answer names no GitHub user of gh: no texts can be told apart',
        })
      }
      if (owner !== null && owner.toLowerCase() !== viewer.toLowerCase()) {
        throw new GitHubError('owner_unknown', args, {
          ghText: '',
          what: 'the GitHub user of gh changed while the list was read (gh auth switch?): nothing of it is used',
        })
      }
      owner = viewer
      if (!isObject(data) || !isObject(data.repository)) throw shapeError(args, `no repository ${repositoryRef(this.repository)}`)
      datas.push(data)
    }
    if (owner === null) throw shapeError(args, 'no page')
    return { owner, pages: datas, args }
  }

  // The nodes of the connection a paginated read went through, from all its pages. The pages must follow each other:
  // a cursor and `hasNextPage: true` on every page but the last, `hasNextPage: false` on the last — otherwise gh stopped
  // before the end, and the list is not whole.
  private pagedNodes(read: Read, pick: (data: Record<string, unknown>) => unknown): Record<string, unknown>[] {
    return this.shape(read.args, () => {
      const nodes: Record<string, unknown>[] = []
      read.pages.forEach((data, index) => {
        const connection = pick(data)
        if (!isObject(connection) || !Array.isArray(connection.nodes) || !isObject(connection.pageInfo)) {
          throw new Error('not a list of nodes with its pageInfo')
        }
        const { hasNextPage, endCursor } = connection.pageInfo
        const last = index === read.pages.length - 1
        if (last && hasNextPage !== false) {
          throw new Error('the list is not whole: its last page says more pages follow (gh stopped before the end)')
        }
        if (!last && (hasNextPage !== true || typeof endCursor !== 'string' || endCursor === '')) {
          throw new Error('the list is not whole: its pages do not follow each other')
        }
        for (const node of connection.nodes) {
          if (!isObject(node)) throw new Error('a node is not an object')
          nodes.push(node)
        }
      })
      return nodes
    })
  }

  // The whole edit history (`edits`) or title renames (`renames`) of an issue or comment, read on by its own query
  // after the first 100 came with the list. The query names the repository; the node must belong to it, and gh must
  // still run as the same user.
  // The entries must be at least as many as GitHub counted with the text (`counted`): an entry is never removed from a
  // history (a deleted revision stays, with `deletedBy`), so fewer means the history did not come whole — GitHubError
  // `bad_answer`, and nothing of the text is used. More means it grew meanwhile; every entry is checked as ever.
  private async history(
    id: unknown,
    what: 'edits' | 'renames',
    list: Read,
    counted: number,
    of: string,
  ): Promise<Record<string, unknown>[]> {
    if (typeof id !== 'string' || id === '') throw shapeError(list.args, 'a text without its id')
    const read = await this.read(what === 'edits' ? Q_EDITS : Q_RENAMES, { id }, true)
    if (read.owner.toLowerCase() !== list.owner.toLowerCase()) {
      throw new GitHubError('owner_unknown', read.args, {
        ghText: '',
        what: 'the GitHub user of gh changed while the texts were read (gh auth switch?): nothing of them is used',
      })
    }
    const slug = repositorySlug(this.repository).toLowerCase()
    for (const data of read.pages) {
      const repository = field(data.node, 'repository')
      if (!isObject(repository) || typeof repository.nameWithOwner !== 'string' || repository.nameWithOwner.toLowerCase() !== slug) {
        throw shapeError(read.args, `the text ${id} is not one of ${repositoryRef(this.repository)}`)
      }
    }
    const entries = this.pagedNodes(read, (data) => field(data.node, what === 'edits' ? 'userContentEdits' : 'timelineItems'))
    if (entries.length < counted) {
      throw shapeError(
        read.args,
        `the ${what === 'edits' ? 'edit' : 'rename'} history of ${of} came incomplete: GitHub counted ${counted}, read ${entries.length}`,
      )
    }
    return entries
  }

  // Whether a text counts as the owner's (see the header): `owner`, or why not. An edit history or rename history
  // longer than came with the list is read on whole before the answer — an incomplete history decides nothing.
  private async originOf(node: Record<string, unknown>, read: Read, issue: boolean): Promise<'owner' | NotOwner> {
    const { owner, args } = read
    const first = this.shape(args, () => {
      for (const key of ['author', 'editor', 'lastEditedAt', 'userContentEdits']) {
        if (!(key in node)) throw new Error(`no ${key}`)
      }
      if (!sameLogin(node.author, owner)) return 'author' as const
      if ((node.lastEditedAt !== null || node.editor !== null) && !sameLogin(node.editor, owner)) return 'edited' as const
      const edits = listed(node.userContentEdits, 'userContentEdits')
      const renames = issue ? listed(node.timelineItems, 'timelineItems') : { nodes: [], more: false, total: 0 }
      if (edits.nodes.some((edit) => !ownEdit(edit, owner))) return 'edited' as const
      if (renames.nodes.some((rename) => !sameLogin(rename.actor, owner))) return 'edited' as const
      const of = issue ? `issue #${String(node.number)}` : `comment ${String(node.url)}`
      return { edits: edits.more ? edits.total : null, renames: renames.more ? renames.total : null, of }
    })
    if (typeof first === 'string') return first
    if (first.edits !== null) {
      const edits = await this.history(node.id, 'edits', read, first.edits, first.of)
      if (edits.some((edit) => !ownEdit(edit, owner))) return 'edited'
    }
    if (first.renames !== null) {
      const renames = await this.history(node.id, 'renames', read, first.renames, first.of)
      if (renames.some((rename) => !sameLogin(rename.actor, owner))) return 'edited'
    }
    return 'owner'
  }

  private issueFromNode(node: Record<string, unknown>, args: readonly string[]): Issue {
    return this.shape(args, () => {
      const labels = listed(node.labels, 'labels')
      if (labels.more) throw new Error('more labels than one read gives: the list is not whole')
      return {
        number: integer(node.number),
        title: text(node.title),
        body: typeof node.body === 'string' ? node.body : '',
        state: graphState(node.state),
        stateReason: typeof node.stateReason === 'string' ? node.stateReason.toLowerCase() : null,
        labels: labels.nodes.map((label) => text(label.name)),
        author: login(node.author),
        createdAt: text(node.createdAt),
        updatedAt: text(node.updatedAt),
        closedAt: typeof node.closedAt === 'string' ? node.closedAt : null,
        url: text(node.url),
      }
    })
  }

  private commentFromNode(node: Record<string, unknown>, issue: number, args: readonly string[]): Comment {
    return this.shape(args, () => ({
      id: commentId(text(node.url)),
      issue,
      body: typeof node.body === 'string' ? node.body : '',
      author: login(node.author),
      createdAt: text(node.createdAt),
      updatedAt: text(node.updatedAt),
      url: text(node.url),
    }))
  }

  // Reads GitHub's answer into the plugin's shape; a field missing or of another type is GitHubError `bad_answer`.
  private shape<T>(args: readonly string[], read: () => T): T {
    try {
      return read()
    } catch (error) {
      if (error instanceof GitHubError) throw error
      throw shapeError(args, error instanceof Error ? error.message : String(error))
    }
  }

  // An issue from the REST answer of its creation (the text is the one just written).
  private issueOf(item: Record<string, unknown>): Issue {
    return this.shape(['api', 'issues'], () => ({
      number: integer(item.number),
      title: text(item.title),
      body: typeof item.body === 'string' ? item.body : '',
      state: restState(item.state),
      stateReason: typeof item.state_reason === 'string' ? item.state_reason : null,
      labels: labelNames(item.labels),
      author: login(item.user),
      createdAt: text(item.created_at),
      updatedAt: text(item.updated_at),
      closedAt: typeof item.closed_at === 'string' ? item.closed_at : null,
      url: text(item.html_url),
    }))
  }

  // A comment from the REST answer of its write.
  private commentOf(item: Record<string, unknown>, issue: number): Comment {
    return this.shape(['api', 'comments'], () => ({
      id: integer(item.id),
      issue,
      body: typeof item.body === 'string' ? item.body : '',
      author: login(item.user),
      createdAt: text(item.created_at),
      updatedAt: text(item.updated_at),
      url: text(item.html_url),
    }))
  }

  private pullOf(item: Record<string, unknown>, args: readonly string[]): PullRequest {
    return this.shape(args, () => {
      const base = item.base
      const head = item.head
      if (!isObject(base) || !isObject(head)) throw new Error('no base or head')
      const repo = head.repo
      const mergedAt = typeof item.merged_at === 'string' ? item.merged_at : null
      return {
        number: integer(item.number),
        state: restState(item.state),
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

function titleOf(title: GitHubText, context: CheckContext): CheckedText {
  const checked = checkText(title, context)
  if (checked.text.trim() === '') throw new CheckError('empty', 'the title is empty; nothing was written')
  if (/[\r\n]/.test(checked.text)) throw new CheckError('bad_field', 'a title is one line; nothing was written')
  return checked
}

// A base branch for a PR: a branch name, and nothing the mask would hide.
function baseBranch(name: string, context: CheckContext): string {
  branch(name, 'base')
  if (context.mask.matches(name)) {
    throw new CheckError(
      'masked_value',
      "the base branch name matches the mask: hiding it would change the PR's target; nothing was written",
    )
  }
  return name
}

// A failure whose answer never came: a timeout, or gh failed without an HTTP status (the network, a cut connection).
// Only then is the state read again; a refusal GitHub did answer is final.
function unanswered(error: unknown): boolean {
  return (
    error instanceof GitHubError && (error.kind === 'gh_timed_out' || (error.kind === 'gh_failed' && error.status === null))
  )
}

function shapeError(args: readonly string[], what: string): GitHubError {
  return new GitHubError('bad_answer', args, { ghText: '', what: `gh answered JSON of another shape: ${what}` })
}

// The items of a nested list read with totalCount, and whether GitHub has more than it gave.
function listed(
  connection: unknown,
  name: string,
): { readonly nodes: Record<string, unknown>[]; readonly more: boolean; readonly total: number } {
  if (!isObject(connection) || !Array.isArray(connection.nodes) || typeof connection.totalCount !== 'number') {
    throw new Error(`no ${name}`)
  }
  const nodes = connection.nodes.map((node) => {
    if (!isObject(node)) throw new Error(`an item of ${name} is not an object`)
    return node
  })
  return { nodes, more: connection.totalCount > nodes.length, total: connection.totalCount }
}

// An entry of an edit history made (and, if a revision was deleted, deleted) by the owner.
function ownEdit(edit: Record<string, unknown>, owner: string): boolean {
  return sameLogin(edit.editor, owner) && (edit.deletedBy === null || edit.deletedBy === undefined || sameLogin(edit.deletedBy, owner))
}

// A field of a JSON object, or undefined.
function field(value: unknown, key: string): unknown {
  return isObject(value) ? value[key] : undefined
}

function sameLogin(actor: unknown, owner: string): boolean {
  return isObject(actor) && typeof actor.login === 'string' && actor.login.toLowerCase() === owner.toLowerCase()
}

function sum(...parts: ({ readonly hidden: number; readonly rules: readonly string[] } | null)[]) {
  const present = parts.filter((part) => part !== null)
  return {
    hidden: present.reduce((total, part) => total + part.hidden, 0),
    rules: [...new Set(present.flatMap((part) => part.rules))],
  }
}

function positive(number: number): number {
  if (!hasFixedForm('issue', number)) throw new CheckError('bad_field', 'not an issue or PR number (an integer from 1)')
  return number
}

function branch(name: string, field: string): string {
  if (!isBranchName(name)) throw new CheckError('bad_field', `field ${field} is not a git branch name; nothing was written`)
  return name
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new CheckError('bad_field', `field ${field} is not ${allowed.join(', ')}; nothing was written`)
  }
  return value as T
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
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`expected an integer, got ${JSON.stringify(value)}`)
  }
  return value
}

function commentId(url: string): number {
  const id = /#issuecomment-([1-9][0-9]*)$/.exec(url)?.[1]
  if (id === undefined || !Number.isSafeInteger(Number(id))) throw new Error(`no comment id in ${JSON.stringify(url)}`)
  return Number(id)
}

function restState(value: unknown): IssueState {
  if (value !== 'open' && value !== 'closed') throw new Error(`expected open or closed, got ${JSON.stringify(value)}`)
  return value
}

// GraphQL's state of an issue (OPEN, CLOSED) or a pull request (also MERGED).
function graphState(value: unknown): IssueState {
  if (value === 'OPEN') return 'open'
  if (value === 'CLOSED' || value === 'MERGED') return 'closed'
  throw new Error(`expected OPEN, CLOSED or MERGED, got ${JSON.stringify(value)}`)
}

function login(user: unknown): string {
  if (!isObject(user) || typeof user.login !== 'string') throw new Error('no user login')
  return user.login
}

function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) throw new Error('labels is not a list')
  return labels.map((label) => (typeof label === 'string' ? label : text(isObject(label) ? label.name : undefined)))
}
