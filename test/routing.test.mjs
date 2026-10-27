import test from 'node:test'
import assert from 'node:assert/strict'

import { computeLayout, nodeTop, colX, NODE_W, NODE_H } from '../lib/geometry/layout.js'
import { segmentPoints } from './helpers.mjs'

import {
  segHitsObstacle, routeOrthogonal, routeEdgePath, OBST_PAD,
} from '../lib/geometry/routing.js'

const segs = (d) => {
  const pts = segmentPoints(d)
  const out = []
  for (let i = 0; i + 1 < pts.length; i++) out.push([pts[i], pts[i + 1]])
  return out
}

const assertOrthogonal = (d) => {
  for (const [[x1, y1], [x2, y2]] of segs(d)) {
    assert.ok(x1 === x2 || y1 === y2, `非正交段 ${x1},${y1} -> ${x2},${y2}`)
  }
}

const assertNoHits = (d, obs) => {
  for (const [[x1, y1], [x2, y2]] of segs(d)) {
    assert.equal(segHitsObstacle(x1, y1, x2, y2, obs), false, `穿障段 ${x1},${y1} -> ${x2},${y2}`)
  }
}

test('segHitsObstacle：开区间判定（贴边不算穿、内部算穿）', () => {
  const obs = [{ x: 0, y: 0, w: 100, h: 100 }]
  assert.equal(segHitsObstacle(50, -10, 50, 10, obs), true, '竖直穿内部')
  assert.equal(segHitsObstacle(-10, 50, 10, 50, obs), true, '水平穿内部')
  assert.equal(segHitsObstacle(0, -10, 0, 110, obs), false, '沿左缘不算穿')
  assert.equal(segHitsObstacle(-10, 0, 110, 0, obs), false, '沿顶缘不算穿')
  assert.equal(segHitsObstacle(120, 120, 200, 120, obs), false, '框外')
})

test('无障碍：直连且端点保留', () => {
  const d = routeOrthogonal([], 10, 50, 210, 50, new Map())
  assertOrthogonal(d)
  const pts = segmentPoints(d)
  assert.deepEqual(pts[0], [10, 50])
  assert.deepEqual(pts[pts.length - 1], [210, 50])
  assert.equal(pts.length, 2)
})

test('绕障：路径不穿障碍且比直线更长', () => {
  const obs = [{ x: 80, y: 0, w: 40, h: 100 }]
  const d = routeOrthogonal(obs, 10, 50, 210, 50, new Map())
  assertOrthogonal(d)
  assertNoHits(d, obs)
  assert.ok(segs(d).length >= 3, '应至少 3 段折线绕行')
})

test('多框布局：任意起终点均正交且不穿框', () => {
  const obs = [
    { x: 0, y: 0, w: 60, h: 40 }, { x: 140, y: 30, w: 60, h: 40 },
    { x: 60, y: 120, w: 100, h: 40 }, { x: 260, y: 100, w: 60, h: 60 },
  ]
  // 起终点取框外（真实调用恒为框缘外 3px）
  const d = routeOrthogonal(obs, 20, 60, 300, 200, new Map())
  assertOrthogonal(d)
  assertNoHits(d, obs)
})

test('兜底：起点被困在障碍内时仍输出正交通道（绝不出斜线）', () => {
  const obs = [{ x: 0, y: 0, w: 100, h: 100 }]
  const d = routeOrthogonal(obs, 50, 50, 150, 50, new Map(), [])
  assertOrthogonal(d)
  const pts = segmentPoints(d)
  assert.deepEqual(pts[0], [50, 50])
  assert.deepEqual(pts[pts.length - 1], [150, 50])
})

/* ---- routeEdgePath：引出/接入边矩阵（父在子左/右 × 上/下方） ---- */

const edgeLayout = (order, createdAtBy, edge) => {
  const nodes = order.map((id) => ({ id, createdAt: createdAtBy[id] }))
  const layout = computeLayout(nodes, edge === undefined ? [] : [edge], [])
  const obstacles = order.map((id) => ({
    x: colX(layout, id) - NODE_W / 2 - OBST_PAD,
    y: nodeTop(layout, id) - OBST_PAD,
    w: NODE_W + OBST_PAD * 2,
    h: NODE_H + OBST_PAD * 2,
  }))
  return { layout, obstacles }
}

const edgeEnds = (layout, path) => {
  const pts = segmentPoints(path)
  return { start: pts[0], end: pts[pts.length - 1] }
}

