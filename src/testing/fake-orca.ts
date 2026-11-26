// A fake Orca for the tests of the agents layer: workspaces and their terminals, the focused workspace, the agents Orca
// launches and the states it lists for them, and Orca's CLI on a fake computer. It refuses what Orca 1.4.274 refuses
// (out/main/index.js of its app.asar):
// - the host's `terminal.sendText` into a terminal outside the focused worktree: «terminal is outside the active
//   worktree» — every agent the plugin launches runs in the background;
// - the host's `terminal.close` of a terminal the plugin neither opened nor has in the focused workspace: action_failed;
// - the CLI's `terminal send` to a handle no live terminal has: `terminal_handle_stale`, exit 1.
// `agent.launch` opens the agent's terminal and answers (`launchGate` holds the answer back); Orca sends the prompt on
// its own afterwards and only logs a failure, so whether the agent got it shows only in the states the test reports for
// it (`list`, or the worker's agent.status.changed). The CLI's `terminal send` answers like Orca's: the stage
// `turn_started` when the agent starts a turn on the text (`turnStarts`); a request id it has seen replays the first
// outcome without typing again. `cliGate` holds the CLI's answer back after the text is typed, `loseAnswers` makes it
// type the text and then die without an answer, `cliRefusals` makes Orca refuse the next sends without typing anything;
// `terminal.close` waits for `closeGate`, `agents.list` for `listGate`. While `cliPresent` is false (`cli: false`) the
// computer has no Orca CLI at all.
import { hostError, mockHost, type MockHost } from 'orca/testing'
import type { Platform } from '../platform/machine'
import { fakeClock, fakeMachine, FAKE_HOME, orcaStatusAnswer, type FakeAnswer, type FakeClock, type FakeMachine } from './fake-machine'

type AgentState = 'working' | 'blocked' | 'waiting' | 'done'

export type FakeTerminal = {
  readonly id: string
  readonly workspaceId: string
  readonly agent: string | null
  // Opened by the plugin (`agent.launch`), not by the owner.
  readonly byPlugin: boolean
  open: boolean
  // The prompt `agent.launch` was given.
  readonly prompt: string | null
  // What the CLI typed into it, in order.
  readonly typed: string[]
}

export type FakeOrca = {
  readonly host: MockHost
  readonly machine: FakeMachine
  readonly clock: FakeClock
  // The path of Orca's CLI on the fake computer.
  readonly cli: string
  readonly terminals: Map<string, FakeTerminal>
  // The workspace the owner looks at.
  focused: string | null
  // Whether the CLI sees an agent start a turn on what it types.
  turnStarts: boolean
  // While set, `agent.launch` answers only once the promise settles.
  launchGate: Promise<void> | null
  // While set, the CLI's `terminal send` answers only once the promise settles (the text is typed before).
  cliGate: Promise<void> | null
  // How many of the next CLI sends type the text and then end without an answer.
  loseAnswers: number
  // While set, `terminal.close` answers only once the promise settles.
  closeGate: Promise<void> | null
  // While set, `agents.list` answers only once the promise settles, with the states listed then.
  listGate: Promise<void> | null
  // Orca's refusals of the next CLI sends, in order: each types nothing and leaves the request unseen.
  readonly cliRefusals: { code: string; message: string; data?: Record<string, unknown> }[]
  // Whether the computer has Orca's CLI.
  cliPresent: boolean
  // The state `agents.list` reports for a terminal, and since when.
  list(terminalId: string, state: AgentState, stateStartedAt: number): void
  unlist(terminalId: string): void
  // A terminal the owner opened in a workspace.
  ownerTerminal(workspaceId: string): string
}

// Where each system keeps Orca's CLI the plugin finds first on the fake computer (a known path of src/platform/orca-cli.ts).
function cliPath(platform: Platform, home: string): string {
  if (platform === 'win32') return `${home}\\AppData\\Local\\Programs\\Orca\\resources\\bin\\orca.exe`
  if (platform === 'darwin') return '/usr/local/bin/orca'
  return `${home}/.local/bin/orca-ide`
}

