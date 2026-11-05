/**
 * Fishbone + depth-row layout (pure functions, no React/DOM deps; unit-test entry).
 *
 * Columns follow input order (UI sorts by creation/activity time); side:
 * standalone nodes alternate up/down, lineage children inherit the parent's
 * side; depth: standalone/branch children = 0 (fishbone layer, spur to the
 * axis), handoff child = parent + 1 (rows stack outward = lineage depth row).
 * Row height LH = NODE_H + ROW_GAP.
 */
export declare const SPACING = 140;
export declare const NODE_W = 132;
export declare const NODE_H = 96;
export declare const GAP = 26;
export declare const ROW_GAP = 16;
export declare const DATE_BAND = 16;
/** Node fields the layout needs (UI nodes may carry more; generics preserved). */
export interface LayoutNode {
    id: string;
    createdAt: number;
}
export interface LayoutEdge {
    from: string;
    to: string;
}
export interface LayoutManualLink {
    from: string;
    to: string;
}
export interface Layout<T extends LayoutNode = LayoutNode> {
    nodes: T[];
    colOf: Map<string, number>;
    sideOf: Map<string, 'up' | 'down'>;
    depthOf: Map<string, number>;
    axisY: number;
    innerW: number;
    innerH: number;
    maxDepth: number;
    corridorUp: number;
    corridorDown: number;
}
export declare function computeLayout<T extends LayoutNode>(nodesIn: T[], edges: LayoutEdge[], manualLinks: LayoutManualLink[]): Layout<T>;
export declare function colX(layout: Layout, id: string): number;
export declare function nodeTop(layout: Layout, id: string): number;
