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
import { type Layout, type LayoutEdge, type LayoutManualLink, type LayoutNode } from './layout.js';
/** Canvas-top band for the shared date labels; lane bands start below it. */
export declare const TOP_BAND = 26;
/** Vertical gap between consecutive lane bands. */
export declare const LANE_GAP = 26;
/** Band height of a collapsed lane (label row only, no fishbone content). */
export declare const COLLAPSED_H = 28;
export interface Lane<T extends LayoutNode = LayoutNode> extends Layout<T> {
    /** Lane id (the workspace bucket). */
    id: string;
    /** Absolute canvas y of the lane band's top (lane label baseline sits at top + 13). */
    top: number;
    /** Collapsed lane: slim label-only band; nodes/columns stay out of the shared scale. */
    collapsed: boolean;
}
export interface LanesLayout<T extends LayoutNode = LayoutNode> {
    nodes: T[];
    /** Shared scale: global column per node — identical indices drive every lane's x. */
    colOf: Map<string, number>;
    /** Node id → lane id. */
    laneOf: Map<string, string>;
    laneById: Map<string, Lane<T>>;
    /** Lane bands in stacking order (top → bottom): first appearance in the input order. */
    lanes: Lane<T>[];
    innerW: number;
    innerH: number;
}
/** `collapsed` = ids of lanes to render as slim label-only bands (their nodes stay out of the scale). */
export declare function computeLanesLayout<T extends LayoutNode>(nodesIn: T[], edges: LayoutEdge[], manualLinks: LayoutManualLink[], laneOfNode: (n: T) => string, collapsed?: Set<string>): LanesLayout<T>;
/** Absolute canvas x of a node within the lane stack (shared-scale column). */
export declare function laneColX<T extends LayoutNode>(l: LanesLayout<T>, id: string): number;
/** Absolute canvas y of a node box top within the lane stack (its own lane's axis). */
export declare function laneNodeTop<T extends LayoutNode>(l: LanesLayout<T>, id: string): number;
