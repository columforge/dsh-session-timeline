/**
 * Pure session-log parser (no plugin deps; shared by host and unit tests).
 * Input: decoded JSONL text of session.v4.jsonl.zstd; torn/corrupt lines are skipped.
 */

const TITLE_MARK = '"type":"session/title"'
const USER_MSG_MARK = '"type":"user/message"'
const HANDOFF_MARK = '"kind":"skill-invocation","name":"handoff"'

/** One handoff skill invocation (in log order). */
export interface HandoffHit {
  /** Event seq (0 = log line missing/corrupt). */
  seq: number
  /** Event time (epoch ms; 0 = missing). */
  at: number
  /** Turn number (real user messages delimit turns, 1-based; calls before the first message count as turn 1). */
  turn: number
}

export interface ParsedLog {
  /** header.createdAt (session object written time; fallback/display only). */
  createdAt: number
  /** Time of the first real user message (creation-time criterion; 0 = none yet). */
  firstUserAt: number
  /** Time of the last log event (last activity). */
  lastAt: number
  parent: string | null
  seeded: boolean
  title: string | null
  cwd: string | null
  /** Handoff skill ran within the first window (purple "no predecessor" criterion). */
  handoffFirst: boolean
  /** Any handoff skill invocation appeared (gold "no successor" criterion; not last-window only). */
  handoffUsed: boolean
  /** Handoff skill invocations (seq/time/turn each, in log order). */
  handoffHits: HandoffHit[]
}

export function parseLog(text: string): ParsedLog | null {
  const nl = text.indexOf('\n')
  if (nl <= 0) return null
  let header: unknown
  try { header = JSON.parse(text.slice(0, nl)) } catch { return null }
  const hd = header as { type?: unknown; id?: unknown; createdAt?: unknown; parentSession?: unknown; isSeeded?: unknown; cwd?: unknown }
  if (hd?.type !== 'session' || typeof hd.id !== 'string') return null

  let title: string | null = null
  let idx = text.indexOf(TITLE_MARK)
  while (idx >= 0) {
    const lineStart = text.lastIndexOf('\n', idx - 1) + 1
    let lineEnd = text.indexOf('\n', idx)
    if (lineEnd < 0) lineEnd = text.length
    try {
      const ev = JSON.parse(text.slice(lineStart, lineEnd)) as { data?: { title?: unknown } }
      if (typeof ev?.data?.title === 'string' && ev.data.title.trim() !== '') title = ev.data.title
    } catch { /* skip torn/corrupt line */ }
    idx = text.indexOf(TITLE_MARK, idx + TITLE_MARK.length)
  }

  /* Scan real user messages (source.kind=user); the first time is the
   * creation-time criterion. Never flag by "handoff" text in the first
   * message — sessions merely discussing handoff would be mislabeled;
   * the tag only trusts isSeeded ∪ handoffUsed. */
  const userPos: number[] = []
  let firstUserAt = 0
  let u = text.indexOf(USER_MSG_MARK)
  while (u >= 0) {
    const lineStart = text.lastIndexOf('\n', u - 1) + 1
    let lineEnd = text.indexOf('\n', u)
    if (lineEnd < 0) lineEnd = text.length
    try {
      const raw = text.slice(lineStart, lineEnd)
      const ev = JSON.parse(raw) as { type?: unknown; time?: unknown; data?: { source?: { kind?: unknown }; content?: { type?: unknown; text?: unknown }[] } }
      if (ev?.type === 'user/message' && ev?.data?.source?.kind === 'user') {
        userPos.push(u)
        if (firstUserAt === 0 && typeof ev.time === 'number' && ev.time > 0) firstUserAt = ev.time
      }
    } catch { /* skip */ }
    u = text.indexOf(USER_MSG_MARK, u + USER_MSG_MARK.length)
  }

  /* Last activity: scan backward from the log tail for the first parsable
   * event carrying a time (tolerates torn trailing lines). */
  let lastAt = typeof hd.createdAt === 'number' ? hd.createdAt : 0
  {
    let pos = text.length
    for (let guard = 0; guard < 64 && pos > 0; guard += 1) {
      const lineEnd = pos
      const lineStart = text.lastIndexOf('\n', pos - 2) + 1
      pos = lineStart > 0 ? lineStart - 1 : 0
      const raw = text.slice(lineStart, lineEnd).trim()
      if (raw === '' || !raw.includes('"time"')) continue
      try {
        const ev = JSON.parse(raw) as { time?: unknown }
        if (typeof ev.time === 'number' && ev.time > 0) { lastAt = ev.time; break }
      } catch { /* torn/truncated line: keep scanning */ }
    }
  }

  /* Scan handoff skill invocations for seq/time; turn = number of prior real
   * user messages (1-based). handoffUsed = any invocation (gold criterion, no
   * longer last-window only); handoffFirst = within the first window (before
   * the second real user message; purple criterion). Non-handoff
   * skill-invocations and corrupt lines don't count. */
  interface Scan { pos: number; hit: HandoffHit }
  const scans: Scan[] = []
  let hh = text.indexOf(HANDOFF_MARK)
  while (hh >= 0) {
    const lineStart = text.lastIndexOf('\n', hh - 1) + 1
    let lineEnd = text.indexOf('\n', hh)
    if (lineEnd < 0) lineEnd = text.length
    try {
      const ev = JSON.parse(text.slice(lineStart, lineEnd)) as {
        seq?: unknown; time?: unknown; type?: unknown
        data?: { source?: { kind?: unknown; name?: unknown } }
      }
      if (ev?.type === 'user/message'
        && ev?.data?.source?.kind === 'skill-invocation'
        && ev?.data?.source?.name === 'handoff') {
        let turn = 0
        for (const p of userPos) { if (p < lineStart) turn += 1; else break }
        scans.push({
          pos: lineStart,
          hit: {
            seq: typeof ev.seq === 'number' ? ev.seq : 0,
            at: typeof ev.time === 'number' ? ev.time : 0,
            turn: Math.max(turn, 1),
          },
        })
      }
    } catch { /* skip torn/corrupt line */ }
    hh = text.indexOf(HANDOFF_MARK, hh + HANDOFF_MARK.length)
  }
  const firstEnd = userPos.length >= 2 ? userPos[1] : Number.MAX_SAFE_INTEGER
  const handoffFirst = scans.some((s) => s.pos < firstEnd)
  const handoffHits = scans.map((s) => s.hit)

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
  }
}