test('矩阵 up 侧 + 父在子左：父出上方、子入左缘', () => {
  const { layout, obstacles } = edgeLayout(['p', 'c'], { p: 1, c: 2 }, { from: 'p', to: 'c' })
  const j = (0 % 3) - 1
  const d = routeEdgePath({ layout, obstacles, occupied: new Map(), from: 'p', to: 'c', step: 0 })
  assertOrthogonal(d)
  assertNoHits(d, obstacles)
  const { start, end } = edgeEnds(layout, d)
  assert.deepEqual(start, [colX(layout, 'p') + j * 10, nodeTop(layout, 'p') - 3])
  assert.deepEqual(end, [colX(layout, 'c') - NODE_W / 2 - 3, nodeTop(layout, 'c') + NODE_H / 2 + j * 6])
})

test('矩阵 up 侧 + 父在子右：父出上方、子入右缘', () => {
  // 列序 [c, p] => 子在父左；分派仍按创建序：p 先 up、c 继承 up
  const { layout, obstacles } = edgeLayout(['c', 'p'], { p: 1, c: 2 }, { from: 'p', to: 'c' })
  const j = (0 % 3) - 1
  const d = routeEdgePath({ layout, obstacles, occupied: new Map(), from: 'p', to: 'c', step: 0 })
  assertOrthogonal(d)
  assertNoHits(d, obstacles)
  const { start, end } = edgeEnds(layout, d)
  assert.deepEqual(start, [colX(layout, 'p') + j * 10, nodeTop(layout, 'p') - 3])
  assert.deepEqual(end, [colX(layout, 'c') + NODE_W / 2 + 3, nodeTop(layout, 'c') + NODE_H / 2 + j * 6])
})

test('矩阵 down 侧 + 父在子左：父出下方、子入左缘', () => {
  // x 最新先分派 => up；p 次之 => down；c 继承 p（down，深度 1）
  const { layout, obstacles } = edgeLayout(['x', 'p', 'c'], { x: 3, p: 2, c: 1 }, { from: 'p', to: 'c' })
  assert.equal(layout.sideOf.get('p'), 'down')
  const j = (0 % 3) - 1
  const d = routeEdgePath({ layout, obstacles, occupied: new Map(), from: 'p', to: 'c', step: 0 })
  assertOrthogonal(d)
  assertNoHits(d, obstacles)
  const { start, end } = edgeEnds(layout, d)
  assert.deepEqual(start, [colX(layout, 'p') + j * 10, nodeTop(layout, 'p') + NODE_H + 3])
  assert.deepEqual(end, [colX(layout, 'c') - NODE_W / 2 - 3, nodeTop(layout, 'c') + NODE_H / 2 + j * 6])
})

test('矩阵 down 侧 + 父在子右：父出下方、子入右缘', () => {
  const { layout, obstacles } = edgeLayout(['x', 'c', 'p'], { x: 3, p: 2, c: 1 }, { from: 'p', to: 'c' })
  assert.equal(layout.sideOf.get('p'), 'down')
  const j = (0 % 3) - 1
  const d = routeEdgePath({ layout, obstacles, occupied: new Map(), from: 'p', to: 'c', step: 0 })
  assertOrthogonal(d)
  assertNoHits(d, obstacles)
  const { start, end } = edgeEnds(layout, d)
  assert.deepEqual(start, [colX(layout, 'p') + j * 10, nodeTop(layout, 'p') + NODE_H + 3])
  assert.deepEqual(end, [colX(layout, 'c') + NODE_W / 2 + 3, nodeTop(layout, 'c') + NODE_H / 2 + j * 6])
})

test('微扰沿边滑动：step 改变时出口沿外侧边水平滑、不离开框缘外', () => {
  const { layout, obstacles } = edgeLayout(['p', 'c'], { p: 1, c: 2 }, { from: 'p', to: 'c' })
  const outs = [0, 1, 2].map((step) => {
    const d = routeEdgePath({ layout, obstacles, occupied: new Map(), from: 'p', to: 'c', step })
    return segmentPoints(d)[0]
  })
  const top = nodeTop(layout, 'p') - 3
  for (const pt of outs) assert.equal(pt[1], top, '出口恒在外侧框缘外 3px')
  assert.deepEqual(outs.map((p) => p[0] - colX(layout, 'p')), [-10, 0, 10])
})
