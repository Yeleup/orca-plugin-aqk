// Checking from a test that a process a fake program reported (its pid in the output or in a file) has stopped. A
// signal goes only to a pid that is a positive integer and not the test's own: kill(0, …) — or a negative number —
// would reach the test's whole process group on macOS and Linux, the test itself included. A missing or malformed
// pid fails the test with a clear message instead, before any signal.
import { readFileSync } from 'node:fs'
import { kill, pid as ownPid } from 'node:process'

// The pid in `text` (the whole text, blanks around it allowed); throws when there is none.
export function pidIn(text: string, what: string): number {
  const trimmed = text.trim()
  const pid = /^[1-9][0-9]*$/.test(trimmed) ? Number(trimmed) : NaN
  if (!Number.isSafeInteger(pid) || pid === ownPid) {
    throw new Error(`${what}: no pid of its own (got ${JSON.stringify(trimmed)}); no signal was sent`)
  }
  return pid
}

// The pid written to `file`; throws when the file is missing or holds none.
export function pidInFile(file: string, what: string): number {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`${what}: no pid file ${file} (${error instanceof Error ? error.message : String(error)})`)
  }
  return pidIn(text, what)
}

// Whether process `pid` (from pidIn) still runs after up to 3 s of waiting. A process left running is stopped, so a
// failing test does not keep the test run waiting.
export async function stillRuns(pid: number): Promise<boolean> {
  pidIn(String(pid), `pid ${pid}`)
  for (let i = 0; i < 30; i++) {
    try {
      kill(pid, 0)
    } catch {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  kill(pid, 'SIGKILL')
  return true
}
