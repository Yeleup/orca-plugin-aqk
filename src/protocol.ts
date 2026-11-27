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

/** A git project of Orca the wizard lists (step 1). A project of this computer (host `local`) not connected yet, with
 *  its path and GitHub repository — or, on agent-queue-kit, marked and never chosen; a project of another host
 *  (`otherHost`) is listed too, never chosen, with nothing of it looked at: its path is not this computer's. */
export type ConnectCandidate = {
  id: string
  hostId: string
  name: string
  /** The project's main checkout, as Orca gives it: shown to the owner, never written to GitHub. Empty for a project of
   *  another host. */
  path: string
  /** The GitHub repository of its `origin` as `owner/name` (`host/owner/name` off github.com), or null when there is
   *  none (or the project is on another host). */
  repository: string | null
  /** On agent-queue-kit (`.agent-queue/config.json`): marked «На agent-queue-kit — переход после MVP», never chosen. */
  kit: boolean
  /** Whether `.agent-queue/config.json` is there could not be told (no access): never chosen. */
  kitUnknown: boolean
  /** On another host of Orca (`ssh:…`, `runtime:…`): marked with `hostId`, never chosen. */
  otherHost: boolean
}

/** How long «Подключить» and `connect.wait` keep the panel's request before they answer `running`: within the two
 *  minutes a panel's request may last. */
export const CONNECT_ANSWER_MS = 90_000

/** The project a check or the connection is for. */
export type ConnectTarget = { projectId: string; hostId: string }

/** Step 2, git: the project is a git repository whose `origin` is a GitHub repository, fetched from and pushed to
 *  alike. `ok` gives the form the branches of `origin` this clone knows and its default branch as the clone knows it. */
export type GitCheck =
  | { status: 'ok'; repository: string; branches: string[]; defaultBranch: string }
  /** `push-elsewhere`: a push of `origin` would go somewhere else than the repository fetched from
   *  (`remote.origin.pushurl`, another `remote.origin.url`, `url.*.pushInsteadOf`). */
  | { status: 'problem'; problem: 'not-git' | 'no-github' | 'push-elsewhere' | 'no-branches' }
  | { status: 'unchecked'; error: string }

/** Step 2, gh: installed, logged in, may write to the repository. `defaultBranch` — the repository's default branch as
 *  GitHub says it now. */
export type GhCheck =
  | { status: 'ok'; login: string; defaultBranch: string | null }
  | { status: 'problem'; problem: 'not-installed' | 'not-logged-in' | 'no-repository' | 'no-write' }
  | { status: 'unchecked'; error: string }

/** The agents of each role the form starts with (the defaults of .agent-queue.json). */
export type RoleAgents<T> = { implementer: T; reviewer: T; solver: T; start: T }

/** Why the agents Orca knows could not be read: the CLI of Orca is not found (`search` — what was looked for and
 *  where), or the CLI `cli` (the file run) did not start, did not answer in time, was refused by Orca, answered no JSON,
 *  answered without the list or with an agent without its id, or answered without `ok: true` and exit 0. `detail` —
 *  what the CLI or Orca said, as it is. */
export type AgentsFailure =
  | { kind: 'cli-not-found'; search: string }
  | { kind: 'not-started' | 'timed-out' | 'refused' | 'no-json' | 'no-list' | 'no-id' | 'not-ok'; cli: string; detail: string }

/** Step 2, agents: the agents Orca knows on this computer (`agent installed`) and whether the default agents of the
 *  roles are among them. `missing` does not stop the form (the owner picks another agent there); `empty` and
 *  `unchecked` do. */
export type AgentsCheck =
  | { status: 'ok'; agents: OrcaAgent[]; defaults: RoleAgents<string> }
  | { status: 'problem'; problem: 'missing'; missing: string[]; agents: OrcaAgent[]; defaults: RoleAgents<string> }
  | { status: 'problem'; problem: 'empty' }
  | { status: 'unchecked'; failure: AgentsFailure }

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
 *  Orca does not know now; `number` — not a whole number from 1; `branch-name` — not a git branch name; `no-branch` —
 *  `origin` has no such branch now; `directory` — a dependency directory not inside the repository; `masked` — the mask
 *  of the plugin finds data that never goes to GitHub (`detail` names its rules, never the text); `invalid` — what the
 *  check of .agent-queue.json says (`detail`). */
export type FieldError = {
  field: ConnectField
  code: 'required' | 'oneLine' | 'agent' | 'number' | 'branch-name' | 'no-branch' | 'directory' | 'masked' | 'invalid'
  detail: string
}

