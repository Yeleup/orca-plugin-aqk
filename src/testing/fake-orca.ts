// A fake Orca for the tests of the agents layer, over Orca's mock host (`mockHost` refuses a call without its manifest
// capability, or with params Orca would refuse — an agent it does not know among them — exactly as Orca does): the
// workspaces' terminals, the ones the plugin opened with `agent.launch` and the ones the owner opened, the focused
// workspace, the agents Orca lists, Orca's CLI on a fake computer, and a clock that moves only when the test moves it.
// It refuses what Orca 1.4.274 refuses (out/main/index.js of its app.asar): `terminal.close` of a terminal the plugin
// neither opened nor has in the focused workspace — action_failed, as for a terminal that is no longer there;
// `terminal.sendText` into a terminal outside the focused workspace — «terminal is outside the active worktree» (every
// agent the plugin launches runs in a background worktree unless the test focuses it). `agent.launch` shows the test its
// params the moment it is called (`onLaunch`, before any wait), opens the agent's terminal and answers (`launchGate`
// holds the answer back); `terminal.close` waits for `closeGate`; `terminal.list` names the open terminals of a
// workspace, and says the list is cut short while `listTruncated` is set. `agents.list` names the agents of a workspace
// in the states the test listed (`list`, `unlist`), as they are when Orca gets the call: `listGate` holds that answer
// back — it reaches the worker late, with the states of the moment of the call — and `listError` makes Orca refuse it.
// `finishTurn` is an agent ending its turn with its report: the report file written, the agent listed «done» from that
// moment. Orca's events (`agent.status.changed`) the test sends to its worker itself (`emit`).
//
// Orca's CLI (`cli`, at a known path of Ф14 on each system, answering `status --json` as Orca 1.4.274 does) answers
// `terminal send` like Orca's: the line goes into the open terminal of the handle (`typed`), the receipt names the stage
// `turn_started` while `turnStarts` is set, and a request id it has seen repeats the first receipt without typing again.
// A handle no open terminal has: `terminal_handle_stale`, nothing typed. The test steers the next sends: `cliRefusals` —
// Orca refuses without typing and the request stays unseen; `cliAnswers` — the answer as given, nothing typed, the
// request unseen; `loseAnswers` — the CLI does what Orca does (types, or repeats the outcome) and then ends without an
// answer, stopped at its timeout; `cliGate` — the line is typed at once and the answer held back; `cliHoldNext` — the
// next send waits before Orca handles it; `sendDurationMs` — the time a send takes after the line is typed;
// `statusGate` — the answer of `status` held back. While `cliPresent` is false (`cli: false`) the computer has no Orca
// CLI. `agent installed --json` answers as Orca's CLI does with the agents of `installedAgents` (by default Claude and
// Codex), `{ ok: true, result: { agents: [{ id, name, default }] } }`; `installedRefusal` — Orca refuses it
// (`{ ok: false, error }`, exit 1); `installedAnswer` — the answer as given (no JSON, a timeout …). The CLI sits at a
// known path of Ф14 under the fake home (FAKE_HOME of the system), or under `home` when the test gives one (a real
// temporary directory, for a computer that runs real git).
import { hostError, mockHost, type MockHost } from 'orca/testing'
import type { Platform } from '../platform/machine'
import { FAKE_HOME, fakeClock, fakeMachine, orcaStatusAnswer, type FakeAnswer, type FakeClock, type FakeMachine } from './fake-machine'

export type FakeAgentState = 'working' | 'blocked' | 'waiting' | 'done'

export type FakeTerminal = {
  readonly id: string
  readonly workspaceId: string
  readonly agent: string | null
  // Opened by the plugin (`agent.launch`), not by the owner.
  readonly byPlugin: boolean
  open: boolean
  // The prompt `agent.launch` was given.
  readonly prompt: string | null
  // The lines typed into it, in order: by Orca's CLI, or by the host's `terminal.sendText` (which only the test calls).
  readonly typed: string[]
}

// An error of Orca's CLI (`{ ok: false, error }`).
export type FakeCliError = { readonly code: string; readonly message: string; readonly data?: Record<string, unknown> }

// An agent as `agent installed --json` lists it.
export type FakeInstalledAgent = { readonly id: string; readonly name?: string; readonly default?: boolean }

// The agents `agent installed` lists unless the test says otherwise.
export const FAKE_INSTALLED_AGENTS: readonly FakeInstalledAgent[] = [
  { id: 'claude', name: 'Claude', default: true },
  { id: 'codex', name: 'Codex', default: false },
]

