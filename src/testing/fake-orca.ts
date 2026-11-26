// A fake Orca for the tests of the agents layer, over Orca's mock host (`mockHost` refuses a call without its manifest
// capability, or with params Orca would refuse — an agent it does not know among them — exactly as Orca does): the
// workspaces' terminals, the ones the plugin opened with `agent.launch` and the ones the owner opened, the focused
// workspace, and a fake computer with a clock that moves only when the test moves it. It refuses what Orca 1.4.274
// refuses (out/main/index.js of its app.asar): `terminal.close` of a terminal the plugin neither opened nor has in the
// focused workspace — action_failed, as for a terminal that is no longer there. `agent.launch` shows the test its
// params the moment it is called (`onLaunch`, before any wait), opens the agent's terminal and answers (`launchGate`
// holds the answer back); `terminal.close` waits for `closeGate`; `terminal.list` names the open terminals of a
// workspace, and says the list is cut short while `listTruncated` is set.
import { hostError, mockHost, type MockHost } from 'orca/testing'
import type { Platform } from '../platform/machine'
import { fakeMachine, type FakeClock, type FakeMachine } from './fake-machine'

export type FakeTerminal = {
  readonly id: string
  readonly workspaceId: string
  readonly agent: string | null
  // Opened by the plugin (`agent.launch`), not by the owner.
  readonly byPlugin: boolean
  open: boolean
  // The prompt `agent.launch` was given.
  readonly prompt: string | null
}

export type FakeOrca = {
  readonly host: MockHost
  readonly machine: FakeMachine
  readonly clock: FakeClock
  // Every terminal Orca has opened, in order, closed ones included.
  readonly terminals: Map<string, FakeTerminal>
  // The workspace the owner looks at.
  focused: string | null
  // Called with the params of each `agent.launch` as Orca gets the call, before it waits or opens anything.
  onLaunch: ((params: { workspaceId: string; agent: string; prompt?: string }) => void) | null
  // While set, `agent.launch` answers only once the promise settles.
  launchGate: Promise<void> | null
  // While set, `terminal.close` answers only once the promise settles.
  closeGate: Promise<void> | null
  // While set, `terminal.list` answers that its list is cut short (Orca lists at most 50 terminals).
  listTruncated: boolean
  // A terminal the owner opened in a workspace.
  ownerTerminal(workspaceId: string): string
}

export function fakeOrca(options: { readonly platform?: Platform; readonly results?: Record<string, unknown> } = {}): FakeOrca {
  const machine = fakeMachine({ platform: options.platform ?? 'linux' })
  const terminals = new Map<string, FakeTerminal>()
  let opened = 0

  const host = mockHost({
    results: {
      'agent.launch': async (params: { workspaceId: string; agent: string; prompt?: string }) => {
        fake.onLaunch?.(params)
        const gate = fake.launchGate
        if (gate !== null) await gate
        const id = `terminal-${++opened}`
        terminals.set(id, {
          id,
          workspaceId: params.workspaceId,
          agent: params.agent,
          byPlugin: true,
          open: true,
          prompt: params.prompt ?? null,
        })
        return { terminalId: id }
      },
      'terminal.close': async (params: { terminalId: string }) => {
        const gate = fake.closeGate
        if (gate !== null) await gate
        const terminal = terminals.get(params.terminalId)
        const focused = terminal !== undefined && terminal.workspaceId === fake.focused
        if (terminal === undefined || !terminal.open || (!terminal.byPlugin && !focused)) {
          throw hostError('action_failed', 'terminal.close closes only terminals of the focused workspace or ones this plugin opened')
        }
        terminal.open = false
        return { closed: true }
      },
      'terminal.list': (params: { workspaceId: string }) => ({
        terminals: [...terminals.values()].filter((t) => t.open && t.workspaceId === params.workspaceId).map((t) => ({ id: t.id })),
        truncated: fake.listTruncated,
      }),
      ...options.results,
    },
  })

  const fake: FakeOrca = {
    host,
    machine,
    clock: machine.clock,
    terminals,
    focused: null,
    onLaunch: null,
    launchGate: null,
    closeGate: null,
    listTruncated: false,
    ownerTerminal: (workspaceId) => {
      const id = `terminal-of-the-owner-${terminals.size + 1}`
      terminals.set(id, { id, workspaceId, agent: null, byPlugin: false, open: true, prompt: null })
      return id
    },
  }
  return fake
}
