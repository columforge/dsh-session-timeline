/**
 * extractTurns 纯函数单测（lib/turns.js）：轮次归属规则与 /turns 路由测试
 * （test/routes.test.mjs）互补，不重复其端到端用例——这里覆盖路由测不到的
 * 事件形状分支：多 text 块拼接、非文本块忽略、content 缺失、缺 time 回 0、
 * 非 handoff 技能调用忽略、reasoning 与正式正文的先后覆盖、坏行跳过、
 * handoffTurns 升序。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { extractTurns, TURN_CLIP } from '../lib/turns.js'

const userMsg = (time, text, extra = {}) =>
  JSON.stringify({ type: 'user/message', time, data: { source: { kind: 'user' }, content: extra.content ?? [{ type: 'text', text }] } })
const userMsgWithSeq = (seq, time, text) =>
  JSON.stringify({ type: 'user/message', seq, time, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const handoffCall = (time) =>
  JSON.stringify({ type: 'user/message', time, data: { source: { kind: 'skill-invocation', name: 'handoff' } } })
const otherSkillCall = (time) =>
  JSON.stringify({ type: 'user/message', time, data: { source: { kind: 'skill-invocation', name: 'stc' } } })
const assistantMsg = (time, blocks) =>
  JSON.stringify({ type: 'assistant/message', time, data: { message: { content: blocks } } })

test('轮次携带 user message 的 seq（/turns 侧跳转锚点）；缺 seq 回 -1', () => {
  const s = extractTurns([userMsgWithSeq(7, 1100, 'q1'), userMsgWithSeq(42, 2100, 'q2')].join('\n') + '\n')
  assert.deepEqual(s.turns.map((t) => t.seq), [7, 42])
  const noSeq = extractTurns(userMsg(1100, 'q') + '\n')
  assert.equal(noSeq.turns[0].seq, -1)
})

test('多 text 块按 \\n 拼接；非文本块（reasoning 之外的类型）不进正文', () => {
  const s = extractTurns([
    userMsg(1100, undefined, { content: [{ type: 'text', text: '甲' }, { type: 'image', text: 'IMG' }, { type: 'text', text: '乙' }] }),
    assistantMsg(1200, [{ type: 'text', text: '回甲' }]),
  ].join('\n') + '\n')
  assert.equal(s.turns.length, 1)
  assert.equal(s.turns[0].user, '甲\n乙')
  assert.equal(s.turns[0].assistant, '回甲')
})

test('user 消息 content 缺失/非数组：不产生轮次', () => {
  const noContent = JSON.stringify({ type: 'user/message', time: 1, data: { source: { kind: 'user' } } })
  const arrContent = JSON.stringify({ type: 'user/message', time: 2, data: { source: { kind: 'user' }, content: 'not-array' } })
  const s = extractTurns([noContent, arrContent].join('\n') + '\n')
  assert.equal(s.turns.length, 0)
  assert.deepEqual(s.handoffTurns, [])
})

test('缺 time 回 0；非 handoff 技能调用忽略；开局 handoff 跳过', () => {
  const noTime = JSON.stringify({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'q' }] } })
  const s = extractTurns([handoffCall(900), otherSkillCall(950), noTime, handoffCall(1000)].join('\n') + '\n')
  assert.equal(s.turns.length, 1)
  assert.equal(s.turns[0].at, 0)
  assert.deepEqual(s.handoffTurns, [1])
})

test('assistant 多 text 块拼接；formal 后再来 reasoning 不回退；reasoning 兜底不带 clipped 标记', () => {
  const s = extractTurns([
    userMsg(1100, 'q'),
    assistantMsg(1200, [{ type: 'text', text: '回一' }, { type: 'text', text: '回二' }]),
    assistantMsg(1300, [{ type: 'reasoning', text: '多余推理' }]),
    assistantMsg(1400, [{ type: 'text', text: 'x'.repeat(TURN_CLIP + 1) }]),
  ].join('\n') + '\n')
  assert.equal(s.turns.length, 1)
  const t = s.turns[0]
  assert.equal(t.assistant.length, TURN_CLIP)
  assert.equal(t.assistantClipped, true)
  assert.equal(t.assistantReasoning, false)
})

test('坏 JSON 行跳过；handoffTurns 升序', () => {
  const bad = '{"type":"user/message","data":{ broken'
  const s = extractTurns([
    userMsg(1100, 'q1'), handoffCall(1200), bad, userMsg(2100, 'q2'), handoffCall(2200),
  ].join('\n') + '\n')
  assert.equal(s.turns.length, 2)
  assert.deepEqual(s.handoffTurns, [1, 2])
})

test('user 正文裁剪与标记（4000 边界）', () => {
  const s = extractTurns(userMsg(1100, 'a'.repeat(TURN_CLIP + 5)) + '\n')
  assert.equal(s.turns[0].user.length, TURN_CLIP)
  assert.equal(s.turns[0].userClipped, true)
  const exact = extractTurns(userMsg(1100, 'b'.repeat(TURN_CLIP)) + '\n')
  assert.equal(exact.turns[0].userClipped, false)
})
