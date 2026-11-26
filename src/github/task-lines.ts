// The lines of a task's text the plugin reads (TZ «Данные», «Задача очереди»): «Зависит от #N» / «Depends on #N» — the
// task waits until those issues are done; «MVP: #E» — a task of the MVP whose issue is #E; «Часть #N» — a part of the
// split task #N.
//
// What counts as such a line (README «Строки задачи»):
// - a whole line of the text, blanks around it ignored; lines in fenced code blocks (``` or ~~~), in quotes (>) and
//   inside HTML comments do not count — they are not lines of the task as GitHub shows it;
// - it starts with the words, in any case: «Зависит от» or «Depends on», then an optional colon and the first number
//   with #; «MVP» and a colon, then the number with #; «Часть», then an optional colon and the number with #;
// - the rest of the line is only numbers with #: for dependencies one or more, divided by commas, blanks, «и» or «and»;
//   for «MVP:» and «Часть» exactly one; a full stop at the end is allowed;
// - a line that starts like this but has anything else (a number without #, a word after the numbers) is not read: it
//   is reported in `problems`, never silently taken for less. So is a second «MVP:» or «Часть» line with another
//   number.
// Dependencies of several lines are joined in the order of the text, each number once.

export type TaskLines = {
  readonly dependsOn: readonly number[]
  readonly mvp: number | null
  readonly partOf: number | null
  // Lines that start like a task line but are not one, and conflicting lines.
  readonly problems: readonly string[]
}

const NUMBER = '#([1-9][0-9]{0,8})'
const DEPENDS = /^(?:зависит\s+от|depends\s+on)(?=[\s:#]|$)\s*:?\s*/iu
const MVP = /^mvp\s*:\s*(?=#)/iu
const PART = /^часть(?=[\s:#])\s*:?\s*(?=#)/iu
const NUMBER_LIST = new RegExp(`^${NUMBER}(?:(?:\\s*,\\s*|\\s+(?:и|and)\\s+|\\s+)${NUMBER})*\\s*\\.?$`, 'iu')
const ONE_NUMBER = new RegExp(`^${NUMBER}\\s*\\.?$`, 'u')

export function parseTaskLines(body: string): TaskLines {
  const dependsOn: number[] = []
  let mvp: number | null = null
  let partOf: number | null = null
  const problems: string[] = []
  for (const { line, number } of visibleLines(body)) {
    const depends = DEPENDS.exec(line)
    if (depends) {
      const rest = line.slice(depends[0].length)
      if (!rest.startsWith('#') || !NUMBER_LIST.test(rest)) {
        problems.push(`line ${number}: a dependency line needs only issue numbers with # («Зависит от #5, #7»)`)
        continue
      }
      for (const found of rest.matchAll(/#([1-9][0-9]{0,8})/g)) {
        const value = Number(found[1])
        if (!dependsOn.includes(value)) dependsOn.push(value)
      }
      continue
    }
    for (const [pattern, name] of [
      [MVP, 'MVP'],
      [PART, 'Часть'],
    ] as const) {
      const start = pattern.exec(line)
      if (!start) continue
      const one = ONE_NUMBER.exec(line.slice(start[0].length))
      if (!one) {
        problems.push(`line ${number}: a «${name}» line needs exactly one issue number with # («${name}${name === 'MVP' ? ':' : ''} #12»)`)
        break
      }
      const value = Number(one[1])
      const known: number | null = name === 'MVP' ? mvp : partOf
      if (known !== null && known !== value) {
        problems.push(`line ${number}: a second «${name}» line names #${value}, the first named #${known}`)
      } else if (name === 'MVP') mvp = value
      else partOf = value
      break
    }
  }
  return { dependsOn, mvp, partOf, problems }
}

// The lines of the text as GitHub shows them as text: trimmed, with their number (from 1); without fenced code blocks,
// quotes and HTML comments.
function visibleLines(body: string): { line: string; number: number }[] {
  const lines = body.split(/\r?\n/)
  const visible: { line: string; number: number }[] = []
  let fence: string | null = null
  let comment = false
  lines.forEach((raw, index) => {
    const line = raw.trim()
    if (fence !== null) {
      // A fence closes with the same character, at least as many of them, and nothing else on the line.
      const char = fence[0] === '`' ? '`' : '~'
      if (new RegExp(`^ {0,3}${char}{${fence.length},}\\s*$`).test(raw)) fence = null
      return
    }
    if (comment) {
      if (line.includes('-->')) comment = false
      return
    }
    const opens = /^ {0,3}(`{3,}|~{3,})/.exec(raw)
    if (opens) {
      fence = opens[1] ?? null
      return
    }
    const htmlStart = line.indexOf('<!--')
    if (htmlStart !== -1 && !line.includes('-->', htmlStart + 4)) {
      comment = true
      return
    }
    if (line.startsWith('>')) return
    visible.push({ line: line.replace(/<!--[\s\S]*?-->/g, '').trim(), number: index + 1 })
  })
  return visible
}
