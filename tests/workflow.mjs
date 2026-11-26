// The plugin's GitHub Actions workflow for the tests (tests/ci.test.mjs): a reader of the YAML it is written in, and a
// runner of a job's steps on this machine the way GitHub's runner runs them. Node only, no packages: the reader takes
// the subset of YAML the workflow uses (block mappings and sequences, plain and quoted scalars, `[a, b]` lists of
// scalars, `|` block scalars, comments) and throws on anything else, rather than read it otherwise than GitHub does.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pluginRoot, run } from './helpers.mjs'

export const workflowFile = join(pluginRoot, '.github', 'workflows', 'plugin.yml')

export function readWorkflow(file = workflowFile) {
  return readYaml(readFileSync(file, 'utf8'))
}

export function readYaml(text) {
  const lines = text.split(/\r?\n/).map((raw, index) => ({ raw, index }))
  let pos = 0
  const fail = (line, why) => new Error(`YAML, строка ${line.index + 1}: ${why}: ${line.raw}`)
  const blank = (line) => /^\s*(#.*)?$/.test(line.raw)
  const indentOf = (line) => line.raw.search(/\S/)
  const isItem = (content) => content === '-' || content.startsWith('- ')
  const skipBlank = () => {
    while (pos < lines.length && blank(lines[pos])) pos++
  }

  function node(indent) {
    skipBlank()
    if (pos >= lines.length || indentOf(lines[pos]) < indent) return null
    const at = indentOf(lines[pos])
    return isItem(lines[pos].raw.slice(at)) ? sequence(at) : mapping(at)
  }

  function sequence(indent) {
    const items = []
    for (skipBlank(); pos < lines.length; skipBlank()) {
      const line = lines[pos]
      const at = indentOf(line)
      if (at < indent || !isItem(line.raw.slice(at))) break
      if (at > indent) throw fail(line, 'лишний отступ')
      const rest = line.raw.slice(at + 1).replace(/^ +/, '')
      if (stripComment(rest, line) === '') {
        pos++
        items.push(node(indent + 1))
      } else if (/^[A-Za-z_][\w-]*:(\s|$)/.test(rest)) {
        // `- key: value` opens a mapping whose keys stand where `key` stands.
        const column = line.raw.length - rest.length
        lines[pos] = { raw: ' '.repeat(column) + rest, index: line.index }
        items.push(mapping(column))
      } else {
        items.push(scalar(stripComment(rest, line), line))
        pos++
      }
    }
    return items
  }

  function mapping(indent) {
    const map = {}
    for (skipBlank(); pos < lines.length; skipBlank()) {
      const line = lines[pos]
      const at = indentOf(line)
      if (at < indent) break
      if (at > indent) throw fail(line, 'лишний отступ')
      if (isItem(line.raw.slice(at))) break
      const entry = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(line.raw.slice(at))
      if (!entry) throw fail(line, 'не «ключ: значение»')
      const [, key] = entry
      const value = stripComment(entry[2] ?? '', line)
      if (Object.hasOwn(map, key)) throw fail(line, `ключ ${key} повторяется`)
      pos++
      if (value === '') {
        skipBlank()
        const next = lines[pos]
        if (next && indentOf(next) === indent && isItem(next.raw.slice(indent))) map[key] = sequence(indent)
        else map[key] = next && indentOf(next) > indent ? node(indentOf(next)) : null
      } else if (/^\|[-+]?$/.test(value)) {
        map[key] = blockScalar(indent, value)
      } else {
        map[key] = scalar(value, line)
      }
    }
    return map
  }

  // A literal block scalar: the lines indented deeper than its key, as they are (comments included).
  function blockScalar(indent, indicator) {
    const body = []
    while (pos < lines.length && (lines[pos].raw.trim() === '' || indentOf(lines[pos]) > indent)) body.push(lines[pos++].raw)
    while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
    if (body.length === 0) return ''
    const contentIndent = body[0].search(/\S/)
    const text = body.map((l) => l.slice(contentIndent)).join('\n')
    return indicator === '|-' ? text : `${text}\n`
  }

  function scalar(text, line) {
    if (/^[&*!{>%@`]/.test(text)) throw fail(line, 'не поддерживается этим чтением')
    if (text.startsWith("'")) {
      if (!/^'([^']|'')*'$/.test(text)) throw fail(line, 'незакрытая строка')
      return text.slice(1, -1).replaceAll("''", "'")
    }
    if (text.startsWith('"')) {
      if (!/^"([^"\\]|\\.)*"$/.test(text)) throw fail(line, 'незакрытая строка')
      return text.slice(1, -1).replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' })[c] ?? c)
    }
    if (text.startsWith('[')) {
      if (!/^\[[^[\]{}]*\]$/.test(text)) throw fail(line, 'список не из простых значений')
      const inner = text.slice(1, -1).trim()
      return inner === '' ? [] : inner.split(',').map((item) => scalar(item.trim(), line))
    }
    return text
  }

  // The value without a trailing comment: `#` after a blank, outside quotes.
  function stripComment(text, line) {
    let quote = null
    for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if (quote) {
        if (c === quote) quote = null
      } else if (c === "'" || c === '"') {
        if (i === 0) quote = c
      } else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
        return text.slice(0, i).trimEnd()
      }
    }
    if (quote) throw fail(line, 'незакрытая строка')
    return text.trimEnd()
  }

  const document = node(0)
  skipBlank()
  if (pos < lines.length) throw fail(lines[pos], 'не прочитано')
  return document
}

// Whether a step runs on `runnerOs` (Linux, macOS, Windows): no `if`, or `runner.os == '…'` / `runner.os != '…'`.
export function runsOn(step, runnerOs) {
  if (step.if === undefined) return true
  const condition = /^runner\.os (==|!=) '(Linux|macOS|Windows)'$/.exec(step.if)
  if (!condition) throw new Error(`условие шага не из простых: ${step.if}`)
  return (condition[1] === '==') === (condition[2] === runnerOs)
}

// Runs the steps of `job` for `runnerOs` in `cwd` the way GitHub's runner does on this machine: each `run` through
// `bash --noprofile --norc -eo pipefail` (the job's default shell must be bash), `if` evaluated, the actions of `uses`
// left out (the test gives what they set up), `$GITHUB_ENV` and `$GITHUB_PATH` of a step passed on to the next ones,
// RUNNER_OS, RUNNER_TEMP (`runnerTemp`) and GITHUB_WORKSPACE set. Stops after the first failing step. Returns one record
// per step: { step, ran, status, output, … }.
export function runJob(job, { runnerOs, cwd, env, runnerTemp }) {
  if (job.defaults?.run?.shell !== 'bash') throw new Error('оболочка шагов по умолчанию — не bash')
  const pathKey = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
  const stepFiles = join(runnerTemp, '.steps')
  mkdirSync(stepFiles, { recursive: true })
  let current = {
    ...env,
    RUNNER_OS: runnerOs,
    RUNNER_TEMP: runnerTemp,
    GITHUB_WORKSPACE: cwd,
    GITHUB_ACTIONS: 'true',
    CI: 'true',
  }
  const records = []
  for (const [index, step] of job.steps.entries()) {
    const known = new Set(['name', 'id', 'if', 'uses', 'with', 'run'])
    const unknown = Object.keys(step).filter((key) => !known.has(key))
    if (unknown.length > 0) throw new Error(`шаг «${step.name}»: ключи ${unknown.join(', ')} этим запуском не поддерживаются`)
    if (!runsOn(step, runnerOs)) {
      records.push({ step, ran: false, reason: 'if' })
      continue
    }
    if (step.uses !== undefined) {
      records.push({ step, ran: false, reason: 'uses' })
      continue
    }
    if (typeof step.run !== 'string' || step.run.includes('${{')) {
      throw new Error(`шаг «${step.name}»: run не скрипт bash без выражений \${{ }}`)
    }
    const script = join(stepFiles, `step-${index}.sh`)
    const githubEnv = join(stepFiles, `env-${index}`)
    const githubPath = join(stepFiles, `path-${index}`)
    writeFileSync(script, step.run, 'utf8')
    writeFileSync(githubEnv, '')
    writeFileSync(githubPath, '')
    const result = run('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
      cwd,
      env: { ...current, GITHUB_ENV: githubEnv, GITHUB_PATH: githubPath },
    })
    records.push({ step, ran: true, ...result })
    if (result.status !== 0) break
    current = { ...current, ...readGithubEnv(readFileSync(githubEnv, 'utf8')) }
    for (const dir of readFileSync(githubPath, 'utf8').split(/\r?\n/).filter(Boolean)) {
      current[pathKey] = `${dir}${process.platform === 'win32' ? ';' : ':'}${current[pathKey] ?? ''}`
    }
  }
  return records
}

// The variables a step wrote to $GITHUB_ENV: `NAME=value` lines and `NAME<<DELIMITER` blocks.
export function readGithubEnv(text) {
  const vars = {}
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '') continue
    const block = /^([A-Za-z_]\w*)<<(.+)$/.exec(lines[i])
    if (block) {
      const value = []
      while (++i < lines.length && lines[i] !== block[2]) value.push(lines[i])
      vars[block[1]] = value.join('\n')
      continue
    }
    const pair = /^([A-Za-z_]\w*)=(.*)$/.exec(lines[i])
    if (!pair) throw new Error(`$GITHUB_ENV: не «ИМЯ=значение»: ${lines[i]}`)
    vars[pair[1]] = pair[2]
  }
  return vars
}
