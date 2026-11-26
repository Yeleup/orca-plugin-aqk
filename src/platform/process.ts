// Starting a process on the real machine: its exit, its output and a timeout.
// - Input: the request's `input` is written to the standard input as UTF-8, which is then closed; without it the
//   standard input is empty. A process that exits without reading it all is no failure of the start.
// - Output: the bytes of both streams go, in the order they arrive, to `outputFile` when the request names one (the
//   full output of a test run, TZ «Данные»). A write that fails (a full disk …) stops the file and the run reports it
//   (`outputError`); it never escapes as an exception. In memory each stream keeps at most `maxOutput` bytes: its
//   beginning and its end, with a line in between saying how much was left out.
// - Text: empty output and valid UTF-8 are read as UTF-8 at once. On Windows other output is read in the console's code
//   page (cmd.exe and many console programs write in it): `chcp` is asked once, within CODE_PAGE_TIMEOUT_MS; every
//   OEM code page of Windows is known (TextDecoder and code-pages.ts). Without an answer: UTF-8 with replacement
//   characters; `outputFile` keeps the bytes as they came.
// - Timeout: the whole process tree stops — its process group on macOS and Linux; on Windows `taskkill /T /F`, and if
//   taskkill fails, at least the started process (`stopError` says the tree was not stopped). The result comes at most
//   STOP_GRACE_MS after the stop even if a process left behind still holds the output pipes.
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, openSync, writeSync } from 'node:fs'
import { env, kill, platform } from 'node:process'
import { OEM_CODE_PAGES } from './code-pages'
import { errorCode, errorMessage } from './errors'
import type { Env, StartOutcome, StartRequest } from './machine'

export const MAX_OUTPUT = 16 * 1024 * 1024

// How long a timed-out run may take to give back its pipes after its tree was stopped.
export const STOP_GRACE_MS = 2_000

// How long taskkill and chcp may take.
export const TASKKILL_TIMEOUT_MS = 5_000
export const CODE_PAGE_TIMEOUT_MS = 3_000

// What the start needs besides spawn; tests replace parts of it (a Windows run on any system, a failing disk, a failing
// taskkill, the console's code page).
export type ProcessIo = {
  readonly windows: boolean
  open(path: string): number
  // Writes from `offset` on; returns how many bytes it wrote (maybe fewer than asked).
  write(fd: number, bytes: Uint8Array, offset: number): number
  close(fd: number): void
  codePage(): Promise<number | null>
  // The taskkill command that stops the tree of process `pid`, in the run's environment.
  taskkill(env: Env, pid: number): { readonly file: string; readonly args: readonly string[] }
  // How long taskkill may take before it is stopped itself.
  readonly taskkillTimeoutMs: number
}

export const REAL_IO: ProcessIo = {
  windows: platform === 'win32',
  open: (path) => openSync(path, 'w'),
  write: (fd, bytes, offset) => writeSync(fd, bytes, offset),
  close: closeSync,
  codePage: () => consoleCodePage(),
  taskkill: (variables, pid) => {
    const root = Object.entries(variables).find(([name]) => name.toUpperCase() === 'SYSTEMROOT')?.[1]
    const file = root ? `${root}\\System32\\taskkill.exe` : 'taskkill.exe'
    return { file, args: ['/pid', String(pid), '/T', '/F'] }
  },
  taskkillTimeoutMs: TASKKILL_TIMEOUT_MS,
}

