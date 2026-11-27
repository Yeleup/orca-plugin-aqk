// Holding a computer of the tests at one of its calls, to put the steps of several coordinators in the order a test
// needs («A reads, B reads, B writes, A writes»): the first start of a process on a fake machine that matches waits
// until the test lets it go — nothing of it has reached GitHub yet. The wait of a coordinator's protocol (its sleep)
// can be held the same way.
import type { StartRequest } from '../platform/machine'
import { readCall, type FakeGhCall } from './fake-github'
import type { FakeClock, FakeMachine } from './fake-machine'

export type Hold = {
  // Resolves when the held call (or wait) has come and waits.
  readonly reached: Promise<void>
  // Lets it go on.
  release(): void
}

function gate(): { hold: Hold; arrive: () => Promise<void> } {
  let arrived: () => void = () => {}
  let go: () => void = () => {}
  const reached = new Promise<void>((resolve) => {
    arrived = resolve
  })
  const released = new Promise<void>((resolve) => {
    go = resolve
  })
  return {
    hold: { reached, release: () => go() },
    arrive: () => {
      arrived()
      return released
    },
  }
}

// Holds the first gh call of `machine` that `match` names, before it reaches GitHub.
export function holdCall(machine: FakeMachine, match: (call: FakeGhCall) => boolean): Hold {
  const { hold, arrive } = gate()
  const start = machine.start.bind(machine)
  let armed = true
  machine.start = async (request: StartRequest) => {
    if (armed && match(readCall(request))) {
      armed = false
      await arrive()
    }
    return start(request)
  }
  return hold
}

// The coordinator's wait (CoordinatorOptions.sleep) on a fake clock: the clock moves by the wait at once. `holds` —
// waits held until the test lets them go, in order: the n-th wait is held by the n-th hold given (`null`: not held).
export function fakeSleep(clock: FakeClock): { sleep: (ms: number) => Promise<void>; hold: () => Hold } {
  const pending: { hold: Hold; arrive: () => Promise<void> }[] = []
  return {
    sleep: async (ms) => {
      const next = pending.shift()
      if (next) await next.arrive()
      clock.advance(ms)
    },
    hold: () => {
      const one = gate()
      pending.push(one)
      return one.hold
    },
  }
}

// Calls of a computer's gh that write: comments, labels, issues, PRs (not reads).
export function isWrite(call: FakeGhCall): boolean {
  return call.method !== 'GET' && call.path !== 'graphql'
}

// The gh call that writes a comment on issue #issue.
export function isCommentOn(issue: number): (call: FakeGhCall) => boolean {
  return (call) => call.method === 'POST' && call.path.endsWith(`/issues/${issue}/comments`)
}

// The gh call that adds labels to issue #issue.
export function isLabelOn(issue: number): (call: FakeGhCall) => boolean {
  return (call) => call.method === 'POST' && call.path.endsWith(`/issues/${issue}/labels`)
}
