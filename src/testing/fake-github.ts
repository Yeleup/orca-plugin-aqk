// A fake GitHub behind a fake `gh` for the plugin's tests (TZ: «Только подделки» — no network, no real GitHub, never the
// real gh of this computer). The fake computer (fake-machine.ts) has `gh` in its PATH, records every start with its
// arguments and standard input, and this fake answers it the way `gh` answers:
//
// - `gh api [--hostname H] <REST endpoint>` of one repository and `gh api [--hostname H] graphql` with the plugin's
//   queries (AqViewer, AqIssues, AqIssue, AqComments) — JSON on stdout, an error text on stderr and a non-zero exit;
// - `gh pr ready N --repo [HOST/]OWNER/REPO [--undo]`.
//
// The host is the one gh would use: `--hostname`, else GH_HOST of the environment, else github.com; a call for another
// host or repository gets the error gh would print. The fake keeps issues, comments, labels and pull requests in
// memory, with their authors, editors, edit histories and title renames, and changes them on writes. Lists come in
// pages of `pageSize`, printed one after another like `gh api --paginate` does. A test can make a call fail — with
// the change made anyway, as when GitHub's answer is lost — or answer what it likes.
import type { StartRequest } from '../platform/machine'
import { fakeMachine, type FakeAnswer, type FakeMachine } from './fake-machine'

export const FAKE_GH = '/usr/bin/gh'

export type FakeIssue = {
  number: number
  title: string
  body: string
  state: 'open' | 'closed'
  state_reason: string | null
  labels: string[]
  user: string
  created_at: string
  updated_at: string
  closed_at: string | null
  // Who edited the body, in order (the last one is GitHub's `editor`); `null` — an account that no longer exists.
  edits: (string | null)[]
  // Edits GitHub has but does not give in one read (a history longer than the read).
  unreadEdits: number
  // Who renamed the title, in order.
  renames: string[]
}

export type FakeComment = {
  id: number
  issue: number
  body: string
  user: string
  created_at: string
  updated_at: string
  edits: (string | null)[]
  unreadEdits: number
}

export type FakeLabel = { name: string; color: string; description: string }

export type FakePull = {
  number: number
  title: string
  body: string
  state: 'open' | 'closed'
  draft: boolean
  merged_at: string | null
  merge_commit_sha: string | null
  base: string
  head: string
  head_sha: string
  user: string
}

// One call of gh as the fake read it.
export type FakeGhCall = {
  readonly args: readonly string[]
  // The host gh would use for it (--hostname, else GH_HOST, else github.com); `--repo`'s host for `gh pr`.
  readonly host: string
  readonly method: string
  // REST: the endpoint as given; GraphQL: `graphql`.
  readonly endpoint: string
  readonly path: string
  readonly query: URLSearchParams
  // The GraphQL operation (AqIssues …) and its variables from -f/-F, or null.
  readonly operation: string | null
  readonly variables: Record<string, unknown>
  readonly input: unknown
}

type Failure = {
  readonly match: (call: FakeGhCall) => boolean
  readonly answer: FakeAnswer
  // Make the change anyway, then answer with the failure: GitHub did it, the answer was lost.
  readonly apply: boolean
  times: number
}

export type FakeGitHubOptions = {
  // The repository `owner/name` the fake serves; calls for any other get the error gh would give.
  readonly repository: string
  // Its host.
  readonly host?: string
  // The GitHub user gh runs as; null — gh is not logged in.
  readonly login: string | null
  readonly pageSize?: number
  readonly env?: Record<string, string>
}

export class FakeGitHub {
  readonly repository: string
  readonly host: string
  login: string | null
  readonly pageSize: number
  readonly issues: FakeIssue[] = []
  readonly comments: FakeComment[] = []
  readonly labels: FakeLabel[] = []
  readonly pulls: FakePull[] = []
  readonly machine: FakeMachine
  private readonly failures: Failure[] = []
  private clock = Date.UTC(2026, 0, 15, 9, 0, 0)
  private nextComment = 9_000_001

