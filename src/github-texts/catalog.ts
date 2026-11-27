// The texts the plugin writes to GitHub — progress, block and final comments, PR bodies, the texts of the «MVP» issue —
// in the project's language (Ф15): `language` of the project's settings (.agent-queue.json, src/project/settings.ts),
// `ru` or `en`. Not the panel's language: that is a plugin setting of each computer with catalogs of its own
// (src/i18n/), while what goes to GitHub is the same for every computer of the project. Every text the plugin writes
// to GitHub comes from here, and every key has a text in both catalogs: the type of ./ru.ts demands it, and a test
// checks it.
import type { GitHubText, Segment } from '../github/check'
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

/**
 * The text of `key` in the project's language as segments for the check before writing (src/github/check.ts): each
 * `{name}` becomes `segments[name]` — a coordinator field (`field.coordinator(id)`, `field.claim(n)` …) keeps its own
 * rule and is never masked, a plain string goes through the mask with the rest. A `{name}` without a segment stays as
 * it is.
 */
export function githubSegments(
  language: GithubLanguage,
  key: GithubTextKey,
  segments: Readonly<Record<string, Segment>> = {},
): GitHubText {
  const template = githubCatalogs[language][key]
  const out: Segment[] = []
  let at = 0
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    const name = match[1] ?? ''
    if (!Object.hasOwn(segments, name)) continue
    const start = match.index ?? 0
    if (start > at) out.push(template.slice(at, start))
    out.push(segments[name] as Segment)
    at = start + match[0].length
  }
  if (at < template.length) out.push(template.slice(at))
  return out
}
