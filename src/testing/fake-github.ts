// A fake GitHub behind a fake `gh` for the plugin's tests (TZ: «Только подделки» — no network, no real GitHub, never the
// real gh of this computer). The fake computer (fake-machine.ts) has `gh` in its PATH, records every start with its
// arguments and standard input, and this fake answers it the way `gh` answers: `gh api` with REST endpoints of one
// repository — JSON on stdout, an error text on stderr and exit 1 — and `gh pr ready`. It keeps issues, comments,
// labels and pull requests in memory and changes them on writes.
//
// Lists come in pages of `pageSize`, printed one after another like `gh api --paginate` does. A test can make a call
// fail — with the change made anyway, as when GitHub's answer is lost — or answer what it likes.
import type { StartRequest } from '../platform/machine'
import { fakeMachine, type FakeAnswer, type FakeMachine } from './fake-machine'

export const FAKE_GH = '/usr/bin/gh'

export type FakeUser = { readonly login: string }

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
}

export type FakeComment = { id: number; issue: number; body: string; user: string; created_at: string; updated_at: string }

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
  readonly method: string
  readonly endpoint: string
  readonly path: string
  readonly query: URLSearchParams
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
  // The repository `owner/name` the fake serves; calls for any other get 404.
  readonly repository: string
  // The GitHub user gh runs as; null — `gh api user` fails (gh is not logged in).
  readonly login: string | null
  readonly pageSize?: number
  readonly env?: Record<string, string>
}

