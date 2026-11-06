/**
 * Pure session-log parser (no plugin deps; shared by host and unit tests).
 * Input: decoded JSONL text of session.v4.jsonl.zstd; torn/corrupt lines are skipped.
 *
 * Split into one scanner per fact (title, fork marker, user messages, last
 * activity, handoff calls) so each rule stays under the ub-mode CRAP budget:
 * the composition lives in parseLog, the per-line decoding in the helpers.
 */
const TITLE_MARK = '"type":"session/title"';
const USER_MSG_MARK = '"type":"user/message"';
const HANDOFF_MARK = '"kind":"skill-invocation","name":"handoff"';
const FORK_SEED_MARK = '"type":"session/end-seed"';
/** Line bounds for the event containing offset `at` (a line starts after the previous newline). */
function lineBounds(text, at) {
    const start = text.lastIndexOf('\n', at - 1) + 1;
    const next = text.indexOf('\n', at);
    return { start, end: next < 0 ? text.length : next };
}
function asNumber(value) {
    return typeof value === 'number' ? value : 0;
}
function asNonEmptyString(value) {
    return typeof value === 'string' && value !== '' ? value : null;
}
function sourceOf(ev) {
    const data = ev.data;
    if (data === undefined)
        return null;
    return data.source ?? null;
}
/** Fork children count only messages after their own marker (own conversation). */
function inOwnConversation(start, marker) {
    return marker === null || start > marker.pos;
}
/** First line = session header; validates type/id, parses the six fields the timeline reads. */
function parseHeader(text) {
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
    return {
        createdAt: asNumber(hd.createdAt),
        parent: asNonEmptyString(hd.parentSession),
        seeded: hd.isSeeded === true,
        cwd: asNonEmptyString(hd.cwd),
    };
}
/** Last non-empty session/title wins (a later rename overwrites earlier titles). */
function lastTitle(text) {
    let title = null;
    let at = text.indexOf(TITLE_MARK);
    while (at >= 0) {
        const { start, end } = lineBounds(text, at);
        try {
            const ev = JSON.parse(text.slice(start, end));
            const value = ev?.data?.title;
            if (typeof value === 'string' && value.trim() !== '')
                title = value;
        }
        catch { /* skip torn/corrupt line */ }
        at = text.indexOf(TITLE_MARK, at + TITLE_MARK.length);
    }
    return title;
}
/* Scan real user messages (source.kind=user); the first time is the
 * creation-time criterion. Never flag by "handoff" text in the first
 * message — sessions merely discussing handoff would be mislabeled;
 * the tag only trusts isSeeded ∪ handoffUsed. For fork children only
 * messages after the own fork marker count (own conversation). */
function isUserMessageLine(raw, marker, start) {
    try {
        const ev = JSON.parse(raw);
        const source = sourceOf(ev);
        if (ev.type === 'user/message' && source !== null && source.kind === 'user' && inOwnConversation(start, marker)) {
            return { pos: start, time: asNumber(ev.time) };
        }
    }
    catch { /* skip torn/corrupt line */ }
    return null;
}
function scanUserMessages(text, marker) {
    const positions = [];
    let firstUserAt = 0;
    let at = text.indexOf(USER_MSG_MARK);
    while (at >= 0) {
        const { start, end } = lineBounds(text, at);
        const hit = isUserMessageLine(text.slice(start, end), marker, start);
        if (hit !== null) {
            positions.push(hit.pos);
            if (firstUserAt === 0 && hit.time > 0)
                firstUserAt = hit.time;
        }
        at = text.indexOf(USER_MSG_MARK, at + USER_MSG_MARK.length);
    }
    return { positions, firstUserAt };
}
/** Fork marker: last `session/end-seed` line carrying `data.inherited === true` (own marker wins over copied ancestors). */
function findForkMarker(text) {
    let marker = null;
    let at = text.indexOf(FORK_SEED_MARK);
    while (at >= 0) {
        const { start, end } = lineBounds(text, at);
        try {
            const ev = JSON.parse(text.slice(start, end));
            if (ev?.data?.inherited === true && typeof ev.seq === 'number')
                marker = { seq: ev.seq, pos: start };
        }
        catch { /* skip torn/corrupt line */ }
        at = text.indexOf(FORK_SEED_MARK, at + FORK_SEED_MARK.length);
    }
    return marker;
}
/** Event time for one raw line (0 = unusable): tolerates torn/truncated trailing lines. */
function eventTime(raw) {
    if (!raw.includes('"time"'))
        return 0;
    try {
        const ev = JSON.parse(raw);
        return typeof ev.time === 'number' && ev.time > 0 ? ev.time : 0;
    }
    catch {
        return 0;
    }
}
/* Last activity: scan backward from the log tail for the first parsable
 * event carrying a time (tolerates torn trailing lines). */
