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
export function computeLayout(nodesIn, edges, manualLinks) {
    const nodes = nodesIn;
    const colOf = new Map();
    const sideOf = new Map();
    const depthOf = new Map();
    // Native lineage (handoff chains and branches): children always sink a depth row.
    const nativeParent = new Map();
    for (const e of edges)
        nativeParent.set(e.to, e.from);
    // Manual links (earlier from → later to): "to" also sinks a depth row.
    const manualParent = new Map();
    for (const l of manualLinks)
        manualParent.set(l.to, l.from);
    /* Assign side/depth in topological order: process a node only after its
     * dependency (native parent / manual from) is assigned; otherwise defer to
     * the next pass — a manual link's "from" may be created later than "to"
     * (drag semantics), so creation order is unreliable. This also stays
     * decoupled from the display sort key (lastAt etc.). */
    const byCreation = [...nodesIn].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    let flip = 0;
    let upMax = 0;
    let downMax = 0;
    const pending = byCreation;
    let progressed = true;
    while (pending.length > 0 && progressed) {
        progressed = false;
        for (let pi = pending.length - 1; pi >= 0; pi--) {
            const n = pending[pi];
            const np = nativeParent.get(n.id);
            const mp = manualParent.get(n.id);
            const dep = np ?? mp;
            if (dep !== undefined && !sideOf.has(dep))
                continue;
            let side;
            let depth;
            if (dep !== undefined) {
                // Lineage (handoff chain/branch) or manual link: inherit the parent's side, depth + 1.
                side = sideOf.get(dep) ?? 'up';
                depth = (depthOf.get(dep) ?? 0) + 1;
            }
            else {
                side = flip % 2 === 0 ? 'up' : 'down';
                depth = 0;
                flip += 1;
            }
            sideOf.set(n.id, side);
            depthOf.set(n.id, depth);
            if (side === 'up' && depth > upMax)
                upMax = depth;
            if (side === 'down' && depth > downMax)
                downMax = depth;
            pending.splice(pi, 1);
            progressed = true;
        }
    }
    // Fallback: only theoretical cycles remain; assign as standalone.
    for (const n of pending) {
        const side = flip % 2 === 0 ? 'up' : 'down';
        sideOf.set(n.id, side);
        depthOf.set(n.id, 0);
        flip += 1;
    }
    nodesIn.forEach((n, i) => { colOf.set(n.id, i); });
    const upBlock = (upMax + 1) * NODE_H + upMax * ROW_GAP;
    const downBlock = (downMax + 1) * NODE_H + downMax * ROW_GAP;
    const axisY = DATE_BAND + upBlock + GAP;
    /* Outer corridors (horizontal channels for all links): offset 12px beyond
     * the actual outer edge of the outermost box per side, so they stay clear
     * of every box and spur even with stacked depth rows. */
    const rowTop = (side, depth) => side === 'up'
        ? axisY - GAP - NODE_H - depth * (NODE_H + ROW_GAP)
        : axisY + GAP + depth * (NODE_H + ROW_GAP);
    let upOuter = Infinity;
    let downOuter = -Infinity;
    for (const n of nodes) {
        const t = rowTop(sideOf.get(n.id) ?? 'up', depthOf.get(n.id) ?? 0);
        if ((sideOf.get(n.id) ?? 'up') === 'up')
            upOuter = Math.min(upOuter, t);
        else
            downOuter = Math.max(downOuter, t + NODE_H);
    }
    const corridorUp = (upOuter === Infinity ? DATE_BAND : upOuter) - 12;
    const corridorDown = (downOuter === -Infinity ? axisY + GAP + NODE_H : downOuter) + 12;
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
    };
}
export function colX(layout, id) {
    return (layout.colOf.get(id) ?? 0) * SPACING + SPACING / 2;
}
export function nodeTop(layout, id) {
    const side = layout.sideOf.get(id) ?? 'up';
    const depth = layout.depthOf.get(id) ?? 0;
    if (side === 'up') {
        // Above the axis: depth 0 sits nearest; deeper rows stack away from the axis.
        return layout.axisY - GAP - NODE_H - depth * (NODE_H + ROW_GAP);
    }
    return layout.axisY + GAP + depth * (NODE_H + ROW_GAP);
}
//# sourceMappingURL=layout.js.map