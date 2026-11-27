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
//   configured, before any `url.*.insteadOf` rewrite: that is the repository the owner named. A push of `origin` must
//   go where its fetch comes from: every `remote.origin.url` and `remote.origin.pushurl` names that same repository (in
//   any of the forms above), and the addresses git really uses after its rewrites — each push address against the fetch
//   address — are the same address or name the same GitHub repository; otherwise `push-elsewhere`. The base branches
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

// Whether two addresses git uses lead to one repository: the same address, or two forms of one GitHub repository.
function sameTarget(a: string, b: string): boolean {
  if (a.trim() === b.trim()) return true
  const left = githubRepositoryOf(a)
  const right = githubRepositoryOf(b)
  return left !== null && right !== null && sameRepository(left, right)
}

// The repository as people and `gh --repo` name it: `owner/name` on github.com, `host/owner/name` elsewhere.
export function repositoryName(repository: Repository): string {
  const slug = `${repository.owner}/${repository.name}`
  return repository.host === DEFAULT_HOST ? slug : `${repository.host}/${slug}`
}

export type GitReading = { readonly check: GitCheck; readonly repository: Repository | null }

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

// Step 2, git: the project's checkout at `path`.
export async function checkGit(machine: Machine, path: string): Promise<GitReading> {
  const top = await git(machine, path, ['rev-parse', '--show-toplevel'])
  if (top.error !== null && top.error.kind !== 'not_found') return unchecked(`git: ${top.error.reason}`)
  if (top.error !== null) return unchecked(`git is not installed: ${top.error.reason}`)
  if (top.code !== 0) return { check: { status: 'problem', problem: 'not-git' }, repository: null }
  const urls = await configValues(machine, path, 'remote.origin.url')
  const pushUrls = await configValues(machine, path, 'remote.origin.pushurl')
  if (urls === null || pushUrls === null) return unchecked('git config of remote.origin failed')
  const repository = urls[0] === undefined ? null : githubRepositoryOf(urls[0])
  if (repository === null) return { check: { status: 'problem', problem: 'no-github' }, repository: null }
  const elsewhere = { check: { status: 'problem', problem: 'push-elsewhere' } as const, repository }
  for (const url of [...urls, ...pushUrls]) {
    const named = githubRepositoryOf(url)
    if (named === null || !sameRepository(named, repository)) return elsewhere
  }
  // The addresses git really uses, after url.*.insteadOf and url.*.pushInsteadOf.
  const fetchUrl = await git(machine, path, ['remote', 'get-url', 'origin'])
  const pushTo = await git(machine, path, ['remote', 'get-url', '--push', '--all', 'origin'])
  if (fetchUrl.error !== null || fetchUrl.code !== 0 || pushTo.error !== null || pushTo.code !== 0) {
    return { check: { status: 'unchecked', error: 'git remote get-url origin failed' }, repository }
  }
  const pushes = pushTo.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  if (pushes.length === 0 || !pushes.every((push) => sameTarget(push, fetchUrl.stdout))) return elsewhere
  try {
    const branches = (await remoteBranches(machine, path)).map((one) => one.branch)
    if (branches.length === 0) return { check: { status: 'problem', problem: 'no-branches' }, repository }
    const main = await defaultBranch(machine, path)
    const ordered = [main, ...branches.filter((branch) => branch !== main).sort()]
    return { check: { status: 'ok', repository: repositoryName(repository), branches: ordered, defaultBranch: main }, repository }
  } catch (error) {
    return { check: { status: 'unchecked', error: errorMessage(error) }, repository }
  }
}

function unchecked(error: string): GitReading {
  return { check: { status: 'unchecked', error }, repository: null }
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
