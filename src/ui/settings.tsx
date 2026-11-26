// «Настройки» (ТЗ «Экраны»): the plugin's settings on this computer (src/settings.ts) — the interface language, the
// queue check interval, merge notifications and the coordinator of this computer — and «Настройки проекта», which opens
// the selected project's .agent-queue.json and .agent-queue.md in Orca's editor (through the worker). A change is saved
// at once: each control shows the person's latest change while its write is on its way; when that write ends, the
// control shows the saved value, or after a refusal the previous one again — never one a failed write did not save.
// A new change takes away the line above the settings; «Сохранено» (with what the switches now mean, where the frames
// say so) comes only once nothing the screen shows is still on its way, «Не удалось сохранить: <ошибка>» at once.
import { atom, Button, Callout, Input, plugin, read, Row, Select, set, settings, Stack, Switch, Text } from 'orca'
import { LANGUAGES, type Language, type MessageKey } from '../i18n/catalog'
import { PROJECT_FILES, type Project, type ProjectFile } from '../protocol'
import {
  isQueueCheckInterval,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
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

/** The latest change of each setting whose write has not ended, by the number of the change (`edit`). */
type Pending = { readonly [N in SettingName]?: { readonly edit: number; readonly value: PluginSettings[N] } }

/**
 * One visit of the screen: its notice, the changes on their way and the interval's field as typed — shown until the
 * write of that very text ends, and kept while it is not a valid interval (then nothing is written). A new visit (any
 * move to another screen and back) starts with none of these.
 */
type Visit = {
  route: Route
  notice: Notice | null
  pending: Pending
  field: { readonly text: string; readonly edit: number } | null
}

const visit = atom<Visit | null>(null)

// Numbers the person's changes, so that only the end of the latest one decides what the screen shows.
let edits = 0

function currentVisit(): Visit {
  const here = read(route)
  const kept = read(visit)
  return kept !== null && kept.route === here ? kept : { route: here, notice: null, pending: {}, field: null }
}

/** Changes the visit `at` began; nothing once the person has left it. */
function changeVisit(at: Route, change: Partial<Omit<Visit, 'route'>>): void {
  if (read(route) !== at) return
  set(visit, { ...currentVisit(), ...change })
}

/**
 * The saved line after `name` changed. After a switch, and after a change to Русский, it says what the switches now
 * mean (the frames «Настройки — сохранено — …» and the «Русский» transitions of the English frames); after a change to
 * English (the English frames) and after the interval — «Сохранено.».
 */
function savedLine(name: SettingName, saved: PluginSettings): MessageKey {
  const switched = name === 'mergeNotifications' || name === 'coordinator'
  if (!switched && !(name === 'language' && saved.language === 'ru')) return 'settings.saved'
  if (!saved.mergeNotifications && !saved.coordinator) return 'settings.savedBothOff'
  if (!saved.mergeNotifications) return 'settings.savedNotificationsOff'
  if (!saved.coordinator) return 'settings.savedCoordinatorOff'
  return 'settings.saved'
}

// Writes go one after another, in the order the person made the changes.
let writing: Promise<void> = Promise.resolve()

/**
 * Saves the change number `edit` of `name`; the control shows `value` until this write, or a later change, ends. The
 * change takes away the line above the settings: it spoke of earlier changes.
 */
function save<N extends SettingName>(name: N, value: PluginSettings[N], edit = ++edits): Promise<void> {
  const at = read(route)
  changeVisit(at, { notice: null, pending: { ...currentVisit().pending, [name]: { edit, value } } })
  const run = writing.then(() => write(at, name, value, edit))
  writing = run.catch(() => {})
  return run
}

async function write<N extends SettingName>(at: Route, name: N, value: PluginSettings[N], edit: number): Promise<void> {
  try {
    await settings.set(SETTING_KEYS[name], value)
  } catch (error) {
    settle(at, name, edit, { kind: 'saveError', error: errorMessage(error) })
    return
  }
  const state = read(pluginSettings.state)
  if (state.status !== 'ready') await refreshSettings()
  const now = read(pluginSettings.state)
  const saved: PluginSettings | null = now.status === 'ready' ? { ...now.data, [name]: value } : null
  if (saved !== null) pluginSettings.resolve(saved)
  if (name === 'language') set(language, value as Language)
  settle(at, name, edit, { kind: 'saved', line: saved === null ? 'settings.saved' : savedLine(name, saved) })
}

/**
 * The write of change `edit` of `name` ended with `notice`. A later change of `name` on its way has the last word: this
 * end changes neither the control nor the line. Otherwise the control shows what Orca keeps now — the new value after
 * a save, the previous one after a refusal — and the line says so: a refusal at once; «Сохранено» only once no other
 * write is on its way, and never over a refusal of this round of changes. The interval's field lets go of its text
 * only if this change typed it.
 */
function settle(at: Route, name: SettingName, edit: number, notice: Notice): void {
  if (read(route) !== at) return
  const here = currentVisit()
  if (here.pending[name]?.edit !== edit) return
  const pending: Record<string, unknown> = { ...here.pending }
  delete pending[name]
  const field = here.field?.edit === edit ? null : here.field
  const settled = Object.keys(pending).length === 0
  const shown =
    notice.kind !== 'saved' ? notice : settled && here.notice?.kind !== 'saveError' ? notice : here.notice
  set(visit, { ...here, notice: shown, pending: pending as Pending, field })
}

/** The minutes a text of the field names: digits only, read as a number. */
function minutesOf(text: string): number {
  const typed = text.trim()
  return /^\d+$/.test(typed) ? Number(typed) : Number.NaN
}

/** The interval a text of the field names, or null when it is not one (isQueueCheckInterval). */
function intervalOf(text: string): number | null {
  const minutes = minutesOf(text)
  return isQueueCheckInterval(minutes) ? minutes : null
}

/**
 * The field keeps the text as typed. A valid interval is saved at once, each one the person types (typing «30» saves
 * 3, then 30); anything else stays in the field with its error and is not written. Either way the line above the
 * settings goes: it spoke of earlier changes.
 */
function changeInterval(text: string): void {
  const edit = ++edits
  changeVisit(read(route), { notice: null, field: { text, edit } })
  const minutes = intervalOf(text)
  if (minutes !== null) void save('queueCheckInterval', minutes, edit)
}

const LANGUAGE_LABELS: { readonly [L in Language]: MessageKey } = {
  en: 'settings.languageEnglish',
  ru: 'settings.languageRussian',
}

const FILE_LABELS: { readonly [F in ProjectFile]: MessageKey } = {
  '.agent-queue.json': 'settings.configFile',
  '.agent-queue.md': 'settings.rulesFile',
}

async function openFile(project: Project, file: ProjectFile): Promise<void> {
  const at = read(route)
  let error: string | null
  try {
    const answer = await plugin.request('project.openFile', { projectId: project.id, hostId: project.hostId, file })
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
  const { pending, field } = here
  const interval = field?.text ?? String(pending.queueCheckInterval?.value ?? saved.queueCheckInterval)
  const intervalInvalid = field !== null && intervalOf(field.text) === null
  const tooLarge = field !== null && minutesOf(field.text) > MAX_INTERVAL_MINUTES
  return (
    <Stack gap="md">
      <NoticeLine notice={here.notice} />
      <Select
        label={t('settings.language')}
        options={LANGUAGES.map((option) => ({ value: option, label: t(LANGUAGE_LABELS[option]) }))}
        value={pending.language?.value ?? read(language) ?? saved.language}
        onChange={(value) => {
          const chosen = LANGUAGES.find((option) => option === value)
          if (chosen) void save('language', chosen)
        }}
      />
      <Stack gap="xs">
        <Input label={t('settings.interval')} value={interval} invalid={intervalInvalid} onChange={changeInterval} />
        {intervalInvalid ? (
          <Text tone="danger" size="sm">
            {tooLarge
              ? t('settings.intervalTooLarge', { max: MAX_INTERVAL_MINUTES })
              : t('settings.intervalInvalid', { min: MIN_INTERVAL_MINUTES })}
          </Text>
        ) : null}
      </Stack>
      <Switch
        label={t('settings.mergeNotifications')}
        checked={pending.mergeNotifications?.value ?? saved.mergeNotifications}
        onChange={(checked) => void save('mergeNotifications', checked)}
      />
      <Switch
        label={t('settings.coordinator')}
        checked={pending.coordinator?.value ?? saved.coordinator}
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
              if (project) void openFile(project, file)
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
