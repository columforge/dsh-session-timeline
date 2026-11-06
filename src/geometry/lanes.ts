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
 * Collapsed lanes (collapsed set) render as slim label-only bands: their nodes
 * stay out of the shared scale, so the grid covers visible lanes only.
 */
import {
  computeLayout, SPACING, GAP, NODE_H, ROW_GAP,
  type Layout, type LayoutEdge, type LayoutManualLink, type LayoutNode,
} from './layout.js'

/** Canvas-top band for the shared date labels; lane bands start below it. */
export const TOP_BAND = 26
/** Vertical gap between consecutive lane bands. */
export const LANE_GAP = 26
/** Band height of a collapsed lane (label row only, no fishbone content). */
export const COLLAPSED_H = 28

export interface Lane<T extends LayoutNode = LayoutNode> extends Layout<T> {
  /** Lane id (the workspace bucket). */
  id: string
  /** Absolute canvas y of the lane band's top (lane label baseline sits at top + 13). */
  top: number
  /** Collapsed lane: slim label-only band; nodes/columns stay out of the shared scale. */
  collapsed: boolean
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

/** Shared scale: global columns by display order (same rule as the single view), skipping collapsed lanes. */
function assignSharedColumns<T extends LayoutNode>(
  nodesIn: T[],
  laneOfNode: (n: T) => string,
  collapsed: Set<string> | undefined,
): Map<string, number> {
  const colOf = new Map<string, number>()
  let ci = 0
  for (const n of nodesIn) {
    if (collapsed !== undefined && collapsed.has(laneOfNode(n))) continue
    colOf.set(n.id, ci)
    ci += 1
  }
  return colOf
}

/** Group per lane, preserving display order; lane stacking order = first appearance. */
function groupByLane<T extends LayoutNode>(
  nodesIn: T[],
  laneOfNode: (n: T) => string,
): { laneIds: string[]; byLane: Map<string, T[]> } {
  const laneIds: string[] = []
  const byLane = new Map<string, T[]>()
  for (const n of nodesIn) {
    const lane = laneOfNode(n)
    const list = byLane.get(lane)
    if (list === undefined) {
      byLane.set(lane, [n])
      laneIds.push(lane)
    } else {
      list.push(n)
    }
  }
  return { laneIds, byLane }
}

/** Collapsed lane: slim label-only band; its nodes stay out of nodes/colOf/laneOf. */
function collapsedLane<T extends LayoutNode>(laneId: string, y: number): Lane<T> {
  return {
    nodes: [], colOf: new Map(), sideOf: new Map(), depthOf: new Map(),
    axisY: y + COLLAPSED_H, innerW: 0, innerH: COLLAPSED_H, maxDepth: 0,
    corridorUp: y, corridorDown: y + COLLAPSED_H,
    id: laneId, top: y, collapsed: true,
  }
}

/** One visible lane: fishbone on the lane's own nodes, then shared columns + stack offset. */
function buildLane<T extends LayoutNode>(
  laneId: string,
  laneNodes: T[],
  y: number,
  colOf: Map<string, number>,
  edges: LayoutEdge[],
  manualLinks: LayoutManualLink[],
): Lane<T> {
  const member = new Set(laneNodes.map((n) => n.id))
  /* Native edges / manual links stay within one workspace; the filter also
   * guards against out-of-lane pairs reaching this lane's router. */
  const base = computeLayout(
    laneNodes,
    edges.filter((e) => member.has(e.from) && member.has(e.to)),
    manualLinks.filter((l) => member.has(l.from) && member.has(l.to)),
  )
  /* Shared scale overrides the lane-local columns; band geometry shifts by the stack offset. */
  const laneColOf = new Map<string, number>()
  for (const n of laneNodes) laneColOf.set(n.id, colOf.get(n.id) ?? 0)
  return {
    ...base,
    id: laneId,
    top: y,
    collapsed: false,
    colOf: laneColOf,
    axisY: base.axisY + y,
    corridorUp: base.corridorUp + y,
    corridorDown: base.corridorDown + y,
  }
}

/** `collapsed` = ids of lanes to render as slim label-only bands (their nodes stay out of the scale). */
export function computeLanesLayout<T extends LayoutNode>(
  nodesIn: T[],
  edges: LayoutEdge[],
  manualLinks: LayoutManualLink[],
  laneOfNode: (n: T) => string,
  collapsed?: Set<string>,
): LanesLayout<T> {
  const colOf = assignSharedColumns(nodesIn, laneOfNode, collapsed)
  const { laneIds, byLane } = groupByLane(nodesIn, laneOfNode)
  const laneOf = new Map<string, string>()
  const laneById = new Map<string, Lane<T>>()
  const lanes: Lane<T>[] = []
  let y = TOP_BAND
  for (const laneId of laneIds) {
    if (collapsed !== undefined && collapsed.has(laneId)) {
      const lane = collapsedLane<T>(laneId, y)
      laneById.set(laneId, lane)
      lanes.push(lane)
      y += COLLAPSED_H + LANE_GAP
      continue
    }
    const laneNodes = byLane.get(laneId) ?? []
    const lane = buildLane(laneId, laneNodes, y, colOf, edges, manualLinks)
    for (const n of laneNodes) laneOf.set(n.id, laneId)
    laneById.set(laneId, lane)
    lanes.push(lane)
    y += lane.innerH + LANE_GAP
  }

  const gridNodes = nodesIn.filter((n) => !(collapsed !== undefined && collapsed.has(laneOfNode(n))))
  return {
    nodes: gridNodes,
    colOf,
    laneOf,
    laneById,
    lanes,
    innerW: Math.max(gridNodes.length * SPACING + 24, 320),
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
