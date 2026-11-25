/**
 * Pure session-log parser (no plugin deps; shared by host and unit tests).
 * Input: decoded JSONL text of session.v4.jsonl.zstd; torn/corrupt lines are skipped.
 *
 * Split into one scanner per fact (title, fork marker, user messages, last
 * activity, handoff calls) so each rule stays under the ub-mode CRAP budget:
 * the composition lives in parseLog, the per-line decoding in the helpers.
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
/** Session header fields the timeline reads (first log line). */
export interface HeaderFields {
    createdAt: number;
    parent: string | null;
    seeded: boolean;
    cwd: string | null;
}
/** First line = session header; validates type/id, parses the six fields the timeline reads. */
export declare function parseHeader(text: string): HeaderFields | null;
/** Event times of the last `budget` lines, oldest → newest (0 = the line
 *  carries no usable time; a trailing newline adds no empty line). Kept as
 *  data so the last-activity scan of an appended chunk can continue it. */
export declare function tailTimes(text: string, budget?: number): number[];
export declare function lastActivity(text: string, fallback: number): number;
export declare function parseLog(text: string): ParsedLog | null;
/** parseLog plus `users` = real user messages of the own conversation (the
 *  turn base an appended chunk continues from). */
export declare function parseLogFull(text: string): (ParsedLog & {
    users: number;
}) | null;
/** One log event's lineage tuple: (type, seq, time). A fork child's first
 * `forkMarkerSeq` tuples equal the source session's own prefix verbatim —
 * the only durable physical link native forks leave after v0.2.2-alpha.2
 * stopped writing header.parentSession. */
export type EventSignature = Array<[string, number, number]>;
/** Extract the per-event (type, seq, time) signature of a decoded log.
 * Header line (no seq) and torn/corrupt lines are skipped; lines the fast
 * regex cannot read fall back to JSON.parse for robustness. */
export declare function signatureLog(text: string): EventSignature;
/** Handoff invocation inside a chunk; its turn = base + before (the base = real
 *  user messages of the parsed prefix). */
export interface ChunkHit {
    seq: number;
    at: number;
    before: number;
}
/** What an appended chunk contributes on its own. */
export interface ChunkScan {
    title: string | null;
    /** Time of the chunk's first real user message (0 = none). */
    firstUserAt: number;
    /** Real user messages inside the chunk (added to the turn base). */
    users: number;
    hits: ChunkHit[];
    /** Event times of the chunk's last lines (see tailTimes). */
    tail: number[];
    /** Event signature of the chunk's lines (appended to the prefix signature). */
    sig: EventSignature;
}
/** Scan a chunk that starts on a line boundary after text ending with '\n'.
 *  Null = the chunk carries an own fork marker: that marker gates which user
 *  messages and handoff calls count, so the whole log must be re-parsed. */
export declare function scanChunk(chunk: string): ChunkScan | null;
