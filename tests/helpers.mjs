// Helpers of the delivery tests (tests/*.test.mjs): the plugin folder, a clean export of its commit, Orca's CLI and the
// hooks of orca.yaml run the way Orca runs them. Plain JavaScript: these tests use Node's own modules, and the plugin's
// tsconfig has only Orca's typings.
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findCommand, isScreenReader, orcaCliCommand } from '../scripts/tools.mjs'

// The plugin folder: the directory of orca-plugin.json above this file.
export const pluginRoot = (() => {
  let dir = dirname(fileURLToPath(import.meta.url))
  while (!existsSync(join(dir, 'orca-plugin.json'))) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error('orca-plugin.json not found above tests/')
    dir = parent
  }
  return dir
})()

// A delivery test runs `make test` in a prepared export of the commit; that inner run has this variable set, and the
// delivery tests skip there instead of starting yet another `make test`.
export const NESTED_RUN = 'ORCA_PLUGIN_AQK_NESTED_MAKE_TEST'
export const nestedRun = process.env[NESTED_RUN] === '1'

// The variables the Makefile assigns. An enclosing `make test ORCA=… test_args=…` exports its command-line variables and
// its own exports (PLUGIN_ORCA_CLI, TEST_RESULT_ARGS …) to every process below it, and an inner `make test` would take
// them for its own: another CLI, a filtered run.
export const makefileVariables = (() => {
  const names = new Set(['ORCA', 'test_args', 'TEST_RESULT_DIR'])
  const assignment = /^(?:[^\t#:=]*:\s*)?(?:(?:export|override)\s+)*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\?|:|\+)?=/
  for (const line of readFileSync(join(pluginRoot, 'Makefile'), 'utf8').split(/\r?\n/)) {
    const match = assignment.exec(line)
    if (match) names.add(match[1])
  }
  return names
})()

// The environment of a command a test starts (`base` plus `extra`), without what the enclosing run passes to its
// children: make's flags, jobserver and variables, and NODE_TEST_CONTEXT of Node's test runner, with which an inner
// `orca plugin test` would skip every test file and still report them passed. The CLI chosen for the run reaches the
// command through ORCA_CLI_COMMAND, which stays.
export function testEnv(extra = {}, base = process.env) {
  const env = { ...base }
  for (const name of ['MAKEFLAGS', 'MFLAGS', 'MAKELEVEL', 'MAKEOVERRIDES', 'NODE_TEST_CONTEXT', ...makefileVariables]) {
    delete env[name]
  }
  return { ...env, ...extra }
}

// The environment of an npm run in a test: no network (only npm's cache, which the worktree's own preparation filled).
export function offlineNpmEnv(extra = {}) {
  return testEnv({ npm_config_offline: 'true', npm_config_update_notifier: 'false', ...extra })
}

// Runs a program the way a shell of this system finds it; on Windows a .cmd or .bat starts through cmd.exe.
export function run(command, args, options = {}) {
  const env = options.env ?? process.env
  const file = findCommand(command, env) ?? command
  const viaCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)
  const spawnOptions = { ...options, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  const result = viaCmd
    ? spawnSync([file, ...args].map(quoteForCmd).join(' '), { ...spawnOptions, shell: true })
    : spawnSync(file, args, spawnOptions)
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
    output: `$ ${command} ${args.join(' ')}\nexit ${result.status}${result.error ? ` (${result.error.message})` : ''}\n` +
      `--- stdout\n${result.stdout ?? ''}\n--- stderr\n${result.stderr ?? ''}`,
  }
}

function quoteForCmd(word) {
  return /^[\w.:\\/=-]+$/.test(word) ? word : `"${word}"`
}

// Orca's CLI of this system (scripts/tools.mjs, as `make test` picks it). A bare `orca` on Linux is GNOME's screen
// reader: it throws instead of starting it, also when the tests run without `make test` (`orca-ide plugin test .`).
export function orcaCli(env = process.env) {
  const cli = orcaCliCommand(env)
  if (isScreenReader(cli)) {
    throw new Error("ORCA_CLI_COMMAND=orca: on Linux a bare orca is GNOME's screen reader, not Orca's CLI; " +
      'not started — set ORCA_CLI_COMMAND to orca-ide or the full path of the CLI')
  }
  return cli
}

export function orca(args, options = {}) {
  return run(orcaCli(options.env ?? process.env), args, options)
}

// `orca plugin inspect <dir> --json`: its exit code and parsed answer.
export function inspect(dir) {
  const result = orca(['plugin', 'inspect', dir, '--json'], { env: testEnv() })
  let json = null
  try {
    json = JSON.parse(result.stdout)
  } catch {
    // An answer that is not JSON stays null; the test shows the whole output.
  }
  return { ...result, json }
}

// A temporary directory for one test; remove() deletes it with everything in it.
export function tempDir(name) {
  const dir = mkdtempSync(join(tmpdir(), `orca-plugin-aqk-${name}-`))
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) }
}

