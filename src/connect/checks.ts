// The checks of the connection wizard's step 2 (Ф1, point 2), each on its own: the project is a git repository whose
// `origin` is a GitHub repository, fetched from and pushed to alike; `gh` is installed, logged in, and its user may
// write to that repository; the agents of the settings are known to Orca. «Подключить» runs them again before it
// writes anything (./connect.ts): a check's answer is a reading of the moment, not a promise. Only projects of this
// computer are checked (./projects.ts): nothing here runs for a project of another host.
//
// - git: the repository's GitHub repository is read from `remote.origin.url` as the repository's configuration has it
//   (`https://<host>/<owner>/<name>[.git]`, `ssh://git@<host>[:port]/<owner>/<name>[.git]` or
//   `git@<host>:<owner>/<name>[.git]`, on github.com — or ssh.github.com — or a GitHub Enterprise Cloud host
//   `*.ghe.com`); no `origin`, or one that is not such a URL — «нет удалённого репозитория GitHub». The URL is taken as
//   configured, before any `url.*.insteadOf` rewrite: that is the repository the owner named, and the one gh checks
//   and writes the labels to. Fetch and push of `origin` must reach that very repository: every `remote.origin.url` and
//   `remote.origin.pushurl` names it (in any of the forms above), and so do the addresses git really uses after its
//   rewrites (`url.*.insteadOf`, `url.*.pushInsteadOf`) — the fetch address and each push address; otherwise
//   `push-elsewhere`. These confirmed addresses are what the connection fetches from and pushes to, by URL, not by the
//   name `origin` read again later (./connect.ts checks them again right before the push). The base branches
//   the form offers are the branches of `origin` this clone knows; the default one there is the clone's idea of the
//   repository's default branch (the gh check tells GitHub's own).
// - gh: `gh` in PATH; the user gh runs as (`gh auth login` done: gh's exit 4 or its «gh auth login» means no login);
//   GitHub's `permissions` of the repository for that user (push, maintain or admin), and its default branch now.
// - agents: the agents Orca knows on this computer (src/platform/orca-agents.ts) and the default agents of the roles
//   (DEFAULT_AGENTS): all known — ok; some not — a problem that names them, the form still opens (the owner picks
//   another agent there); none at all, or the list not read — the form does not open.
import { GitHub } from '../github/github'
import { DEFAULT_HOST, GitHubError, isRepository, type Repository } from '../github/gh'
import { commandEnv } from '../platform/folders'
import { errorMessage, type Machine } from '../platform/machine'
import { readOrcaAgents, type OrcaAgent } from '../platform/orca-agents'
import { resolveCommand, runProgram, type RunResult } from '../platform/run'
import { defaultBranch, remoteBranches } from '../project/base-branch'
import { AGENT_ROLES, DEFAULT_AGENTS } from '../project/settings'
import type { AgentsCheck, GhCheck, GitCheck, RoleAgents } from '../protocol'

const GIT_TIMEOUT_MS = 60_000

// The GitHub repository of a remote URL, or null when the URL names none.
export function githubRepositoryOf(url: string): Repository | null {
  const text = url.trim()
  let host: string
  let path: string
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(?!\/)(.+)$/.exec(text)
  if (scp) {
    host = scp[1] ?? ''
    path = scp[2] ?? ''
  } else {
    const web = /^(?:https:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?)([A-Za-z0-9.-]+)(?::\d{1,5})?\/(.+)$/.exec(text)
    if (!web) return null
    host = web[1] ?? ''
    path = web[2] ?? ''
  }
  host = host.toLowerCase()
  if (host === 'ssh.github.com' || host === 'www.github.com') host = DEFAULT_HOST
  if (host !== DEFAULT_HOST && !host.endsWith('.ghe.com')) return null
  const parts = path.replace(/\/+$/, '').replace(/\.git$/, '').split('/')
  if (parts.length !== 2) return null
  const repository = { host, owner: parts[0] ?? '', name: parts[1] ?? '' }
  return isRepository(repository) ? repository : null
}

// Whether two repositories are one: GitHub names have no case.
export function sameRepository(a: Repository, b: Repository): boolean {
  return a.host === b.host && a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase()
}

// Whether an address git uses names `repository`.
function reaches(url: string, repository: Repository): boolean {
  const named = githubRepositoryOf(url)
  return named !== null && sameRepository(named, repository)
}

// The repository as people and `gh --repo` name it: `owner/name` on github.com, `host/owner/name` elsewhere.
export function repositoryName(repository: Repository): string {
  const slug = `${repository.owner}/${repository.name}`
  return repository.host === DEFAULT_HOST ? slug : `${repository.host}/${slug}`
}

// The addresses of `origin` git really uses, each confirmed to name the repository: the one fetch uses and the one push
// uses.
export type OriginUrls = { readonly fetch: string; readonly push: string }

export type GitReading = { readonly check: GitCheck; readonly repository: Repository | null; readonly urls: OriginUrls | null }

function git(machine: Machine, path: string, args: string[]): Promise<RunResult> {
  return runProgram(machine, 'git', args, { cwd: path, timeoutMs: GIT_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: '0' } })
}

// The values of a configuration key (`--get-all`): none when it is not set; null when git failed.
async function configValues(machine: Machine, path: string, key: string): Promise<string[] | null> {
  const result = await git(machine, path, ['config', '--get-all', key])
  if (result.error !== null) return null
  if (result.code === 1) return []
  if (result.code !== 0) return null
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
}

// The GitHub repository of the checkout's `origin` (its first `remote.origin.url`), or null when there is none or git
// cannot tell.
export async function originRepository(machine: Machine, path: string): Promise<Repository | null> {
  const urls = await configValues(machine, path, 'remote.origin.url')
  return urls === null || urls[0] === undefined ? null : githubRepositoryOf(urls[0])
}

