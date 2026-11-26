// Markdown for the texts the plugin writes for people and agents: a code span and a fenced block that hold any text as
// it is, whatever backticks it has.

// `text` as a Markdown code span: fenced by more backticks than any run of them inside, padded when it starts or ends
// with one.
export function inlineCode(text: string): string {
  const fence = '`'.repeat(longestBacktickRun(text) + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

// `text` as a fenced code block with the info string `info`: the fence is longer than any run of backticks in the text
// (three at least), so no line of the text closes it, and the text inside stays exactly as it is.
export function fencedBlock(text: string, info = 'text'): string {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1))
  const body = text.endsWith('\n') ? text : `${text}\n`
  return `${fence}${info}\n${body}${fence}`
}

function longestBacktickRun(text: string): number {
  let longest = 0
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length)
  return longest
}
