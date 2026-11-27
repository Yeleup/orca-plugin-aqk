// The checks of the connection wizard's step 2 (Ф1, point 2), each on its own: the project is a git repository whose
// `origin` is a GitHub repository; `gh` is installed, logged in, and its user may write to that repository; the agents
// of the settings are known to Orca. «Подключить» runs them again before it writes anything (./connect.ts): a check's
// answer is a reading of the moment, not a promise.
//
// - git: the repository's GitHub repository is read from `remote.origin.url` as the repository's configuration has it
//   (`https://<host>/<owner>/<name>[.git]`, `ssh://git@<host>[:port]/<owner>/<name>[.git]` or `git@<host>:<owner>/<name>[.git]`,
//   on github.com — or ssh.github.com — or a GitHub Enterprise Cloud host `*.ghe.com`); no `origin`, or one that is not
//   such a URL — «нет удалённого репозитория GitHub». The URL is taken as configured, before any `url.*.insteadOf`
//   rewrite: that is the repository the owner named. The base branches the form offers are the branches of `origin`
//   this clone knows, and the default one is the repository's default branch (src/project/base-branch.ts).
// - gh: `gh` in PATH; the user gh runs as (`gh auth login` done: gh's exit 4 or its «gh auth login» means no login);
//   GitHub's `permissions` of the repository for that user (push, maintain or admin).
// - agents: the agents Orca knows on this computer (src/platform/orca-agents.ts) and the default agents of the roles
//   (DEFAULT_AGENTS): all known — ok; some not — a problem that names them, the form still opens (the owner picks
//   another agent there); none at all, or the list not read — the form does not open.
import { GitHub } from '../github/github'
import { DEFAULT_HOST, GitHubError, isRepository, type Repository } from '../github/gh'
import { commandEnv } from '../platform/folders'
import { errorMessage, type Machine } from '../platform/machine'
import { readOrcaAgents, type OrcaAgent } from '../platform/orca-agents'
import { resolveCommand, runProgram } from '../platform/run'
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

// The repository as people and `gh --repo` name it: `owner/name` on github.com, `host/owner/name` elsewhere.
export function repositoryName(repository: Repository): string {
  const slug = `${repository.owner}/${repository.name}`
  return repository.host === DEFAULT_HOST ? slug : `${repository.host}/${slug}`
}

export type GitReading = { readonly check: GitCheck; readonly repository: Repository | null }

// The GitHub repository of the checkout's `origin`, or null when there is none or git cannot tell.
export async function originRepository(machine: Machine, path: string): Promise<Repository | null> {
  const url = await runProgram(machine, 'git', ['config', '--get', 'remote.origin.url'], { cwd: path, timeoutMs: GIT_TIMEOUT_MS })
  return url.error === null && url.code === 0 ? githubRepositoryOf(url.stdout) : null
}

// Step 2, git: the project's checkout at `path`.
export async function checkGit(machine: Machine, path: string): Promise<GitReading> {
  const git = (args: string[]) => runProgram(machine, 'git', args, { cwd: path, timeoutMs: GIT_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: '0' } })
  const top = await git(['rev-parse', '--show-toplevel'])
  if (top.error !== null && top.error.kind !== 'not_found') return unchecked(`git: ${top.error.reason}`)
  if (top.error !== null) return unchecked(`git is not installed: ${top.error.reason}`)
  if (top.code !== 0) return { check: { status: 'problem', problem: 'not-git' }, repository: null }
  const url = await git(['config', '--get', 'remote.origin.url'])
  if (url.error !== null) return unchecked(`git config: ${url.error.reason}`)
  // Exit 1: no such key — the repository has no `origin`.
  if (url.code !== 0 && url.code !== 1) return unchecked(`git config --get remote.origin.url failed (exit ${url.code}): ${firstLine(url.stderr)}`)
  const repository = url.code === 0 ? githubRepositoryOf(url.stdout) : null
  if (repository === null) return { check: { status: 'problem', problem: 'no-github' }, repository: null }
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
    return (await github.canWrite()) ? { status: 'ok', login } : { status: 'problem', problem: 'no-write' }
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

// Step 2, agents: the list Orca gives now and the default agents of the roles.
export async function checkAgents(machine: Machine): Promise<AgentsReading> {
  const reading = await readOrcaAgents(machine)
  if (!reading.ok) return { check: { status: 'unchecked', kind: reading.kind, reason: reading.reason }, agents: null }
  const agents = [...reading.agents]
  if (agents.length === 0) return { check: { status: 'problem', problem: 'empty' }, agents }
  const defaults: RoleAgents<string> = { ...DEFAULT_AGENTS }
  const missing = [...new Set(AGENT_ROLES.map((role) => defaults[role]))].filter((id) => !agents.some((agent) => agent.id === id))
  if (missing.length > 0) return { check: { status: 'problem', problem: 'missing', missing, agents, defaults }, agents }
  return { check: { status: 'ok', agents, defaults }, agents }
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '') ?? ''
}
