// The connection's git work in the project's main checkout (Ф1, point 4), with real git through the platform layer:
// a fresh fetch of the base branch; the checkout's state against it (on it, no changes, HEAD equal to what that fetch
// brought); the four files as the source commit has them and as the working tree has them; the hashes of the content
// the operation writes; writing the files without overwriting what is not the operation's; a commit of exactly them;
// its check against the journal; a push of that very commit to the base branch; and undoing only the operation's own
// changes.
//
// Hooks: no hook of the project's git runs for any command of the connection (decision «🤖 Решение по #11: вопрос»,
// the second) — neither one in `.git/hooks` nor one in a `core.hooksPath` of the repository's, the user's or the
// system's configuration (husky, lefthook, pre-commit, Git LFS, shared hooks): pre-commit, prepare-commit-msg,
// commit-msg, post-commit, pre-push, post-checkout, reference-transaction, post-index-change and any other. Every git
// process here gets `-c core.hooksPath=<a directory the plugin never creates>`, and commit and push also
// `--no-verify`. A hook is code of the project that could change the files or the message, while the commit must be
// exactly the four files with the content the journal names and the operation's id in its message. What stays: a
// refusal of `origin` (branch protection, its pre-receive hook, GitHub's push rules) is never got round; the
// attributes and filters of `.gitattributes` act on `git add` (they are not hooks — content they would change is
// refused before the journal); the author and signature of the commit are the user's own git configuration. So a
// local hook that forbids a direct push to the base branch or runs the tests before a push does not stop the
// connection; a protection of the branch on GitHub does.
//
// Only the operation's own changes are ever undone: a path goes back only while it holds what the operation wrote, the
// local commit is undone only while HEAD is that commit on the base branch — work of the user made meanwhile stays.
import type { Machine } from '../platform/machine'
import { worktreeFile } from '../platform/paths'
import { runProgram, type RunResult } from '../platform/run'
import { commitEntry, REMOTE } from '../project/base-branch'
import type { CheckoutChange, ConnectRefusal } from '../protocol'

const GIT_TIMEOUT_MS = 60_000
// The network commands, fetch and push.
const NETWORK_TIMEOUT_MS = 60_000

export type GitRun = RunResult & { readonly gitArgs: readonly string[] }

// A file of the source commit: its text — exactly its bytes, a byte order mark included — and blob.
export type SourceFile = { readonly text: string; readonly blob: string }

// What the working tree has at a path: nothing, a file with this text, or something else (a directory, a link to a
// directory, a file that cannot be read).
export type WorktreeEntry = { readonly kind: 'none' } | { readonly kind: 'file'; readonly text: string } | { readonly kind: 'other' }

// A file of the operation: its path, the text the operation writes, the blob id of that text, and the path in the source
// commit (null: the commit lacks it).
export type OperationFile = {
  readonly path: string
  readonly text: string
  readonly blob: string
  readonly source: SourceFile | null
}

export type PushOutcome =
  | { readonly outcome: 'pushed' }
  // `origin` or git refused the base branch's update (its line in git's answer says so): nothing was pushed.
  | { readonly outcome: 'rejected'; readonly error: string }
  // git did not start: nothing was pushed.
  | { readonly outcome: 'not-sent'; readonly error: string }
  // No certain answer (a timeout, a connection lost, no line for the branch): it may have reached origin.
  | { readonly outcome: 'unknown'; readonly error: string }

export class Checkout {
  constructor(
    private readonly machine: Machine,
    readonly path: string,
    // A directory with no hooks — the plugin never creates it: `core.hooksPath` of every git process.
    private readonly hooksOff: string,
  ) {}

  async git(args: readonly string[], options: { input?: string; timeoutMs?: number } = {}): Promise<GitRun> {
    const result = await runProgram(this.machine, 'git', ['-c', `core.hooksPath=${this.hooksOff}`, ...args], {
      cwd: this.path,
      timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS,
      env: { GIT_TERMINAL_PROMPT: '0' },
      ...(options.input === undefined ? {} : { input: options.input }),
    })
    return { ...result, gitArgs: args }
  }

  // Runs git and returns its output; throws with git's reason when it fails.
  async must(args: readonly string[], options: { input?: string; timeoutMs?: number } = {}): Promise<string> {
    const result = await this.git(args, options)
    if (result.error !== null || result.code !== 0) throw new Error(failure(result))
    return result.stdout
  }

