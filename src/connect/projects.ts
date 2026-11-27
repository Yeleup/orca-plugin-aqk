// The git projects of Orca and whether each is connected to the queue (Ф1, point 1; decision «🤖 Решение по #11:
// вопрос», the second). The plugin connects and runs only the git projects of this computer — Orca's host `local` (or
// none named): git, `gh`, the tests, the data directory and the journal of operations are on the worker's computer, and
// the plugin API of Orca gives no way to run a command or read a file on the host of a project. A project of another
// host (`ssh:…`, `runtime:…` or any other id) is listed in the wizard's step 1 as unavailable, with its host, and never
// chosen: for it the worker starts no process and reads no file by its path — whether it is connected or on
// agent-queue-kit is not asked; `projects.list` never names it. Folders of Orca are not projects of the queue.
//
// A project of this computer is connected when the base branch of its `origin` has the connection commit — the
// plugin's .agent-queue.json there, read as the project's settings are read (src/project/settings.ts: from the branches
// of `origin` this clone knows, no fetch); a file with a wrong field still counts as connected («Проверка проекта»
// names the field). A project on agent-queue-kit — `.agent-queue/config.json` in its main checkout — is offered with
// its mark and never chosen: the plugin touches neither its files nor its labels nor its entry rule. Whether that file
// is there is told by the path alone (its contents are never read); when even that cannot be told (no access), the
// project is not chosen either: nothing is written over a project that may be on the kit. The project's main checkout
// is the project's own path.
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

// Orca's git projects, in Orca's order: those of this computer and those of other hosts.
async function gitProjects(host: Host): Promise<{ readonly project: OrcaProject; readonly local: boolean }[]> {
  const { projects } = await host.call('project.list')
  return projects
    .filter((project) => project.kind === 'git')
    .map((project) => {
      const local = (project.hostId ?? LOCAL_HOST) === LOCAL_HOST
      return { project: { id: project.id, hostId: local ? LOCAL_HOST : (project.hostId ?? ''), name: project.name, path: project.path }, local }
    })
}

// Orca's git projects of this computer, in Orca's order.
export async function localProjects(host: Host): Promise<OrcaProject[]> {
  return (await gitProjects(host)).filter((one) => one.local).map((one) => one.project)
}

// The project `id` on `hostId` among the projects of this computer, or null (a project of another host included).
export async function findProject(host: Host, id: string, hostId: string): Promise<OrcaProject | null> {
  return (await localProjects(host)).find((project) => project.id === id && project.hostId === hostId) ?? null
}

// Whether the base branch of the project's `origin` has the plugin's settings.
export async function isConnected(machine: Machine, project: OrcaProject): Promise<boolean> {
  const read = await readProjectSettings(machine, project.path)
  return read.ok || read.kind === 'invalid'
}

// Whether the project is on agent-queue-kit — its main checkout has a `.agent-queue/config.json` path, whatever it is —
// or `unknown` when the system cannot tell (no access on the way).
export function kitOf(machine: Machine, project: OrcaProject): 'yes' | 'no' | 'unknown' {
  try {
    return machine.modifiedAt(worktreeFile(machine, project.path, KIT_CONFIG)) === null ? 'no' : 'yes'
  } catch {
    return 'unknown'
  }
}

// The connected projects of this computer, as the panel's project selector shows them.
export async function connectedProjects(host: Host, machine: Machine): Promise<Project[]> {
  const connected: Project[] = []
  for (const project of await localProjects(host)) {
    if (await isConnected(machine, project)) connected.push({ id: project.id, hostId: project.hostId, name: project.name })
  }
  return connected
}

// The wizard's step 1, in Orca's order: the projects of this computer not connected, each with its GitHub repository
// (or none) and the kit's mark; the projects of other hosts, unavailable, with nothing of them looked at.
export async function connectCandidates(host: Host, machine: Machine): Promise<ConnectCandidate[]> {
  const candidates: ConnectCandidate[] = []
  for (const { project, local } of await gitProjects(host)) {
    if (!local) {
      candidates.push({
        id: project.id,
        hostId: project.hostId,
        name: project.name,
        path: '',
        repository: null,
        kit: false,
        kitUnknown: false,
        otherHost: true,
      })
      continue
    }
    if (await isConnected(machine, project)) continue
    const repository = await originRepository(machine, project.path)
    const kit = kitOf(machine, project)
    candidates.push({
      id: project.id,
      hostId: project.hostId,
      name: project.name,
      path: project.path,
      repository: repository === null ? null : repositoryName(repository),
      kit: kit === 'yes',
      kitUnknown: kit === 'unknown',
      otherHost: false,
    })
  }
  return candidates
}
