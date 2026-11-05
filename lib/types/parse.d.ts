/**
 * Pure session-log parser (no plugin deps; shared by host and unit tests).
 * Input: decoded JSONL text of session.v4.jsonl.zstd; torn/corrupt lines are skipped.
 */
/** One handoff skill invocation (in log order). */
export interface HandoffHit {
    /** Event seq (0 = log line missing/corrupt). */
    seq: number;
    /** Event time (epoch ms; 0 = missing). */
    at: number;
    /** Turn number (real user messages delimit turns, 1-based; calls before the first message count as turn 1). */
    turn: number;
}
export interface ParsedLog {
    /** header.createdAt (session object written time; fallback/display only). */
    createdAt: number;
    /** Time of the first real user message (creation-time criterion; 0 = none yet). */
    firstUserAt: number;
    /** Time of the last log event (last activity). */
    lastAt: number;
    parent: string | null;
    seeded: boolean;
    title: string | null;
    cwd: string | null;
    /** Handoff skill ran within the first window (purple "no predecessor" criterion). */
    handoffFirst: boolean;
    /** Any handoff skill invocation appeared (gold "no successor" criterion; not last-window only). */
    handoffUsed: boolean;
    /** Handoff skill invocations (seq/time/turn each, in log order). */
    handoffHits: HandoffHit[];
    /** Own fork marker: seq of the LAST `session/end-seed` event carrying
     * `data.inherited === true` (= inherited prefix length; null = not a fork).
     * Native forks (v0.2.2-alpha.2+) no longer write header.parentSession; this
     * marker is the durable physical trace of a seeded prefix copy. Copied
     * ancestor markers also carry the flag, but the own marker is always the
     * last one in log order. */
    forkMarkerSeq: number | null;
}
export declare function parseLog(text: string): ParsedLog | null;
/** One log event's lineage tuple: (type, seq, time). A fork child's first
 * `forkMarkerSeq` tuples equal the source session's own prefix verbatim —
 * the only durable physical link native forks leave after v0.2.2-alpha.2
 * stopped writing header.parentSession. */
export type EventSignature = Array<[string, number, number]>;
/** Extract the per-event (type, seq, time) signature of a decoded log.
 * Header line (no seq) and torn/corrupt lines are skipped; lines the fast
 * regex cannot read fall back to JSON.parse for robustness. */
export declare function signatureLog(text: string): EventSignature;
