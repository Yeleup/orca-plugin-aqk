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
  // Paths of files the system can run.
  readonly executables?: readonly string[]
  readonly files?: Readonly<Record<string, string>>
  readonly answer?: (request: StartRequest) => FakeAnswer
  readonly clock?: FakeClock
  // Thrown by createText instead of creating the file.
  readonly createError?: Error
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
    now: () => clock.now(),
    isRunnableFile: (path) => executables.some((file) => same(file, path)),
    readText: (path) => {
      const key = find(path)
      return key === undefined ? null : (files.get(key) ?? null)
    },
    createText: (path, text) => {
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
