// «Настройки» (ТЗ «Экраны»): the plugin's settings on this computer (src/settings.ts) — the interface language, the
// queue check interval, merge notifications and the coordinator of this computer — and «Настройки проекта», which opens
// the selected project's .agent-queue.json and .agent-queue.md in Orca's editor (through the worker). A change is saved
// at once: the screen then says «Сохранено» (after a switch, also what the switches now mean) or «Не удалось сохранить:
// <ошибка>», and it always shows the values Orca keeps, never one a failed write did not save.
import { atom, Button, Callout, Input, plugin, read, Row, Select, set, settings, Stack, Switch, Text } from 'orca'
import { LANGUAGES, type Language, type MessageKey } from '../i18n/catalog'
import { PROJECT_FILES, type ProjectFile } from '../protocol'
import {
  INTERVAL_MINUTES,
  isQueueCheckInterval,
  readSettings,
  SETTING_KEYS,
  type PluginSettings,
  type SettingName,
} from '../settings'
import { language, t } from './language'
import { route, type Route } from './navigation'
import { connectedProjects, currentProject } from './queue'
import { errorMessage, resource } from './request'
import { ScreenFrame } from './screens'
import { LoadingRows, RequestError } from './states'

/** The settings as Orca keeps them: read when the panel opens, read again when one of them changes. */
export const pluginSettings = resource(() => readSettings(settings))

/** Reads the settings again after a change; if that read fails, the screen keeps what it shows. */
export async function refreshSettings(): Promise<void> {
  let saved: PluginSettings
  try {
    saved = await readSettings(settings)
  } catch {
    return
  }
  pluginSettings.resolve(saved)
}

/** What the screen says above the settings: a save, a failed save, a file that did not open. */
type Notice =
  | { kind: 'saved'; line: MessageKey }
  | { kind: 'saveError'; error: string }
  | { kind: 'openError'; file: ProjectFile; error: string | null }

/**
 * One visit of the screen: its notice, an interval typed that is not valid (not saved), and the generation of its
 * controls — a failed save draws them anew from the saved values. A new visit (any move to another screen and back)
 * starts with none of these.
 */
type Visit = { route: Route; notice: Notice | null; intervalDraft: string | null; generation: number }

const visit = atom<Visit | null>(null)

function currentVisit(): Visit {
  const here = read(route)
  const kept = read(visit)
  return kept !== null && kept.route === here ? kept : { route: here, notice: null, intervalDraft: null, generation: 0 }
}

/** Changes the visit `at` began; nothing once the person has left it. */
function changeVisit(at: Route, change: Partial<Omit<Visit, 'route'>>): void {
  if (read(route) !== at) return
  set(visit, { ...currentVisit(), ...change })
}

/** The saved line after `name` changed: after a switch, what the switches now mean (frames «Настройки — сохранено…»). */
function savedLine(name: SettingName, saved: PluginSettings): MessageKey {
  if (name !== 'mergeNotifications' && name !== 'coordinator') return 'settings.saved'
  if (!saved.mergeNotifications && !saved.coordinator) return 'settings.savedBothOff'
  if (!saved.mergeNotifications) return 'settings.savedNotificationsOff'
  if (!saved.coordinator) return 'settings.savedCoordinatorOff'
  return 'settings.saved'
}

// Writes go one after another, so the screen shows them in the order the person made them.
let writing: Promise<void> = Promise.resolve()

function save<N extends SettingName>(name: N, value: PluginSettings[N]): Promise<void> {
  const at = read(route)
  const run = writing.then(() => write(at, name, value))
  writing = run.catch(() => {})
  return run
}

async function write<N extends SettingName>(at: Route, name: N, value: PluginSettings[N]): Promise<void> {
  try {
    await settings.set(SETTING_KEYS[name], value)
  } catch (error) {
    changeVisit(at, {
      notice: { kind: 'saveError', error: errorMessage(error) },
      intervalDraft: null,
      generation: currentVisit().generation + 1,
    })
    return
  }
  const state = read(pluginSettings.state)
  if (state.status !== 'ready') {
    await refreshSettings()
    return
  }
  const saved: PluginSettings = { ...state.data, [name]: value }
  pluginSettings.resolve(saved)
  if (name === 'language') set(language, saved.language)
  changeVisit(at, { notice: { kind: 'saved', line: savedLine(name, saved) } })
}

/**
 * A whole number of minutes in INTERVAL_MINUTES is saved at once, each one the person types (an earlier one may still
 * be on its way, so even the value on the screen is written again); anything else stays in the field with its error.
 */
