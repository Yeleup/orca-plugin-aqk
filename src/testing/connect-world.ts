// The world of the tests of «Подключение проекта» (decision «Только подделки»): a project's repository with real git —
// its `origin` a local bare repository (./git-repository.ts) — fake `gh` with a fake GitHub (./fake-github.ts), Orca's
// mock host with Orca's projects and a fake CLI of Orca (./fake-orca.ts), and the real worker (src/worker.ts) on a
// computer of its own that runs real git and only these fakes:
//
// - the computer is this one's system with the environment Orca gives a worker (no ORCA_CLI_COMMAND, no GH_* of the
//   user), a temporary home directory — the plugin's data directory and the CLI's known path are in it —, the test
//   repository's git configuration (an empty global one of its own, an invented author) and a fake clock; every
//   process it starts is recorded (`starts`, with its working directory);
// - `gh` is found in PATH and answered by the fake GitHub (a test may hold a call back: `holdGh`); the CLI of Orca is
//   found at its known path under the home and answered by the fake Orca; any other `gh`, `orca` or `orca-ide` of this
//   computer is never found or started;
// - the project's `origin` looks like a GitHub repository (`https://github.com/demo-org/shop-demo.git`, the owner's
//   repository the fake GitHub serves) while git reaches the local bare repository through `url.<bare>.insteadOf`.
//   `github: false` leaves `origin` the local path: no GitHub repository;
// - `otherHost` adds a copy of the project with the same id on the host `ssh:build-box` (or the host given), listed by
//   Orca before the local one: its path is a second real repository of this computer, connected (its `origin` has
//   .agent-queue.json);
// - `beforeWrite` runs right before the worker writes a file: someone changes the disk at that moment;
// - `manualTimer` gives the worker's answer window of «Подключить» to the test (`timer`): it elapses only when fired.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env as processEnv } from 'node:process'
import { mockHost, mountWorker, type MockHost, type TestWorker } from 'orca/testing'
import type { AnswerTimer } from '../connect/connect'
import { pathsOf, realMachine, type Machine, type StartOutcome, type StartRequest } from '../platform/machine'
import type { Project } from '../protocol'
import { startOn } from '../worker'
import { FAKE_GH, FakeGitHub, readCall, type FakeGhCall } from './fake-github'
import { fakeClock, orcaWorkerEnv, type FakeClock } from './fake-machine'
import { fakeOrca, type FakeOrca } from './fake-orca'
import { withRepository, type TestRepository } from './git-repository'

export const GITHUB_REPOSITORY = 'demo-org/shop-demo'
export const GITHUB_URL = `https://github.com/${GITHUB_REPOSITORY}.git`
export const OWNER_LOGIN = 'avery-example'
export const OTHER_HOST = 'ssh:build-box'

// The project in Orca.
export const SHOP: Project = { id: 'project-shop', hostId: 'local', name: 'shop-demo' }

// A window of the worker that elapses only when the test fires it.
export type ManualTimer = {
  readonly timer: AnswerTimer
  // How many windows wait now.
  pending(): number
  // Elapses every window waiting now.
  fire(): void
}

export function manualTimer(): ManualTimer {
  const waiting = new Set<() => void>()
  return {
    timer: () => {
      let release: () => void = () => {}
      const elapsed = new Promise<void>((resolve) => {
        release = () => {
          waiting.delete(release)
          resolve()
        }
        waiting.add(release)
      })
      return { elapsed, cancel: () => waiting.delete(release) }
    },
    pending: () => waiting.size,
    fire: () => {
      for (const release of [...waiting]) release()
    },
  }
}

export type ConnectWorld = {
  readonly repo: TestRepository
  readonly github: FakeGitHub
  readonly orca: FakeOrca
  readonly machine: Machine
  readonly clock: FakeClock
  readonly home: string
  readonly worker: TestWorker
  // Every process the worker started, in order.
  readonly starts: StartRequest[]
  // The answer window of the worker, when the test took it.
  readonly timer: ManualTimer | null
  // The repository of the copy on another host, when there is one.
  readonly other: TestRepository | null
  // The panel's host: its requests go to the real worker.
  panelHost(settings?: Record<string, string>): MockHost
  // Makes the bare `origin` refuse every push (a pre-receive hook) until `acceptPushes()`.
  rejectPushes(): void
  acceptPushes(): void
  // Holds back the next gh call that `match` until the returned release.
  holdGh(match: (call: FakeGhCall) => boolean): () => void
  // Runs right before the worker writes a file (createText, replaceText) — someone acts on the disk meanwhile.
  beforeWrite: ((path: string) => void) | null
}

export type ConnectWorldOptions = {
  // Whether `origin` is a GitHub repository; by default it is.
  readonly github?: boolean
  // The user gh runs as; null — gh is not logged in.
  readonly login?: string | null
  // A copy of the project on this host, listed by Orca before the local project.
  readonly otherHost?: string
  // Whether Orca lists the local project; by default it does.
  readonly local?: boolean
  readonly manualTimer?: boolean
}

export async function withConnectWorld(body: (world: ConnectWorld) => Promise<void>, options: ConnectWorldOptions = {}): Promise<void> {
  if (options.otherHost === undefined) return inWorld(body, options, null)
  await withRepository(async (other) => {
    await other.commit({ '.agent-queue.json': `${JSON.stringify({ version: 1, testCommand: 'make test', language: 'en', dataRule: 'No customer data.' })}\n` }, 'connected')
    await other.push()
    await inWorld(body, options, other)
  })
}

