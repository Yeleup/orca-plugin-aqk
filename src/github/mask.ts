// The plugin's mask (TZ «Данные», «Проверка перед каждой записью в GitHub»): before any text goes to GitHub, what looks
// like an e-mail address, a phone number, a key or token of a known format, or matches a forbidden-data pattern of the
// project's settings becomes «[скрыто]». The mask is the plugin's own check; the data rule of the project, which a
// plugin cannot check in free text, is kept by the agents by their tasks.
//
// Matches are found on the original text by every rule at once and merged, so a rule never sees another rule's
// «[скрыто]». A match of zero length hides nothing.

export const HIDDEN = '[скрыто]'

// The refusal of the check before a write: nothing is written. `message` names the field or pattern and why, without
// the refused value itself.
export class CheckError extends Error {
  readonly reason: CheckRefusal
  constructor(reason: CheckRefusal, message: string) {
    super(message)
    this.name = 'CheckError'
    this.reason = reason
  }
}

export type CheckRefusal =
  // A forbidden-data pattern of the settings is not a valid regular expression.
  | 'invalid_pattern'
  // A coordinator field does not have its fixed form.
  | 'bad_field'
  // A file path is not in the diff being checked (or there is no diff to check it against).
  | 'path_outside_diff'
  // Nothing to write (an empty body or title).
  | 'empty'
  // A value that cannot be hidden without changing what the write does (a PR's base branch) matches the mask.
  | 'masked_value'
  // The write would change an issue that is not the queue owner's (or a pull request through the issue call).
  | 'not_owner'

type Rule = { readonly name: string; readonly pattern: RegExp; readonly accept?: (found: string) => boolean }

// Tokens and keys of known formats. Lookarounds instead of \b, so a token inside a longer word is not taken for one.
const TOKEN_RULES: readonly Rule[] = [
  // GitHub: classic (ghp_, gho_, ghu_, ghs_, ghr_) and fine-grained personal access tokens.
  { name: 'token:github', pattern: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})(?![A-Za-z0-9_])/g },
  { name: 'token:gitlab', pattern: /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}/g },
  // Cloud: AWS access key ids, Google API keys and OAuth access tokens.
  { name: 'token:aws', pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}(?![A-Za-z0-9])/g },
  { name: 'token:google', pattern: /(?<![A-Za-z0-9_-])(?:AIza[0-9A-Za-z_-]{35}|ya29\.[0-9A-Za-z_-]{20,})/g },
  // Chats: Slack tokens and webhooks, Telegram bot tokens, Discord webhooks.
  { name: 'token:slack', pattern: /(?<![A-Za-z0-9_-])xox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: 'token:slack', pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g },
  { name: 'token:telegram', pattern: /(?<![A-Za-z0-9_])\d{8,10}:AA[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])/g },
  { name: 'token:discord', pattern: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g },
  // AI providers: OpenAI and Anthropic keys (sk-…, sk-proj-…, sk-ant-…), Hugging Face tokens.
  { name: 'token:ai', pattern: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g },
  { name: 'token:ai', pattern: /(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{30,}(?![A-Za-z0-9_])/g },
  // Payments and packages: Stripe secret and restricted keys, npm tokens, SendGrid keys.
  { name: 'token:stripe', pattern: /(?<![A-Za-z0-9_])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { name: 'token:npm', pattern: /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9_])/g },
  { name: 'token:sendgrid', pattern: /(?<![A-Za-z0-9_])SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
  // JSON Web Tokens: header and payload are base64url JSON objects ("eyJ…").
  { name: 'token:jwt', pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}/g },
  // Private-key blocks (PEM, OpenSSH, PGP), to the END line or, when it is missing, to the end of the text.
  {
    name: 'private-key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
]

const EMAIL: Rule = {
  name: 'email',
  pattern: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu,
}

