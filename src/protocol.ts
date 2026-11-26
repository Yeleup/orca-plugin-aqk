// The panel <-> worker contract, declared once: src/panel.tsx (with src/ui/) and src/worker.ts both read it.
export {}

/** A project connected to the queue, as the panel's project selector shows it. */
export type Project = {
  /** Stable id the panel keeps as the selected project. */
  id: string
  /** Name shown in the selector. */
  name: string
}

declare module 'orca' {
  interface PluginRequests {
    /** The projects connected to the queue on this computer. */
    'projects.list': { output: { projects: Project[] } }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel when the connected projects change: the whole new list. */
    'projects.changed': { projects: Project[] }
  }
}
