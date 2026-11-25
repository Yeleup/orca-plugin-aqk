// Delivery of the plugin folder (Ф14, К14.4): a clean export of the commit passes `orca plugin inspect`, and so does the
// folder after the usual preparation of a worktree (`setup` of orca.yaml) and after the preparation command of README:
// no symlinks in it, and the full `make test` is green there and records its result for the queue.
//
// Everything runs in clean exports of HEAD in temporary directories (commit first: uncommitted changes are not in
// them); a prepared tree is a local git repository of that export, and its `make test` records into a temporary
// directory. npm runs offline, from the cache the worktree's own preparation filled: no network. The inner `make test`
// skips these tests (NESTED_RUN), so it runs every other step and test once.
import { assert, test } from 'orca/testing'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { findCommand, orcaCliCommand } from '../scripts/tools.mjs'
import {
  NESTED_RUN,
  commitAll,
  exportHead,
  inspect,
  nestedRun,
  offlineNpmEnv,
  orcaYamlScripts,
  readmePrepareCommand,
  recordsOf,
  run,
  runOrcaHook,
  symlinksIn,
  tempDir,
  testEnv,
  writeExecutable,
} from './helpers.mjs'

const windows = process.platform === 'win32'
const pathKey = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
const pathSeparator = windows ? ';' : ':'

function deliveryTest(name, body) {
  test(name, (t) => {
    if (nestedRun) {
      t.skip('внутренний make test проверки поставки: их ведёт внешний прогон')
      return
    }
    const temp = tempDir('delivery')
    try {
      return body(temp.dir, t)
    } finally {
      temp.remove()
    }
  })
}

function assertInspectPasses(dir, when) {
  const result = inspect(dir)
  assert.equal(result.status, 0, `plugin inspect ${when}:\n${result.output}`)
  assert.equal(result.json?.result?.valid, true, `plugin inspect ${when}:\n${result.output}`)
  return result.json.result
}

// `make test` in `dir`, the inner run: make's own variables as `vars`, the environment of a test plus `env`.
function makeTest(dir, vars, env = {}) {
  assert.ok(findCommand('make') !== null, 'make не найден в PATH: полный make test проверить нечем')
  return run('make', ['test', ...vars], { cwd: dir, env: testEnv({ [NESTED_RUN]: '1', ...env }) })
}

// The environment with `dir` first on PATH.
function pathFirst(dir) {
  return { [pathKey]: `${dir}${pathSeparator}${process.env[pathKey] ?? ''}` }
}

