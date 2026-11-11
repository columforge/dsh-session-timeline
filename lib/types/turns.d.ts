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
export declare const TURN_CLIP = 4000;
/** One conversation turn as served by /turns (dialog clip + marker flags). */
export interface TurnDialog {
    user: string;
    assistant: string;
    /** First real user message time of the turn (epoch ms; 0 when absent). */
    at: number;
    /**
     * The turn's first real user message event seq — the /turns-side jump anchor.
     * The turnOutline projection only exists for retained sessions, so this seq
     * is what lets "locate" work for every session: loadThrough pages history
     * back until the window covers it (pages align to turn boundaries, so the
     * turn's turn/start comes with it). -1 when the log line carried no seq.
     */
    seq: number;
    userClipped?: boolean;
    assistantClipped?: boolean;
    assistantReasoning?: boolean;
}
/** Turns plus the 1-based, ascending handoff-call turn numbers. */
export interface TurnScan {
    turns: TurnDialog[];
    handoffTurns: number[];
}
/** Extract every turn and the handoff-call turn numbers from a decoded log. */
export declare function extractTurns(text: string): TurnScan;
