// The plugin's settings on this computer (ТЗ «Данные», «Настройки плагина в Orca»): plugin settings Orca keeps for the
// plugin, declared in orca-plugin.json (contributes.settings) with their defaults. The owner changes them on the screen
// «Настройки» (src/ui/settings.tsx), and Orca's Settings shows them under the plugin too. The panel and the worker read
// them the same way, through readSettings(): a value that is not set, or not valid, reads as its default.
import type { SettingsApi } from 'orca'
import { DEFAULT_LANGUAGE, LANGUAGE_SETTING, parseLanguage, type Language } from './i18n/catalog'

/** The key of each setting in orca-plugin.json (contributes.settings). */
export const SETTING_KEYS = {
  language: LANGUAGE_SETTING,
  queueCheckInterval: 'queueCheckInterval',
  mergeNotifications: 'mergeNotifications',
  coordinator: 'coordinatorEnabled',
} as const

export type SettingName = keyof typeof SETTING_KEYS

export type PluginSettings = {
  /** The panel's interface language. */
  readonly language: Language
  /** Minutes between two checks of the queue by the coordinator of this computer. */
  readonly queueCheckInterval: number
  /** Whether a merged task is announced by a notification; blocked tasks always are. */
  readonly mergeNotifications: boolean
  /** Whether the coordinator of this computer takes and runs tasks; when off, the panel only shows the queue. */
  readonly coordinator: boolean
}

/**
 * The queue check interval: a whole number of minutes in this range (orca-plugin.json: integer, minimum, maximum). The
 * top is no product limit, only the largest whole number a JSON number holds exactly.
 */
export const MIN_INTERVAL_MINUTES = 1
export const MAX_INTERVAL_MINUTES = Number.MAX_SAFE_INTEGER

export const DEFAULT_SETTINGS: PluginSettings = {
  language: DEFAULT_LANGUAGE,
  queueCheckInterval: 5,
  mergeNotifications: true,
  coordinator: true,
}

/** The one check of an interval — the screen's, reading the settings', and Orca's own for the declared setting (a
 *  whole number from minimum to maximum). */
export function isQueueCheckInterval(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_INTERVAL_MINUTES &&
    value <= MAX_INTERVAL_MINUTES
  )
}

/** Whether `key` (of a settings change) is one of these settings. */
export function isSettingKey(key: string): boolean {
  return Object.values(SETTING_KEYS).some((known) => known === key)
}

/** The settings in `stored` (what Orca answers for the plugin's settings), each missing or invalid one as its default. */
export function parseSettings(stored: Readonly<Record<string, unknown>>): PluginSettings {
  const interval = stored[SETTING_KEYS.queueCheckInterval]
  const notifications = stored[SETTING_KEYS.mergeNotifications]
  const coordinator = stored[SETTING_KEYS.coordinator]
  return {
    language: parseLanguage(stored[SETTING_KEYS.language]),
    queueCheckInterval: isQueueCheckInterval(interval) ? interval : DEFAULT_SETTINGS.queueCheckInterval,
    mergeNotifications: typeof notifications === 'boolean' ? notifications : DEFAULT_SETTINGS.mergeNotifications,
    coordinator: typeof coordinator === 'boolean' ? coordinator : DEFAULT_SETTINGS.coordinator,
  }
}

/** Reads the settings now: the panel with `settings` from 'orca', the worker with `orca.settings`. */
export async function readSettings(api: Pick<SettingsApi, 'get'>): Promise<PluginSettings> {
  const stored = await api.get()
  return parseSettings(stored && typeof stored === 'object' ? stored : {})
}