  constructor(options: FakeGitHubOptions) {
    this.repository = options.repository
    this.host = options.host ?? 'github.com'
    this.login = options.login
    this.pageSize = options.pageSize ?? 2
    this.machine = fakeMachine({
      platform: 'linux',
      env: { PATH: '/usr/bin', ...(options.env ?? {}) },
      executables: [FAKE_GH],
      answer: (request) => this.answer(request),
    })
  }

  // Every gh call so far, in order.
  get calls(): FakeGhCall[] {
    return this.machine.starts.map(readCall)
  }

  // The next `times` calls that `match` get `answer` instead (after the change, when `apply`).
  fail(match: (call: FakeGhCall) => boolean, answer: FakeAnswer, options: { apply?: boolean; times?: number } = {}): void {
    this.failures.push({ match, answer, apply: options.apply ?? false, times: options.times ?? 1 })
  }

  addIssue(issue: Partial<FakeIssue> & { number: number; user: string }): FakeIssue {
    const time = this.tick()
    const full: FakeIssue = {
      title: `Task ${issue.number}`,
      body: '',
      state: 'open',
      state_reason: null,
      labels: [],
      created_at: time,
      updated_at: time,
      closed_at: null,
      edits: [],
      unreadEdits: 0,
      renames: [],
      ...issue,
    }
    this.issues.push(full)
    return full
  }

  addComment(issue: number, user: string, body: string, more: Partial<FakeComment> = {}): FakeComment {
    const time = this.tick()
    const comment: FakeComment = {
      id: this.nextComment++,
      issue,
      body,
      user,
      created_at: time,
      updated_at: time,
      edits: [],
      unreadEdits: 0,
      ...more,
    }
    this.comments.push(comment)
    return comment
  }

  addLabel(name: string, color = 'ededed', description = ''): void {
    this.labels.push({ name, color, description })
  }

  addPull(pull: Partial<FakePull> & { number: number; head: string; base: string; user: string }): FakePull {
    const full: FakePull = {
      title: `PR ${pull.number}`,
      body: '',
      state: 'open',
      draft: false,
      merged_at: null,
      merge_commit_sha: null,
      head_sha: 'a'.repeat(40),
      ...pull,
    }
    this.pulls.push(full)
    return full
  }

  private tick(): string {
    this.clock += 60_000
    return new Date(this.clock).toISOString()
  }

  answer(request: StartRequest): FakeAnswer {
    if (request.file !== FAKE_GH) return { code: 127, stderr: `fake: not gh: ${request.file}` }
    const call = readCall(request)
    const failure = this.failures.find((one) => one.times > 0 && one.match(call))
    if (failure) {
      failure.times--
      if (failure.apply) this.handle(call)
      return failure.answer
    }
    return this.handle(call)
  }

