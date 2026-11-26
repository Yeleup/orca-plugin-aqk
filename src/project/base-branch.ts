// Files of a project as its base branch has them in git: the commit of the remote-tracking branch origin/<branch>,
// never the working tree, the index or a local branch of a checkout. The project's settings (.agent-queue.json) and
// its rules for tasks (.agent-queue.md) are read this way: what counts is what was pushed to the base branch, the commit
// a task's worktree starts from (TZ К4.1: «worktree с HEAD на origin/<базовая ветка>»), not an edit in the main
// checkout that nobody committed or pushed. Nothing here fetches: a caller that needs the newest base runs `git fetch`
// first. `checkout` is any directory of the project's repository (its main checkout or a worktree).
import type { Machine } from '../platform/machine'
import { runProgram, type RunResult } from '../platform/run'

// The remote of the project's GitHub repository.
export const REMOTE = 'origin'

// A local git command answers at once; asking the remote (the default branch, when the clone does not know it) may wait
// for the network.
const GIT_TIMEOUT_MS = 60_000

// Where a file was read: the base branch and the commit origin/<branch> pointed to.
export type BaseBranchCommit = { readonly branch: string; readonly commit: string }

export type BaseBranchFile =
  | (BaseBranchCommit & { readonly found: true; readonly text: string })
  | (BaseBranchCommit & { readonly found: false })

// The repository's default branch (the branch GitHub opens first): the remote's HEAD as this clone knows it
// (refs/remotes/origin/HEAD, set by `git clone`), otherwise as the remote itself answers (`git ls-remote --symref`).
// Throws when git fails or the remote names none.
export async function defaultBranch(machine: Machine, checkout: string): Promise<string> {
  const known = await git(machine, checkout, ['symbolic-ref', '--quiet', `refs/remotes/${REMOTE}/HEAD`])
  const prefix = `refs/remotes/${REMOTE}/`
  if (known.error === null && known.code === 0 && known.stdout.trim().startsWith(prefix)) {
    return known.stdout.trim().slice(prefix.length)
  }
  // Exit 1: the clone has no origin/HEAD (a repository made with `git init` and `git remote add`, or cloned while
  // empty). Anything else is a failure of git itself.
  if (known.error !== null || known.code !== 1) throw new Error(failure(known))
  const asked = await git(machine, checkout, ['ls-remote', '--symref', REMOTE, 'HEAD'])
  if (asked.error !== null || asked.code !== 0) throw new Error(failure(asked))
  const match = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(asked.stdout.replace(/\r/g, ''))
  if (match === null) throw new Error(`the remote ${REMOTE} names no default branch (git ls-remote --symref ${REMOTE} HEAD)`)
  return match[1] ?? ''
}

// The file at `path` (from the repository's root, with `/`) in the commit of origin/<branch>, or `found: false` when
// that commit has no such file. Throws when git fails, when this clone has no origin/<branch> (it was never fetched, or
// there is no such branch), or when the path is something other than a regular file (a directory, a symbolic link).
// A UTF-8 byte order mark at the start is dropped.
export async function readBaseBranchFile(
  machine: Machine,
  checkout: string,
  branch: string,
  path: string,
): Promise<BaseBranchFile> {
  const ref = `refs/remotes/${REMOTE}/${branch}`
  const rev = await git(machine, checkout, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  if (rev.error === null && rev.code === 1) {
    throw new Error(`this clone has no ${REMOTE}/${branch}: there is no such branch, or it was not fetched yet`)
  }
  if (rev.error !== null || rev.code !== 0) throw new Error(failure(rev))
  const commit = rev.stdout.trim()
  const where = { branch, commit }
  // --full-tree: `path` counts from the repository's root wherever `checkout` is in it; -z: the path comes unquoted.
  const tree = await git(machine, checkout, ['ls-tree', '-z', '--full-tree', commit, '--', path])
  if (tree.error !== null || tree.code !== 0) throw new Error(failure(tree))
  const entry = /^(\d+) (\w+) ([0-9a-f]+)\t/.exec(tree.stdout)
  if (entry === null) return { ...where, found: false }
  const [, mode, type, object] = entry
  if (type !== 'blob' || mode === '120000') {
    const what = type === 'tree' ? 'a directory' : mode === '120000' ? 'a symbolic link' : `a ${type}`
    throw new Error(`${path} in ${REMOTE}/${branch} is ${what}, not a file`)
  }
  const blob = await git(machine, checkout, ['cat-file', 'blob', object ?? ''])
  if (blob.error !== null || blob.code !== 0) throw new Error(failure(blob))
  if (blob.truncated) throw new Error(`${path} in ${REMOTE}/${branch} is too large to read`)
  return { ...where, found: true, text: blob.stdout.replace(/^\uFEFF/, '') }
}

type GitRun = RunResult & { readonly gitArgs: readonly string[] }

async function git(machine: Machine, checkout: string, args: string[]): Promise<GitRun> {
  return { ...(await runProgram(machine, 'git', args, { cwd: checkout, timeoutMs: GIT_TIMEOUT_MS })), gitArgs: args }
}

// Why a git command failed: the reason it did not run, or its exit code and the first line it printed.
function failure(result: GitRun): string {
  const command = `git ${result.gitArgs.join(' ')}`
  if (result.error !== null) return `${command}: ${result.error.reason}`
  const said = [result.stderr, result.stdout]
    .flatMap((text) => text.split(/\r?\n/))
    .map((line) => line.trim())
    .find((line) => line !== '')
  return `${command} failed (exit ${result.code ?? result.signal})${said ? `: ${said}` : ''}`
}
