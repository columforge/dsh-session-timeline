/**
 * 索引记录（record.ts）单测：
 * - 增量合并 ≡ 整日志解析：随机日志分多次 flush 追加，每一步的记录与「从头整日志构建」
 *   deepEqual（标题 / 首条用户消息 / 末次活动 / handoff 命中与轮次 / fork 标记 / 尾部时间 /
 *   用户消息数），并与 parseLogFull 的节点字段一致
 * - 追加块带自己的 fork 标记 → 不合并（调用方整日志重建）
 * - 签名列：整数时间存增量、非整数存原值、按上限截断、可续接、sigCovers
 * - 失败记录、骨架、首帧 header 取值
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLogFull, scanChunk, signatureLog } from '../lib/parse.js'
import {
  SIG_CAP, TAIL_LINES, appendSig, buildRec, extendRec, failedRec, headCwd, headerLine, isOk,
  packSig, recNode, sigCovers, skeletonNode, skeletonOf, unpackSig,
} from '../lib/record.js'
import { assistantMsg, endSeed, handoffCall, header, titleEvent, userMsg } from './fixtures.mjs'

const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
const textOf = (events) => events.map((ev) => JSON.stringify(ev) + '\n').join('')

/** 随机事件流（时间大多递增，偶发 time=0 走兜底）；marker = 某次 flush 中段插自己的 fork 标记。 */
function genLog(rand, { marker = false } = {}) {
  const parts = [[header('session-a', { createdAt: 500, cwd: '/w' })]]
  const groups = 3 + Math.floor(rand() * 5)
  const markerGroup = 1 + Math.floor(rand() * (groups - 1))
  let seq = 1
  let time = 1000
  for (let g = 0; g < groups; g += 1) {
    const events = []
    const n = Math.floor(rand() * 90)
    for (let i = 0; i < n; i += 1) {
      const roll = rand()
      time += rand() < 0.12 ? 0 : 1 + Math.floor(rand() * 5)
      const at = roll < 0.05 ? 0 : time
      if (roll < 0.28) events.push(userMsg(seq, at, 'u' + seq))
      else if (roll < 0.36) events.push(handoffCall(seq, at))
      else if (roll < 0.46) events.push(titleEvent(seq, at, rand() < 0.2 ? '  ' : '标题 ' + seq))
      else events.push(assistantMsg(seq, at))
      seq += 1
    }
    if (marker && g === markerGroup && events.length > 0) events.splice(Math.floor(rand() * events.length), 0, endSeed(seq, time, true))
    parts.push(events)
  }
  return parts.map(textOf)
}

test('增量合并 ≡ 整日志解析（随机日志，多块追加，含 fork 标记）', () => {
  let mergedSteps = 0
  let rebuiltSteps = 0
  for (let seed = 1; seed <= 80; seed += 1) {
    const parts = genLog(rng(seed), { marker: seed % 2 === 0 })
    let text = parts[0]
    let rec = buildRec(text, 100, 7)
    assert.ok(isOk(rec), 'header-only log is a record')
    for (let k = 1; k < parts.length; k += 1) {
      const chunk = parts[k]
      const c = scanChunk(chunk)
      if (c === null) {
        // the chunk carries an own fork marker: the caller rebuilds the whole log
        rec = buildRec(text + chunk, 100 + k, 7 + k)
        rebuiltSteps += 1
      } else {
        rec = extendRec(rec, c, 100 + k, 7 + k)
        mergedSteps += 1
      }
      text += chunk
      const whole = buildRec(text, 100 + k, 7 + k)
      assert.deepEqual(rec, whole, 'seed ' + seed + ' part ' + k + ': record fields')
      const log = parseLogFull(text)
      const node = recNode(rec, 'session-a', 'b')
      assert.deepEqual({
        title: node.title,
        createdAt: node.createdAt,
        lastAt: node.lastAt,
        parent: node.parent,
        seeded: node.seeded,
        cwd: node.cwd,
        handoffFirst: node.handoffFirst,
        handoffUsed: node.handoffUsed,
        handoffHits: node.handoffHits,
        forkMarkerSeq: node.forkMarkerSeq,
        users: rec.users,
      }, {
        title: log.title,
        createdAt: log.firstUserAt > 0 ? log.firstUserAt : log.createdAt,
        lastAt: log.lastAt,
        parent: log.parent,
        seeded: log.seeded,
        cwd: log.cwd,
        handoffFirst: log.handoffFirst,
        handoffUsed: log.handoffUsed,
        handoffHits: log.handoffHits,
        forkMarkerSeq: log.forkMarkerSeq,
        users: log.users,
      }, 'seed ' + seed + ' part ' + k + ': node fields')
    }
  }
  assert.ok(mergedSteps > 150 && rebuiltSteps > 20, 'both paths exercised: ' + mergedSteps + ' merged, ' + rebuiltSteps + ' rebuilt')
})

