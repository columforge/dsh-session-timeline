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
/** Cut length of the child's own marker, or null when the node is not a fork. */
function validCut(node) {
    const cut = node.forkMarkerSeq;
    if (cut === null || !Number.isSafeInteger(cut) || cut <= 0)
        return null;
    return cut;
}
/** In-bucket header lineage wins: inference only fills gaps (absent/out-of-bucket parent). */
function hasBucketParent(node, bucketIds) {
    return node.parent !== null && bucketIds.has(node.parent);
}
/** True when the child's first `cut` tuples equal the candidate's own prefix verbatim. */
function prefixMatches(prefix, candidate, cut) {
    for (let i = 0; i < cut; i += 1) {
        const a = prefix[i];
        const b = candidate[i];
        if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2])
            return false;
    }
    return true;
}
/** Tie-break: the source must predate the child; an equal logCreatedAt resolves to the smaller id. */
function earlierThan(candidate, best) {
    if (best === null)
        return true;
    if (candidate.logCreatedAt !== best.logCreatedAt)
        return candidate.logCreatedAt < best.logCreatedAt;
    return candidate.id < best.id;
}
/** Earliest-logCreatedAt candidate whose own prefix matches the child's marker cut. */
function bestParent(child, nodes, signatureOf, cut, prefix) {
    let best = null;
    for (const candidate of nodes) {
        if (candidate.id === child.id)
            continue;
        const sig = signatureOf(candidate.id);
        if (sig === null || sig.length < cut)
            continue;
        if (!prefixMatches(prefix, sig, cut))
            continue;
        if (earlierThan(candidate, best))
            best = candidate;
    }
    return best;
}
/**
 * Infer each fork child's source session within one bucket.
 * @param nodes - the bucket's top-level session nodes.
 * @param signatureOf - session id → event signature (null = unreadable).
 * @returns id → inferred parent, only for children whose header parent is
 *   absent or points outside the bucket (in-bucket header lineage wins).
 */
export function inferForkParents(nodes, signatureOf) {
    const out = new Map();
    const bucketIds = new Set(nodes.map((n) => n.id));
    for (const node of nodes) {
        const cut = validCut(node);
        if (cut === null || hasBucketParent(node, bucketIds))
            continue;
        const sig = signatureOf(node.id);
        if (sig === null || sig.length < cut)
            continue;
        const parent = bestParent(node, nodes, signatureOf, cut, sig.slice(0, cut));
        if (parent !== null)
            out.set(node.id, { parent: parent.id, matchedSeq: cut });
    }
    return out;
}
//# sourceMappingURL=lineage-infer.js.map