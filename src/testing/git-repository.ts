// A project's repository for tests, with real git (decision «Только подделки»: git is real, on temporary local
// repositories, `origin` a local bare repository): in a new temporary directory, a bare repository as `origin` and a
// clone of it — the project's main checkout. The test's own git commands (commit, push …) run with an empty global
// configuration of their own (GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM) and an invented author, so the user's settings
// (signing, hooks, the default branch name) never reach them; the plugin's reads run as the plugin runs them.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { realMachine } from '../platform/machine'
import { runProgram } from '../platform/run'

export type TestRepository = {
  // The bare repository `origin`.
  readonly origin: string
  // The clone: the project's main checkout.
  readonly checkout: string
  // Runs git in the checkout (or in `cwd`); throws when it fails. Returns its output.
  git(args: readonly string[], cwd?: string): Promise<string>
  // Writes the files into the checkout (paths from its root, with /) and commits them on the current branch; returns
  // the commit.
  commit(files: Readonly<Record<string, string>>, message?: string): Promise<string>
  // Writes a file into the checkout without committing it.
  write(path: string, text: string): void
  // Pushes the current branch (or `branch`) to origin.
  push(branch?: string): Promise<void>
}

export type TestRepositoryOptions = {
  // The repository's default branch: the branch of the first commit, origin's HEAD.
  readonly defaultBranch?: string
  // Whether the clone knows origin's HEAD (refs/remotes/origin/HEAD), as after `git clone` of a repository with
  // commits; false: as after `git init` and `git remote add`, where only the remote can name its default branch.
  readonly originHead?: boolean
}

export async function withRepository(
  body: (repo: TestRepository) => Promise<void>,
  options: TestRepositoryOptions = {},
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'agent-queue-repo-'))
  const branch = options.defaultBranch ?? 'main'
  const config = join(root, 'gitconfig')
  writeFileSync(config, '')
  const env = {
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Avery Example',
    GIT_AUTHOR_EMAIL: 'avery@example.invalid',
    GIT_COMMITTER_NAME: 'Avery Example',
    GIT_COMMITTER_EMAIL: 'avery@example.invalid',
  }
  const machine = realMachine()
  const origin = join(root, 'origin.git')
  const checkout = join(root, 'shop-demo')
  const git = async (args: readonly string[], cwd = checkout): Promise<string> => {
    const result = await runProgram(machine, 'git', args, { cwd, env, timeoutMs: 60_000 })
    if (result.error !== null || result.code !== 0) {
      throw new Error(`git ${args.join(' ')}: ${result.error?.reason ?? `exit ${result.code}`}\n${result.stderr}`)
    }
    return result.stdout
  }
  const write = (path: string, text: string) => {
    const file = join(checkout, ...path.split('/'))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  const repo: TestRepository = {
    origin,
    checkout,
    git,
    write,
    commit: async (files, message = 'change') => {
      for (const [path, text] of Object.entries(files)) write(path, text)
      await git(['add', '--', ...Object.keys(files)])
      await git(['commit', '--quiet', '--no-verify', '-m', message])
      return (await git(['rev-parse', 'HEAD'])).trim()
    },
    push: async (target) => {
      const current = target ?? (await git(['symbolic-ref', '--short', 'HEAD'])).trim()
      await git(['push', '--quiet', 'origin', `HEAD:refs/heads/${current}`])
      await git(['fetch', '--quiet', 'origin'])
    },
  }
  try {
    await git(['init', '--quiet', '--bare', `--initial-branch=${branch}`, origin], root)
    await git(['init', '--quiet', `--initial-branch=${branch}`, checkout], root)
    await git(['remote', 'add', 'origin', origin])
    await repo.commit({ 'README.md': '# shop-demo\n' }, 'start')
    await repo.push()
    if (options.originHead ?? true) await git(['remote', 'set-head', 'origin', branch])
    await body(repo)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
