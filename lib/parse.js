/**
 * Pure session-log parser (no plugin deps; shared by host and unit tests).
 * Input: decoded JSONL text of session.v4.jsonl.zstd; torn/corrupt lines are skipped.
 */
const TITLE_MARK = '"type":"session/title"';
const USER_MSG_MARK = '"type":"user/message"';
const HANDOFF_MARK = '"kind":"skill-invocation","name":"handoff"';
const FORK_SEED_MARK = '"type":"session/end-seed"';
export function parseLog(text) {
    const nl = text.indexOf('\n');
    if (nl <= 0)
        return null;
    let header;
    try {
        header = JSON.parse(text.slice(0, nl));
    }
    catch {
        return null;
    }
    const hd = header;
    if (hd?.type !== 'session' || typeof hd.id !== 'string')
        return null;
    let title = null;
    let idx = text.indexOf(TITLE_MARK);
    while (idx >= 0) {
        const lineStart = text.lastIndexOf('\n', idx - 1) + 1;
        let lineEnd = text.indexOf('\n', idx);
        if (lineEnd < 0)
            lineEnd = text.length;
        try {
            const ev = JSON.parse(text.slice(lineStart, lineEnd));
            if (typeof ev?.data?.title === 'string' && ev.data.title.trim() !== '')
                title = ev.data.title;
        }
        catch { /* skip torn/corrupt line */ }
        idx = text.indexOf(TITLE_MARK, idx + TITLE_MARK.length);
    }
    /* Scan real user messages (source.kind=user); the first time is the
     * creation-time criterion. Never flag by "handoff" text in the first
     * message — sessions merely discussing handoff would be mislabeled;
     * the tag only trusts isSeeded ∪ handoffUsed. For fork children only
     * messages after the own fork marker count (own conversation). */
    let forkMarker = null;
    {
        let f = text.indexOf(FORK_SEED_MARK);
        while (f >= 0) {
            const lineStart = text.lastIndexOf('\n', f - 1) + 1;
            let lineEnd = text.indexOf('\n', f);
            if (lineEnd < 0)
                lineEnd = text.length;
            try {
                const ev = JSON.parse(text.slice(lineStart, lineEnd));
                if (ev?.data?.inherited === true && typeof ev.seq === 'number') {
                    forkMarker = { seq: ev.seq, pos: lineStart };
                }
            }
            catch { /* skip torn/corrupt line */ }
            f = text.indexOf(FORK_SEED_MARK, f + FORK_SEED_MARK.length);
        }
    }
    const userPos = [];
    let firstUserAt = 0;
    let u = text.indexOf(USER_MSG_MARK);
    while (u >= 0) {
        const lineStart = text.lastIndexOf('\n', u - 1) + 1;
        let lineEnd = text.indexOf('\n', u);
        if (lineEnd < 0)
            lineEnd = text.length;
        try {
            const raw = text.slice(lineStart, lineEnd);
            const ev = JSON.parse(raw);
            if (ev?.type === 'user/message' && ev?.data?.source?.kind === 'user'
                && (forkMarker === null || lineStart > forkMarker.pos)) {
                userPos.push(lineStart);
                if (firstUserAt === 0 && typeof ev.time === 'number' && ev.time > 0)
                    firstUserAt = ev.time;
            }
        }
        catch { /* skip */ }
        u = text.indexOf(USER_MSG_MARK, u + USER_MSG_MARK.length);
    }
    /* Last activity: scan backward from the log tail for the first parsable
     * event carrying a time (tolerates torn trailing lines). */
    let lastAt = typeof hd.createdAt === 'number' ? hd.createdAt : 0;
    {
        let pos = text.length;
        for (let guard = 0; guard < 64 && pos > 0; guard += 1) {
            const lineEnd = pos;
            const lineStart = text.lastIndexOf('\n', pos - 2) + 1;
            pos = lineStart > 0 ? lineStart - 1 : 0;
            const raw = text.slice(lineStart, lineEnd).trim();
            if (raw === '' || !raw.includes('"time"'))
                continue;
            try {
                const ev = JSON.parse(raw);
                if (typeof ev.time === 'number' && ev.time > 0) {
                    lastAt = ev.time;
                    break;
                }
            }
            catch { /* torn/truncated line: keep scanning */ }
        }
    }
    const scans = [];
    let hh = text.indexOf(HANDOFF_MARK);
    while (hh >= 0) {
        const lineStart = text.lastIndexOf('\n', hh - 1) + 1;
        let lineEnd = text.indexOf('\n', hh);
        if (lineEnd < 0)
            lineEnd = text.length;
        try {
            const ev = JSON.parse(text.slice(lineStart, lineEnd));
            if (ev?.type === 'user/message'
                && ev?.data?.source?.kind === 'skill-invocation'
                && ev?.data?.source?.name === 'handoff'
                && (forkMarker === null || lineStart > forkMarker.pos)) {
                let turn = 0;
                for (const p of userPos) {
                    if (p < lineStart)
                        turn += 1;
                    else
                        break;
                }
                scans.push({
                    pos: lineStart,
                    hit: {
                        seq: typeof ev.seq === 'number' ? ev.seq : 0,
                        at: typeof ev.time === 'number' ? ev.time : 0,
                        turn: Math.max(turn, 1),
                    },
                });
            }
        }
        catch { /* skip torn/corrupt line */ }
        hh = text.indexOf(HANDOFF_MARK, hh + HANDOFF_MARK.length);
    }
    const firstEnd = userPos.length >= 2 ? userPos[1] : Number.MAX_SAFE_INTEGER;
    const handoffFirst = scans.some((s) => s.pos < firstEnd);
    const handoffHits = scans.map((s) => s.hit);
    return {
        createdAt: typeof hd.createdAt === 'number' ? hd.createdAt : 0,
        firstUserAt,
        lastAt,
        parent: typeof hd.parentSession === 'string' && hd.parentSession !== '' ? hd.parentSession : null,
        seeded: hd.isSeeded === true,
        title,
        cwd: typeof hd.cwd === 'string' ? hd.cwd : null,
        handoffFirst,
        handoffUsed: handoffHits.length > 0,
        handoffHits,
        forkMarkerSeq: forkMarker !== null ? forkMarker.seq : null,
    };
}
/** Fast path: v4 event lines open with {"type":"…","seq":N,"time":N. */
const SIG_FAST = /^\{"type":"([^"]+)","seq":(\d+),"time":(\d+)/;
/** Extract the per-event (type, seq, time) signature of a decoded log.
 * Header line (no seq) and torn/corrupt lines are skipped; lines the fast
 * regex cannot read fall back to JSON.parse for robustness. */
export function signatureLog(text) {
    const sig = [];
    let pos = 0;
    for (;;) {
        const nl = text.indexOf('\n', pos);
        const lineEnd = nl < 0 ? text.length : nl;
        const raw = text.slice(pos, lineEnd);
        pos = nl < 0 ? text.length : nl + 1;
        if (raw.length > 2) {
            const m = SIG_FAST.exec(raw);
            if (m !== null) {
                sig.push([m[1], Number(m[2]), Number(m[3])]);
            }
            else if (raw.includes('"seq"')) {
                try {
                    const ev = JSON.parse(raw);
                    if (typeof ev?.type === 'string' && typeof ev?.seq === 'number' && typeof ev?.time === 'number') {
                        sig.push([ev.type, ev.seq, ev.time]);
                    }
                }
                catch { /* skip torn/corrupt line */ }
            }
        }
        if (nl < 0)
            break;
    }
    return sig;
}
//# sourceMappingURL=parse.js.map