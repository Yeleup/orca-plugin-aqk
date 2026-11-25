// The manifest: the minimum Orca version (К2.7), Orca's own check of the manifest, the plugin's id and name (Ф14).
import { assert, test } from 'orca/testing'
import { join } from 'node:path'
import { orca, pluginRoot, readJson, testEnv } from './helpers.mjs'

const manifest = readJson(join(pluginRoot, 'orca-plugin.json'))

const NUMBER = '(0|[1-9]\\d*)'
const MINIMUM_RANGE = new RegExp(`^>=${NUMBER}\\.${NUMBER}\\.${NUMBER}$`)
const VERSION = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}$`)

// Whether Orca `version` is in `range`. Reads only the form Orca supports in engines.orca, a minimum `>=x.y.z`: no
// leading zeros, blanks, `v`, `-…` or `+…`, other operators or more than one condition, each number a safe integer.
// Anything else, a range that is not a string too, throws an error naming the range rather than answering.
function minimumAccepts(range, version) {
  const minimum = typeof range === 'string' ? MINIMUM_RANGE.exec(range) : null
  if (!minimum) throw new Error(`engines.orca ${JSON.stringify(range)}: not a minimum >=x.y.z`)
  const wanted = safeNumbers(minimum, `engines.orca ${JSON.stringify(range)}`)
  const found = typeof version === 'string' ? VERSION.exec(version) : null
  if (!found) throw new Error(`version ${JSON.stringify(version)} for engines.orca ${JSON.stringify(range)}: not x.y.z`)
  const have = safeNumbers(found, `version ${JSON.stringify(version)} for engines.orca ${JSON.stringify(range)}`)
  for (let i = 0; i < 3; i++) {
    if (have[i] !== wanted[i]) return have[i] > wanted[i]
  }
  return true
}

function safeNumbers(match, what) {
  const numbers = match.slice(1, 4).map(Number)
  if (!numbers.every(Number.isSafeInteger)) throw new Error(`${what}: a number is not a safe integer`)
  return numbers
}

test('К2.7: диапазон engines.orca манифеста по semver не принимает 1.4.272 и принимает 1.4.273', () => {
  const range = manifest.engines?.orca
  assert.equal(typeof range, 'string', 'orca-plugin.json: engines.orca')
  assert.equal(minimumAccepts(range, '1.4.272'), false, `engines.orca "${range}" принимает 1.4.272`)
  assert.equal(minimumAccepts(range, '1.4.273'), true, `engines.orca "${range}" не принимает 1.4.273`)
})

test('К2.7: проверка манифеста CLI Orca (plugin validate) проходит', () => {
  const result = orca(['plugin', 'validate', pluginRoot, '--json'], { env: testEnv() })
  assert.equal(result.status, 0, result.output)
  const answer = JSON.parse(result.stdout)
  assert.equal(answer.ok, true, result.output)
  assert.equal(answer.result.valid, true, result.output)
  assert.deepEqual(answer.result.errors, [])
})

// The range check above is the tests' own code: it compares numbers, and it reads nothing but `>=x.y.z`.
test('К2.7 (контроль): проверка диапазона читает только >=x.y.z и сравнивает числа', () => {
  for (const version of ['1.4.272', '1.4.99', '1.3.999', '0.9.0']) {
    assert.equal(minimumAccepts('>=1.4.273', version), false, `>=1.4.273 принимает ${version}`)
  }
  for (const version of ['1.4.273', '1.4.274', '1.4.1000', '1.10.0', '2.0.0']) {
    assert.equal(minimumAccepts('>=1.4.273', version), true, `>=1.4.273 не принимает ${version}`)
  }
  const refused = [
    '>=01.4.273', '>=1.04.273', '>=1.4.0273',
    '>=9007199254740993.0.0',
    '>= 1.4.273', '>=v1.4.273', '>=1.4', '>1.4.272', '=1.4.273', '1.4.273', '^1.4.273', '~1.4.273', '1.4.x', '*', '',
    '>=1.4.273 <2.0.0', '<1.0.0 || >=1.4.273', '>=1.4.273-beta', '>=1.4.273+build',
    undefined, 10404273,
  ]
  for (const range of refused) {
    assert.throws(
      () => minimumAccepts(range, '1.4.273'),
      (error) => error instanceof Error && error.message.includes(`engines.orca ${JSON.stringify(range)}`),
    )
  }
  for (const version of ['1.4', '01.4.273', 'v1.4.273', '1.4.273-rc.1']) {
    assert.throws(() => minimumAccepts('>=1.4.273', version), /not x\.y\.z/)
  }
})

test('К14.4 (манифест): в манифесте id agent-queue и имя «Agent Queue»', () => {
  assert.equal(manifest.id, 'agent-queue')
  assert.equal(manifest.name, 'Agent Queue')
})
