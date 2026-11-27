// The entry rule's block (TZ Ф3) and its place in CLAUDE.md and AGENTS.md: between the plugin's own markers, once, the
// rest of the file as it was.
import { assert, test } from 'orca/testing'
import { ENTRY_RULE_BEGIN, ENTRY_RULE_END, entryRuleBlock, entryRuleIn, placeEntryRule } from './entry-rule'

const BLOCK = entryRuleBlock('ru', 'demo-org/shop-demo')

function blocks(text: string): number {
  return text.split('\n').filter((line) => line.startsWith(ENTRY_RULE_BEGIN)).length
}

test('правило входа: блок между маркерами плагина, не маркерами agent-queue-kit; на языке проекта', () => {
  const lines = BLOCK.split('\n')
  assert.ok(lines[0]?.startsWith(ENTRY_RULE_BEGIN), lines[0])
  assert.equal(lines.at(-1), ENTRY_RULE_END)
  assert.ok(!BLOCK.includes('<!-- agent-queue:begin'), 'маркер кита')
  assert.match(BLOCK, /только для входных сессий/)
  const english = entryRuleBlock('en', 'demo-org/shop-demo')
  assert.match(english, /only for entry sessions/)
  assert.ok(!/[а-яё]/i.test(english.replace(/«Зависит от #N»/, '')), 'русский текст в английском блоке')
})

test('правило входа: файла нет → файл из одного блока; чужой текст остаётся, блок добавлен в конец один раз', () => {
  assert.deepEqual(placeEntryRule(null, BLOCK), { ok: true, text: `${BLOCK}\n` })
  const own = '# Проект shop-demo\n\nСобирать командой make.\n'
  const placed = placeEntryRule(own, BLOCK)
  assert.ok(placed.ok)
  if (!placed.ok) return
  assert.equal(placed.text, `${own}\n${BLOCK}\n`)
  assert.equal(blocks(placed.text), 1)
  // Again: the block is replaced in its place, not added a second time.
  const again = placeEntryRule(placed.text, BLOCK)
  assert.deepEqual(again, { ok: true, text: placed.text })
})

test('правило входа: старый блок заменяется на месте, второй блок уходит, текст вокруг остаётся; CRLF файла сохраняются', () => {
  const old = `${ENTRY_RULE_BEGIN} old -->\nстарое правило\n${ENTRY_RULE_END}`
  const text = `до блока\n${old}\nмежду\n${old}\nпосле блока\n`
  const placed = placeEntryRule(text, BLOCK)
  assert.ok(placed.ok)
  if (!placed.ok) return
  assert.equal(placed.text, `до блока\n${BLOCK}\nмежду\nпосле блока\n`)
  const crlf = placeEntryRule('строка один\r\nстрока два\r\n', BLOCK)
  assert.ok(crlf.ok)
  if (!crlf.ok) return
  assert.equal(crlf.text, `строка один\r\nстрока два\r\n\r\n${BLOCK.split('\n').join('\r\n')}\r\n`)
  assert.equal(entryRuleIn(crlf.text), BLOCK)
})

test('правило входа: маркер без пары → проблема с кодом, файл не меняется', () => {
  assert.deepEqual(placeEntryRule(`текст\n${ENTRY_RULE_BEGIN} -->\nбез конца\n`, BLOCK), { ok: false, problem: 'begin-alone' })
  assert.deepEqual(placeEntryRule(`текст\n${ENTRY_RULE_END}\n`, BLOCK), { ok: false, problem: 'end-alone' })
  assert.deepEqual(placeEntryRule(`${ENTRY_RULE_BEGIN} -->\n${ENTRY_RULE_BEGIN} -->\n${ENTRY_RULE_END}\n`, BLOCK), { ok: false, problem: 'begin-again' })
})

test('правило входа: байты вне блока не меняются — BOM, смешанные LF и CRLF, строка без перевода в конце; окончания выбираются только для своего блока', () => {
  const mixed = '﻿# Заметки\r\nстрока с LF\nстрока с CRLF\r\n'
  assert.deepEqual(placeEntryRule(mixed, BLOCK), { ok: true, text: `${mixed}\r\n${BLOCK.split('\n').join('\r\n')}\r\n` })
  const open = 'строка с LF\nпоследняя строка без перевода'
  assert.deepEqual(placeEntryRule(open, BLOCK), { ok: true, text: `${open}\n\n${BLOCK}\n` })
  const old = `${ENTRY_RULE_BEGIN} old -->\r\nстарое правило\nещё\r\n${ENTRY_RULE_END}`
  const replaced = placeEntryRule(`﻿до\n${old}\r\nпосле\n`, BLOCK)
  assert.deepEqual(replaced, { ok: true, text: `﻿до\n${BLOCK.split('\n').join('\r\n')}\r\nпосле\n` })
})

test('правило входа: BOM — префикс файла, а не часть первой строки: он остаётся первым и когда блок, который заменяется, открывает файл', () => {
  const old = `${ENTRY_RULE_BEGIN} old -->\nстарое правило\n${ENTRY_RULE_END}`
  assert.deepEqual(placeEntryRule(`\uFEFF${old}\nтекст проекта\n`, BLOCK), { ok: true, text: `\uFEFF${BLOCK}\nтекст проекта\n` })
  assert.deepEqual(placeEntryRule(`\uFEFFтекст проекта\n${old}\n`, BLOCK), { ok: true, text: `\uFEFFтекст проекта\n${BLOCK}\n` })
  assert.deepEqual(placeEntryRule(`\uFEFF${ENTRY_RULE_END}\n`, BLOCK), { ok: false, problem: 'end-alone' })
})
