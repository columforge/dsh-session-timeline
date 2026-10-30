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
  // Assignment order = sort by createdAt ascending, walk from the tail → later-created assigned first (up)
  const nodes = [node('a', 1), node('b', 2)]
  const l = computeLayout(nodes, [], [])
  assert.equal(l.colOf.get('a'), 0)
  assert.equal(l.colOf.get('b'), 1)
  assert.equal(l.sideOf.get('b'), 'up')
  assert.equal(l.sideOf.get('a'), 'down')
  assert.equal(l.depthOf.get('a'), 0)
  assert.equal(l.depthOf.get('b'), 0)
  // Column centers and row tops
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
  // Depth rows sit outside the fishbone: deeper on the up side => smaller row top
  assert.ok(nodeTop(l, 'c') < nodeTop(l, 'p'))
})

test('手工链：父创建晚于子也按拓扑序分派（子仍下沉）', () => {
  // x created first, p last; manual link p -> c (semantics: from is the predecessor)
  const nodes = [node('x', 1), node('p', 10), node('c', 2)]
  const l = computeLayout(nodes, [], [{ from: 'p', to: 'c' }])
  assert.equal(l.sideOf.get('c'), l.sideOf.get('p'))
  assert.equal(l.depthOf.get('c'), (l.depthOf.get('p') ?? 0) + 1)
})

test('手工链式传播：深度行跨连续手工边传递（A→B→C 同侧叠两层）', () => {
  const nodes = [node('a', 1), node('b', 2), node('c', 3)]
  const l = computeLayout(nodes, [], [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
  ])
  assert.equal(l.sideOf.get('b'), l.sideOf.get('a'))
  assert.equal(l.sideOf.get('c'), l.sideOf.get('a'))
  assert.equal(l.depthOf.get('a'), 0)
  assert.equal(l.depthOf.get('b'), 1)
  assert.equal(l.depthOf.get('c'), 2)
  assert.equal(l.maxDepth, 2)
})

test('混合链传播：原生边接手工边连续下沉（P→B 原生，B→C 手工）', () => {
  const nodes = [node('p', 1), node('b', 2), node('c', 3)]
  const l = computeLayout(nodes, [{ from: 'p', to: 'b' }], [{ from: 'b', to: 'c' }])
  assert.equal(l.sideOf.get('b'), l.sideOf.get('p'))
  assert.equal(l.sideOf.get('c'), l.sideOf.get('b'))
  assert.equal(l.depthOf.get('b'), 1)
  assert.equal(l.depthOf.get('c'), 2)
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
