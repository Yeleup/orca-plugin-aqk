// The GitHub Actions workflow of the plugin (Ф14, К14.3, К14.6): .github/workflows/plugin.yml on ubuntu-latest,
// macos-latest and windows-latest installs Orca's CLI of exactly the minimum version of engines.orca from that Orca
// release's package (scripts/ci.mjs install-orca), runs `plugin validate`, the type check and `plugin test` on it and
// `plugin inspect` on a clean export of the commit; it prepares the checkout and cleans up with `setup` and `archive`
// of orca.yaml the way Orca runs them — on Windows through a .cmd file (scripts/ci.mjs hook).
//
// Here: the workflow file read as GitHub reads it; its steps run on this machine with a fake Orca release (fake curl,
// unpack tools, Electron and CLI — no network); the commands of scripts/ci.mjs run in temporary copies with changed
// manifests and orca.yaml. The run in Actions itself is the owner's (Actions are the owner's to enable).
import { assert, test } from 'orca/testing'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ORCA_RELEASES, orcaPackage } from '../scripts/ci.mjs'
import { orcaHookInvocation } from '../scripts/orca-hooks.mjs'
import { findCommand } from '../scripts/tools.mjs'
import {
  NESTED_RUN,
  commitAll,
  exportHead,
  nestedRun,
  offlineNpmEnv,
  orca,
  orcaCli,
  orcaHookRunner,
  orcaYamlScripts,
  pluginRoot,
  readJson,
  run,
  symlinksIn,
  tempDir,
  testEnv,
  writeExecutable,
} from './helpers.mjs'
import { readWorkflow, runJob, runsOn } from './workflow.mjs'

const windows = process.platform === 'win32'
const pathKey = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
const SYSTEMS = ['ubuntu-latest', 'macos-latest', 'windows-latest']
const RUNNER_OS = { 'ubuntu-latest': 'Linux', 'macos-latest': 'macOS', 'windows-latest': 'Windows' }

// The minimum version of engines.orca, read here on its own: `>=x.y.z` → x.y.z.
function minimumOf(manifest) {
  const match = /^>=(\d+\.\d+\.\d+)$/.exec(manifest.engines?.orca ?? '')
  assert.ok(match, `engines.orca ${JSON.stringify(manifest.engines?.orca)}: не >=x.y.z`)
  return match[1]
}

// The asset of Orca's release `v<version>` for a system: the packages Orca publishes (https://github.com/stablyai/orca
// /releases) — the .deb for Linux, the .zip of Orca.app for macOS, the setup .exe for Windows.
const RELEASE_ASSETS = {
  'linux-x64': (v) => `orca-ide_${v}_amd64.deb`,
  'linux-arm64': (v) => `orca-ide_${v}_arm64.deb`,
  'darwin-arm64': (v) => `Orca-${v}-arm64-mac.zip`,
  'darwin-x64': (v) => `Orca-${v}-mac.zip`,
  'win32-x64': () => 'orca-windows-setup.exe',
}

function releaseUrl(version, platform = process.platform, arch = process.arch) {
  return `https://github.com/stablyai/orca/releases/download/v${version}/${RELEASE_ASSETS[`${platform}-${arch}`](version)}`
}

// A test that runs processes of its own (installs, hooks, the workflow's steps): it skips in the inner `make test` and
// `plugin test` runs the delivery tests and К14.6 start, which run every other test once already.
function outerTest(name, body) {
  test(name, (t) => {
    if (nestedRun) {
      t.skip('внутренний прогон: эти проверки ведёт внешний')
      return
    }
    const temp = tempDir('ci')
    try {
      return body(temp.dir, t)
    } finally {
      temp.remove()
    }
  })
}

// The lines of the `run` scripts of the workflow's job that run on `runnerOs`, in order, each with its step.
function scriptLines(job, runnerOs) {
  const lines = []
  for (const [index, step] of job.steps.entries()) {
    if (step.run === undefined || !runsOn(step, runnerOs)) continue
    for (const line of step.run.split('\n')) if (line.trim() !== '') lines.push({ line: line.trim(), index, step })
  }
  return lines
}

