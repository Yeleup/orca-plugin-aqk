// The search for Orca's CLI (Ф14, К14.5 — the search part): on fake systems with files and process starts in memory,
// which commands the plugin starts and what the result holds; then once with real processes on this computer, with
// fake CLIs in a temporary PATH. The real Orca CLI is never started.
import { assert, test } from 'orca/testing'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { env, platform } from 'node:process'
import { fakeMachine, orcaStatusAnswer, type FakeAnswer, type FakeMachine } from '../testing/fake-machine'
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

test('К14.5 (поиск): CLI не найден ни в PATH, ни по известному пути → результат «CLI Orca не найден» с причиной', async () => {
  const machines = [
    fakeMachine({ platform: 'linux', env: { PATH: '/usr/bin' }, executables: ['/usr/bin/orca'] }),
    fakeMachine({ platform: 'darwin', env: { PATH: '/usr/bin' } }),
    fakeMachine({ platform: 'win32', env: { Path: 'C:\\Windows\\System32', LOCALAPPDATA: 'C:\\Users\\Avery\\AppData\\Local', ProgramFiles: 'C:\\Program Files' } }),
  ]
  for (const machine of machines) {
    const search = await findOrcaCli(machine)
    assert.equal(search.found, false, machine.platform)
    if (search.found) continue
    assert.equal(search.code, ORCA_CLI_NOT_FOUND)
    assert.deepEqual(started(machine), [], `${machine.platform}: nothing may start`)
    const name = machine.platform === 'linux' ? 'orca-ide' : 'orca'
    assert.ok(search.reason.startsWith(`${name}: not in PATH`), search.reason)
    for (const path of knownOrcaCliPaths(machine)) assert.ok(search.reason.includes(`${path}: no such file`), search.reason)
    assert.deepEqual(search.tried.map((entry) => entry.source), ['PATH', ...knownOrcaCliPaths(machine).map(() => 'known path')])
  }
})

test('К14.5 (поиск): не нашёлся в PATH — известный путь CLI в установке Orca этой системы', async () => {
  const cases = [
    { platform: 'linux' as const, env: {}, cli: '/home/avery/.local/bin/orca-ide' },
    // The stable launcher of Orca's AppImage, under $XDG_CACHE_HOME.
    { platform: 'linux' as const, env: { XDG_CACHE_HOME: '/var/cache/avery' }, cli: '/var/cache/avery/orca/appimage/launcher/orca-ide' },
    { platform: 'linux' as const, env: {}, cli: '/opt/Orca/resources/bin/orca-ide' },
    { platform: 'darwin' as const, env: {}, cli: '/Applications/Orca.app/Contents/Resources/bin/orca' },
    { platform: 'darwin' as const, env: {}, cli: '/Users/avery/Applications/Orca.app/Contents/Resources/bin/orca' },
    { platform: 'win32' as const, env: { LOCALAPPDATA: 'C:\\Users\\Avery\\AppData\\Local' }, cli: 'C:\\Users\\Avery\\AppData\\Local\\Programs\\Orca\\resources\\bin\\orca.exe' },
    { platform: 'win32' as const, env: { ProgramFiles: 'C:\\Program Files' }, cli: 'C:\\Program Files\\Orca\\resources\\bin\\orca.exe' },
  ]
  for (const { platform: system, env: variables, cli } of cases) {
    const machine = fakeMachine({
      platform: system,
      env: { PATH: system === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin', ...variables },
      executables: [cli],
      answer: answers([cli]),
    })
    const search = await findOrcaCli(machine)
    assert.deepEqual(started(machine), [`${cli} status --json`], cli)
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
    search.tried.map(({ file, problem }) => ({ file, problem })),
    [
      { file: broken, problem: 'orca status answered no JSON (exit 1): Orca CLI is not ready; reopen Orca or register the CLI again.' },
      { file: refusing, problem: 'orca status: not ok: Orca is not running (exit 0)' },
      // The AppImage launcher, the next known path, is missing.
      { file: null, problem: 'no such file' },
    ],
  )
})

test('К14.5 (поиск): на этой системе — настоящий запуск поддельных CLI из PATH, вызывается только CLI её имени', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-queue-orca-cli-'))
  try {
    const windows = realPlatform(platform) === 'win32'
    const log = join(dir, 'calls.log')
    assert.ok(!/['"%]/.test(log), `the test's temporary path needs quoting: ${log}`)
    const status = '{"id":"local-status","ok":true,"result":{"runtime":{"appVersion":"9.9.9-test"}}}'
    for (const name of ['orca', 'orca-ide']) {
      if (windows) {
        // A batch file gets each argument in quotes from cmd.exe; %~1 drops them.
        writeFileSync(join(dir, `${name}.cmd`), `@echo off\r\necho ${name} %~1 %~2>>"${log}"\r\necho ${status}\r\n`)
      } else {
        const file = join(dir, name)
        writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> '${log}'\nprintf '%s\\n' '${status}'\n`)
        chmodSync(file, 0o755)
      }
    }
    const real = realMachine()
    const machine = realMachine({
      env: { ...env, PATH: dir, Path: undefined, ORCA_CLI_COMMAND: undefined },
      homedir: dir,
      // Only the fake CLIs: a known path of a real Orca installation is never even looked at.
      isRunnableFile: (path) => path.startsWith(dir) && real.isRunnableFile(path),
    })
    const search = await findOrcaCli(machine, { timeoutMs: 60_000 })
    const name = real.platform === 'linux' ? 'orca-ide' : 'orca'
    assert.ok(search.found, JSON.stringify(search))
    assert.equal(basename(search.file, '.cmd'), name)
    assert.equal(search.version, '9.9.9-test')
    assert.deepEqual(readFileSync(log, 'utf8').trim().split(/\r?\n/).map((line) => line.trim()), [`${name} ${statusArgs.join(' ')}`])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
