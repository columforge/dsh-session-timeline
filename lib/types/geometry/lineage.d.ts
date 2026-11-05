/**
 * Merged lineage-chain semantics (pure functions, no React/DOM deps; unit-test entry).
 *
 * A lineage chain = native edges (from header.parentSession; handoff/branch)
 * ∪ manual links (from = earlier-created side). Everything "chain" semantics
 * — in/out degrees (gold/purple frame criteria), branch detection (⑂N badge,
 * link display kind), detail lineage/successor narration — is computed on the
 * merged chain; the origin (native/manual) only affects display annotation
 * (color, "(manual)" label), never chain semantics. Manual edges are
 * normalized by the host to creation order, same direction as native
 * parent→child.
 */
export interface LineageEdge {
    from: string;
    to: string;
}
export interface LineageLink {
    from: string;
    to: string;
}
export interface LineageDegree {
    /** Merged in-degree (native + manual; purple "no predecessor" criterion). */
    in: number;
    /** Merged out-degree (native + manual; gold "no successor" criterion, ⑂N badge, branch detection). */
    out: number;
    nativeIn: number;
    manualIn: number;
    nativeOut: number;
    manualOut: number;
}
/** Merged degrees: native and manual edges count equally (computed once; shared by badge/frame criteria/details). */
export declare function lineageDegrees(edges: LineageEdge[], links: LineageLink[]): Map<string, LineageDegree>;
/** Display kind of a link: merged out-degree ≥ 2 = branch (fan-out, purple solid), else handoff (chained, blue solid).
 *  The host's edges[].kind keeps the native criterion (by native child count);
 *  display kind is derived here — when the parent also has a manual successor,
 *  a native single-child edge displays as a branch (result of merged chain
 *  semantics). */
export declare function displayKind(edge: LineageEdge, degrees: Map<string, LineageDegree>): 'handoff' | 'branch';