// Phone numbers: 10 to 15 digits (8 to 15 after a leading +), in groups divided by single blanks or hyphens, one group
// may be in parentheses — also as a part of a file path or branch name, after `/`, `\`, `_` or a word and a hyphen
// (`calls/tel-<number>.txt`). Digits that continue a word or a hex string, go on a hyphenated number (`…7-<digits>`: a
// date, the groups of a numeric id), follow GitHub's anchors (`issuecomment-…`, `pullrequestreview-…`, `event-…`) or an
// issue reference (#…), or start a time (…:mm) or a decimal (….5) are not a phone number, nor is a date (YYYY-MM-DD …).
// A run of such groups with more than 15 digits — several numbers in a row, or a card number — is hidden whole.
const PHONE: Rule = {
  name: 'phone',
  pattern:
    /(?<![\p{L}\p{N}+#])(?<!\p{N}-)(?<!(?:issuecomment|pullrequestreview|event)-)(?<!\d[.,])\+?(?:\(\d{1,5}\)|\d)(?:[ -]?(?:\(\d{1,5}\)|\d)){6,}(?![\p{L}\p{N}]|[.:]\d)/gu,
  accept: (found) => {
    if (/^\d{4}-\d{2}-\d{2}(?!\d)/.test(found)) return false
    const digits = found.replace(/\D/g, '').length
    if (digits > 15) return found.split(/[ ()-]+/).filter((group) => group !== '').length > 1
    return digits >= (found.startsWith('+') ? 8 : 10)
  },
}

const BUILT_IN: readonly Rule[] = [EMAIL, PHONE, ...TOKEN_RULES]

// The names of the built-in rules, for README and tests.
export const BUILT_IN_RULES: readonly string[] = [...new Set(BUILT_IN.map((rule) => rule.name))]

// A part of a text the mask hides: [start, end) and the rules that matched it.
export type MaskMatch = { readonly start: number; readonly end: number; readonly rules: readonly string[] }

export type Masked = {
  readonly text: string
  // How many parts became «[скрыто]».
  readonly hidden: number
  // Which rules hid something (`email`, `phone`, `token:…`, `private-key`, `pattern:<n>` — the n-th pattern of the
  // settings, from 1).
  readonly rules: readonly string[]
}

export type Mask = {
  find(text: string): MaskMatch[]
  matches(text: string): boolean
  apply(text: string): Masked
}

// The mask with the project's forbidden-data patterns (JavaScript regular expressions, flag `u`). A pattern that is not
// a valid regular expression is never skipped: CheckError `invalid_pattern`, nothing is written.
export function compileMask(forbiddenPatterns: readonly string[]): Mask {
  const own: Rule[] = forbiddenPatterns.map((source, index) => {
    if (typeof source !== 'string' || source === '') {
      throw new CheckError('invalid_pattern', `forbidden-data pattern ${index + 1} is empty or not a string`)
    }
    try {
      return { name: `pattern:${index + 1}`, pattern: new RegExp(source, 'gu') }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new CheckError(
        'invalid_pattern',
        `forbidden-data pattern ${index + 1} is not a valid regular expression (${reason}); nothing was written`,
      )
    }
  })
  const rules = [...BUILT_IN, ...own]
  const find = (text: string): MaskMatch[] => merge(rules.flatMap((rule) => matchesOf(rule, text)))
  return {
    find,
    matches: (text) => find(text).length > 0,
    apply: (text) => hideRanges(text, find(text)),
  }
}

function matchesOf(rule: Rule, text: string): MaskMatch[] {
  const found: MaskMatch[] = []
  const pattern = new RegExp(rule.pattern.source, rule.pattern.flags)
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match[0] === '') {
      // An empty match hides nothing; the search goes on from the next character — a whole one, never the middle of a
      // surrogate pair (where a `u` pattern would find the same empty match again, for ever).
      pattern.lastIndex = nextCharacter(text, pattern.lastIndex)
      continue
    }
    if (rule.accept && !rule.accept(match[0])) {
      // Not this one (a date): a shorter one may start inside it.
      pattern.lastIndex = nextCharacter(text, match.index)
      continue
    }
    found.push({ start: match.index, end: match.index + match[0].length, rules: [rule.name] })
  }
  return found
}

// The index after the character at `at` (one code point: two UTF-16 units for a surrogate pair).
function nextCharacter(text: string, at: number): number {
  const code = text.codePointAt(at)
  return at + (code !== undefined && code > 0xffff ? 2 : 1)
}

// Overlapping and touching matches become one.
function merge(matches: MaskMatch[]): MaskMatch[] {
  const sorted = [...matches].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: { start: number; end: number; rules: string[] }[] = []
  for (const match of sorted) {
    const last = merged[merged.length - 1]
    if (last && match.start <= last.end) {
      last.end = Math.max(last.end, match.end)
      for (const rule of match.rules) if (!last.rules.includes(rule)) last.rules.push(rule)
    } else {
      merged.push({ start: match.start, end: match.end, rules: [...match.rules] })
    }
  }
  return merged
}

// `text` with each of the (merged, sorted) ranges replaced by «[скрыто]».
export function hideRanges(text: string, ranges: readonly MaskMatch[]): Masked {
  let out = ''
  let at = 0
  const rules = new Set<string>()
  for (const range of ranges) {
    out += text.slice(at, range.start) + HIDDEN
    at = range.end
    for (const rule of range.rules) rules.add(rule)
  }
  return { text: out + text.slice(at), hidden: ranges.length, rules: [...rules] }
}
