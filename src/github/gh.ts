// Running `gh` for the GitHub layer (TZ «Интеграции»: GitHub через gh). The plugin keeps no tokens: `gh` works with its
// own login (`gh auth login`), and the plugin never asks it for a token or reads its configuration. `gh` starts through
// the platform layer (src/platform/run.ts), with the worker's environment.
//
// - Every call names the host and the repository itself: `gh api --hostname <host>` with `repos/<owner>/<name>/…` or
//   GraphQL variables `owner` and `name`; `--repo <host>/<owner>/<name>` for other commands. gh's default host
//   (GH_HOST, its configuration) and default repository (the checkout's remote, GH_REPO) are never used.
// - A failure is an error that carries gh's own text: a non-zero exit (stderr), a program that did not start, a run
//   that timed out, an answer that is not the expected JSON. Never an empty answer in its place.
// - A list is read whole: `gh api --paginate` follows every page, and a list cut short — gh failed on a later page, its
//   output was cut in memory, a page is not whole — is an error, never a shorter list.
// - Bodies (comment, issue and PR texts) go to `gh api --input -` on standard input as JSON: no limit of the command
//   line, no flag magic of `-F` (`@file`) on the text.
import { errorMessage, type Machine } from '../platform/machine'
import { runProgram, type RunResult } from '../platform/run'

// How long one call of gh may take; a whole paginated list gets longer.
export const GH_TIMEOUT_MS = 120_000
export const GH_LIST_TIMEOUT_MS = 600_000

// What gh itself must not do in a worker: ask anything, check for its own updates, or trace its HTTP traffic — a trace
// (GH_DEBUG=api, or DEBUG=api while GH_DEBUG is not set) writes the response bodies, texts of any author, to stderr,
// which is gh's text in an error. GH_DEBUG set to 0 turns gh's logging and tracing off whatever DEBUG says (an empty
// value would not reach gh on Windows).
const GH_ENV = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_DEBUG: '0' }

export const DEFAULT_HOST = 'github.com'

// A repository: its host (github.com, or a GitHub Enterprise host), owner (user or organisation) and name.
export type Repository = { readonly host: string; readonly owner: string; readonly name: string }

const HOST_FORM = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::\d{1,5})?$/
const OWNER_FORM = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const NAME_FORM = /^[A-Za-z0-9._-]{1,100}$/

// `owner/name` (on github.com) or `host/owner/name` → a Repository; anything else (a URL, a path, blanks) is an error.
export function parseRepository(slug: string): Repository {
  const parts = slug.split('/')
  const [host, owner, name] = parts.length === 2 ? [DEFAULT_HOST, ...parts] : parts
  if (parts.length < 2 || parts.length > 3 || host === undefined || owner === undefined || name === undefined) {
    throw new Error(`not a GitHub repository «owner/name» or «host/owner/name»: ${JSON.stringify(slug)}`)
  }
  const repository = { host: host.toLowerCase(), owner, name }
  if (!isRepository(repository)) {
    throw new Error(`not a GitHub repository «owner/name» or «host/owner/name»: ${JSON.stringify(slug)}`)
  }
  return repository
}

export function isRepository(repository: Repository): boolean {
  return (
    HOST_FORM.test(repository.host) &&
    OWNER_FORM.test(repository.owner) &&
    NAME_FORM.test(repository.name) &&
    repository.name !== '.' &&
    repository.name !== '..'
  )
}

// `owner/name`.
export function repositorySlug(repository: Repository): string {
  return `${repository.owner}/${repository.name}`
}

// `host/owner/name`: the form of `--repo` that names the host too.
export function repositoryRef(repository: Repository): string {
  checkRepository(repository)
  return `${repository.host}/${repository.owner}/${repository.name}`
}

// The REST path of the repository's `rest` (`issues/7/comments` …).
export function repositoryPath(repository: Repository, rest: string): string {
  checkRepository(repository)
  return `repos/${repository.owner}/${repository.name}/${rest}`
}

// The start of every `gh api` call for the repository: its host named.
export function apiArgs(repository: Repository): string[] {
  checkRepository(repository)
  return ['api', '--hostname', repository.host]
}

function checkRepository(repository: Repository): void {
  if (!isRepository(repository)) throw new Error(`not a GitHub repository: ${JSON.stringify(repository)}`)
}

