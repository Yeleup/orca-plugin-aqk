// The task lines the plugin reads from an issue's text: dependencies, the MVP and the split task a part belongs to.
import { assert, test } from 'orca/testing'
import { parseTaskLines } from './task-lines'

test('«Зависит от #5, #7» → зависимости 5 и 7; «Depends on #5» → 5; «MVP: #41» и «Часть #44» разобраны', () => {
  assert.deepEqual(parseTaskLines('Сделать поиск.\n\nЗависит от #5, #7\n'), { dependsOn: [5, 7], mvp: null, partOf: null, problems: [] })
  assert.deepEqual(parseTaskLines('Add search.\nDepends on #5'), { dependsOn: [5], mvp: null, partOf: null, problems: [] })
  assert.deepEqual(parseTaskLines('MVP: #41\nЧасть #44\n\nТекст части.'), { dependsOn: [], mvp: 41, partOf: 44, problems: [] })
  // As the plugin's plan tasks have them: a mark line first, then the lines.
  assert.deepEqual(
    parseTaskLines('<!-- agent-queue:mark {"v":1,"kind":"operation-start"} -->\nMVP: #1\nЗависит от #2, #4\n\n## Что сделать\n'),
    { dependsOn: [2, 4], mvp: 1, partOf: null, problems: [] },
  )
})

test('строки задачи: целые строки вне кода, цитат и HTML-комментариев, в любом регистре; неверная строка — проблема, а не тихий пропуск', () => {
  // Several dependency lines are joined in order, each number once; separators: commas, blanks, «и», «and»; case,
  // a colon, blanks around and a full stop do not matter; \r\n is a line break.
  const body = [
    '  зависит от: #12 и #3.  ',
    'DEPENDS ON #3 #8 and #12',
    'Часть: #44',
    'mvp:#41',
    '',
    '```',
    'Зависит от #99',
    '```',
    '~~~~ text',
    'MVP: #98',
    '~~~~',
    '> Зависит от #97',
    '<!--',
    'Часть #96',
    '-->',
    'Зависит от #6 <!-- после ревью -->',
    'Текст, где Зависит от #95 стоит не в начале строки.',
    'Часть работы уже сделана, MVP: потом.',
  ].join('\r\n')
  assert.deepEqual(parseTaskLines(body), { dependsOn: [12, 3, 8, 6], mvp: 41, partOf: 44, problems: [] })

  // Lines that start like task lines but are not one: reported with their line numbers, never read as less.
  const wrong = parseTaskLines(
    [
      'Зависит от 5',
      'Зависит от #5, 7',
      'Depends on #5 after the review',
      'Зависит от решения владельца',
      'MVP: #1, #2',
      'Часть #4 и #5',
      'Зависит от #8',
    ].join('\n'),
  )
  assert.deepEqual(wrong.dependsOn, [8])
  assert.equal(wrong.mvp, null)
  assert.equal(wrong.partOf, null)
  assert.deepEqual(
    wrong.problems.map((problem) => problem.split(':')[0]),
    ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6'],
  )
  // Two MVP lines with different numbers: the first counts, the second is a problem; the same number twice is fine.
  const twice = parseTaskLines('MVP: #1\nMVP: #2\nЧасть #3\nЧасть #3')
  assert.equal(twice.mvp, 1)
  assert.equal(twice.partOf, 3)
  assert.deepEqual(twice.problems, ['line 2: a second «MVP» line names #2, the first named #1'])
  // No lines at all, or words that only look alike.
  assert.deepEqual(parseTaskLines(''), { dependsOn: [], mvp: null, partOf: null, problems: [] })
  assert.deepEqual(parseTaskLines('MVP: Agent Queue\nЧасть работы\nЗависимости нет'), {
    dependsOn: [],
    mvp: null,
    partOf: null,
    problems: [],
  })
})

test('строка сразу после цитаты без пустой строки — продолжение цитаты (как в GitHub) и не читается; после пустой строки — читается', () => {
  // GFM: a line right after a quoted paragraph goes on that paragraph, inside the quote.
  assert.deepEqual(parseTaskLines('> Пример:\nЗависит от #5\nMVP: #2').dependsOn, [])
  assert.deepEqual(parseTaskLines('> Пример:\nЗависит от #5\nMVP: #2').mvp, null)
  // After a blank line the quote is over.
  assert.deepEqual(parseTaskLines('> Пример:\n\nЗависит от #5').dependsOn, [5])
  // A quote whose last line is empty (">") has ended its paragraph: the next line starts a paragraph outside it.
  assert.deepEqual(parseTaskLines('> Пример:\n>\nЗависит от #6').dependsOn, [6])
  // A line that starts a block of its own ends the quote (a heading here); the line after it is outside.
  assert.deepEqual(parseTaskLines('> Пример:\n## Зависимости\nЗависит от #7').dependsOn, [7])
  const fenced = parseTaskLines('> Пример:\n```\nЗависит от #8\n```\nЗависит от #9')
  assert.deepEqual(fenced.dependsOn, [9])
  // Nested quotes the same.
  assert.deepEqual(parseTaskLines('>> Вложенная цитата\nЧасть #4\n\nЧасть #3'), { dependsOn: [], mvp: null, partOf: 3, problems: [] })
})
