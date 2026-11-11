/**
 * Pure turn extraction from a decoded v4 session log (no plugin, fs or zstd
 * deps — the route hands in the decompressed text).
 *
 * Turn attribution rules (single source for /turns and the live projection):
 * a turn opens on a real user message (user/message with source.kind='user');
 * a handoff skill invocation (user/message with source.kind='skill-invocation'
 * and name='handoff') belongs to the turn already open and is skipped while
 * none is; assistant/message events fold into the open turn — the last formal
 * text reply wins, and reasoning blocks only stand in while no formal text
 * has arrived (the reasoning fallback never sets the clipped flag, and a
 * later formal reply resets the reasoning marker). Unparseable lines and
 * non-text content blocks are skipped. Dialogs are clipped at TURN_CLIP with
 * the marker flags travelling alongside so the client can localize the
 * truncation notice.
 */
/** 4000-char clip; truncation markers are rendered client-side by language. */
export const TURN_CLIP = 4000;
/** Joined text of the content blocks matching `kind`, in block order. */
function blockText(blocks, kind) {
    if (!Array.isArray(blocks))
        return '';
    return blocks
        .filter((c) => c?.type === kind && typeof c.text === 'string')
        .map((c) => String(c.text))
        .join('\n');
}
function clip(t) {
    return t.length > TURN_CLIP ? { text: t.slice(0, TURN_CLIP), clipped: true } : { text: t, clipped: false };
}
/** Fold one assistant/message event into the open turn. */
function applyAssistant(turn, data) {
    const msg = data;
    const blocks = Array.isArray(msg?.message?.content) ? msg.message.content : [];
    const text = blockText(blocks, 'text').trim();
    if (text !== '') {
        const clipped = clip(text);
        turn.assistant = clipped.text;
        turn.assistantClipped = clipped.clipped;
        // Formal text replaces the reasoning fallback: the flag must follow the
        // content, or a turn with a real reply stays labelled "reasoning".
        turn.assistantReasoning = false;
        return;
    }
    if (turn.assistant !== '')
        return;
    const reasoning = blockText(blocks, 'reasoning').trim();
    if (reasoning === '')
        return;
    turn.assistant = clip(reasoning).text;
    turn.assistantReasoning = true;
}
/** Open a turn from one user message; null when its content is not block-shaped. */
function buildTurn(e) {
    const content = e.data?.content;
    if (!Array.isArray(content))
        return null;
    const clipped = clip(blockText(content, 'text'));
    return {
        user: clipped.text,
        userClipped: clipped.clipped,
        assistant: '',
        at: typeof e.time === 'number' ? e.time : 0,
        seq: typeof e.seq === 'number' ? e.seq : -1,
    };
}
/** Record a handoff skill call against the open turn; no-op when nothing is open. */
function markHandoff(acc, source) {
    if (source?.kind !== 'skill-invocation' || source?.name !== 'handoff' || acc.turns.length === 0)
        return;
    acc.handoffSeen.add(acc.turns.length);
}
/** A user message opens a turn; a handoff skill call belongs to the already-open turn and is
 *  skipped while none is (same-turn calls deduplicate through the set). */
function applyUserEvent(acc, e) {
    const source = e.data?.source;
    if (source?.kind === 'user') {
        const turn = buildTurn(e);
        if (turn !== null)
            acc.turns.push(turn);
        return;
    }
    markHandoff(acc, source);
}
/** Apply one parsed event to the accumulator; unknown shapes no-op. */
function applyEvent(acc, ev) {
    const e = ev;
    if (e?.type === 'user/message') {
        applyUserEvent(acc, e);
        return;
    }
    if (e?.type === 'assistant/message' && acc.turns.length > 0) {
        applyAssistant(acc.turns[acc.turns.length - 1], e.data);
    }
}
/** Extract every turn and the handoff-call turn numbers from a decoded log. */
export function extractTurns(text) {
    const acc = { turns: [], handoffSeen: new Set() };
    let pos = 0;
    for (;;) {
        const nl = text.indexOf('\n', pos);
        const lineEnd = nl < 0 ? text.length : nl;
        const raw = text.slice(pos, lineEnd);
        pos = nl < 0 ? text.length : nl + 1;
        // Fast line filter before JSON.parse, same as the previous inline loop.
        if (raw.length > 2 && (raw.includes('"user/message"') || raw.includes('"assistant/message"'))) {
            try {
                applyEvent(acc, JSON.parse(raw));
            }
            catch { /* skip bad line */ }
        }
        if (nl < 0)
            break;
    }
    const handoffTurns = [...acc.handoffSeen].sort((a, b) => a - b);
    return { turns: acc.turns, handoffTurns };
}
//# sourceMappingURL=turns.js.map