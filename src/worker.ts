// The plugin's worker. Orca transpiles this file when it loads it: no build step. It answers the panel's
// plugin.request (src/protocol.ts); the MVP's tasks give it the rest of its functions.
import type { OrcaWorkerApi } from 'orca/worker'
import type { Project } from './protocol'

// The projects connected to the queue. None yet: connecting a project is the task `connect` (docs/mvp/plan.md), which
// gives this its source — the Orca projects whose remote base branch has the connect commit with .agent-queue.json —
// and posts `projects.changed` to open panels when the list changes.
async function connectedProjects(): Promise<Project[]> {
  return []
}

export default function activate(orca: OrcaWorkerApi): void {
  orca.log('agent-queue: worker started')
  orca.panels.handle('projects.list', async () => ({ projects: await connectedProjects() }))
}
