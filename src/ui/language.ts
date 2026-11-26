// The panel's interface language: read from the plugin setting, kept current when it changes (Orca's Settings or the
// screen «Настройки»), and `t()`, the only way a screen gets its texts.
import { atom, read, set, settings } from 'orca'
import { format, LANGUAGE_SETTING, parseLanguage, type Language, type MessageKey, type MessageParams } from '../i18n/catalog'

/** null until the setting is read: the panel then shows only loading rows, so it never flashes the other language. */
export const language = atom<Language | null>(null)

let reads = 0

/** Reads the setting; a failed read leaves the default language. The answer of the latest read wins. */
export async function loadLanguage(): Promise<void> {
  const mine = ++reads
  let value: unknown
  try {
    value = await settings.get(LANGUAGE_SETTING)
  } catch {
    value = undefined
  }
  if (mine === reads) set(language, parseLanguage(value))
}

/** The text of `key` in the panel's language. Read while rendering, it re-renders the panel when the language changes. */
export function t(key: MessageKey, params?: MessageParams): string {
  return format(read(language) ?? parseLanguage(undefined), key, params)
}
