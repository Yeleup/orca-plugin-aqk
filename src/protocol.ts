// The panel <-> worker contract, declared once: src/panel.tsx (with src/ui/) and src/worker.ts both read it.
import type { OrcaAgent } from './platform/orca-agents'

export type { OrcaAgent } from './platform/orca-agents'

/** A project connected to the queue, as the panel's project selector shows it. */
export type Project = {
  /** Orca's id of the project (`project.list`): the panel keeps it as the selected project, the worker finds the
   *  project's main checkout by it and `hostId`. */
  id: string
  /** Orca's host of the project (`project.list`: `local`, `ssh:…`, `runtime:…`): one id can name copies of a project
   *  on two hosts. */
  hostId: string
  /** Name shown in the selector. */
  name: string
}

/** The project's files of «Настройки проекта» (screen «Настройки»), by their path in the project's main checkout. */
export const PROJECT_FILES = ['.agent-queue.json', '.agent-queue.md'] as const
export type ProjectFile = (typeof PROJECT_FILES)[number]

/** The worker's answer to `project.openFile`. `no_checkout`: Orca has no workspace of the project's main checkout. */
export type OpenProjectFileAnswer = { opened: true } | { opened: false; reason: 'no_checkout' }

// ── «Подключение проекта» (Ф1): the wizard's requests ─────────────────────────────────────────────────────────────

/** An Orca project of this computer the wizard offers (step 1): a git project not connected yet. */
export type ConnectCandidate = {
  id: string
  hostId: string
  name: string
  /** The project's main checkout, as Orca gives it: shown to the owner, never written to GitHub. */
  path: string
  /** The GitHub repository of its `origin` as `owner/name` (`host/owner/name` off github.com), or null when there is
   *  none. */
  repository: string | null
  /** On agent-queue-kit (`.agent-queue/config.json`): marked «На agent-queue-kit — переход после MVP», never chosen. */
  kit: boolean
}

/** The project a check or the connection is for. */
export type ConnectTarget = { projectId: string; hostId: string }

/** Step 2, git: the project is a git repository whose `origin` is a GitHub repository. `ok` gives the form its base
 *  branches: the branches of `origin` this clone knows and the repository's default branch. */
export type GitCheck =
  | { status: 'ok'; repository: string; branches: string[]; defaultBranch: string }
  | { status: 'problem'; problem: 'not-git' | 'no-github' | 'no-branches' }
  | { status: 'unchecked'; error: string }

/** Step 2, gh: installed, logged in, may write to the repository. */
export type GhCheck =
  | { status: 'ok'; login: string }
  | { status: 'problem'; problem: 'not-installed' | 'not-logged-in' | 'no-repository' | 'no-write' }
  | { status: 'unchecked'; error: string }

/** The agents of each role the form starts with (the defaults of .agent-queue.json). */
export type RoleAgents<T> = { implementer: T; reviewer: T; solver: T; start: T }

/** Step 2, agents: the agents Orca knows on this computer (`orca agent installed`) and whether the default agents of
 *  the roles are among them. `missing` does not stop the form (the owner picks another agent there); `empty` and
 *  `unchecked` do. */
export type AgentsCheck =
  | { status: 'ok'; agents: OrcaAgent[]; defaults: RoleAgents<string> }
  | { status: 'problem'; problem: 'missing'; missing: string[]; agents: OrcaAgent[]; defaults: RoleAgents<string> }
  | { status: 'problem'; problem: 'empty' }
  | { status: 'unchecked'; kind: 'cli-not-found' | 'failed'; reason: string }

/** The settings form (step 3), as the owner filled it in: what «Подключить» sends. */
export type ConnectForm = {
  baseBranch: string
  testCommand: string
  /** Empty: no command of its own for Windows. */
  testCommandWindows: string
  /** null: no agent chosen for the role. */
  agents: RoleAgents<string | null>
  language: 'ru' | 'en'
  dataRule: string
  /** The text of .agent-queue.md. */
  taskRules: string
  /** As typed: a whole number from 1. */
  maxInProgress: string
  worktreeMode: 'own' | 'shared'
  /** The dependency directories, separated by commas. */
  directories: string
}