  private handle(call: FakeGhCall): FakeAnswer {
    if (call.host !== this.host) {
      return { code: 1, stderr: `HTTP 401: Bad credentials (https://${call.host}/api/v3/${call.path})\nTry authenticating with:  gh auth login` }
    }
    if (call.args[0] === 'pr' && call.args[1] === 'ready') return this.prReady(call.args)
    if (call.args[0] !== 'api') return { code: 1, stderr: `fake gh: unknown command ${call.args.join(' ')}` }
    if (this.login === null) {
      return { code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' }
    }
    if (call.path === 'graphql') return this.graphql(call)
    const prefix = `repos/${this.repository}/`
    if (!call.path.startsWith(prefix)) return notFound()
    const rest = call.path.slice(prefix.length).split('/')
    const paginate = call.args.includes('--paginate')
    const [what, id, sub, name] = rest
    const number = Number(id)
    if (what === 'issues' && id === undefined && call.method === 'POST') return this.createIssue(call.input)
    if (what === 'issues' && id !== undefined && sub === undefined) {
      const issue = this.issues.find((one) => one.number === number)
      if (!issue) return notFound()
      if (call.method === 'GET') return ok(this.issueJson(issue))
      if (call.method === 'PATCH') return this.patchIssue(issue, call.input)
      return notFound()
    }
    if (what === 'issues' && sub === 'comments' && call.method === 'POST') {
      const body = field(call.input, 'body')
      if (typeof body !== 'string' || body === '') return invalid('body')
      return ok(this.commentJson(this.addComment(number, this.login, body)))
    }
    if (what === 'issues' && sub === 'labels') {
      const issue = this.issues.find((one) => one.number === number)
      if (!issue) return notFound()
      if (call.method === 'POST' && name === undefined) {
        const labels = field(call.input, 'labels')
        if (!Array.isArray(labels)) return invalid('labels')
        for (const label of labels) {
          if (!this.labels.some((one) => one.name.toLowerCase() === String(label).toLowerCase())) return invalid('labels')
          if (!issue.labels.includes(String(label))) issue.labels.push(String(label))
        }
        return ok(issue.labels.map((label) => ({ name: label })))
      }
      if (call.method === 'DELETE' && name !== undefined) {
        const label = decodeURIComponent(name)
        if (!issue.labels.includes(label)) {
          return {
            code: 1,
            stdout: JSON.stringify({ message: 'Label does not exist', documentation_url: 'https://docs.github.com/rest', status: '404' }),
            stderr: 'gh: Label does not exist (HTTP 404)',
          }
        }
        issue.labels = issue.labels.filter((one) => one !== label)
        return ok(issue.labels.map((one) => ({ name: one })))
      }
    }
    if (what === 'labels' && id === undefined) {
      if (call.method === 'GET') return this.page(this.labels.map((one) => ({ ...one, id: 1, default: false })), paginate)
      if (call.method === 'POST') {
        const label = field(call.input, 'name')
        if (typeof label !== 'string') return invalid('name')
        if (this.labels.some((one) => one.name.toLowerCase() === label.toLowerCase())) {
          return {
            code: 1,
            stdout: JSON.stringify({
              message: 'Validation Failed',
              errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }],
            }),
            stderr: 'gh: Validation Failed (HTTP 422)',
          }
        }
        const created = {
          name: label,
          color: String(field(call.input, 'color')),
          description: String(field(call.input, 'description') ?? ''),
        }
        this.labels.push(created)
        return ok(created)
      }
    }
    if (what === 'pulls' && id === undefined) {
      if (call.method === 'GET') {
        const state = call.query.get('state') ?? 'open'
        const head = call.query.get('head')
        const base = call.query.get('base')
        const owner = this.repository.split('/')[0]
        return this.page(
          this.pulls
            .filter((one) => state === 'all' || one.state === state)
            .filter((one) => head === null || `${owner}:${one.head}` === head)
            .filter((one) => base === null || one.base === base)
            .map((one) => this.pullJson(one)),
          paginate,
        )
      }
      if (call.method === 'POST') return this.createPull(call.input)
    }
    if (what === 'pulls' && id !== undefined && sub === undefined) {
      const pull = this.pulls.find((one) => one.number === number)
      if (!pull) return notFound()
      if (call.method === 'GET') return ok(this.pullJson(pull))
      if (call.method === 'PATCH') {
        for (const key of ['title', 'body', 'base', 'state'] as const) {
          const value = field(call.input, key)
          if (typeof value === 'string') (pull as Record<string, unknown>)[key] = value
        }
        return ok(this.pullJson(pull))
      }
    }
    return { code: 1, stderr: `fake gh: unknown call ${call.method} ${call.endpoint}` }
  }

  // GraphQL: the plugin's queries, each with `viewer` and the repository it names.
  private graphql(call: FakeGhCall): FakeAnswer {
    const variables = call.variables
    if (`${String(variables.owner)}/${String(variables.name)}` !== this.repository) {
      return {
        code: 1,
        stderr: `GraphQL: Could not resolve to a Repository with the name '${String(variables.owner)}/${String(variables.name)}'. (repository)`,
      }
    }
    const viewer = { login: this.login }
    const paginate = call.args.includes('--paginate')
    const number = Number(variables.number)
    if (call.operation === 'AqViewer') return ok({ data: { viewer, repository: { nameWithOwner: this.repository } } })
    if (call.operation === 'AqIssues') {
      const states = (variables.states as string[] | undefined) ?? null
      const labels = (variables.labels as string[] | undefined) ?? null
      const nodes = this.issues
        .filter((issue) => states === null || states.includes(issue.state.toUpperCase()))
        // GitHub's label filter: any of the labels.
        .filter((issue) => labels === null || labels.some((label) => issue.labels.includes(label)))
        .sort((a, b) => a.number - b.number)
        .map((issue) => this.issueNode(issue))
      return this.graphPages(nodes, paginate, (connection) => ({ viewer, repository: { issues: connection } }))
    }
    if (call.operation === 'AqIssue') {
      const issue = this.issues.find((one) => one.number === number)
      const pull = this.pulls.find((one) => one.number === number)
      if (!issue && !pull) {
        return {
          code: 1,
          stderr: `GraphQL: Could not resolve to an issue or pull request with the number of ${number}. (repository.issueOrPullRequest)`,
        }
      }
      const node = issue
        ? { __typename: 'Issue', ...this.issueNode(issue) }
        : { __typename: 'PullRequest', number, state: pull?.merged_at ? 'MERGED' : pull?.state.toUpperCase() }
      return ok({ data: { viewer, repository: { issueOrPullRequest: node } } })
    }
    if (call.operation === 'AqComments') {
      if (!this.issues.some((one) => one.number === number)) {
        return { code: 1, stderr: `GraphQL: Could not resolve to an Issue with the number of ${number}. (repository.issue)` }
      }
      const nodes = this.comments.filter((one) => one.issue === number).map((one) => this.commentNode(one))
      return this.graphPages(nodes, paginate, (connection) => ({ viewer, repository: { issue: { comments: connection } } }))
    }
    return { code: 1, stderr: `fake gh: unknown GraphQL operation ${String(call.operation)}` }
  }

  // GraphQL pages as gh --paginate prints them: one JSON object per page, one after another.
  private graphPages(
    nodes: readonly unknown[],
    paginate: boolean,
    wrap: (connection: Record<string, unknown>) => Record<string, unknown>,
  ): FakeAnswer {
    const pages: string[] = []
    for (let at = 0; at < nodes.length || at === 0; at += this.pageSize) {
      const hasNextPage = at + this.pageSize < nodes.length
      const connection = {
        pageInfo: { hasNextPage, endCursor: hasNextPage ? `cursor-${at + this.pageSize}` : null },
        nodes: nodes.slice(at, at + this.pageSize),
      }
      pages.push(JSON.stringify({ data: wrap(connection) }))
      if (!paginate) break
    }
    return { code: 0, stdout: pages.join('') }
  }

  // A REST list as gh --paginate prints it: each page a JSON array, one after another; without --paginate only the first.
  private page(items: readonly unknown[], paginate: boolean): FakeAnswer {
    const pages: string[] = []
    for (let at = 0; at < items.length || at === 0; at += this.pageSize) {
      pages.push(JSON.stringify(items.slice(at, at + this.pageSize)))
      if (!paginate) break
    }
    return { code: 0, stdout: pages.join('') }
  }

  private createIssue(input: unknown): FakeAnswer {
    const title = field(input, 'title')
    if (typeof title !== 'string' || title === '') return invalid('title')
    const labels = field(input, 'labels')
    const issue = this.addIssue({
      number: this.nextNumber(),
      user: this.login ?? '',
      title,
      body: String(field(input, 'body') ?? ''),
      labels: Array.isArray(labels) ? labels.map(String) : [],
    })
    return ok(this.issueJson(issue))
  }

  private nextNumber(): number {
    return Math.max(0, ...this.issues.map((one) => one.number), ...this.pulls.map((one) => one.number)) + 1
  }

  private patchIssue(issue: FakeIssue, input: unknown): FakeAnswer {
    const title = field(input, 'title')
    const body = field(input, 'body')
    const state = field(input, 'state')
    const reason = field(input, 'state_reason')
    if (typeof title === 'string' && title !== issue.title) {
      issue.title = title
      issue.renames.push(this.login ?? '')
    }
    if (typeof body === 'string' && body !== issue.body) {
      issue.body = body
      issue.edits.push(this.login)
    }
    if (state === 'open' || state === 'closed') {
      issue.state = state
      issue.closed_at = state === 'closed' ? this.tick() : null
    }
    if (typeof reason === 'string') issue.state_reason = reason
    issue.updated_at = this.tick()
    return ok(this.issueJson(issue))
  }

  private createPull(input: unknown): FakeAnswer {
    const head = field(input, 'head')
    const base = field(input, 'base')
    const title = field(input, 'title')
    if (typeof head !== 'string' || typeof base !== 'string' || typeof title !== 'string') return invalid('head')
    const pull = this.addPull({
      number: this.nextNumber(),
      head,
      base,
      title,
      body: String(field(input, 'body') ?? ''),
      draft: field(input, 'draft') === true,
      user: this.login ?? '',
    })
    return ok(this.pullJson(pull))
  }

  private prReady(args: readonly string[]): FakeAnswer {
    const repo = args.includes('--repo') ? (args[args.indexOf('--repo') + 1] ?? '') : ''
    const slug = repo.split('/').slice(-2).join('/')
    if (slug !== this.repository) return { code: 1, stderr: 'GraphQL: Could not resolve to a Repository' }
    if (this.login === null) return { code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' }
    const pull = this.pulls.find((one) => one.number === Number(args[2]))
    if (!pull) return { code: 1, stderr: `GraphQL: Could not resolve to a PullRequest with the number of ${args[2]}.` }
    pull.draft = args.includes('--undo')
    return { code: 0, stdout: '' }
  }

  // The REST JSON of an issue (answers of writes, GET issues/N).
  issueJson(issue: FakeIssue): Record<string, unknown> {
    return {
      id: 100_000 + issue.number,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      state_reason: issue.state_reason,
      labels: issue.labels.map((name) => ({ name, color: 'ededed' })),
      user: { login: issue.user, type: 'User' },
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      closed_at: issue.closed_at,
      html_url: `https://${this.host}/${this.repository}/issues/${issue.number}`,
    }
  }

  // The GraphQL node of an issue, with its author, editors and renames.
  issueNode(issue: FakeIssue): Record<string, unknown> {
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state.toUpperCase(),
      stateReason: issue.state_reason?.toUpperCase() ?? null,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      closedAt: issue.closed_at,
      url: `https://${this.host}/${this.repository}/issues/${issue.number}`,
      ...edited(issue.user, issue.edits, issue.unreadEdits, issue.updated_at),
      labels: { totalCount: issue.labels.length, nodes: issue.labels.map((name) => ({ name })) },
      timelineItems: { totalCount: issue.renames.length, nodes: issue.renames.map((login) => ({ actor: { login } })) },
    }
  }

  commentJson(comment: FakeComment): Record<string, unknown> {
    return {
      id: comment.id,
      body: comment.body,
      user: { login: comment.user, type: 'User' },
      created_at: comment.created_at,
      updated_at: comment.updated_at,
      html_url: `https://${this.host}/${this.repository}/issues/${comment.issue}#issuecomment-${comment.id}`,
      issue_url: `https://api.${this.host}/repos/${this.repository}/issues/${comment.issue}`,
    }
  }

  private commentNode(comment: FakeComment): Record<string, unknown> {
    return {
      body: comment.body,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
      url: `https://${this.host}/${this.repository}/issues/${comment.issue}#issuecomment-${comment.id}`,
      ...edited(comment.user, comment.edits, comment.unreadEdits, comment.updated_at),
    }
  }

  private pullJson(pull: FakePull): Record<string, unknown> {
    return {
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      draft: pull.draft,
      merged_at: pull.merged_at,
      merge_commit_sha: pull.merge_commit_sha,
      base: { ref: pull.base, sha: 'b'.repeat(40) },
      head: { ref: pull.head, sha: pull.head_sha, repo: { full_name: this.repository } },
      user: { login: pull.user },
      html_url: `https://${this.host}/${this.repository}/pull/${pull.number}`,
    }
  }
}