export function startProcess(request: StartRequest, io: ProcessIo = REAL_IO): Promise<StartOutcome> {
  return new Promise((resolve) => {
    const limit = request.maxOutput ?? MAX_OUTPUT
    const stdout = new KeptOutput(limit)
    const stderr = new KeptOutput(limit)
    let file: number | null = null
    let outputError: string | null = null
    let stopping: Promise<string | null> | null = null
    let timedOut = false
    let spawned = false
    let settled = false
    let exit: { code: number | null; signal: string | null } = { code: null, signal: null }
    const timers: ReturnType<typeof setTimeout>[] = []

    const closeFile = () => {
      if (file === null) return
      const fd = file
      file = null
      try {
        io.close(fd)
      } catch (error) {
        outputError ??= `${request.outputFile}: ${errorMessage(error)}`
      }
    }
    // Every byte of the chunk, also when the system writes fewer at a time; a failure stops the file for good.
    const record = (chunk: Uint8Array) => {
      if (file === null) return
      try {
        for (let offset = 0; offset < chunk.length; ) {
          const written = io.write(file, chunk, offset)
          if (!(written > 0)) throw new Error('the system wrote nothing')
          offset += written
        }
      } catch (error) {
        outputError = `${request.outputFile}: ${errorMessage(error)}; the file lacks the rest of the output`
        closeFile()
      }
    }
    const finish = (outcome: Pick<StartOutcome, 'code' | 'signal' | 'startError'>) => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      closeFile()
      void Promise.all([stdout.text(io), stderr.text(io), stopping ?? Promise.resolve(null)]).then(([out, err, stop]) =>
        resolve({
          ...outcome,
          stdout: out,
          stderr: err,
          truncated: stdout.truncated || stderr.truncated,
          timedOut,
          outputError,
          stopError: stop,
        }),
      )
    }

    if (request.outputFile !== undefined) {
      try {
        file = io.open(request.outputFile)
      } catch (error) {
        // Not a missing program: the code stays null, so the run reports start_failed with the file's path.
        const message =
          `the output file ${request.outputFile} cannot be opened (${errorMessage(error)}); the program was not started`
        finish({ code: null, signal: null, startError: { code: null, message } })
        return
      }
    }

    let child: ChildProcess
    try {
      child = spawn(request.file, request.args, {
        cwd: request.cwd,
        env: { ...request.env },
        stdio: [request.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        // macOS and Linux: a process group of its own, so a timeout stops the processes it started too.
        detached: !io.windows,
        windowsHide: true,
        windowsVerbatimArguments: request.windowsVerbatimArguments === true,
      })
    } catch (error) {
      finish({ code: null, signal: null, startError: { code: errorCode(error), message: errorMessage(error) } })
      return
    }
    // The input, then the end of it. A process that exits without reading it all closes the pipe (EPIPE): its exit
    // and output tell what happened, the write error itself is dropped.
    if (request.input !== undefined && child.stdin) {
      child.stdin.on('error', () => undefined)
      child.stdin.end(request.input)
    }
    const take = (kept: KeptOutput) => (chunk: Uint8Array) => {
      if (settled) return
      record(chunk)
      kept.push(chunk)
    }
    child.stdout?.on('data', take(stdout))
    child.stderr?.on('data', take(stderr))
    child.on('spawn', () => {
      spawned = true
      if (request.timeoutMs === undefined) return
      timers.push(
        setTimeout(() => {
          timedOut = true
          stopping = stopTree(child, request, io)
          timers.push(
            setTimeout(() => {
              child.stdout?.destroy()
              child.stderr?.destroy()
              finish({ ...exit, startError: null })
            }, STOP_GRACE_MS),
          )
        }, request.timeoutMs),
      )
    })
    child.on('error', (error) => {
      if (spawned) return
      finish({ code: null, signal: null, startError: { code: error.code ?? null, message: error.message } })
    })
    child.on('exit', (code, signal) => {
      exit = { code, signal }
    })
    child.on('close', (code, signal) => finish({ code, signal, startError: null }))
  })
}

// Stops the process and the processes it started; resolves with why the tree was not stopped, or null.
function stopTree(child: ChildProcess, request: StartRequest, io: ProcessIo): Promise<string | null> {
  const pid = child.pid
  if (pid === undefined) return Promise.resolve(null)
  if (!io.windows) {
    try {
      kill(-pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    let done = false
    let said = ''
    let killer: ChildProcess | null = null
    const end = (problem: string | null) => {
      if (done) return
      done = true
      clearTimeout(limit)
      if (problem === null) return resolve(null)
      child.kill('SIGKILL')
      resolve(`${problem}; only the started process was stopped, the processes it started may still run`)
    }
    // At the limit the helper itself is stopped and its stderr closed, so nothing of it outlives the result.
    const limit = setTimeout(() => {
      killer?.kill('SIGKILL')
      killer?.stderr?.destroy()
      end(`taskkill gave no answer in ${io.taskkillTimeoutMs} ms`)
    }, io.taskkillTimeoutMs)
    try {
      const command = io.taskkill(request.env, pid)
      killer = spawn(command.file, command.args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
      killer.stderr?.on('data', (chunk) => (said += new TextDecoder().decode(chunk)))
      killer.on('error', (error) => end(`taskkill did not start: ${error.message}`))
      killer.on('close', (code) => {
        const line = said.split(/\r?\n/).map((text) => text.trim()).find((text) => text !== '')
        end(code === 0 ? null : `taskkill exited ${code}${line ? `: ${line}` : ''}`)
      })
    } catch (error) {
      end(`taskkill did not start: ${errorMessage(error)}`)
    }
  })
}

// One stream's output in memory: all of it up to `limit` bytes; past that its first and last limit/2 bytes.
class KeptOutput {
  private chunks: Uint8Array[] = []
  private size = 0
  private head: Uint8Array | null = null
  private dropped = 0
  constructor(private readonly limit: number) {}

  get truncated(): boolean {
    return this.head !== null
  }

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk)
    this.size += chunk.length
    if (this.head === null && this.size <= this.limit) return
    const half = Math.floor(this.limit / 2)
    if (this.head === null) {
      const all = concat(this.chunks)
      this.head = all.slice(0, half)
      this.chunks = [all.slice(half)]
      this.size = all.length - half
    }
    // Keep the last `half` bytes after the head.
    while (this.size > half && this.size - (this.chunks[0]?.length ?? 0) >= half) {
      const first = this.chunks.shift() as Uint8Array
      this.size -= first.length
      this.dropped += first.length
    }
    if (this.size > half) {
      const cut = this.size - half
      this.chunks[0] = (this.chunks[0] as Uint8Array).subarray(cut)
      this.size = half
      this.dropped += cut
    }
  }

  async text(io: Pick<ProcessIo, 'windows' | 'codePage'>): Promise<string> {
    const tail = concat(this.chunks)
    const head = this.head
    const utf8 = head === null ? isUtf8(tail, 'whole') : isUtf8(head, 'head') && isUtf8(tail, 'tail')
    // The console's code page only for output that is not UTF-8, and only on Windows.
    const codePage = utf8 || !io.windows ? null : await io.codePage()
    if (head === null) return decodeOutput(tail, codePage)
    const left = `\n… [${this.dropped} bytes of output left out here]\n`
    return decodeOutput(head, codePage) + left + decodeOutput(tail, codePage)
  }
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array
  const all = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    all.set(chunk, at)
    at += chunk.length
  }
  return all
}

