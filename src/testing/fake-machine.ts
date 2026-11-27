// A fake computer for the plugin's tests: any system (linux, darwin, win32) on any real one, an invented environment
// and home directory, files in memory, a clock that moves only when told, and a process start that records each
// request and answers it as the test says. Nothing here touches the real disk or starts a real process. Symbolic links
// (`links`) work as on a disk: reads and writes through one land in its target, and a directory lists it as a link. A
// file's time of last write is the clock's reading at the moment it was written — by the test (`files.set`) or by
// createText.
import type { DirectoryEntry, Env, Machine, Platform, StartOutcome, StartRequest } from '../platform/machine'

export type FakeAnswer = Partial<Omit<StartOutcome, 'startError'>> & {
  readonly startError?: StartOutcome['startError']
  // How far the fake clock moves while the process runs.
  readonly durationMs?: number
}

export type FakeClock = { now(): number; advance(ms: number): void }

export type FakeMachine = Machine & {
  // Every process start, in order.
  readonly starts: StartRequest[]
  // The files in memory by their exact path, including those createText made. Setting one is writing it: its time of
  // last write becomes the clock's reading.
  readonly files: Map<string, string>
  // Symbolic links (or Windows junctions) to directories: the link's path and the directory it points to.
  readonly links: Map<string, string>
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
  const clock = options.clock ?? fakeClock()
  // When each file was last written: the fake clock's reading at the moment the test (files.set) or createText wrote
  // it.
  const written = new Map<string, number>()
  const files = new Map<string, string>()
  const put = files.set.bind(files)
  const remove = files.delete.bind(files)
  const empty = files.clear.bind(files)
  files.set = (path, text) => {
    written.set(path, clock.now())
    return put(path, text)
  }
  files.delete = (path) => {
    written.delete(path)
    return remove(path)
  }
  files.clear = () => {
    written.clear()
    empty()
  }
  for (const [path, text] of Object.entries(options.files ?? {})) files.set(path, text)
  const links = new Map<string, string>()
  const separators = windows ? /[\\/]/ : /\//
  const parts = (path: string) => path.split(separators).filter((part) => part !== '')
  const within = (path: string[], dir: string[]) => path.length >= dir.length && dir.every((part, at) => same(part, path[at] ?? ''))
  // The path with every link on its way replaced by the link's target, as a disk follows them.
  const resolve = (path: string): string => {
    let resolved = path
    for (let turn = 0; turn < 40; turn++) {
      const link = [...links.keys()].find((each) => within(parts(resolved), parts(each)))
      if (link === undefined) return resolved
      const rest = parts(resolved).slice(parts(link).length)
      resolved = [links.get(link) ?? '', ...rest].join(windows ? '\\' : '/')
    }
    throw new Error(`ELOOP: too many symbolic links, ${path}`)
  }
  const find = (path: string) => {
    const target = resolve(path)
    return [...files.keys()].find((key) => same(key, target))
  }
  const starts: StartRequest[] = []
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
    modifiedAt: (path) => {
      const key = find(path)
      return key === undefined ? null : (written.get(key) ?? null)
    },
    // A directory exists while a file is in it (or deeper), or a link: what is right inside it, in order of names.
    listEntries: (path) => {
      const dir = parts(resolve(path))
      const entries = new Map<string, DirectoryEntry['kind']>()
      for (const file of files.keys()) {
        const each = parts(file)
        if (each.length > dir.length && within(each, dir)) entries.set(each[dir.length] ?? '', each.length === dir.length + 1 ? 'file' : 'directory')
      }
      for (const link of links.keys()) {
        const each = parts(link)
        if (each.length === dir.length + 1 && within(each, dir)) entries.set(each[dir.length] ?? '', 'other')
      }
      if (entries.size === 0) return null
      return [...entries].map(([name, kind]) => ({ name, kind })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    },
    createText: async (path, text) => {
      if (options.createError) throw options.createError
      if (find(path) !== undefined) return false
      files.set(resolve(path), text)
      return true
    },
    replaceText: async (path, text, expected) => {
      const key = find(path)
      if (key === undefined || files.get(key) !== expected) return false
      files.set(key, text)
      return true
    },
    removeText: async (path, expected) => {
      const key = find(path)
      if (key === undefined || files.get(key) !== expected) return false
      files.delete(key)
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
    links,
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
