import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { availableParallelism, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import z from 'schemastery';
import { scanChunk, signatureLog } from './parse.js';
import { extractTurns } from './turns.js';
import { inferForkParents } from './lineage-infer.js';
import { ZSTD_MAGIC, completeEnd, decodeLog, firstFrameText, lastFrameText } from './logfile.js';
import { appendSig, extendRec, headCwd, headerLine, isOk, recNode, sigCovers, skeletonNode, skeletonOf, unpackSig, } from './record.js';
import { classify, parseIndex, parseSigs, serializeIndex, serializeSigs } from './index-store.js';
import { buildJob } from './build.js';
import { createPool } from './pool.js';
export const name = '@columforge/session-timeline';
export const inject = ['webServer'];
export const Config = z.object({
    storage_dir: z.string().default(''),
    workers: z.number().default(-1),
});
const SESSION_FILE = 'session.v4.jsonl.zstd';
/** Sentinel bucket name for the global timeline (/list?workspace=__global__ aggregates all;
 *  /link and /unlink resolve each endpoint back to its own bucket). */
export const GLOBAL_BUCKET = '__global__';
/** Upper bound for the auto worker count (builds are CPU-bound; the host keeps a core). */
const WORKER_CAP = 4;
/** Appended bytes merged on the request path: per file, and per table request. */
const MERGE_FILE_BYTES = 256 * 1024;
const MERGE_REQUEST_BYTES = 1024 * 1024;
/** Skeleton reads: first/last-frame windows (grown ×4 up to the whole file). */
const EDGE_WINDOW_BYTES = 64 * 1024;
/** Index writes: debounce after a change, then at most once per gap under continuous appends. */
const PERSIST_DELAY_MS = 500;
const RECS_WRITE_GAP_MS = 5000;
const SIGS_WRITE_GAP_MS = 30000;
function dshHomeDir() {
    return process.env.DSH_HOME || join(homedir(), '.dsh');
}
/** Workspace path → bucket encoding: /a/b → --a-b-- (matches decisions-tracker). */
export function encodeBucket(workspacePath) {
    const clean = workspacePath.replace(/\/+$/, '').replace(/^\//, '');
    return '--' + clean.replaceAll('/', '-') + '--';
}
function loadDoc(root, bucket) {
    try {
        const file = join(root, bucket + '.json');
        if (!existsSync(file))
            return { doc: { version: 1, links: [] }, fail: null };
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (!Array.isArray(parsed.links))
            return { doc: { version: 1, links: [] }, fail: { code: 'storageRead', text: '存储文件 links 字段缺失，已按空账处理' } };
        return { doc: { version: 1, links: parsed.links }, fail: null };
    }
    catch (e) {
        return { doc: { version: 1, links: [] }, fail: { code: 'storageRead', text: '存储文件读取失败：' + String(e).slice(0, 120), params: { message: String(e).slice(0, 120) } } };
    }
}
function saveDoc(root, bucket, doc) {
    try {
        mkdirSync(root, { recursive: true });
        const file = join(root, bucket + '.json');
        const tmp = file + '.tmp';
        writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
        renameSync(tmp, file);
        return null;
    }
    catch (e) {
        return { code: 'storageWrite', text: '存储文件写入失败：' + String(e).slice(0, 120), params: { message: String(e).slice(0, 120) } };
    }
}
export function apply(ctx, config) {
    const root = config.storage_dir.trim() !== ''
        ? config.storage_dir
        : join(dshHomeDir(), 'session-timeline');
    const sessionsRoot = join(dshHomeDir(), 'sessions');
    const indexDir = join(root, 'index');
    mkdirSync(root, { recursive: true });
    /* ---- Build workers: whole-log builds off the event loop (0 = on the request path) ---- */
    const wanted = config.workers ?? -1;
    const threads = wanted > 0 ? wanted : wanted === 0 ? 0 : Math.max(1, Math.min(WORKER_CAP, availableParallelism() - 1));
    const pool = threads === 0 ? null : createPool(threads, fileURLToPath(new URL('./worker.js', import.meta.url)));
    /* ---- Workspace archive set (service first, durable file fallback) ---- */
    const archiveFile = join(dshHomeDir(), 'storages', 'workspace.json');
    let archiveCache = null;
    /** The registry-global archive set; read failures degrade to "nothing archived". */
    const archivedIds = () => {
        // Runtime mirror first (works with any storage backend); optional get —
        // absent/unstarted registry falls through to the durable file below.
        const reg = ctx
            .get?.('workspaceRegistry');
        if (reg?.archivedSessionIds !== undefined)
            return new Set(reg.archivedSessionIds);
        try {
            const st = statSync(archiveFile);
            if (archiveCache !== null && archiveCache.mtimeMs === st.mtimeMs)
                return archiveCache.ids;
            const parsed = JSON.parse(readFileSync(archiveFile, 'utf8'));
            const ids = Array.isArray(parsed?.global?.archivedSessionIds)
                ? new Set(parsed.global.archivedSessionIds.filter((x) => typeof x === 'string'))
                : new Set();
            archiveCache = { mtimeMs: st.mtimeMs, ids };
            return ids;
        }
        catch { /* unreadable/absent storage file = no archive info */ }
        return new Set();
    };
    /** Stamp the response-only archived flag (the index stays flag-free). */
    const stampArchived = (nodes) => {
        const ids = archivedIds();
        return nodes.map((n) => ({ ...n, archived: ids.has(n.id) }));
    };
    /** Session id → bucket (scans session buckets; positive results cached). */
    const bucketCache = new Map();
    const sessionBucket = (sessionId) => {
        const hit = bucketCache.get(sessionId);
        if (hit !== undefined)
            return hit;
        try {
            for (const ent of readdirSync(sessionsRoot, { withFileTypes: true })) {
                if (!ent.isDirectory())
                    continue;
                if (existsSync(join(sessionsRoot, ent.name, sessionId))) {
                    bucketCache.set(sessionId, ent.name);
                    return ent.name;
                }
            }
        }
        catch { /* unreadable sessions root = unresolved */ }
        return null;
    };
    /* ---- Session index (records + signatures per bucket; the logs stay the truth) ---- */
    const buckets = new Map();
    const stateOf = (bucket) => {
        let st = buckets.get(bucket);
        if (st === undefined) {
            st = {
                recs: new Map(), sigs: new Map(), full: new Map(), recsLoaded: null, sigsLoaded: null,
                recsDirty: false, sigsDirty: false, timer: null, lastRecsWrite: 0, lastSigsWrite: 0,
                building: new Map(), skeletons: new Map(), wave: null,
            };
            buckets.set(bucket, st);
        }
        return st;
    };
    /** Text of an index file ('' = absent or unreadable: the logs rebuild it). */
    const readIndexFile = async (name) => {
        try {
            return await readFile(join(indexDir, name), 'utf8');
        }
        catch {
            return '';
        }
    };
    /** Load a bucket's records once per host run (shared by concurrent requests). */
    const loadRecs = (st, bucket) => {
        st.recsLoaded ??= readIndexFile(bucket + '.json').then((text) => {
            const recs = text === '' ? null : parseIndex(text, bucket);
            st.recs = recs ?? new Map();
            // A foreign/corrupt/older-version file is replaced on the first change.
            if (recs === null && text !== '')
                st.recsDirty = true;
        });
        return st.recsLoaded;
    };
    /** Load a bucket's signatures on demand (only fork-bearing buckets need them). */
    const loadSigs = (st, bucket) => {
        st.sigsLoaded ??= readIndexFile(bucket + '.sig.json').then((text) => {
            const sigs = text === '' ? null : parseSigs(text, bucket);
            if (sigs !== null)
                st.sigs = sigs;
        });
        return st.sigsLoaded;
    };
    /** Replace an index file atomically (tmp + rename: a crash leaves the old file). */
    const writeFileAtomic = (name, text) => {
        const file = join(indexDir, name);
        writeFileSync(file + '.tmp', text, 'utf8');
        renameSync(file + '.tmp', file);
    };
    /** Write what is due (synchronous: the maps must not change under the serializer). */
    const flushIndex = (st, bucket, force = false) => {
        const now = Date.now();
        const recs = st.recsDirty && (force || now - st.lastRecsWrite >= RECS_WRITE_GAP_MS);
        const sigs = st.sigsDirty && (force || now - st.lastSigsWrite >= SIGS_WRITE_GAP_MS);
        if (!recs && !sigs)
            return;
        try {
            mkdirSync(indexDir, { recursive: true });
            if (recs) {
                writeFileAtomic(bucket + '.json', serializeIndex(bucket, st.recs));
                st.lastRecsWrite = now;
                st.recsDirty = false;
            }
            if (sigs) {
                writeFileAtomic(bucket + '.sig.json', serializeSigs(bucket, st.sigs));
                st.lastSigsWrite = now;
                st.sigsDirty = false;
            }
        }
        catch { /* the index is a cache: retried on the next change or at dispose */ }
    };
    /** Debounce after the last change, honoring the write gaps. */
    const persistDelay = (st) => {
        const now = Date.now();
        const waitRecs = st.recsDirty ? RECS_WRITE_GAP_MS - (now - st.lastRecsWrite) : 0;
        const waitSigs = st.sigsDirty ? SIGS_WRITE_GAP_MS - (now - st.lastSigsWrite) : 0;
        return Math.max(PERSIST_DELAY_MS, waitRecs, waitSigs);
    };
    const schedulePersist = (st, bucket) => {
        if (st.timer !== null)
            return;
        st.timer = setTimeout(() => {
            st.timer = null;
            flushIndex(st, bucket);
            if (st.recsDirty || st.sigsDirty)
                schedulePersist(st, bucket);
        }, persistDelay(st));
        st.timer.unref?.();
    };
    /** Mark a bucket's index changed (signatures too) and schedule its write. */
    const touch = (st, bucket, sigsToo = false) => {
        st.recsDirty = true;
        if (sigsToo)
            st.sigsDirty = true;
        schedulePersist(st, bucket);
    };
    /* ---- File reads (all async: nothing below blocks the event loop but decoding) ---- */
    /** Bytes [from, to) of a file; null = unreadable or shorter than expected. */
    const readSlice = async (file, from, to) => {
        try {
            const handle = await open(file, 'r');
            try {
                const buf = Buffer.allocUnsafe(to - from);
                const { bytesRead } = await handle.read(buf, 0, to - from, from);
                return bytesRead === to - from ? buf : null;
            }
            finally {
                await handle.close();
            }
        }
        catch {
            return null;
        }
    };
    /** Text of the first complete frame of a file (the header frame). */
    const readHead = async (file, size) => {
        for (let window = EDGE_WINDOW_BYTES;; window *= 4) {
            const buf = await readSlice(file, 0, Math.min(size, window));
            if (buf === null)
                return null;
            const text = firstFrameText(buf);
            if (text !== null || buf.length >= size)
                return text;
        }
    };
    /** Text of the last complete frame of a file (a flush in progress is skipped). */
    const readTail = async (file, size) => {
        for (let window = EDGE_WINDOW_BYTES;; window *= 4) {
            const from = Math.max(0, size - window);
            const buf = await readSlice(file, from, size);
            if (buf === null)
                return null;
            const text = lastFrameText(buf);
            if (text !== null || from === 0)
                return text;
        }
    };
    /** Top-level session files of a bucket with their current size + mtime. */
    const statTopLevel = async (bucket) => {
        let ents;
        try {
            ents = await readdir(join(sessionsRoot, bucket), { withFileTypes: true });
        }
        catch {
            return [];
        }
        const stats = await Promise.all(ents.map(async (ent) => {
            if (!ent.isDirectory() || !ent.name.startsWith('session-'))
                return null;
            const file = join(sessionsRoot, bucket, ent.name, SESSION_FILE);
            try {
                const st = await stat(file);
                return { sid: ent.name, file, size: st.size, mtimeMs: st.mtimeMs };
            }
            catch {
                return null;
            }
        }));
        return stats.filter((f) => f !== null);
    };
    /* ---- Keep records current: prune, merge appended frames, rebuild ---- */
    /** Drop what belongs to sessions that left the bucket. */
    const prune = (st, bucket, sids) => {
        let changed = false;
        for (const sid of st.recs.keys()) {
            if (sids.has(sid))
                continue;
            st.recs.delete(sid);
            st.sigs.delete(sid);
            st.full.delete(sid);
            st.skeletons.delete(sid);
            changed = true;
        }
        if (changed)
            touch(st, bucket, true);
    };
    /** Merge the bytes appended to an indexed log on the request path (complete
     *  frames only, at most MERGE_FILE_BYTES). A torn frame alone changes
     *  nothing: the record keeps its size and the next poll merges the rest.
     *  Null = anything unusual → the log is rebuilt. */
    const mergeGrown = async (st, bucket, rec, f, sig) => {
        const head = await readSlice(f.file, 0, Math.min(f.size, EDGE_WINDOW_BYTES));
        const tail = f.size - rec.size <= MERGE_FILE_BYTES ? await readSlice(f.file, rec.size, f.size) : null;
        if (head === null || tail === null)
            return null;
        const first = firstFrameText(head);
        if (first === null || headerLine(first) !== rec.head)
            return null;
        if (tail.length < 4 || tail.readUInt32LE(0) !== ZSTD_MAGIC)
            return null;
        const text = decodeLog(tail);
        if (text === null)
            return completeEnd(tail) === 0 ? rec : null;
        const c = scanChunk(text);
        if (c === null)
            return null;
        const next = extendRec(rec, c, rec.size + completeEnd(tail), f.mtimeMs);
        st.recs.set(f.sid, next);
        st.sigs.set(f.sid, appendSig(sig, c.sig));
        touch(st, bucket, true);
        return next;
    };
    const applyResult = (st, bucket, r) => {
        st.recs.set(r.sid, r.rec);
        st.skeletons.delete(r.sid);
        if (r.sig === undefined)
            st.sigs.delete(r.sid);
        else
            st.sigs.set(r.sid, r.sig);
        st.full.delete(r.sid);
        touch(st, bucket, true);
    };
    /** Build a log's record: on a worker when possible (a dead pool falls back
     *  to the request path), inline when workers are off. Shared by concurrent
     *  requests of the same session; never rejects. */
    const startBuild = (st, bucket, f) => {
        const running = st.building.get(f.sid);
        if (running !== undefined)
            return running;
        const job = { sid: f.sid, file: f.file, size: f.size, mtimeMs: f.mtimeMs };
        const run = pool === null ? buildJob(job) : pool.build(job).catch(() => buildJob(job));
        const wave = (st.wave ??= { total: 0, done: 0 });
        wave.total += 1;
        const tracked = (async () => {
            try {
                applyResult(st, bucket, await run);
            }
            catch { /* not stored: the next request classifies the file and rebuilds */ }
            wave.done += 1;
            st.building.delete(f.sid);
        })();
        st.building.set(f.sid, tracked);
        return tracked;
    };
    /** Skeleton of a log still being built (cached per file state; never stored). */
    const skeletonFor = async (st, f) => {
        const hit = st.skeletons.get(f.sid);
        if (hit !== undefined && hit.size === f.size && hit.mtimeMs === f.mtimeMs)
            return hit.sk;
        const head = await readHead(f.file, f.size);
        const tail = head === null ? null : await readTail(f.file, f.size);
        const sk = head === null || tail === null ? null : skeletonOf(head, tail);
        st.skeletons.set(f.sid, { size: f.size, mtimeMs: f.mtimeMs, sk });
        return sk;
    };
    /** Node of an indexed session; a failed record counts as an unreadable log. */
    const addSettled = (st, bucket, sid, view) => {
        const rec = st.recs.get(sid);
        if (isOk(rec))
            view.nodes.push(recNode(rec, sid, bucket));
        else
            view.unreadable += 1;
    };
    /** The bucket's table. Unchanged records are reused as is, appended frames
     *  are merged; the rest is built — awaited when `wait` (or workers are off),
     *  else started in the background and reported through pending/building. */
    const tableView = async (bucket, wait) => {
        const st = stateOf(bucket);
        await loadRecs(st, bucket);
        const files = await statTopLevel(bucket);
        prune(st, bucket, new Set(files.map((f) => f.sid)));
        const view = { nodes: [], unreadable: 0, pending: 0, building: 0, done: 0 };
        const stale = [];
        let budget = MERGE_REQUEST_BYTES;
        for (const f of files) {
            const rec = st.recs.get(f.sid);
            const cls = classify(rec, f.size, f.mtimeMs);
            if (cls === 'same') {
                addSettled(st, bucket, f.sid, view);
                continue;
            }
            // Appended frames within the request budget merge here; the rest is rebuilt.
            if (cls !== 'grow' || rec === undefined || rec.fail === true || f.size - rec.size > budget) {
                stale.push(f);
                continue;
            }
            const merged = await mergeGrown(st, bucket, rec, f, st.sigs.get(f.sid));
            if (merged === null) {
                stale.push(f);
                continue;
            }
            budget -= merged.size - rec.size;
            view.nodes.push(recNode(merged, f.sid, bucket));
        }
        if (wait) {
            await Promise.all(stale.map((f) => startBuild(st, bucket, f)));
            for (const f of stale)
                addSettled(st, bucket, f.sid, view);
            st.wave = null;
        }
        else if (stale.length > 0) {
            // Still being built when the response leaves: answer with the previous
            // record (slightly old beats absent) or a skeleton, and say so.
            await Promise.all(stale.map(async (f) => {
                void startBuild(st, bucket, f);
                view.pending += 1;
                const rec = st.recs.get(f.sid);
                if (isOk(rec)) {
                    view.nodes.push(recNode(rec, f.sid, bucket));
                    return;
                }
                const sk = await skeletonFor(st, f);
                if (sk !== null)
                    view.nodes.push(skeletonNode(sk, f.sid, bucket));
            }));
            view.building = st.wave?.total ?? stale.length;
            view.done = st.wave?.done ?? 0;
        }
        else {
            st.wave = null;
        }
        view.nodes.sort((a, b2) => a.lastAt - b2.lastAt);
        return view;
    };
    /* ---- Fork-lineage inference over the index ---- */
    /** Whole-log signature of a session whose stored columns are shorter than a
     *  fork cut (records truncated at SIG_CAP); kept per file state. */
    const decodeFullSig = async (st, bucket, sid) => {
        const rec = st.recs.get(sid);
        if (!isOk(rec))
            return;
        const hit = st.full.get(sid);
        if (hit !== undefined && hit.size === rec.size && hit.mtimeMs === rec.mtimeMs)
            return;
        try {
            const text = decodeLog(await readFile(join(sessionsRoot, bucket, sid, SESSION_FILE)));
            if (text === null)
                return;
            st.full.set(sid, { size: rec.size, mtimeMs: rec.mtimeMs, sig: signatureLog(text) });
        }
        catch { /* unreadable: inference skips this candidate */ }
    };
    /** Native forks stopped writing header.parentSession (DSH v0.2.2-alpha.2),
     *  so header lineage alone misses every new fork. For children with an own
     *  fork marker whose header parent is absent/out-of-bucket, recover the
     *  source via the inherited-prefix signature match (pure logic in
     *  ./lineage-infer; same bucket only — lineage never crosses workspaces).
     *  Signatures come from the index; sessions still being built sit out. */
    const resolveForkParents = async (bucket, nodes) => {
        if (!nodes.some((n) => n.forkMarkerSeq !== null))
            return;
        const st = stateOf(bucket);
        await loadSigs(st, bucket);
        const cut = Math.max(...nodes.map((n) => n.forkMarkerSeq ?? 0));
        const indexed = nodes.filter((n) => isOk(st.recs.get(n.id)));
        const lacking = indexed.filter((n) => !sigCovers(st.sigs.get(n.id), cut));
        await Promise.all(lacking.map((n) => decodeFullSig(st, bucket, n.id)));
        /** Whole-log signature of an indexed session: the stored columns when they
         *  cover the cut, else the decoded signature of the same file state. */
        const signatureOf = (id) => {
            const sig = st.sigs.get(id);
            if (sigCovers(sig, cut))
                return unpackSig(sig);
            const rec = st.recs.get(id);
            const full = st.full.get(id);
            return full !== undefined && isOk(rec) && full.size === rec.size && full.mtimeMs === rec.mtimeMs ? full.sig : null;
        };
        const inferred = inferForkParents(nodes, signatureOf);
        for (const n of nodes) {
            const hit = inferred.get(n.id);
            if (hit !== undefined) {
                n.parent = hit.parent;
                n.parentSource = 'inferred';
            }
        }
    };
    /** Native edges: a fork child (own inherited end-seed marker) is a branch
     *  edge even as an only child — a fork is a fork regardless of fan-out;
     *  multiple children always branch; a single non-fork child chains as
     *  handoff (header parentSession lineage / pre-marker era). */
    const nativeEdges = (nodes) => {
        const byId = new Set(nodes.map((n) => n.id));
        const childCount = new Map();
        for (const n of nodes) {
            if (n.parent !== null && byId.has(n.parent))
                childCount.set(n.parent, (childCount.get(n.parent) ?? 0) + 1);
        }
        const out = [];
        for (const n of nodes) {
            if (n.parent === null || !byId.has(n.parent))
                continue;
            const branch = (childCount.get(n.parent) ?? 0) >= 2 || n.forkMarkerSeq !== null;
            out.push({ from: n.parent, to: n.id, kind: branch ? 'branch' : 'handoff' });
        }
        return out;
    };
    /* ---- Workspace list ---- */
    /** cwd of the first session in readdir order whose header carries one: the
     *  indexed header for records, else the first frame alone (child sessions
     *  are never parsed in full; failed logs are skipped). */
    const bucketCwd = async (bucket, files) => {
        const st = stateOf(bucket);
        await loadRecs(st, bucket);
        for (const f of files) {
            const rec = st.recs.get(f.sid);
            if (rec !== undefined) {
                if (isOk(rec) && rec.cwd !== null)
                    return rec.cwd;
                continue;
            }
            const head = await readHead(join(sessionsRoot, bucket, f.sid, SESSION_FILE), f.size);
            const cwd = head === null ? null : headCwd(head);
            if (cwd !== null)
                return cwd;
        }
        return null;
    };
    /** Workspace list: bucket + cwd + top-level session count (= node count) + newest mtime. */
    const listWorkspaces = async () => {
        const out = [];
        let bucketDirs;
        try {
            bucketDirs = readdirSync(sessionsRoot, { withFileTypes: true });
        }
        catch {
            return out;
        }
        for (const b of bucketDirs) {
            if (!b.isDirectory())
                continue;
            let sids;
            try {
                sids = readdirSync(join(sessionsRoot, b.name), { withFileTypes: true })
                    .filter((e) => e.isDirectory())
                    .map((e) => e.name);
            }
            catch {
                continue;
            }
            const stats = await Promise.all(sids.map(async (sid) => {
                try {
                    const st = await stat(join(sessionsRoot, b.name, sid, SESSION_FILE));
                    return { sid, size: st.size, mtimeMs: st.mtimeMs };
                }
                catch {
                    return null; // directories without a session file don't count
                }
            }));
            const present = stats.filter((f) => f !== null);
            /* Count = timeline node criterion (top-level session-* only;
             * subagent child sessions are excluded), aligned with /list sessions.length */
            const count = present.filter((f) => f.sid.startsWith('session-')).length;
            if (count === 0)
                continue;
            const newest = present.reduce((max, f) => Math.max(max, f.mtimeMs), 0);
            out.push({ bucket: b.name, cwd: await bucketCwd(b.name, present), sessions: count, newest });
        }
        out.sort((a, b2) => b2.newest - a.newest);
        return out;
    };
    /* ---- Panel API ---- */
    const json = (res, code, payload) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(payload));
    };
    /** Error payload: `code`/`params` drive the client's localized copy; `error` keeps the zh text. */
    const failPayload = (f) => ({
        ok: false,
        error: f.text,
        code: f.code,
        ...(f.params !== undefined ? { params: f.params } : {}),
    });
    const readBody = (req) => new Promise((resolve) => {
        let body = '';
        req.on('data', (chunk) => { body += String(chunk); });
        req.on('end', () => resolve(body));
        req.on('error', () => resolve(body));
    });
    /** Resolve workspace: workspace param (bucket name) first, else locate via session param; __global__ = all buckets. */
    const locate = (workspace, sessionId) => {
        if (workspace !== null && workspace.trim() !== '') {
            const bucket = workspace.trim();
            if (bucket === GLOBAL_BUCKET)
                return { bucket, fail: null };
            if (!existsSync(join(sessionsRoot, bucket))) {
                return { bucket: null, fail: { code: 'workspaceMissing', text: '工作区 ' + bucket + ' 不存在（桶不可读）', params: { bucket } } };
            }
            return { bucket, fail: null };
        }
        if (sessionId === null || sessionId.trim() === '') {
            return { bucket: null, fail: { code: 'locateMissing', text: '缺 session/workspace 参数' } };
        }
        const bucket = sessionBucket(sessionId.trim());
        if (bucket === null)
            return { bucket: null, fail: { code: 'sessionNotInBucket', text: '会话 ' + sessionId + ' 不在任何工作区存储桶', params: { session: sessionId } } };
        return { bucket, fail: null };
    };
    /** Build progress fields, only while builds are still running (settled
     *  responses stay exactly what earlier versions returned). */
    const progress = (view) => view.pending > 0 ? { partial: true, build: { done: view.done, total: view.building } } : {};
    /** Global aggregation: all buckets' nodes + per-bucket lineage edges + manual links (lineage never crosses buckets). */
    const listGlobalNodes = async (wait) => {
        const out = { nodes: [], edges: [], links: [], unreadable: 0, pending: 0, building: 0, done: 0 };
        let bucketNames = [];
        try {
            bucketNames = readdirSync(sessionsRoot, { withFileTypes: true })
                .filter((e) => e.isDirectory())
                .map((e) => e.name);
        }
        catch { /* unreadable root returns empty */ }
        const views = await Promise.all(bucketNames.map(async (bucket) => ({ bucket, view: await tableView(bucket, wait) })));
        for (const { bucket, view } of views) {
            await resolveForkParents(bucket, view.nodes);
            out.nodes.push(...view.nodes);
            out.unreadable += view.unreadable;
            out.pending += view.pending;
            out.building += view.building;
            out.done += view.done;
            out.edges.push(...nativeEdges(view.nodes));
            const doc = loadDoc(root, bucket);
            if (doc.fail === null)
                out.links.push(...doc.doc.links);
        }
        out.nodes.sort((a, b2) => a.lastAt - b2.lastAt);
        return out;
    };
    const turnsCache = new Map();
    const TURNS_CACHE_CAP = 64;
    ctx.effect(() => ctx.webServer.register({
        kind: 'prefix',
        path: '/session-timeline/api',
        handler: async (req, res) => {
            const pathname = (req.url ?? '').split('?')[0];
            const query = new URL('http://x/' + (req.url ?? '')).searchParams;
            if (pathname === '/session-timeline/api/workspaces' && req.method === 'GET') {
                json(res, 200, { ok: true, workspaces: await listWorkspaces() });
                return;
            }
            if (pathname === '/session-timeline/api/list' && req.method === 'GET') {
                const located = locate(query.get('workspace'), query.get('session'));
                if (located.fail !== null) {
                    json(res, 400, failPayload(located.fail));
                    return;
                }
                if (located.bucket === GLOBAL_BUCKET) {
                    const g = await listGlobalNodes(threads === 0);
                    json(res, 200, {
                        ok: true,
                        bucket: GLOBAL_BUCKET,
                        unreadable: g.unreadable,
                        sessions: stampArchived(g.nodes),
                        edges: g.edges,
                        manualLinks: g.links,
                        ...progress(g),
                    });
                    return;
                }
                const view = await tableView(located.bucket, threads === 0);
                await resolveForkParents(located.bucket, view.nodes);
                const doc = loadDoc(root, located.bucket);
                if (doc.fail !== null) {
                    json(res, 500, failPayload(doc.fail));
                    return;
                }
                json(res, 200, {
                    ok: true,
                    bucket: located.bucket,
                    unreadable: view.unreadable,
                    sessions: stampArchived(view.nodes),
                    edges: nativeEdges(view.nodes),
                    manualLinks: doc.doc.links,
                    ...progress(view),
                });
                return;
            }
            if (pathname === '/session-timeline/api/link' && req.method === 'POST') {
                let body = {};
                try {
                    body = JSON.parse(await readBody(req));
                }
                catch { /* empty body = missing params */ }
                const located = locate(typeof body.workspace === 'string' ? body.workspace : null, typeof body.session === 'string' ? body.session : null);
                if (located.fail !== null) {
                    json(res, 400, failPayload(located.fail));
                    return;
                }
                const from = typeof body.from === 'string' ? body.from.trim() : '';
                const to = typeof body.to === 'string' ? body.to.trim() : '';
                if (from === '' || to === '') {
                    json(res, 400, failPayload({ code: 'emptyFromTo', text: 'from/to 不能为空' }));
                    return;
                }
                if (from === to) {
                    json(res, 400, failPayload({ code: 'linkSelf', text: '不能与自己衔接' }));
                    return;
                }
                /* Global view (__global__): resolve each endpoint's own bucket — lineage never
                 * crosses workspaces, so a cross-workspace pair fails with a stable code. */
                let bucket = located.bucket;
                if (bucket === GLOBAL_BUCKET) {
                    const fromBucket = sessionBucket(from);
                    const toBucket = sessionBucket(to);
                    if (fromBucket === null || toBucket === null) {
                        const missing = fromBucket === null ? from : to;
                        json(res, 400, failPayload({ code: 'sessionNotInBucket', text: '会话 ' + missing + ' 不在任何工作区存储桶', params: { session: missing } }));
                        return;
                    }
                    if (fromBucket !== toBucket) {
                        json(res, 400, failPayload({ code: 'crossWorkspace', text: '两会话分属不同工作区，手工衔接不能跨工作区' }));
                        return;
                    }
                    bucket = fromBucket;
                }
                const { nodes } = await tableView(bucket, true);
                await resolveForkParents(bucket, nodes);
                const byId = new Map(nodes.map((n) => [n.id, n]));
                const a = byId.get(from);
                const b = byId.get(to);
                if (a === undefined || b === undefined) {
                    json(res, 400, failPayload({ code: 'notTopLevel', text: 'from/to 必须是该工作区的顶层会话' }));
                    return;
                }
                for (const e of nativeEdges(nodes)) {
                    if ((e.from === from && e.to === to) || (e.from === to && e.to === from)) {
                        json(res, 409, e.kind === 'branch'
                            ? failPayload({ code: 'nativeBranch', text: '两会话已存在原生血缘（分支），无需手工连线' })
                            : failPayload({ code: 'nativeHandoff', text: '两会话已存在原生血缘（handoff），无需手工连线' }));
                        return;
                    }
                }
                // Normalize direction by creation time: from = earlier side (predecessor),
                // to = later side (successor); creation time = first real user message
                // time, falling back to header.createdAt — same direction as native
                // parent→child (older points to newer).
                const [nf, nt] = a.createdAt <= b.createdAt ? [from, to] : [to, from];
                const doc = loadDoc(root, bucket);
                if (doc.fail !== null) {
                    json(res, 500, failPayload(doc.fail));
                    return;
                }
                const dup = doc.doc.links.some((l) => (l.from === nf && l.to === nt) || (l.from === nt && l.to === nf));
                if (dup) {
                    json(res, 200, { ok: true, duplicate: true });
                    return;
                }
                doc.doc.links.push({ from: nf, to: nt, created_at: new Date().toISOString() });
                const err = saveDoc(root, bucket, doc.doc);
                if (err !== null) {
                    json(res, 500, failPayload(err));
                    return;
                }
                json(res, 200, { ok: true, from: nf, to: nt });
                return;
            }
            if (pathname === '/session-timeline/api/unlink' && req.method === 'POST') {
                let body = {};
                try {
                    body = JSON.parse(await readBody(req));
                }
                catch { /* empty body = missing params */ }
                const located = locate(typeof body.workspace === 'string' ? body.workspace : null, typeof body.session === 'string' ? body.session : null);
                if (located.fail !== null) {
                    json(res, 400, failPayload(located.fail));
                    return;
                }
                const from = typeof body.from === 'string' ? body.from.trim() : '';
                const to = typeof body.to === 'string' ? body.to.trim() : '';
                if (from === '' || to === '') {
                    json(res, 400, failPayload({ code: 'emptyFromTo', text: 'from/to 不能为空' }));
                    return;
                }
                /* Global view (__global__): resolve the link's own bucket from either endpoint. */
                let bucket = located.bucket;
                if (bucket === GLOBAL_BUCKET) {
                    const own = sessionBucket(from) ?? sessionBucket(to);
                    if (own === null) {
                        json(res, 400, failPayload({ code: 'sessionNotInBucket', text: '会话 ' + from + ' 不在任何工作区存储桶', params: { session: from } }));
                        return;
                    }
                    bucket = own;
                }
                const doc = loadDoc(root, bucket);
                if (doc.fail !== null) {
                    json(res, 500, failPayload(doc.fail));
                    return;
                }
                const before = doc.doc.links.length;
                doc.doc.links = doc.doc.links.filter((l) => !((l.from === from && l.to === to) || (l.from === to && l.to === from)));
                const removed = before - doc.doc.links.length;
                if (removed > 0) {
                    const err = saveDoc(root, bucket, doc.doc);
                    if (err !== null) {
                        json(res, 500, failPayload(err));
                        return;
                    }
                }
                json(res, 200, { ok: true, removed });
                return;
            }
            if (pathname === '/session-timeline/api/turns' && req.method === 'GET') {
                const sid = (query.get('session') ?? '').trim();
                const ws = query.get('workspace');
                let dir = null;
                if (ws !== null && ws.trim() !== '' && ws !== GLOBAL_BUCKET) {
                    dir = join(sessionsRoot, ws.trim(), sid);
                }
                else {
                    const bucket = sessionBucket(sid);
                    if (bucket !== null)
                        dir = join(sessionsRoot, bucket, sid);
                }
                if (dir === null || !existsSync(join(dir, SESSION_FILE))) {
                    json(res, 404, failPayload({ code: 'sessionMissing', text: '会话 ' + sid + ' 不存在', params: { session: sid } }));
                    return;
                }
                try {
                    /* mtime+size cache: the detail view re-requests turns on every node
                     * select and every bar click; each miss used to decompress the whole
                     * log. Same staleness contract as the session index (size + mtime;
                     * content changes at equal size+mtime are invisible by design). */
                    const file = join(dir, SESSION_FILE);
                    const st = statSync(file);
                    const cached = turnsCache.get(dir);
                    let scan;
                    if (cached !== undefined && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
                        scan = cached.scan;
                    }
                    else {
                        const text = decodeLog(await readFile(file));
                        scan = text === null ? null : extractTurns(text);
                        if (turnsCache.size >= TURNS_CACHE_CAP) {
                            const oldest = turnsCache.keys().next();
                            if (!oldest.done)
                                turnsCache.delete(oldest.value);
                        }
                        turnsCache.set(dir, { mtimeMs: st.mtimeMs, size: st.size, scan });
                    }
                    if (scan === null) {
                        json(res, 500, failPayload({ code: 'decodeFailed', text: '会话日志解码失败' }));
                        return;
                    }
                    const turns = scan.turns;
                    if (turns.length === 0) {
                        json(res, 200, { ok: true, turns: 0, handoffTurns: [] });
                        return;
                    }
                    /* Single turn on demand (clicking any turn bar): GET /turns&turn=N → that turn's dialog. */
                    const wantTurn = Number(query.get('turn') ?? '');
                    if (Number.isInteger(wantTurn) && wantTurn >= 1 && wantTurn <= turns.length) {
                        json(res, 200, { ok: true, turns: turns.length, turn: wantTurn, data: turns[wantTurn - 1] });
                        return;
                    }
                    json(res, 200, {
                        ok: true,
                        turns: turns.length,
                        first: turns[0],
                        last: turns[turns.length - 1],
                        /* Full dialog of handoff-skill turns (user/assistant, same 4000-char clip). */
                        handoffTurns: scan.handoffTurns
                            .filter((turn) => turn >= 1 && turn <= turns.length)
                            .map((turn) => ({ turn, ...turns[turn - 1] })),
                    });
                }
                catch (e) {
                    json(res, 500, failPayload({ code: 'parseFailed', text: '解析失败：' + String(e).slice(0, 120), params: { message: String(e).slice(0, 120) } }));
                }
                return;
            }
            json(res, 404, failPayload({ code: 'unknownEndpoint', text: '未知端点 ' + req.method + ' ' + pathname, params: { method: req.method ?? '', path: pathname } }));
        },
    }), 'session-timeline: api');
    /* Index files are only a cache, but rebuilding them costs a full pass over
     * the logs: write what is due when the plugin unloads (reload, shutdown). */
    ctx.effect(() => () => {
        for (const [bucket, st] of buckets) {
            if (st.timer !== null)
                clearTimeout(st.timer);
            flushIndex(st, bucket, true);
        }
        pool?.dispose();
    }, 'session-timeline: index store');
    ctx.logger?.info?.('[' + name + '] 会话时间线就绪：手工衔接存储 ' + root + '；索引构建线程 ' + threads);
}
//# sourceMappingURL=index.js.map