/**
 * 会话文件与事件构造（record / logfile / loading 测试共用）。
 *
 * 事件形状与 DSH session.v4 日志一致；文件按 harness 的落盘布局写：
 * 头行（session header）单独一帧，之后每次 flush 一帧（带校验和的 zstd 帧）。
 */
import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { constants, zstdCompressSync } from 'node:zlib'

export const SESSION_FILE = 'session.v4.jsonl.zstd'

export const header = (sid, extra = {}) => ({ type: 'session', id: sid, createdAt: 1000, cwd: '/w', ...extra })
export const userMsg = (seq, time, text = 'hi') => ({ type: 'user/message', seq, time, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
export const handoffCall = (seq, time) => ({ type: 'user/message', seq, time, data: { source: { kind: 'skill-invocation', name: 'handoff' } } })
export const assistantMsg = (seq, time) => ({ type: 'assistant/message', seq, time, data: { message: { content: [{ type: 'text', text: 'ok' }] } } })
export const titleEvent = (seq, time, title) => ({ type: 'session/title', seq, time, data: { title } })
/** fork 标记：data.inherited === true，seq = 继承前缀长度。 */
export const endSeed = (seq, time, inherited) => ({ type: 'session/end-seed', seq, time, data: { inherited } })

/** 事件数组 → JSONL 文本（每行一个事件，含结尾换行）。 */
export const jsonl = (lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'

/** 一帧带校验和的 zstd（harness 每次 flush 写一帧）。 */
export const frame = (text) => zstdCompressSync(Buffer.from(text), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })

export const sessionFile = (home, bucket, sid) => join(home, 'sessions', bucket, sid, SESSION_FILE)

/** harness 布局的会话文件：flushes = 每次 flush 的事件数组（第一个通常是 [header]）。 */
export function writeLog(home, bucket, sid, flushes) {
  const file = sessionFile(home, bucket, sid)
  mkdirSync(join(home, 'sessions', bucket, sid), { recursive: true })
  writeFileSync(file, Buffer.concat(flushes.map((lines) => frame(jsonl(lines)))))
  return file
}

/** 追加一次 flush。 */
export const appendFrame = (file, lines) => appendFileSync(file, frame(jsonl(lines)))

/** 整数毫秒 mtime（索引按 size+mtime 校验；整数便于原样恢复）。 */
export const setMtime = (file, ms) => {
  const at = new Date(ms)
  utimesSync(file, at, at)
}
