// The Russian catalog of the texts the plugin writes to GitHub, for a project whose language is `ru`: the same keys as
// ./en.ts, no more and no fewer (the type checks it).
import type { GithubTextKey } from './en'

export const ru: { readonly [K in GithubTextKey]: string } = {
  'pr.closes': 'Closes #{issue}',
  'mvp.standMissing': 'Добавьте стенд приёмки в настройки проекта',
}