export type FakeOrca = {
  readonly host: MockHost
  readonly machine: FakeMachine
  readonly clock: FakeClock
  // The path of Orca's CLI on the fake computer.
  readonly cli: string
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
  // While set, `agents.list` answers only once the promise settles — with the states listed when it was called.
  listGate: Promise<void> | null
  // While set, Orca refuses `agents.list` with this error.
  listError: { readonly code: string; readonly message: string } | null
  // Whether the CLI sees the agent start a turn on the line it types (the stage `turn_started` of its receipt).
  turnStarts: boolean
  // Whether the computer has Orca's CLI.
  cliPresent: boolean
  // The agents `agent installed --json` lists, in Orca's order.
  installedAgents: FakeInstalledAgent[]
  // While set, Orca refuses `agent installed` with this error (exit 1).
  installedRefusal: FakeCliError | null
  // While set, `agent installed` answers this as it is.
  installedAnswer: FakeAnswer | null
  // Orca's refusals of the next CLI sends, in order: each types nothing and leaves its request unseen.
  readonly cliRefusals: FakeCliError[]
  // The next CLI sends' answers as they are, in order: each types nothing and leaves its request unseen.
  readonly cliAnswers: FakeAnswer[]
  // How many of the next CLI sends end without an answer after Orca handled them (typed the line, or repeated the
  // outcome of a request it had seen).
  loseAnswers: number
  // While set, the CLI's `terminal send` types at once and answers only once the promise settles.
  cliGate: Promise<void> | null
  // While set, the next CLI send waits for it before Orca handles it; that send takes it.
  cliHoldNext: Promise<void> | null
  // While set, the CLI's `status` answers only once the promise settles.
  statusGate: Promise<void> | null
  // How long a CLI send Orca handles takes after the line is typed (or the outcome repeated): the clock moves by it
  // before the answer.
  sendDurationMs: number
  // The agent of a terminal as `agents.list` names it from now on: its state, and since when.
  list(terminalId: string, state: FakeAgentState, stateStartedAt: number): void
  // `agents.list` no longer names the agent of the terminal.
  unlist(terminalId: string): void
  // The agent of the terminal ends its turn with its report: `text` written to `reportFile` now, and the agent listed
  // «done» from now on (the clock's reading, which is also the file's time of last write).
  finishTurn(launch: { readonly terminalId: string; readonly reportFile: string }, text: string): void
  // A terminal the owner opened in a workspace.
  ownerTerminal(workspaceId: string): string
}

// Where each system keeps Orca's CLI the plugin finds on the fake computer: a known path of src/platform/orca-cli.ts.
function cliPath(platform: Platform, home: string): string {
  if (platform === 'win32') return `${home}\\AppData\\Local\\Programs\\Orca\\resources\\bin\\orca.exe`
  if (platform === 'darwin') return '/usr/local/bin/orca'
  return `${home}/.local/bin/orca-ide`
}

