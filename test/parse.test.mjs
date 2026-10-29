import test from 'node:test'
import assert from 'node:assert/strict'

import { parseLog } from '../lib/parse.js'

/* 构造最小 JSONL 日志：header + 可选 title + 用户消息 + handoff skill 调用行 */
const header = (id = 'session-x', extra = {}) =>
  JSON.stringify({ type: 'session', id, createdAt: 1000, ...extra })
const userMsg = (text, time) =>
  JSON.stringify({ type: 'user/message', time, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const handoffCall = (seq, time) =>
  JSON.stringify({ type: 'user/message', seq, time, data: { source: { kind: 'skill-invocation', name: 'handoff' }, content: [] } })
const otherSkillCall = (seq, time) =>
  JSON.stringify({ type: 'user/message', seq, time, data: { source: { kind: 'skill-invocation', name: 'stc' }, content: [] } })

const log = (lines) => lines.join('\n') + '\n'

test('无 handoff 调用：handoffUsed=false、无明细', () => {
  const p = parseLog(log([header(), userMsg('你好', 2000)]))
  assert.equal(p.handoffUsed, false)
  assert.equal(p.handoffFirst, false)
  assert.deepEqual(p.handoffHits, [])
})

test('首轮调用（第一、二条用户消息之间）：handoffFirst=true', () => {
  const p = parseLog(log([header(), userMsg('一', 2000), handoffCall(10, 2100), userMsg('二', 3000)]))
  assert.equal(p.handoffUsed, true)
  assert.equal(p.handoffFirst, true)
  assert.deepEqual(p.handoffHits, [{ seq: 10, at: 2100, turn: 1 }])
})

test('中间轮调用（回归点）：handoffUsed=true 而 handoffFirst=false', () => {
  const p = parseLog(log([
    header(),
    userMsg('一', 2000),
    userMsg('二', 3000),
    handoffCall(20, 3100),
    userMsg('三', 4000),
  ]))
  assert.equal(p.handoffUsed, true)
  assert.equal(p.handoffFirst, false)
  assert.deepEqual(p.handoffHits, [{ seq: 20, at: 3100, turn: 2 }])
})

test('末窗口调用：轮次 = 真实用户消息条数', () => {
  const p = parseLog(log([
    header(),
    userMsg('一', 2000),
    userMsg('二', 3000),
    userMsg('三', 4000),
    handoffCall(30, 4100),
  ]))
  assert.equal(p.handoffUsed, true)
  assert.deepEqual(p.handoffHits, [{ seq: 30, at: 4100, turn: 3 }])
})

test('多次调用：按日志顺序全量记录，轮次逐一对账', () => {
  const p = parseLog(log([
    header(),
    handoffCall(1, 1500),
    userMsg('一', 2000),
    userMsg('二', 3000),
    handoffCall(2, 3100),
    userMsg('三', 4000),
    handoffCall(3, 4100),
    handoffCall(4, 4200),
  ]))
  assert.equal(p.handoffUsed, true)
  /* 开局（无用户消息前）调用记第 1 轮 */
  assert.deepEqual(p.handoffHits, [
    { seq: 1, at: 1500, turn: 1 },
    { seq: 2, at: 3100, turn: 2 },
    { seq: 3, at: 4100, turn: 3 },
    { seq: 4, at: 4200, turn: 3 },
  ])
})

test('非 handoff 的 skill-invocation 不计数；name 校验生效', () => {
  const p = parseLog(log([header(), userMsg('一', 2000), otherSkillCall(9, 2100)]))
  assert.equal(p.handoffUsed, false)
  assert.deepEqual(p.handoffHits, [])
})

test('撕裂/损坏行跳过；缺 seq/time 兜底 0', () => {
  const torn = '{"type":"user/message","seq":7,"time":22'
  const p = parseLog(log([header(), userMsg('一', 2000), torn, handoffCall(0, 0)]))
  assert.equal(p.handoffUsed, true)
  assert.deepEqual(p.handoffHits, [{ seq: 0, at: 0, turn: 1 }])
})

test('无用户消息仅开局调用：仍算 handoffUsed + handoffFirst', () => {
  const p = parseLog(log([header(), handoffCall(5, 1600)]))
  assert.equal(p.handoffUsed, true)
  assert.equal(p.handoffFirst, true)
  assert.deepEqual(p.handoffHits, [{ seq: 5, at: 1600, turn: 1 }])
})

test('原有字段不回归：标题/首用户时间/seed/parent/cwd/末活动', () => {
  const p = parseLog(log([
    header('session-y', { parentSession: 'session-p', isSeeded: true, cwd: '/w' }),
    JSON.stringify({ type: 'session/title', data: { title: '标题' } }),
    userMsg('读 handoff 文档继续', 2000),
    handoffCall(6, 2100),
  ]))
  assert.equal(p.title, '标题')
  assert.equal(p.firstUserAt, 2000)
  assert.equal(p.parent, 'session-p')
  assert.equal(p.seeded, true)
  assert.equal(p.cwd, '/w')
  assert.equal(p.handoffUsed, true)
  assert.equal(p.lastAt, 2100)
})

test('反例回归（2026-10-29 定夺）：首条消息含 handoff 字样不产生任何 handoff 标记', () => {
  /* 讨论 handoff 的会话（如“…改为 消息中有使用过 handoff skills。”）不得被误标 */
  const p = parseLog(log([header(), userMsg('待接后继标签需要改为 消息中有使用过 handoff skills。', 2000)]))
  assert.equal(p.handoffUsed, false)
  assert.equal(p.handoffFirst, false)
  assert.deepEqual(p.handoffHits, [])
  assert.equal('handoffSeed' in p, false)
})

test('空文本/坏 header 返回 null', () => {
  assert.equal(parseLog(''), null)
  assert.equal(parseLog('not-json\n'), null)
  assert.equal(parseLog(log([JSON.stringify({ type: 'other', id: 'x' })])), null)
})
