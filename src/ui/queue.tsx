// «Очередь»: the title «Agent Queue», the project selector (connected projects, from the worker) and the menu to the
// other screens. The queue itself — the project row, the sections of tasks, the MVP block — comes with later tasks.
import { atom, Button, plugin, read, Row, Select, set, Stack } from 'orca'
import type { MessageKey } from '../i18n/catalog'
import type { Project } from '../protocol'
import { ScreenHeader } from './header'
import { t } from './language'
import { openScreen, type ScreenName } from './navigation'
import { resource } from './request'
import { LoadingRows, RequestError } from './states'

/** The connected projects, as the worker answers `projects.list`. */
export const connectedProjects = resource(async () => (await plugin.request('projects.list')).projects)

/** The id of the project the person picked; kept across panel runs. */
export const selectedProject = atom<string | null>('selectedProject', null, { persist: 'plugin' })

/** The picked project, or the first one when the pick is no longer connected; null without projects. */
export function currentProject(projects: readonly Project[]): Project | null {
  const id = read(selectedProject)
  return projects.find((project) => project.id === id) ?? projects[0] ?? null
}

/** The menu of «Очередь», in the order of the ТЗ, and the screen each item opens. */
export const QUEUE_MENU: readonly { label: MessageKey; screen: ScreenName }[] = [
  { label: 'menu.doctor', screen: 'doctor' },
  { label: 'menu.mvpStart', screen: 'mvpStart' },
  { label: 'menu.settings', screen: 'settings' },
  { label: 'menu.connect', screen: 'connect' },
]

export function QueueScreen() {
  const state = read(connectedProjects.state)
  const projects = state.status === 'ready' ? state.data : []
  const current = currentProject(projects)
  return (
    <Stack gap="md">
      <ScreenHeader title={t('app.title')}>
        {current ? (
          <Select
            label={t('queue.project')}
            labelHidden
            options={projects.map((project) => ({ value: project.id, label: project.name }))}
            value={current.id}
            onChange={(id) => set(selectedProject, id)}
          />
        ) : null}
      </ScreenHeader>
      {state.status === 'loading' ? <LoadingRows label={t('state.loading')} /> : null}
      {state.status === 'error' ? (
        <RequestError
          message={t('queue.projectsError', { error: state.message })}
          onRetry={connectedProjects.load}
        />
      ) : null}
      {state.status === 'ready' ? (
        <Row wrap gap="xs">
          {QUEUE_MENU.map((item) => (
            <Button
              key={item.screen}
              variant="ghost"
              tone="accent"
              size="sm"
              onPress={() => openScreen(item.screen)}
            >
              {t(item.label)}
            </Button>
          ))}
        </Row>
      ) : null}
    </Stack>
  )
}