export class FakeGitHub {
  readonly repository: string
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
      ...issue,
    }
    this.issues.push(full)
    return full
  }

  addComment(issue: number, user: string, body: string): FakeComment {
    const time = this.tick()
    const comment = { id: this.nextComment++, issue, body, user, created_at: time, updated_at: time }
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
    if (call.args[0] === 'pr' && call.args[1] === 'ready') return this.prReady(call.args)
    if (call.args[0] !== 'api') return { code: 1, stderr: `fake gh: unknown command ${call.args.join(' ')}` }
    if (call.path === 'user') {
      if (this.login === null) {
        return { code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' }
      }
      return ok({ login: this.login, id: 1001, type: 'User' })
    }
    const prefix = `repos/${this.repository}/`
    if (!call.path.startsWith(prefix)) return notFound()
    const rest = call.path.slice(prefix.length).split('/')
    const paginate = call.args.includes('--paginate')
    const [what, id, sub, name] = rest
    const number = Number(id)
    if (what === 'issues' && id === undefined) {
      if (call.method === 'GET') return this.page(this.issueList(call.query), paginate)
      if (call.method === 'POST') return this.createIssue(call.input)
    }
    if (what === 'issues' && id !== undefined && sub === undefined) {
      const issue = this.issues.find((one) => one.number === number)
      const pull = this.pulls.find((one) => one.number === number)
      if (call.method === 'GET') {
        if (issue) return ok(this.issueJson(issue))
        if (pull) return ok(this.pullAsIssue(pull))
        return notFound()
      }
      if (call.method === 'PATCH' && issue) return this.patchIssue(issue, call.input)
      return notFound()
    }
    if (what === 'issues' && sub === 'comments') {
      if (call.method === 'GET') {
        return this.page(
          this.comments.filter((one) => one.issue === number).map((one) => this.commentJson(one)),
          paginate,
        )
      }
      if (call.method === 'POST') {
        const body = field(call.input, 'body')
        if (typeof body !== 'string' || body === '') return invalid('body')
        if (this.login === null) return { code: 4, stderr: 'gh auth login' }
        return ok(this.commentJson(this.addComment(number, this.login, body)))
      }
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
          return { code: 1, stdout: JSON.stringify({ message: 'Label does not exist' }), stderr: 'gh: Label does not exist (HTTP 404)' }
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
            stdout: JSON.stringify({ message: 'Validation Failed', errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }] }),
            stderr: 'gh: Validation Failed (HTTP 422)',
          }
        }
        const created = { name: label, color: String(field(call.input, 'color')), description: String(field(call.input, 'description') ?? '') }
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

  private issueList(query: URLSearchParams): Record<string, unknown>[] {
    const state = query.get('state') ?? 'open'
    const labels = (query.get('labels') ?? '').split(',').filter((label) => label !== '')
    // GitHub lists pull requests among issues.
    const all = [
      ...this.issues.map((issue) => ({ at: issue.created_at, number: issue.number, json: this.issueJson(issue), labels: issue.labels, state: issue.state })),
      ...this.pulls.map((pull) => ({ at: '', number: pull.number, json: this.pullAsIssue(pull), labels: [] as string[], state: pull.state })),
    ]
    return all
      .filter((one) => state === 'all' || one.state === state)
      .filter((one) => labels.every((label) => one.labels.includes(label)))
      .sort((a, b) => a.number - b.number)
      .map((one) => one.json)
  }

  // A list as gh --paginate prints it: each page a JSON array, one after another; without --paginate only the first.
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
    if (this.login === null) return { code: 4, stderr: 'gh auth login' }
    const labels = field(input, 'labels')
    const number = Math.max(0, ...this.issues.map((one) => one.number), ...this.pulls.map((one) => one.number)) + 1
    const issue = this.addIssue({
      number,
      user: this.login,
      title,
      body: String(field(input, 'body') ?? ''),
      labels: Array.isArray(labels) ? labels.map(String) : [],
    })
    return ok(this.issueJson(issue))
  }

  private patchIssue(issue: FakeIssue, input: unknown): FakeAnswer {
    const title = field(input, 'title')
    const body = field(input, 'body')
    const state = field(input, 'state')
    const reason = field(input, 'state_reason')
    if (typeof title === 'string') issue.title = title
    if (typeof body === 'string') issue.body = body
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
    if (this.login === null) return { code: 4, stderr: 'gh auth login' }
    const number = Math.max(0, ...this.issues.map((one) => one.number), ...this.pulls.map((one) => one.number)) + 1
    const pull = this.addPull({
      number,
      head,
      base,
      title,
      body: String(field(input, 'body') ?? ''),
      draft: field(input, 'draft') === true,
      user: this.login,
    })
    return ok(this.pullJson(pull))
  }

  private prReady(args: readonly string[]): FakeAnswer {
    const repo = args[args.indexOf('--repo') + 1]
    if (!args.includes('--repo') || repo !== this.repository) return { code: 1, stderr: 'GraphQL: Could not resolve to a Repository' }
    const pull = this.pulls.find((one) => one.number === Number(args[2]))
    if (!pull) return { code: 1, stderr: `GraphQL: Could not resolve to a PullRequest with the number of ${args[2]}.` }
    pull.draft = args.includes('--undo')
    return { code: 0, stdout: '' }
  }

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
      html_url: `https://github.com/${this.repository}/issues/${issue.number}`,
    }
  }

  commentJson(comment: FakeComment): Record<string, unknown> {
    return {
      id: comment.id,
      body: comment.body,
      user: { login: comment.user, type: 'User' },
      created_at: comment.created_at,
      updated_at: comment.updated_at,
      html_url: `https://github.com/${this.repository}/issues/${comment.issue}#issuecomment-${comment.id}`,
      issue_url: `https://api.github.com/repos/${this.repository}/issues/${comment.issue}`,
    }
  }

  private pullAsIssue(pull: FakePull): Record<string, unknown> {
    return {
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      labels: [],
      user: { login: pull.user },
      created_at: '2026-01-15T09:00:00Z',
      updated_at: '2026-01-15T09:00:00Z',
      closed_at: null,
      html_url: `https://github.com/${this.repository}/pull/${pull.number}`,
      pull_request: { url: `https://api.github.com/repos/${this.repository}/pulls/${pull.number}` },
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
      html_url: `https://github.com/${this.repository}/pull/${pull.number}`,
    }
  }
}

function readCall(request: StartRequest): FakeGhCall {
  const args = request.args
  let method = 'GET'
  let endpoint = ''
  for (let at = 1; at < args.length; at++) {
    const arg = args[at] ?? ''
    if (arg === '--method' || arg === '-X') method = args[++at] ?? method
    else if (arg === '--input') at++
    else if (!arg.startsWith('-') && endpoint === '' && args[0] === 'api') endpoint = arg
  }
  const [path = '', search = ''] = endpoint.split('?')
  let input: unknown
  if (request.input !== undefined) {
    try {
      input = JSON.parse(request.input)
    } catch {
      input = request.input
    }
  }
  return { args, method, endpoint, path, query: new URLSearchParams(search), input }
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