// GitHub's fields about a text's author and edits: `editor` and `lastEditedAt` of the last edit, and the edit history
// (when edited: the creation by the author, then each edit), with `totalCount` above what is given when some are not.
function edited(author: string, edits: readonly (string | null)[], unread: number, at: string): Record<string, unknown> {
  const actor = (login: string | null) => (login === null ? null : { login })
  const last = edits.length > 0 ? edits[edits.length - 1] : undefined
  const history = edits.length > 0 ? [author, ...edits] : []
  return {
    author: { login: author },
    editor: last === undefined ? null : actor(last),
    lastEditedAt: last === undefined ? null : at,
    userContentEdits: {
      totalCount: history.length + unread,
      nodes: history.map((login) => ({ editor: actor(login), deletedBy: null })),
    },
  }
}

// What gh would make of its arguments: the host (--hostname, else GH_HOST, else github.com; `--repo HOST/…` for gh pr),
// the REST method and endpoint or the GraphQL operation and variables (-f strings, -F numbers, key[]= lists).
function readCall(request: StartRequest): FakeGhCall {
  const args = request.args
  let method = 'GET'
  let endpoint = ''
  let hostname: string | null = null
  const variables: Record<string, unknown> = {}
  for (let at = 1; at < args.length; at++) {
    const arg = args[at] ?? ''
    if (arg === '--method' || arg === '-X') method = args[++at] ?? method
    else if (arg === '--hostname') hostname = args[++at] ?? null
    else if (arg === '--input' || arg === '--repo') at++
    else if (arg === '-f' || arg === '-F') {
      const pair = args[++at] ?? ''
      const cut = pair.indexOf('=')
      const key = pair.slice(0, cut)
      const raw = pair.slice(cut + 1)
      const value = arg === '-F' && /^-?\d+$/.test(raw) ? Number(raw) : raw
      if (key.endsWith('[]')) {
        const list = (variables[key.slice(0, -2)] as unknown[] | undefined) ?? []
        list.push(value)
        variables[key.slice(0, -2)] = list
      } else variables[key] = value
    } else if (!arg.startsWith('-') && endpoint === '' && args[0] === 'api') endpoint = arg
  }
  if (args[0] === 'api' && endpoint === 'graphql' && !args.includes('--method')) method = 'POST'
  if (args[0] === 'pr') {
    const repo = args.includes('--repo') ? (args[args.indexOf('--repo') + 1] ?? '') : ''
    const parts = repo.split('/')
    hostname = parts.length === 3 ? (parts[0] ?? null) : null
  }
  const host = hostname ?? request.env.GH_HOST ?? 'github.com'
  const [path = '', search = ''] = endpoint.split('?')
  const query = typeof variables.query === 'string' ? variables.query : ''
  const operation = /^\s*query\s+(\w+)/.exec(query)?.[1] ?? null
  let input: unknown
  if (request.input !== undefined) {
    try {
      input = JSON.parse(request.input)
    } catch {
      input = request.input
    }
  }
  return { args, host, method, endpoint, path, query: new URLSearchParams(search), operation, variables, input }
}

function field(input: unknown, key: string): unknown {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>)[key] : undefined
}

function ok(value: unknown): FakeAnswer {
  return { code: 0, stdout: JSON.stringify(value) }
}

function notFound(): FakeAnswer {
  return {
    code: 1,
    stdout: JSON.stringify({ message: 'Not Found', documentation_url: 'https://docs.github.com/rest', status: '404' }),
    stderr: 'gh: Not Found (HTTP 404)',
  }
}

function invalid(name: string): FakeAnswer {
  return {
    code: 1,
    stdout: JSON.stringify({ message: 'Validation Failed', errors: [{ field: name, code: 'invalid' }] }),
    stderr: 'gh: Validation Failed (HTTP 422)',
  }
}