test('追加块全是无时间事件：64 行预算用尽后回退 header.createdAt，与整日志一致', () => {
  const base = textOf([header('session-a', { createdAt: 500 })])
  const timed = textOf([userMsg(1, 4242), assistantMsg(2, 4243)])
  const blank = (n) => textOf(Array.from({ length: n }, (_, i) => assistantMsg(10 + i, 0)))
  const cases = [
    [base, blank(3), timed],
    [base, timed, blank(3)],
    [base, timed, blank(TAIL_LINES - 1)],
    [base, timed, blank(TAIL_LINES)],
    [base, timed, blank(TAIL_LINES + 40), blank(5)],
    [base, blank(70), timed, blank(70), textOf([userMsg(99, 9000)]), blank(80)],
  ]
  for (const [first, ...chunks] of cases) {
    let text = first
    let rec = buildRec(text, 1, 1)
    for (const [i, chunk] of chunks.entries()) {
      rec = extendRec(rec, scanChunk(chunk), 2 + i, 1)
      text += chunk
      assert.deepEqual(rec, buildRec(text, 2 + i, 1))
    }
  }
  const onlyBlank = extendRec(buildRec(base, 1, 1), scanChunk(blank(100)), 2, 1)
  assert.equal(onlyBlank.lastAt, 500)
  assert.equal(onlyBlank.tail.length, TAIL_LINES)
})

test('块内 handoff 轮次 = 旧用户数 + 块内轮次；标题取块内最后一个有效标题', () => {
  const base = textOf([header('session-a'), userMsg(1, 10), titleEvent(2, 11, 'old')])
  const c = scanChunk(textOf([userMsg(3, 20), handoffCall(4, 21), titleEvent(5, 22, ''), titleEvent(6, 23, 'new')]))
  const rec = extendRec(buildRec(base, 1, 1), c, 9, 1)
  assert.equal(rec.title, 'new')
  assert.deepEqual(rec.handoffHits, [{ seq: 4, at: 21, turn: 2 }])
  assert.equal(rec.handoffFirst, false)
  assert.equal(rec.handoffUsed, true)
  assert.equal(rec.users, 2)
  // opening handoff of the whole log: before the first user message
  const first = extendRec(buildRec(textOf([header('session-a')]), 1, 1), scanChunk(textOf([handoffCall(1, 5), userMsg(2, 6)])), 2, 1)
  assert.equal(first.handoffFirst, true)
})

test('追加块带自己的 fork 标记 → scanChunk 返回 null（之后的用户消息只算标记之后的）', () => {
  const base = textOf([header('session-a'), userMsg(1, 10), handoffCall(2, 11), userMsg(3, 12)])
  const marker = textOf([endSeed(3, 13, true)])
  assert.equal(scanChunk(marker), null)
  assert.equal(scanChunk(textOf([endSeed(9, 13, false)]))?.users, 0, 'a non-inherited end-seed is no marker')
  const whole = parseLogFull(base + marker + textOf([userMsg(4, 14), handoffCall(5, 15)]))
  assert.equal(whole.users, 1, 'only the message after the own marker counts')
  assert.equal(whole.forkMarkerSeq, 3)
  // and merges continue verbatim once the marker is part of the base
  const rec = buildRec(base + marker, 1, 1)
  const next = extendRec(rec, scanChunk(textOf([userMsg(4, 14), handoffCall(5, 15)])), 2, 1)
  assert.deepEqual(next, buildRec(base + marker + textOf([userMsg(4, 14), handoffCall(5, 15)]), 2, 1))
})

