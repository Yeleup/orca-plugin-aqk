// Starting real processes with parts of the system replaced (ProcessIo): a disk that writes little at a time or fails, a
// Windows run on any system with a taskkill that fails or a console code page, and the decoding of Windows output.
import { assert, test } from 'orca/testing'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execPath, pid as ownPid } from 'node:process'
import { pidIn, pidInFile, stillRuns } from '../testing/processes'
import { realMachine } from './machine'
import { askCodePage, decodeOutput, REAL_IO, startProcess, type ProcessIo } from './process'
import { runProgram } from './run'

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-queue-process-'))
  try {
    await body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// This computer, its processes started with `io`.
function machineWith(io: ProcessIo) {
  return realMachine({ start: (request) => startProcess(request, io) })
}

const PRINT = "process.stdout.write('A'.repeat(1000) + '\\n'); process.stderr.write('B'.repeat(500) + '\\n')"

test('файл вывода: запись по частям доходит до конца; отказ диска после открытия файла — результат с причиной, воркер не падает', async () => {
  await withTempDir(async (dir) => {
    // The system writes at most 7 bytes at a time: every byte still reaches the file.
    const short = join(dir, 'short.log')
    const piecemeal: ProcessIo = {
      ...REAL_IO,
      write: (fd, bytes, offset) => writeSync(fd, bytes, offset, Math.min(7, bytes.length - offset)),
    }
    const whole = await runProgram(machineWith(piecemeal), execPath, ['-e', PRINT], { outputFile: short })
    assert.equal(whole.error, null, JSON.stringify(whole.error))
    const text = readFileSync(short, 'utf8')
    assert.equal(text.length, 1001 + 501)
    assert.ok(text.includes('A'.repeat(1000)) && text.includes('B'.repeat(500)))

    // The disk fills up after 100 bytes: the run says so, its output in memory is whole, nothing is thrown.
    const full = join(dir, 'full.log')
    let written = 0
    const filling: ProcessIo = {
      ...REAL_IO,
      write: (fd, bytes, offset) => {
        if (written >= 100) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
        const count = writeSync(fd, bytes, offset, Math.min(100 - written, bytes.length - offset))
        written += count
        return count
      },
    }
    const cut = await runProgram(machineWith(filling), execPath, ['-e', PRINT], { outputFile: full })
    assert.equal(cut.code, 0)
    assert.equal(cut.error?.kind, 'output_failed')
    assert.match(cut.error?.reason ?? '', /ENOSPC: no space left on device.*lacks the rest of the output/)
    assert.equal(cut.stdout, `${'A'.repeat(1000)}\n`)
    assert.equal(readFileSync(full, 'utf8').length, 100)

    // Closing the file fails: the same.
    const closing: ProcessIo = {
      ...REAL_IO,
      close: (fd) => {
        REAL_IO.close(fd)
        throw Object.assign(new Error('EIO: i/o error, close'), { code: 'EIO' })
      },
    }
    const unclosed = await runProgram(machineWith(closing), execPath, ['-e', PRINT], { outputFile: join(dir, 'close.log') })
    assert.equal(unclosed.error?.kind, 'output_failed')
    assert.match(unclosed.error?.reason ?? '', /EIO: i\/o error, close/)
  })
})

test('тайм-аут на Windows: taskkill запустился, но вышел с ошибкой — остановлен хотя бы запущенный процесс, причина в результате', async () => {
  // A taskkill that starts and fails, as taskkill does without the right to stop a process.
  const failing = "process.stderr.write('ERROR: Access is denied.\\n'); process.exit(1)"
  const io: ProcessIo = { ...REAL_IO, windows: true, taskkill: () => ({ file: execPath, args: ['-e', failing] }) }
  const began = Date.now()
  const script = "process.stdout.write(process.pid + '\\n'); setInterval(() => {}, 1000)"
  const result = await runProgram(machineWith(io), execPath, ['-e', script], { timeoutMs: 1000 })
  assert.ok(Date.now() - began < 15_000, `the result took ${Date.now() - began} ms`)
  assert.equal(result.error?.kind, 'timed_out')
  assert.match(result.error?.reason ?? '', /stopped after 1000 ms without an answer; taskkill exited 1: ERROR: Access is denied\./)
  assert.match(result.error?.reason ?? '', /only the started process was stopped/)
  const pid = pidIn(result.stdout, 'the started process')
  assert.equal(await stillRuns(pid), false, `the started process ${pid} still runs`)
})

test('вывод на Windows: кодовая страница консоли спрашивается только для вывода не в UTF-8, со своим пределом времени', async () => {
  let asked = 0
  const io: ProcessIo = {
    ...REAL_IO,
    windows: true,
    codePage: async () => {
      asked++
      return 866
    },
  }
  const machine = machineWith(io)
  const utf8 = await runProgram(machine, execPath, ['-e', "process.stdout.write('Ошибка: файл не найден\\n')"])
  assert.equal(utf8.stdout, 'Ошибка: файл не найден\n')
  const empty = await runProgram(machine, execPath, ['-e', ''])
  assert.equal(empty.stdout, '')
  assert.equal(asked, 0, 'the code page was asked for UTF-8 or empty output')
  // «Ошибка» in code page 866.
  const oem = await runProgram(machine, execPath, ['-e', 'process.stdout.write(Buffer.from([0x8e, 0xe8, 0xa8, 0xa1, 0xaa, 0xa0]))'])
  assert.equal(oem.stdout, 'Ошибка')
  assert.equal(asked, 1)

  // The question itself: the number after localized words; no answer within the limit — none, and the query stops.
  const say = (text: string) => askCodePage(execPath, ['-e', `process.stdout.write(${JSON.stringify(text)})`], 10_000)
  assert.equal(await say('Active code page: 850\r\n'), 850)
  assert.equal(await say('Текущая кодовая страница: 866\r\n'), 866)
  assert.equal(await say('no number'), null)
  const began = Date.now()
  assert.equal(await askCodePage(execPath, ['-e', 'setInterval(() => {}, 1000)'], 300), null)
  assert.ok(Date.now() - began < 5_000, `a hanging chcp held the result for ${Date.now() - began} ms`)
})

test('вывод на Windows: все OEM-страницы консоли — 437, 850, 858 и другие по таблицам, 866 и азиатские через TextDecoder', () => {
  // 0x9B: ¢ in 437, ø in 850; 0xD5: ı in 850, € in 858; 0x80: Ç in both.
  assert.equal(decodeOutput(new Uint8Array([0x80, 0x9b, 0x41]), 437), 'Ç¢A')
  assert.equal(decodeOutput(new Uint8Array([0x80, 0x9b, 0xd5]), 850), 'Çøı')
  assert.equal(decodeOutput(new Uint8Array([0xd5]), 858), '€')
  assert.equal(decodeOutput(new Uint8Array([0x8e, 0xe8, 0xa8, 0xa1, 0xaa, 0xa0]), 866), 'Ошибка')
  // A code page nobody knows: UTF-8 with replacement characters (the output file keeps the bytes).
  assert.equal(decodeOutput(new Uint8Array([0x41, 0x9b]), 12345), 'A�')
})

test('тайм-аут на Windows: taskkill завис — по своему пределу он сам остановлен, запущенный процесс остановлен, причина в результате', async () => {
  await withTempDir(async (dir) => {
    // A taskkill that starts and never answers; it notes its pid first.
    const helperPid = join(dir, 'taskkill.pid')
    const hang = `require('fs').writeFileSync(${JSON.stringify(helperPid)}, String(process.pid)); setInterval(() => {}, 1000)`
    const io: ProcessIo = {
      ...REAL_IO,
      windows: true,
      taskkill: () => ({ file: execPath, args: ['-e', hang] }),
      taskkillTimeoutMs: 700,
    }
    const began = Date.now()
    const script = "process.stdout.write(process.pid + '\\n'); setInterval(() => {}, 1000)"
    const result = await runProgram(machineWith(io), execPath, ['-e', script], { timeoutMs: 500 })
    assert.ok(Date.now() - began < 10_000, `the result took ${Date.now() - began} ms`)
    assert.equal(result.error?.kind, 'timed_out')
    assert.match(result.error?.reason ?? '', /taskkill gave no answer in 700 ms; only the started process was stopped/)
    // Both pids are checked before any signal: a missing one fails the test instead of reaching a process group.
    const started = pidIn(result.stdout, 'the started process')
    const helper = pidInFile(helperPid, 'the fake taskkill')
    assert.equal(await stillRuns(started), false, 'the started process still runs')
    assert.equal(await stillRuns(helper), false, 'taskkill still runs after the result')
  })
})

test('файл вывода не открылся (нет его каталога) — программа не запускается: start_failed с путём файла, кода нет', async () => {
  await withTempDir(async (dir) => {
    const marker = join(dir, 'ran.txt')
    const output = join(dir, 'missing', 'run.log')
    const result = await runProgram(realMachine(), execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], {
      outputFile: output,
    })
    assert.equal(result.error?.kind, 'start_failed', JSON.stringify(result))
    assert.ok(result.error?.reason.includes(`the output file ${output} cannot be opened (ENOENT`), result.error?.reason)
    assert.match(result.error?.reason ?? '', /the program was not started/)
    assert.equal(result.code, null)
    assert.equal(existsSync(marker), false, 'the program ran')
  })
})

test('pid из вывода или файла поддельной программы: пустой, 0, отрицательный, не число или свой — ошибка теста до любого сигнала', async () => {
  for (const text of ['', '  \n', '0', '-1', '12a', String(ownPid)]) {
    assert.throws(() => pidIn(text, 'a fake program'), /a fake program: no pid of its own .*; no signal was sent/)
  }
  await assert.rejects(stillRuns(0), /no pid of its own/)
  await withTempDir(async (dir) => {
    assert.throws(() => pidInFile(join(dir, 'missing.pid'), 'the fake taskkill'), /the fake taskkill: no pid file/)
  })
  assert.equal(pidIn(' 4242\n', 'a fake program'), 4242)
})
