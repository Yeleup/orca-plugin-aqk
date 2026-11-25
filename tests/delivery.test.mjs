// Delivery of the plugin folder (Ф14, К14.4): a clean export of the commit passes `orca plugin inspect`, and so does the
// folder after the usual preparation of a worktree (`setup` of orca.yaml) and after the preparation command of README:
// no symlinks in it, and the full `make test` is green there and records its result for the queue. Then the ways
// `make test` itself is started: the chosen CLI, an enclosing make, Windows paths, an old bash, the screen reader.
//
// Everything runs in clean exports of HEAD in temporary directories (commit first: uncommitted changes are not in
// them); a prepared tree is a local git repository of that export, and its `make test` records into a temporary
// directory. npm runs offline, from the cache the worktree's own preparation filled: no network. The inner `make test`
// skips these tests (NESTED_RUN), so it runs every other step and test once.
import { assert, test } from 'orca/testing'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { findCommand } from '../scripts/tools.mjs'
import {
  NESTED_RUN,
  commitAll,
  exportHead,
  inspect,
  nestedRun,
  offlineNpmEnv,
  orcaCli,
  orcaYamlScripts,
  pluginRoot,
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

// `make test` in `dir`, the inner run: make's own variables as `vars`; the environment of a test (`testEnv`, from
// `base`) plus `env`.
function makeTest(dir, vars, env = {}, base = process.env) {
  assert.ok(findCommand('make') !== null, 'make не найден в PATH: полный make test проверить нечем')
  return run('make', ['test', ...vars], { cwd: dir, env: testEnv({ [NESTED_RUN]: '1', ...env }, base) })
}

// The environment with `dir` first on PATH.
function pathFirst(dir) {
  return { [pathKey]: `${dir}${pathSeparator}${process.env[pathKey] ?? ''}` }
}

// A clean export of HEAD as a local git repository, prepared by the install of README: { dir, sha }.
function preparedTree(temp) {
  const dir = exportHead(temp)
  const sha = commitAll(dir)
  const install = run('npm', ['ci', '--no-audit', '--no-fund', '--no-bin-links'], { cwd: dir, env: offlineNpmEnv() })
  assert.equal(install.status, 0, install.output)
  return { dir, sha }
}

// A full green run: exit 0, every step's summary, the tests really ran (the worker's test and the manifest's passed,
// only the delivery tests skipped).
function assertGreenRun(make, when) {
  assert.equal(make.status, 0, `make test ${when}:\n${make.output}`)
  for (const summary of ['orca plugin validate: манифест в порядке', 'tsc: типы в порядке', '# fail 0']) {
    assert.ok(make.stdout.includes(summary), `make test ${when}: нет «${summary}»:\n${make.output}`)
  }
  const passed = Number(/^# pass (\d+)$/m.exec(make.stdout)?.[1] ?? 0)
  assert.ok(passed > 0, `make test ${when}: ни один тест не прошёл:\n${make.output}`)
  for (const name of ['the worker starts without host calls or refusals', 'К2.7: проверка манифеста CLI Orca']) {
    assert.match(make.stdout, new RegExp(`^ok \\d+ - ${name}`, 'm'), `make test ${when}:\n${make.output}`)
  }
}

// The record the queue merges by: exactly one, a full green unfiltered run of this commit on a clean tree.
function assertFullGreenRecord(results, sha, make, when) {
  const records = recordsOf(results, sha)
  assert.equal(records.length, 1, `make test ${when}: записей итога ${records.length}:\n${make.output}`)
  const [record] = records
  assert.equal(record.sha, sha)
  assert.deepEqual(
    { full: record.full, green: record.green, clean: record.clean, filtered: record.filtered, exit: record.exit },
    { full: true, green: true, clean: true, filtered: false, exit: 0 },
    JSON.stringify(record),
  )
  assert.equal(record.test_args, '--compact')
  assert.deepEqual(record.steps.map((step) => [step.name, step.exit]), [['validate', 0], ['types', 0], ['plugin', 0]])
}

// The folder after a preparation: TypeScript installed, no symlinks, inspect passes, and the full `make test` is green
// and writes a full green record of the tree's commit.
function assertPreparedFolder(dir, sha, temp, when) {
  assert.ok(existsSync(join(dir, 'node_modules', 'typescript', 'bin', 'tsc')), `${when}: TypeScript не установлен`)
  assert.deepEqual(symlinksIn(dir), [], `${when}: симлинки в папке плагина`)
  assertInspectPasses(dir, when)

  const results = join(temp, 'test-results')
  const make = makeTest(dir, [`TEST_RESULT_DIR=${results}`])
  assertGreenRun(make, when)
  assertFullGreenRecord(results, sha, make, when)

  assert.deepEqual(symlinksIn(dir), [], `${when}, после make test: симлинки в папке плагина`)
  assertInspectPasses(dir, `${when}, после make test`)
}

// A stand-in for Orca's CLI at `dir/name`: it logs each call (its arguments as a list and the ORCA_CLI_COMMAND it got,
// JSON lines in UTF-8, to ORCA_CALLS_LOG), then runs the real CLI with the same arguments and environment and exits
// with its code. ORCA_CLI_COMMAND stays the stand-in, so `orca plugin test` hands it on to the tests it runs.
function cliWrapper(temp, dir, name) {
  const script = join(temp, 'orca-wrapper.mjs')
  writeFileSync(
    script,
    `import { appendFileSync } from 'node:fs'\n` +
      `import { run } from ${JSON.stringify(pathToFileURL(join(pluginRoot, 'tests', 'helpers.mjs')).href)}\n` +
      `const args = process.argv.slice(2)\n` +
      `appendFileSync(process.env.ORCA_CALLS_LOG, JSON.stringify({ args, cli: process.env.ORCA_CLI_COMMAND ?? null }) + '\\n', 'utf8')\n` +
      `const real = process.env.REAL_ORCA_CLI\n` +
      `const result = run(real, args, { stdio: 'inherit' })\n` +
      `process.exit(result.status ?? 1)\n`,
    'utf8',
  )
  const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`
  return writeExecutable(dir, name, {
    sh: `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
    cmd: `@echo off\n"${process.execPath}" "${script}" %*\nexit /b %errorlevel%\n`,
  })
}

