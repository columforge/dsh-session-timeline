/**
 * 泳道（多时间线）布局测试——所有工作区画布的几何层。
 *
 * 强约束：
 * - 共享刻度：全局列 = 传入顺序下标；同一列在每根泳道 x 相同（列网格全局唯一）；
 * - 泳道堆叠顺序 = 传入顺序中的首次出现序；
 * - 每根泳道内部跑单鱼骨：独立节点上下交替、血缘子继承父侧并下沉一行（泳道内）；
 * - 泳道 colOf 覆盖为全局列（不是泳道内局部 0..k）；
 * - innerH = TOP_BAND + Σ 泳道高 + (n-1)×LANE_GAP。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  computeLanesLayout, laneNodeTop, laneColX, TOP_BAND, LANE_GAP, COLLAPSED_H,
} from '../lib/geometry/lanes.js'
import { SPACING, NODE_H, ROW_GAP, colX } from '../lib/geometry/layout.js'

const node = (id, createdAt, bucket, extra = {}) => ({ id, createdAt, bucket, ...extra })

test('共享刻度：全局列 = 传入顺序下标，同列同 x', () => {
  // 传入顺序 a1, b1, a2（UI 已按排序键排好）
  const ns = [node('a1', 1, 'A'), node('b1', 2, 'B'), node('a2', 3, 'A')]
  const L = computeLanesLayout(ns, [], [], (n) => n.bucket)
  assert.equal(L.colOf.get('a1'), 0)
  assert.equal(L.colOf.get('b1'), 1)
  assert.equal(L.colOf.get('a2'), 2)
  // 泳道 colOf 与全局一致（覆盖局部列）
  const laneA = L.laneById.get('A')
  const laneB = L.laneById.get('B')
  assert.equal(laneA.colOf.get('a1'), 0)
  assert.equal(laneA.colOf.get('a2'), 2)
  assert.equal(laneB.colOf.get('b1'), 1)
  // 同列 x：泳道 A 的 a1（列 0）与单视图列公式一致
  assert.equal(laneColX(L, 'a1'), colX(laneA, 'a1'))
  assert.equal(laneColX(L, 'a1'), 0 * SPACING + SPACING / 2)
})

test('泳道堆叠顺序 = 传入顺序首次出现序；innerH = TOP_BAND + Σ + gaps', () => {
  const ns = [
    node('b1', 5, 'B'), node('a1', 1, 'A'), node('b2', 6, 'B'), node('c1', 9, 'C'), node('a2', 2, 'A'),
  ]
  const L = computeLanesLayout(ns, [], [], (n) => n.bucket)
  assert.deepEqual(L.lanes.map((l) => l.id), ['B', 'A', 'C'])
  const sum = L.lanes.reduce((acc, l) => acc + l.innerH, 0)
  assert.equal(L.innerH, TOP_BAND + sum + LANE_GAP * (L.lanes.length - 1))
  // 第二根泳道的轴在第一根之下
  assert.ok(L.laneById.get('A').axisY > L.laneById.get('B').axisY)
})

test('泳道内单鱼骨：独立节点交替、血缘子继承父侧并下沉一行', () => {
  // 泳道 A：a1 独立 + a2/a3 为 a1 的原生子（handoff 链）；泳道 B：b1 独立
  const ns = [
    node('a1', 1, 'A'), node('a2', 2, 'A'), node('a3', 3, 'A'), node('b1', 4, 'B'),
  ]
  const edges = [{ from: 'a1', to: 'a2' }, { from: 'a2', to: 'a3' }]
  const L = computeLanesLayout(ns, edges, [], (n) => n.bucket)
  const laneA = L.laneById.get('A')
  assert.equal(laneA.sideOf.get('a2'), laneA.sideOf.get('a1'))
  assert.equal(laneA.depthOf.get('a2'), (laneA.depthOf.get('a1') ?? 0) + 1)
  assert.equal(laneA.depthOf.get('a3'), (laneA.depthOf.get('a2') ?? 0) + 1)
  // laneNodeTop 用各自泳道的轴：a3 在 A 泳道（深度 2，按其实际侧别推导），b1 在 B 泳道
  const topA3 = laneNodeTop(L, 'a3')
  const topB1 = laneNodeTop(L, 'b1')
  const depthA3 = laneA.depthOf.get('a3') ?? 0
  assert.equal(depthA3, 2)
  const expectedTopA3 = laneA.sideOf.get('a3') === 'up'
    ? laneA.axisY - 26 - NODE_H - depthA3 * (NODE_H + ROW_GAP)
    : laneA.axisY + 26 + depthA3 * (NODE_H + ROW_GAP)
  assert.equal(topA3, expectedTopA3)
  // b1 的 top 相对 B 轴，落在 A 泳道带之外
  assert.ok(topB1 > laneA.innerH)
})

test('跨泳道边被过滤：路由与泳道图不收跨界对', () => {
  const ns = [node('a1', 1, 'A'), node('b1', 2, 'B')]
  const L = computeLanesLayout(ns, [{ from: 'a1', to: 'b1' }], [{ from: 'b1', to: 'a1', created_at: '' }], (n) => n.bucket)
  // 泳道几何不受跨界边影响（两侧都只有独立节点，深度 0）
  for (const lane of L.lanes) {
    for (const n of lane.nodes) assert.equal(lane.depthOf.get(n.id), 0)
  }
  assert.equal(L.lanes.length, 2)
})

test('空画布：无节点时给最小宽度、TOP_BAND 高、无泳道', () => {
  const L = computeLanesLayout([], [], [], () => 'A')
  assert.deepEqual(L.lanes, [])
  assert.equal(L.innerW, 320)
  assert.equal(L.innerH, TOP_BAND)
})

test('折叠泳道：细条带高度、节点退出共享刻度、列重排', () => {
  const ns = [
    node('a1', 1, 'A'), node('b1', 2, 'B'), node('a2', 3, 'A'), node('c1', 4, 'C'),
  ]
  const L = computeLanesLayout(ns, [], [], (n) => n.bucket, new Set(['B']))
  // B = 细条带：无节点、无列、band 高 = COLLAPSED_H
  const laneB = L.laneById.get('B')
  assert.equal(laneB.collapsed, true)
  assert.equal(laneB.nodes.length, 0)
  assert.equal(laneB.colOf.size, 0)
  assert.equal(laneB.innerH, COLLAPSED_H)
  // B 的节点退出画布与共享刻度；其余列按可见顺序重排（a1=0, a2=1, c1=2）
  assert.deepEqual(L.nodes.map((n) => n.id), ['a1', 'a2', 'c1'])
  assert.equal(L.colOf.get('a2'), 1)
  assert.equal(L.colOf.get('c1'), 2)
  assert.equal(L.laneOf.has('b1'), false)
  // 条带堆叠：B 介于 A、C 之间，总高含细条带
  assert.equal(laneB.top, L.laneById.get('A').top + L.laneById.get('A').innerH + LANE_GAP)
  const sum = L.lanes.reduce((acc, l) => acc + l.innerH, 0)
  assert.equal(L.innerH, TOP_BAND + sum + LANE_GAP * (L.lanes.length - 1))
})
