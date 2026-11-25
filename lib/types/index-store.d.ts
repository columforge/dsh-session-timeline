import type { Rec, SigColumns } from './record.js';
/** Bump whenever record semantics change: files of other versions are ignored. */
export declare const INDEX_VERSION = 1;
type Obj = Record<string, unknown>;
/** Stored record → record; null = malformed (its session is rebuilt from the log). */
export declare function readRec(r: Obj): Rec | null;
/** Stored signature columns → columns; null = malformed. `raw` is either
 *  absent (times are deltas) or true (times as stored); nothing else. */
export declare function readSig(s: Obj): SigColumns | null;
/** Parse <bucket>.json (null = absent, unreadable or unusable → rebuild). */
export declare function parseIndex(text: string, bucket: string): Map<string, Rec> | null;
/** Parse <bucket>.sig.json (same contract as parseIndex). */
export declare function parseSigs(text: string, bucket: string): Map<string, SigColumns> | null;
export declare function serializeIndex(bucket: string, recs: ReadonlyMap<string, Rec>): string;
export declare function serializeSigs(bucket: string, sigs: ReadonlyMap<string, SigColumns>): string;
export type FileClass = 'same' | 'grow' | 'work';
/** What a session file's current size + mtime ask for, given its record:
 *  same → both match: the record is current.
 *  grow → the file grew past a record that ends on a frame boundary: merge the appended bytes.
 *  work → everything else (no record, shrunk, rewritten, failed record): rebuild. */
export declare function classify(rec: Rec | undefined, size: number, mtimeMs: number): FileClass;
export {};
