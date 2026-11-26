// The texts the plugin writes to GitHub come in the project's language (Ф15): `language` of .agent-queue.json, read
// from the project's base branch with real git, picks the English or the Russian catalog; the two catalogs have the
// same keys and the same places for values.
import { assert, test } from 'orca/testing'
import { realMachine } from '../platform/machine'
import { readProjectSettings, SETTINGS_FILE } from '../project/settings'
import { fakeClock } from '../testing/fake-machine'
import { withRepository } from '../testing/git-repository'
import { paramNames } from '../text-params'
import { githubCatalogs, githubText, GITHUB_LANGUAGES, type GithubTextKey } from './catalog'
import { en } from './en'
import { ru } from './ru'

const machine = realMachine({ now: fakeClock().now })

const settingsFile = (language: string) =>
  `${JSON.stringify({ version: 1, testCommand: 'make test', language, dataRule: 'No customer data in GitHub.' })}\n`

test('язык проекта en → текст GitHub из английского каталога, ru — из русского', async () => {
  await withRepository(async (repo) => {
    const texts: Record<string, string> = {}
    for (const language of ['en', 'ru']) {
      await repo.commit({ [SETTINGS_FILE]: settingsFile(language) }, `language ${language}`)
      await repo.push()
      const result = await readProjectSettings(machine, repo.checkout)
      assert.ok(result.ok, JSON.stringify(result))
      assert.equal(result.settings.language, language)
      texts[language] = githubText(result.settings.language, 'mvp.standMissing')
    }
    assert.deepEqual(texts, {
      en: 'Add the MVP acceptance stand to the project settings',
      ru: 'Добавьте стенд приёмки в настройки проекта',
    })
    assert.equal(texts.en, en['mvp.standMissing'])
    assert.equal(texts.ru, ru['mvp.standMissing'])
  })
  // Values go into their places in either language.
  assert.equal(githubText('en', 'pr.closes', { issue: 48 }), 'Closes #48')
  assert.equal(githubText('ru', 'pr.closes', { issue: 48 }), 'Closes #48')
})

test('у каждого ключа одного каталога текстов GitHub есть ключ в другом, с теми же местами для значений', () => {
  assert.deepEqual([...GITHUB_LANGUAGES].sort(), Object.keys(githubCatalogs).sort())
  const keys = (catalog: object) => Object.keys(catalog).sort()
  for (const language of GITHUB_LANGUAGES) {
    for (const other of GITHUB_LANGUAGES) {
      const missing = keys(githubCatalogs[language]).filter((key) => !Object.hasOwn(githubCatalogs[other], key))
      assert.deepEqual(missing, [], `keys of ${language} without a text in ${other}`)
    }
  }
  for (const key of keys(en) as GithubTextKey[]) {
    for (const language of GITHUB_LANGUAGES) {
      const text = githubCatalogs[language][key]
      assert.ok(typeof text === 'string' && text.trim() !== '', `${language} ${key}: empty`)
      assert.deepEqual(paramNames(text).sort(), paramNames(en[key]).sort(), `${language} ${key}: other places for values`)
    }
  }
})
