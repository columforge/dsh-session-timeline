/**
 * 词典一致性测试（8 语种）。
 *
 * 强约束（任一不满足即 fail）：
 * - zh/en/ja/es/fr/de/ru/pt 全部存在，且键集与 zh 完全一致（en 是 fallback 链的
 *   终点，缺键会让非 zh 语言在 fallback 后显示键名）；
 * - 每个值非空字符串；
 * - 同一键在 8 语种中的 {name} 占位符集合一致（插值参数错位会静默丢参数）。
 *
 * 导入 lib/locales.js（tsdown 第二 entry 产出，ESM），pretest 自动 build。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dictionaries } from '../lib/locales.js'

const LANGS = ['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt']

/** 一个模板里的占位符名字集合。 */
function placeholders(template) {
  return new Set([...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))
}

test('全部 8 语种词典在列', () => {
  for (const lang of LANGS) {
    assert.ok(dictionaries[lang] !== undefined, `missing dictionary: ${lang}`)
    assert.equal(typeof dictionaries[lang], 'object')
  }
})

test('各语种键集与 zh 基准完全一致', () => {
  const base = Object.keys(dictionaries.zh).sort()
  assert.ok(base.length > 50, `zh baseline unexpectedly small: ${base.length}`)
  for (const lang of LANGS) {
    assert.deepEqual(Object.keys(dictionaries[lang]).sort(), base, `key set differs: ${lang}`)
  }
})

test('所有值为非空字符串', () => {
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(dictionaries[lang])) {
      assert.equal(typeof value, 'string', `${lang}.${key} is not a string`)
      assert.ok(value.trim() !== '', `${lang}.${key} is empty`)
    }
  }
})

test('同一键的占位符集合在 8 语种间一致', () => {
  for (const key of Object.keys(dictionaries.zh)) {
    const expected = [...placeholders(dictionaries.zh[key])].sort()
    for (const lang of LANGS) {
      const actual = [...placeholders(dictionaries[lang][key])].sort()
      assert.deepEqual(actual, expected, `placeholder mismatch: ${lang}.${key}`)
    }
  }
})