  // Fetches the base branch itself into origin/<base>, forced, whatever the remote's fetch refspec says, and gives the
  // commit this fetch brought. `missing`: origin has no such branch now.
  async fetchBase(base: string): Promise<{ readonly commit: string } | { readonly missing: boolean; readonly error: string }> {
    const result = await this.git(['fetch', '--quiet', '--no-tags', REMOTE, `+refs/heads/${base}:refs/remotes/${REMOTE}/${base}`], {
      timeoutMs: NETWORK_TIMEOUT_MS,
    })
    if (result.error !== null || result.code !== 0) {
      return { missing: /couldn't find remote ref/i.test(result.stderr), error: failure(result) }
    }
    return { commit: (await this.must(['rev-parse', '--verify', `refs/remotes/${REMOTE}/${base}^{commit}`])).trim() }
  }

  // HEAD, the branch HEAD is on (null: none) and how many paths have changes (tracked and new; ignored ones aside).
  async state(): Promise<{ readonly head: string; readonly branch: string | null; readonly changed: number }> {
    const head = (await this.must(['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
    const branch = await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD'])
    if (branch.error !== null || (branch.code !== 0 && branch.code !== 1)) throw new Error(failure(branch))
    // -z: one entry per path (a rename is one entry followed by its source).
    const status = await this.must(['status', '--porcelain=v1', '-z', '--untracked-files=normal'])
    const entries = status.split('\0').filter((entry) => entry !== '')
    let changed = 0
    for (let at = 0; at < entries.length; at++) {
      changed++
      if (/^[RC]/.test(entries[at] ?? '')) at++
    }
    return { head, branch: branch.code === 0 ? branch.stdout.trim() : null, changed }
  }

  // Whether the checkout may be connected on `base`, its remote commit being `remote` (from this attempt's fetch): on
  // the branch, without changes, HEAD equal to it. Null when it may; otherwise the refusal. `head` — the commit of HEAD.
  async readiness(base: string, remote: string): Promise<{ readonly refusal: ConnectRefusal | null; readonly head: string }> {
    const { head, branch, changed } = await this.state()
    if (branch !== base) return { refusal: { reason: 'not-on-base', branch, base }, head }
    if (changed > 0) return { refusal: { reason: 'dirty', paths: changed }, head }
    if (remote === head) return { refusal: null, head }
    const counts = (await this.must(['rev-list', '--left-right', '--count', `${head}...${remote}`])).trim().split(/\s+/)
    const ahead = Number(counts[0] ?? 0)
    const behind = Number(counts[1] ?? 0)
    if (ahead === 0) return { refusal: { reason: 'behind', commits: behind, base }, head }
    if (behind === 0) return { refusal: { reason: 'ahead', commits: ahead, base }, head }
    return { refusal: { reason: 'diverged', ahead, behind, base }, head }
  }

  // `path` in `commit`: null when the commit has no such path; a problem when it is not a regular file, or its bytes
  // are not UTF-8 text the plugin can give back exactly (its blob is checked against the text read, with and without a
  // byte order mark).
  async fileAt(
    commit: string,
    path: string,
  ): Promise<{ readonly file: SourceFile | null } | { readonly problem: 'not-file' | 'not-text'; readonly detail: string }> {
    const entry = await commitEntry(this.machine, this.path, commit, path)
    if (entry.kind === 'none') return { file: null }
    if (entry.kind === 'other') return { problem: 'not-file', detail: entry.what }
    // git's output is read as UTF-8, its byte order mark dropped: the text is right only if it gives the blob again.
    const read = await this.must(['cat-file', 'blob', entry.blob])
    for (const text of [read, `﻿${read}`]) {
      if ((await this.blobId(text)) === entry.blob) return { file: { text, blob: entry.blob } }
    }
    return { problem: 'not-text', detail: `${entry.size} bytes` }
  }

  // The blob id git gives `text` as it is (no filter or line-ending conversion): the hash of the expected content.
  async blobId(text: string): Promise<string> {
    return (await this.must(['hash-object', '--no-filters', '--stdin'], { input: text })).trim()
  }

  // The blob id `git add` would give `text` at `path`: with the attributes and filters of that path.
  async addedBlobId(path: string, text: string): Promise<string> {
    return (await this.must(['hash-object', `--path=${path}`, '--stdin'], { input: text })).trim()
  }

  // Whether git ignores `path` (a path not in the index).
  async isIgnored(path: string): Promise<boolean> {
    const result = await this.git(['check-ignore', '--quiet', '--', path])
    if (result.error === null && (result.code === 0 || result.code === 1)) return result.code === 0
    throw new Error(failure(result))
  }

  // What the working tree has at `path`.
  worktree(path: string): WorktreeEntry {
    const file = worktreeFile(this.machine, this.path, path)
    try {
      const text = this.machine.readText(file)
      return text === null ? { kind: 'none' } : { kind: 'file', text }
    } catch {
      // A directory (EISDIR), no access, anything that is not a readable file.
      return { kind: 'other' }
    }
  }

  // Whether the working tree's file at `path` holds the content of `blob` — as git compares them, through the path's
  // attributes and filters (a checkout with CRLF line endings holds the LF blob it came from).
  async holds(path: string, blob: string): Promise<boolean> {
    const now = this.worktree(path)
    return now.kind === 'file' && (await this.addedBlobId(path, now.text)) === blob
  }

  // What changed since the checks: HEAD, the branch, changes in the checkout, one of the four paths (a new one is there,
  // an existing one holds other content). Null: nothing.
  async changeSince(source: string, base: string, files: readonly OperationFile[]): Promise<CheckoutChange | null> {
    const { head, branch, changed } = await this.state()
    if (head !== source) return { kind: 'head' }
    if (branch !== base) return { kind: 'branch' }
    if (changed > 0) return { kind: 'dirty', paths: changed }
    for (const file of files) {
      const same = file.source === null ? this.worktree(file.path).kind === 'none' : await this.holds(file.path, file.source.blob)
      if (!same) return { kind: 'file', file: file.path }
    }
    return null
  }

  // Writes the file of the operation, never over anything that is not the source commit's content: a new path only
  // while nothing is there (created, never replaced), an existing one only while it holds the source content. False —
  // something else is there now, and nothing was written.
  async writeFile(file: OperationFile): Promise<boolean> {
    const target = worktreeFile(this.machine, this.path, file.path)
    if (file.source === null) return this.machine.createText(target, file.text)
    if (!(await this.holds(file.path, file.source.blob))) return false
    await this.machine.replaceText(target, file.text)
    return true
  }

  // `git add` of the paths, then a commit of exactly them with `message` (its lines); the new HEAD, when HEAD moved.
  async commit(paths: readonly string[], message: readonly string[], source: string): Promise<{ readonly commit: string } | { readonly error: string }> {
    const added = await this.git(['add', '--', ...paths])
    if (added.error !== null || added.code !== 0) return { error: failure(added) }
    const committed = await this.git(['commit', '--quiet', '--no-verify', '--cleanup=verbatim', ...message.flatMap((line) => ['-m', line]), '--', ...paths])
    const head = (await this.must(['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
    return head !== source ? { commit: head } : { error: failure(committed) }
  }

  // Whether `commit` is the operation's: its one parent is `source`, it changes exactly the files, each to its blob,
  // and its message is exactly `message`. Null when it is; otherwise what differs.
  async verify(
    commit: string,
    source: string,
    files: readonly OperationFile[],
    message: string,
  ): Promise<{ readonly what: 'parent' | 'paths' | 'blob' | 'message'; readonly file: string | null } | null> {
    const parents = (await this.must(['rev-list', '--parents', '-n', '1', commit])).trim().split(/\s+/).slice(1)
    if (parents.length !== 1 || parents[0] !== source) return { what: 'parent', file: null }
    const changed = (await this.must(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', source, commit]))
      .split('\0')
      .filter((path) => path !== '')
      .sort()
    const expected = files.map((file) => file.path).sort()
    if (changed.length !== expected.length || changed.some((path, at) => path !== expected[at])) return { what: 'paths', file: null }
    for (const file of files) {
      const entry = await commitEntry(this.machine, this.path, commit, file.path)
      if (entry.kind !== 'file' || entry.blob !== file.blob) return { what: 'blob', file: file.path }
    }
    const raw = await this.must(['cat-file', 'commit', commit])
    const body = raw.slice(raw.indexOf('\n\n') + 2)
    return body === message ? null : { what: 'message', file: null }
  }

  // Pushes the commit itself (not whatever HEAD is by then) to origin's `base`, never forced.
  async push(commit: string, base: string): Promise<PushOutcome> {
    const target = `refs/heads/${base}`
    const result = await this.git(['push', '--porcelain', '--no-verify', REMOTE, `${commit}:${target}`], { timeoutMs: NETWORK_TIMEOUT_MS })
    if (result.error !== null && (result.error.kind === 'not_found' || result.error.kind === 'start_failed')) {
      return { outcome: 'not-sent', error: failure(result) }
    }
    // --porcelain: a line `<flag>\t<from>:<to>\t<summary>` for the ref. A refusal is certain only as `[rejected]` (git
    // itself: not a fast-forward, fetch first) or `[remote rejected]` (origin answered `ng`); `[remote failure] (remote
    // failed to report status)` and anything else is no answer.
    for (const line of result.stdout.split(/\r?\n/)) {
      const [flag, refs, summary = ''] = line.split('\t')
      if (flag !== '!' || refs === undefined || !refs.endsWith(`:${target}`)) continue
      const refused = /^\[(rejected|remote rejected)\]\s*(.*)$/.exec(summary.trim())
      if (refused) return { outcome: 'rejected', error: `${refused[1]}${refused[2] ? ` ${refused[2]}` : ''}` }
    }
    if (result.error === null && result.code === 0) return { outcome: 'pushed' }
    return { outcome: 'unknown', error: failure(result) }
  }

  // Undoes the operation's commit: only while HEAD is `commit` on `base` — the checkout back on `source`. Null when it
  // is undone, otherwise why not (nothing was changed then).
  async undoCommit(commit: string, source: string, base: string): Promise<string | null> {
    const { head, branch } = await this.state()
    if (head !== commit || branch !== base) return `the checkout moved on (HEAD ${head}, branch ${branch ?? 'none'}): the commit ${commit} stays`
    const reset = await this.git(['reset', '--quiet', '--keep', source])
    const after = (await this.must(['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
    if (after === source) return null
    return reset.error === null && reset.code === 0 ? `HEAD is ${after}, not ${source}` : failure(reset)
  }

  // Puts back the paths the operation wrote — only while each holds the operation's text (and its index entry is the
  // source's or the operation's): an existing path to the source commit's content, a new one gone. The paths left as
  // they were, since they changed after the operation wrote them.
  async restore(source: string, files: readonly OperationFile[]): Promise<string[]> {
    const left: string[] = []
    for (const file of files) {
      const index = await this.indexBlob(file.path)
      const ours = (await this.holds(file.path, file.blob)) && (index === null || index === file.blob || index === file.source?.blob)
      if (!ours) {
        left.push(file.path)
        continue
      }
      const runs: (readonly string[])[] =
        file.source !== null
          ? [['checkout', '--quiet', source, '--', file.path]]
          : [
              ['rm', '--quiet', '--cached', '--force', '--ignore-unmatch', '--', file.path],
              ['clean', '--quiet', '--force', '--', file.path],
            ]
      for (const args of runs) {
        const result = await this.git(args)
        if (result.error !== null || result.code !== 0) {
          left.push(file.path)
          break
        }
      }
    }
    return left
  }

  // The blob of `path` in the index, or null when the index has none.
  private async indexBlob(path: string): Promise<string | null> {
    const entry = (await this.must(['ls-files', '--stage', '-z', '--', path])).split('\0')[0] ?? ''
    const match = /^\d+ ([0-9a-f]+) \d\t/.exec(entry)
    return match ? (match[1] ?? null) : null
  }
}

// Why a git command failed: the reason it did not run, or its exit code and the first line it printed.
export function failure(result: GitRun): string {
  const command = `git ${result.gitArgs.join(' ')}`
  if (result.error !== null) return `${command}: ${result.error.reason}`
  const said = [result.stderr, result.stdout]
    .flatMap((text) => text.split(/\r?\n/))
    .map((line) => line.trim())
    .find((line) => line !== '')
  return `${command} failed (exit ${result.code ?? result.signal})${said ? `: ${said}` : ''}`
}