// The position of the first line equal to `wanted` (or matching it), after position `after`.
function lineAfter(lines, wanted, after, what) {
  const found = lines.findIndex((entry, i) => i > after && (wanted instanceof RegExp ? wanted.test(entry.line) : entry.line === wanted))
  assert.ok(found >= 0, `${what}: нет «${wanted}» после строки ${after}:\n${lines.map((l) => l.line).join('\n')}`)
  return found
}

// A fake Orca release on PATH, for `scripts/ci.mjs install-orca`: curl "downloads" the package (a note of its URL) and
// the unpack tool of this system (dpkg-deb, ditto, 7z — for 7z an installer with its app as an inner .7z, as Orca's
// setup.exe for Windows) lays out an Orca package: the Electron executable where Orca's has it and the CLI's entry point
// resources/app.asar.unpacked/out/cli/index.js. The fake Electron runs only in Node mode (ELECTRON_RUN_AS_NODE=1): it is
// Node itself (a shell script running Node, a copy of node.exe on Windows). The fake CLI logs every call (its arguments,
// directory, ELECTRON_RUN_AS_NODE, NODE_OPTIONS; for `plugin inspect` the files of the folder and its README) to
// FAKE_ORCA_LOG, answers `--version` with the version of the release URL (or FAKE_ORCA_VERSION), hands `plugin types` to
// the real CLI (REAL_ORCA_CLI) when one is given, and exits 0.
function fakeOrcaRelease(temp) {
  const dir = join(temp, 'fake-release')
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const node = findCommand('node') ?? process.execPath
  const tools = join(dir, 'fake-tools.mjs')
  writeFileSync(tools, FAKE_TOOLS.replace('__FAKE_CLI__', JSON.stringify(FAKE_CLI)), 'utf8')
  const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`
  for (const tool of ['curl', 'dpkg-deb', 'ditto', '7z']) {
    writeExecutable(bin, tool, {
      sh: `#!/bin/sh\nexec ${quote(node)} ${quote(tools)} ${tool} "$@"\n`,
      cmd: `@echo off\n"${node}" "${tools}" ${tool} %*\nexit /b %errorlevel%\n`,
    })
  }
  const toolsLog = join(dir, 'tools.log')
  const cliLog = join(dir, 'cli.log')
  return {
    bin,
    env: { FAKE_TOOLS_LOG: toolsLog, FAKE_ORCA_LOG: cliLog, FAKE_NODE: node },
    toolCalls: () => jsonLines(toolsLog),
    cliCalls: () => jsonLines(cliLog),
  }
}

function jsonLines(file) {
  return existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : []
}

const FAKE_TOOLS = `import { appendFileSync, chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
const [tool, ...args] = process.argv.slice(2)
appendFileSync(process.env.FAKE_TOOLS_LOG, JSON.stringify({ tool, args }) + '\\n', 'utf8')
if (tool === 'curl') {
  writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify({ url: args[args.length - 1] }))
  process.exit(0)
}
let file, dir
if (tool === 'dpkg-deb') [, file, dir] = args
else if (tool === 'ditto') [, , file, dir] = args
else { dir = args.find((a) => a.startsWith('-o')).slice(2); file = args[args.length - 1] }
const pkg = JSON.parse(readFileSync(file, 'utf8'))
const version = process.env.FAKE_ORCA_VERSION || /\\/download\\/v([^/]+)\\//.exec(pkg.url)[1]
const node = process.env.FAKE_NODE
function app(resources, electron) {
  const cli = join(resources, 'app.asar.unpacked', 'out', 'cli')
  mkdirSync(cli, { recursive: true })
  writeFileSync(join(cli, 'index.js'), __FAKE_CLI__)
  writeFileSync(join(cli, 'version.txt'), version)
  mkdirSync(dirname(electron), { recursive: true })
  if (process.platform === 'win32') {
    copyFileSync(node, electron)
  } else {
    const quoted = "'" + node.replaceAll("'", "'\\\\''") + "'"
    writeFileSync(electron, '#!/bin/sh\\n[ "$ELECTRON_RUN_AS_NODE" = 1 ] || { echo "fake Electron: not in Node mode" >&2; exit 97; }\\nexec ' + quoted + ' "$@"\\n')
    chmodSync(electron, 0o755)
  }
}
if (tool === 'dpkg-deb') {
  app(join(dir, 'opt', 'Orca', 'resources'), join(dir, 'opt', 'Orca', 'orca-ide'))
  mkdirSync(join(dir, 'usr', 'share', 'doc', 'orca-ide'), { recursive: true })
} else if (tool === 'ditto') {
  app(join(dir, 'Orca.app', 'Contents', 'Resources'), join(dir, 'Orca.app', 'Contents', 'MacOS', 'Orca'))
} else if (pkg.inner) {
  app(join(dir, 'resources'), join(dir, 'Orca.exe'))
} else {
  mkdirSync(join(dir, '$PLUGINSDIR'), { recursive: true })
  writeFileSync(join(dir, '$PLUGINSDIR', 'app-64.7z'), JSON.stringify({ ...pkg, inner: true }))
}
`