export function fakeOrca(
  options: {
    readonly platform?: Platform
    readonly results?: Record<string, unknown>
    readonly cli?: boolean
    // The home directory the CLI's known path is under; FAKE_HOME of the system by default.
    readonly home?: string
  } = {},
): FakeOrca {
  const platform = options.platform ?? 'linux'
  const clock = fakeClock()
  const cli = cliPath(platform, options.home ?? FAKE_HOME[platform])
  const terminals = new Map<string, FakeTerminal>()
  const listed = new Map<string, { readonly state: FakeAgentState; readonly stateStartedAt: number }>()
  let opened = 0
  // The answer Orca repeats for each request id it has seen.
  const requests = new Map<string, string>()
  let answered = 0

  // Orca's CLI: `status --json`, and `terminal send`.
  const answer = (request: { readonly file: string; readonly args: readonly string[] }): FakeAnswer => {
    if (request.file !== cli) return { startError: { code: 'ENOENT', message: `spawn ${request.file} ENOENT` } }
    const [command, sub] = request.args
    if (command === 'status') return orcaStatusAnswer('1.4.274')
    if (command === 'agent' && sub === 'installed') {
      if (fake.installedAnswer !== null) return fake.installedAnswer
      if (fake.installedRefusal !== null) {
        return { code: 1, stdout: JSON.stringify({ id: `cli-${++answered}`, ok: false, error: fake.installedRefusal }) }
      }
      const agents = fake.installedAgents.map((agent) => ({ id: agent.id, name: agent.name ?? agent.id, default: agent.default ?? false }))
      return { code: 0, stdout: JSON.stringify({ id: `cli-${++answered}`, ok: true, result: { agents } }) }
    }
    if (command !== 'terminal' || sub !== 'send') {
      return { code: 1, stdout: JSON.stringify({ id: 'cli-0', ok: false, error: { code: 'invalid_argument', message: 'unknown command' } }) }
    }
    const flag = (name: string) => {
      const at = request.args.indexOf(name)
      return at < 0 ? undefined : request.args[at + 1]
    }
    const handle = flag('--terminal') ?? ''
    const text = flag('--text') ?? ''
    const requestId = flag('--retry-request')
    const given = fake.cliAnswers.shift()
    if (given !== undefined) return given
    const refusal = fake.cliRefusals.shift()
    if (refusal !== undefined) return { code: 1, stdout: JSON.stringify({ id: `cli-${++answered}`, ok: false, error: refusal }) }
    const lost = (): FakeAnswer | null => {
      if (fake.loseAnswers <= 0) return null
      fake.loseAnswers--
      return { timedOut: true, signal: 'SIGKILL' }
    }
    const seen = requestId === undefined ? undefined : requests.get(requestId)
    if (seen !== undefined) return lost() ?? { code: 0, stdout: seen, durationMs: fake.sendDurationMs }
    const terminal = terminals.get(handle)
    if (terminal === undefined || !terminal.open) {
      return {
        code: 1,
        stdout: JSON.stringify({ id: `cli-${++answered}`, ok: false, error: { code: 'terminal_handle_stale', message: `terminal_handle_stale ${handle}` } }),
      }
    }
    terminal.typed.push(text)
    const stages = fake.turnStarts && request.args.includes('--wait-submit') ? ['input_accepted', 'turn_started'] : ['input_accepted']
    // Orca's receipt; a request id seen again gets the same one.
    const receipt = JSON.stringify({
      id: `cli-${++answered}`,
      ok: true,
      result: {
        send: {
          handle,
          accepted: true,
          bytesWritten: text.length + 1,
          prompt: { requestId: requestId ?? null, stages, provider: terminal.agent ?? 'unsupported', observation: 'supported' },
        },
      },
    })
    if (requestId !== undefined) requests.set(requestId, receipt)
    return lost() ?? { code: 0, stdout: receipt, durationMs: fake.sendDurationMs }
  }

  const base = fakeMachine({ platform, clock, executables: [cli], answer })
  const machine: FakeMachine = {
    ...base,
    isRunnableFile: (path) => (path === cli ? fake.cliPresent : base.isRunnableFile(path)),
    start: async (request) => {
      const status = fake.statusGate
      if (request.args[0] === 'status' && status !== null) await status
      const sending = request.args[0] === 'terminal'
      const hold = fake.cliHoldNext
      if (sending && hold !== null) {
        fake.cliHoldNext = null
        await hold
      }
      const gate = fake.cliGate
      if (!sending || gate === null) return base.start(request)
      // Orca handles the send at once; its answer waits.
      const outcome = await base.start(request)
      await gate
      return outcome
    },
  }

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
          typed: [],
        })
        return { terminalId: id }
      },
      'terminal.sendText': (params: { terminalId: string; text: string; enter?: boolean }) => {
        if (fake.focused === null) throw hostError('action_failed', 'no active worktree is available for terminal input')
        const terminal = terminals.get(params.terminalId)
        if (terminal === undefined || !terminal.open || terminal.workspaceId !== fake.focused) {
          throw hostError('action_failed', 'terminal is outside the active worktree')
        }
        terminal.typed.push(params.text)
        return { accepted: true }
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
      'agents.list': async (params: { workspaceId?: string }) => {
        if (fake.listError !== null) throw hostError(fake.listError.code, fake.listError.message)
        // The states as Orca has them when it gets the call.
        const agents = [...terminals.values()].flatMap((terminal) => {
          const entry = listed.get(terminal.id)
          if (entry === undefined || terminal.workspaceId !== params.workspaceId) return []
          return [{ terminalId: terminal.id, title: null, agent: terminal.agent, state: entry.state, stateStartedAt: entry.stateStartedAt }]
        })
        const gate = fake.listGate
        if (gate !== null) await gate
        return { agents }
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
    onLaunch: null,
    launchGate: null,
    closeGate: null,
    listTruncated: false,
    listGate: null,
    listError: null,
    turnStarts: true,
    cliPresent: options.cli !== false,
    installedAgents: [...FAKE_INSTALLED_AGENTS],
    installedRefusal: null,
    installedAnswer: null,
    cliRefusals: [],
    cliAnswers: [],
    loseAnswers: 0,
    cliGate: null,
    cliHoldNext: null,
    statusGate: null,
    sendDurationMs: 0,
    list: (terminalId, state, stateStartedAt) => {
      listed.set(terminalId, { state, stateStartedAt })
    },
    unlist: (terminalId) => {
      listed.delete(terminalId)
    },
    finishTurn: (launch, text) => {
      machine.files.set(launch.reportFile, text)
      listed.set(launch.terminalId, { state: 'done', stateStartedAt: machine.clock.now() })
    },
    ownerTerminal: (workspaceId) => {
      const id = `terminal-of-the-owner-${terminals.size + 1}`
      terminals.set(id, { id, workspaceId, agent: null, byPlugin: false, open: true, prompt: null, typed: [] })
      return id
    },
  }
  return fake
}
