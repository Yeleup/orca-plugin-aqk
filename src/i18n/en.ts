// The English string catalog of the panel: every text a screen shows comes from here or from ./ru.ts.
// `{name}` marks a value the screen puts in.
export const en = {
  'app.title': 'Agent Queue',
  'nav.back': 'Back',

  'state.loading': 'Loading…',
  'state.error': 'Error',
  'state.retry': 'Retry',

  'queue.project': 'Project',
  'queue.projectsError': 'Could not read the connected projects: {error}',
  'menu.doctor': 'Project check',
  'menu.mvpStart': 'Start MVP',
  'menu.settings': 'Settings',
  'menu.connect': 'Connect project',

  'screen.task': 'Task',
  'screen.newTask': 'New task',
  'screen.answer': 'Answer',
  'screen.connect': 'Connect project',
  'screen.doctor': 'Project check',
  'screen.settings': 'Settings',
  'screen.mvp': 'MVP',
  'screen.mvpStart': 'MVP start',
} as const satisfies Record<string, string>

export type MessageKey = keyof typeof en