// The addresses `origin` really uses, when every one of them — as configured and after git's rewrites — names
// `repository`; `elsewhere` when one does not; null when git cannot tell.
export async function originUrls(machine: Machine, path: string, repository: Repository): Promise<OriginUrls | 'elsewhere' | null> {
  const urls = await configValues(machine, path, 'remote.origin.url')
  const pushUrls = await configValues(machine, path, 'remote.origin.pushurl')
  if (urls === null || pushUrls === null) return null
  if (![...urls, ...pushUrls].every((url) => reaches(url, repository))) return 'elsewhere'
  const fetchUrl = await git(machine, path, ['remote', 'get-url', 'origin'])
  const pushTo = await git(machine, path, ['remote', 'get-url', '--push', '--all', 'origin'])
  if (fetchUrl.error !== null || fetchUrl.code !== 0 || pushTo.error !== null || pushTo.code !== 0) return null
  const fetch = fetchUrl.stdout.trim()
  const pushes = pushTo.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  const push = pushes[0]
  if (push === undefined || !reaches(fetch, repository) || !pushes.every((one) => reaches(one, repository))) return 'elsewhere'
  return { fetch, push }
}

// Step 2, git: the project's checkout at `path`.
export async function checkGit(machine: Machine, path: string): Promise<GitReading> {
  const top = await git(machine, path, ['rev-parse', '--show-toplevel'])
  if (top.error !== null && top.error.kind !== 'not_found') return unchecked(`git: ${top.error.reason}`)
  if (top.error !== null) return unchecked(`git is not installed: ${top.error.reason}`)
  if (top.code !== 0) return { check: { status: 'problem', problem: 'not-git' }, repository: null, urls: null }
  const configured = await configValues(machine, path, 'remote.origin.url')
  if (configured === null) return unchecked('git config of remote.origin failed')
  const repository = configured[0] === undefined ? null : githubRepositoryOf(configured[0])
  if (repository === null) return { check: { status: 'problem', problem: 'no-github' }, repository: null, urls: null }
  const urls = await originUrls(machine, path, repository)
  if (urls === null) return { check: { status: 'unchecked', error: 'git remote get-url origin failed' }, repository, urls: null }
  if (urls === 'elsewhere') return { check: { status: 'problem', problem: 'push-elsewhere' }, repository, urls: null }
  try {
    const branches = (await remoteBranches(machine, path)).map((one) => one.branch)
    if (branches.length === 0) return { check: { status: 'problem', problem: 'no-branches' }, repository, urls }
    const main = await defaultBranch(machine, path)
    const ordered = [main, ...branches.filter((branch) => branch !== main).sort()]
    return { check: { status: 'ok', repository: repositoryName(repository), branches: ordered, defaultBranch: main }, repository, urls }
  } catch (error) {
    return { check: { status: 'unchecked', error: errorMessage(error) }, repository, urls }
  }
}

function unchecked(error: string): GitReading {
  return { check: { status: 'unchecked', error }, repository: null, urls: null }
}

// Step 2, gh: for the project's repository.
export async function checkGh(machine: Machine, repository: Repository): Promise<GhCheck> {
  if (resolveCommand({ ...machine, env: commandEnv(machine) }, 'gh') === null) return { status: 'problem', problem: 'not-installed' }
  // The language and patterns of the check before a write: this check writes nothing.
  const github = new GitHub({ machine, repository, settings: { language: 'en', forbiddenPatterns: [] } })
  let login: string
  try {
    login = await github.owner()
  } catch (error) {
    if (notLoggedIn(error)) return { status: 'problem', problem: 'not-logged-in' }
    return { status: 'unchecked', error: errorMessage(error) }
  }
  try {
    const access = await github.access()
    return access.write ? { status: 'ok', login, defaultBranch: access.defaultBranch } : { status: 'problem', problem: 'no-write' }
  } catch (error) {
    if (notLoggedIn(error)) return { status: 'problem', problem: 'not-logged-in' }
    if (error instanceof GitHubError && error.status === 404) return { status: 'problem', problem: 'no-repository' }
    return { status: 'unchecked', error: errorMessage(error) }
  }
}

// gh says it has no login: exit 4 (gh's «authentication required»), or its advice to run `gh auth login`.
function notLoggedIn(error: unknown): boolean {
  return error instanceof GitHubError && (error.code === 4 || /gh auth login/.test(error.ghText))
}

export type AgentsReading = { readonly check: AgentsCheck; readonly agents: readonly OrcaAgent[] | null }

// The check of the agents a list gives: the default agents of the roles among them, or not; an empty list.
export function agentsCheckOf(agents: readonly OrcaAgent[]): AgentsCheck {
  if (agents.length === 0) return { status: 'problem', problem: 'empty' }
  const defaults: RoleAgents<string> = { ...DEFAULT_AGENTS }
  const missing = [...new Set(AGENT_ROLES.map((role) => defaults[role]))].filter((id) => !agents.some((agent) => agent.id === id))
  if (missing.length > 0) return { status: 'problem', problem: 'missing', missing, agents: [...agents], defaults }
  return { status: 'ok', agents: [...agents], defaults }
}

// Step 2, agents: the list Orca gives now and the default agents of the roles.
export async function checkAgents(machine: Machine): Promise<AgentsReading> {
  const reading = await readOrcaAgents(machine)
  if (!reading.ok) return { check: { status: 'unchecked', failure: reading.failure }, agents: null }
  return { check: agentsCheckOf(reading.agents), agents: [...reading.agents] }
}