export type GitHubErrorKind =
  // gh ran and exited with a non-zero code.
  | 'gh_failed'
  // gh is not installed (not in PATH) or the system did not start it.
  | 'gh_not_started'
  // gh gave no answer in time and was stopped.
  | 'gh_timed_out'
  // gh exited 0, but its answer is not the expected JSON (or a list in it is not whole).
  | 'bad_answer'
  // The GitHub user gh runs as is unknown, or changed within one read: no texts can be told apart.
  | 'owner_unknown'
  // What GitHub has cannot confirm a state the plugin needs (an operation's comment changed by someone else).
  | 'unconfirmed'

// GitHub's own words in a refusal (the error body of a REST call that gh prints): its `message` and the `code`s of its
// `errors` — nothing else of gh's output.
export type Refusal = { readonly message: string | null; readonly codes: readonly string[] }

const NO_REFUSAL: Refusal = { message: null, codes: [] }

// A failure of a GitHub call. `message` carries gh's own text: its stderr, or why it did not run. What gh printed on
// stdout is never kept — after a failed page it may hold texts of any author — only GitHub's refusal read from it.
export class GitHubError extends Error {
  readonly kind: GitHubErrorKind
  // The arguments gh got (no bodies: those go on stdin).
  readonly args: readonly string[]
  readonly code: number | null
  // The HTTP status gh reported (`… (HTTP 404)`), when it did; null when GitHub gave no answer gh could report.
  readonly status: number | null
  // gh's own text: its stderr, or the reason it did not run.
  readonly ghText: string
  readonly refusal: Refusal

  constructor(
    kind: GitHubErrorKind,
    args: readonly string[],
    detail: { readonly code?: number | null; readonly ghText: string; readonly what?: string; readonly refusal?: Refusal },
  ) {
    const exit = detail.code === undefined || detail.code === null ? '' : ` (exit ${detail.code})`
    super(`gh ${args.join(' ')}${exit}: ${detail.what ?? detail.ghText}`)
    this.name = 'GitHubError'
    this.kind = kind
    this.args = args
    this.code = detail.code ?? null
    this.ghText = detail.ghText
    this.refusal = detail.refusal ?? NO_REFUSAL
    const status = /\(HTTP (\d{3})\)/.exec(detail.ghText)
    this.status = status ? Number(status[1]) : null
  }
}

export type GhCall = {
  readonly machine: Machine
  readonly args: readonly string[]
  // JSON sent on stdin (`--input -`).
  readonly input?: unknown
  readonly timeoutMs?: number
}

// Runs gh; any failure to run or a non-zero exit is a GitHubError with gh's text.
export async function runGh(call: GhCall): Promise<RunResult> {
  const { machine, args } = call
  let result: RunResult
  try {
    result = await runProgram(machine, 'gh', args, {
      env: GH_ENV,
      timeoutMs: call.timeoutMs ?? GH_TIMEOUT_MS,
      ...(call.input === undefined ? {} : { input: JSON.stringify(call.input) }),
    })
  } catch (error) {
    throw new GitHubError('gh_not_started', args, { ghText: errorMessage(error) })
  }
  if (result.error !== null) {
    const kind = result.error.kind === 'timed_out' ? 'gh_timed_out' : 'gh_not_started'
    const said = result.stderr.trim()
    throw new GitHubError(kind, args, { ghText: said ? `${result.error.reason}; ${said}` : result.error.reason })
  }
  if (result.code !== 0) {
    const refusal = refusalIn(result.stdout)
    throw new GitHubError('gh_failed', args, {
      code: result.code,
      ghText: result.stderr.trim() || refusal.message || `no output${result.signal ? `, ended by ${result.signal}` : ''}`,
      refusal,
    })
  }
  return result
}

// GitHub's refusal in gh's stdout: one JSON object with a `message` (a REST error body). A GraphQL page (`data`) or
// anything else gives none.
function refusalIn(stdout: string): Refusal {
  let answer: unknown
  try {
    answer = JSON.parse(stdout)
  } catch {
    return NO_REFUSAL
  }
  if (!isObject(answer) || 'data' in answer || typeof answer.message !== 'string') return NO_REFUSAL
  const codes = Array.isArray(answer.errors)
    ? answer.errors.flatMap((one) => (isObject(one) && typeof one.code === 'string' && /^[a-z_]{1,40}$/.test(one.code) ? [one.code] : []))
    : []
  return { message: answer.message.slice(0, 200), codes }
}