function lastActivity(text, fallback) {
    let pos = text.length;
    for (let guard = 0; guard < 64 && pos > 0; guard += 1) {
        const lineEnd = pos;
        const lineStart = text.lastIndexOf('\n', pos - 2) + 1;
        pos = lineStart > 0 ? lineStart - 1 : 0;
        const time = eventTime(text.slice(lineStart, lineEnd).trim());
        if (time > 0)
            return time;
    }
    return fallback;
}
/** Handoff skill invocation line (seq/time each; turn is assigned by the caller). */
function isHandoffSource(source) {
    return source !== null && source.kind === 'skill-invocation' && source.name === 'handoff';
}
function isHandoffLine(raw, marker, start) {
    try {
        const ev = JSON.parse(raw);
        if (ev.type === 'user/message' && isHandoffSource(sourceOf(ev)) && inOwnConversation(start, marker)) {
            return { seq: asNumber(ev.seq), at: asNumber(ev.time) };
        }
    }
    catch { /* skip torn/corrupt line */ }
    return null;
}
/** Turn number for a line offset: number of real user messages before it (1-based; calls before the first message count as turn 1). */
function turnAt(pos, userPositions) {
    let turn = 0;
    for (const p of userPositions) {
        if (p < pos)
            turn += 1;
        else
            break;
    }
    return turn;
}
/* Scan handoff skill invocations for seq/time; turn = number of prior real
 * user messages (1-based). handoffUsed = any invocation (gold criterion, no
 * longer last-window only); handoffFirst = within the first window (before
 * the second real user message; purple criterion). Non-handoff
 * skill-invocations and corrupt lines don't count. */
function scanHandoffs(text, userPositions, marker) {
    const hits = [];
    let firstPos = null;
    let at = text.indexOf(HANDOFF_MARK);
    while (at >= 0) {
        const { start, end } = lineBounds(text, at);
        const hit = isHandoffLine(text.slice(start, end), marker, start);
        if (hit !== null) {
            hits.push({ seq: hit.seq, at: hit.at, turn: Math.max(turnAt(start, userPositions), 1) });
            if (firstPos === null)
                firstPos = start;
        }
        at = text.indexOf(HANDOFF_MARK, at + HANDOFF_MARK.length);
    }
    return { hits, firstPos };
}
/** Offset where the first conversation window ends: the second real user message (no second message = whole log). */
function firstWindowEnd(userPositions) {
    return userPositions.length >= 2 ? userPositions[1] : Number.MAX_SAFE_INTEGER;
}
export function parseLog(text) {
    const header = parseHeader(text);
    if (header === null)
        return null;
    const marker = findForkMarker(text);
    const users = scanUserMessages(text, marker);
    const handoff = scanHandoffs(text, users.positions, marker);
    return {
        createdAt: header.createdAt,
        firstUserAt: users.firstUserAt,
        lastAt: lastActivity(text, header.createdAt),
        parent: header.parent,
        seeded: header.seeded,
        title: lastTitle(text),
        cwd: header.cwd,
        handoffFirst: handoff.firstPos !== null && handoff.firstPos < firstWindowEnd(users.positions),
        handoffUsed: handoff.hits.length > 0,
        handoffHits: handoff.hits,
        forkMarkerSeq: marker?.seq ?? null,
    };
}
/** Fast path: v4 event lines open with {"type":"…","seq":N,"time":N. */
const SIG_FAST = /^\{"type":"([^"]+)","seq":(\d+),"time":(\d+)/;
/** JSON fallback for lines the fast regex cannot read. */
function signatureFromJson(raw) {
    try {
        const ev = JSON.parse(raw);
        if (typeof ev.type === 'string' && typeof ev.seq === 'number' && typeof ev.time === 'number') {
            return [ev.type, ev.seq, ev.time];
        }
    }
    catch { /* skip torn/corrupt line */ }
    return null;
}
/** One line → (type, seq, time); null when the line has no complete tuple (header, torn or corrupt line). */
function signatureOfLine(raw) {
    const m = SIG_FAST.exec(raw);
    if (m !== null)
        return [m[1], Number(m[2]), Number(m[3])];
    if (!raw.includes('"seq"'))
        return null;
    return signatureFromJson(raw);
}
/** Extract the per-event (type, seq, time) signature of a decoded log.
 * Header line (no seq) and torn/corrupt lines are skipped; lines the fast
 * regex cannot read fall back to JSON.parse for robustness. */
export function signatureLog(text) {
    const sig = [];
    let pos = 0;
    for (;;) {
        const nl = text.indexOf('\n', pos);
        const raw = text.slice(pos, nl < 0 ? text.length : nl);
        if (raw.length > 2) {
            const tuple = signatureOfLine(raw);
            if (tuple !== null)
                sig.push(tuple);
        }
        if (nl < 0)
            break;
        pos = nl + 1;
    }
    return sig;
}
//# sourceMappingURL=parse.js.map