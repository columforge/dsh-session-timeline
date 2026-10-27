/**
 * 正交避障路由（纯函数，无 React/DOM 依赖；单测入口）。
 *
 * 节点框（外扩 2px）为障碍，画布取框缘 ±8px 生成正交通道网格；
 * 每条边在网格上跑 A*（代价 = 长度 + 转折 ×10 + 已占用通道拥挤 ×30），
 * 得到不穿任何框的正交折线，任意布局/连线组合自动适配。
 *
 * 三个历史坑（回归先查）：
 * 1. 通道坐标集禁含障碍内部点（框中心等）——起终点吸附到内部则起点孤立；
 * 2. 起终点必须取框缘外 3px 精确点（障碍外扩 2px 后框缘在障碍内）；
 * 3. 防重合微扰必须沿边滑动（出口沿顶/底边水平、接入沿缘竖直）——
 *    垂直微扰会把点推回障碍内，同 1 的后果。
 */

import { colX, nodeTop, NODE_W, NODE_H, type Layout } from './layout.js'

export interface Obstacle { x: number; y: number; w: number; h: number }

export const OBST_PAD = 2
export const EDGE_PAD = 8
export const TURN_COST = 10
export const CROWD_COST = 30

/** 线段 (x1,y1)-(x2,y2)（正交）是否穿过任一障碍（开区间，端点贴边允许）。 */
export function segHitsObstacle(x1: number, y1: number, x2: number, y2: number, obs: Obstacle[]): boolean {
  for (const o of obs) {
    const l = o.x; const r = o.x + o.w; const t = o.y; const b = o.y + o.h
    if (x1 === x2) {
      // 竖直段
      if (x1 > l && x1 < r) {
        const lo = Math.min(y1, y2); const hi = Math.max(y1, y2)
        if (hi > t && lo < b) return true
      }
    } else if (y1 === y2) {
      if (y1 > t && y1 < b) {
        const lo = Math.min(x1, x2); const hi = Math.max(x1, x2)
        if (hi > l && lo < r) return true
      }
    }
  }
  return false
}

