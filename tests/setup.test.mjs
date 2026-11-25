// The worktree hooks of orca.yaml (Ф14): setup checks the tools and installs without bin links, archive exits with 0, and
// both are plain commands Orca can run on macOS, Linux (bash) and Windows (cmd.exe). Fake tools on a temporary PATH:
// nothing here installs anything.
import { assert, test } from 'orca/testing'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { missingTools, orcaCliCommand } from '../scripts/tools.mjs'
import { orcaHookRunner, orcaYamlScripts, pluginRoot, run, runOrcaHook, tempDir, testEnv } from './helpers.mjs'

const hooks = orcaYamlScripts(readFileSync(join(pluginRoot, 'orca.yaml'), 'utf8'))
const windows = process.platform === 'win32'

// A fake tool in `dir`: it writes its arguments, one per line, to the file named by FAKE_TOOL_LOG.
function fakeTool(dir, name) {
  if (windows) {
    writeFileSync(join(dir, `${name}.cmd`), '@echo off\r\n(for %%a in (%*) do @echo %%a) > "%FAKE_TOOL_LOG%"\r\n')
  } else {
    const file = join(dir, name)
    writeFileSync(file, '#!/bin/sh\nprintf "%s\\n" "$@" > "$FAKE_TOOL_LOG"\n')
    chmodSync(file, 0o755)
  }
}

// An environment whose PATH has only `dir` (and the directory of cmd.exe on Windows), without ORCA_CLI_COMMAND.
function fakeEnv(dir, log) {
  const env = testEnv({ FAKE_TOOL_LOG: log })
  for (const name of Object.keys(env)) {
    if (name.toUpperCase() === 'PATH' || name === 'ORCA_CLI_COMMAND') delete env[name]
  }
  env.PATH = windows && env.ComSpec ? `${dir};${dirname(env.ComSpec)}` : dir
  return env
}

function runSetupScript(env) {
  return run(process.execPath, [join(pluginRoot, 'scripts', 'setup.mjs')], { cwd: pluginRoot, env })
}

test('setup: CLI Orca — ORCA_CLI_COMMAND, иначе orca-ide на Linux и orca на macOS и Windows; голый orca на Linux — никогда', () => {
  assert.equal(orcaCliCommand({}, 'linux'), 'orca-ide')
  assert.equal(orcaCliCommand({}, 'darwin'), 'orca')
  assert.equal(orcaCliCommand({}, 'win32'), 'orca')
  assert.equal(orcaCliCommand({ ORCA_CLI_COMMAND: '/opt/orca/bin/orca' }, 'linux'), '/opt/orca/bin/orca')
  assert.equal(orcaCliCommand({ Orca_Cli_Command: 'C:\\Orca\\orca.cmd' }, 'win32'), 'C:\\Orca\\orca.cmd')

  // Only a bare `orca` on PATH: on Linux that is not Orca's CLI.
  const bin = tempDir('setup-bin')
  try {
    for (const tool of ['git', 'node', 'npm', 'orca']) fakeTool(bin.dir, tool)
    const env = fakeEnv(bin.dir, join(bin.dir, 'log'))
    assert.deepEqual(missingTools(env, 'linux'), ['Orca CLI (orca-ide)'])
    assert.deepEqual(missingTools(env, 'darwin'), [])
    assert.deepEqual(missingTools({ ...env, ORCA_CLI_COMMAND: join(bin.dir, windows ? 'orca.cmd' : 'orca') }, 'linux'), [])
  } finally {
    bin.remove()
  }
})

test('setup: нет git или CLI Orca — выход 1 с их именами, установка не запускается', () => {
  const bin = tempDir('setup-bin')
  try {
    const log = join(bin.dir, 'npm.log')
    for (const tool of ['node', 'npm']) fakeTool(bin.dir, tool)
    const result = runSetupScript(fakeEnv(bin.dir, log))
    assert.equal(result.status, 1, result.output)
    assert.match(result.stderr, new RegExp(`missing tools: git, Orca CLI \\(${orcaCliCommand({})}\\)`))
    assert.equal(existsSync(log), false, 'npm запускался при недостающих инструментах')
  } finally {
    bin.remove()
  }
})

test('setup: все инструменты есть — npm ci без bin-ссылок, код выхода npm', () => {
  const bin = tempDir('setup-bin')
  try {
    const log = join(bin.dir, 'npm.log')
    for (const tool of ['git', 'node', 'npm', orcaCliCommand({})]) fakeTool(bin.dir, tool)
    const result = runSetupScript(fakeEnv(bin.dir, log))
    assert.equal(result.status, 0, result.output)
    const args = readFileSync(log, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    assert.deepEqual(args, ['ci', '--no-audit', '--no-fund', '--no-bin-links'])
  } finally {
    bin.remove()
  }
})

test('setup и archive в orca.yaml — простые команды без синтаксиса bash, для bash и cmd.exe', () => {
  assert.deepEqual(Object.keys(hooks).sort(), ['archive', 'setup'])
  // Each line is a call of a Node script of the project or an echo of plain words: valid in bash and in cmd.exe, with
  // nothing either shell would read as syntax (variables, quotes, pipes, redirections, conditions, comments).
  const plain = /^(node [\w./-]+\.mjs( [\w-]+)*|echo [\w .,:/-]+)$/
  for (const [name, script] of Object.entries(hooks)) {
    const lines = script.split('\n').filter((line) => line.trim() !== '')
    assert.ok(lines.length > 0, `${name}: пустой скрипт`)
    for (const line of lines) {
      assert.match(line, plain, `${name}: «${line}»`)
      const nodeScript = /^node (\S+)/.exec(line)?.[1]
      if (nodeScript) assert.ok(existsSync(join(pluginRoot, nodeScript)), `${name}: нет ${nodeScript}`)
    }
  }
  assert.match(hooks.setup, /^node scripts\/setup\.mjs\n$/)
  // On Windows Orca calls each line from a .cmd file and stops at the first failure.
  assert.equal(
    orcaHookRunner(hooks.setup, 'win32'),
    '@echo off\r\nsetlocal EnableExtensions DisableDelayedExpansion\r\n' +
      'call node scripts/setup.mjs\r\nif errorlevel 1 exit /b %errorlevel%\r\n\r\n',
  )
})

test('archive из orca.yaml выходит с кодом 0', () => {
  const result = runOrcaHook('archive', hooks.archive, pluginRoot, testEnv())
  assert.equal(result.status, 0, result.output)
})
