/**
 * Fishbone + depth-row layout (pure functions, no React/DOM deps; unit-test entry).
 *
 * Columns follow input order (UI sorts by creation/activity time); side:
 * standalone nodes alternate up/down, lineage children inherit the parent's
 * side; depth: standalone/branch children = 0 (fishbone layer, spur to the
 * axis), handoff child = parent + 1 (rows stack outward = lineage depth row).
 * Row height LH = NODE_H + ROW_GAP.
 */
export const SPACING = 140;
export const NODE_W = 132;
export const NODE_H = 96;
export const GAP = 26;
export const ROW_GAP = 16;
export const DATE_BAND = 16;
/** Top of a node box on one side at one depth row. */
function rowTop(side, depth, axisY) {
    return side === 'up'
        ? axisY - GAP - NODE_H - depth * (NODE_H + ROW_GAP)
        : axisY + GAP + depth * (NODE_H + ROW_GAP);
}
/** Dependency = native parent if present, else manual predecessor (both normalized to parent→child). */
function dependencyOf(node, state) {
    return state.nativeParent.get(node.id) ?? state.manualParent.get(node.id);
}
/** Record one assignment and widen the side's max depth. */
function commitAssignment(state, nodeId, side, depth) {
    state.sideOf.set(nodeId, side);
    state.depthOf.set(nodeId, depth);
    if (side === 'up' && depth > state.upMax)
        state.upMax = depth;
    if (side === 'down' && depth > state.downMax)
        state.downMax = depth;
}
/** Standalone node: alternate sides, depth 0. */
function assignStandalone(node, state) {
    const side = state.flip % 2 === 0 ? 'up' : 'down';
    state.flip += 1;
    commitAssignment(state, node.id, side, 0);
}
/**
 * Assign one node when its dependency is already assigned.
 * @returns true when the node was assigned (standalone counts), false when deferred.
 */
function assignNode(node, state) {
    const dep = dependencyOf(node, state);
    if (dep === undefined) {
        assignStandalone(node, state);
        return true;
    }
    if (!state.sideOf.has(dep))
        return false;
    const side = state.sideOf.get(dep) ?? 'up';
    const depth = (state.depthOf.get(dep) ?? 0) + 1;
    commitAssignment(state, node.id, side, depth);
    return true;
}
/* Assign side/depth in topological order: process a node only after its
 * dependency (native parent / manual from) is assigned; otherwise defer to
 * the next pass — a manual link's "from" may be created later than "to"
 * (drag semantics), so creation order is unreliable. This also stays
 * decoupled from the display sort key (lastAt etc.). Only theoretical cycles
 * remain after the passes; they fall back to standalone. */
function assignSides(byCreation, state) {
    const pending = byCreation;
    let progressed = true;
    while (pending.length > 0 && progressed) {
        progressed = false;
        for (let pi = pending.length - 1; pi >= 0; pi -= 1) {
            if (!assignNode(pending[pi], state))
                continue;
            pending.splice(pi, 1);
            progressed = true;
        }
    }
    for (const node of pending)
        assignStandalone(node, state);
}
/** Outer box bounds per side (Infinity/-Infinity when no nodes on that side). */
function outerBounds(nodes, sideOf, depthOf, axisY) {
    let up = Infinity;
    let down = -Infinity;
    for (const node of nodes) {
        const side = sideOf.get(node.id) ?? 'up';
        const top = rowTop(side, depthOf.get(node.id) ?? 0, axisY);
        if (side === 'up')
            up = Math.min(up, top);
        else
            down = Math.max(down, top + NODE_H);
    }
    return { up, down };
}
export function computeLayout(nodesIn, edges, manualLinks) {
    const nodes = nodesIn;
    // Native lineage (handoff chains and branches): children always sink a depth row.
    const nativeParent = new Map();
    for (const e of edges)
        nativeParent.set(e.to, e.from);
    // Manual links (earlier from → later to): "to" also sinks a depth row.
    const manualParent = new Map();
    for (const l of manualLinks)
        manualParent.set(l.to, l.from);
    const byCreation = [...nodesIn].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    const state = {
        nativeParent,
        manualParent,
        sideOf: new Map(),
        depthOf: new Map(),
        flip: 0,
        upMax: 0,
        downMax: 0,
    };
    assignSides(byCreation, state);
    const colOf = new Map();
    nodesIn.forEach((n, i) => { colOf.set(n.id, i); });
    const upBlock = (state.upMax + 1) * NODE_H + state.upMax * ROW_GAP;
    const downBlock = (state.downMax + 1) * NODE_H + state.downMax * ROW_GAP;
    const axisY = DATE_BAND + upBlock + GAP;
    /* Outer corridors (horizontal channels for all links): offset 12px beyond
     * the actual outer edge of the outermost box per side, so they stay clear
     * of every box and spur even with stacked depth rows. */
    const outer = outerBounds(nodes, state.sideOf, state.depthOf, axisY);
    const corridorUp = (outer.up === Infinity ? DATE_BAND : outer.up) - 12;
    const corridorDown = (outer.down === -Infinity ? axisY + GAP + NODE_H : outer.down) + 12;
    return {
        nodes,
        colOf,
        sideOf: state.sideOf,
        depthOf: state.depthOf,
        axisY,
        innerW: Math.max(nodes.length * SPACING + 24, 320),
        innerH: axisY + GAP + downBlock + DATE_BAND,
        maxDepth: Math.max(state.upMax, state.downMax),
        corridorUp,
        corridorDown,
    };
}
export function colX(layout, id) {
    return (layout.colOf.get(id) ?? 0) * SPACING + SPACING / 2;
}
export function nodeTop(layout, id) {
    return rowTop(layout.sideOf.get(id) ?? 'up', layout.depthOf.get(id) ?? 0, layout.axisY);
}
//# sourceMappingURL=layout.js.map