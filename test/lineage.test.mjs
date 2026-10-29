import test from 'node:test'
import assert from 'node:assert/strict'

import { lineageDegrees, displayKind } from '../lib/geometry/lineage.js'

const e = (from, to) => ({ from, to })

test('合并出入度：原生与手工同权计入，来源分项保留', () => {
  const d = lineageDegrees([e('p', 'c')], [{ from: 'p', to: 'm' }])
  const p = d.get('p')
  assert.equal(p.out, 2)
  assert.equal(p.nativeOut, 1)
  assert.equal(p.manualOut, 1)
  assert.equal(p.in, 0)
  const c = d.get('c')
  assert.equal(c.in, 1)
  assert.equal(c.nativeIn, 1)
  assert.equal(c.manualIn, 0)
  const m = d.get('m')
  assert.equal(m.in, 1)
  assert.equal(m.manualIn, 1)
})

test('合并出入度：空链返回空表', () => {
  assert.equal(lineageDegrees([], []).size, 0)
})

test('显形类别：单后继（纯原生）= handoff', () => {
  const d = lineageDegrees([e('p', 'c')], [])
  assert.equal(displayKind(e('p', 'c'), d), 'handoff')
})

test('显形类别：父另有手工后继时，原生单子边显形为分支（链语义合并）', () => {
  const d = lineageDegrees([e('p', 'c')], [{ from: 'p', to: 'm' }])
  assert.equal(displayKind(e('p', 'c'), d), 'branch')
})

test('显形类别：双原生子 = 分支（host 原生口径与合并口径一致）', () => {
  const d = lineageDegrees([e('p', 'c1'), e('p', 'c2')], [])
  assert.equal(displayKind(e('p', 'c1'), d), 'branch')
  assert.equal(displayKind(e('p', 'c2'), d), 'branch')
})

test('显形类别：纯手工扇出无数边可显形——度表仍计出 2（徽章口径）', () => {
  const d = lineageDegrees([], [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }])
  assert.equal(d.get('a').out, 2)
  assert.equal(d.get('a').manualOut, 2)
})

test('显形类别：度表缺节点时按 0 兜底 = handoff', () => {
  const d = lineageDegrees([], [])
  assert.equal(displayKind(e('x', 'y'), d), 'handoff')
})
