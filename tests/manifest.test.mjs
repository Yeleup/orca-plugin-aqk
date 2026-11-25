// The manifest: the minimum Orca version (К2.7), Orca's own check of the manifest, the plugin's id and name (Ф14).
import { assert, test } from 'orca/testing'
import { join } from 'node:path'
import { orca, pluginRoot, readJson, testEnv } from './helpers.mjs'
import { satisfies } from './semver.mjs'

const manifest = readJson(join(pluginRoot, 'orca-plugin.json'))

test('К2.7: диапазон engines.orca манифеста по semver не принимает 1.4.272 и принимает 1.4.273 и новее', () => {
  const range = manifest.engines?.orca
  assert.equal(typeof range, 'string', 'orca-plugin.json: engines.orca')
  assert.equal(satisfies('1.4.272', range), false, `engines.orca "${range}" принимает 1.4.272`)
  for (const older of ['1.4.0', '1.3.999', '0.9.0']) {
    assert.equal(satisfies(older, range), false, `engines.orca "${range}" принимает ${older}`)
  }
  for (const newer of ['1.4.273', '1.4.274', '1.5.0', '2.0.0']) {
    assert.equal(satisfies(newer, range), true, `engines.orca "${range}" не принимает ${newer}`)
  }
})

test('К2.7: проверка манифеста CLI Orca (plugin validate) проходит', () => {
  const result = orca(['plugin', 'validate', pluginRoot, '--json'], { env: testEnv() })
  assert.equal(result.status, 0, result.output)
  const answer = JSON.parse(result.stdout)
  assert.equal(answer.ok, true, result.output)
  assert.equal(answer.result.valid, true, result.output)
  assert.deepEqual(answer.result.errors, [])
})

test('К14.4 (манифест): в манифесте id agent-queue и имя «Agent Queue»', () => {
  assert.equal(manifest.id, 'agent-queue')
  assert.equal(manifest.name, 'Agent Queue')
})

// The range check above is the tests' own code: it has to answer as npm's semver does.
test('semver: диапазоны считаются как в npm semver', () => {
  const cases = [
    ['>=1.4.273', '1.4.273', true],
    ['>=1.4.273', '1.4.272', false],
    ['>1.4.273', '1.4.273', false],
    ['<=1.4.273', '1.4.273', true],
    ['<1.4.273', '1.4.273', false],
    ['=1.4.273', '1.4.273', true],
    ['1.4.273', '1.4.274', false],
    ['>= 1.4.273', '1.4.273', true],
    ['^1.4.273', '1.9.0', true],
    ['^1.4.273', '2.0.0', false],
    ['^1.4.273', '1.4.272', false],
    ['^0.2.3', '0.3.0', false],
    ['^0.0.3', '0.0.4', false],
    ['~1.4.273', '1.4.300', true],
    ['~1.4.273', '1.5.0', false],
    ['1.4.x', '1.4.0', true],
    ['1.4.x', '1.5.0', false],
    ['>1.4', '1.4.999', false],
    ['>1.4', '1.5.0', true],
    ['<=1.4', '1.4.999', true],
    ['*', '0.0.1', true],
    ['1.2.3 - 1.4', '1.4.9', true],
    ['1.2.3 - 1.4', '1.5.0', false],
    ['>=1.4.273 <2.0.0', '2.0.0', false],
    ['<1.0.0 || >=1.4.273', '1.2.0', false],
    ['<1.0.0 || >=1.4.273', '0.5.0', true],
  ]
  for (const [range, version, expected] of cases) {
    assert.equal(satisfies(version, range), expected, `${version} in "${range}"`)
  }
  assert.throws(() => satisfies('1.4.273', '>=1.4.273-beta'), /cannot read/)
  assert.throws(() => satisfies('1.4.273-rc.1', '>=1.4.273'), /not a release version/)
})