function changeInterval(text: string): void {
  const typed = text.trim()
  const minutes = /^\d+$/.test(typed) ? Number(typed) : Number.NaN
  if (!isQueueCheckInterval(minutes)) {
    changeVisit(read(route), { intervalDraft: text })
    return
  }
  changeVisit(read(route), { intervalDraft: null })
  void save('queueCheckInterval', minutes)
}

const LANGUAGE_LABELS: { readonly [L in Language]: MessageKey } = {
  en: 'settings.languageEnglish',
  ru: 'settings.languageRussian',
}

const FILE_LABELS: { readonly [F in ProjectFile]: MessageKey } = {
  '.agent-queue.json': 'settings.configFile',
  '.agent-queue.md': 'settings.rulesFile',
}

async function openFile(projectId: string, file: ProjectFile): Promise<void> {
  const at = read(route)
  let error: string | null
  try {
    const answer = await plugin.request('project.openFile', { projectId, file })
    if (answer.opened) {
      if (currentVisit().notice?.kind === 'openError') changeVisit(at, { notice: null })
      return
    }
    error = null
  } catch (refused) {
    error = errorMessage(refused)
  }
  changeVisit(at, { notice: { kind: 'openError', file, error } })
}

export function SettingsScreen() {
  const state = read(pluginSettings.state)
  return (
    <ScreenFrame screen="settings">
      {state.status === 'loading' ? <LoadingRows label={t('state.loading')} /> : null}
      {state.status === 'error' ? (
        <RequestError message={t('settings.readError', { error: state.message })} onRetry={pluginSettings.load} />
      ) : null}
      {state.status === 'ready' ? <SettingsForm saved={state.data} /> : null}
    </ScreenFrame>
  )
}

function SettingsForm(props: { saved: PluginSettings }) {
  const { saved } = props
  const here = currentVisit()
  const shown = read(language) ?? saved.language
  return (
    <Stack key={String(here.generation)} gap="md">
      <NoticeLine notice={here.notice} />
      <Select
        label={t('settings.language')}
        options={LANGUAGES.map((option) => ({ value: option, label: t(LANGUAGE_LABELS[option]) }))}
        value={shown}
        onChange={(value) => {
          const chosen = LANGUAGES.find((option) => option === value)
          if (chosen) void save('language', chosen)
        }}
      />
      <Stack gap="xs">
        <Input
          label={t('settings.interval')}
          value={here.intervalDraft ?? String(saved.queueCheckInterval)}
          invalid={here.intervalDraft !== null}
          onChange={changeInterval}
        />
        {here.intervalDraft !== null ? (
          <Text tone="danger" size="sm">
            {t('settings.intervalInvalid', INTERVAL_MINUTES)}
          </Text>
        ) : null}
      </Stack>
      <Switch
        label={t('settings.mergeNotifications')}
        checked={saved.mergeNotifications}
        onChange={(checked) => void save('mergeNotifications', checked)}
      />
      <Switch
        label={t('settings.coordinator')}
        checked={saved.coordinator}
        onChange={(checked) => void save('coordinator', checked)}
      />
      <ProjectSettings />
    </Stack>
  )
}

function NoticeLine(props: { notice: Notice | null }) {
  const { notice } = props
  if (notice === null) return null
  if (notice.kind === 'saved') {
    return (
      <Callout tone="success">
        <Text>{t(notice.line)}</Text>
      </Callout>
    )
  }
  const text =
    notice.kind === 'saveError'
      ? t('settings.saveError', { error: notice.error })
      : t('settings.openError', { file: t(FILE_LABELS[notice.file]), error: notice.error ?? t('settings.noCheckout') })
  return (
    <Callout tone="danger">
      <Text>{text}</Text>
    </Callout>
  )
}

/** «Настройки проекта»: the files of the project selected on «Очередь»; with no connected project, nothing to open. */
function ProjectSettings() {
  const state = read(connectedProjects.state)
  const project = state.status === 'ready' ? currentProject(state.data) : null
  return (
    <Stack gap="sm">
      <Text weight="semibold">{t('settings.project')}</Text>
      <Row wrap gap="sm">
        {PROJECT_FILES.map((file) => (
          <Button
            key={file}
            variant="outline"
            icon="open-external"
            tooltip={t('settings.openFile')}
            disabled={project === null}
            onPress={() => {
              if (project) void openFile(project.id, file)
            }}
          >
            {t(FILE_LABELS[file])}
          </Button>
        ))}
      </Row>
      {state.status === 'ready' && project === null ? (
        <Text muted size="sm">
          {t('settings.noProjects')}
        </Text>
      ) : null}
    </Stack>
  )
}
