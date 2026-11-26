// What the panel tests read from a drawn tree (TestPanel.tree()): every word it shows or names, the words that are not
// from the string catalog of a language, and where an element gets a width in pixels.
import type { TreeSnapshot } from 'orca/testing'
import { catalogs, type Language } from '../i18n/catalog'

/** Every word a drawn tree shows or names: text, and the label, title, description, placeholder, tooltip and options. */
export function textsIn(tree: TreeSnapshot | string | null): string[] {
  if (tree === null) return []
  if (typeof tree === 'string') return [tree]
  const props = tree.props ?? {}
  const named = ['label', 'title', 'description', 'placeholder', 'tooltip']
    .map((name) => props[name])
    .filter((value): value is string => typeof value === 'string')
  const options = Array.isArray(props.options) ? (props.options as { label: string }[]).map((option) => option.label) : []
  return [...named, ...options, ...(tree.children ?? []).flatMap(textsIn)]
}

/**
 * The words of `texts` that are neither a text of `language`'s catalog (a `{name}` part is a value the screen puts in)
 * nor one of `data` (the names of projects, an error a test made up).
 */
export function textsNotFromCatalog(texts: readonly string[], language: Language, data: readonly string[]): string[] {
  const templates = Object.values(catalogs[language]).map((template) => {
    const pattern = template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{\w+\}/g, '.+')
    return new RegExp(`^${pattern}$`, 's')
  })
  return texts.filter((text) => !data.includes(text) && !templates.some((template) => template.test(text)))
}

/** Where a drawn tree gives an element a width in pixels: `width` or `minWidth` as a number. */
export function pixelWidths(tree: TreeSnapshot | string | null, path = ''): string[] {
  if (tree === null || typeof tree === 'string') return []
  const here = `${path}/${tree.type}`
  const props = tree.props ?? {}
  const found = ['width', 'minWidth']
    .filter((name) => typeof props[name] === 'number')
    .map((name) => `${here} ${name}=${String(props[name])}`)
  return [...found, ...(tree.children ?? []).flatMap((child, index) => pixelWidths(child, `${here}[${index}]`))]
}
