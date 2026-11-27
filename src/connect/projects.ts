// The Orca projects of this computer and whether each is connected to the queue (Ф1, point 1). A project is connected
// when the base branch of its `origin` has the connection commit — the plugin's .agent-queue.json there, read as the
// project's settings are read (src/project/settings.ts: from the branches of `origin` this clone knows, no fetch); a
// file with a wrong field still counts as connected («Проверка проекта» names the field). A project on agent-queue-kit
// — `.agent-queue/config.json` in its main checkout — is offered with its mark and never chosen: the plugin touches
// neither its files nor its labels nor its entry rule.
//
// Only Orca's git projects of this computer (`project.list`: kind `git`, host `local`) count: the worker's git reaches
// only this computer's checkouts. The project's main checkout is the project's own path.
import type { HostApi } from 'orca/host'
import type { Machine } from '../platform/machine'
import { worktreeFile } from '../platform/paths'
import { readProjectSettings } from '../project/settings'
import type { ConnectCandidate, Project } from '../protocol'
import { originRepository, repositoryName } from './checks'

type Host = Pick<HostApi<'worker'>, 'call'>

export type OrcaProject = Project & { readonly path: string }

// The file of agent-queue-kit's settings in a project on the kit.
export const KIT_CONFIG = '.agent-queue/config.json'

export const LOCAL_HOST = 'local'

// Orca's git projects on this computer, in Orca's order.
export async function localProjects(host: Host): Promise<OrcaProject[]> {
  const { projects } = await host.call('project.list')
  return projects
    .filter((project) => project.kind === 'git' && (project.hostId ?? LOCAL_HOST) === LOCAL_HOST)
    .map((project) => ({ id: project.id, hostId: LOCAL_HOST, name: project.name, path: project.path }))
}

// The project `id` on `hostId` among them, or null.
export async function findProject(host: Host, id: string, hostId: string): Promise<OrcaProject | null> {
  return (await localProjects(host)).find((project) => project.id === id && project.hostId === hostId) ?? null
}

// Whether the base branch of the project's `origin` has the plugin's settings.
export async function isConnected(machine: Machine, project: OrcaProject): Promise<boolean> {
  const read = await readProjectSettings(machine, project.path)
  return read.ok || read.kind === 'invalid'
}

// Whether the project is on agent-queue-kit: its main checkout has `.agent-queue/config.json`.
export function isOnKit(machine: Machine, project: OrcaProject): boolean {
  try {
    return machine.readText(worktreeFile(machine, project.path, KIT_CONFIG)) !== null
  } catch {
    // Not a readable file there (a directory, no access): not the kit's settings.
    return false
  }
}

// The connected projects, as the panel's project selector shows them.
export async function connectedProjects(host: Host, machine: Machine): Promise<Project[]> {
  const connected: Project[] = []
  for (const project of await localProjects(host)) {
    if (await isConnected(machine, project)) connected.push({ id: project.id, hostId: project.hostId, name: project.name })
  }
  return connected
}

// The wizard's step 1: the projects not connected, each with its GitHub repository (or none) and the kit's mark.
export async function connectCandidates(host: Host, machine: Machine): Promise<ConnectCandidate[]> {
  const candidates: ConnectCandidate[] = []
  for (const project of await localProjects(host)) {
    if (await isConnected(machine, project)) continue
    const repository = await originRepository(machine, project.path)
    candidates.push({
      id: project.id,
      hostId: project.hostId,
      name: project.name,
      path: project.path,
      repository: repository === null ? null : repositoryName(repository),
      kit: isOnKit(machine, project),
    })
  }
  return candidates
}
