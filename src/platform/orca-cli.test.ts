// The search for Orca's CLI (Ф14, К14.5 — the search part): on fake systems with files and process starts in memory,
// which commands the plugin starts and what the result holds; then once with real processes on this computer, with
// fake CLIs in a temporary PATH. The real Orca CLI is never started.
import { assert, test } from 'orca/testing'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { env, execPath, platform } from 'node:process'
import { fakeMachine, orcaStatusAnswer, orcaWorkerEnv, type FakeAnswer, type FakeMachine } from '../testing/fake-machine'
import { realMachine, realPlatform, type StartRequest } from './machine'
import { ORCA_CLI_NOT_FOUND, findOrcaCli, knownOrcaCliPaths } from './orca-cli'

const statusArgs = ['status', '--json']

// Each start as `<file> <args…>`.
function started(machine: FakeMachine): string[] {
  return machine.starts.map((request) => [request.file, ...request.args].join(' '))
}

// The last part of a path of any system.
function lastPart(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

// Answers `status --json` as Orca's CLI for the files in `cli`, and as GNOME's screen reader (no JSON) for any other.
function answers(cli: readonly string[]): (request: StartRequest) => FakeAnswer {
  return (request) => (cli.includes(request.file) ? orcaStatusAnswer('1.4.274') : { code: 0, stdout: 'Screen reader on.\n' })
}

test('К14.5 (поиск): на подделке linux без ORCA_CLI_COMMAND плагин вызывает orca-ide и ни разу не голый orca', async () => {
  const orcaIde = '/home/avery/.local/bin/orca-ide'
  for (const variables of [{}, { ORCA_CLI_COMMAND: 'orca' }, { ORCA_CLI_COMMAND: '  ' }]) {
    // GNOME's screen reader /usr/bin/orca comes first in PATH.
    const machine = fakeMachine({
      platform: 'linux',
      env: { PATH: '/usr/bin:/home/avery/.local/bin', ...variables },
      executables: ['/usr/bin/orca', orcaIde],
      answer: answers([orcaIde]),
    })
    const search = await findOrcaCli(machine)
    assert.deepEqual(started(machine), [`${orcaIde} status --json`], JSON.stringify(variables))
    assert.ok(search.found)
    assert.equal(search.file, orcaIde)
    assert.equal(search.source, 'PATH')
    assert.equal(search.version, '1.4.274')
    assert.ok(machine.starts.every((request) => lastPart(request.file) !== 'orca'), 'a bare orca was started')
  }
})

test('К14.5 (поиск): на подделках darwin и win32 плагин вызывает orca', async () => {
  const mac = fakeMachine({
    platform: 'darwin',
    env: { PATH: '/opt/homebrew/bin:/usr/local/bin' },
    executables: ['/opt/homebrew/bin/orca-ide', '/usr/local/bin/orca'],
    answer: answers(['/opt/homebrew/bin/orca-ide', '/usr/local/bin/orca']),
  })
  const onMac = await findOrcaCli(mac)
  assert.deepEqual(started(mac), ['/usr/local/bin/orca status --json'])
  assert.ok(onMac.found && onMac.file === '/usr/local/bin/orca' && onMac.source === 'PATH')

  const bin = 'C:\\Users\\Avery\\AppData\\Local\\Programs\\Orca\\resources\\bin'
  const win = fakeMachine({
    platform: 'win32',
    env: { Path: `C:\\Windows\\System32;${bin}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    executables: [`${bin}\\orca-ide.exe`, `${bin}\\orca.exe`],
    answer: answers([`${bin}\\orca-ide.exe`, `${bin}\\orca.exe`]),
  })
  const onWindows = await findOrcaCli(win)
  assert.deepEqual(started(win), [`${bin}\\orca.exe status --json`])
  assert.ok(onWindows.found && onWindows.file === `${bin}\\orca.exe` && onWindows.source === 'PATH')
})

test('К14.5 (поиск): с заданной ORCA_CLI_COMMAND плагин вызывает её значение', async () => {
  // The CLI of Orca's terminals on Linux: a path whose last part is orca, which is not the bare name.
  const shim = '/home/avery/.config/orca/linux-orca-cli-shim/orca'
  const linux = fakeMachine({
    platform: 'linux',
    env: { PATH: '/home/avery/.local/bin', ORCA_CLI_COMMAND: shim },
    executables: [shim, '/home/avery/.local/bin/orca-ide'],
    answer: answers([shim, '/home/avery/.local/bin/orca-ide']),
  })
  const onLinux = await findOrcaCli(linux)
  assert.deepEqual(started(linux), [`${shim} status --json`])
  assert.ok(onLinux.found && onLinux.file === shim && onLinux.source === 'ORCA_CLI_COMMAND')

  const cli = 'D:\\Apps\\Orca\\resources\\bin\\orca.exe'
  const win = fakeMachine({
    platform: 'win32',
    env: { Path: 'C:\\Tools', orca_cli_command: cli },
    executables: [cli, 'C:\\Tools\\orca.exe'],
    answer: answers([cli, 'C:\\Tools\\orca.exe']),
  })
  const onWindows = await findOrcaCli(win)
  assert.deepEqual(started(win), [`${cli} status --json`])
  assert.ok(onWindows.found && onWindows.file === cli && onWindows.source === 'ORCA_CLI_COMMAND')

  // A bare name in ORCA_CLI_COMMAND is looked up in PATH.
  const mac = fakeMachine({
    platform: 'darwin',
    env: { PATH: '/opt/orca-nightly/bin', ORCA_CLI_COMMAND: 'orca-nightly' },
    executables: ['/opt/orca-nightly/bin/orca-nightly'],
    answer: answers(['/opt/orca-nightly/bin/orca-nightly']),
  })
  const onMac = await findOrcaCli(mac)
  assert.deepEqual(started(mac), ['/opt/orca-nightly/bin/orca-nightly status --json'])
  assert.ok(onMac.found && onMac.source === 'ORCA_CLI_COMMAND')
})

// The environment of Orca itself on each system, with what the worker would like to see: Orca passes the worker only a
// few of these variables (orcaWorkerEnv).
const ORCA_ENV = {
  linux: { PATH: '/bin', HOME: '/home/avery', XDG_CACHE_HOME: '/var/cache/avery', ORCA_CLI_COMMAND: '/nowhere/orca' },
  darwin: { PATH: '/bin', HOME: '/Users/avery', ORCA_CLI_COMMAND: '/nowhere/orca' },
  win32: {
    Path: 'C:\\Windows\\System32',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    USERPROFILE: 'C:\\Users\\Avery',
    SystemRoot: 'C:\\Windows',
    SystemDrive: 'C:',
    LOCALAPPDATA: 'D:\\Profiles\\Avery\\Local',
    ProgramFiles: 'E:\\Program Files',
    ORCA_CLI_COMMAND: 'C:\\nowhere\\orca.exe',
  },
}

// Process starts other than the one PowerShell that names Local AppData on Windows.
function cliStarts(machine: FakeMachine): string[] {
  return started(machine).filter((line) => !line.includes('powershell.exe'))
}

test('К14.5 (поиск): CLI не найден ни в PATH, ни по известному пути → результат «CLI Orca не найден» с причиной', async () => {
  const machines = [
    fakeMachine({ platform: 'linux', env: orcaWorkerEnv(ORCA_ENV.linux, 'linux'), executables: ['/usr/bin/orca'] }),
    fakeMachine({ platform: 'darwin', env: orcaWorkerEnv(ORCA_ENV.darwin, 'darwin') }),
    fakeMachine({ platform: 'win32', env: orcaWorkerEnv(ORCA_ENV.win32, 'win32') }),
  ]
  for (const machine of machines) {
    const search = await findOrcaCli(machine)
    assert.equal(search.found, false, machine.platform)
    if (search.found) continue
    assert.equal(search.code, ORCA_CLI_NOT_FOUND)
    assert.deepEqual(cliStarts(machine), [], `${machine.platform}: no CLI may start`)
    const name = machine.platform === 'linux' ? 'orca-ide' : 'orca'
    assert.ok(search.reason.startsWith(`${name}: not in PATH`), search.reason)
    const known = await knownOrcaCliPaths(machine)
    for (const path of known) assert.ok(search.reason.includes(`${path}: no such file`), search.reason)
    assert.deepEqual(search.tried.map((entry) => entry.source), ['PATH', ...known.map(() => 'known path')])
  }
})

test('К14.5 (поиск): не нашёлся в PATH — известный путь CLI в установке Orca этой системы (окружение воркера Orca)', async () => {
  const cases = [
    // The CLI of the Orca that runs the worker, wherever it is installed.
    { platform: 'linux' as const, execPath: '/opt/tools/orca-1.4/orca-ide', cli: '/opt/tools/orca-1.4/resources/bin/orca-ide' },
    { platform: 'linux' as const, cli: '/home/avery/.local/bin/orca-ide' },
    // The AppImage launcher under ~/.cache: XDG_CACHE_HOME does not reach the worker.
    { platform: 'linux' as const, cli: '/home/avery/.cache/orca/appimage/launcher/orca-ide' },
    // The link of the deb and rpm packages, and the CLI inside them.
    { platform: 'linux' as const, cli: '/usr/bin/orca-ide' },
    { platform: 'linux' as const, cli: '/opt/Orca/resources/bin/orca-ide' },
    { platform: 'linux' as const, cli: '/opt/orca-ide/resources/bin/orca-ide' },
    { platform: 'linux' as const, cli: '/opt/orca/resources/bin/orca-ide' },
    {
      platform: 'darwin' as const,
      execPath: '/Volumes/Work/Orca Beta.app/Contents/MacOS/Orca',
      cli: '/Volumes/Work/Orca Beta.app/Contents/Resources/bin/orca',
    },
    { platform: 'darwin' as const, cli: '/usr/local/bin/orca' },
    { platform: 'darwin' as const, cli: '/Applications/Orca.app/Contents/Resources/bin/orca' },
    { platform: 'darwin' as const, cli: '/Users/avery/Applications/Orca.app/Contents/Resources/bin/orca' },
    // An installation in a directory of its own (NSIS /D): only the running Orca knows it.
    { platform: 'win32' as const, execPath: 'D:\\Apps\\Orca\\Orca.exe', cli: 'D:\\Apps\\Orca\\resources\\bin\\orca.exe' },
    // Local AppData as Windows names it (the worker has no LOCALAPPDATA).
    { platform: 'win32' as const, cli: 'D:\\Profiles\\Avery\\Local\\Programs\\Orca\\resources\\bin\\orca.exe' },
    // Program Files on the system drive (the worker has no ProgramFiles).
    { platform: 'win32' as const, cli: 'C:\\Program Files\\Orca\\resources\\bin\\orca.exe' },
  ]
  for (const { platform: system, execPath, cli } of cases) {
    const machine = fakeMachine({
      platform: system,
      env: orcaWorkerEnv(ORCA_ENV[system], system),
      execPath,
      executables: [cli],
      answer: (request) =>
        request.file.endsWith('powershell.exe') ? { code: 0, stdout: 'D:\\Profiles\\Avery\\Local' } : answers([cli])(request),
    })
    const search = await findOrcaCli(machine)
    assert.deepEqual(cliStarts(machine), [`${cli} status --json`], cli)
    assert.ok(search.found && search.file === cli && search.source === 'known path', cli)
  }
})

test('К14.5 (поиск): найденный CLI проверяется ответом orca status — не ответивший пропускается', async () => {
  const broken = '/opt/old-orca/bin/orca-ide'
  const refusing = '/home/avery/.local/bin/orca-ide'
  const good = '/opt/Orca/resources/bin/orca-ide'
  const machine = fakeMachine({
    platform: 'linux',
    env: { PATH: '/opt/old-orca/bin' },
    executables: [broken, refusing, good],
    answer: (request) => {
      if (request.file === broken) return { code: 1, stderr: 'Orca CLI is not ready; reopen Orca or register the CLI again.\n' }
      if (request.file === refusing) return { code: 0, stdout: JSON.stringify({ id: 'local', ok: false, error: { code: 'unavailable', message: 'Orca is not running' } }) }
      return orcaStatusAnswer('1.4.274')
    },
  })
  const search = await findOrcaCli(machine)
  assert.deepEqual(started(machine), [broken, refusing, good].map((file) => `${file} status --json`))
  assert.ok(search.found && search.file === good && search.source === 'known path')
  assert.deepEqual(
    search.tried.filter((entry) => entry.file !== null).map(({ file, problem }) => ({ file, problem })),
    [
      { file: broken, problem: 'orca status answered no JSON (exit 1): Orca CLI is not ready; reopen Orca or register the CLI again.' },
      { file: refusing, problem: 'orca status: not ok: Orca is not running (exit 0)' },
    ],
  )
  // The known paths before the good one that are missing.
  assert.ok(search.tried.filter((entry) => entry.file === null).every((entry) => entry.problem === 'no such file'))
})

const windows = realPlatform(platform) === 'win32'
const STATUS = '{"id":"local-status","ok":true,"result":{"runtime":{"appVersion":"9.9.9-test"}}}'

// A fake Orca CLI `name` in `dir` for this system: it notes `<name> <args>` in `log` and answers `status --json`.
function writeFakeCli(dir: string, name: string, log: string): string {
  assert.ok(!/['"%]/.test(log), `the test's temporary path needs quoting: ${log}`)
  if (windows) {
    // A batch file gets each argument in quotes from cmd.exe; %~1 drops them.
    const file = join(dir, `${name}.cmd`)
    writeFileSync(file, `@echo off\r\necho ${name} %~1 %~2>>"${log}"\r\necho ${STATUS}\r\n`)
    return file
  }
  const file = join(dir, name)
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> '${log}'\nprintf '%s\\n' '${STATUS}'\n`)
  chmodSync(file, 0o755)
  return file
}

// A fake CLI that never answers: it starts a child that holds its output pipes, and both wait.
function writeHangingCli(dir: string): string {
  assert.ok(!/['"%]/.test(execPath), `node's path needs quoting: ${execPath}`)
  const wait = "setInterval(() => {}, 1000)"
  if (windows) {
    const file = join(dir, 'hanging-orca.cmd')
    writeFileSync(file, `@"${execPath}" -e "${wait}"\r\n`)
    return file
  }
  const file = join(dir, 'hanging-orca')
  writeFileSync(file, `#!/bin/sh\n'${execPath}' -e '${wait}' &\n'${execPath}' -e '${wait}'\n`)
  chmodSync(file, 0o755)
  return file
}

// This computer, where only the files under `dir` can run: a real Orca installation is never even looked at.
function onlyUnder(dir: string, variables: Record<string, string | undefined>) {
  const real = realMachine()
  return realMachine({
    env: { ...env, PATH: dir, Path: undefined, ORCA_CLI_COMMAND: undefined, ...variables },
    homedir: dir,
    isRunnableFile: (path) => path.startsWith(dir) && real.isRunnableFile(path),
  })
}

test('К14.5 (поиск): на этой системе — настоящий запуск поддельных CLI из PATH, вызывается только CLI её имени', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-queue-orca-cli-'))
  try {
    const log = join(dir, 'calls.log')
    for (const name of ['orca', 'orca-ide']) writeFakeCli(dir, name, log)
    const search = await findOrcaCli(onlyUnder(dir, {}), { timeoutMs: 60_000 })
    const name = realPlatform(platform) === 'linux' ? 'orca-ide' : 'orca'
    assert.ok(search.found, JSON.stringify(search))
    assert.equal(basename(search.file, '.cmd'), name)
    assert.equal(search.version, '9.9.9-test')
    assert.deepEqual(readFileSync(log, 'utf8').trim().split(/\r?\n/).map((line) => line.trim()), [`${name} ${statusArgs.join(' ')}`])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('К14.5 (поиск): CLI, который не отвечает и держит вывод через потомка, останавливается по тайм-ауту, и поиск идёт дальше', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-queue-orca-cli-'))
  try {
    const log = join(dir, 'calls.log')
    for (const name of ['orca', 'orca-ide']) writeFakeCli(dir, name, log)
    const hanging = writeHangingCli(dir)
    const began = Date.now()
    const search = await findOrcaCli(onlyUnder(dir, { ORCA_CLI_COMMAND: hanging }), { timeoutMs: 1500 })
    assert.ok(Date.now() - began < 15_000, `the search took ${Date.now() - began} ms`)
    assert.ok(search.found && search.source === 'PATH', JSON.stringify(search))
    assert.equal(search.tried[0]?.file, hanging)
    assert.match(search.tried[0]?.problem ?? '', /stopped after 1500 ms/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
