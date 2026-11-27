// The world of the tests of «Подключение проекта» (decision «Только подделки»): a project's repository with real git —
// its `origin` a local bare repository (./git-repository.ts) — fake `gh` with a fake GitHub (./fake-github.ts), Orca's
// mock host with Orca's projects and a fake CLI of Orca (./fake-orca.ts), and the real worker (src/worker.ts) on a
// computer of its own that runs real git and only these fakes:
//
// - the computer is this one's system with the environment Orca gives a worker (no ORCA_CLI_COMMAND, no GH_* of the
//   user), a temporary home directory — the plugin's data directory and the CLI's known path are in it — and the test
//   repository's git configuration: an empty global one of its own, an invented author;
// - `gh` is found in PATH and answered by the fake GitHub; the CLI of Orca is found at its known path under the home and
//   answered by the fake Orca; any other `gh`, `orca` or `orca-ide` of this computer is never found or started;
// - the project's `origin` looks like a GitHub repository (`https://github.com/demo-org/shop-demo.git`, the owner's
//   repository the fake GitHub serves) while git reaches the local bare repository through `url.<bare>.insteadOf`.
//   `github: false` leaves `origin` the local path: no GitHub repository.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env as processEnv } from 'node:process'
import { mockHost, mountWorker, type MockHost, type TestWorker } from 'orca/testing'
import { pathsOf, realMachine, type Machine, type StartOutcome } from '../platform/machine'
import { FAKE_GH, FakeGitHub } from './fake-github'
import { orcaWorkerEnv } from './fake-machine'
import { fakeOrca, type FakeOrca } from './fake-orca'
import { withRepository, type TestRepository } from './git-repository'
import { startOn } from '../worker'
import type { Project } from '../protocol'

export const GITHUB_REPOSITORY = 'demo-org/shop-demo'
export const GITHUB_URL = `https://github.com/${GITHUB_REPOSITORY}.git`
export const OWNER_LOGIN = 'avery-example'

// The project in Orca.
export const SHOP: Project = { id: 'project-shop', hostId: 'local', name: 'shop-demo' }

export type ConnectWorld = {
  readonly repo: TestRepository
  readonly github: FakeGitHub
  readonly orca: FakeOrca
  readonly machine: Machine
  readonly home: string
  readonly worker: TestWorker
  // The panel's host: its requests go to the real worker.
  panelHost(settings?: Record<string, string>): MockHost
  // Makes the bare `origin` refuse every push (a pre-receive hook) until `acceptPushes()`.
  rejectPushes(): void
  acceptPushes(): void
}

export type ConnectWorldOptions = {
  // Whether `origin` is a GitHub repository; by default it is.
  readonly github?: boolean
  // The user gh runs as; null — gh is not logged in.
  readonly login?: string | null
}

export async function withConnectWorld(body: (world: ConnectWorld) => Promise<void>, options: ConnectWorldOptions = {}): Promise<void> {
  await withRepository(async (repo) => {
    if (options.github !== false) {
      await repo.git(['remote', 'set-url', 'origin', GITHUB_URL])
      await repo.git(['config', `url.${repo.origin}.insteadOf`, GITHUB_URL])
      await repo.git(['fetch', '--quiet', 'origin'])
    }
    const home = mkdtempSync(join(tmpdir(), 'agent-queue-connect-home-'))
    try {
      const github = new FakeGitHub({ repository: GITHUB_REPOSITORY, login: options.login === undefined ? OWNER_LOGIN : options.login })
      const orca = fakeOrca({
        platform: realMachine().platform,
        home,
        results: {
          'project.list': () => ({
            projects: [{ id: SHOP.id, name: SHOP.name, kind: 'git', hostId: SHOP.hostId, path: repo.checkout }],
            truncated: false,
          }),
        },
      })
      const machine = connectMachine({ home, env: repo.env, github, orca })
      const worker = await mountWorker({ default: (api) => startOn(api, machine) }, { host: orca.host })
      const hook = join(repo.origin, 'hooks', 'pre-receive')
      const world: ConnectWorld = {
        repo,
        github,
        orca,
        machine,
        home,
        worker,
        panelHost: (settings = { interfaceLanguage: 'ru' }) =>
          mockHost({
            settings,
            requests: {
              'projects.list': (input) => worker.request('projects.list', input),
              'connect.projects': (input) => worker.request('connect.projects', input),
              'connect.checkGit': (input) => worker.request('connect.checkGit', input),
              'connect.checkGh': (input) => worker.request('connect.checkGh', input),
              'connect.checkAgents': (input) => worker.request('connect.checkAgents', input),
              'connect.connect': (input) => worker.request('connect.connect', input),
            },
          }),
        rejectPushes: () => {
          writeFileSync(hook, '#!/bin/sh\necho "the test closed pushes" >&2\nexit 1\n')
          chmodSync(hook, 0o755)
        },
        acceptPushes: () => rmSync(hook, { force: true }),
      }
      try {
        await body(world)
      } finally {
        await worker.deactivate()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
}

// The computer of the worker in these tests: this one, with real git, and only the fakes as `gh` and Orca's CLI.
export function connectMachine(options: {
  readonly home: string
  readonly env: Readonly<Record<string, string>>
  readonly github: FakeGitHub
  readonly orca: FakeOrca
}): Machine {
  const real = realMachine()
  const paths = pathsOf(real)
  const windows = real.platform === 'win32'
  const fakeBin = paths.join(options.home, 'fake-bin')
  const gh = paths.join(fakeBin, windows ? 'gh.exe' : 'gh')
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b)
  // `gh`, `orca` or `orca-ide` of this computer: never found, never started.
  const faked = (path: string) => ['gh', 'orca', 'orca-ide'].includes(paths.basename(path).toLowerCase().replace(/\.(exe|cmd|bat|com)$/, ''))
  const worker = orcaWorkerEnv(processEnv, real.platform)
  const home = windows ? { USERPROFILE: options.home } : { HOME: options.home }
  const env = {
    ...worker,
    ...home,
    PATH: [fakeBin, worker.PATH ?? worker.Path ?? ''].filter((part) => part !== '').join(windows ? ';' : ':'),
    ...options.env,
  }
  return realMachine({
    env,
    homedir: options.home,
    isRunnableFile: (path) => {
      if (same(path, gh)) return true
      if (same(path, options.orca.cli)) return options.orca.cliPresent
      if (faked(path)) return false
      return real.isRunnableFile(path)
    },
    start: async (request): Promise<StartOutcome> => {
      if (same(request.file, gh)) return options.github.machine.start({ ...request, file: FAKE_GH })
      if (same(request.file, options.orca.cli)) return options.orca.machine.start({ ...request, file: options.orca.cli })
      if (faked(request.file)) {
        return {
          code: null,
          signal: null,
          stdout: '',
          stderr: '',
          truncated: false,
          timedOut: false,
          outputError: null,
          stopError: null,
          startError: { code: 'ENOENT', message: `spawn ${request.file} ENOENT` },
        }
      }
      return real.start(request)
    },
  })
}
