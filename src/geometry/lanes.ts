/**
 * Lane (swimlane) layout for the all-workspaces canvas (pure functions, no
 * React/DOM deps; unit-test entry).
 *
 * Shared scale: every node — regardless of its lane — takes a column from ONE
 * global ordinal grid (index in the caller's display order; the UI applies
 * archive filter / sort key / direction first). The same column index maps to
 * the same x in every lane, so the vertical date gridlines derived from the
 * global order align across lanes (consistent ticks) while each lane keeps
 * the plain single fishbone inside: side alternation, lineage depth rows and
 * corridors come from computeLayout on the lane's own nodes (native edges and
 * manual links never cross workspaces). Lane bands stack vertically: a canvas
 * top band holds the shared date labels; each band keeps its own label row
 * (workspace name) in the box-free DATE_BAND headroom of its topmost nodes.
 */
import {
  computeLayout, SPACING, GAP, NODE_H, ROW_GAP,
  type Layout, type LayoutEdge, type LayoutManualLink, type LayoutNode,
} from './layout.js'

/** Canvas-top band for the shared date labels; lane bands start below it. */
export const TOP_BAND = 26
/** Vertical gap between consecutive lane bands. */
export const LANE_GAP = 26

export interface Lane<T extends LayoutNode = LayoutNode> extends Layout<T> {
  /** Lane id (the workspace bucket). */
  id: string
  /** Absolute canvas y of the lane band's top (lane label baseline sits at top + 13). */
  top: number
}

export interface LanesLayout<T extends LayoutNode = LayoutNode> {
  nodes: T[]
  /** Shared scale: global column per node — identical indices drive every lane's x. */
  colOf: Map<string, number>
  /** Node id → lane id. */
  laneOf: Map<string, string>
  laneById: Map<string, Lane<T>>
  /** Lane bands in stacking order (top → bottom): first appearance in the input order. */
  lanes: Lane<T>[]
  innerW: number
  innerH: number
}

export function computeLanesLayout<T extends LayoutNode>(
  nodesIn: T[],
  edges: LayoutEdge[],
  manualLinks: LayoutManualLink[],
  laneOfNode: (n: T) => string,
): LanesLayout<T> {
  /* Shared scale: global columns by display order (same rule as the single view). */
  const colOf = new Map<string, number>()
  nodesIn.forEach((n, i) => { colOf.set(n.id, i) })

  /* Group per lane, preserving display order; lane stacking order = first appearance. */
  const laneIds: string[] = []
  const byLane = new Map<string, T[]>()
  for (const n of nodesIn) {
    const lane = laneOfNode(n)
    const list = byLane.get(lane)
    if (list === undefined) { byLane.set(lane, [n]); laneIds.push(lane) }
    else list.push(n)
  }

  const laneOf = new Map<string, string>()
  const laneById = new Map<string, Lane<T>>()
  const lanes: Lane<T>[] = []
  let y = TOP_BAND
  for (const laneId of laneIds) {
    const laneNodes = byLane.get(laneId) ?? []
    const member = new Set(laneNodes.map((n) => n.id))
    /* Native edges / manual links stay within one workspace; the filter also
     * guards against out-of-lane pairs reaching this lane's router. */
    const laneEdges = edges.filter((e) => member.has(e.from) && member.has(e.to))
    const laneLinks = manualLinks.filter((l) => member.has(l.from) && member.has(l.to))
    const base = computeLayout(laneNodes, laneEdges, laneLinks)
    /* Shared scale overrides the lane-local columns; band geometry shifts by the stack offset. */
    const laneColOf = new Map<string, number>()
    for (const n of laneNodes) laneColOf.set(n.id, colOf.get(n.id) ?? 0)
    const lane: Lane<T> = {
      ...base,
      id: laneId,
      top: y,
      colOf: laneColOf,
      axisY: base.axisY + y,
      corridorUp: base.corridorUp + y,
      corridorDown: base.corridorDown + y,
    }
    for (const n of laneNodes) laneOf.set(n.id, laneId)
    laneById.set(laneId, lane)
    lanes.push(lane)
    y += base.innerH + LANE_GAP
  }

  return {
    nodes: nodesIn,
    colOf,
    laneOf,
    laneById,
    lanes,
    innerW: Math.max(nodesIn.length * SPACING + 24, 320),
    innerH: laneIds.length > 0 ? y - LANE_GAP : TOP_BAND,
  }
}

/** Absolute canvas x of a node within the lane stack (shared-scale column). */
export function laneColX<T extends LayoutNode>(l: LanesLayout<T>, id: string): number {
  return (l.colOf.get(id) ?? 0) * SPACING + SPACING / 2
}

/** Absolute canvas y of a node box top within the lane stack (its own lane's axis). */
export function laneNodeTop<T extends LayoutNode>(l: LanesLayout<T>, id: string): number {
  const lane = l.laneById.get(l.laneOf.get(id) ?? '')
  if (lane === undefined) return 0
  const side = lane.sideOf.get(id) ?? 'up'
  const depth = lane.depthOf.get(id) ?? 0
  if (side === 'up') {
    // Above the lane axis: depth 0 sits nearest; deeper rows stack away from it.
    return lane.axisY - GAP - NODE_H - depth * (NODE_H + ROW_GAP)
  }
  return lane.axisY + GAP + depth * (NODE_H + ROW_GAP)
}
