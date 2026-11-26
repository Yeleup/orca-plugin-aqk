// The project's rules for tasks, .agent-queue.md (TZ «Данные»): the connection wizard's template in the project's
// language with the project's test commands, and the file as the project's base branch has it, read with real git.
import { assert, test } from 'orca/testing'
import { realMachine } from '../platform/machine'
import { fakeClock } from '../testing/fake-machine'
import { withRepository } from '../testing/git-repository'
import { readTaskRules, TASK_RULES_FILE, taskRulesTemplate } from './task-rules'

const machine = realMachine({ now: fakeClock().now })

test('шаблон .agent-queue.md: что читать перед задачей, команды проекта, чего нельзя в worktree — на языке проекта', () => {
  const ru = taskRulesTemplate({ language: 'ru', testCommand: 'make test', testCommandWindows: 'npm run test:windows' })
  assert.equal(
    ru,
    [
      '# Правила для заданий очереди',
      '',
      '<!-- Agent Queue вставляет этот файл целиком в задания агентам очереди. Пишите правила для них: что читать перед задачей, какими командами пользоваться, чего в worktree делать нельзя. Меняет файл только владелец. -->',
      '',
      '## Что читать перед задачей',
      '',
      '- <документы проекта: ТЗ, бизнес-правила, описания модулей>',
      '',
      '## Команды проекта',
      '',
      '- Полные тесты: `make test`.',
      '- Полные тесты на Windows: `npm run test:windows`.',
      '- <другие команды: сборка, линтер, один тест>',
      '',
      '## Чего нельзя в worktree',
      '',
      '- <команды, которые трогают общий стенд, основной чекаут или боевой сервер>',
      '',
    ].join('\n'),
  )

  // English, without a command for Windows (or a blank one): no line for it.
  for (const testCommandWindows of [undefined, null, ' ']) {
    const en = taskRulesTemplate({ language: 'en', testCommand: 'make test', testCommandWindows })
    assert.match(en, /^# Rules for the tasks of the queue\n/)
    assert.match(en, /\n## Read before a task\n\n- <documents of the project/)
    assert.match(en, /\n## Commands of the project\n\n- Full tests: `make test`\.\n- <other commands/)
    assert.match(en, /\n## Never in a worktree\n\n- <commands that touch a shared stand/)
    assert.ok(!en.includes('Windows'), en)
  }

  // A command with backticks stays one code span.
  assert.match(
    taskRulesTemplate({ language: 'en', testCommand: 'echo `date` && make test' }),
    /- Full tests: ``echo `date` && make test``\./,
  )
})

test('.agent-queue.md читается из базовой ветки на origin, а не из рабочего дерева основного чекаута', async () => {
  await withRepository(async (repo) => {
    const missing = await readTaskRules(machine, repo.checkout, 'main')
    assert.ok(!missing.ok && missing.kind === 'missing', JSON.stringify(missing))

    const rules = taskRulesTemplate({ language: 'en', testCommand: 'make test' })
    const commit = await repo.commit({ [TASK_RULES_FILE]: rules })
    await repo.push()
    repo.write(TASK_RULES_FILE, '# edited, not committed\n')
    assert.deepEqual(await readTaskRules(machine, repo.checkout, 'main'), {
      ok: true,
      text: rules,
      source: { branch: 'main', commit },
    })

    const unread = await readTaskRules(machine, repo.checkout, 'release')
    assert.ok(!unread.ok && unread.kind === 'unreadable', JSON.stringify(unread))
    assert.match(unread.error, /origin\/release/)
  })
})
