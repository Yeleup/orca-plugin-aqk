// Interface languages of the plugin and their string catalogs (Ф15): English and Russian, English by default.
// The language is the plugin setting LANGUAGE_SETTING (orca-plugin.json, contributes.settings).
import { en, type MessageKey } from './en'
import { ru } from './ru'

export type { MessageKey } from './en'

export const LANGUAGES = ['en', 'ru'] as const
export type Language = (typeof LANGUAGES)[number]
export const DEFAULT_LANGUAGE: Language = 'en'

/** The key of the plugin setting «язык интерфейса» in orca-plugin.json. */
export const LANGUAGE_SETTING = 'interfaceLanguage'

export type Catalog = { readonly [K in MessageKey]: string }
export const catalogs: { readonly [L in Language]: Catalog } = { en, ru }

/** The language a stored setting value names; anything else (not set, unknown) is the default, English. */
export function parseLanguage(value: unknown): Language {
  return LANGUAGES.find((language) => language === value) ?? DEFAULT_LANGUAGE
}

export type MessageParams = Readonly<Record<string, string | number>>

/** The text of `key` in `language`, with each `{name}` replaced by `params[name]`. */
export function format(language: Language, key: MessageKey, params: MessageParams = {}): string {
  return catalogs[language][key].replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  )
}
