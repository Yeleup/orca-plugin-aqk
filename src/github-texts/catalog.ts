// The texts the plugin writes to GitHub — progress, block and final comments, PR bodies, the texts of the «MVP» issue —
// in the project's language (Ф15): `language` of the project's settings (.agent-queue.json, src/project/settings.ts),
// `ru` or `en`. Not the panel's language: that is a plugin setting of each computer with catalogs of its own
// (src/i18n/), while what goes to GitHub is the same for every computer of the project. Every text the plugin writes
// to GitHub comes from here, and every key has a text in both catalogs: the type of ./ru.ts demands it, and a test
// checks it.
import { fillParams, type TextParams } from '../text-params'
import { en, type GithubTextKey } from './en'
import { ru } from './ru'

export type { GithubTextKey } from './en'

export const GITHUB_LANGUAGES = ['ru', 'en'] as const
export type GithubLanguage = (typeof GITHUB_LANGUAGES)[number]

export type GithubCatalog = { readonly [K in GithubTextKey]: string }
export const githubCatalogs: { readonly [L in GithubLanguage]: GithubCatalog } = { ru, en }

export function isGithubLanguage(value: unknown): value is GithubLanguage {
  return GITHUB_LANGUAGES.some((language) => language === value)
}

/** The text of `key` in the project's language, with each `{name}` replaced by `params[name]`. */
export function githubText(language: GithubLanguage, key: GithubTextKey, params: TextParams = {}): string {
  return fillParams(githubCatalogs[language][key], params)
}
