/**
 * Index record of one top-level session log (pure; built from decoded text,
 * persisted by the host, kept current by merging appended chunks).
 *
 * A record carries exactly what /list needs of a session, plus what an
 * appended chunk needs to extend it without re-reading the log: the header
 * line (merge guard), the real-user-message count (turn base), the event
 * times of the last lines (last-activity scan) and the event signature
 * (fork-lineage inference; stored beside the record, see packSig).
 */
import { type ChunkScan, type EventSignature, type HandoffHit } from './parse.js';
import type { SessionNode } from './types.js';
/** Lines of log tail kept per record (the last-activity scan budget). */
export declare const TAIL_LINES = 64;
/** Signature events kept per session. Fork inference compares at most the
 *  largest fork cut; a record truncated below such a cut is decoded in full. */
export declare const SIG_CAP = 65536;
/** Log that yields no node (undecodable, or no session header line). */
export interface RecFail {
    size: number;
    mtimeMs: number;
    fail: true;
}
export interface RecOk {
    /** Bytes of the file the record covers: end of its last complete frame. */
    size: number;
    mtimeMs: number;
    fail?: false;
    /** Header line, verbatim (a merge appends only to a log with the same header). */
    head: string;
    /** Covered text ends with a newline (a merge appends whole lines). */
    nl: boolean;
    title: string | null;
    createdAt: number;
    firstUserAt: number;
    lastAt: number;
    parent: string | null;
    seeded: boolean;
    cwd: string | null;
    handoffFirst: boolean;
    handoffUsed: boolean;
    handoffHits: HandoffHit[];
    forkMarkerSeq: number | null;
    /** Real user messages so far: the turn base an appended chunk continues. */
    users: number;
    /** Event times of the covered text's last lines, oldest → newest (see tailTimes). */
    tail: number[];
}
export type Rec = RecFail | RecOk;
/** Whether a record yields a node (failed records count as unreadable logs). */
export declare function isOk(rec: Rec | undefined): rec is RecOk;
/** Event signature as columns (compact on disk; types as a first-appearance dictionary). */
export interface SigColumns {
    /** Event types in first-appearance order. */
    d: string[];
    /** Type index into `d` per event. */
    k: number[];
    /** Event seq per line. */
    s: number[];
    /** Event time per line: raw ms when `raw` is set; else the first time, then deltas from the previous event. */
    t: number[];
    raw?: true;
}
export declare function failedRec(size: number, mtimeMs: number): RecFail;
/** header.cwd of a first-frame text (null = no session header or no cwd). */
export declare function headCwd(headText: string): string | null;
/** First line of a text (the session header line). */
export declare function headerLine(text: string): string;
/** Record of a whole log; `size` = bytes of the file that `text` covers.
 *  Null text (undecodable) and a missing session header both yield a failed record. */
export declare function buildRec(text: string | null, size: number, mtimeMs: number): Rec;
/** Last activity after an append: newest line first over at most TAIL_LINES
 *  lines of the chunk, the rest of the budget over the parsed prefix, else
 *  the header time — the whole-log scan of the concatenated text. */
export declare function mergedLastAt(fresh: number[], stale: number[], fallback: number): number;
/** Merge a scanned chunk appended to the record's text (which ends with '\n'). */
export declare function extendRec(rec: RecOk, c: ChunkScan, size: number, mtimeMs: number): RecOk;
/** Column-pack an event signature, keeping at most `cap` events. Times are
 *  stored as deltas whenever every time is a safe integer (exact: integers
 *  add up without rounding); any other time switches to raw times. */
export declare function packSig(sig: EventSignature, cap?: number): SigColumns;
/** Event signature of the stored columns (inverse of packSig). */
export declare function unpackSig(sig: SigColumns): EventSignature;
/** Columns of a signature plus appended events (see packSig for the cap). */
export declare function appendSig(old: SigColumns | undefined, add: EventSignature, cap?: number): SigColumns;
/** Whether fork inference can run on these stored columns alone: they cover
 *  the cut, or they already hold the whole signature. */
export declare function sigCovers(sig: SigColumns | undefined, cut: number, cap?: number): sig is SigColumns;
/** Timeline node of a record (archived is stamped at response time). */
export declare function recNode(rec: RecOk, id: string, bucket: string): SessionNode;
/** Header fields + last activity of a log whose middle has not been read. */
export interface Skeleton {
    head: string;
    createdAt: number;
    seeded: boolean;
    cwd: string | null;
    parent: string | null;
    lastAt: number;
}
/** Skeleton from the first-frame text (session header line) and the last
 *  complete frame's text. Null = no usable session header. */
export declare function skeletonOf(headText: string, tailText: string): Skeleton | null;
/** Node of a skeleton: header lineage only (title, fork marker and handoff
 *  flags are unknown until the log is indexed; the next poll replaces it). */
export declare function skeletonNode(sk: Skeleton, id: string, bucket: string): SessionNode;
