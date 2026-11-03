/**
 * 全局画布（workspace=__global__）宿主行为测试。
 *
 * Fake cordis ctx + 临时 DSH_HOME（两个桶各含最小 zstd 会话日志）：
 * - GET /list?workspace=__global__ 聚合两桶节点（bucket 字段在列）+ 每桶原生边
 * - POST /link 全局桶：同桶对 → 写入该桶账本；storage 里不产生 __global__.json
 * - POST /link 全局桶：跨桶对 → 400 + code=crossWorkspace
 * - POST /link 全局桶：未知会话 → 400 + code=sessionNotInBucket
 * - POST /unlink 全局桶：按端点解析桶并删除
 *
 * 会话文件用 node:zlib 的 zstdCompressSync 生成单帧 zstd（host 端 scanZstdFrames +
 * zstdDecompressSync 可解）；日志最小形态 = header（type=session）+ 一条真实用户消息。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const { apply } = await import('../lib/index.js')

const BUCKET_A = '--alpha--'
const BUCKET_B = '--beta--'

/** 最小会话目录：header + 一条真实用户消息，zstd 单帧压缩。 */
function writeSession(home, bucket, sid, { createdAt, userAt, parent = null }) {
  const dir = join(home, 'sessions', bucket, sid)
  mkdirSync(dir, { recursive: true })
  const header = { type: 'session', id: sid, createdAt }
  if (parent !== null) header.parentSession = parent
  const lines = [
    JSON.stringify(header),
    JSON.stringify({ type: 'user/message', seq: 1, time: userAt, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } }),
  ]
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines.join('\n') + '\n')))
}

/** 装配插件并返回捕获的 prefix 路由 handler。 */
function boot(home) {
  process.env.DSH_HOME = home
  const routes = []
  const ctx = {
    effect: (fn) => fn(),
    webServer: { register: (route) => routes.push(route) },
    logger: { info() {} },
  }
  apply(ctx, { storage_dir: join(home, 'tl-storage') })
  assert.equal(routes.length, 1)
  return routes[0].handler
}

function request(url, method = 'GET', body = '') {
  return {
    url,
    method,
    on(ev, cb) {
      if (ev === 'data' && body !== '') cb(body)
      if (ev === 'end') cb()
    },
  }
}

async function call(handler, url, method = 'GET', body = '') {
  let code = 0
  let raw = ''
  await handler(request(url, method, body), {
    writeHead: (c) => { code = c },
    end: (b) => { raw = String(b ?? '') },
  })
  return { code, data: JSON.parse(raw) }
}

test('全局桶 /list 聚合所有工作区节点与每桶原生边', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stl-global-'))
  try {
    writeSession(home, BUCKET_A, 'session-aaa1', { createdAt: 1000, userAt: 1100 })
    writeSession(home, BUCKET_A, 'session-aaa2', { createdAt: 2000, userAt: 2100, parent: 'session-aaa1' })
    writeSession(home, BUCKET_B, 'session-bbb1', { createdAt: 3000, userAt: 3100 })
    const handler = boot(home)
    const { code, data } = await call(handler, '/session-timeline/api/list?workspace=__global__')
    assert.equal(code, 200)
    assert.equal(data.ok, true)
    assert.equal(data.bucket, '__global__')
    assert.equal(data.sessions.length, 3)
    for (const n of data.sessions) assert.ok(typeof n.bucket === 'string' && n.bucket.startsWith('--'), 'node carries its bucket')
    assert.deepEqual(data.edges, [{ from: 'session-aaa1', to: 'session-aaa2', kind: 'handoff' }])
    assert.deepEqual(data.manualLinks, [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('全局桶 /link：同桶对写入该桶账本，不产生 __global__.json', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stl-global-'))
  try {
    writeSession(home, BUCKET_B, 'session-bbb1', { createdAt: 1000, userAt: 1100 })
    writeSession(home, BUCKET_B, 'session-bbb2', { createdAt: 2000, userAt: 2100 })
    const handler = boot(home)
    const storage = join(home, 'tl-storage')
    const { code, data } = await call(handler, '/session-timeline/api/link', 'POST',
      JSON.stringify({ workspace: '__global__', from: 'session-bbb1', to: 'session-bbb2' }))
    assert.equal(code, 200)
    assert.equal(data.ok, true)
    assert.equal(data.from, 'session-bbb1')
    assert.equal(data.to, 'session-bbb2')
    const doc = JSON.parse(readFileSync(join(storage, BUCKET_B + '.json'), 'utf8'))
    assert.deepEqual(doc.links, [{ from: 'session-bbb1', to: 'session-bbb2', created_at: doc.links[0].created_at }])
    assert.equal(existsSync(join(storage, '__global__.json')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('全局桶 /link：跨桶对 400 + crossWorkspace', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stl-global-'))
  try {
    writeSession(home, BUCKET_A, 'session-aaa1', { createdAt: 1000, userAt: 1100 })
    writeSession(home, BUCKET_B, 'session-bbb1', { createdAt: 2000, userAt: 2100 })
    const handler = boot(home)
    const { code, data } = await call(handler, '/session-timeline/api/link', 'POST',
      JSON.stringify({ workspace: '__global__', from: 'session-aaa1', to: 'session-bbb1' }))
    assert.equal(code, 400)
    assert.equal(data.ok, false)
    assert.equal(data.code, 'crossWorkspace')
    assert.equal(existsSync(join(home, 'tl-storage', '__global__.json')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('全局桶 /link：未知会话 400 + sessionNotInBucket', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stl-global-'))
  try {
    writeSession(home, BUCKET_A, 'session-aaa1', { createdAt: 1000, userAt: 1100 })
    const handler = boot(home)
    const { code, data } = await call(handler, '/session-timeline/api/link', 'POST',
      JSON.stringify({ workspace: '__global__', from: 'session-aaa1', to: 'session-zzz9' }))
    assert.equal(code, 400)
    assert.equal(data.ok, false)
    assert.equal(data.code, 'sessionNotInBucket')
    assert.equal(data.params.session, 'session-zzz9')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('全局桶 /unlink：按端点解析桶并删除', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stl-global-'))
  try {
    writeSession(home, BUCKET_A, 'session-aaa1', { createdAt: 1000, userAt: 1100 })
    writeSession(home, BUCKET_A, 'session-aaa2', { createdAt: 2000, userAt: 2100 })
    const handler = boot(home)
    const storage = join(home, 'tl-storage')
    // 先经全局桶建立，再经全局桶断开
    const linked = await call(handler, '/session-timeline/api/link', 'POST',
      JSON.stringify({ workspace: '__global__', from: 'session-aaa1', to: 'session-aaa2' }))
    assert.equal(linked.code, 200)
    const removed = await call(handler, '/session-timeline/api/unlink', 'POST',
      JSON.stringify({ workspace: '__global__', from: 'session-aaa1', to: 'session-aaa2' }))
    assert.equal(removed.code, 200)
    assert.equal(removed.data.removed, 1)
    const doc = JSON.parse(readFileSync(join(storage, BUCKET_A + '.json'), 'utf8'))
    assert.deepEqual(doc.links, [])
    assert.equal(existsSync(join(storage, '__global__.json')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
