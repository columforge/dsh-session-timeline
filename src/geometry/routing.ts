/**
 * Orthogonal obstacle-avoiding routing (pure functions, no React/DOM deps; unit-test entry).
 *
 * Node boxes (padded 2px) are obstacles; the canvas builds an orthogonal
 * channel grid at box edges ±8px. Each edge runs A* on the grid
 * (cost = length + turns ×10 + occupied-channel crowding ×30), yielding an
 * orthogonal polyline that crosses no box and adapts to any layout/link combo.
 *
 * Three historical pitfalls (check first on regressions):
 * 1. Channel coordinates must not include points inside an obstacle (e.g. box
 *    centers) — endpoints snapping inside get stranded;
 * 2. Endpoints must be exact points 3px outside the box edge (after the 2px
 *    obstacle padding the box edge lies inside the obstacle);
 * 3. Anti-overlap nudges must slide along the edge (exits horizontally along
 *    the top/bottom edge, entries vertically along the side) — perpendicular
 *    nudges push the point back inside the obstacle, same effect as 1.
 */

import { colX, nodeTop, NODE_W, NODE_H, type Layout } from './layout.js'

export interface Obstacle { x: number; y: number; w: number; h: number }

export const OBST_PAD = 2
export const EDGE_PAD = 8
export const TURN_COST = 10
export const CROWD_COST = 30

/** Does the orthogonal segment (x1,y1)-(x2,y2) cross any obstacle (open interval; edge-touching allowed)? */
export function segHitsObstacle(x1: number, y1: number, x2: number, y2: number, obs: Obstacle[]): boolean {
  for (const o of obs) {
    const l = o.x; const r = o.x + o.w; const t = o.y; const b = o.y + o.h
    if (x1 === x2) {
      // vertical segment
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
  /* Channel coordinates: all box edges ±8 plus both endpoints; deduped and near-neighbors merged. */
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

  /* A*: cost = step + turn ×10 + channel crowding ×30 (occupied is caller-owned and shared across edges). */
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
    /* Fallback when A* hits a grid dead end: ① U-shape via an outer corridor
     * (corridors lie outside every box, so no box is crossed);
     * ② orthogonal L polyline (never diagonal; pick the one crossing fewer
     * obstacles when it does). */
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
  /* Backtrack waypoints. */
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
  /* Polyline → path: merge same-direction points + mark channel crowding (feeds later edges' costs). */
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

/** Edge routing (shared by handoff/branch/manual links): picks exit/entry candidates per the user matrix and runs A* per combination. */
export interface EdgeRouteOptions {
  layout: Layout
  obstacles: Obstacle[]
  occupied: Map<string, number>
  from: string
  to: string
  /** Same-direction edge index (avoids coinciding start/end; j = step % 3 - 1). */
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
  /* Exit/entry candidates (user matrix; covers every parent-left/right combo):
   * side edges always face the counterpart — parent left of child ⇒ parent
   * exits right edge, child enters left edge; parent right ⇒ mirrored.
   * Exit primary = outer edge (bottom for down / top for up), secondary = facing side edge;
   * entry primary = facing side edge, secondary = outer edge. */
  const childOnRight = tx > fx
  const exitSideX = childOnRight ? fx + NODE_W / 2 + 3 : fx - NODE_W / 2 - 3
  const entrySideX = childOnRight ? tx - NODE_W / 2 - 3 : tx + NODE_W / 2 + 3
  /* Nudges slide along the edge (j*10/j*6), never perpendicular — that would push endpoints back inside the obstacle and strand them. */
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
      /* 2-point direct connect = A* deemed unreachable; try the next combo. */
      const segs = (d.match(/L/g) || []).length
      if (segs >= 1) return d
      if (fallback === null) fallback = d
    }
  }
  return fallback ?? ''
}