export function routeOrthogonal(
  obstacles: Obstacle[],
  sx: number, sy: number,
  tx: number, ty: number,
  occupied: Map<string, number>,
  corridorYs: number[] = [],
): string {
  /* 通道坐标：所有框缘 ±8 + 起/终点，去重并合并近邻 */
  const xsRaw: number[] = [sx, tx]
  const ysRaw: number[] = [sy, ty]
  for (const o of obstacles) {
    xsRaw.push(o.x - EDGE_PAD, o.x + o.w + EDGE_PAD)
    ysRaw.push(o.y - EDGE_PAD, o.y + o.h + EDGE_PAD)
  }
  const merge = (arr: number[]): number[] => {
    const a = [...arr].sort((p, q) => p - q)
    const out: number[] = []
    for (const v of a) {
      if (out.length === 0 || v - out[out.length - 1] > 6) out.push(v)
    }
    return out
  }
  const xs = merge(xsRaw)
  const ys = merge(ysRaw)
  const xIdx = new Map<number, number>(xs.map((v, i) => [v, i]))
  const yIdx = new Map<number, number>(ys.map((v, i) => [v, i]))
  const near = (arr: number[], v: number): number => {
    let best = arr[0]
    for (const c of arr) if (Math.abs(c - v) < Math.abs(best - v)) best = c
    return best
  }
  const s = { x: xIdx.get(near(xs, sx)) ?? 0, y: yIdx.get(near(ys, sy)) ?? 0 }
  const t = { x: xIdx.get(near(xs, tx)) ?? 0, y: yIdx.get(near(ys, ty)) ?? 0 }

  /* A*：代价 = 步长 + 转折 ×10 + 通道拥挤 ×30（occupied 由调用方传入跨边共享） */
  const crowd = (x1: number, y1: number, x2: number, y2: number): number => {
    const key = x1 === x2 ? 'v' + String(x1) : 'h' + String(y1)
    return (occupied.get(key) ?? 0) * CROWD_COST
  }
  const mark = (x1: number, y1: number, x2: number, y2: number): void => {
    const key = x1 === x2 ? 'v' + String(x1) : 'h' + String(y1)
    occupied.set(key, (occupied.get(key) ?? 0) + 1)
  }
  const keyOf = (x: number, y: number): string => String(x) + ',' + String(y)
  const open: { x: number; y: number; g: number; f: number; dir: string; parent: string | null }[] = [{ x: s.x, y: s.y, g: 0, f: 0, dir: '', parent: null }]
  const bestG = new Map<string, number>([[keyOf(s.x, s.y), 0]])
  const parentMap = new Map<string, string>()
  const h = (x: number, y: number): number => Math.abs(x - xs[t.x]) + Math.abs(y - ys[t.y])
  let expanded = 0
  while (open.length > 0 && expanded < 60000) {
    open.sort((a, b) => a.f - b.f)
    const cur = open.shift()
    if (cur === undefined) break
    expanded += 1
    const ck = keyOf(cur.x, cur.y)
    if ((bestG.get(ck) ?? Infinity) < cur.g) continue
    if (cur.x === t.x && cur.y === t.y) break
    const neighbors: [number, number, string][] = [
      [cur.x + 1, cur.y, 'h'], [cur.x - 1, cur.y, 'h'],
      [cur.x, cur.y + 1, 'v'], [cur.x, cur.y - 1, 'v'],
    ]
    for (const [nx, ny, ndir] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= xs.length || ny >= ys.length) continue
      const ax = xs[cur.x]; const ay = ys[cur.y]
      const bx = xs[nx]; const by = ys[ny]
      if (segHitsObstacle(ax, ay, bx, by, obstacles)) continue
      const turn = cur.dir !== '' && cur.dir !== ndir ? TURN_COST : 0
      const g = cur.g + (Math.abs(bx - ax) + Math.abs(by - ay)) + turn + crowd(ax, ay, bx, by)
      const nk = keyOf(nx, ny)
      if (g < (bestG.get(nk) ?? Infinity)) {
        bestG.set(nk, g)
        parentMap.set(nk, ck)
        open.push({ x: nx, y: ny, g, f: g + h(xs[nx], ys[ny]), dir: ndir, parent: ck })
      }
    }
  }
  if (!parentMap.has(keyOf(t.x, t.y))) {
    /* 兜底（A* 网格死角时）：① 经外侧走廊的 U 形（走廊在所有框外，保证不穿框）；
     * ② 正交 L 形折线（绝不出斜线，穿障碍时取段少的） */
    const bad = (path: string): number => {
      const nums = path.match(/-?\d+(\.\d+)?/g) ?? []
      const pts: [number, number][] = []
      for (let i = 0; i < nums.length; i += 2) pts.push([Number(nums[i]), Number(nums[i + 1])])
      let n = 0
      for (let i = 0; i + 1 < pts.length; i++) {
        for (const o of obstacles) {
          const l = o.x; const r = o.x + o.w; const tp = o.y; const bt = o.y + o.h
          if (pts[i][0] === pts[i + 1][0]) {
            if (pts[i][0] > l && pts[i][0] < r && Math.max(pts[i][1], pts[i + 1][1]) > tp && Math.min(pts[i][1], pts[i + 1][1]) < bt) n += 1
          } else if (pts[i][1] > tp && pts[i][1] < bt && Math.max(pts[i][0], pts[i + 1][0]) > l && Math.min(pts[i][0], pts[i + 1][0]) < r) n += 1
        }
      }
      return n
    }
    const candidates: string[] = []
    for (const cy of corridorYs) {
      candidates.push('M ' + String(sx) + ' ' + String(sy) + ' L ' + String(sx) + ' ' + String(cy) + ' L ' + String(tx) + ' ' + String(cy) + ' L ' + String(tx) + ' ' + String(ty))
    }
    candidates.push('M ' + String(sx) + ' ' + String(sy) + ' L ' + String(sx) + ' ' + String(ty) + ' L ' + String(tx) + ' ' + String(ty))
    candidates.push('M ' + String(sx) + ' ' + String(sy) + ' L ' + String(tx) + ' ' + String(sy) + ' L ' + String(tx) + ' ' + String(ty))
    let best: string | null = null
    let bestBad = Infinity
    for (const c of candidates) {
      const b = bad(c)
      if (b === 0) return c
      if (b < bestBad) { bestBad = b; best = c }
    }
    return best ?? candidates[0]
  }
  /* 回溯折点 */
  const pts: [number, number][] = []
  let ck = keyOf(t.x, t.y)
  const seen = new Set<string>()
  for (;;) {
    pts.unshift([xs[Number(ck.split(',')[0])], ys[Number(ck.split(',')[1])]])
    seen.add(ck)
    const par = parentMap.get(ck)
    if (par === undefined || seen.has(par)) break
    ck = par
  }
  pts.unshift([sx, sy])
  pts.push([tx, ty])
  /* 折线转 path：同向点合并 + mark 通道拥挤（供后续边代价） */
  const outPts: [number, number][] = []
  for (const pt of pts) {
    const n = outPts.length
    if (n >= 2 && ((outPts[n - 1][0] === pt[0]) === (outPts[n - 2][0] === outPts[n - 1][0]))) {
      outPts[outPts.length - 1] = pt
    } else if (n === 0 || outPts[n - 1][0] !== pt[0] || outPts[n - 1][1] !== pt[1]) {
      outPts.push(pt)
    }
  }
  for (let i = 0; i + 1 < outPts.length; i++) mark(outPts[i][0], outPts[i][1], outPts[i + 1][0], outPts[i + 1][1])
  return 'M ' + outPts.map((p) => String(p[0]) + ' ' + String(p[1])).join(' L ')
}