// The folder after a preparation: TypeScript installed, no symlinks, inspect passes, and the full `make test` is green
// and writes a full green record of the tree's commit.
function assertPreparedFolder(dir, sha, temp, when) {
  assert.ok(existsSync(join(dir, 'node_modules', 'typescript', 'bin', 'tsc')), `${when}: TypeScript не установлен`)
  assert.deepEqual(symlinksIn(dir), [], `${when}: симлинки в папке плагина`)
  assertInspectPasses(dir, when)

  const results = join(temp, 'test-results')
  const make = makeTest(dir, [`TEST_RESULT_DIR=${results}`])
  assert.equal(make.status, 0, `make test ${when}:\n${make.output}`)
  for (const summary of ['orca plugin validate: манифест в порядке', 'tsc: типы в порядке', '# fail 0']) {
    assert.ok(make.stdout.includes(summary), `make test ${when}: нет «${summary}»:\n${make.output}`)
  }
  // The tests really ran there: the worker's test and the manifest's passed, only these delivery tests skipped.
  const passed = Number(/^# pass (\d+)$/m.exec(make.stdout)?.[1] ?? 0)
  assert.ok(passed > 0, `make test ${when}: ни один тест не прошёл:\n${make.output}`)
  for (const name of ['the worker starts without host calls or refusals', 'К2.7: проверка манифеста CLI Orca']) {
    assert.match(make.stdout, new RegExp(`^ok \\d+ - ${name}`, 'm'), `make test ${when}:\n${make.output}`)
  }
  // The record the queue merges by: one full green run of this commit on a clean tree.
  const records = recordsOf(results, sha)
  assert.equal(records.length, 1, `make test ${when}: записей итога ${records.length}:\n${make.output}`)
  const [record] = records
  assert.equal(record.sha, sha)
  assert.deepEqual(
    { full: record.full, green: record.green, clean: record.clean, filtered: record.filtered, exit: record.exit },
    { full: true, green: true, clean: true, filtered: false, exit: 0 },
    JSON.stringify(record),
  )
  assert.deepEqual(record.steps.map((step) => [step.name, step.exit]), [['validate', 0], ['types', 0], ['plugin', 0]])

  assert.deepEqual(symlinksIn(dir), [], `${when}, после make test: симлинки в папке плагина`)
  assertInspectPasses(dir, `${when}, после make test`)
}

deliveryTest('К14.4 (выгрузка): на чистой выгрузке коммита plugin inspect проходит, плагин — agent-queue «Agent Queue»', (temp) => {
  const dir = exportHead(temp)
  assert.equal(existsSync(join(dir, 'node_modules')), false)
  assert.equal(existsSync(join(dir, '.orca')), false)
  const answer = assertInspectPasses(dir, 'на чистой выгрузке')
  assert.equal(answer.plugin.pluginKey, 'local.agent-queue')
  assert.equal(answer.plugin.name, 'Agent Queue')
})

deliveryTest('К14.4 (setup): после setup из orca.yaml нет симлинков, plugin inspect проходит и полный make test зелёный', (temp) => {
  const dir = exportHead(temp)
  const sha = commitAll(dir)
  const { setup } = orcaYamlScripts(readFileSync(join(dir, 'orca.yaml'), 'utf8'))
  const result = runOrcaHook('setup', setup, dir, offlineNpmEnv())
  assert.equal(result.status, 0, `setup из orca.yaml:\n${result.output}`)
  assertPreparedFolder(dir, sha, temp, 'после setup')
})

deliveryTest('К14.4 (README): после команды подготовки из README нет симлинков, plugin inspect проходит и полный make test зелёный', (temp) => {
  const [program, ...args] = readmePrepareCommand()
  assert.equal(program, 'npm')
  const dir = exportHead(temp)
  const sha = commitAll(dir)
  const result = run(program, args, { cwd: dir, env: offlineNpmEnv() })
  assert.equal(result.status, 0, `команда подготовки из README:\n${result.output}`)
  assertPreparedFolder(dir, sha, temp, 'после команды из README')
})

// The check above finds what breaks delivery: an install with bin links leaves the symlink node_modules/.bin/tsc, and
// inspect refuses the folder. On Windows npm makes .cmd files there instead of symlinks.
deliveryTest('К14.4 (контроль): npm ci с bin-ссылками оставляет симлинк, и plugin inspect папку не принимает', (temp, t) => {
  if (windows) {
    t.skip('на Windows npm не делает симлинков в node_modules/.bin')
    return
  }
  const dir = exportHead(temp)
  const result = run('npm', ['ci', '--no-audit', '--no-fund', '--bin-links'], { cwd: dir, env: offlineNpmEnv() })
  assert.equal(result.status, 0, result.output)
  assert.deepEqual(symlinksIn(dir), ['node_modules/.bin/tsc'])
  const refused = inspect(dir)
  assert.equal(refused.status, 2, refused.output)
  assert.match(refused.output, /symlink not allowed in plugin content: node_modules\/\.bin\/tsc/)
})

// One CLI for the whole run: `make test ORCA=<path with a blank>` runs every step and the tests' own calls of Orca's CLI
// through that path, as one argument, although ORCA_CLI_COMMAND names another CLI.
deliveryTest('make test: выбранный CLI Orca (ORCA=…, путь с пробелом) — одним аргументом во всех шагах и в тестах', (temp) => {
  const real = findCommand(orcaCliCommand())
  assert.ok(real, `CLI Orca не найден: ${orcaCliCommand()}`)
  const dir = exportHead(temp)
  const install = run('npm', ['ci', '--no-audit', '--no-fund', '--no-bin-links'], { cwd: dir, env: offlineNpmEnv() })
  assert.equal(install.status, 0, install.output)

  const toolsDir = join(temp, 'Orca Tools')
  mkdirSync(toolsDir)
  const log = join(temp, 'orca-calls.log')
  const wrapper = writeExecutable(toolsDir, 'orca-ide', {
    sh: '#!/bin/sh\nprintf "%s\\n" "$*" >> "$ORCA_CALLS_LOG"\nexec "$REAL_ORCA_CLI" "$@"\n',
    cmd: '@echo off\necho %*>> "%ORCA_CALLS_LOG%"\n"%REAL_ORCA_CLI%" %*\n',
  })
  const make = makeTest(dir, ['TEST_RESULT_DIR=', `ORCA=${wrapper}`], {
    ORCA_CLI_COMMAND: real,
    REAL_ORCA_CLI: real,
    ORCA_CALLS_LOG: log,
  })
  assert.equal(make.status, 0, make.output)
  const calls = readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean)
  for (const step of ['plugin validate .', 'plugin types .', 'plugin test .']) {
    assert.ok(calls.includes(step), `шаг «${step}» не через ${wrapper}: ${JSON.stringify(calls)}`)
  }
  // The inner test names the folder by the path Node loaded it from: the real path, where the temporary directory is
  // behind a symlink (macOS).
  const validateCalls = [`plugin validate ${dir} --json`, `plugin validate ${realpathSync(dir)} --json`]
  assert.ok(calls.some((call) => validateCalls.includes(call)), `тест К2.7 не через ${wrapper}: ${JSON.stringify(calls)}`)
})