test('签名列：整数时间存增量、非整数存原值、截断到上限、续接', () => {
  const sig = [['a', 1, 100], ['b', 2, 150], ['a', 3, 140], ['c', 4, 140], ['a', 5, 1000.5]]
  const raw = packSig(sig)
  assert.equal(raw.raw, true)
  assert.deepEqual(unpackSig(raw), sig)
  assert.deepEqual(raw.d, ['a', 'b', 'c'], 'types in first-appearance order')
  const int = packSig(sig.slice(0, 4))
  assert.equal(int.raw, undefined)
  assert.deepEqual(int.t, [100, 50, -10, 0], 'first time, then deltas (negative and zero included)')
  assert.deepEqual(unpackSig(int), sig.slice(0, 4))

  const big = Array.from({ length: 10 }, (_, i) => ['t' + (i % 3), i, i * 7])
  const capped = packSig(big, 4)
  assert.equal(capped.k.length, 4, 'truncated at the cap')
  assert.deepEqual(unpackSig(capped), big.slice(0, 4))
  assert.deepEqual(unpackSig(packSig([])), [])

  const grown = appendSig(packSig(big.slice(0, 4), 6), big.slice(4, 7), 6)
  assert.deepEqual(unpackSig(grown), big.slice(0, 6), 'appended, then capped again')
  assert.deepEqual(unpackSig(appendSig(undefined, big.slice(0, 2), 6)), big.slice(0, 2))
})

test('sigCovers：够到 cut 或未截断才算覆盖', () => {
  const sig = packSig(Array.from({ length: 5 }, (_, i) => [['t', i, i]]), 5)
  assert.equal(sigCovers(undefined, 1), false)
  assert.equal(sigCovers(sig, 5), true, 'reaches the cut')
  assert.equal(sigCovers(sig, 9), true, 'shorter than the cut, but not truncated')
  const trunc = packSig(Array.from({ length: 9 }, (_, i) => ['t', i, i]), 5)
  assert.equal(sigCovers(trunc, 5), true)
  assert.equal(sigCovers(trunc, 6, 5), false, 'truncated below the cut')
  assert.equal(packSig([], SIG_CAP).k.length, 0)
})

test('失败记录 / 首帧 header / 骨架', () => {
  const failed = buildRec(null, 12, 34)
  assert.deepEqual(failed, failedRec(12, 34))
  assert.equal(isOk(failed), false)
  assert.equal(isOk(undefined), false)
  assert.deepEqual(buildRec('not a session\n', 12, 34), failed, 'no session header line')
  assert.deepEqual(buildRec(textOf([header('session-a')]).trimEnd(), 3, 4), failedRec(3, 4), 'a header without its line end does not parse')
  const open = textOf([header('session-a'), assistantMsg(1, 5)]).trimEnd()
  assert.deepEqual(buildRec(open, 3, 4), { ...buildRec(open + '\n', 3, 4), nl: false }, 'last line without a newline')

  const head = JSON.stringify(header('session-a', { parentSession: 'session-p', isSeeded: true }))
  assert.equal(headCwd(head), '/w', 'header frame may end without a newline')
  assert.equal(headCwd(head + '\n'), '/w')
  assert.equal(headCwd(JSON.stringify({ type: 'x' })), null)
  assert.equal(headerLine('a\nb\nc'), 'a')
  assert.equal(headerLine('abc'), 'abc')

  const sk = skeletonOf(head, textOf([assistantMsg(7, 777), assistantMsg(8, 0)]))
  assert.deepEqual(sk, { head, createdAt: 1000, seeded: true, cwd: '/w', parent: 'session-p', lastAt: 777 })
  assert.deepEqual(skeletonNode(sk, 'session-a', 'b'), {
    id: 'session-a', title: null, createdAt: 1000, logCreatedAt: 1000, lastAt: 777, parent: 'session-p', parentSource: 'header',
    forkMarkerSeq: null, seeded: true, cwd: '/w', bucket: 'b', handoffFirst: false, handoffUsed: false, handoffHits: [], archived: false,
  })
  assert.equal(skeletonOf('garbage', ''), null)
  assert.equal(skeletonOf(head, '')?.lastAt, 1000, 'no tail: the header time')
  assert.equal(signatureLog('x').length, 0)
})