/** 边路由（handoff/分支/手工链共用）：按用户矩阵选引出/接入候选，逐组合跑 A*。 */
export interface EdgeRouteOptions {
  layout: Layout
  obstacles: Obstacle[]
  occupied: Map<string, number>
  from: string
  to: string
  /** 同向边序号（防起点/终点重合；j = step % 3 - 1） */
  step: number
}

export function routeEdgePath(opts: EdgeRouteOptions): string {
  const { layout, obstacles, occupied, from, to, step } = opts
  const fUp = (layout.sideOf.get(from) ?? 'up') === 'up'
  const tUp = (layout.sideOf.get(to) ?? 'up') === 'up'
  const fTop = nodeTop(layout, from)
  const tTop = nodeTop(layout, to)
  const fx = colX(layout, from)
  const tx = colX(layout, to)
  const j = (step % 3) - 1
  /* 引出/接入候选（用户矩阵，覆盖父在子左/右全部组合）：
   * 侧缘恒取父子相对的面向侧——父在子左 => 父出右缘、子入左缘；
   * 父在子右 => 父出左缘、子入右缘。
   * 引出主选 = 外侧边（down 底 / up 顶），次选面向侧缘；
   * 接入主选 = 面向侧缘，次选外侧边。 */
  const childOnRight = tx > fx
  const exitSideX = childOnRight ? fx + NODE_W / 2 + 3 : fx - NODE_W / 2 - 3
  const entrySideX = childOnRight ? tx - NODE_W / 2 - 3 : tx + NODE_W / 2 + 3
  /* 微扰沿边滑动（j*10/j*6），不垂直推回框内——否则起终点落回障碍内而孤立 */
  const exitCandidates = [
    { x: fx + j * 10, y: fUp ? fTop - 3 : fTop + NODE_H + 3 },
    { x: exitSideX, y: fTop + NODE_H / 2 + j * 6 },
  ]
  const entryCandidates = [
    { x: entrySideX, y: tTop + NODE_H / 2 + j * 6 },
    { x: tx + j * 10, y: tUp ? tTop - 3 : tTop + NODE_H + 3 },
  ]
  let fallback: string | null = null
  for (const ec of exitCandidates) {
    for (const en of entryCandidates) {
      const d = routeOrthogonal(obstacles, ec.x, ec.y, en.x, en.y, occupied)
      if (d === '') continue
      /* 2 点直连 = A* 判定不可达的兜底；换下一组合 */
      const segs = (d.match(/L/g) || []).length
      if (segs >= 1) return d
      if (fallback === null) fallback = d
    }
  }
  return fallback ?? ''
}