const FAKE_CLI = `const { appendFileSync, existsSync, readFileSync, readdirSync } = require('node:fs')
const { join, relative } = require('node:path')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
const call = { args, cwd: process.cwd(), electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null, nodeOptions: process.env.NODE_OPTIONS ?? null }
if (args[0] === 'plugin' && args[1] === 'inspect') {
  const dir = args[2]
  const files = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else files.push(relative(dir, path).split('\\\\').join('/'))
    }
  }
  walk(dir)
  call.files = files.sort()
  call.readme = existsSync(join(dir, 'README.md')) ? readFileSync(join(dir, 'README.md'), 'utf8') : null
}
if (process.env.FAKE_ORCA_LOG) appendFileSync(process.env.FAKE_ORCA_LOG, JSON.stringify(call) + '\\n', 'utf8')
if (args.length === 1 && args[0] === '--version') {
  process.stdout.write(readFileSync(join(__dirname, 'version.txt'), 'utf8') + '\\n')
  process.exit(0)
}
const real = process.env.REAL_ORCA_CLI
if (real && args[0] === 'plugin' && args[1] === 'types') {
  const result = spawnSync(real, args, { stdio: 'inherit', env: { ...process.env, ORCA_CLI_COMMAND: real } })
  process.exit(result.status ?? 1)
}
process.exit(0)
`

// A copy of the plugin's CI commands (scripts/) in `temp`, with `manifest` and `orcaYaml` of its own.
function ciCopy(temp, { manifest, orcaYaml } = {}) {
  const dir = join(temp, 'plugin')
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  for (const name of ['ci.mjs', 'orca-hooks.mjs', 'tools.mjs', 'setup.mjs']) {
    copyFileSync(join(pluginRoot, 'scripts', name), join(dir, 'scripts', name))
  }
  writeFileSync(join(dir, 'orca-plugin.json'), JSON.stringify(manifest ?? readJson(join(pluginRoot, 'orca-plugin.json')), null, 2))
  writeFileSync(join(dir, 'orca.yaml'), orcaYaml ?? readFileSync(join(pluginRoot, 'orca.yaml'), 'utf8'))
  return dir
}

// The environment of a run of the workflow's commands here: the test's own, without the CLI the enclosing run chose,
// without the Actions files of an enclosing run in Actions, and without the ELECTRON_RUN_AS_NODE these tests inherit
// from the Orca CLI that runs them (only the installed CLI's launcher may set it), plus `extra`. It is an inner run
// (NESTED_RUN): a `plugin test` the commands reach never starts these tests again.
function ciEnv(extra = {}) {
  const env = offlineNpmEnv({ [NESTED_RUN]: '1' })
  const own = ['ORCA_CLI_COMMAND', 'ELECTRON_RUN_AS_NODE', 'GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY', 'RUNNER_TEMP']
  for (const name of own) {
    delete env[name]
  }
  return { ...env, ...extra }
}

const manifest = readJson(join(pluginRoot, 'orca-plugin.json'))
const workflow = readWorkflow()
const job = workflow.jobs?.plugin

