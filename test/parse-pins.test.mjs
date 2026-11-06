import test from 'node:test'
import assert from 'node:assert/strict'

import { parseLog } from '../lib/parse.js'

/* Pin tests for mutation-testing survivors that are real test gaps
 * (mutator-trial, task-2). Equivalence-class survivors are deliberately
 * NOT pinned here — see the task-2 triage notes.
 * 同 parse.test.mjs 风格：最小 JSONL 日志 + 中文测试名。 */

const header = (id = 'session-pins', createdAt = 1000) =>
  JSON.stringify({ type: 'session', id, createdAt })
const userMsg = (text, time) =>
  JSON.stringify({ type: 'user/message', time, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const handoffCall = (seq, time) =>
  JSON.stringify({ type: 'user/message', seq, time, data: { source: { kind: 'skill-invocation', name: 'handoff' }, content: [] } })
const ev = (type, seq, time) => JSON.stringify({ type, seq, time })
const log = (lines) => lines.join('\n') + '\n'

test('多条带时用户消息：firstUserAt 取首条时间（first-wins，不被后续消息覆盖）', () => {
  const p = parseLog(log([header(), userMsg('一', 2000), userMsg('二', 5000)]))
  assert.equal(p.firstUserAt, 2000)
})

test('末行三种坏尾巴（缺 time / 撕裂 / time=0）：lastAt 取上方最近带时事件而非兜底', () => {
  /* 尾巴1：整行缺 "time" 字段 → eventTime 快速跳过 */
  const p1 = parseLog(log([header('h1'), ev('a', 1, 9000), '{"type":"x","seq":9}']))
  assert.equal(p1.lastAt, 9000)
  /* 尾巴2：撕裂行（含 "time" 但 JSON 不完整）→ catch 兜底 0 */
  const p2 = parseLog(log([header('h2'), ev('b', 1, 9000), '{"type":"y","seq":10,"time":99']))
  assert.equal(p2.lastAt, 9000)
  /* 尾巴3：time=0（无时间事件）→ >0 校验拒绝 */
  const p3 = parseLog(log([header('h3'), ev('c', 1, 9000), '{"type":"z","seq":11,"time":0}']))
  assert.equal(p3.lastAt, 9000)
})

test('反向扫描 guard：尾部 65 条无时行触顶截断，lastAt 兜底 createdAt', () => {
  const lines = [header('h4'), ev('e', 1, 9000)]
  for (let i = 0; i < 65; i += 1) lines.push(`{"type":"noise${i}","seq":${i + 2}}`)
  const p = parseLog(log(lines))
  assert.equal(p.lastAt, 1000)
})

test('坏 header 行为 JSON null：parseLog 返回 null 而非崩溃', () => {
  assert.equal(parseLog('null\n' + header('h5') + '\n'), null)
})

test('handoff 行缺 seq/time 字段：兜底 0（非 number 一律 0）', () => {
  const noFields =
    JSON.stringify({ type: 'user/message', data: { source: { kind: 'skill-invocation', name: 'handoff' } } })
  const p = parseLog(log([header(), noFields]))
  assert.deepEqual(p.handoffHits, [{ seq: 0, at: 0, turn: 1 }])
})

test('恰好两条用户消息 + 末窗调用：handoffFirst=false（首窗边界 = 第二条消息）', () => {
  const p = parseLog(log([header(), userMsg('一', 2000), userMsg('二', 3000), handoffCall(10, 3100)]))
  assert.equal(p.handoffFirst, false)
  assert.equal(p.handoffUsed, true)
})
