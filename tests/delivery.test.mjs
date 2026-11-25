// Delivery of the plugin folder (Ф14, К14.4): a clean export of the commit passes `orca plugin inspect`, and so does the
// folder after the usual preparation of a worktree (`setup` of orca.yaml) and after the preparation command of README:
// no symlinks in it, and the full `make test` is green there.
//
// Everything runs in clean exports of HEAD in temporary directories (commit first: uncommitted changes are not in
// them). npm runs offline, from the cache the worktree's own preparation filled: no network. The inner `make test`
// records nothing and skips these tests (NESTED_RUN), so it runs every other step and test once.
import { assert, test } from 'orca/testing'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findCommand } from '../scripts/tools.mjs'
import {
  NESTED_RUN,
  exportHead,
  inspect,
  nestedRun,
  offlineNpmEnv,
  orcaYamlScripts,
  readmePrepareCommand,
  run,
  runOrcaHook,
  symlinksIn,
  tempDir,
  testEnv,
} from './helpers.mjs'

const windows = process.platform === 'win32'

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

// The folder after a preparation: TypeScript installed, no symlinks, inspect passes, and the full `make test` is green.
function assertPreparedFolder(dir, when, t) {
  assert.ok(existsSync(join(dir, 'node_modules', 'typescript', 'bin', 'tsc')), `${when}: TypeScript не установлен`)
  assert.deepEqual(symlinksIn(dir), [], `${when}: симлинки в папке плагина`)
  assertInspectPasses(dir, when)

  if (findCommand('make') === null && windows) {
    // The full test command of this project is `make test`; on Windows without make it cannot run here.
    t.diagnostic(`${when}: make не найден, полный make test не запускался`)
    return
  }
  const make = run('make', ['test', 'TEST_RESULT_DIR='], { cwd: dir, env: testEnv({ [NESTED_RUN]: '1' }) })
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

deliveryTest('К14.4 (setup): после setup из orca.yaml нет симлинков, plugin inspect проходит и полный make test зелёный', (temp, t) => {
  const dir = exportHead(temp)
  const { setup } = orcaYamlScripts(readFileSync(join(dir, 'orca.yaml'), 'utf8'))
  const result = runOrcaHook('setup', setup, dir, offlineNpmEnv())
  assert.equal(result.status, 0, `setup из orca.yaml:\n${result.output}`)
  assertPreparedFolder(dir, 'после setup', t)
})

deliveryTest('К14.4 (README): после команды подготовки из README нет симлинков, plugin inspect проходит и полный make test зелёный', (temp, t) => {
  const [program, ...args] = readmePrepareCommand()
  assert.equal(program, 'npm')
  const dir = exportHead(temp)
  const result = run(program, args, { cwd: dir, env: offlineNpmEnv() })
  assert.equal(result.status, 0, `команда подготовки из README:\n${result.output}`)
  assertPreparedFolder(dir, 'после команды из README', t)
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
