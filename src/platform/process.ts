// Starting a process on the real machine: its exit, its output and a timeout.
// - Output: the bytes of both streams go, in the order they arrive, to `outputFile` when the request names one (the full
//   output of a test run, TZ «Данные»). In memory each stream keeps at most `maxOutput` bytes: its beginning and its
//   end, with a line in between saying how much was left out.
// - Text: output that is valid UTF-8 is read as UTF-8. On Windows other output is read in the console's code page
//   (cmd.exe and many console programs write in it), when that code page is one TextDecoder knows.
// - Timeout: the whole process tree stops (its process group on macOS and Linux, taskkill /T on Windows), and the
//   result comes at most STOP_GRACE_MS later even if a process left behind still holds the output pipes.
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, openSync, writeSync } from 'node:fs'
import { env, kill, platform } from 'node:process'
import { errorCode, errorMessage } from './errors'
import type { StartOutcome, StartRequest } from './machine'

export const MAX_OUTPUT = 16 * 1024 * 1024

// How long a timed-out run may take to give back its pipes after its tree was stopped.
export const STOP_GRACE_MS = 2_000

export function startProcess(request: StartRequest): Promise<StartOutcome> {
  const windows = platform === 'win32'
  return new Promise((resolve) => {
    const limit = request.maxOutput ?? MAX_OUTPUT
    const stdout = new KeptOutput(limit)
    const stderr = new KeptOutput(limit)
    let file: number | null = null
    let timedOut = false
    let spawned = false
    let settled = false
    let exit: { code: number | null; signal: string | null } = { code: null, signal: null }
    const timers: ReturnType<typeof setTimeout>[] = []

    const finish = (outcome: Pick<StartOutcome, 'code' | 'signal' | 'startError'>) => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      if (file !== null) closeSync(file)
      void Promise.all([stdout.text(windows), stderr.text(windows)]).then(([out, err]) =>
        resolve({ ...outcome, stdout: out, stderr: err, truncated: stdout.truncated || stderr.truncated, timedOut }),
      )
    }

    if (request.outputFile !== undefined) {
      try {
        file = openSync(request.outputFile, 'w')
      } catch (error) {
        finish({ code: null, signal: null, startError: { code: errorCode(error), message: errorMessage(error) } })
        return
      }
    }

    let child: ChildProcess
    try {
      child = spawn(request.file, request.args, {
        cwd: request.cwd,
        env: { ...request.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        // macOS and Linux: a process group of its own, so a timeout stops the processes it started too.
        detached: !windows,
        windowsHide: true,
        windowsVerbatimArguments: request.windowsVerbatimArguments === true,
      })
    } catch (error) {
      finish({ code: null, signal: null, startError: { code: errorCode(error), message: errorMessage(error) } })
      return
    }
    const take = (kept: KeptOutput) => (chunk: Uint8Array) => {
      if (settled) return
      if (file !== null) writeSync(file, chunk)
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
          stopTree(child, request, windows)
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

function stopTree(child: ChildProcess, request: StartRequest, windows: boolean): void {
  const pid = child.pid
  if (pid === undefined) return
  if (!windows) {
    try {
      kill(-pid, 'SIGKILL')
      return
    } catch {
      child.kill('SIGKILL')
      return
    }
  }
  const root = Object.entries(request.env).find(([name]) => name.toUpperCase() === 'SYSTEMROOT')?.[1]
  const taskkill = root ? `${root}\\System32\\taskkill.exe` : 'taskkill.exe'
  try {
    const killer = spawn(taskkill, ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    killer.on('error', () => child.kill('SIGKILL'))
    killer.unref()
  } catch {
    child.kill('SIGKILL')
  }
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

  async text(windows: boolean): Promise<string> {
    const tail = concat(this.chunks)
    if (this.head === null) return decodeOutput(tail, windows ? await oemCodePage() : null)
    const head = this.head
    const codePage = windows && !(isUtf8(head, 'head') && isUtf8(tail, 'tail')) ? await oemCodePage() : null
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

// Output as text: UTF-8 when it is valid UTF-8; otherwise in `codePage` (the Windows console's) when TextDecoder knows
// it; otherwise UTF-8 with replacement characters.
export function decodeOutput(bytes: Uint8Array, codePage: number | null): string {
  if (isUtf8(bytes, 'whole')) return new TextDecoder('utf-8').decode(bytes)
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

let oemCodePageOnce: Promise<number | null> | null = null

// The code page of a new console on this Windows (`chcp` prints it: digits after localized words), asked once.
function oemCodePage(): Promise<number | null> {
  oemCodePageOnce ??= new Promise((resolve) => {
    let out = ''
    try {
      const shell = Object.entries(env).find(([name]) => name.toUpperCase() === 'COMSPEC')?.[1] ?? 'cmd.exe'
      const chcp = spawn(shell, ['/d', '/c', 'chcp'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      chcp.stdout?.on('data', (chunk) => (out += new TextDecoder('latin1').decode(chunk)))
      chcp.on('error', () => resolve(null))
      chcp.on('close', () => resolve(Number(/(\d+)\D*$/.exec(out.trim())?.[1]) || null))
    } catch {
      resolve(null)
    }
  })
  return oemCodePageOnce
}