function loggedCalls(log) {
  return existsSync(log) ? readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : []
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

// One CLI for the whole run: `make test ORCA=<relative path with a blank>` runs every step and the tests' own calls of
// Orca's CLI through that CLI, as one argument and anchored to the directory make runs in, although ORCA_CLI_COMMAND
// names another CLI.
deliveryTest('make test: выбранный CLI Orca (ORCA=…, относительный путь с пробелом) — один абсолютный путь во всех шагах и в тестах', (temp) => {
  const real = findCommand(orcaCli())
  assert.ok(real, `CLI Orca не найден: ${orcaCli()}`)
  const { dir } = preparedTree(temp)
  const toolsDir = join(temp, 'Orca Tools')
  mkdirSync(toolsDir)
  const log = join(temp, 'orca-calls.log')
  const wrapper = cliWrapper(temp, toolsDir, 'orca-ide')

  // The path make gets: relative to the directory it runs in, to the file as it was created (orca-ide.cmd on Windows).
  const relativeCli = relative(dir, wrapper)
  assert.ok(!isAbsolute(relativeCli) && relativeCli.includes(' '), relativeCli)
  // On macOS and Linux make runs in the tree through a symlink, as a shell's logical PWD has it: the relative path
  // counts from the physical directory, where the kernel counts it from.
  let cwd = dir
  const logical = {}
  if (!windows) {
    mkdirSync(join(temp, 'deep'))
    cwd = join(temp, 'deep', 'tree')
    symlinkSync(dir, cwd)
    logical.PWD = cwd
  }
  const make = makeTest(cwd, ['TEST_RESULT_DIR=', `ORCA=${relativeCli}`], {
    ...logical,
    ORCA_CLI_COMMAND: real,
    REAL_ORCA_CLI: real,
    ORCA_CALLS_LOG: log,
  })
  assertGreenRun(make, `ORCA=${relativeCli}`)
  const calls = loggedCalls(log)
  const argLists = calls.map((call) => JSON.stringify(call.args))
  for (const args of [['plugin', 'validate', '.'], ['plugin', 'types', '.'], ['plugin', 'test', '.']]) {
    assert.ok(argLists.includes(JSON.stringify(args)), `шаг «${args.join(' ')}» не через ${wrapper}: ${argLists}`)
  }
  // The manifest test of the inner run, in its own process: the folder by the path Node loaded it from.
  const validate = calls.find((call) => call.args.length === 4 && call.args[1] === 'validate' && call.args[3] === '--json')
  assert.ok(validate, `тест К2.7 не через ${wrapper}: ${argLists}`)
  assert.equal(realpathSync.native(validate.args[2]), realpathSync.native(dir), `К2.7 проверяет не эту папку: ${validate.args[2]}`)
  // Every call got the chosen CLI as one absolute path to it.
  for (const call of calls) {
    assert.ok(call.cli && isAbsolute(call.cli), `ORCA_CLI_COMMAND не абсолютный: ${JSON.stringify(call)}`)
    // The same file, read as the kernel reads the path and as path.resolve reads it (findCommand does).
    for (const path of [call.cli, resolve(call.cli)]) {
      assert.ok(existsSync(path), `${path}: нет такого файла: ${JSON.stringify(call)}`)
      assert.equal(realpathSync.native(path), realpathSync.native(wrapper), JSON.stringify(call))
    }
  }
})

// An inner `make test` started under an enclosing `make test ORCA=… test_args=…` (both exported to every process
// below it): it runs unfiltered, with the CLI of ORCA_CLI_COMMAND, and records a full green run.
deliveryTest('make test внутри make test: ORCA и test_args внешнего make не доходят до вложенного прогона', (temp) => {
  const { dir, sha } = preparedTree(temp)
  const strayDir = join(temp, 'stray')
  mkdirSync(strayDir)
  const strayLog = join(temp, 'stray.log')
  const stray = writeExecutable(strayDir, 'orca-ide', {
    sh: '#!/bin/sh\nprintf "%s\\n" "$*" >> "$STRAY_LOG"\nexit 3\n',
    cmd: '@echo off\necho %*>> "%STRAY_LOG%"\nexit /b 3\n',
  })
  const enclosing = {
    ...process.env,
    ORCA: stray,
    test_args: '--compact --filter=К14.4',
    PLUGIN_ORCA_CLI: stray,
    TEST_RESULT_ARGS: '--compact --filter=К14.4',
    MAKEFLAGS: ` -- ORCA=${stray} test_args=--compact\\ --filter=К14.4`,
    MAKELEVEL: '1',
    STRAY_LOG: strayLog,
  }
  const results = join(temp, 'test-results')
  const make = makeTest(dir, [`TEST_RESULT_DIR=${results}`], {}, enclosing)
  assertGreenRun(make, 'под внешним make')
  assertFullGreenRecord(results, sha, make, 'под внешним make')
  assert.equal(existsSync(strayLog), false, `вложенный прогон взял ORCA внешнего make: ${stray}`)
})

// The recorder takes only absolute POSIX paths and ~: a native Windows results directory (C:\…) reaches it in the shell's
// form through cygpath -u (Git Bash, MSYS2). Here a stand-in cygpath maps one Windows path to a temporary directory; on
// Windows the К14.4 runs above pass native paths to the real cygpath.
deliveryTest('make test: каталог записи итога в виде Windows (C:\\…) приходит в регистратор через cygpath -u', (temp, t) => {
  if (windows) {
    t.skip('на Windows это проверяют К14.4 с настоящим cygpath')
    return
  }
  const { dir, sha } = preparedTree(temp)
  const fakeBin = join(temp, 'cygpath-bin')
  mkdirSync(fakeBin)
  const results = join(temp, 'test-results')
  const windowsResults = 'C:\\Users\\Delivery Test\\AppData\\Local\\Temp\\test-results'
  writeExecutable(fakeBin, 'cygpath', {
    sh: '#!/bin/sh\n[ "$1" = -u ] && [ "$2" = "$WINDOWS_RESULTS" ] || exit 1\nprintf "%s\\n" "$POSIX_RESULTS"\n',
    cmd: '',
  })
  const make = makeTest(dir, [`TEST_RESULT_DIR=${windowsResults}`], {
    ...pathFirst(fakeBin),
    WINDOWS_RESULTS: windowsResults,
    POSIX_RESULTS: results,
  })
  assertGreenRun(make, `TEST_RESULT_DIR=${windowsResults}`)
  assertFullGreenRecord(results, sha, make, `TEST_RESULT_DIR=${windowsResults}`)
})

// A Windows results directory that cygpath -u did not turn into a path of the shell: `make test` stops before any step
// and names the directory, instead of running as if recording were off.
deliveryTest('make test: каталог записи итога в виде Windows не преобразован (cygpath -u с ошибкой или без вывода) — отказ до шагов, без записи', (temp, t) => {
  if (windows) {
    t.skip('поддельный cygpath — сценарий POSIX')
    return
  }
  const dir = exportHead(temp)
  const windowsResults = 'C:\\Users\\Delivery Test\\AppData\\Local\\Temp\\test-results'
  const standIns = {
    'код 1 без вывода': '#!/bin/sh\nexit 1\n',
    'код 0 без вывода': '#!/bin/sh\nexit 0\n',
  }
  for (const [what, sh] of Object.entries(standIns)) {
    const fakeBin = join(temp, `cygpath-${Object.keys(standIns).indexOf(what)}`)
    mkdirSync(fakeBin)
    writeExecutable(fakeBin, 'cygpath', { sh, cmd: '' })
    const make = makeTest(dir, [`TEST_RESULT_DIR=${windowsResults}`], pathFirst(fakeBin))
    assert.notEqual(make.status, 0, `${what}:\n${make.output}`)
    assert.ok(make.stderr.includes(`«${windowsResults}»`), `${what}: нет исходного каталога:\n${make.output}`)
    assert.equal(make.stdout.trim(), '', `${what}: шаги шли:\n${make.output}`)
    assert.equal(existsSync(join(dir, 'test-results')), false, `${what}: запись в чекауте`)
  }
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

// On Linux a bare `orca` is GNOME's screen reader: `make test` refuses it as the CLI before any step runs it, also when
// an enclosing make passed its own ORCA.
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
  const enclosing = { ...process.env, ORCA: '/opt/enclosing-make/orca-ide' }
  const env = { ...pathFirst(fakeBin), ORCA_CLI_COMMAND: 'orca', SCREEN_READER_LOG: log }
  for (const vars of [['TEST_RESULT_DIR='], ['TEST_RESULT_DIR=', 'ORCA=orca']]) {
    const make = makeTest(dir, vars, env, enclosing)
    assert.notEqual(make.status, 0, make.output)
    assert.match(make.stderr, /CLI Orca «orca» без пути на Linux — экранный диктор GNOME/, make.output)
  }
  assert.equal(existsSync(log), false, 'make test запустил голый orca')
})

// The Makefile is read by the GNU Make 3.81 of macOS too: nothing that version cannot parse.
test('Makefile: только синтаксис, который читает GNU Make 3.81 (macOS)', () => {
  const lines = readFileSync(join(pluginRoot, 'Makefile'), 'utf8').split(/\r?\n/)
  const newer = [
    [/^[^\t#][^=]*:\s*(override|export|private)\s+(override|export|private)\s/, 'два модификатора у целевой переменной'],
    [/^[^\t#]*(::=|:::=)/, 'присваивание ::= (GNU Make 4.0)'],
    [/^[^\t#]*\s!=/, 'присваивание != (GNU Make 4.0)'],
    [/^\s*(undefine|private)\s/, 'undefine / private (GNU Make 3.82)'],
    [/^\.(ONESHELL|RECIPEPREFIX)\b/, '.ONESHELL / .RECIPEPREFIX (GNU Make 3.82)'],
    [/\$\((file|guile|let|intcmp)\s/, '$(file …), $(guile …), $(let …), $(intcmp …) (GNU Make 4.0+)'],
  ]
  for (const [index, line] of lines.entries()) {
    for (const [pattern, what] of newer) {
      assert.ok(!pattern.test(line), `Makefile:${index + 1}: ${what}: ${line}`)
    }
  }
})