export function fakeOrca(
  options: { readonly platform?: Platform; readonly results?: Record<string, unknown>; readonly cli?: boolean } = {},
): FakeOrca {
  const platform = options.platform ?? 'linux'
  const clock = fakeClock()
  const cli = cliPath(platform, FAKE_HOME[platform])
  const terminals = new Map<string, FakeTerminal>()
  const listed = new Map<string, { state: AgentState; stateStartedAt: number }>()
  let opened = 0
  // The outcome of each request id the CLI has seen.
  const requests = new Map<string, string>()

  const answer = (request: { file: string; args: readonly string[] }): FakeAnswer => {
    if (request.file !== cli) return { startError: { code: 'ENOENT', message: `spawn ${request.file} ENOENT` } }
    const [command, sub] = request.args
    if (command === 'status') return orcaStatusAnswer('1.4.274')
    if (command !== 'terminal' || sub !== 'send') return { code: 1, stdout: JSON.stringify({ ok: false, error: { code: 'invalid_argument', message: 'unknown command' } }) }
    const flag = (name: string) => {
      const at = request.args.indexOf(name)
      return at < 0 ? undefined : request.args[at + 1]
    }
    const handle = flag('--terminal') ?? ''
    const text = flag('--text') ?? ''
    const requestId = flag('--retry-request')
    const refusal = fake.cliRefusals.shift()
    if (refusal !== undefined) return { code: 1, stdout: JSON.stringify({ id: 'cli-0', ok: false, error: refusal }) }
    const replay = requestId === undefined ? undefined : requests.get(requestId)
    if (replay !== undefined) {
      if (fake.loseAnswers > 0) {
        fake.loseAnswers--
        return { timedOut: true, signal: 'SIGKILL' }
      }
      return { code: 0, stdout: replay }
    }
    const terminal = terminals.get(handle)
    if (terminal === undefined || !terminal.open) {
      return {
        code: 1,
        stdout: JSON.stringify({ id: 'cli-1', ok: false, error: { code: 'terminal_handle_stale', message: `terminal_handle_stale ${handle}` } }),
      }
    }
    terminal.typed.push(text)
    const stages = fake.turnStarts && request.args.includes('--wait-submit') ? ['input_accepted', 'turn_started'] : ['input_accepted']
    const stdout = JSON.stringify({
        id: 'cli-2',
        ok: true,
        result: {
          send: {
            handle,
            accepted: true,
            bytesWritten: text.length + 1,
            prompt: { requestId: requestId ?? `request-${terminal.typed.length}`, stages, provider: terminal.agent ?? 'unsupported', observation: 'supported' },
          },
          mutation: { requestId: requestId ?? `request-${terminal.typed.length}`, replayed: false },
        },
      })
    if (requestId !== undefined) requests.set(requestId, stdout.replace('"replayed":false', '"replayed":true'))
    if (fake.loseAnswers > 0) {
      fake.loseAnswers--
      return { timedOut: true, signal: 'SIGKILL' }
    }
    return { code: 0, stdout }
  }

  const base = fakeMachine({ platform, clock, executables: [cli], answer })
  const machine: FakeMachine = {
    ...base,
    isRunnableFile: (path) => (path === cli ? fake.cliPresent : base.isRunnableFile(path)),
    start: async (request) => {
      const gate = fake.cliGate
      if (gate === null || request.args[0] !== 'terminal') return base.start(request)
      // The text is typed at once; the answer waits.
      const outcome = await base.start(request)
      await gate
      return outcome
    },
  }

  const host = mockHost({
    results: {
      'agent.launch': async (params: { workspaceId: string; agent: string; prompt?: string }) => {
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
          typed: [],
        })
        return { terminalId: id }
      },
      'terminal.sendText': (params: { terminalId: string }) => {
        const terminal = terminals.get(params.terminalId)
        if (fake.focused === null) throw hostError('action_failed', 'no active worktree is available for terminal input')
        if (terminal === undefined || terminal.workspaceId !== fake.focused || !terminal.open) {
          throw hostError('action_failed', 'terminal is outside the active worktree')
        }
        return { accepted: true }
      },
      'terminal.close': async (params: { terminalId: string }) => {
        const gate = fake.closeGate
        if (gate !== null) await gate
        const terminal = terminals.get(params.terminalId)
        const focused = terminal !== undefined && terminal.workspaceId === fake.focused
        if (terminal === undefined || (!terminal.byPlugin && !focused)) {
          throw hostError('action_failed', 'terminal.close closes only terminals of the focused workspace or ones this plugin opened')
        }
        terminal.open = false
        return { closed: true }
      },
      'terminal.list': (params: { workspaceId: string }) => ({
        terminals: [...terminals.values()].filter((t) => t.open && t.workspaceId === params.workspaceId).map((t) => ({ id: t.id })),
        truncated: false,
      }),
      'agents.list': async (params: { workspaceId: string }) => {
        const gate = fake.listGate
        if (gate !== null) await gate
        return {
          agents: [...terminals.values()]
            .filter((t) => t.workspaceId === params.workspaceId && listed.has(t.id))
            .map((t) => ({ terminalId: t.id, title: null, agent: t.agent, state: listed.get(t.id)?.state, stateStartedAt: listed.get(t.id)?.stateStartedAt })),
        }
      },
      ...options.results,
    },
  })

  const fake: FakeOrca = {
    host,
    machine,
    clock,
    cli,
    terminals,
    focused: null,
    turnStarts: true,
    launchGate: null,
    cliGate: null,
    loseAnswers: 0,
    closeGate: null,
    listGate: null,
    cliRefusals: [],
    cliPresent: options.cli !== false,
    list: (terminalId, state, stateStartedAt) => {
      listed.set(terminalId, { state, stateStartedAt })
    },
    unlist: (terminalId) => {
      listed.delete(terminalId)
    },
    ownerTerminal: (workspaceId) => {
      const id = `terminal-of-the-owner-${terminals.size + 1}`
      terminals.set(id, { id, workspaceId, agent: null, byPlugin: false, open: true, prompt: null, typed: [] })
      return id
    },
  }
  return fake
}