test('К14.3 (workflow): матрица ubuntu-latest, macos-latest и windows-latest; на каждой CLI Orca ставит scripts/ci.mjs install-orca, на нём — plugin validate, проверка типов, plugin test и plugin inspect чистой выгрузки коммита', () => {
  assert.ok(workflow.on && 'push' in workflow.on && 'pull_request' in workflow.on, 'workflow не запускается на push и pull_request')
  assert.deepEqual(Object.keys(workflow.jobs), ['plugin'])
  assert.deepEqual(Object.keys(job.strategy.matrix), ['os'], 'в матрице только os, без include и exclude')
  assert.deepEqual([...job.strategy.matrix.os].sort(), [...SYSTEMS].sort())
  assert.equal(job['runs-on'], '${{ matrix.os }}')
  assert.equal(job.defaults?.run?.shell, 'bash')

  const install = job.steps.findIndex((step) => step.run === 'node scripts/ci.mjs install-orca "$RUNNER_TEMP/orca"')
  assert.ok(install >= 0, 'нет шага node scripts/ci.mjs install-orca')
  for (const system of SYSTEMS) {
    const lines = scriptLines(job, RUNNER_OS[system])
    const what = `${system}`
    // The CLI comes from install-orca alone: no step sets ORCA_CLI_COMMAND, none uses it before the install.
    assert.ok(!lines.some((entry) => /ORCA_CLI_COMMAND\s*=/.test(entry.line)), `${what}: шаг задаёт ORCA_CLI_COMMAND сам`)
    const installed = lineAfter(lines, 'node scripts/ci.mjs install-orca "$RUNNER_TEMP/orca"', -1, what)
    assert.ok(!lines.slice(0, installed).some((entry) => entry.line.includes('ORCA_CLI_COMMAND')), `${what}: CLI до установки`)
    const validate = lineAfter(lines, '"$ORCA_CLI_COMMAND" plugin validate .', installed, what)
    const types = lineAfter(lines, '"$ORCA_CLI_COMMAND" plugin types .', validate, what)
    const tsc = lineAfter(lines, 'node node_modules/typescript/bin/tsc -p .', types, what)
    assert.equal(lines[tsc].index, lines[types].index, `${what}: tsc не в шаге plugin types`)
    const pluginTest = lineAfter(lines, '"$ORCA_CLI_COMMAND" plugin test .', tsc, what)
    const archive = lineAfter(lines, /^git archive --format=tar HEAD \| tar -x -f - -C "\$export_dir"$/, pluginTest, what)
    const inspect = lineAfter(lines, '"$ORCA_CLI_COMMAND" plugin inspect "$export_dir"', archive, what)
    assert.equal(lines[inspect].index, lines[archive].index, `${what}: inspect не той выгрузки`)
  }
})

test('К14.3 (пакеты): CLI Orca — из релиза v<engines.orca> Orca, пакет системы раннера: .deb для Linux, Orca.app для macOS, setup.exe для Windows', () => {
  const version = minimumOf(manifest)
  for (const [platform, arch] of [['linux', 'x64'], ['darwin', 'arm64'], ['win32', 'x64'], ['linux', 'arm64'], ['darwin', 'x64']]) {
    assert.equal(orcaPackage(version, platform, arch).url, releaseUrl(version, platform, arch), `${platform}-${arch}`)
  }
  assert.equal(ORCA_RELEASES, 'https://github.com/stablyai/orca/releases/download')
  assert.throws(() => orcaPackage(version, 'win32', 'arm64'), /нет пакета Orca для win32-arm64/)
})

