// The plugin's worker. Orca transpiles this file when it loads it: no build step. It answers the panel's
// plugin.request (src/protocol.ts). On start it settles the common layer of the three systems (src/platform/): the
// plugin's data directory on this computer and the coordinator id kept there. The plugin's settings (interval,
// switches) it reads with readSettings(orca.settings) from src/settings.ts. The MVP's tasks give it the rest of its
// functions.
import type { OrcaWorkerApi } from 'orca/worker'
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

// The projects connected to the queue. None yet: connecting a project is the task `connect` (docs/mvp/plan.md), which
// gives this its source — the Orca projects whose remote base branch has the connect commit with .agent-queue.json —
// and posts `projects.changed` to open panels when the list changes.
async function connectedProjects(): Promise<Project[]> {
  return []
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  await startWorker(orca, realMachine())
  orca.panels.handle('projects.list', async () => ({ projects: await connectedProjects() }))
  orca.panels.handle('project.openFile', (input) => openProjectFile(orca.host, input))
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
