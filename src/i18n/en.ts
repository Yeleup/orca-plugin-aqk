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

  'settings.language': 'Interface language',
  'settings.languageEnglish': 'English',
  'settings.languageRussian': 'Русский',
  'settings.interval': 'Queue check interval, minutes',
  'settings.intervalInvalid': 'Enter a whole number of minutes, at least {min}',
  'settings.mergeNotifications': 'Merge notifications',
  'settings.coordinator': 'Coordinator on this computer',
  'settings.project': 'Project settings',
  'settings.configFile': '.agent-queue.json',
  'settings.rulesFile': '.agent-queue.md',
  'settings.openFile': "Opens the file in Orca's editor",
  'settings.noProjects': 'No connected projects',
  'settings.saved': 'Saved.',
  'settings.savedNotificationsOff': 'Saved: there will be no merge notifications; blocking notifications will still come.',
  'settings.savedCoordinatorOff':
    'Saved: the coordinator of this computer neither takes nor runs tasks; the panel only shows the queue.',
  'settings.savedBothOff': 'Saved: no merge notifications, and the coordinator of this computer takes no tasks.',
  'settings.saveError': 'Could not save: {error}',
  'settings.readError': 'Could not read the settings: {error}',
  'settings.openError': 'Could not open {file}: {error}',
  'settings.noCheckout': 'Orca has no main checkout of this project',
} as const satisfies Record<string, string>

export type MessageKey = keyof typeof en