// install-orca in a copy whose manifest asks for another minimum: the release it downloads, the CLI it writes to
// $GITHUB_ENV, and that CLI running the package's Electron in Node mode.
outerTest('К14.3 (установка): install-orca берёт версию из engines.orca манифеста, ставит CLI Orca из пакета этой версии (Electron в режиме Node) и пишет его в $GITHUB_ENV', (temp) => {
  const version = '1.4.281'
  const dir = ciCopy(temp, { manifest: { ...manifest, engines: { orca: `>=${version}` } } })
  const fakes = fakeOrcaRelease(temp)
  const githubEnv = join(temp, 'github-env')
  writeFileSync(githubEnv, '')
  const target = join(temp, 'runner-temp', 'orca')
  const env = ciEnv({ ...fakes.env, [pathKey]: `${fakes.bin}${windows ? ';' : ':'}${process.env[pathKey]}`, GITHUB_ENV: githubEnv })

  const version1 = run('node', [join(dir, 'scripts', 'ci.mjs'), 'orca-version'], { env })
  assert.equal(version1.stdout.trim(), version, version1.output)

  const install = run('node', [join(dir, 'scripts', 'ci.mjs'), 'install-orca', target], { env })
  assert.equal(install.status, 0, install.output)
  const downloads = fakes.toolCalls().filter((call) => call.tool === 'curl')
  assert.equal(downloads.length, 1, JSON.stringify(fakes.toolCalls()))
  assert.equal(downloads[0].args.at(-1), releaseUrl(version))

  const launcher = join(target, 'bin', { linux: 'orca-ide', darwin: 'orca', win32: 'orca.cmd' }[process.platform])
  assert.equal(readFileSync(githubEnv, 'utf8'), `ORCA_CLI_COMMAND=${launcher}\n`)
  // The install checked the version of the CLI; the CLI runs under the package's Electron in Node mode, NODE_OPTIONS
  // moved aside as Orca's own launcher does.
  assert.deepEqual(fakes.cliCalls().map((call) => call.args), [['--version']])
  const validate = run(launcher, ['plugin', 'validate', '.'], { cwd: dir, env: { ...env, NODE_OPTIONS: '--no-warnings' } })
  assert.equal(validate.status, 0, validate.output)
  const [, call] = fakes.cliCalls()
  assert.deepEqual(call.args, ['plugin', 'validate', '.'])
  assert.equal(realpathSync.native(call.cwd), realpathSync.native(dir))
  assert.equal(call.electronRunAsNode, '1')
  assert.equal(call.nodeOptions, null)
})

outerTest('К14.3 (установка, контроль): CLI в пакете не той версии или engines.orca не минимум — install-orca выходит с ошибкой, $GITHUB_ENV пуст', (temp) => {
  const dir = ciCopy(temp, { manifest: { ...manifest, engines: { orca: '>=1.4.281' } } })
  const fakes = fakeOrcaRelease(temp)
  const githubEnv = join(temp, 'github-env')
  writeFileSync(githubEnv, '')
  const env = ciEnv({ ...fakes.env, [pathKey]: `${fakes.bin}${windows ? ';' : ':'}${process.env[pathKey]}`, GITHUB_ENV: githubEnv })

  const other = run('node', [join(dir, 'scripts', 'ci.mjs'), 'install-orca', join(temp, 'orca-1')], {
    env: { ...env, FAKE_ORCA_VERSION: '1.4.282' },
  })
  assert.equal(other.status, 1, other.output)
  assert.match(other.stderr, /сообщает версию «1\.4\.282».*нужна 1\.4\.281/)
  assert.equal(readFileSync(githubEnv, 'utf8'), '')

  const calls = fakes.toolCalls().length
  writeFileSync(join(dir, 'orca-plugin.json'), JSON.stringify({ ...manifest, engines: { orca: '^1.4.281' } }))
  const range = run('node', [join(dir, 'scripts', 'ci.mjs'), 'install-orca', join(temp, 'orca-2')], { env })
  assert.equal(range.status, 1, range.output)
  assert.match(range.stderr, /engines\.orca "\^1\.4\.281".*не минимум >=x\.y\.z/)
  assert.equal(fakes.toolCalls().length, calls, 'скачивание без минимальной версии')
  assert.equal(readFileSync(githubEnv, 'utf8'), '')
})

