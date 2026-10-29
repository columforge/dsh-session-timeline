/**
 * 会话日志纯解析（无插件依赖，供 host 与单测共用）。
 * 输入 = session.v4.jsonl.zstd 解码后的 JSONL 文本；容忍撕裂/损坏行（跳过）。
 */

const TITLE_MARK = '"type":"session/title"'
const USER_MSG_MARK = '"type":"user/message"'
const HANDOFF_MARK = '"kind":"skill-invocation","name":"handoff"'

/** 一次 handoff skill 调用明细（按日志顺序）。 */
export interface HandoffHit {
  /** 事件 seq（0 = 日志行缺失/损坏时兜底） */
  seq: number
  /** 事件 time（epoch ms；0 = 缺失） */
  at: number
  /** 所属轮次（真实用户消息分隔，1 起；开局即调用记第 1 轮） */
  turn: number
}

export interface ParsedLog {
  /** header.createdAt（会话对象落盘时刻；仅作回落与展示参考） */
  createdAt: number
  /** 首条真实用户消息的 time（会话创建时间口径；0 = 尚无用户消息） */
  firstUserAt: number
  /** 日志末事件 time（最后活动） */
  lastAt: number
  parent: string | null
  seeded: boolean
  title: string | null
  cwd: string | null
  /** 首条真实用户消息内容含 handoff 文档引用（handoff 新会话判据） */
  handoffSeed: boolean
  /** 首窗口内调用过 handoff skill（待接前驱紫框判据） */
  handoffFirst: boolean
  /** 消息中出现任意 handoff skill 调用（待接后继金框判据，不限末窗口） */
  handoffUsed: boolean
  /** handoff skill 调用明细（每次调用的 seq/time/轮次，按日志顺序） */
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
    } catch { /* 撕裂/损坏行跳过 */ }
    idx = text.indexOf(TITLE_MARK, idx + TITLE_MARK.length)
  }

  /* 轮次窗口：真实用户消息（source.kind=user）分隔；handoff skill 调用 =
   * user/message + source{kind:skill-invocation,name:handoff}。
   * handoff 新会话判据：首条真实用户消息文本含 handoff 文档引用（含
   * handoff 字样即命中，如“读 handoff 文档”“handoff-xxx.md”）。 */
  const userPos: number[] = []
  let firstUserText: string | null = null
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
        if (firstUserText === null && Array.isArray(ev.data.content)) {
          const joined = ev.data.content
            .filter((c) => c?.type === 'text' && typeof c.text === 'string')
            .map((c) => String(c.text))
            .join(' ')
          if (joined.trim() !== '') firstUserText = joined
        }
      }
    } catch { /* 跳过 */ }
    u = text.indexOf(USER_MSG_MARK, u + USER_MSG_MARK.length)
  }
  const handoffSeed = firstUserText !== null && firstUserText.toLowerCase().includes('handoff')

  /* 最后活动时间：从日志末尾向前找第一条可解析且带 time 的事件（容忍撕裂尾行） */
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
      } catch { /* 撕裂/截断行继续向前 */ }
    }
  }

  /* handoff skill 调用扫描：逐次解析行取 seq/time；轮次 = 该行之前的真实
   * 用户消息条数（1 起）。handoffUsed = 出现任意调用（金框判据，不再限于
   * 末窗口）；handoffFirst = 首窗口内出现（第二条真实用户消息之前，紫框
   * 判据，口径不变）。非 handoff 的 skill-invocation / 损坏行不计数。 */
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
    } catch { /* 撕裂/损坏行跳过 */ }
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
    handoffSeed,
    handoffFirst,
    handoffUsed: handoffHits.length > 0,
    handoffHits,
  }
}
