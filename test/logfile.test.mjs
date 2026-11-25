/**
 * 会话日志文件布局（logfile.ts）单测：
 * - decodeLog：多帧一次解码 ≡ 逐帧解码拼接；尾随撕裂帧 / 垃圾字节被忽略；非 zstd、截断头 → null
 * - completeEnd：最后一个完整帧的结尾；无完整帧 → 0
 * - firstFrameText / lastFrameText：首帧 header、末帧末次活动（窗口不够 → null）
 * - 手工 craft 帧：RLE 块、保留块类型（撕裂）、保留描述位、仅魔数
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { ZSTD_MAGIC, completeEnd, decodeLog, firstFrameText, lastFrameText, scanZstdFrames } from '../lib/logfile.js'
import { assistantMsg, frame, header, jsonl, userMsg } from './fixtures.mjs'

const text = (n, start = 1) => Array.from({ length: n }, (_, i) => JSON.stringify(assistantMsg(start + i, 2000 + i)) + '\n').join('')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

test('decodeLog：多帧一次解码 ≡ 逐帧解码拼接（带/不带校验和，大小帧混排）', () => {
  const plain = (s) => zstdCompressSync(Buffer.from(s, 'utf8'))
  const parts = [
    frame(jsonl([header('session-a')])), // checksummed, as the harness writes
    plain(text(3)),
    frame(text(40000, 100)), // several MB decoded: multi-block frame
    plain(text(5000, 9)),
    frame(text(7, 40000)),
  ]
  const file = Buffer.concat(parts)
  const perFrame = Buffer.concat(scanZstdFrames(file).map((f) => zstdDecompressSync(file.subarray(f.start, f.end)))).toString('utf8')
  assert.equal(decodeLog(file), perFrame)
  assert.equal(completeEnd(file), file.length)
  assert.equal(scanZstdFrames(file).length, parts.length)
})

test('尾随撕裂帧 / 垃圾字节 / 截断：只解完整前缀', () => {
  const good = Buffer.concat([frame(jsonl([header('session-a')])), frame(text(5))])
  const torn = frame(text(9))
  const tornFile = Buffer.concat([good, torn.subarray(0, torn.length - 3)])
  assert.equal(completeEnd(tornFile), good.length)
  assert.equal(decodeLog(tornFile), decodeLog(good))

  const garbage = Buffer.concat([good, Buffer.from('trailing bytes that are no frame at all')])
  assert.equal(completeEnd(garbage), good.length)
  assert.equal(decodeLog(garbage), decodeLog(good))

  assert.equal(completeEnd(Buffer.alloc(0)), 0)
  assert.equal(decodeLog(Buffer.alloc(0)), null)
  assert.equal(decodeLog(Buffer.from('plain text log')), null)
  assert.equal(completeEnd(MAGIC.subarray(0, 2)), 0, 'truncated magic')
  assert.equal(completeEnd(MAGIC), 0, 'magic without descriptor')
  assert.equal(decodeLog(MAGIC), null)
  assert.equal(decodeLog(torn.subarray(0, 12)), null, 'header-truncated frame alone')
})

test('firstFrameText：首帧 header；头窗口不够 → null', () => {
  const head = frame(jsonl([header('session-a', { cwd: '/x' })]))
  const file = Buffer.concat([head, frame(text(200))])
  assert.equal(firstFrameText(file), jsonl([header('session-a', { cwd: '/x' })]))
  assert.equal(firstFrameText(head), jsonl([header('session-a', { cwd: '/x' })]))
  assert.equal(firstFrameText(head.subarray(0, head.length - 1)), null, 'first frame not complete inside the window')
  assert.equal(firstFrameText(Buffer.alloc(0)), null)
  assert.equal(firstFrameText(Buffer.concat([Buffer.from('junk'), head])), null, 'does not start at a frame')
  assert.equal(firstFrameText(Buffer.concat([head.subarray(0, 6)])), null, 'header-truncated')
})

test('lastFrameText：末帧文本；窗口里没有完整末帧 → null', () => {
  const f1 = frame(jsonl([header('session-a')]))
  const f2 = frame(text(300))
  const f3 = frame(jsonl([userMsg(99, 4242), assistantMsg(100, 4243)]))
  const file = Buffer.concat([f1, f2, f3])
  assert.equal(lastFrameText(file), jsonl([userMsg(99, 4242), assistantMsg(100, 4243)]))
  assert.equal(lastFrameText(file.subarray(f1.length)), jsonl([userMsg(99, 4242), assistantMsg(100, 4243)]))
  assert.equal(lastFrameText(f3), jsonl([userMsg(99, 4242), assistantMsg(100, 4243)]))
  assert.equal(lastFrameText(f3.subarray(0, f3.length - 1)), null, 'torn last frame')
  assert.equal(lastFrameText(file.subarray(0, file.length - 2)), null, 'earlier frames do not end at the file end')
  assert.equal(lastFrameText(file.subarray(f1.length + 5)), jsonl([userMsg(99, 4242), assistantMsg(100, 4243)]), 'window opens mid-frame')
  assert.equal(lastFrameText(file.subarray(file.length - 4)), null, 'window inside the last frame (no magic)')
  assert.equal(lastFrameText(Buffer.concat([file, MAGIC, Buffer.from([1, 2, 3])])), null, 'false magic after the last complete frame')
  assert.equal(lastFrameText(Buffer.concat([f3, Buffer.from([0x28, 0xb5, 0x2f, 0xfd])])), null)
  assert.equal(lastFrameText(Buffer.alloc(0)), null)
  assert.equal(lastFrameText(file.subarray(f1.length + f2.length - 3)), jsonl([userMsg(99, 4242), assistantMsg(100, 4243)]), 'window opens 3 bytes before the last frame')
  assert.equal(lastFrameText(file.subarray(f1.length, file.length - 1)), null, 'window starts at an earlier frame, the last one is torn')
})

test('craft 帧：RLE 块可解；保留块类型 / 保留描述位 / 头截断 → 停在该帧', () => {
  const rle = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x05, 43, 0, 0, 0x61]) // single segment, size 5, RLE block 'a'
  assert.equal(decodeLog(rle), 'aaaaa')
  assert.equal(ZSTD_MAGIC, 0xfd2fb528)
  const reservedBlock = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x05, 6, 0, 0]) // block type 3
  assert.deepEqual(scanZstdFrames(reservedBlock), [])
  assert.equal(completeEnd(Buffer.concat([frame('{}\n'), reservedBlock])), frame('{}\n').length, 'stops at the reserved block')
  const reservedBits = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x28, 0x05, 43, 0, 0, 0x61]) // descriptor bit 3
  assert.deepEqual(scanZstdFrames(reservedBits), [])
  const shortBlock = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x05, 43, 0]) // block header cut
  assert.deepEqual(scanZstdFrames(shortBlock), [])
  const cutChecksum = frame('hello\n')
  assert.deepEqual(scanZstdFrames(cutChecksum.subarray(0, cutChecksum.length - 2)), [], 'checksum truncated = torn')
})
