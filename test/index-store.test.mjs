/**
 * 索引文件读写（index-store.ts）单测：
 * - 记录表与签名表序列化 → 解析 round trip（成功记录、失败记录、截断/原值签名）
 * - 坏文件整体不可用 → null（非 JSON、版本不符、bucket 不符、表缺失/不是对象）
 * - 单条记录字段类型不符 → 只丢该条（其余保留）
 * - classify：无记录 / 未变 / 变长 / 改写
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseIndex, parseSigs, classify, serializeIndex, serializeSigs, INDEX_VERSION } from '../lib/index-store.js'
import { buildRec, failedRec, packSig } from '../lib/record.js'
import { assistantMsg, handoffCall, header, titleEvent, userMsg } from './fixtures.mjs'

const textOf = (events) => events.map((ev) => JSON.stringify(ev) + '\n').join('')
const full = buildRec(textOf([
  header('session-a', { parentSession: 'session-p', isSeeded: true, cwd: '/w' }),
  titleEvent(1, 10, 't'), userMsg(2, 11), handoffCall(3, 12), userMsg(4, 13), assistantMsg(5, 14),
]), 100, 200)
const plain = buildRec(textOf([header('session-b')]), 1, 2)
const bad = failedRec(3, 4)

test('记录表 round trip：成功记录 / 失败记录 / 空表', () => {
  assert.equal(INDEX_VERSION, 1)
  const recs = new Map([['session-a', full], ['session-b', plain], ['session-c', bad]])
  const text = serializeIndex('--w--', recs)
  assert.deepEqual(JSON.parse(text).v, INDEX_VERSION)
  const back = parseIndex(text, '--w--')
  assert.deepEqual([...back], [...recs])
  assert.deepEqual([...parseIndex(serializeIndex('--w--', new Map()), '--w--')], [])
})

test('签名表 round trip：增量式 / 原值式 / 截断', () => {
  const sigs = new Map([
    ['session-a', packSig([['a', 1, 100], ['b', 2, 150], ['a', 3, 140]])],
    ['session-b', packSig([['a', 1, 1.5], ['b', 2, 2]])],
    ['session-c', packSig(Array.from({ length: 9 }, (_, i) => ['t', i, i]), 4)],
    ['session-d', packSig([])],
  ])
  const back = parseSigs(serializeSigs('--w--', sigs), '--w--')
  assert.deepEqual([...back], [...sigs])
})

test('坏文件整体不可用 → null', () => {
  const good = serializeIndex('--w--', new Map([['session-a', full]]))
  const sig = serializeSigs('--w--', new Map([['session-a', packSig([['a', 1, 1]])]]))
  const cases = [
    ['', '--w--'],
    ['not json', '--w--'],
    ['null', '--w--'],
    ['[1,2]', '--w--'],
    ['{}', '--w--'],
    [JSON.stringify({ v: 2, bucket: '--w--', recs: {} }), '--w--'],
    [JSON.stringify({ v: 1, bucket: '--other--', recs: {} }), '--w--'],
    [JSON.stringify({ v: 1, bucket: '--w--' }), '--w--'],
    [JSON.stringify({ v: 1, bucket: '--w--', recs: [] }), '--w--'],
    [JSON.stringify({ v: 1, bucket: '--w--', recs: 'x' }), '--w--'],
  ]
  for (const [text, bucket] of cases) assert.equal(parseIndex(text, bucket), null, 'index ' + text.slice(0, 40))
  for (const [text, bucket] of cases) assert.equal(parseSigs(text, bucket), null, 'sigs ' + text.slice(0, 40))
  assert.equal(parseIndex(good, '--other--'), null, 'bucket mismatch')
  assert.equal(parseSigs(sig, '--other--'), null)
  // an entry that is no object is dropped, the rest survives
  const mixed = JSON.stringify({ v: 1, bucket: '--w--', recs: { 'session-a': 5, junk: 'x' } })
  assert.deepEqual([...parseIndex(mixed, '--w--')], [])
  const mixedSig = JSON.stringify({ v: 1, bucket: '--w--', sigs: { a: null } })
  assert.deepEqual([...parseSigs(mixedSig, '--w--')], [])
})

test('单条记录字段不符 → 只丢该条', () => {
  const okRec = JSON.parse(serializeIndex('--w--', new Map([['session-keep', full]]))).recs['session-keep']
  const broken = [
    ['size', 'x'], ['size', -1], ['size', undefined],
    ['mtimeMs', 'x'], ['mtimeMs', NaN],
    ['fail', true], ['fail', 'no'],
    ['head', 5], ['head', undefined], ['nl', 'yes'], ['nl', undefined],
    ['title', 7], ['title', undefined], ['title', ''],
    ['createdAt', 'x'], ['createdAt', undefined], ['firstUserAt', null], ['firstUserAt', '1'],
    ['lastAt', 'x'], ['lastAt', undefined],
    ['parent', 3], ['parent', 0], ['parent', ''], ['seeded', 1], ['seeded', 'true'],
    ['cwd', 0], ['cwd', false], ['cwd', ''],
    ['handoffFirst', 'no'], ['handoffUsed', null], ['handoffUsed', undefined],
    ['handoffHits', {}], ['handoffHits', 'x'], ['handoffHits', undefined],
    ['handoffHits', [{ seq: 1 }]], ['handoffHits', [{ seq: 'a', at: 1, turn: 1 }]],
    ['handoffHits', [{ seq: 1, at: 'x', turn: 1 }]], ['handoffHits', [{ seq: 1, at: 1, turn: 0 }]],
    ['forkMarkerSeq', 'x'],
    ['users', -1], ['users', 'x'], ['users', 1.5],
    ['tail', 'x'], ['tail', ['x']], ['tail', {}],
  ]
  for (const [field, value] of broken) {
    const rec = { ...okRec }
    if (value === undefined) delete rec[field]
    else rec[field] = value
    const text = JSON.stringify({ v: 1, bucket: '--w--', recs: { 'session-bad': rec, 'session-keep': okRec } })
    const back = parseIndex(text, '--w--')
    assert.ok(back !== null, field + ': table still usable')
    assert.deepEqual([...back.keys()], ['session-keep'], field + ' = ' + JSON.stringify(value))
  }
  // a failed record needs exactly its three fields
  const failOk = JSON.stringify({ v: 1, bucket: '--w--', recs: { c: { size: 1, mtimeMs: 2, fail: true } } })
  assert.deepEqual([...parseIndex(failOk, '--w--')], [['c', failedRec(1, 2)]])
  for (const rec of [
    { size: 1, mtimeMs: 2 }, { mtimeMs: 2, fail: true }, { size: 1, fail: true },
    { size: 1, mtimeMs: 2, fail: true, title: 'x' },
  ]) {
    assert.deepEqual([...parseIndex(JSON.stringify({ v: 1, bucket: '--w--', recs: { c: rec } }), '--w--')], [], JSON.stringify(rec))
  }
  // optional fields may be absent (or an explicit fail: false)
  const { fail, ...noFail } = okRec
  assert.deepEqual([...parseIndex(JSON.stringify({ v: 1, bucket: '--w--', recs: { k: noFail } }), '--w--')], [['k', full]])
  assert.deepEqual([...parseIndex(JSON.stringify({ v: 1, bucket: '--w--', recs: { k: { ...noFail, fail: false } } }), '--w--')], [['k', full]])
})

test('单条签名不符 → 只丢该条', () => {
  const ok = JSON.parse(serializeSigs('--w--', new Map([['a', packSig([['x', 1, 5], ['y', 2, 7]])]]))).sigs.a
  const broken = [
    { ...ok, k: [0] }, { ...ok, s: [1] }, { ...ok, t: [5] },
    { ...ok, k: [0, 2] }, { ...ok, k: [0, -1] }, { ...ok, k: ['0', '1'] },
    { ...ok, s: [1, 'x'] }, { ...ok, t: [5, 'x'] },
    { ...ok, d: 'xy' }, { ...ok, d: [] }, { ...ok, d: [1, 2] },
    { ...ok, raw: 'yes' }, { ...ok, raw: false },
  ]
  for (const sig of broken) {
    const text = JSON.stringify({ v: 1, bucket: '--w--', sigs: { bad: sig, keep: ok } })
    assert.deepEqual([...parseSigs(text, '--w--').keys()], ['keep'], JSON.stringify(sig))
  }
  const { raw, ...notRaw } = ok
  assert.deepEqual([...parseSigs(JSON.stringify({ v: 1, bucket: '--w--', sigs: { a: notRaw } }), '--w--')], [['a', notRaw]])
  assert.deepEqual([...parseSigs(JSON.stringify({ v: 1, bucket: '--w--', sigs: { a: { ...ok, raw: true } } }), '--w--')], [['a', { ...ok, raw: true }]])
})

test('classify：无记录 → work；size+mtime 相同 → same；变长且可续接 → grow；其余 → work', () => {
  assert.equal(classify(undefined, 10, 20), 'work')
  assert.equal(classify(full, full.size, full.mtimeMs), 'same')
  assert.equal(classify(bad, 3, 4), 'same', 'a failed record is re-checked only when the file changes')
  assert.equal(classify(full, full.size + 1, full.mtimeMs), 'grow')
  assert.equal(classify(full, full.size + 1, full.mtimeMs + 1), 'grow')
  assert.equal(classify(full, full.size - 1, full.mtimeMs), 'work', 'shrank')
  assert.equal(classify(full, full.size, full.mtimeMs + 1), 'work', 'rewritten in place')
  assert.equal(classify(full, full.size, full.mtimeMs - 1), 'work')
  assert.equal(classify(bad, 4, 4), 'work', 'a failed record never grows')
  const noNl = buildRec(textOf([header('session-c'), assistantMsg(1, 5)]).trimEnd(), 5, 6)
  assert.equal(noNl.nl, false)
  assert.equal(noNl.nl, false)
  assert.equal(classify(noNl, 6, 6), 'work', 'base text has no line boundary at its end')
})
