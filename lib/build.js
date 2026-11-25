/**
 * Whole-log index build (used on a worker thread and, when workers are off
 * or unavailable, on the request path): one file → one record + signature.
 */
import { readFile, stat } from 'node:fs/promises';
import { completeEnd, decodeLog } from './logfile.js';
import { buildRec, failedRec, packSig, SIG_CAP } from './record.js';
import { signatureLog } from './parse.js';
/** Build the record of one whole log: read → decode the complete frames →
 *  parse + signature in the same pass over the text. size = bytes actually
 *  covered (end of the last complete frame, so an appended chunk starts on a
 *  frame boundary); mtimeMs = the file's mtime once the read settled (file
 *  size unchanged across the read), else the caller's earlier stat — the
 *  next stat then classifies the record as grown and merges the rest.
 *  Never rejects: an unreadable file yields a failed record. */
export async function buildJob(job) {
    try {
        const buffer = await readFile(job.file);
        const size = completeEnd(buffer);
        const text = decodeLog(buffer);
        const after = await stat(job.file);
        const rec = buildRec(text, size, after.size === size ? after.mtimeMs : job.mtimeMs);
        if (text === null || rec.fail === true)
            return { sid: job.sid, rec };
        return { sid: job.sid, rec, sig: packSig(signatureLog(text), SIG_CAP) };
    }
    catch {
        return { sid: job.sid, rec: failedRec(job.size, job.mtimeMs) };
    }
}
//# sourceMappingURL=build.js.map