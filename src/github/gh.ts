// Running `gh` for the GitHub layer (TZ «Интеграции»: GitHub через gh). The plugin keeps no tokens: `gh` works with its
// own login (`gh auth login`), and the plugin never asks it for a token or reads its configuration. `gh` starts through
// the platform layer (src/platform/run.ts), with the worker's environment.
//
// - Every call names the repository itself: `repos/<owner>/<name>/…` for `gh api`, `--repo <owner>/<name>` for other
//   commands. gh's default repository (the checkout's remote, GH_REPO) is never used.
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

// What gh itself must not do in a worker: ask anything, or check for its own updates.
const GH_ENV = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' }

// A repository on GitHub: owner (user or organisation) and name.
export type Repository = { readonly owner: string; readonly name: string }

const OWNER_FORM = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const NAME_FORM = /^[A-Za-z0-9._-]{1,100}$/

// `owner/name` → a Repository; anything else (a URL, a path, blanks) is an error.
export function parseRepository(slug: string): Repository {
  const parts = slug.split('/')
  const [owner, name] = parts
  if (parts.length !== 2 || owner === undefined || name === undefined || !isRepository({ owner, name })) {
    throw new Error(`not a GitHub repository «owner/name»: ${JSON.stringify(slug)}`)
  }
  return { owner, name }
}

export function isRepository(repository: Repository): boolean {
  return (
    OWNER_FORM.test(repository.owner) &&
    NAME_FORM.test(repository.name) &&
    repository.name !== '.' &&
    repository.name !== '..'
  )
}

export function repositorySlug(repository: Repository): string {
  return `${repository.owner}/${repository.name}`
}

// The REST path of the repository's `rest` (`issues/7/comments` …).
export function repositoryPath(repository: Repository, rest: string): string {
  if (!isRepository(repository)) throw new Error(`not a GitHub repository: ${JSON.stringify(repository)}`)
  return `repos/${repository.owner}/${repository.name}/${rest}`
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
  // The GitHub user gh runs as is unknown: no texts can be told apart.
  | 'owner_unknown'

// A failure of a GitHub call. `message` carries gh's own text (its stderr, or why it did not run).
export class GitHubError extends Error {
  readonly kind: GitHubErrorKind
  // The arguments gh got (no bodies: those go on stdin).
  readonly args: readonly string[]
  readonly code: number | null
  // The HTTP status gh reported (`… (HTTP 404)`), when it did.
  readonly status: number | null
  // gh's own text: its stderr, or the reason it did not run.
  readonly ghText: string

  constructor(
    kind: GitHubErrorKind,
    args: readonly string[],
    detail: { readonly code?: number | null; readonly ghText: string; readonly what?: string },
  ) {
    const exit = detail.code === undefined || detail.code === null ? '' : ` (exit ${detail.code})`
    super(`gh ${args.join(' ')}${exit}: ${detail.what ?? detail.ghText}`)
    this.name = 'GitHubError'
    this.kind = kind
    this.args = args
    this.code = detail.code ?? null
    this.ghText = detail.ghText
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
    const said = ghSaid(result)
    throw new GitHubError(kind, args, { ghText: said ? `${result.error.reason}; ${said}` : result.error.reason })
  }
  if (result.code !== 0) {
    throw new GitHubError('gh_failed', args, {
      code: result.code,
      ghText: ghSaid(result) || `no output${result.signal ? `, ended by ${result.signal}` : ''}`,
    })
  }
  return result
}

// gh's own text about a run: its stderr, otherwise its stdout (gh api prints GitHub's error body there).
function ghSaid(result: RunResult): string {
  return result.stderr.trim() || result.stdout.trim()
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

// Every item of a paginated list: `gh api --paginate <endpoint>` prints each page as its own JSON array, one after
// another. All pages must be whole arrays; anything else — no page at all, a page that is not an array, output cut in
// memory — is an error, never a shorter list.
export async function ghList(call: GhCall): Promise<Record<string, unknown>[]> {
  if (!call.args.includes('--paginate')) throw new Error('ghList needs --paginate: a list is read whole')
  const result = await runGh({ ...call, timeoutMs: call.timeoutMs ?? GH_LIST_TIMEOUT_MS })
  if (result.truncated) throw badAnswer(call.args, 'the answer was cut in memory: the list is not whole', result)
  let pages: unknown[]
  try {
    pages = jsonValues(result.stdout)
  } catch (error) {
    throw badAnswer(call.args, `not whole JSON pages (${errorMessage(error)})`, result)
  }
  if (pages.length === 0) throw badAnswer(call.args, 'no page at all', result)
  const items: Record<string, unknown>[] = []
  for (const page of pages) {
    if (!Array.isArray(page)) throw badAnswer(call.args, 'a page is not a JSON array', result)
    for (const item of page) {
      if (!isObject(item)) throw badAnswer(call.args, 'an item of the list is not a JSON object', result)
      items.push(item)
    }
  }
  return items
}

function parseAnswer(args: readonly string[], result: RunResult): unknown {
  if (result.truncated) throw badAnswer(args, 'the answer was cut in memory', result)
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    throw badAnswer(args, `not JSON (${errorMessage(error)})`, result)
  }
}

function badAnswer(args: readonly string[], what: string, result: RunResult): GitHubError {
  const said = ghSaid(result)
  const head = said.length > 300 ? `${said.slice(0, 300)}…` : said
  return new GitHubError('bad_answer', args, {
    code: result.code,
    ghText: said,
    what: `gh answered ${what}${head ? `: ${head}` : ''}`,
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
    values.push(JSON.parse(text.slice(start, at)))
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
