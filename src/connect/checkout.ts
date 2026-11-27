// The connection's git work in the project's main checkout (Ф1, point 4), with real git through the platform layer:
// a fresh `fetch` of `origin`; the checkout's state against the base branch (on it, no changes, HEAD equal to
// origin/<base>); the four files as the checkout's commit has them; the blob id of a text; writing the files, a commit
// of exactly them and a push to the base branch; and undoing — the paths back to the commit's content, or the local
// commit undone after a rejected push.
//
// - The commit and the push run without the project's git hooks (`--no-verify`): a hook could change or add files, and
//   the commit holds exactly the four files with the content the journal names.
// - The commit takes the author and signing of the user's own git configuration, as any commit of theirs.
// - A rejected push is undone with `git reset --keep <source>`: HEAD, the index and the files of the commit go back to
//   the source commit — a file the commit added goes — and a file with changes made meanwhile stops it rather than
//   being lost.
import type { Machine } from '../platform/machine'
import { worktreeFile } from '../platform/paths'
import { runProgram, type RunResult } from '../platform/run'
import { blobText, commitEntry, REMOTE } from '../project/base-branch'
import type { ConnectRefusal } from '../protocol'

const GIT_TIMEOUT_MS = 60_000
// The network commands, fetch and push: together with the rest of «Подключить» within the two minutes the panel waits.
const NETWORK_TIMEOUT_MS = 60_000

type GitRun = RunResult & { readonly gitArgs: readonly string[] }

export class Checkout {
  constructor(
    private readonly machine: Machine,
    readonly path: string,
  ) {}

