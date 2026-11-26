// Values put into a catalog text: each `{name}` in the text becomes `params[name]`, and a `{name}` without a value stays
// as it is. The panel's string catalogs (src/i18n/) and the catalogs of the texts the plugin writes to GitHub
// (src/github-texts/) fill their texts the same way.
export type TextParams = Readonly<Record<string, string | number>>

export function fillParams(text: string, params: TextParams = {}): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : whole))
}

// The names of the `{name}` places of a text, in order of their first appearance.
export function paramNames(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? ''))]
}
