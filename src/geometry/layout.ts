/**
 * 鱼骨 + 深度行布局（纯函数，无 React/DOM 依赖；单测入口）。
 *
 * 列 = 传入顺序（UI 按创建/活动时间排好）；side = 独立节点奇偶交替、
 * 血缘子继承父侧；depth = 独立/分支子 0（鱼骨层，鱼刺接轴），handoff 子 =
 * 父 + 1（向轴外侧叠行 = 血缘深度行）。行高 LH = NODE_H + ROW_GAP。
 */

export const SPACING = 160
export const NODE_W = 132
export const NODE_H = 96
export const GAP = 34
export const ROW_GAP = 24
export const DATE_BAND = 18

/** 布局只需的节点字段（UI 节点可带更多字段，泛型保留）。 */
export interface LayoutNode {
  id: string
  createdAt: number
}

export interface LayoutEdge {
  from: string
  to: string
}

export interface LayoutManualLink {
  from: string
  to: string
}

export interface Layout<T extends LayoutNode = LayoutNode> {
  nodes: T[]
  colOf: Map<string, number>
  sideOf: Map<string, 'up' | 'down'>
  depthOf: Map<string, number>
  axisY: number
  innerW: number
  innerH: number
  maxDepth: number
  corridorUp: number
  corridorDown: number
}

export function computeLayout<T extends LayoutNode>(
  nodesIn: T[],
  edges: LayoutEdge[],
  manualLinks: LayoutManualLink[],
): Layout<T> {
  const nodes = nodesIn
  const colOf = new Map<string, number>()
  const sideOf = new Map<string, 'up' | 'down'>()
  const depthOf = new Map<string, number>()
  // 原生血缘（handoff 链与分支）：子会话一律下沉深度行
  const nativeParent = new Map<string, string>()
  for (const e of edges) nativeParent.set(e.to, e.from)
  // 手工衔接（from 创建较早 → to 较晚）：to 未被子会话化时同样下沉深度行
  const manualParent = new Map<string, string>()
  for (const l of manualLinks) manualParent.set(l.to, l.from)
  /* 分派（side/depth）按拓扑序：依赖（原生父 / 手工 from）已分派才处理该节点，
   * 依赖未定则延后到下一轮——手工链的父创建可晚于子（拖拽语义），创建序不可靠；
   * 同时与显示排序键（lastAt 等）解耦。 */
  const byCreation = [...nodesIn].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
  let flip = 0
  let upMax = 0
  let downMax = 0
  const pending = byCreation
  let progressed = true
  while (pending.length > 0 && progressed) {
    progressed = false
    for (let pi = pending.length - 1; pi >= 0; pi--) {
      const n = pending[pi]
      const np = nativeParent.get(n.id)
      const mp = manualParent.get(n.id)
      const dep = np ?? mp
      if (dep !== undefined && !sideOf.has(dep)) continue
      let side: 'up' | 'down'
      let depth: number
      if (dep !== undefined) {
        // 血缘（handoff 链/分支）或手工链：继承父侧，深度 + 1（血缘深度行）
        side = sideOf.get(dep) ?? 'up'
        depth = (depthOf.get(dep) ?? 0) + 1
      } else {
        side = flip % 2 === 0 ? 'up' : 'down'
        depth = 0
        flip += 1
      }
      sideOf.set(n.id, side)
      depthOf.set(n.id, depth)
      if (side === 'up' && depth > upMax) upMax = depth
      if (side === 'down' && depth > downMax) downMax = depth
      pending.splice(pi, 1)
      progressed = true
    }
  }
  // 兜底：仅理论成环才会残留，按独立分派
  for (const n of pending) {
    const side: 'up' | 'down' = flip % 2 === 0 ? 'up' : 'down'
    sideOf.set(n.id, side)
    depthOf.set(n.id, 0)
    flip += 1
  }
  nodesIn.forEach((n, i) => { colOf.set(n.id, i) })
  const upBlock = (upMax + 1) * NODE_H + upMax * ROW_GAP
  const downBlock = (downMax + 1) * NODE_H + downMax * ROW_GAP
  const axisY = DATE_BAND + upBlock + GAP
  /* 外侧走廊（所有连线的水平通道）：按该侧最外框的实际外缘再外移 12px，
   * 保证深度行叠高后走廊仍在所有框与鱼刺之外 */
  const rowTop = (side: 'up' | 'down', depth: number): number =>
    side === 'up'
      ? axisY - GAP - NODE_H - depth * (NODE_H + ROW_GAP)
      : axisY + GAP + depth * (NODE_H + ROW_GAP)
  let upOuter = Infinity
  let downOuter = -Infinity
  for (const n of nodes) {
    const t = rowTop(sideOf.get(n.id) ?? 'up', depthOf.get(n.id) ?? 0)
    if ((sideOf.get(n.id) ?? 'up') === 'up') upOuter = Math.min(upOuter, t)
    else downOuter = Math.max(downOuter, t + NODE_H)
  }
  const corridorUp = (upOuter === Infinity ? DATE_BAND : upOuter) - 12
  const corridorDown = (downOuter === -Infinity ? axisY + GAP + NODE_H : downOuter) + 12
  return {
    nodes,
    colOf,
    sideOf,
    depthOf,
    axisY,
    innerW: Math.max(nodes.length * SPACING + 24, 320),
    innerH: axisY + GAP + downBlock + DATE_BAND,
    maxDepth: Math.max(upMax, downMax),
    corridorUp,
    corridorDown,
  }
}

export function colX(layout: Layout, id: string): number {
  return (layout.colOf.get(id) ?? 0) * SPACING + SPACING / 2
}

export function nodeTop(layout: Layout, id: string): number {
  const side = layout.sideOf.get(id) ?? 'up'
  const depth = layout.depthOf.get(id) ?? 0
  if (side === 'up') {
    // 轴上方：depth 0 最靠轴，深度行向上（远离轴）叠
    return layout.axisY - GAP - NODE_H - depth * (NODE_H + ROW_GAP)
  }
  return layout.axisY + GAP + depth * (NODE_H + ROW_GAP)
}
