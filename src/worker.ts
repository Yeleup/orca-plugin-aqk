// The plugin's worker. Orca transpiles this file when it loads it: no build step. It answers the panel's
// plugin.request (src/protocol.ts). On start it settles the common layer of the three systems (src/platform/): the
// plugin's data directory on this computer and the coordinator id kept there; then the layer of the agents
// (src/agents/), which hears Orca's agent.status.changed; then the coordinator of this computer (src/coordinator/),
// whose periodic check of the queue activate starts. The plugin's settings (interval, switches) it reads with
// readSettings(orca.settings) from src/settings.ts. The MVP's tasks give it the rest of its functions.
import type { OrcaWorkerApi } from 'orca/worker'
import { startAgents, type Agents } from './agents/agents'
import { Coordinator, type CoordinatorOptions, type QueueProject } from './coordinator/coordinator'
import { startQueueCheck, type QueueCheck, type Timers } from './coordinator/schedule'
import { ensureCoordinatorId } from './platform/coordinator-id'
import { errorMessage, realMachine, type Machine } from './platform/machine'
import { dataDirectory } from './platform/paths'
import { openProjectFile } from './project-files'
import type { Project } from './protocol'

export type WorkerContext = {
  readonly machine: Machine
  readonly dataDir: string
  // Null when the data directory could not give one (the reason is in the log): nothing that needs the id may start.
  readonly coordinatorId: string | null
}

// The projects connected to the queue, each with its main checkout and GitHub repository (the coordinator reads the
// settings and the tasks through them; the panel gets the id, the host and the name). None yet: connecting a project is
// the task `connect` (docs/mvp/plan.md), which gives this its source — the Orca projects whose remote base branch has
// the connect commit with .agent-queue.json — and posts `projects.changed` to open panels when the list changes.
async function connectedProjects(): Promise<QueueProject[]> {
  return []
}

let queueCheck: QueueCheck | null = null

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  deactivate()
  const plugin = await startPlugin(orca, realMachine())
  orca.panels.handle('projects.list', async () => ({ projects: (await connectedProjects()).map(panelProject) }))
  orca.panels.handle('project.openFile', (input) => openProjectFile(orca.host, input))
  queueCheck = startCoordinator(orca, plugin, { projects: connectedProjects })
}

// Orca awaits it before it stops the worker: no check of the queue is planned after it.
export function deactivate(): void {
  queueCheck?.stop()
  queueCheck = null
}

function panelProject(project: QueueProject): Project {
  return { id: project.id, hostId: project.hostId, name: project.name }
}

// The worker as activate starts it on `machine`: the common layer of the three systems, then the layer of the agents of
// the queue's tasks, subscribed to Orca's agent.status.changed, and the coordinator of this computer (none without a
// coordinator id). `coordinator` — what tests put in: the hooks, the settings of projects, the wait of the protocol.
export async function startPlugin(
  orca: Pick<OrcaWorkerApi, 'log' | 'host' | 'events'>,
  machine: Machine,
  coordinator: Partial<Omit<CoordinatorOptions, 'machine' | 'dataDir' | 'coordinatorId'>> = {},
): Promise<WorkerContext & { readonly agents: Agents; readonly coordinator: Coordinator | null }> {
  const context = await startWorker(orca, machine)
  const agents = startAgents(orca, machine, context.dataDir)
  const id = context.coordinatorId
  const options = { machine, dataDir: context.dataDir, log: (line: string) => orca.log(line), ...coordinator }
  return { ...context, agents, coordinator: id === null ? null : new Coordinator({ ...options, coordinatorId: id }) }
}

// The periodic check of the queue of the connected projects by the coordinator of the plugin (src/coordinator/
// schedule.ts), by the plugin's settings of this computer. `timers` — fake ones in tests.
export function startCoordinator(
  orca: Pick<OrcaWorkerApi, 'log' | 'settings'>,
  plugin: { readonly machine: Machine; readonly coordinator: Coordinator | null },
  options: { readonly projects: () => Promise<readonly QueueProject[]>; readonly timers?: Timers },
): QueueCheck {
  return startQueueCheck({
    settings: orca.settings,
    coordinator: plugin.coordinator,
    projects: options.projects,
    now: () => plugin.machine.now(),
    log: (line) => orca.log(line),
    ...(options.timers ? { timers: options.timers } : {}),
  })
}

export async function startWorker(orca: Pick<OrcaWorkerApi, 'log'>, machine: Machine): Promise<WorkerContext> {
  const dataDir = dataDirectory(machine)
  try {
    const coordinatorId = await ensureCoordinatorId(machine, dataDir)
    orca.log(`agent-queue: worker started, coordinator ${coordinatorId}`)
    return { machine, dataDir, coordinatorId }
  } catch (error) {
    orca.log(`agent-queue: worker started without a coordinator id: ${errorMessage(error)}`)
    return { machine, dataDir, coordinatorId: null }
  }
}
