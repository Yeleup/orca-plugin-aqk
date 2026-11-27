// The plugin's worker. Orca transpiles this file when it loads it: no build step. It answers the panel's
// plugin.request (src/protocol.ts): the connected projects, the files of «Настройки проекта», and the wizard
// «Подключение проекта» (src/connect/), which posts `projects.changed` to open panels once a project is connected. On
// start it settles the common layer of the three systems (src/platform/): the plugin's data directory on this computer
// and the coordinator id kept there; then the layer of the agents (src/agents/), which hears Orca's
// agent.status.changed. The plugin's settings (interval, switches) it reads with readSettings(orca.settings) from
// src/settings.ts. The MVP's tasks give it the rest of its functions.
import type { OrcaWorkerApi } from 'orca/worker'
import { startAgents, type Agents } from './agents/agents'
import { Connector } from './connect/connect'
import { ensureCoordinatorId } from './platform/coordinator-id'
import { errorMessage, realMachine, type Machine } from './platform/machine'
import { dataDirectory } from './platform/paths'
import { openProjectFile } from './project-files'

export type WorkerContext = {
  readonly machine: Machine
  readonly dataDir: string
  // Null when the data directory could not give one (the reason is in the log): nothing that needs the id may start.
  readonly coordinatorId: string | null
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  await startOn(orca, realMachine())
}

// The whole worker on `machine` — what activate starts on this computer, and what tests start on their own: the
// plugin's layers, then its answers to the panel. The connected projects are Orca's projects of this computer whose
// remote base branch has the connection commit with .agent-queue.json (src/connect/projects.ts).
export async function startOn(
  orca: OrcaWorkerApi,
  machine: Machine,
): Promise<WorkerContext & { readonly agents: Agents; readonly connector: Connector }> {
  const plugin = await startPlugin(orca, machine)
  const connector = new Connector({
    host: orca.host,
    machine,
    dataDir: plugin.dataDir,
    log: (message) => orca.log(message),
    post: (projects) => orca.panels.post('projects.changed', { projects }),
  })
  orca.panels.handle('projects.list', async () => ({ projects: await connector.connected() }))
  orca.panels.handle('project.openFile', (input) => openProjectFile(orca.host, input))
  orca.panels.handle('connect.projects', async () => ({ projects: await connector.candidates() }))
  orca.panels.handle('connect.checkGit', (input) => connector.checkGit(input))
  orca.panels.handle('connect.checkGh', (input) => connector.checkGh(input))
  orca.panels.handle('connect.checkAgents', (input) => connector.checkAgents(input))
  orca.panels.handle('connect.connect', (input) => connector.connect(input))
  return { ...plugin, connector }
}

// The worker as activate starts it on `machine`: the common layer of the three systems, then the layer of the agents of
// the queue's tasks, subscribed to Orca's agent.status.changed. The next tasks (the coordinator) take the layer from
// here.
export async function startPlugin(
  orca: Pick<OrcaWorkerApi, 'log' | 'host' | 'events'>,
  machine: Machine,
): Promise<WorkerContext & { readonly agents: Agents }> {
  const context = await startWorker(orca, machine)
  return { ...context, agents: startAgents(orca, machine, context.dataDir) }
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