async function inWorld(body: (world: ConnectWorld) => Promise<void>, options: ConnectWorldOptions, other: TestRepository | null): Promise<void> {
  await withRepository(async (repo) => {
    if (options.github !== false) {
      await repo.git(['remote', 'set-url', 'origin', GITHUB_URL])
      await repo.git(['config', `url.${repo.origin}.insteadOf`, GITHUB_URL])
      await repo.git(['fetch', '--quiet', 'origin'])
    }
    const home = mkdtempSync(join(tmpdir(), 'agent-queue-connect-home-'))
    try {
      const github = new FakeGitHub({ repository: GITHUB_REPOSITORY, login: options.login === undefined ? OWNER_LOGIN : options.login })
      const projects = [
        ...(other === null ? [] : [{ id: SHOP.id, name: SHOP.name, kind: 'git', hostId: options.otherHost ?? OTHER_HOST, path: other.checkout }]),
        ...(options.local === false ? [] : [{ id: SHOP.id, name: SHOP.name, kind: 'git', hostId: SHOP.hostId, path: repo.checkout }]),
        { id: 'project-notes', name: 'notes', kind: 'folder', hostId: 'local', path: join(home, 'notes') },
      ]
      const orca = fakeOrca({ platform: realMachine().platform, home, results: { 'project.list': () => ({ projects, truncated: false }) } })
      const clock = fakeClock()
      const starts: StartRequest[] = []
      const holds: { match: (call: FakeGhCall) => boolean; gate: Promise<void> }[] = []
      const writes: { before: ((path: string) => void) | null } = { before: null }
      const machine = connectMachine({ home, env: repo.env, github, orca, clock, starts, holds, writes })
      const timer = options.manualTimer === true ? manualTimer() : null
      const worker = await mountWorker(
        { default: (api) => startOn(api, machine, timer === null ? {} : { connectTimer: timer.timer }) },
        { host: orca.host },
      )
      const hook = join(repo.origin, 'hooks', 'pre-receive')
      const requests = ['projects.list', 'connect.projects', 'connect.checkGit', 'connect.checkGh', 'connect.checkAgents', 'connect.connect', 'connect.wait'] as const
      const world: ConnectWorld = {
        repo,
        github,
        orca,
        machine,
        clock,
        home,
        worker,
        starts,
        timer,
        other,
        panelHost: (settings = { interfaceLanguage: 'ru' }) =>
          mockHost({
            settings,
            requests: Object.fromEntries(requests.map((name) => [name, (input: unknown) => worker.request(name, input as never)])),
          }),
        rejectPushes: () => {
          writeFileSync(hook, '#!/bin/sh\necho "the test closed pushes" >&2\nexit 1\n')
          chmodSync(hook, 0o755)
        },
        acceptPushes: () => rmSync(hook, { force: true }),
        get beforeWrite() {
          return writes.before
        },
        set beforeWrite(run) {
          writes.before = run
        },
        holdGh: (match) => {
          let release: () => void = () => {}
          const gate = new Promise<void>((resolve) => (release = resolve))
          holds.push({ match, gate })
          return release
        },
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

// The hooks of the tests of the connection: each writes its name to `marks` (a file outside the repository); pre-commit,
// commit-msg and pre-push then refuse (exit 1), prepare-commit-msg adds a line to the message, post-commit,
// post-checkout and reference-transaction only mark. Written into `dir` (a hooks directory), executable.
export const MARKED_HOOKS = [
  'pre-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-push',
  'post-checkout',
  'reference-transaction',
  'post-index-change',
] as const

export function writeMarkingHooks(dir: string, marks: string): void {
  mkdirSync(dir, { recursive: true })
  const file = marks.replace(/\\/g, '/')
  for (const name of MARKED_HOOKS) {
    const refuse = name === 'pre-commit' || name === 'commit-msg' || name === 'pre-push' ? 'exit 1\n' : ''
    const edit = name === 'prepare-commit-msg' ? 'echo "added by a hook" >> "$1"\n' : ''
    const path = join(dir, name)
    writeFileSync(path, `#!/bin/sh\necho ${name} >> "${file}"\n${edit}${refuse}exit 0\n`)
    chmodSync(path, 0o755)
  }
}

// The computer of the worker in these tests: this one, with real git, and only the fakes as `gh` and Orca's CLI.
export function connectMachine(options: {
  readonly home: string
  readonly env: Readonly<Record<string, string>>
  readonly github: FakeGitHub
  readonly orca: FakeOrca
  readonly clock: FakeClock
  readonly starts: StartRequest[]
  readonly holds: { match: (call: FakeGhCall) => boolean; gate: Promise<void> }[]
  readonly writes: { before: ((path: string) => void) | null }
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
    now: () => options.clock.now(),
    createText: async (path, text) => {
      options.writes.before?.(path)
      return real.createText(path, text)
    },
    replaceText: async (path, text) => {
      options.writes.before?.(path)
      return real.replaceText(path, text)
    },
    isRunnableFile: (path) => {
      if (same(path, gh)) return true
      if (same(path, options.orca.cli)) return options.orca.cliPresent
      if (faked(path)) return false
      return real.isRunnableFile(path)
    },
    start: async (request): Promise<StartOutcome> => {
      options.starts.push(request)
      if (same(request.file, gh)) {
        const call = { ...request, file: FAKE_GH }
        const held = options.holds.findIndex((hold) => hold.match(readCall(call)))
        if (held >= 0) {
          const [hold] = options.holds.splice(held, 1)
          await hold?.gate
        }
        return options.github.machine.start(call)
      }
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