export type ConnectField =
  | 'baseBranch'
  | 'testCommand'
  | 'testCommandWindows'
  | 'agents.implementer'
  | 'agents.reviewer'
  | 'agents.solver'
  | 'agents.start'
  | 'language'
  | 'dataRule'
  | 'taskRules'
  | 'maxInProgress'
  | 'worktreeMode'
  | 'directories'

/** A field the owner must fix: `required` — empty; `oneLine` — a command of several lines; `agent` — no agent, or one
 *  Orca does not know; `number` — not a whole number from 1; `branch` — not a branch of `origin`; `invalid` — what the
 *  check of .agent-queue.json says (`detail`). */
export type FieldError = {
  field: ConnectField
  code: 'required' | 'oneLine' | 'agent' | 'number' | 'branch' | 'invalid'
  detail: string
}

/** Why «Подключить» wrote nothing. */
export type ConnectRefusal =
  | { reason: 'kit' }
  | { reason: 'busy' }
  | { reason: 'git'; check: GitCheck }
  | { reason: 'gh'; check: GhCheck }
  | { reason: 'agents'; check: AgentsCheck }
  | { reason: 'fetch'; error: string }
  /** The main checkout is not on the base branch: `branch` — the branch it is on, null when it is on no branch. */
  | { reason: 'not-on-base'; branch: string | null; base: string }
  /** The main checkout has changes: so many paths. */
  | { reason: 'dirty'; paths: number }
  | { reason: 'behind'; commits: number; base: string }
  | { reason: 'ahead'; commits: number; base: string }
  | { reason: 'diverged'; ahead: number; behind: number; base: string }
  /** One of the four files cannot take the plugin's change: not a regular file in the repository, or a marker of the
   *  plugin's block without its pair. */
  | { reason: 'file'; file: string; problem: string }
  | { reason: 'journal'; error: string }

/** The answer to «Подключить». */
export type ConnectResult =
  | { status: 'connected'; project: Project; operation: string; commit: string }
  | { status: 'fields'; errors: FieldError[] }
  | { status: 'refused'; refusal: ConnectRefusal }
  /** The push was rejected: the local commit is undone, the checkout is back on its commit. */
  | { status: 'pushRejected'; error: string; operation: string }
  /** Something failed after the operation began (labels, files, commit, push, undoing the commit): `error` says what. */
  | { status: 'failed'; error: string; operation: string }

declare module 'orca' {
  interface PluginRequests {
    /** The projects connected to the queue on this computer. */
    'projects.list': { output: { projects: Project[] } }
    /** Shows the project's main checkout in Orca and opens one of its files of «Настройки проекта» there in Orca's
     *  editor. A file that is not one of PROJECT_FILES is refused with `invalid_params`; Orca's refusals come as is. */
    'project.openFile': {
      input: { projectId: string; hostId: string; file: ProjectFile }
      output: OpenProjectFileAnswer
    }
    /** The wizard's step 1: the Orca projects of this computer not connected yet. */
    'connect.projects': { output: { projects: ConnectCandidate[] } }
    /** The wizard's step 2, one check at a time. */
    'connect.checkGit': { input: ConnectTarget; output: GitCheck }
    'connect.checkGh': { input: ConnectTarget; output: GhCheck }
    'connect.checkAgents': { input: ConnectTarget; output: AgentsCheck }
    /** «Подключить»: checks everything again, then connects the project (Ф1, point 4). */
    'connect.connect': { input: ConnectTarget & { form: ConnectForm }; output: ConnectResult }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel when the connected projects change: the whole new list. */
    'projects.changed': { projects: Project[] }
  }
}
