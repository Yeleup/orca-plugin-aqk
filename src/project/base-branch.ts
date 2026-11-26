// Files of a project as its base branch has them in git: the commit of the remote-tracking branch origin/<branch>,
// never the working tree, the index or a local branch of a checkout. The project's settings (.agent-queue.json) and
// its rules for tasks (.agent-queue.md) are read this way: what counts is what was pushed to the base branch, the commit
// a task's worktree starts from (TZ К4.1: «worktree с HEAD на origin/<базовая ветка>»), not an edit in the main
// checkout that nobody committed or pushed. Nothing here fetches: a caller that needs the newest base runs `git fetch`
// first. `checkout` is any directory of the project's repository (its main checkout or a worktree).
//
// A file is always read exactly: its entry in the commit's tree (`git ls-tree`: mode, type, size, blob id), then the
// blob by its id (`git cat-file blob`), which no attribute, filter or setting of git changes.
import type { Machine } from '../platform/machine'
import { runProgram, type RunResult } from '../platform/run'

// The remote of the project's GitHub repository.
export const REMOTE = 'origin'

// The largest file read: a settings file or rules for tasks are a few kilobytes, and a larger file is refused with its
// own reason instead of being read into memory.
export const MAX_FILE_BYTES = 1024 * 1024

// A local git command answers at once; asking the remote (the default branch, when the clone does not know it) may wait
// for the network.
const GIT_TIMEOUT_MS = 60_000

// Where a file was read: the base branch and the commit origin/<branch> pointed to.
export type BaseBranchCommit = { readonly branch: string; readonly commit: string }

export type BaseBranchFile =
  | (BaseBranchCommit & { readonly found: true; readonly text: string })
  | (BaseBranchCommit & { readonly found: false })

// What a commit has at a path: a regular file (its blob and size in bytes), nothing, or something that is not a file
// (a directory, a symbolic link, a submodule) — `what` says which.
export type CommitEntry =
  | { readonly kind: 'file'; readonly blob: string; readonly size: number }
  | { readonly kind: 'none' }
  | { readonly kind: 'other'; readonly what: string }

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

// The commit origin/<branch> points to in this clone. Throws when `branch` is not a branch name, when this clone has no
// such branch (there is none, or it was not fetched yet), or when git fails.
export async function branchCommit(machine: Machine, checkout: string, branch: string): Promise<string> {
  const notBranch = branchNameProblem(branch)
  if (notBranch !== null) throw new Error(`${JSON.stringify(branch)} is not a branch name: ${notBranch}`)
  const rev = await git(machine, checkout, ['rev-parse', '--verify', '--quiet', `refs/remotes/${REMOTE}/${branch}^{commit}`])
  if (rev.error === null && rev.code === 1) {
    throw new Error(`this clone has no ${REMOTE}/${branch}: there is no such branch, or it was not fetched yet`)
  }
  if (rev.error !== null || rev.code !== 0) throw new Error(failure(rev))
  return rev.stdout.trim()
}

