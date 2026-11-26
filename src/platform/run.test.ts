// Running commands (Ф14): the project's test command through the shell of each system (К14.2), and a run's result — exit
// code, output, start time and duration — with real processes on this computer and a fake clock.
import { assert, test } from 'orca/testing'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env, execPath, kill, platform } from 'node:process'
import { fakeClock, fakeMachine } from '../testing/fake-machine'
import { realMachine, realPlatform, type Machine } from './machine'
import { decodeOutput } from './process'
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

test('запуск команды: программа из PATH по правилам системы — на win32 с PATHEXT; .cmd через cmd.exe, аргументы экранированы один раз, у cmd-shim npm — дважды', async () => {
  const shim = 'C:\\work\\demo-shop\\node_modules\\.bin\\eslint.cmd'
  const win = fakeMachine({
    platform: 'win32',
    env: { Path: 'C:\\Tools;"C:\\Program Files\\Demo Tools"', PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    executables: ['C:\\Program Files\\Demo Tools\\demo-tool.cmd', 'C:\\Tools\\git.exe', shim],
  })
  await runProgram(win, 'git', ['status', '--short'])
  await runProgram(win, 'demo-tool', ['say', 'a & b', '50%', 'say "hi"', 'dir\\'])
  await runProgram(win, shim, ['--fix', 'a b'])
  assert.deepEqual(
    win.starts.map(({ file, args, windowsVerbatimArguments }) => ({ file, args, windowsVerbatimArguments })),
    [
      { file: 'C:\\Tools\\git.exe', args: ['status', '--short'], windowsVerbatimArguments: undefined },
      {
        file: 'C:\\Windows\\System32\\cmd.exe',
        args: [
          '/d',
          '/s',
          '/c',
          '"C:\\Program^ Files\\Demo^ Tools\\demo-tool.cmd ^"say^" ^"a^ ^&^ b^" ^"50^%^" ^"say^ \\^"hi\\^"^" ^"dir\\\\^""',
        ],
        windowsVerbatimArguments: true,
      },
      {
        file: 'C:\\Windows\\System32\\cmd.exe',
        args: ['/d', '/s', '/c', `"${shim} ^^^"--fix^^^" ^^^"a^^^ b^^^""`],
        windowsVerbatimArguments: true,
      },
    ],
  )

  const linux = fakeMachine({ platform: 'linux', env: { PATH: '/usr/local/bin:/usr/bin' }, executables: ['/usr/bin/git'] })
  const result = await runProgram(linux, 'git', ['log', '-1'])
  assert.deepEqual(linux.starts.map(({ file, args }) => ({ file, args })), [{ file: '/usr/bin/git', args: ['log', '-1'] }])
  assert.equal(result.code, 0)
})

// node:test's context, which orca/testing's `test` passes but does not declare.
type TestContext = { skip(message?: string): void }
const testWithContext = test as unknown as (name: string, fn: (t: TestContext) => unknown) => Promise<void>

testWithContext('запуск команды на Windows: обычный .cmd получает аргументы через %1 и %~1, обёртка с %* передаёт их программе без изменений', async (t) => {
  if (!windows) {
    t.skip('только Windows: cmd.exe и .cmd')
    return
  }
  await withTempDir(async (dir) => {
    const args = ['plain', 'a & b', '50%', '(paren)', 'semi;colon', 'two  spaces', 'x|y<z>']
    // A batch file that keeps each %~1 in a variable (set "v=…" and !v! keep & | < > as text) and writes it out.
    const plainLog = join(dir, 'plain.log')
    const sets = args.map((_, i) => `set "a${i + 1}=%~${i + 1}"`).join('\r\n')
    const echoes = args.map((_, i) => `>>"${plainLog}" echo(!a${i + 1}!`).join('\r\n')
    writeFileSync(join(dir, 'plain.cmd'), `@echo off\r\nsetlocal EnableDelayedExpansion\r\n${sets}\r\n${echoes}\r\n`)
    // A wrapper that hands %* to a program, as the CLI launchers do; the program writes the arguments it got.
    const wrapperLog = join(dir, 'wrapper.json')
    writeFileSync(join(dir, 'print-args.js'), `require('fs').writeFileSync(${JSON.stringify(wrapperLog)}, JSON.stringify(process.argv.slice(2)))\n`)
    writeFileSync(join(dir, 'wrapper.cmd'), `@"${execPath}" "%~dp0print-args.js" %*\r\n`)

    const machine = realMachine({ cwd: dir })
    const plain = await runProgram(machine, join(dir, 'plain.cmd'), args)
    assert.equal(plain.code, 0, JSON.stringify(plain))
    assert.deepEqual(readFileSync(plainLog, 'utf8').split(/\r?\n/).filter((line) => line !== ''), args)

    const forwarded = [...args, 'say "hi"', 'dir\\', 'caret^x']
    const wrapper = await runProgram(machine, join(dir, 'wrapper.cmd'), forwarded)
    assert.equal(wrapper.code, 0, JSON.stringify(wrapper))
    assert.deepEqual(JSON.parse(readFileSync(wrapperLog, 'utf8')), forwarded)
  })
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

test('команда не найдена на Windows: cmd.exe вышел с 9009 или с 1, а первого слова нет ни среди команд cmd.exe, ни в каталоге, ни в PATH → ошибка с причиной; настоящий выход с 1 — без ошибки', async () => {
  const exits: Record<string, number> = {
    'agent-queue-missing-tool --flag': 1,
    'other-missing-tool': 9009,
    'npm run test:windows': 1,
    'exit /b 1': 1,
    'build --all': 1,
  }
  const win = fakeMachine({
    platform: 'win32',
    env: { Path: 'C:\\Tools', PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    executables: ['C:\\Tools\\npm.cmd', 'C:\\work\\demo-shop\\build.bat'],
    answer: (request) => {
      const line = (request.args[3] ?? '').replace(/^"|"$/g, '')
      return { code: exits[line] ?? 0, stderr: `'${line.split(' ')[0]}' is not recognized as a command.\r\n` }
    },
  })
  const run = (line: string) => runShell(win, line, { cwd: 'C:\\work\\demo-shop' })
  const missing = await run('agent-queue-missing-tool --flag')
  assert.equal(missing.code, 1)
  assert.equal(missing.error?.kind, 'not_found', JSON.stringify(missing))
  assert.match(missing.error?.reason ?? '', /agent-queue-missing-tool \(exit 1\)/)
  const other = await run('other-missing-tool')
  assert.equal(other.code, 9009)
  assert.equal(other.error?.kind, 'not_found')
  // A program in PATH, a command of cmd.exe and a batch file of the run's directory that exit with 1: their own result.
  for (const line of ['npm run test:windows', 'exit /b 1', 'build --all']) {
    const result = await run(line)
    assert.equal(result.code, 1, line)
    assert.equal(result.error, null, line)
  }

  const linux = fakeMachine({ platform: 'linux', answer: (request) => ({ code: request.args[1] === 'missing-tool' ? 127 : 1 }) })
  assert.equal((await runShell(linux, 'missing-tool')).error?.kind, 'not_found')
  assert.equal((await runShell(linux, 'false')).error, null)

  // A real exit with 1 on this computer is no error.
  const real = await runShell(realMachine(), windows ? 'exit /b 1' : 'exit 1')
  assert.equal(real.code, 1)
  assert.equal(real.error, null)
})

test('запуск команды: относительная команда и относительный элемент PATH ищутся от cwd запуска, а не от каталога воркера', async () => {
  const fake = fakeMachine({
    platform: 'linux',
    cwd: '/srv/worker',
    env: { PATH: 'tools:/usr/bin' },
    executables: ['/srv/worker/tools/check', '/work/demo-shop/tools/check'],
  })
  await runProgram(fake, './tools/check', [], { cwd: '/work/demo-shop' })
  await runProgram(fake, 'check', [], { cwd: '/work/demo-shop' })
  await runProgram(fake, 'check', [])
  assert.deepEqual(
    fake.starts.map(({ file, cwd }) => ({ file, cwd })),
    [
      { file: '/work/demo-shop/tools/check', cwd: '/work/demo-shop' },
      { file: '/work/demo-shop/tools/check', cwd: '/work/demo-shop' },
      { file: '/srv/worker/tools/check', cwd: '/srv/worker' },
    ],
  )

  // The same with real programs: two directories hold a `tools/check` that prints the directory's name.
  await withTempDir(async (dir) => {
    for (const name of ['worker', 'worktree']) {
      mkdirSync(join(dir, name, 'tools'), { recursive: true })
      if (windows) writeFileSync(join(dir, name, 'tools', 'check.cmd'), `@echo ${name}\r\n`)
      else {
        writeFileSync(join(dir, name, 'tools', 'check'), `#!/bin/sh\necho ${name}\n`)
        chmodSync(join(dir, name, 'tools', 'check'), 0o755)
      }
    }
    const machine = realMachine({ cwd: join(dir, 'worker') })
    const worktree = join(dir, 'worktree')
    const byPath = await runProgram(machine, 'check', [], { cwd: worktree, env: { PATH: 'tools' } })
    const byDirectory = await runProgram(machine, './tools/check', [], { cwd: worktree })
    for (const result of [byPath, byDirectory]) {
      assert.equal(result.error, null, JSON.stringify(result))
      assert.equal(result.stdout.trim(), 'worktree')
    }
  })
})

test('запуск команды на Windows: рабочий каталог UNC — cmd.exe не запускается, ошибка с причиной; программа .exe запускается', async () => {
  const unc = '\\\\fileserver\\work\\demo-shop'
  const win = fakeMachine({
    platform: 'win32',
    env: { Path: 'C:\\Tools', PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    executables: ['C:\\Tools\\git.exe', 'C:\\Tools\\npm.cmd'],
  })
  const tests = await runProjectTests(win, { testCommand: 'npm test' }, { cwd: unc })
  const batch = await runProgram(win, 'npm', ['test'], { cwd: unc })
  for (const result of [tests, batch]) {
    assert.equal(result.error?.kind, 'start_failed')
    assert.ok(result.error?.reason.includes(`UNC directory (${unc})`), result.error?.reason)
    assert.equal(result.file, null)
  }
  assert.deepEqual(win.starts, [])
  await runProgram(win, 'git', ['status'], { cwd: unc })
  assert.deepEqual(win.starts.map(({ file, cwd }) => ({ file, cwd })), [{ file: 'C:\\Tools\\git.exe', cwd: unc }])
})

test('вывод больше предела в памяти: файл вывода получает весь вывод обоих потоков, в результате — начало и конец', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'run.log')
    const script = [
      "process.stdout.write('BEGIN-MARK\\n')",
      "const line = 'x'.repeat(1023) + '\\n'",
      'for (let i = 0; i < 1024; i++) process.stdout.write(line)',
      "process.stdout.write('END-MARK\\n')",
      "process.stderr.write('ERR-MARK\\n')",
    ].join(';')
    const result = await runProgram(realMachine(), execPath, ['-e', script], { outputFile: file, maxOutput: 64 * 1024 })
    assert.equal(result.code, 0, result.stderr)
    const all = readFileSync(file, 'utf8')
    assert.equal(all.length, 11 + 1024 * 1024 + 9 + 9)
    assert.ok(all.startsWith('BEGIN-MARK\n'))
    assert.ok(all.includes('END-MARK\n') && all.includes('ERR-MARK\n'))
    assert.equal(result.truncated, true)
    assert.ok(result.stdout.startsWith('BEGIN-MARK\n'), result.stdout.slice(0, 40))
    assert.ok(result.stdout.endsWith('END-MARK\n'), result.stdout.slice(-40))
    assert.match(result.stdout, /\[\d+ bytes of output left out here\]/)
    assert.ok(result.stdout.length < 70 * 1024)
    assert.equal(result.stderr, 'ERR-MARK\n')
  })
})

test('вывод: UTF-8 читается как UTF-8; иное на Windows — в кодовой странице консоли; файл вывода хранит байты как есть', async () => {
  // «Ошибка» in code page 866, the console's code page of a Russian Windows.
  const cp866 = new Uint8Array([0x8e, 0xe8, 0xa8, 0xa1, 0xaa, 0xa0])
  assert.equal(decodeOutput(cp866, 866), 'Ошибка')
  assert.equal(decodeOutput(cp866, 1251), 'ЋиЁЎЄ\u00a0')
  assert.notEqual(decodeOutput(cp866, null), 'Ошибка')
  assert.equal(decodeOutput(new TextEncoder().encode('Ошибка: файл не найден'), 866), 'Ошибка: файл не найден')

  await withTempDir(async (dir) => {
    const machine = realMachine()
    const utf8 = await runProgram(machine, execPath, ['-e', "process.stdout.write('Ошибка: файл не найден\\n')"])
    assert.equal(utf8.stdout, 'Ошибка: файл не найден\n')
    const file = join(dir, 'bytes.log')
    await runProgram(machine, execPath, ['-e', `process.stdout.write(Buffer.from([${[...cp866].join(',')}]))`], { outputFile: file })
    assert.deepEqual([...readFileSync(file)], [...cp866])
  })
})

test('тайм-аут: останавливается всё дерево процессов, и результат приходит, даже если потомок держит вывод', async () => {
  await withTempDir(async (dir) => {
    const pidFile = join(dir, 'grandchild.pid')
    // The started program starts a child that inherits its output pipes, then both wait forever.
    const script = [
      "const child = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' })",
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))`,
      "process.stdout.write('started\\n')",
      'setInterval(() => {}, 1000)',
    ].join(';')
    const began = Date.now()
    const result = await runProgram(realMachine(), execPath, ['-e', script], { timeoutMs: 1500 })
    assert.equal(result.error?.kind, 'timed_out', JSON.stringify(result))
    assert.ok(Date.now() - began < 10_000, `the result took ${Date.now() - began} ms`)
    assert.equal(result.stdout, 'started\n')
    const grandchild = Number(readFileSync(pidFile, 'utf8'))
    let alive = true
    for (let i = 0; i < 30 && alive; i++) {
      try {
        kill(grandchild, 0)
        await new Promise((resolve) => setTimeout(resolve, 100))
      } catch {
        alive = false
      }
    }
    assert.equal(alive, false, `the child ${grandchild} of the stopped program still runs`)
  })
})