// One JSON answer of `gh api` (an object).
export async function ghJson(call: GhCall): Promise<Record<string, unknown>> {
  const result = await runGh(call)
  const answer = parseAnswer(call.args, result)
  if (!isObject(answer)) throw badAnswer(call.args, 'not a JSON object', result)
  return answer
}

// One JSON answer of `gh api` that is a list (one page: e.g. the labels of an issue after a change).
export async function ghArray(call: GhCall): Promise<unknown[]> {
  const result = await runGh(call)
  const answer = parseAnswer(call.args, result)
  if (!Array.isArray(answer)) throw badAnswer(call.args, 'not a JSON array', result)
  return answer
}

// Every page of `gh api --paginate`: gh prints each page as its own JSON value, one after another (an array for REST,
// an object for GraphQL). All pages must be whole and of that kind; anything else — no page at all, a page of another
// kind, output cut in memory — is an error, never fewer pages.
export async function ghPages(call: GhCall, kind: 'array' | 'object'): Promise<unknown[]> {
  if (!call.args.includes('--paginate')) throw new Error('ghPages needs --paginate: a list is read whole')
  const result = await runGh({ ...call, timeoutMs: call.timeoutMs ?? GH_LIST_TIMEOUT_MS })
  if (result.truncated) throw badAnswer(call.args, 'the answer was cut in memory: the list is not whole', result)
  let pages: unknown[]
  try {
    pages = jsonValues(result.stdout)
  } catch (error) {
    throw badAnswer(call.args, `not whole JSON pages (${errorMessage(error)})`, result)
  }
  if (pages.length === 0) throw badAnswer(call.args, 'no page at all', result)
  for (const page of pages) {
    if (kind === 'array' ? !Array.isArray(page) : !isObject(page)) {
      throw badAnswer(call.args, `a page is not a JSON ${kind}`, result)
    }
  }
  return pages
}

// Every item of a paginated REST list, read whole (ghPages).
export async function ghList(call: GhCall): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = []
  for (const page of await ghPages(call, 'array')) {
    for (const item of page as unknown[]) {
      if (!isObject(item)) throw new GitHubError('bad_answer', call.args, { ghText: '', what: 'an item of the list is not a JSON object' })
      items.push(item)
    }
  }
  return items
}

// The answer as JSON. The parser's own message is not kept: it quotes a piece of the answer.
function parseAnswer(args: readonly string[], result: RunResult): unknown {
  if (result.truncated) throw badAnswer(args, 'the answer was cut in memory', result)
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw badAnswer(args, `not JSON (${result.stdout.length} characters)`, result)
  }
}

// An answer of another kind than expected: gh's stderr only, never its stdout.
function badAnswer(args: readonly string[], what: string, result: RunResult): GitHubError {
  const said = result.stderr.trim()
  return new GitHubError('bad_answer', args, {
    code: result.code,
    ghText: said,
    what: `gh answered ${what}${said ? `: ${said.slice(0, 300)}` : ''}`,
  })
}

// The JSON values written one after another in `text` (whitespace between them allowed): the pages of
// `gh api --paginate`. Each value must be an array or an object, whole.
export function jsonValues(text: string): unknown[] {
  const values: unknown[] = []
  let at = 0
  const blank = /\s/
  while (true) {
    while (at < text.length && blank.test(text[at] ?? '')) at++
    if (at >= text.length) return values
    const open = text[at]
    if (open !== '[' && open !== '{') throw new Error(`a value at ${at} is not an array or object`)
    const start = at
    let depth = 0
    let inString = false
    for (; at < text.length; at++) {
      const char = text[at]
      if (inString) {
        if (char === '\\') at++
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') inString = true
      else if (char === '[' || char === '{') depth++
      else if (char === ']' || char === '}') {
        depth--
        if (depth === 0) {
          at++
          break
        }
      }
    }
    if (depth !== 0 || inString) throw new Error(`the value at ${start} is not whole`)
    try {
      values.push(JSON.parse(text.slice(start, at)))
    } catch {
      throw new Error(`the value at ${start} is not valid JSON`)
    }
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
