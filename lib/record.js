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
import { lastActivity, parseHeader, parseLogFull, tailTimes } from './parse.js';
/** Lines of log tail kept per record (the last-activity scan budget). */
export const TAIL_LINES = 64;
/** Signature events kept per session. Fork inference compares at most the
 *  largest fork cut; a record truncated below such a cut is decoded in full. */
export const SIG_CAP = 65536;
/** Whether a record yields a node (failed records count as unreadable logs). */
export function isOk(rec) {
    return rec !== undefined && rec.fail !== true;
}
export function failedRec(size, mtimeMs) {
    return { size, mtimeMs, fail: true };
}
/** Session header of a first-frame text (the frame may hold the header line alone). */
function sessionHeader(headText) {
    return parseHeader(headText.endsWith('\n') ? headText : headText + '\n');
}
/** header.cwd of a first-frame text (null = no session header or no cwd). */
export function headCwd(headText) {
    const header = sessionHeader(headText);
    return header === null ? null : header.cwd;
}
/** First line of a text (the session header line). */
export function headerLine(text) {
    const cut = text.indexOf('\n');
    return cut > 0 ? text.slice(0, cut) : text;
}
/** Record of a whole log; `size` = bytes of the file that `text` covers.
 *  Null text (undecodable) and a missing session header both yield a failed record. */
export function buildRec(text, size, mtimeMs) {
    const log = text === null ? null : parseLogFull(text);
    if (text === null || log === null)
        return failedRec(size, mtimeMs);
    return {
        size,
        mtimeMs,
        head: headerLine(text),
        nl: text.endsWith('\n'),
        title: log.title,
        createdAt: log.createdAt,
        firstUserAt: log.firstUserAt,
        lastAt: log.lastAt,
        parent: log.parent,
        seeded: log.seeded,
        cwd: log.cwd,
        handoffFirst: log.handoffFirst,
        handoffUsed: log.handoffUsed,
        handoffHits: log.handoffHits,
        forkMarkerSeq: log.forkMarkerSeq,
        users: log.users,
        tail: tailTimes(text),
    };
}
/** Last activity after an append: newest line first over at most TAIL_LINES
 *  lines of the chunk, the rest of the budget over the parsed prefix, else
 *  the header time — the whole-log scan of the concatenated text. */
export function mergedLastAt(fresh, stale, fallback) {
    const used = Math.min(fresh.length, TAIL_LINES);
    for (let i = used - 1; i >= 0; i -= 1) {
        const time = fresh[i];
        if (time > 0)
            return time;
    }
    const room = TAIL_LINES - used;
    for (let i = stale.length - 1, seen = 0; i >= 0 && seen < room; i -= 1, seen += 1) {
        const time = stale[i];
        if (time > 0)
            return time;
    }
    return fallback;
}
/** Merge a scanned chunk appended to the record's text (which ends with '\n'). */
export function extendRec(rec, c, size, mtimeMs) {
    const hits = [...rec.handoffHits, ...c.hits.map((hit) => ({ seq: hit.seq, at: hit.at, turn: Math.max(rec.users + hit.before, 1) }))];
    return {
        ...rec,
        size,
        mtimeMs,
        title: c.title ?? rec.title,
        firstUserAt: rec.firstUserAt > 0 ? rec.firstUserAt : c.firstUserAt,
        lastAt: mergedLastAt(c.tail, rec.tail, rec.createdAt),
        handoffHits: hits,
        handoffFirst: hits.length > 0 && hits[0].turn <= 1,
        handoffUsed: hits.length > 0,
        users: rec.users + c.users,
        tail: [...rec.tail, ...c.tail].slice(-TAIL_LINES),
    };
}
/** Column-pack an event signature, keeping at most `cap` events. Times are
 *  stored as deltas whenever every time is a safe integer (exact: integers
 *  add up without rounding); any other time switches to raw times. */
export function packSig(sig, cap = SIG_CAP) {
    const d = [];
    const index = new Map();
    const k = [];
    const s = [];
    const t = [];
    const raw = !sig.every(([, , time]) => Number.isSafeInteger(time));
    let prev = 0;
    for (const [type, seq, time] of sig) {
        if (k.length >= cap)
            break;
        let at = index.get(type);
        if (at === undefined) {
            at = d.length;
            index.set(type, at);
            d.push(type);
        }
        k.push(at);
        s.push(seq);
        t.push(raw || k.length === 1 ? time : time - prev);
        prev = time;
    }
    return raw ? { d, k, s, t, raw: true } : { d, k, s, t };
}
/** Event signature of the stored columns (inverse of packSig). */
export function unpackSig(sig) {
    const out = [];
    let prev = 0;
    for (let i = 0; i < sig.k.length; i += 1) {
        const time = sig.raw === true || i === 0 ? sig.t[i] : prev + sig.t[i];
        prev = time;
        out.push([sig.d[sig.k[i]], sig.s[i], time]);
    }
    return out;
}
/** Columns of a signature plus appended events (see packSig for the cap). */
export function appendSig(old, add, cap = SIG_CAP) {
    return packSig(old === undefined ? add : [...unpackSig(old), ...add], cap);
}
/** Whether fork inference can run on these stored columns alone: they cover
 *  the cut, or they already hold the whole signature. */
export function sigCovers(sig, cut, cap = SIG_CAP) {
    return sig !== undefined && (sig.k.length >= cut || sig.k.length < cap);
}
/** Timeline node of a record (archived is stamped at response time). */
export function recNode(rec, id, bucket) {
    return {
        id,
        title: rec.title,
        createdAt: rec.firstUserAt > 0 ? rec.firstUserAt : rec.createdAt,
        logCreatedAt: rec.createdAt,
        lastAt: rec.lastAt,
        parent: rec.parent,
        parentSource: rec.parent !== null ? 'header' : null,
        forkMarkerSeq: rec.forkMarkerSeq,
        seeded: rec.seeded,
        cwd: rec.cwd,
        bucket,
        handoffFirst: rec.handoffFirst,
        handoffUsed: rec.handoffUsed,
        handoffHits: rec.handoffHits,
        // Response-time flag: the record always carries false;
        // stampArchived overwrites it at /list assembly.
        archived: false,
    };
}
/** Skeleton from the first-frame text (session header line) and the last
 *  complete frame's text. Null = no usable session header. */
export function skeletonOf(headText, tailText) {
    const header = sessionHeader(headText);
    if (header === null)
        return null;
    return {
        head: headerLine(headText),
        createdAt: header.createdAt,
        seeded: header.seeded,
        cwd: header.cwd,
        parent: header.parent,
        lastAt: lastActivity(tailText, header.createdAt),
    };
}
/** Node of a skeleton: header lineage only (title, fork marker and handoff
 *  flags are unknown until the log is indexed; the next poll replaces it). */
export function skeletonNode(sk, id, bucket) {
    return {
        id,
        title: null,
        createdAt: sk.createdAt,
        logCreatedAt: sk.createdAt,
        lastAt: sk.lastAt,
        parent: sk.parent,
        parentSource: sk.parent !== null ? 'header' : null,
        forkMarkerSeq: null,
        seeded: sk.seeded,
        cwd: sk.cwd,
        bucket,
        handoffFirst: false,
        handoffUsed: false,
        handoffHits: [],
        archived: false,
    };
}
//# sourceMappingURL=record.js.map