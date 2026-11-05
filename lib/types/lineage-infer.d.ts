/**
 * Pure native-fork lineage inference (no plugin deps; unit-test entry).
 *
 * Native forks (DSH v0.2.2-alpha.2+, commit b096659245) no longer write
 * header.parentSession — "ordinary forks independent of source lineage".
 * The durable physical trace: a fork child's LAST `session/end-seed` event
 * carries `data.inherited === true` and its seq equals the inherited prefix
 * length; that prefix's (type, seq, time) tuples equal the source session's
 * own prefix verbatim (parse.forkMarkerSeq + parse.signatureLog).
 *
 * Attribution = full-prefix match against the same bucket's top-level
 * sessions; ties (a whole fork family shares prefixes) resolve to the
 * earliest log header createdAt — the source must already exist when the
 * child was forked, so the oldest matching candidate is the true parent.
 * header.createdAt is mandatory here: the first real user message time is
 * identical across a fork family and must NOT be used.
 *
 * Lineage never crosses buckets: the caller only ever passes one bucket's
 * nodes and signatures.
 */
/** Minimal node view the inference reads. */
export interface InferNode {
    id: string;
    /** Raw header.parentSession (may be null, or point outside the bucket). */
    parent: string | null;
    /** Own fork marker seq (= inherited prefix length); null = not a fork. */
    forkMarkerSeq: number | null;
    /** Raw log header.createdAt (fork-family-safe tie-break). */
    logCreatedAt: number;
}
/** Per-event lineage tuple list (parse.signatureLog output). */
export type EventSignature = ReadonlyArray<readonly [string, number, number]>;
export interface InferredParent {
    parent: string;
    /** Matched prefix length (the child's fork marker seq). */
    matchedSeq: number;
}
/**
 * Infer each fork child's source session within one bucket.
 * @param nodes - the bucket's top-level session nodes.
 * @param signatureOf - session id → event signature (null = unreadable).
 * @returns id → inferred parent, only for children whose header parent is
 *   absent or points outside the bucket (in-bucket header lineage wins).
 */
export declare function inferForkParents(nodes: readonly InferNode[], signatureOf: (id: string) => EventSignature | null): Map<string, InferredParent>;