// The branches of origin as this clone knows them (refs/remotes/origin/*, without the symbolic origin/HEAD), each with
// the commit it points to, read at once: one picture of origin for everything decided from it.
export async function remoteBranches(machine: Machine, checkout: string): Promise<BaseBranchCommit[]> {
  const prefix = `refs/remotes/${REMOTE}/`
  const refs = await git(machine, checkout, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', prefix])
  // A list cut short is not a picture of origin: refused before anything is decided from it.
  if (refs.error !== null || refs.code !== 0 || refs.truncated) throw new Error(failure(refs))
  const branches: BaseBranchCommit[] = []
  for (const line of refs.stdout.split(/\r?\n/)) {
    const [name = '', commit = '', symref = ''] = line.split('\0')
    if (!name.startsWith(prefix) || symref !== '' || commit === '') continue
    branches.push({ branch: name.slice(prefix.length), commit })
  }
  return branches
}

// What `commit` has at `path` (from the repository's root, with `/`). Throws when git fails.
export async function commitEntry(machine: Machine, checkout: string, commit: string, path: string): Promise<CommitEntry> {
  // --full-tree: `path` counts from the repository's root wherever `checkout` is in it; -z: the path comes unquoted;
  // -l: with the blob's size.
  const tree = await git(machine, checkout, ['ls-tree', '-z', '-l', '--full-tree', commit, '--', path])
  if (tree.error !== null || tree.code !== 0) throw new Error(failure(tree))
  const entry = /^(\d+) (\w+) ([0-9a-f]+) +(-|\d+)\t([^\0]*)\0/.exec(tree.stdout)
  if (entry === null || entry[5] !== path) return { kind: 'none' }
  const [, mode, type, object = '', size] = entry
  if (type === 'blob' && mode !== '120000') return { kind: 'file', blob: object, size: Number(size) }
  return { kind: 'other', what: type === 'tree' ? 'a directory' : mode === '120000' ? 'a symbolic link' : `a ${type}` }
}

// The text of a file's blob (from commitEntry), a UTF-8 byte order mark at its start dropped. Throws when git fails or
// the file is larger than MAX_FILE_BYTES.
export async function blobText(machine: Machine, checkout: string, entry: { readonly blob: string; readonly size: number }): Promise<string> {
  if (entry.size > MAX_FILE_BYTES) throw new Error(`it is ${entry.size} bytes, more than the ${MAX_FILE_BYTES} read`)
  const blob = await git(machine, checkout, ['cat-file', 'blob', entry.blob])
  if (blob.error !== null || blob.code !== 0 || blob.truncated) throw new Error(failure(blob))
  return blob.stdout.replace(/^\uFEFF/, '')
}

// The file at `path` in the commit of origin/<branch>, or `found: false` when that commit has no such file. Throws when
// git fails, when this clone has no origin/<branch>, or when the path is not a regular file or is too large.
export async function readBaseBranchFile(
  machine: Machine,
  checkout: string,
  branch: string,
  path: string,
): Promise<BaseBranchFile> {
  const commit = await branchCommit(machine, checkout, branch)
  const where = { branch, commit }
  const entry = await commitEntry(machine, checkout, commit, path)
  if (entry.kind === 'none') return { ...where, found: false }
  if (entry.kind === 'other') throw new Error(`${path} in ${REMOTE}/${branch} is ${entry.what}, not a file`)
  try {
    return { ...where, found: true, text: await blobText(machine, checkout, entry) }
  } catch (error) {
    throw new Error(`${path} in ${REMOTE}/${branch}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// Why `name` cannot be a git branch (the rules of `git check-ref-format --branch`), or null when it can.
export function branchNameProblem(name: string): string | null {
  if (name === '') return 'it is empty'
  if (name === 'HEAD') return 'HEAD names the current commit, not a branch'
  if (name.startsWith('-')) return 'it starts with -'
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return 'it holds a space, a control character or one of ~ ^ : ? * [ \\'
  if (name.includes('..')) return 'it holds ..'
  if (name.includes('@{') || name === '@') return 'it holds @{ or is @'
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) return 'it has an empty part between slashes'
  if (name.endsWith('.')) return 'it ends with .'
  for (const part of name.split('/')) {
    if (part.startsWith('.')) return 'a part of it starts with .'
    if (part.endsWith('.lock')) return 'a part of it ends with .lock'
  }
  return null
}

type GitRun = RunResult & { readonly gitArgs: readonly string[] }

async function git(machine: Machine, checkout: string, args: string[]): Promise<GitRun> {
  return { ...(await runProgram(machine, 'git', args, { cwd: checkout, timeoutMs: GIT_TIMEOUT_MS })), gitArgs: args }
}

// Why a git command failed: the reason it did not run, its output cut short, or its exit code and the first line it
// printed.
function failure(result: GitRun): string {
  const command = `git ${result.gitArgs.join(' ')}`
  if (result.error !== null) return `${command}: ${result.error.reason}`
  if (result.code === 0 && result.truncated) return `${command}: its output was too large to keep`
  const said = [result.stderr, result.stdout]
    .flatMap((text) => text.split(/\r?\n/))
    .map((line) => line.trim())
    .find((line) => line !== '')
  return `${command} failed (exit ${result.code ?? result.signal})${said ? `: ${said}` : ''}`
}