// A clean export of the commit at HEAD (`git archive`, without node_modules and .orca) in a new directory of `parent`.
export function exportHead(parent) {
  const tarball = spawnSync(findCommand('git') ?? 'git', ['-C', pluginRoot, 'archive', '--format=tar', 'HEAD'], {
    maxBuffer: 256 * 1024 * 1024,
  })
  if (tarball.status !== 0) {
    throw new Error(`git archive HEAD failed (${tarball.status}): ${tarball.stderr ?? tarball.error?.message}`)
  }
  const dir = join(parent, 'plugin')
  mkdirSync(dir)
  // tar reads the archive from stdin (`-f -`, GNU tar and bsdtar alike) in the target directory: no paths to quote.
  const untar = spawnSync(findCommand('tar') ?? 'tar', ['-x', '-f', '-'], {
    cwd: dir,
    input: tarball.stdout,
    encoding: 'utf8',
  })
  if (untar.status !== 0) throw new Error(`tar -x failed (${untar.status}): ${untar.stderr ?? untar.error?.message}`)
  return dir
}

// Makes `dir` a local git repository with everything in it committed, as a worktree of that commit; returns its SHA.
// Git runs without the user's and the system's config (no hooks, signing or templates of theirs), with a test author.
export function commitAll(dir) {
  const config = join(dir, '..', 'gitconfig')
  writeFileSync(config, '')
  const env = testEnv({ GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' })
  const author = ['-c', 'user.name=Delivery Test', '-c', 'user.email=delivery-test@example.invalid']
  for (const args of [['init', '-q'], ['add', '-A'], [...author, 'commit', '-q', '-m', 'export of HEAD']]) {
    const result = run('git', args, { cwd: dir, env })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} in ${dir}:\n${result.output}`)
  }
  return run('git', ['rev-parse', 'HEAD'], { cwd: dir, env }).stdout.trim()
}

// An executable `name` in `dir` for this system: the POSIX shell script `sh`, or on Windows `name.cmd` with `cmd`.
export function writeExecutable(dir, name, { sh, cmd }) {
  if (process.platform === 'win32') {
    const file = join(dir, `${name}.cmd`)
    writeFileSync(file, cmd.replaceAll('\n', '\r\n'))
    return file
  }
  const file = join(dir, name)
  writeFileSync(file, sh)
  chmodSync(file, 0o755)
  return file
}

// The records docker/test-result.sh wrote for commit `sha` under `resultsDir`, parsed.
export function recordsOf(resultsDir, sha) {
  const dir = join(resultsDir, sha)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')))
}

// Every symbolic link (a junction on Windows too) under `dir`, as paths relative to it, without following them.
export function symlinksIn(dir) {
  const found = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isSymbolicLink() || lstatSync(path).isSymbolicLink()) found.push(relative(dir, path).replaceAll('\\', '/'))
      else if (entry.isDirectory()) walk(path)
    }
  }
  walk(dir)
  return found.sort()
}

// The scripts of orca.yaml (`scripts:` — each one a block scalar `name: |` or a one-line plain value), by name.
export function orcaYamlScripts(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^scripts:\s*$/.test(line))
  if (start < 0) throw new Error('orca.yaml has no scripts:')
  const scripts = {}
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^\S/.test(line)) break
    const key = /^(\s+)([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (!key) continue
    const [, indent, name, value] = key
    if (!/^\|[-+]?$/.test(value)) {
      scripts[name] = value.trim()
      continue
    }
    const body = []
    while (i + 1 < lines.length && (lines[i + 1].trim() === '' || lines[i + 1].search(/\S/) > indent.length)) {
      body.push(lines[++i])
    }
    while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
    const contentIndent = Math.min(...body.filter((l) => l.trim() !== '').map((l) => l.search(/\S/)))
    scripts[name] = body.map((l) => l.slice(contentIndent)).join('\n') + (value === '|-' ? '' : '\n')
  }
  return scripts
}

// The runner file Orca 1.4.273 writes for a hook of orca.yaml: on macOS and Linux a bash script with `set -e`, on Windows
// a .cmd file that calls each line and stops at the first one that fails.
export function orcaHookRunner(script, platform = process.platform) {
  if (platform !== 'win32') return `#!/usr/bin/env bash\nset -e\n${script}\n`
  let runner = '@echo off\r\nsetlocal EnableExtensions DisableDelayedExpansion\r\n'
  for (const line of script.split('\n').map((l) => l.replace(/\r$/, '').trim())) {
    if (line.startsWith('#!')) throw new Error('Orca does not run a hook with a #! line through cmd.exe')
    runner += line ? `call ${line}\r\nif errorlevel 1 exit /b %errorlevel%\r\n` : '\r\n'
  }
  return runner
}

// Runs a hook of orca.yaml in `cwd` as Orca does on this system: bash on macOS and Linux, cmd.exe on Windows.
export function runOrcaHook(name, script, cwd, env) {
  const runnerDir = tempDir(`hook-${name}`)
  try {
    const windows = process.platform === 'win32'
    const file = join(runnerDir.dir, windows ? `${name}.cmd` : `${name}.sh`)
    writeFileSync(file, orcaHookRunner(script), 'utf8')
    return windows
      ? run(env.ComSpec ?? process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', file], { cwd, env })
      : run('bash', [file], { cwd, env })
  } finally {
    runnerDir.remove()
  }
}

// The preparation command of README: the one `npm ci …` line of its code blocks, as words.
export function readmePrepareCommand() {
  const readme = readFileSync(join(pluginRoot, 'README.md'), 'utf8')
  const commands = new Set()
  let inCode = false
  for (const line of readme.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) inCode = !inCode
    else if (inCode && /^\s*npm ci\b/.test(line)) commands.add(line.replace(/#.*$/, '').trim())
  }
  if (commands.size !== 1) throw new Error(`README must name one preparation command (npm ci …), found: ${[...commands]}`)
  return [...commands][0].split(/\s+/)
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}
