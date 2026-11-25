// Whether a release version is in a semver range, as npm's semver reads it, without a package: comparators (<, <=, >,
// >=, =), caret (^), tilde (~), x-ranges (1.4.x, 1.4, *), hyphen ranges (1.2.3 - 1.4.0), sets of comparators joined by
// blanks and alternatives joined by ||. Prerelease versions and anything else it cannot read throw, so a test never
// passes on a range it did not understand.
export function satisfies(version, range) {
  const v = parseVersion(version)
  return range.split('||').some((set) => comparatorSet(set).every(([op, bound]) => compareWith(op, v, bound)))
}

function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim())
  if (!match) throw new Error(`not a release version: ${text}`)
  return match.slice(1, 4).map(Number)
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}

function compareWith(op, version, bound) {
  const c = compare(version, bound)
  switch (op) {
    case '>=': return c >= 0
    case '>': return c > 0
    case '<=': return c <= 0
    case '<': return c < 0
    case '=': return c === 0
  }
  throw new Error(`unknown operator ${op}`)
}

// A partial version: [major, minor, patch] with null for each missing or wildcard part (and every part after it).
const PARTIAL = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/

function parsePartial(text) {
  const match = PARTIAL.exec(text)
  if (!match) throw new Error(`cannot read the version ${JSON.stringify(text)} of a range`)
  const parts = []
  for (const part of match.slice(1, 4)) {
    if (part === undefined || /^[xX*]$/.test(part) || parts.includes(null)) parts.push(null)
    else parts.push(Number(part))
  }
  return parts
}

// The comparators of one set: [operator, full version] pairs that must all hold.
function comparatorSet(text) {
  const set = text.trim()
  if (set === '' || set === '*') return []
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(set)
  if (hyphen) return [...xRange('>=', parsePartial(hyphen[1])), ...xRange('<=', parsePartial(hyphen[2]))]
  return set
    .replace(/(<=|>=|<|>|=|\^|~>?)\s+/g, '$1')
    .split(/\s+/)
    .flatMap((token) => {
      const match = /^(<=|>=|<|>|=|\^|~>?)?(.*)$/.exec(token)
      const [, op = '', rest] = match
      const parts = parsePartial(rest)
      if (op === '^') return caret(parts)
      if (op.startsWith('~')) return tilde(parts)
      return xRange(op || '=', parts)
    })
}

function lowest(parts) {
  return parts.map((part) => part ?? 0)
}

// The first version after every version the known parts match: 1.4 → 1.5.0, 1 → 2.0.0.
function pastEnd(parts) {
  const known = parts.filter((part) => part !== null)
  if (known.length === 0) throw new Error('a wildcard has no end')
  const next = [...known.slice(0, -1), known[known.length - 1] + 1]
  while (next.length < 3) next.push(0)
  return next
}

function xRange(op, parts) {
  const full = !parts.includes(null)
  if (parts[0] === null) return op === '<' || op === '>' ? [['<', [0, 0, 0]]] : []
  if (full) return [[op, parts]]
  switch (op) {
    case '=': return [['>=', lowest(parts)], ['<', pastEnd(parts)]]
    case '>=': return [['>=', lowest(parts)]]
    case '>': return [['>=', pastEnd(parts)]]
    case '<': return [['<', lowest(parts)]]
    case '<=': return [['<', pastEnd(parts)]]
  }
  throw new Error(`unknown operator ${op}`)
}

function caret(parts) {
  if (parts[0] === null) return []
  const [major, minor, patch] = parts
  const from = lowest(parts)
  if (major > 0 || minor === null) return [['>=', from], ['<', [major + 1, 0, 0]]]
  if (minor > 0 || patch === null) return [['>=', from], ['<', [0, minor + 1, 0]]]
  return [['>=', from], ['<', [0, 0, patch + 1]]]
}

function tilde(parts) {
  if (parts[0] === null) return []
  const [major, minor] = parts
  const from = lowest(parts)
  return minor === null ? [['>=', from], ['<', [major + 1, 0, 0]]] : [['>=', from], ['<', [major, minor + 1, 0]]]
}