/** Why «Подключить» wrote nothing. */
export type ConnectRefusal =
  | { reason: 'kit' }
  /** Whether the project is on agent-queue-kit could not be told: nothing is written over a project that may be. */
  | { reason: 'kit-unknown' }
  | { reason: 'busy' }
  /** The project is connected already: the base branch of `origin` has .agent-queue.json now. */
  | { reason: 'connected' }
  | { reason: 'git'; check: GitCheck }
  | { reason: 'gh'; check: GhCheck }
  | { reason: 'agents'; failure: AgentsFailure }
  | { reason: 'fetch'; error: string }
  /** The main checkout is not on the base branch: `branch` — the branch it is on, null when it is on no branch. */
  | { reason: 'not-on-base'; branch: string | null; base: string }
  /** The main checkout has changes: so many paths. */
  | { reason: 'dirty'; paths: number }
  | { reason: 'behind'; commits: number; base: string }
  | { reason: 'ahead'; commits: number; base: string }
  | { reason: 'diverged'; ahead: number; behind: number; base: string }
  /** One of the four files cannot take the plugin's change: `present` — the commit lacks it, but the working tree has
   *  it (an ignored file, a file made meanwhile); `differs` — the commit has it, the working tree holds other content;
   *  `ignored` — git ignores the path, its file would not be committed; `transformed` — git would change its content
   *  when adding it (attributes, filters); `not-text` — its content in the commit is not UTF-8 text the plugin can keep
   *  as it is; `not-file` — not a regular file in the commit; `unpaired` — a marker of the plugin's block without its
   *  pair (`detail`: `begin-again`, `end-alone` or `begin-alone`); `masked` — the entry rule's block would carry data
   *  the mask hides (`detail`: its rules). */
  | {
      reason: 'file'
      file: string
      problem: 'present' | 'differs' | 'ignored' | 'transformed' | 'not-text' | 'not-file' | 'unpaired' | 'masked'
      detail: string
    }
  | { reason: 'journal'; error: string }

/** What changed in the main checkout after «Подключить» checked it and before it wrote its files. */
export type CheckoutChange =
  | { kind: 'head' }
  | { kind: 'branch' }
  | { kind: 'dirty'; paths: number }
  | { kind: 'file'; file: string }

/** Why «Подключить» failed once the operation had begun. `left` — paths the plugin did not put back, since they were
 *  changed after it wrote them. `detail` — what git said, for diagnostics; null when the plugin's own reason says it
 *  all. */
export type ConnectFailure =
  | { step: 'labels'; detail: string }
  /** The checkout changed after the checks: none of the files was written. */
  | { step: 'changed'; change: CheckoutChange }
  /** A file could not be written: `changed` — `file` changed in the working tree right before (nothing written over it);
   *  `error` — the disk refused. The files written before are put back. */
  | { step: 'files'; reason: 'changed' | 'error'; file: string; detail: string | null; left: string[] }
  /** The commit could not be made: `moved` — the base branch moved meanwhile (another commit on it), so the operation's
   *  commit was not put on it; `error` — git failed. The files written are put back. */
  | { step: 'commit'; reason: 'moved' | 'error'; detail: string | null; left: string[] }
  /** The commit is not the operation's: `what` says how. No push; the plugin's own changes are undone. */
  | { step: 'verify'; what: 'parent' | 'paths' | 'blob' | 'message'; file: string | null; left: string[] }
  /** The push gave no certain answer: it may have reached origin; the commit stays. */
  | { step: 'push-unknown'; detail: string }
  /** The push address of `origin` changed after the checks: no push; the commit is undone. */
  | { step: 'push-address'; left: string[] }
  /** The commit could not be undone after the push was refused (`push`: git's reason, or null after a failed check):
   *  `moved` — the base branch is no longer the operation's commit (work of the user on it); `error` — git failed. */
  | { step: 'undo'; push: string | null; reason: 'moved' | 'error'; detail: string | null }
  | { step: 'unexpected'; detail: string }
  /** The worker knows nothing of the attempt (it was restarted). */
  | { step: 'lost' }

/** The answer to «Подключить» (and to waiting for it). */
export type ConnectResult =
  | { status: 'connected'; project: Project; operation: string; commit: string }
  /** The fields to fix; `agents` — the agents Orca knows now, when that is why a field is wrong. */
  | { status: 'fields'; errors: FieldError[]; agents: AgentsCheck | null }
  | { status: 'refused'; refusal: ConnectRefusal }
  /** The push was rejected: the local commit is undone, the checkout is back on its commit. */
  | { status: 'pushRejected'; error: string; operation: string }
  | { status: 'failed'; failure: ConnectFailure; operation: string | null }
  /** Still under way: ask again with `connect.wait` and this attempt's id. */
  | { status: 'running'; attempt: string }

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
    /** «Подключить»: checks everything again, then connects the project (Ф1, point 4). The answer comes within
     *  CONNECT_ANSWER_MS; a connection still under way then answers `running`. */
    'connect.connect': { input: ConnectTarget & { form: ConnectForm }; output: ConnectResult }
    /** The end of the attempt `attempt` (the id `running` gave), within CONNECT_ANSWER_MS (`running` again otherwise);
     *  its answer when it ended meanwhile — never another attempt's; `failed` with `lost` when the worker knows none. */
    'connect.wait': { input: ConnectTarget & { attempt: string }; output: ConnectResult }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel when the connected projects change: the whole new list. */
    'projects.changed': { projects: Project[] }
  }
}
