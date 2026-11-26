// Running commands (Ф14): the project's test command through the shell of each system (К14.2), and a run's result — exit
// code, output, start time and duration — with real processes on this computer and a fake clock.
import { assert, test } from 'orca/testing'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env, platform } from 'node:process'
import { fakeClock, fakeMachine } from '../testing/fake-machine'
import { realMachine, realPlatform, type Machine } from './machine'
import { projectTestCommand, runProgram, runProjectTests, runShell } from './run'

const windows = realPlatform(platform) === 'win32'

function withTempDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-queue-run-'))
  return body(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

// This computer, with a clock that gives `start`, then `start + durationMs`.
function realWithClock(start: number, durationMs: number, overrides: Partial<Machine> = {}): Machine {
  const times = [start, start + durationMs]
  return realMachine({ now: () => times.shift() ?? start + durationMs, ...overrides })
}

test('К14.2: в настройках есть команда для Windows — на подделке win32 запускается она оболочкой cmd.exe, на linux — основная через /bin/sh', async () => {
  const settings = { testCommand: 'make test', testCommandWindows: 'npm run test:windows' }

  const win = fakeMachine({ platform: 'win32', env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' } })
  await runProjectTests(win, settings, { cwd: 'C:\\work\\demo-shop' })
  assert.deepEqual(
    win.starts.map(({ file, args, cwd, windowsVerbatimArguments }) => ({ file, args, cwd, windowsVerbatimArguments })),
    [
      {
        file: 'C:\\Windows\\System32\\cmd.exe',
        args: ['/d', '/s', '/c', '"npm run test:windows"'],
        cwd: 'C:\\work\\demo-shop',
        windowsVerbatimArguments: true,
      },
    ],
  )

  const linux = fakeMachine({ platform: 'linux' })
  await runProjectTests(linux, settings, { cwd: '/work/demo-shop' })
  assert.deepEqual(
    linux.starts.map(({ file, args, cwd }) => ({ file, args, cwd })),
    [{ file: '/bin/sh', args: ['-c', 'make test'], cwd: '/work/demo-shop' }],
  )

  // Without a command for Windows (or a blank one) Windows runs the main command too.
  for (const testCommandWindows of [undefined, null, '  ']) {
    assert.equal(projectTestCommand(win, { testCommand: 'make test', testCommandWindows }), 'make test')
  }
  assert.equal(projectTestCommand(fakeMachine({ platform: 'darwin' }), settings), 'make test')
})

test('К14.2: на этой системе запускается её команда: echo основной команды или команды для Windows доходит до вывода', async () => {
  await withTempDir(async (dir) => {
    const result = await runProjectTests(
      realMachine(),
      { testCommand: 'echo main-command', testCommandWindows: 'echo windows-command' },
      { cwd: dir },
    )
    assert.equal(result.error, null, JSON.stringify(result))
    assert.equal(result.code, 0)
    assert.equal(result.stdout.trim(), windows ? 'windows-command' : 'main-command')
  })
})

test('команда проекта выходит с кодом 3 → результат с кодом 3, выводом, временем начала и длительностью', async () => {
  await withTempDir(async (dir) => {
    const start = Date.UTC(2026, 0, 15, 9, 30, 0)
    const testCommand = windows
      ? 'echo out-line& echo err-line 1>&2& exit /b 3'
      : 'echo out-line; echo err-line >&2; exit 3'
    const result = await runProjectTests(realWithClock(start, 2750), { testCommand, testCommandWindows: testCommand }, { cwd: dir })
    assert.equal(result.code, 3, JSON.stringify(result))
    assert.equal(result.error, null)
    assert.equal(result.stdout.trim(), 'out-line')
    assert.equal(result.stderr.trim(), 'err-line')
    assert.equal(result.startedAt, '2026-01-15T09:30:00.000Z')
    assert.equal(result.durationMs, 2750)
    assert.equal(result.command, testCommand)
  })
})

test('команда не найдена → ошибка с причиной, а не код 0', async () => {
  await withTempDir(async (dir) => {
    // PATH holds only an empty directory: neither the program nor the command of the shell line is there.
    const machine = realWithClock(Date.UTC(2026, 0, 15, 9, 30, 0), 40, {
      env: { ...env, PATH: dir, Path: undefined },
      cwd: dir,
    })
    const program = await runProgram(machine, 'agent-queue-missing-tool', ['--version'])
    assert.equal(program.error?.kind, 'not_found', JSON.stringify(program))
    assert.match(program.error?.reason ?? '', /agent-queue-missing-tool is not in PATH/)
    assert.equal(program.code, null)
    assert.equal(program.file, null)

    const shell = await runShell(realMachine({ env: { ...env, PATH: dir, Path: undefined }, cwd: dir }), 'agent-queue-missing-tool --version', { cwd: dir })
    assert.equal(shell.error?.kind, 'not_found', JSON.stringify(shell))
    assert.match(shell.error?.reason ?? '', /agent-queue-missing-tool/)
    assert.notEqual(shell.code, 0)

    const path = await runProgram(machine, join(dir, 'no-such-dir', 'tool'), [])
    assert.equal(path.error?.kind, 'not_found')
    assert.notEqual(path.code, 0)
  })
})

test('запуск команды: программа из PATH по правилам системы — на win32 с PATHEXT, .cmd через cmd.exe с экранированием', async () => {
  const win = fakeMachine({
    platform: 'win32',
    env: { Path: 'C:\\Tools;"C:\\Program Files\\Demo Tools"', PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    executables: ['C:\\Program Files\\Demo Tools\\demo-tool.cmd', 'C:\\Tools\\git.exe'],
  })
  await runProgram(win, 'git', ['status', '--short'])
  await runProgram(win, 'demo-tool', ['say', 'a & b', '50%'])
  assert.deepEqual(
    win.starts.map(({ file, args, windowsVerbatimArguments }) => ({ file, args, windowsVerbatimArguments })),
    [
      { file: 'C:\\Tools\\git.exe', args: ['status', '--short'], windowsVerbatimArguments: undefined },
      {
        file: 'C:\\Windows\\System32\\cmd.exe',
        args: ['/d', '/s', '/c', '"C:\\Program^ Files\\Demo^ Tools\\demo-tool.cmd ^^^"say^^^" ^^^"a^^^ ^^^&^^^ b^^^" ^^^"50^^^%^^^""'],
        windowsVerbatimArguments: true,
      },
    ],
  )

  const linux = fakeMachine({ platform: 'linux', env: { PATH: '/usr/local/bin:/usr/bin' }, executables: ['/usr/bin/git'] })
  const result = await runProgram(linux, 'git', ['log', '-1'])
  assert.deepEqual(linux.starts.map(({ file, args }) => ({ file, args })), [{ file: '/usr/bin/git', args: ['log', '-1'] }])
  assert.equal(result.code, 0)
})

test('запуск команды: время начала и длительность — по часам машины, остановка по тайм-ауту — ошибка с причиной', async () => {
  const clock = fakeClock(Date.UTC(2026, 0, 15, 9, 30, 0))
  const machine = fakeMachine({
    platform: 'linux',
    env: { PATH: '/usr/bin' },
    executables: ['/usr/bin/gh'],
    clock,
    answer: () => ({ code: null, signal: 'SIGKILL', timedOut: true, durationMs: 5000 }),
  })
  const result = await runProgram(machine, 'gh', ['issue', 'list'], { timeoutMs: 5000 })
  assert.equal(result.startedAt, '2026-01-15T09:30:00.000Z')
  assert.equal(result.durationMs, 5000)
  assert.equal(result.error?.kind, 'timed_out')
  assert.match(result.error?.reason ?? '', /5000 ms/)
  assert.equal(machine.starts[0]?.timeoutMs, 5000)
})