  async git(args: readonly string[], options: { input?: string; timeoutMs?: number } = {}): Promise<GitRun> {
    const result = await runProgram(this.machine, 'git', args, {
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

  // `git fetch origin`: what origin has now. Null when it went well, otherwise git's reason.
  async fetch(): Promise<string | null> {
    const result = await this.git(['fetch', '--quiet', REMOTE], { timeoutMs: NETWORK_TIMEOUT_MS })
    return result.error === null && result.code === 0 ? null : failure(result)
  }

  // Whether the checkout may be connected on `base` (after a fresh fetch): on the branch, without changes, its HEAD
  // equal to origin/<base>. Null when it may; otherwise the refusal with the reason. `head` — the commit of HEAD.
  async readiness(base: string): Promise<{ readonly refusal: ConnectRefusal | null; readonly head: string }> {
    const head = (await this.must(['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
    const branch = await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD'])
    if (branch.error !== null || (branch.code !== 0 && branch.code !== 1)) throw new Error(failure(branch))
    const current = branch.code === 0 ? branch.stdout.trim() : null
    if (current !== base) return { refusal: { reason: 'not-on-base', branch: current, base }, head }
    // -z: one entry per path (a rename is one entry followed by its source); untracked files count, ignored ones do not.
    const status = await this.must(['status', '--porcelain=v1', '-z', '--untracked-files=normal'])
    const entries = status.split('\0').filter((entry) => entry !== '')
    let paths = 0
    for (let at = 0; at < entries.length; at++) {
      paths++
      if (/^[RC]/.test(entries[at] ?? '')) at++
    }
    if (paths > 0) return { refusal: { reason: 'dirty', paths }, head }
    const remote = (await this.must(['rev-parse', '--verify', `refs/remotes/${REMOTE}/${base}^{commit}`])).trim()
    if (remote === head) return { refusal: null, head }
    const counts = (await this.must(['rev-list', '--left-right', '--count', `${head}...${remote}`])).trim().split(/\s+/)
    const ahead = Number(counts[0] ?? 0)
    const behind = Number(counts[1] ?? 0)
    if (ahead === 0) return { refusal: { reason: 'behind', commits: behind, base }, head }
    if (behind === 0) return { refusal: { reason: 'ahead', commits: ahead, base }, head }
    return { refusal: { reason: 'diverged', ahead, behind, base }, head }
  }

  // Whether origin/<branch> is a branch this clone knows (after the fetch).
  async hasRemoteBranch(branch: string): Promise<boolean> {
    const result = await this.git(['rev-parse', '--verify', '--quiet', `refs/remotes/${REMOTE}/${branch}^{commit}`])
    if (result.error === null && result.code === 1) return false
    if (result.error !== null || result.code !== 0) throw new Error(failure(result))
    return true
  }

  // `path` in `commit`: its text and blob, or null when the commit has no such path; a problem when it is not a
  // regular file (a directory, a symbolic link, a submodule) or is too large to read.
  async fileAt(
    commit: string,
    path: string,
  ): Promise<{ readonly file: { readonly text: string; readonly blob: string } | null } | { readonly problem: string }> {
    const entry = await commitEntry(this.machine, this.path, commit, path)
    if (entry.kind === 'none') return { file: null }
    if (entry.kind === 'other') return { problem: `${path} is ${entry.what}, not a file` }
    try {
      return { file: { text: await blobText(this.machine, this.path, entry), blob: entry.blob } }
    } catch (error) {
      return { problem: `${path}: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  // The blob id git gives `text` as it is (no filter or line-ending conversion): the hash of the expected content.
  async blobId(text: string): Promise<string> {
    return (await this.must(['hash-object', '--no-filters', '--stdin'], { input: text })).trim()
  }

  // Writes the files (path from the repository's root → text) into the working tree.
  async writeFiles(files: readonly { readonly path: string; readonly text: string }[]): Promise<void> {
    for (const file of files) await this.machine.replaceText(worktreeFile(this.machine, this.path, file.path), file.text)
  }

  // `git add` of the paths, then a commit of exactly them with `message` (its lines); returns the new HEAD. A commit
  // that git reports as failed, but which moved HEAD (a hook of the user's git after the commit), still counts.
  async commit(paths: readonly string[], message: readonly string[], source: string): Promise<{ readonly commit: string } | { readonly error: string }> {
    const added = await this.git(['add', '--', ...paths])
    if (added.error !== null || added.code !== 0) return { error: failure(added) }
    const messageArgs = message.flatMap((line) => ['-m', line])
    const committed = await this.git(['commit', '--quiet', '--no-verify', ...messageArgs, '--', ...paths])
    const head = (await this.must(['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
    if (head !== source) return { commit: head }
    return { error: failure(committed) }
  }

  // Pushes HEAD to origin's `base`, never forced. `rejected`: git or origin refused it (its reason); `unknown`: no
  // answer in time — it may have reached origin.
  async push(base: string): Promise<{ readonly outcome: 'pushed' } | { readonly outcome: 'rejected' | 'unknown'; readonly error: string }> {
    const result = await this.git(['push', '--porcelain', '--no-verify', REMOTE, `HEAD:refs/heads/${base}`], {
      timeoutMs: NETWORK_TIMEOUT_MS,
    })
    if (result.error === null && result.code === 0) return { outcome: 'pushed' }
    if (result.error !== null && result.error.kind === 'timed_out') return { outcome: 'unknown', error: failure(result) }
    return { outcome: 'rejected', error: pushError(result) }
  }

  // Undoes the local commit of a rejected push: the checkout back on `source`. Null when HEAD is on it again,
  // otherwise why not.
  async undoCommit(source: string): Promise<string | null> {
    const reset = await this.git(['reset', '--quiet', '--keep', source])
    const head = (await this.git(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim()
    if (head === source) return null
    return reset.error === null && reset.code === 0 ? `HEAD is ${head}, not ${source}` : failure(reset)
  }

  // Puts the paths back as `source` has them, in the index and the working tree: a path `source` has — its content;
  // one it lacks — gone. Null when it went well, otherwise git's reason.
  async restore(source: string, paths: readonly { readonly path: string; readonly existed: boolean }[]): Promise<string | null> {
    const existing = paths.filter((one) => one.existed).map((one) => one.path)
    const added = paths.filter((one) => !one.existed).map((one) => one.path)
    const runs: (readonly string[])[] = []
    if (existing.length > 0) runs.push(['checkout', '--quiet', source, '--', ...existing])
    if (added.length > 0) {
      runs.push(['rm', '--quiet', '--cached', '--force', '--ignore-unmatch', '--', ...added])
      runs.push(['clean', '--quiet', '--force', '--', ...added])
    }
    for (const args of runs) {
      const result = await this.git(args)
      if (result.error !== null || result.code !== 0) return failure(result)
    }
    return null
  }
}

// What git said of a rejected push: the reason of its refused ref (`--porcelain`: `!<TAB><ref>:<ref><TAB>[rejected]
// (fetch first)`), as «rejected (fetch first)»; otherwise its first line of errors.
export function pushError(result: RunResult): string {
  for (const line of result.stdout.split(/\r?\n/)) {
    const [flag, , summary] = line.split('\t')
    if (flag === '!' && summary !== undefined) return summary.replace(/^\[([^\]]*)\]\s*/, '$1 ').trim()
  }
  if (result.error !== null) return result.error.reason
  const said = [result.stderr, result.stdout]
    .flatMap((text) => text.split(/\r?\n/))
    .map((line) => line.trim())
    .find((line) => line !== '' && !line.startsWith('To ') && line !== 'Done')
  return said ?? `git push failed (exit ${result.code})`
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
