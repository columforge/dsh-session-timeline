import { type Rec, type SigColumns } from './record.js';
export interface BuildJob {
    sid: string;
    file: string;
    /** Caller's stat of the file (size + mtime) before the job was queued. */
    size: number;
    mtimeMs: number;
}
export interface BuildResult {
    sid: string;
    rec: Rec;
    /** Event signature columns (absent for a failed record). */
    sig?: SigColumns;
}
/** Build the record of one whole log: read → decode the complete frames →
 *  parse + signature in the same pass over the text. size = bytes actually
 *  covered (end of the last complete frame, so an appended chunk starts on a
 *  frame boundary); mtimeMs = the file's mtime once the read settled (file
 *  size unchanged across the read), else the caller's earlier stat — the
 *  next stat then classifies the record as grown and merges the rest.
 *  Never rejects: an unreadable file yields a failed record. */
export declare function buildJob(job: BuildJob): Promise<BuildResult>;
