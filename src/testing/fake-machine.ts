// A fake computer for the plugin's tests: any system (linux, darwin, win32) on any real one, an invented environment
// and home directory, files in memory, a clock that moves only when told, and a process start that records each
// request and answers it as the test says. Nothing here touches the real disk or starts a real process.
import type { Env, Machine, Platform, StartOutcome, StartRequest } from '../platform/machine'

export type FakeAnswer = Partial<Omit<StartOutcome, 'startError'>> & {
  readonly startError?: StartOutcome['startError']
  // How far the fake clock moves while the process runs.
  readonly durationMs?: number
}

export type FakeClock = { now(): number; advance(ms: number): void }

export type FakeMachine = Machine & {
  // Every process start, in order.
  readonly starts: StartRequest[]
  // The files in memory by their exact path, including those createText made.
  readonly files: Map<string, string>
  readonly clock: FakeClock
}

export type FakeMachineOptions = {
  readonly platform: Platform
  readonly env?: Env
  readonly homedir?: string
  readonly cwd?: string
  // The worker's program; by default a Node.js outside any Orca installation.
  readonly execPath?: string
  // Paths of files the system can run.
  readonly executables?: readonly string[]
  readonly files?: Readonly<Record<string, string>>
  readonly answer?: (request: StartRequest) => FakeAnswer
  readonly clock?: FakeClock
  // Thrown by createText instead of creating the file.
  readonly createError?: Error
}

// A Node.js of each system, outside any Orca installation.
export const FAKE_NODE: Record<Platform, string> = {
  linux: '/usr/bin/node',
  darwin: '/usr/local/bin/node',
  win32: 'C:\\Program Files\\nodejs\\node.exe',
}

// The variables Orca passes to a trusted-worker (Orca 1.4.274, out/main/index.js of its app.asar: the worker is forked
// with only these, on Windows under upper-case names with SystemRoot as such, plus GIT_TERMINAL_PROMPT and
// ELECTRON_RUN_AS_NODE).
export const ORCA_WORKER_VARIABLES = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'SSH_AUTH_SOCK',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
]

// The environment a trusted-worker gets from Orca when Orca itself runs with `full`.
export function orcaWorkerEnv(full: Env, platform: Platform): Env {
  const byName = new Map<string, string>()
  for (const [name, value] of Object.entries(full)) {
    if (value !== undefined) byName.set(platform === 'win32' ? name.toUpperCase() : name, value)
  }
  const env: Record<string, string> = {}
  for (const name of ORCA_WORKER_VARIABLES) {
    const value = byName.get(name)
    if (value !== undefined) env[name === 'SYSTEMROOT' && platform === 'win32' ? 'SystemRoot' : name] = value
  }
  return { ...env, GIT_TERMINAL_PROMPT: '0', ELECTRON_RUN_AS_NODE: '1' }
}

// An invented user's home on each system.
export const FAKE_HOME: Record<Platform, string> = {
  linux: '/home/avery',
  darwin: '/Users/avery',
  win32: 'C:\\Users\\Avery',
}

export function fakeClock(start = Date.UTC(2026, 0, 15, 9, 30, 0)): FakeClock {
  let now = start
  return {
    now: () => now,
    advance: (ms) => {
      now += ms
    },
  }
}

export function fakeMachine(options: FakeMachineOptions): FakeMachine {
  const windows = options.platform === 'win32'
  // Windows file names have no case.
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b)
  const executables = [...(options.executables ?? [])]
  const files = new Map<string, string>(Object.entries(options.files ?? {}))
  const find = (path: string) => [...files.keys()].find((key) => same(key, path))
  const starts: StartRequest[] = []
  const clock = options.clock ?? fakeClock()
  return {
    platform: options.platform,
    env: options.env ?? {},
    homedir: options.homedir ?? FAKE_HOME[options.platform],
    cwd: options.cwd ?? options.homedir ?? FAKE_HOME[options.platform],
    execPath: options.execPath ?? FAKE_NODE[options.platform],
    now: () => clock.now(),
    isRunnableFile: (path) => executables.some((file) => same(file, path)),
    readText: (path) => {
      const key = find(path)
      return key === undefined ? null : (files.get(key) ?? null)
    },
    // A directory exists while a file is in it (or deeper): the names of what is right inside it, in order.
    listNames: (path) => {
      const separators = windows ? /[\\/]/ : /\//
      const parts = (file: string) => file.split(separators).filter((part) => part !== '')
      const dir = parts(path)
      const names = new Set<string>()
      for (const file of files.keys()) {
        const inside = parts(file)
        if (inside.length > dir.length && dir.every((part, at) => same(part, inside[at] ?? ''))) names.add(inside[dir.length] ?? '')
      }
      return names.size === 0 ? null : [...names].sort()
    },
    createText: async (path, text) => {
      if (options.createError) throw options.createError
      if (find(path) !== undefined) return false
      files.set(path, text)
      return true
    },
    start: async (request) => {
      starts.push(request)
      const answer = options.answer?.(request) ?? {}
      clock.advance(answer.durationMs ?? 0)
      return {
        code: answer.startError ? null : (answer.code ?? 0),
        signal: answer.signal ?? null,
        stdout: answer.stdout ?? '',
        stderr: answer.stderr ?? '',
        truncated: answer.truncated ?? false,
        timedOut: answer.timedOut ?? false,
        outputError: answer.outputError ?? null,
        stopError: answer.stopError ?? null,
        startError: answer.startError ?? null,
      }
    },
    starts,
    files,
    clock,
  }
}

// The answer of Orca's CLI to `status --json` when Orca runs.
export function orcaStatusAnswer(version = '1.4.273'): FakeAnswer {
  return {
    code: 0,
    stdout: JSON.stringify({
      id: 'local-status',
      ok: true,
      result: { app: { running: true }, runtime: { state: 'ready', appVersion: version } },
    }),
  }
}