// The recorder needs bash 4.4 or newer; with an older bash on PATH (macOS ships 3.2) `make test` stops and says so
// instead of passing with no record.
deliveryTest('make test: bash старше 4.4 в PATH — отказ до тестов, без записи итога', (temp, t) => {
  if (windows) {
    t.skip('поддельный bash — сценарий POSIX')
    return
  }
  const dir = exportHead(temp)
  const fakeBin = join(temp, 'bash-3.2')
  mkdirSync(fakeBin)
  writeExecutable(fakeBin, 'bash', { sh: '#!/bin/sh\necho 3.2\n', cmd: '' })
  const results = join(temp, 'test-results')
  const make = makeTest(dir, [`TEST_RESULT_DIR=${results}`], pathFirst(fakeBin))
  assert.notEqual(make.status, 0, make.output)
  assert.match(make.stderr, /требует bash 4\.4 или новее, а bash в PATH — «3\.2»/)
  assert.equal(existsSync(results) && readdirSync(results).length > 0, false, 'итог записан')
})

// On Linux a bare `orca` is GNOME's screen reader: `make test` refuses it as the CLI before any step runs it.
deliveryTest('make test: ORCA_CLI_COMMAND=orca на Linux — отказ до шагов, экранный диктор не запускается', (temp, t) => {
  if (process.platform !== 'linux') {
    t.skip('голый orca — экранный диктор только на Linux; на macOS и Windows это CLI Orca')
    return
  }
  const dir = exportHead(temp)
  const fakeBin = join(temp, 'screen-reader')
  mkdirSync(fakeBin)
  const log = join(temp, 'screen-reader.log')
  writeExecutable(fakeBin, 'orca', { sh: '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SCREEN_READER_LOG"\n', cmd: '' })
  const make = makeTest(dir, ['TEST_RESULT_DIR='], { ...pathFirst(fakeBin), ORCA_CLI_COMMAND: 'orca', SCREEN_READER_LOG: log })
  assert.notEqual(make.status, 0, make.output)
  assert.match(make.stderr, /CLI Orca «orca» без пути на Linux — экранный диктор GNOME/)
  assert.equal(existsSync(log), false, 'make test запустил голый orca')
})
