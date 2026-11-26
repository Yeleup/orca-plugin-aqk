// The panel <-> worker contract, declared once: src/panel.tsx (with src/ui/) and src/worker.ts both read it.

/** A project connected to the queue, as the panel's project selector shows it. */
export type Project = {
  /** Orca's id of the project (`project.list`): the panel keeps it as the selected project, the worker finds the
   *  project's main checkout by it and `hostId`. */
  id: string
  /** Orca's host of the project (`project.list`: `local`, `ssh:…`, `runtime:…`): one id can name copies of a project
   *  on two hosts. */
  hostId: string
  /** Name shown in the selector. */
  name: string
}

/** The project's files of «Настройки проекта» (screen «Настройки»), by their path in the project's main checkout. */
export const PROJECT_FILES = ['.agent-queue.json', '.agent-queue.md'] as const
export type ProjectFile = (typeof PROJECT_FILES)[number]

/** The worker's answer to `project.openFile`. `no_checkout`: Orca has no workspace of the project's main checkout. */
export type OpenProjectFileAnswer = { opened: true } | { opened: false; reason: 'no_checkout' }

declare module 'orca' {
  interface PluginRequests {
    /** The projects connected to the queue on this computer. */
    'projects.list': { output: { projects: Project[] } }
    /** Shows the project's main checkout in Orca and opens one of its files of «Настройки проекта» there in Orca's
     *  editor. A file that is not one of PROJECT_FILES is refused with `invalid_params`; Orca's refusals come as is. */
    'project.openFile': {
      input: { projectId: string; hostId: string; file: ProjectFile }
      output: OpenProjectFileAnswer
    }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel when the connected projects change: the whole new list. */
    'projects.changed': { projects: Project[] }
  }
}
