/** Bump whenever record semantics change: files of other versions are ignored. */
export const INDEX_VERSION = 1;
const obj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const count = (v) => num(v) && Number.isInteger(v) && v >= 0;
const str = (v) => typeof v === 'string';
const text = (v) => typeof v === 'string' && v !== '';
const bool = (v) => typeof v === 'boolean';
const nullable = (ok) => (v) => v === null || ok(v);
const list = (ok) => (v) => Array.isArray(v) && v.every(ok);
const hit = (v) => obj(v) && num(v.seq) && num(v.at) && count(v.turn) && v.turn >= 1;
const strs = (v) => Array.isArray(v) && v.every(str);
const nums = (v) => Array.isArray(v) && v.every(num);
const counts = (v) => Array.isArray(v) && v.every(count);
const textFields = (r) => (r.fail === undefined || r.fail === false) && str(r.head) && bool(r.nl) && nullable(text)(r.title) && nullable(text)(r.parent) && nullable(text)(r.cwd);
const flagFields = (r) => bool(r.seeded) && bool(r.handoffFirst) && bool(r.handoffUsed) && nullable(num)(r.forkMarkerSeq);
const timeFields = (r) => num(r.createdAt) && num(r.firstUserAt) && num(r.lastAt) && count(r.users) && nums(r.tail) && list(hit)(r.handoffHits);
const fieldsOk = (r) => textFields(r) && flagFields(r) && timeFields(r);
/** Stored record → record; null = malformed (its session is rebuilt from the log). */
export function readRec(r) {
    if (!num(r.size) || r.size < 0 || !num(r.mtimeMs))
        return null;
    if (r.fail === true)
        return Object.keys(r).length === 3 ? { size: r.size, mtimeMs: r.mtimeMs, fail: true } : null;
    if (!fieldsOk(r))
        return null;
    return {
        size: r.size,
        mtimeMs: r.mtimeMs,
        head: r.head,
        nl: r.nl,
        title: r.title,
        createdAt: r.createdAt,
        firstUserAt: r.firstUserAt,
        lastAt: r.lastAt,
        parent: r.parent,
        seeded: r.seeded,
        cwd: r.cwd,
        handoffFirst: r.handoffFirst,
        handoffUsed: r.handoffUsed,
        handoffHits: r.handoffHits,
        forkMarkerSeq: r.forkMarkerSeq,
        users: r.users,
        tail: r.tail,
    };
}
/** Column arrays agree with each other and with the type dictionary. */
function columnsOk(s) {
    if (!strs(s.d) || !counts(s.k) || !counts(s.s) || !nums(s.t))
        return false;
    const { d, k, s: seqs, t } = s;
    return k.length === seqs.length && t.length === k.length && k.every((at) => at < d.length);
}
/** Stored signature columns → columns; null = malformed. `raw` is either
 *  absent (times are deltas) or true (times as stored); nothing else. */
export function readSig(s) {
    if (!columnsOk(s) || (s.raw !== undefined && s.raw !== true))
        return null;
    const { d, k, s: seqs, t } = s;
    return s.raw === true ? { d, k, s: seqs, t, raw: true } : { d, k, s: seqs, t };
}
/** Parse <bucket>.json (null = absent, unreadable or unusable → rebuild). */
export function parseIndex(text, bucket) {
    const raw = parseEnvelope(text, bucket, 'recs');
    if (raw === null)
        return null;
    const recs = new Map();
    for (const [sid, value] of Object.entries(raw)) {
        const rec = obj(value) ? readRec(value) : null;
        if (rec !== null)
            recs.set(sid, rec);
    }
    return recs;
}
/** Parse <bucket>.sig.json (same contract as parseIndex). */
export function parseSigs(text, bucket) {
    const raw = parseEnvelope(text, bucket, 'sigs');
    if (raw === null)
        return null;
    const sigs = new Map();
    for (const [sid, value] of Object.entries(raw)) {
        const sig = obj(value) ? readSig(value) : null;
        if (sig !== null)
            sigs.set(sid, sig);
    }
    return sigs;
}
/** The `table` of a well-formed index file envelope ({ v, bucket, <table> }). */
function parseEnvelope(text, bucket, table) {
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch {
        return null;
    }
    if (!obj(raw) || raw.v !== INDEX_VERSION || raw.bucket !== bucket || !obj(raw[table]))
        return null;
    return raw[table];
}
export function serializeIndex(bucket, recs) {
    return JSON.stringify({ v: INDEX_VERSION, bucket, recs: Object.fromEntries(recs) });
}
export function serializeSigs(bucket, sigs) {
    return JSON.stringify({ v: INDEX_VERSION, bucket, sigs: Object.fromEntries(sigs) });
}
/** What a session file's current size + mtime ask for, given its record:
 *  same → both match: the record is current.
 *  grow → the file grew past a record that ends on a frame boundary: merge the appended bytes.
 *  work → everything else (no record, shrunk, rewritten, failed record): rebuild. */
export function classify(rec, size, mtimeMs) {
    if (rec === undefined)
        return 'work';
    if (rec.size === size && rec.mtimeMs === mtimeMs)
        return 'same';
    if (size > rec.size && rec.fail !== true && rec.nl)
        return 'grow';
    return 'work';
}
//# sourceMappingURL=index-store.js.map