// TextDecoder's names of the Windows code pages it knows.
const CODE_PAGES: Record<number, string> = {
  866: 'ibm866',
  874: 'windows-874',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
  20866: 'koi8-r',
  21866: 'koi8-u',
  65001: 'utf-8',
}

// Output as text: UTF-8 when it is valid UTF-8; otherwise in `codePage` (the Windows console's) — by TextDecoder or by
// the tables of code-pages.ts; for an unknown code page or none, UTF-8 with replacement characters.
export function decodeOutput(bytes: Uint8Array, codePage: number | null): string {
  if (isUtf8(bytes, 'whole')) return new TextDecoder('utf-8').decode(bytes)
  const table = codePage === null ? undefined : OEM_CODE_PAGES[codePage]
  if (table !== undefined) {
    let text = ''
    for (const byte of bytes) text += byte < 0x80 ? String.fromCharCode(byte) : table[byte - 0x80]
    return text
  }
  const label = codePage === null ? undefined : CODE_PAGES[codePage]
  return new TextDecoder(label ?? 'utf-8').decode(bytes)
}

// Whether `bytes` is UTF-8; a `head` may end and a `tail` may begin inside a character.
function isUtf8(bytes: Uint8Array, part: 'whole' | 'head' | 'tail'): boolean {
  let start = 0
  let end = bytes.length
  if (part === 'tail') while (start < Math.min(3, end) && ((bytes[start] as number) & 0xc0) === 0x80) start++
  if (part === 'head') {
    let back = end - 1
    while (back >= Math.max(0, end - 3) && ((bytes[back] as number) & 0xc0) === 0x80) back--
    if (back >= 0 && (bytes[back] as number) >= 0xc0) end = back
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, end))
    return true
  } catch {
    return false
  }
}

let codePageOnce: Promise<number | null> | null = null

// The code page of a new console on this Windows, asked once per worker.
function consoleCodePage(): Promise<number | null> {
  codePageOnce ??= askCodePage(
    Object.entries(env).find(([name]) => name.toUpperCase() === 'COMSPEC')?.[1] ?? 'cmd.exe',
    ['/d', '/c', 'chcp'],
    CODE_PAGE_TIMEOUT_MS,
  )
  return codePageOnce
}

// Runs `chcp` (`shell` `args`), which prints the number after localized words, and reads the number; null when it does
// not answer within `timeoutMs` (it is stopped then), fails or prints none.
export function askCodePage(shell: string, args: readonly string[], timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    let chcp: ChildProcess | null = null
    const end = (page: number | null) => {
      if (done) return
      done = true
      clearTimeout(limit)
      resolve(page)
    }
    const limit = setTimeout(() => {
      chcp?.kill('SIGKILL')
      end(null)
    }, timeoutMs)
    try {
      chcp = spawn(shell, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      chcp.stdout?.on('data', (chunk) => (out += new TextDecoder('latin1').decode(chunk)))
      chcp.on('error', () => end(null))
      chcp.on('close', () => end(Number(/(\d+)\D*$/.exec(out.trim())?.[1]) || null))
    } catch {
      end(null)
    }
  })
}
