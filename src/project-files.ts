// «Настройки проекта» on the screen «Настройки»: the worker opens the project's .agent-queue.json or .agent-queue.md in
// Orca's editor (workspace.open and editor.open are worker-only host methods). The file opens in the project's main
// checkout — the workspace of the Orca project, on the project's host, at the project's own path — where the base
// branch keeps these files.
import type { HostApi } from 'orca/host'
import { PROJECT_FILES, type OpenProjectFileAnswer, type ProjectFile } from './protocol'

type Host = Pick<HostApi<'worker'>, 'call'>

/** Opens `input.file` of the project `input.projectId` on `input.hostId`; anything but one of PROJECT_FILES is refused. */
export async function openProjectFile(host: Host, input: unknown): Promise<OpenProjectFileAnswer> {
  const { projectId, hostId, file } = parseInput(input)
  const workspaceId = await mainCheckout(host, projectId, hostId)
  if (workspaceId === null) return { opened: false, reason: 'no_checkout' }
  // editor.open changes the tab inside the workspace it names; the person sees it only once Orca shows that workspace.
  await host.call('workspace.open', { workspaceId })
  // editor.open takes the file's path relative to the workspace.
  await host.call('editor.open', { workspaceId, path: file })
  return { opened: true }
}

/**
 * The id of the workspace of the project's main checkout, or null when Orca has no such project or workspace. The
 * project and its workspace are looked up on `hostId` only: a copy of the project on another host may have the same id
 * and the same path.
 */
export async function mainCheckout(host: Host, projectId: string, hostId: string): Promise<string | null> {
  const { projects } = await host.call('project.list')
  const project = projects.find((candidate) => candidate.id === projectId && candidate.hostId === hostId)
  if (!project) return null
  const { workspaces } = await host.call('workspace.list')
  const checkout = workspaces.find(
    (workspace) =>
      workspace.projectId === project.id &&
      // A row that records no host is one of this machine (workspace.list).
      (workspace.hostId ?? 'local') === hostId &&
      workspace.kind === 'worktree' &&
      samePath(workspace.path, project.path),
  )
  return checkout?.id ?? null
}

/** Whether Orca's two paths name one directory: separators and a trailing one aside, a Windows drive path in any case. */
function samePath(left: string, right: string): boolean {
  const plain = (path: string) => {
    const slashes = path.replace(/\\/g, '/').replace(/(?<=.)\/+$/, '')
    return /^[A-Za-z]:(\/|$)/.test(slashes) ? slashes.toLowerCase() : slashes
  }
  return plain(left) === plain(right)
}

function parseInput(input: unknown): { projectId: string; hostId: string; file: ProjectFile } {
  const { projectId, hostId, file } = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  if (typeof projectId !== 'string' || projectId === '') throw invalidParams('project.openFile: no projectId')
  if (typeof hostId !== 'string' || hostId === '') throw invalidParams('project.openFile: no hostId')
  const known = PROJECT_FILES.find((name) => name === file)
  if (!known) throw invalidParams(`project.openFile: not a project settings file: ${JSON.stringify(file)}`)
  return { projectId, hostId, file: known }
}

/** An error the panel's request rejects with, code included (orca/worker: a host error code reaches the panel). */
function invalidParams(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'invalid_params' })
}
