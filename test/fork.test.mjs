import test from 'node:test'
import assert from 'node:assert/strict'

import { parseLog, signatureLog } from '../lib/parse.js'
import { inferForkParents } from '../lib/lineage-infer.js'

/* Synthetic v4-style logs. Key order matters: {"type":…,"seq":…,"time":…} opens
 * every event line (the signature fast path relies on it); seqs stay dense
 * like real logs. */
const header = (id, createdAt, extra = {}) =>
  JSON.stringify({ type: 'session', id, createdAt, isSeeded: false, ...extra })
const ev = (type, seq, time, data = {}) =>
  JSON.stringify({ type, seq, time, data })
const userMsg = (seq, time, text) =>
  JSON.stringify({ type: 'user/message', seq, time, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const handoffCall = (seq, time) =>
  JSON.stringify({ type: 'user/message', seq, time, data: { source: { kind: 'skill-invocation', name: 'handoff' }, content: [] } })
const forkMarker = (seq, time) =>
  JSON.stringify({ type: 'session/end-seed', seq, time, data: { inherited: true } })
const bareMarker = (seq, time) =>
  JSON.stringify({ type: 'session/end-seed', seq, time, data: {} })
const log = (lines) => lines.join('\n') + '\n'

/* Source log: two events, one user message, one handoff call, one more event. */
const srcLines = [
  header('session-src', 100),
  ev('permission/preset', 0, 100),
  ev('sandbox/mode', 1, 101),
  userMsg(2, 102, 'inherited question'),
  handoffCall(3, 103),
  ev('command/done', 4, 104),
]

test('fork 子代：own marker = 末位 inherited end-seed，createdAt 取自有首条用户消息', () => {
  const child = log([
    header('session-child', 104),
    ...srcLines.slice(1),
    forkMarker(5, 104),
    ev('turn/end', 6, 104, { kind: 'forked' }),
    userMsg(7, 5000, 'own question'),
  ])
  const p = parseLog(child)
  assert.equal(p.forkMarkerSeq, 5)
  assert.equal(p.firstUserAt, 5000) // not the inherited 102
  // Inherited handoff call must not count as the child's own.
  assert.equal(p.handoffUsed, false)
  assert.deepEqual(p.handoffHits, [])
})

test('fork 子代自有 handoff 调用：计入，轮次只数自有用户消息，首窗判定照旧', () => {
  const child = log([
    header('session-child', 104),
    ...srcLines.slice(1),
    forkMarker(5, 104),
    userMsg(6, 5000, 'own 1'),
    handoffCall(7, 5100),
    userMsg(8, 5200, 'own 2'),
    handoffCall(9, 5300),
  ])
  const p = parseLog(child)
  assert.equal(p.handoffUsed, true)
  assert.equal(p.handoffFirst, true) // the seq-7 call sits inside the own first window (before own2)
  assert.deepEqual(p.handoffHits, [
    { seq: 7, at: 5100, turn: 1 },
    { seq: 9, at: 5300, turn: 2 },
  ])
})

test('裸 end-seed（压缩边界，data 无 inherited）：不是 fork', () => {
  const p = parseLog(log([
    header('session-x', 100),
    ev('permission/preset', 0, 100),
    bareMarker(1, 100),
    userMsg(2, 200, 'hello'),
  ]))
  assert.equal(p.forkMarkerSeq, null)
  assert.equal(p.firstUserAt, 200)
})

test('fork 家族标记复制：末位 inherited marker 胜出（祖先的只是拷贝）', () => {
  const grandchild = log([
    header('session-grandchild', 107),
    ...srcLines.slice(1),
    forkMarker(5, 104), // copied from the child's own marker
    ev('command/done', 6, 105),
    ev('step/start', 7, 106),
    ev('step/end', 8, 107),
    forkMarker(9, 107), // grandchild's own marker (inherited prefix = 9 events)
    userMsg(10, 9000, 'grandchild question'),
  ])
  const p = parseLog(grandchild)
  assert.equal(p.forkMarkerSeq, 9)
  assert.equal(p.firstUserAt, 9000)
})

test('signatureLog：快路径 + 无 time 行跳过 + JSON 回退', () => {
  const sig = signatureLog(log([
    header('session-x', 100), // header: no seq → skipped
    ev('sandbox/mode', 1, 101),
    '{"type":"weird/event","seq":2}', // no time → skipped
    userMsg(3, 103, 'q'), // fast regex path (type first)
    '{"seq":4,"time":104,"type":"odd/order"}', // fallback JSON.parse path
    'torn line without json',
  ]))
  assert.deepEqual(sig, [
    ['sandbox/mode', 1, 101],
    ['user/message', 3, 103],
    ['odd/order', 4, 104],
  ])
})

/* ---- inferForkParents ---- */

const sigOf = (lines) => signatureLog(log(lines))

test('fork 家族归因：全前缀匹配 + logCreatedAt 次序消歧', () => {
  const parent = sigOf([
    header('session-parent', 100),
    ev('a', 0, 100), ev('b', 1, 101), ev('c', 2, 102), ev('d', 3, 103),
  ])
  const child = sigOf([
    header('session-child', 200),
    ev('a', 0, 100), ev('b', 1, 101), ev('c', 2, 102),
    forkMarker(3, 103),
    ev('e', 4, 200), ev('f', 5, 201), ev('g', 6, 202),
  ])
  const kidA = sigOf([ // forked child at boundary 4 (prefix 5)
    header('session-kid-a', 300),
    ev('a', 0, 100), ev('b', 1, 101), ev('c', 2, 102), forkMarker(3, 103), ev('e', 4, 200),
    forkMarker(5, 200),
    ev('f', 6, 300), ev('h', 7, 310),
  ])
  const kidB = sigOf([ // forked child at boundary 6 (prefix 7)
    header('session-kid-b', 400),
    ev('a', 0, 100), ev('b', 1, 101), ev('c', 2, 102), forkMarker(3, 103), ev('e', 4, 200), ev('f', 5, 201), ev('g', 6, 202),
    forkMarker(7, 202),
    ev('i', 8, 400),
  ])
  const nodes = [
    { id: 'session-parent', parent: null, forkMarkerSeq: null, logCreatedAt: 100 },
    { id: 'session-child', parent: null, forkMarkerSeq: 3, logCreatedAt: 200 },
    { id: 'session-kid-a', parent: null, forkMarkerSeq: 5, logCreatedAt: 300 },
    { id: 'session-kid-b', parent: null, forkMarkerSeq: 7, logCreatedAt: 400 },
  ]
  const sigs = new Map([
    ['session-parent', parent],
    ['session-child', child],
    ['session-kid-a', kidA],
    ['session-kid-b', kidB],
  ])
  const out = inferForkParents(nodes, (id) => sigs.get(id) ?? null)
  // Both kids share child's whole prefix; child (200) predates kidA (300) / kidB (400).
  assert.deepEqual(out.get('session-child'), { parent: 'session-parent', matchedSeq: 3 })
  assert.deepEqual(out.get('session-kid-a'), { parent: 'session-child', matchedSeq: 5 })
  assert.deepEqual(out.get('session-kid-b'), { parent: 'session-child', matchedSeq: 7 })
})

test('header 血缘在桶外/缺失才推断；桶内 header 胜出；无候选不出边', () => {
  const a = sigOf([header('a', 1), ev('x', 0, 1), ev('y', 1, 2)])
  const b = sigOf([header('b', 2), ev('x', 0, 1), ev('y', 1, 2), forkMarker(2, 2), ev('z', 3, 2)])
  const nodes = [
    { id: 'a', parent: null, forkMarkerSeq: null, logCreatedAt: 1 },
    { id: 'b', parent: 'gone-session', forkMarkerSeq: 2, logCreatedAt: 2 },
  ]
  const sigs = new Map([['a', a], ['b', b]])
  assert.deepEqual(
    inferForkParents(nodes, (id) => sigs.get(id) ?? null).get('b'),
    { parent: 'a', matchedSeq: 2 },
  )
  // Header parent already in-bucket: inference skips (header wins).
  const inBucket = [{ id: 'b', parent: 'a', forkMarkerSeq: 2, logCreatedAt: 2 }]
  assert.equal(inferForkParents(inBucket, (id) => sigs.get(id) ?? null).size, 0)
  // No candidate matches (no other session): no edge invented.
  const alone = [{ id: 'b', parent: null, forkMarkerSeq: 2, logCreatedAt: 2 }]
  assert.equal(inferForkParents(alone, (id) => sigs.get(id) ?? null).size, 0)
})