// The workflow's steps for Linux, run here as the runner runs them, in a local git repository of the commit's export
// with a change that is not committed and a file that is not in the commit. What the fake CLI logs is what the
// workflow ran on the CLI it installed.
outerTest('К14.3 (шаги): шаги workflow ставят CLI Orca минимальной версии из engines.orca и гоняют на нём plugin validate, проверку типов, plugin test и plugin inspect чистой выгрузки коммита', (temp, t) => {
  if (process.platform !== 'linux') {
    t.skip('шаги workflow с подделками гоняет Linux; на macOS и Windows их выполняет сам прогон в Actions')
    return
  }
  const real = findCommand(orcaCli())
  assert.ok(real, `CLI Orca не найден: ${orcaCli()}`)
  const dir = exportHead(temp)
  commitAll(dir)
  const committedReadme = readFileSync(join(dir, 'README.md'), 'utf8')
  writeFileSync(join(dir, 'README.md'), `${committedReadme}\nНе закоммичено.\n`)
  writeFileSync(join(dir, 'scratch.txt'), 'не в коммите\n')
  const fakes = fakeOrcaRelease(temp)
  const runnerTemp = join(temp, 'runner-temp')
  mkdirSync(runnerTemp)

  // The workflow of the commit, run in the commit's checkout.
  const committedJob = readWorkflow(join(dir, '.github', 'workflows', 'plugin.yml')).jobs.plugin
  const records = runJob(committedJob, {
    runnerOs: 'Linux',
    cwd: dir,
    runnerTemp,
    env: ciEnv({ ...fakes.env, [pathKey]: `${fakes.bin}:${process.env[pathKey]}`, REAL_ORCA_CLI: real }),
  })
  for (const record of records.filter((r) => r.ran)) {
    assert.equal(record.status, 0, `шаг «${record.step.name}»:\n${record.output}`)
  }
  assert.deepEqual(
    records.filter((r) => !r.ran).map((r) => [r.step.name, r.reason]),
    committedJob.steps.filter((step) => step.uses !== undefined || !runsOn(step, 'Linux')).map((step) => [step.name, step.uses ? 'uses' : 'if']),
  )
  assert.equal(records.length, committedJob.steps.length, 'не все шаги дошли')

  // The release of exactly the manifest's minimum version, the package of this system.
  const version = minimumOf(readJson(join(dir, 'orca-plugin.json')))
  const downloads = fakes.toolCalls().filter((call) => call.tool === 'curl').map((call) => call.args.at(-1))
  assert.deepEqual(downloads, [releaseUrl(version)])

  // Every call of the CLI went through the installed one: the package's Electron in Node mode.
  const calls = fakes.cliCalls()
  const inspected = calls.at(-1)
  assert.deepEqual(calls.map((call) => call.args), [
    ['--version'],
    ['plugin', 'validate', '.'],
    ['plugin', 'types', '.'],
    ['plugin', 'test', '.'],
    ['plugin', 'inspect', inspected.args[2]],
  ])
  for (const call of calls) assert.equal(call.electronRunAsNode, '1', JSON.stringify(call))
  for (const call of calls.slice(1, 4)) assert.equal(realpathSync.native(call.cwd), realpathSync.native(dir))

  // setup of orca.yaml prepared the checkout (TypeScript without bin links), the type check ran on this CLI's typings.
  assert.ok(existsSync(join(dir, 'node_modules', 'typescript', 'bin', 'tsc')), 'setup не поставил TypeScript')
  assert.deepEqual(symlinksIn(join(dir, 'node_modules')), [])
  assert.ok(existsSync(join(dir, '.orca', 'types', 'tsconfig.json')), 'plugin types не писал типы')
  const typeCheck = records.find((r) => r.ran && r.step.run.includes('plugin types'))
  assert.match(typeCheck.stdout, /tsc: типы в порядке/)

  // inspect got a clean export of the commit: its files exactly, as committed — no node_modules, .orca or other files.
  const exportDir = inspected.args[2]
  assert.ok(relative(dir, exportDir).startsWith('..'), `выгрузка внутри чекаута: ${exportDir}`)
  const committed = run('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: dir, env: testEnv() })
  assert.deepEqual(inspected.files, committed.stdout.split('\n').filter(Boolean).sort())
  assert.equal(inspected.readme, committedReadme)

  const archive = records.at(-1)
  assert.match(archive.step.run, /^node scripts\/ci\.mjs hook archive\n?$/)
  assert.match(archive.stdout, /orca-plugin-aqk archive: nothing to clean up/)
})

test('К14.6 (workflow): на windows-latest setup и archive из orca.yaml идут через scripts/ci.mjs hook, setup — после установки CLI и до plugin test, archive — после', () => {
  assert.ok(job.strategy.matrix.os.includes('windows-latest'))
  const lines = scriptLines(job, 'Windows')
  const installed = lineAfter(lines, 'node scripts/ci.mjs install-orca "$RUNNER_TEMP/orca"', -1, 'windows-latest')
  const setup = lineAfter(lines, 'node scripts/ci.mjs hook setup', installed, 'windows-latest')
  const pluginTest = lineAfter(lines, '"$ORCA_CLI_COMMAND" plugin test .', setup, 'windows-latest')
  lineAfter(lines, 'node scripts/ci.mjs hook archive', pluginTest, 'windows-latest')
  // Nothing else prepares the checkout: setup of orca.yaml is the preparation the tests run on.
  assert.ok(!lines.some((entry) => /^npm (ci|install)\b/.test(entry.line)), 'подготовка не через setup')
})

test('К14.6 (.cmd): на Windows scripts/ci.mjs hook пишет строки скрипта orca.yaml в .cmd так, как Orca 1.4.273, и запускает его cmd.exe', () => {
  const hooks = orcaYamlScripts(readFileSync(join(pluginRoot, 'orca.yaml'), 'utf8'))
  const comspec = 'C:\\Windows\\system32\\cmd.exe'
  const runnerDir = 'C:\\Users\\Ci Test\\AppData\\Local\\Temp\\orca-hook-setup-x'
  const setup = orcaHookInvocation('setup', hooks.setup, runnerDir, 'win32', comspec)
  assert.ok(setup.file.endsWith('setup-runner.cmd'), setup.file)
  assert.equal(
    setup.text,
    '@echo off\r\nsetlocal EnableExtensions DisableDelayedExpansion\r\n' +
      'call node scripts/setup.mjs\r\nif errorlevel 1 exit /b %errorlevel%\r\n\r\n',
  )
  assert.equal(setup.program, comspec)
  assert.deepEqual(setup.args, ['/d', '/s', '/c', `""${setup.file}""`])
  assert.equal(setup.windowsVerbatimArguments, true)
  const archive = orcaHookInvocation('archive', hooks.archive, runnerDir, 'win32', comspec)
  assert.equal(archive.text, orcaHookRunner(hooks.archive, 'win32'))
  assert.match(archive.text, /^@echo off\r\n.*\r\ncall echo orca-plugin-aqk archive: [^\r\n]+\r\nif errorlevel 1 exit \/b %errorlevel%\r\n/s)
  // On macOS and Linux Orca runs the same lines through bash with set -e.
  const bash = orcaHookInvocation('setup', hooks.setup, '/tmp/orca-hook-setup-x', 'linux')
  assert.deepEqual([bash.program, bash.args, bash.text], ['bash', [bash.file], '#!/usr/bin/env bash\nset -e\nnode scripts/setup.mjs\n\n'])
})

// scripts/ci.mjs hook in a copy whose orca.yaml has lines of its own: they run in the plugin folder, in order, from the
// runner file of this system (.cmd through cmd.exe on Windows), and the first failing line stops the hook with its code.
outerTest('К14.6 (строки orca.yaml): scripts/ci.mjs hook запускает строки самого orca.yaml так, как Orca на этой системе, и останавливается на первой ошибке', (temp) => {
  const orcaYaml = 'scripts:\n  setup: |\n    node mark.mjs one\n    node mark.mjs two\n' +
    '  archive: |\n    node mark.mjs one\n    node fail.mjs\n    node mark.mjs three\n'
  const dir = ciCopy(temp, { orcaYaml })
  writeFileSync(join(dir, 'mark.mjs'), "import { appendFileSync } from 'node:fs'\n" +
    "appendFileSync(process.env.MARK_LOG, JSON.stringify([process.argv[2], process.cwd()]) + '\\n')\n")
  writeFileSync(join(dir, 'fail.mjs'), 'process.exit(3)\n')
  const log = join(temp, 'marks.log')
  const env = ciEnv({ MARK_LOG: log })
  const hooks = orcaYamlScripts(orcaYaml)
  const marks = () => jsonLines(log).map(([mark, cwd]) => [mark, realpathSync.native(cwd)])
  const where = realpathSync.native(dir)

  const setup = run('node', [join(dir, 'scripts', 'ci.mjs'), 'hook', 'setup'], { cwd: temp, env })
  assert.equal(setup.status, 0, setup.output)
  assert.deepEqual(marks(), [['one', where], ['two', where]])
  const runnerName = windows ? 'setup-runner.cmd' : 'setup-runner.sh'
  const shown = new RegExp(`^--- (.*[\\\\/]${runnerName.replace('.', '\\.')})$`, 'm').exec(setup.stdout)
  assert.ok(shown, `нет файла ${runnerName}:\n${setup.output}`)
  assert.ok(setup.stdout.includes(`${shown[0]}\n${orcaHookRunner(hooks.setup).replaceAll('\r\n', '\n')}---`), setup.output)
  if (windows) assert.match(setup.stdout, /как его запускает Orca: \S*cmd\.exe \/d \/s \/c ""[^"]+setup-runner\.cmd""/i)

  const archive = run('node', [join(dir, 'scripts', 'ci.mjs'), 'hook', 'archive'], { cwd: temp, env })
  assert.equal(archive.status, 3, archive.output)
  assert.deepEqual(marks(), [['one', where], ['two', where], ['one', where]])

  const missing = run('node', [join(dir, 'scripts', 'ci.mjs'), 'hook', 'deploy'], { cwd: temp, env })
  assert.equal(missing.status, 1, missing.output)
  assert.match(missing.stderr, /в orca\.yaml нет скрипта deploy; есть: setup, archive/)
})

// The workflow's preparation and cleanup on a clean export of the commit, by the same command: setup of orca.yaml (on
// Windows through .cmd and cmd.exe), then `plugin test` of the prepared folder passes, then archive exits with 0. npm
// runs offline, from the cache the worktree's own preparation filled.
outerTest('К14.6: setup из orca.yaml так, как его запускает workflow (на Windows — через .cmd), после него plugin test проходит; archive выходит с кодом 0', (temp) => {
  const dir = exportHead(temp)
  commitAll(dir)
  const ci = join(dir, 'scripts', 'ci.mjs')
  const setup = run('node', [ci, 'hook', 'setup'], { cwd: dir, env: ciEnv({ ORCA_CLI_COMMAND: orcaCli() }) })
  assert.equal(setup.status, 0, setup.output)
  assert.match(setup.stdout, windows ? /--- \S*setup-runner\.cmd\n@echo off\n/ : /--- \S*setup-runner\.sh\n#!\/usr\/bin\/env bash\n/)
  assert.ok(existsSync(join(dir, 'node_modules', 'typescript', 'bin', 'tsc')), `setup не поставил TypeScript:\n${setup.output}`)

  const pluginTest = orca(['plugin', 'test', '.'], { cwd: dir, env: testEnv({ [NESTED_RUN]: '1' }) })
  assert.equal(pluginTest.status, 0, `plugin test после setup:\n${pluginTest.output}`)
  assert.match(pluginTest.stdout, /^# fail 0$/m, pluginTest.output)
  assert.ok(Number(/^# pass (\d+)$/m.exec(pluginTest.stdout)?.[1] ?? 0) > 0, pluginTest.output)
  assert.match(pluginTest.stdout, /^ok \d+ - the worker starts without host calls or refusals/m, pluginTest.output)

  const archive = run('node', [ci, 'hook', 'archive'], { cwd: dir, env: ciEnv() })
  assert.equal(archive.status, 0, archive.output)
  assert.match(archive.stdout, /orca-plugin-aqk archive: nothing to clean up/)
  assert.match(archive.stdout, /orca\.yaml archive: код 0/)
})
