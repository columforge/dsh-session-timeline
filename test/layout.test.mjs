import test from 'node:test'
import assert from 'node:assert/strict'

import {
  computeLayout, colX, nodeTop,
  SPACING, NODE_W, NODE_H, GAP, ROW_GAP, DATE_BAND,
} from '../lib/geometry/layout.js'

const node = (id, createdAt, extra = {}) => ({ id, createdAt, ...extra })

test('空图：无节点时给最小画布宽、无深度', () => {
  const l = computeLayout([], [], [])
  assert.deepEqual(l.nodes, [])
  assert.equal(l.colOf.size, 0)
  assert.equal(l.sideOf.size, 0)
  assert.equal(l.depthOf.size, 0)
  assert.equal(l.maxDepth, 0)
  assert.equal(l.innerW, 320)
})

test('独立节点：列 = 传入顺序，side 按分派奇偶交替', () => {
  // 分派顺序 = 按 createdAt 升序后从尾部往前 → 后创建者先分派（up）
  const nodes = [node('a', 1), node('b', 2)]
  const l = computeLayout(nodes, [], [])
  assert.equal(l.colOf.get('a'), 0)
  assert.equal(l.colOf.get('b'), 1)
  assert.equal(l.sideOf.get('b'), 'up')
  assert.equal(l.sideOf.get('a'), 'down')
  assert.equal(l.depthOf.get('a'), 0)
  assert.equal(l.depthOf.get('b'), 0)
  // 列中心与行顶
  assert.equal(colX(l, 'a'), SPACING / 2)
  assert.equal(colX(l, 'b'), SPACING + SPACING / 2)
  assert.equal(nodeTop(l, 'b'), l.axisY - GAP - NODE_H)
  assert.equal(nodeTop(l, 'a'), l.axisY + GAP)
})

test('几何：轴位置与外侧走廊按最外框外缘 ±12 计算', () => {
  const l = computeLayout([node('a', 1), node('b', 2)], [], [])
  const upBlock = NODE_H
  const downBlock = NODE_H
  assert.equal(l.axisY, DATE_BAND + upBlock + GAP)
  assert.equal(l.innerH, l.axisY + GAP + downBlock + DATE_BAND)
  assert.equal(l.corridorUp, DATE_BAND - 12)
  assert.equal(l.corridorDown, l.axisY + GAP + NODE_H + 12)
})

test('原生血缘：子继承父侧并下沉一行（深度行）', () => {
  const nodes = [node('p', 1), node('c', 2)]
  const l = computeLayout(nodes, [{ from: 'p', to: 'c' }], [])
  assert.equal(l.sideOf.get('c'), l.sideOf.get('p'))
  assert.equal(l.depthOf.get('p'), 0)
  assert.equal(l.depthOf.get('c'), 1)
  assert.equal(l.maxDepth, 1)
  // 深度行在鱼骨外侧：up 侧更深 => 行顶更小
  assert.ok(nodeTop(l, 'c') < nodeTop(l, 'p'))
})

test('手工链：父创建晚于子也按拓扑序分派（子仍下沉）', () => {
  // x 创建最早，p 最晚；手工链 p -> c（语义 from 前驱）
  const nodes = [node('x', 1), node('p', 10), node('c', 2)]
  const l = computeLayout(nodes, [], [{ from: 'p', to: 'c' }])
  assert.equal(l.sideOf.get('c'), l.sideOf.get('p'))
  assert.equal(l.depthOf.get('c'), (l.depthOf.get('p') ?? 0) + 1)
})

test('环：无法拓扑分派时兜底为独立节点（深度 0）', () => {
  const nodes = [node('a', 1), node('b', 2)]
  const l = computeLayout(nodes, [], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }])
  assert.equal(l.depthOf.get('a'), 0)
  assert.equal(l.depthOf.get('b'), 0)
  assert.equal(l.sideOf.get('a'), 'up')
  assert.equal(l.sideOf.get('b'), 'down')
})

test('泛型保留：UI 节点附加字段随 layout.nodes 返回', () => {
  const nodes = [node('a', 1, { title: 'T', lastAt: 9 })]
  const l = computeLayout(nodes, [], [])
  assert.equal(l.nodes[0].title, 'T')
  assert.equal(l.nodes[0].lastAt, 9)
})
