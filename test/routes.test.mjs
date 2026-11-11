/**
 * 路由级宿主行为测试（/turns、/workspaces、archive 戳记、错误码、zstd 帧容错）。
 *
 * Fake cordis ctx + 临时 DSH_HOME（mkdtemp，绝不碰真实 ~/.dsh），与 global.test.mjs
 * 同一模式但不重复其用例（/list、/link、/unlink 的全局桶行为在那边）：
 * - GET /turns：handoff skill-invocation 轮次归属（开局 turns=0 跳过、同轮去重）、
 *   4000 字符裁剪（user/assistant 各测）、&turn=N 单轮、reasoning 兜底、撕裂行跳过
 * - GET /workspaces：多桶 count（只数 session- 前缀）/newest（mtime 最大）/cwd
 *   （取第一个可解析）与 newest 降序排序
 * - /list archive 戳记：无 workspaceRegistry 服务时走 ~/.dsh/storages/workspace.json
 *   的 durable 兜底；有服务时服务优先；parse 缓存不被污染（先 archive 后取消两次结果不同）
 * - 错误码：unknown 端点 404（method+path 进 params）
 * - zstd 帧容错（scanZstdFrames/decompressLog 的路由级行为）：合法帧 + 尾部垃圾、
 *   双帧拼接、截断帧、结构化 craft 帧（坏魔数/保留位/块遍历撕裂/校验和/坏窗口）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const { apply } = await import('../lib/index.js')

const BUCKET_A = '--alpha--'
const BUCKET_B = '--beta--'

/* ---- 会话文件与事件构造 ---- */

const header = (sid, extra = {}) => ({ type: 'session', id: sid, createdAt: 1000, ...extra })
const userMsg = (seq, time, text) => ({ type: 'user/message', seq, time, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const handoffCall = (seq, time) => ({ type: 'user/message', seq, time, data: { source: { kind: 'skill-invocation', name: 'handoff' } } })
const assistantMsg = (seq, time, blocks) => ({ type: 'assistant/message', seq, time, data: { message: { content: blocks } } })

/** 最小会话目录：JSONL 行 zstd 单帧压缩。 */
function writeSession(home, bucket, sid, lines) {
  const dir = join(home, 'sessions', bucket, sid)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n')))
}

/** 原始字节会话文件（zstd 帧容错 craft 用，不经压缩）。 */
function writeRaw(home, bucket, sid, buffer) {
  const dir = join(home, 'sessions', bucket, sid)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), buffer)
}

/** 精确设置会话文件 mtime（/workspaces newest 断言用）。 */
function setMtime(file, ms) {
  utimesSync(file, new Date(ms), new Date(ms))
}

/* ---- 装配与请求（同 global.test.mjs 模式；boot 可注入 ctx 附加成员） ---- */

function boot(home, ctxExtra = {}) {
  process.env.DSH_HOME = home
  const routes = []
  const ctx = {
    effect: (fn) => fn(),
    webServer: { register: (route) => routes.push(route) },
    logger: { info() {} },
    ...ctxExtra,
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

/* ---- /turns ---- */

test('/turns：handoff 调用按所在轮次归属（assistant 之后同轮仍算当轮）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stl-routes-'))
  try {
    writeSession(home, BUCKET_A, 'session-t01', [
      header('session-t01'),
      userMsg(1, 1100, 'q1'),
      handoffCall(2, 1200),
      assistantMsg(3, 1300, [{ type: 'text', text: 'a1' }]),
      handoffCall(4, 1400), // 第二条 user 之前 → 仍属第 1 轮
      userMsg(5, 2100, 'q2'),
      handoffCall(6, 2200),
      assistantMsg(7, 2300, [{ type: 'text', text: 'a2' }]),
    ])
    const handler = boot(home)
    const { code, data } = await call(handler, '/session-timeline/api/turns?session=session-t01')
    assert.equal(code, 200)
    assert.equal(data.ok, true)
    assert.equal(data.turns, 2)
    assert.equal(data.first.user, 'q1')
    assert.equal(data.last.user, 'q2')
    assert.deepEqual(data.handoffTurns.map((t) => t.turn), [1, 2])
    assert.equal(data.handoffTurns[0].user, 'q1')
    assert.equal(data.handoffTurns[0].assistant, 'a1')
    assert.equal(data.handoffTurns[1].user, 'q2')
    assert.equal(data.handoffTurns[1].assistant, 'a2')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('/turns：开局（无 user 消息）的 handoff 调用跳过；首条 user 前的 assistant 忽略', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stl-routes-'))
  try {
    writeSession(home, BUCKET_A, 'session-t02', [
      header('session-t02'),
      handoffCall(1, 1050), // turns=0 → 无轮次可挂，跳过
      assistantMsg(2, 1060, [{ type: 'text', text: 'early' }]), // 无 user → 整条忽略
      userMsg(3, 1100, 'q1'),
      assistantMsg(4, 1200, [{ type: 'text', text: 'a1' }]),
    ])
    const handler = boot(home)
    const { code, data } = await call(handler, '/session-timeline/api/turns?session=session-t02')
    assert.equal(code, 200)
    assert.equal(data.turns, 1)
    assert.deepEqual(data.handoffTurns, [])
    assert.equal(data.first.user, 'q1')
    assert.equal(data.first.assistant, 'a1')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('/turns：同轮多次 handoff 调用去重为一个轮次', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stl-routes-'))
  try {
    writeSession(home, BUCKET_A, 'session-t03', [
      header('session-t03'),
      userMsg(1, 1100, 'q1'),
      handoffCall(2, 1150),
      handoffCall(3, 1160),
      assistantMsg(4, 1200, [{ type: 'text', text: 'a1' }]),
    ])
    const handler = boot(home)
    const { code, data } = await call(handler, '/session-timeline/api/turns?session=session-t03')
    assert.equal(code, 200)
    assert.equal(data.turns, 1)
    assert.equal(data.handoffTurns.length, 1)
    assert.equal(data.handoffTurns[0].turn, 1)
    assert.equal(data.handoffTurns[0].user, 'q1')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('/turns：user 正文 4000 字符裁剪（>4000 裁、恰 4000 与短文不裁）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stl-routes-'))
  try {
    writeSession(home, BUCKET_A, 'session-t04', [header('session-t04'), userMsg(1, 1100, 'x'.repeat(4001))])
    writeSession(home, BUCKET_A, 'session-t05', [header('session-t05'), userMsg(1, 1100, 'y'.repeat(4000))])
    writeSession(home, BUCKET_A, 'session-t06', [header('session-t06'), userMsg(1, 1100, 'hi')])
    const handler = boot(home)
    const long = await call(handler, '/session-timeline/api/turns?session=session-t04')
    assert.equal(long.code, 200)
    assert.equal(long.data.first.user.length, 4000)
    assert.equal(long.data.first.userClipped, true)
    const exact = await call(handler, '/session-timeline/api/turns?session=session-t05')
    assert.equal(exact.data.first.user.length, 4000)
    assert.equal(exact.data.first.userClipped, false)
    const short = await call(handler, '/session-timeline/api/turns?session=session-t06')
    assert.equal(short.data.first.userClipped, false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('/turns：assistant 正文 4000 字符裁剪', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stl-routes-'))
  try {
    writeSession(home, BUCKET_A, 'session-t07', [
      header('session-t07'),
      userMsg(1, 1100, 'q'),
      assistantMsg(2, 1200, [{ type: 'text', text: 'z'.repeat(4501) }]),
    ])
    writeSession(home, BUCKET_A, 'session-t08', [
      header('session-t08'),
      userMsg(1, 1100, 'q'),
      assistantMsg(2, 1200, [{ type: 'text', text: 'short reply' }]),
    ])
    const handler = boot(home)
    const long = await call(handler, '/session-timeline/api/turns?session=session-t07')
    assert.equal(long.code, 200)
    assert.equal(long.data.last.assistant.length, 4000)
    assert.equal(long.data.last.assistantClipped, true)
    const short = await call(handler, '/session-timeline/api/turns?session=session-t08')
    assert.equal(short.data.last.assistant, 'short reply')
    assert.equal(short.data.last.assistantClipped, false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('/turns：assistant 无正文回退 reasoning（assistantReasoning 标记）；后续正式正文覆盖', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stl-routes-'))
  try {
    writeSession(home, BUCKET_A, 'session-t09', [
      header('session-t09'),
      userMsg(1, 1100, 'q1'),
      assistantMsg(2, 1200, [{ type: 'reasoning', text: 'thinking out loud' }]),
      assistantMsg(3, 1300, [{ type: 'text', text: 'formal reply' }]),
    ])
    writeSession(home, BUCKET_A, 'session-t10', [
      header('session-t10'),
      userMsg(1, 1100, 'q2'),
      assistantMsg(2, 1200, [{ type: 'reasoning', text: 'only reasoning here' }]),
    ])
    const handler = boot(home)
    const both = await call(handler, '/session-timeline/api/turns?session=session-t09')
    assert.equal(both.code, 200)
    assert.equal(both.data.last.assistant, 'formal reply')
    assert.equal(both.data.last.assistantClipped, false)
    // 修复后行为（2026-11-06）：正式正文覆盖 reasoning 兜底时旗标必须跟随内容
    // 复位——否则有正式回复的轮次仍被标成"推理"（修复前 set-once 的错误行为）。
    assert.equal(both.data.last.assistantReasoning, false)
    const reasoningOnly = await call(handler, '/session-timeline/api/turns?session=session-t10')
    assert.equal(reasoningOnly.data.last.assistant, 'only reasoning here')
    assert.equal(reasoningOnly.data.last.assistantReasoning, true)
    assert.equal(reasoningOnly.data.last.assistantClipped, undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('/turns：&turn=N 单轮查询（含 workspace 直连 / __global__ 扫描）；非法 turn 回全量', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stl-routes-'))
  try {
    writeSession(home, BUCKET_A, 'session-t11', [
      header('session-t11'),
      userMsg(1, 1100, 'q1'),
      assistantMsg(2, 1200, [{ type: 'text', text: 'a1' }]),
      userMsg(3, 2100, 'q2'),
      assistantMsg(4, 2200, [{ type: 'text', text: 'a2' }]),
    ])
    const handler = boot(home)
    const one = await call(handler, '/session-timeline/api/turns?session=session-t11&turn=2')
    assert.equal(one.code, 200)
    assert.equal(one.data.turns, 2)
    assert.equal(one.data.turn, 2)
    assert.equal(one.data.data.user, 'q2')
    assert.equal(one.data.data.assistant, 'a2')
    assert.equal('first' in one.data, false)
    const viaWorkspace = await call(handler, '/session-timeline/api/turns?session=session-t11&workspace=--alpha--&turn=1')
    assert.equal(viaWorkspace.data.turn, 1)
    assert.equal(viaWorkspace.data.data.user, 'q1')
    const viaGlobal = await call(handler, '/session-timeline/api/turns?session=session-t11&workspace=__global__')
    assert.equal(viaGlobal.code, 200)
    assert.equal(viaGlobal.data.turns, 2)
    assert.equal('first' in viaGlobal.data, true)
    const invalid = await call(handler, '/session-timeline/api/turns?session=session-t11&turn=99')
    assert.equal('turn' in invalid.data, false)
    assert.equal(invalid.data.first.user, 'q1')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('/turns：撕裂行与垃圾行跳过，不炸解析', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stl-routes-'))
  try {
    const dir = join(home, 'sessions', BUCKET_A, 'session-t12')
    mkdirSync(dir, { recursive: true })
    const lines = [
      JSON.stringify(header('session-t12')),
      '{"broken', // 垃圾行
      JSON.stringify(userMsg(1, 1100, 'q1')),
      JSON.stringify(assistantMsg(2, 1200, [{ type: 'text', text: 'a1' }])),
      '{"type":"assistant/message","seq":9,"time":900,"data":{"message":{"content":[{"type":"text","te', // 尾部截断行
    ]
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines.join('\n') + '\n')))
    const handler = boot(home)
    const { code, data } = await call(handler, '/session-timeline/api/turns?session=session-t12')
    assert.equal(code, 200)
    assert.equal(data.turns, 1)
    assert.equal(data.last.assistant, 'a1')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('/turns：空会话 turns=0', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stl-routes-'))
  try {
    writeSession(home, BUCKET_A, 'session-t13', [header('session-t13')])
    const handler = boot(home)
    const { code, data } = await call(handler, '/session-timeline/api/turns?session=session-t13')
    assert.equal(code, 200)
    assert.deepEqual(data, { ok: true, turns: 0, handoffTurns: [] })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('/turns：会话不存在 404 + sessionMissing（params.session）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stl-routes-'))
  try {
    writeSession(home, BUCKET_A, 'session-t14', [header('session-t14'), userMsg(1, 1100, 'hi')])
    const handler = boot(home)
    const { code, data } = await call(handler, '/session-timeline/api/turns?session=session-missing')
    assert.equal(code, 404)
    assert.equal(data.ok, false)
    assert.equal(data.code, 'sessionMissing')
    assert.equal(data.params.session, 'session-missing')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('/turns：非 zstd 会话文件 500 + decodeFailed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stl-routes-'))
  try {
    writeRaw(home, BUCKET_A, 'session-t15', Buffer.from('plain text, definitely not zstd'))
    const handler = boot(home)
    const { code, data } = await call(handler, '/session-timeline/api/turns?session=session-t15')
    assert.equal(code, 500)
    assert.equal(data.ok, false)
    assert.equal(data.code, 'decodeFailed')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('/turns：mtime+size 缓存——同 mtime 改内容（尺寸变）必取新值；mtime 前进再取新值', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stl-routes-'))
  try {
    writeSession(home, BUCKET_A, 'session-t16', [header('session-t16'), userMsg(1, 1100, '第一版')])
    const file = join(home, 'sessions', BUCKET_A, 'session-t16', 'session.v4.jsonl.zstd')
    const handler = boot(home)
    const v1 = await call(handler, '/session-timeline/api/turns?session=session-t16')
    assert.equal(v1.data.first.user, '第一版')
    // Same mtime, different content (different compressed size): size still
    // triggers a re-read — the cache must not hide content changes.
    const { mtimeMs } = statSync(file)
    writeSession(home, BUCKET_A, 'session-t16', [header('session-t16'), userMsg(1, 1100, '第二版·内容变长了一些')])
    utimesSync(file, new Date(mtimeMs), new Date(mtimeMs))
    const v2 = await call(handler, '/session-timeline/api/turns?session=session-t16')
    assert.equal(v2.data.first.user, '第二版·内容变长了一些')
    // mtime advance: another re-read, new content again.
    writeSession(home, BUCKET_A, 'session-t16', [header('session-t16'), userMsg(1, 1100, '第三版')])
    const v3 = await call(handler, '/session-timeline/api/turns?session=session-t16')
    assert.equal(v3.data.first.user, '第三版')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

/* ---- /workspaces ---- */

test('/workspaces：count 只数 session- 前缀、newest 含子会话、cwd 取第一个可解析、newest 降序', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stl-routes-'))
  try {
    const fileOf = (bucket, sid) => join(home, 'sessions', bucket, sid, 'session.v4.jsonl.zstd')
    writeSession(home, BUCKET_A, 'session-aaa1', [header('session-aaa1'), userMsg(1, 1100, 'hi')]) // 无 cwd 头
    writeSession(home, BUCKET_A, 'session-aaa2', [header('session-aaa2', { cwd: '/work/alpha-two' }), userMsg(1, 2100, 'hi')])
    writeSession(home, BUCKET_A, 'sess-child', [header('sess-child'), userMsg(1, 3100, 'hi')]) // 子代理命名，不计 count、无 cwd 头
    writeSession(home, BUCKET_B, 'session-bbb1', [header('session-bbb1', { cwd: '/work/beta' }), userMsg(1, 4100, 'hi')])
    mkdirSync(join(home, 'sessions', '--empty--', 'session-g1'), { recursive: true }) // 无会话文件 → 桶整体排除
    writeFileSync(join(home, 'sessions', 'stray.txt'), 'not a bucket') // 非目录项跳过
    setMtime(fileOf(BUCKET_A, 'session-aaa1'), 1000)
    setMtime(fileOf(BUCKET_A, 'session-aaa2'), 2000)
    setMtime(fileOf(BUCKET_A, 'sess-child'), 5000)
    setMtime(fileOf(BUCKET_B, 'session-bbb1'), 3000)
    const handler = boot(home)
    const { code, data } = await call(handler, '/session-timeline/api/workspaces')
    assert.equal(code, 200)
    assert.equal(data.ok, true)
    assert.deepEqual(data.workspaces.map((w) => w.bucket), [BUCKET_A, BUCKET_B]) // newest 降序：5000 > 3000
    const [alpha, beta] = data.workspaces
    assert.equal(alpha.sessions, 2) // 只数 session- 前缀；sess-child 不计
    assert.equal(alpha.newest, 5000) // newest 取桶内最大 mtime（含子会话）
    assert.equal(alpha.cwd, '/work/alpha-two') // 第一个可解析的 cwd（aaa1 无 cwd → 落到 aaa2）
    assert.equal(beta.sessions, 1)
    assert.equal(beta.newest, 3000)
    assert.equal(beta.cwd, '/work/beta')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

/* ---- /list archive 戳记 ---- */

function writeArchiveFile(home, ids) {
  const file = join(home, 'storages', 'workspace.json')
  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(file, JSON.stringify({ global: { archivedSessionIds: ids } }))
  return file
}

test('/list：无 workspaceRegistry 服务时走 durable 文件兜底，节点带 archived 标记', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stl-routes-'))
  try {
    writeArchiveFile(home, ['session-arc1'])
    writeSession(home, BUCKET_A, 'session-arc1', [header('session-arc1'), userMsg(1, 1100, 'hi')])
    writeSession(home, BUCKET_A, 'session-arc2', [header('session-arc2'), userMsg(1, 2100, 'hi')])
    const handler = boot(home) // ctx 无 get 方法 → 服务缺失，走 durable 兜底
    const { code, data } = await call(handler, `/session-timeline/api/list?workspace=${BUCKET_A}`)
    assert.equal(code, 200)
    assert.equal(data.sessions.length, 2)
    const byId = new Map(data.sessions.map((n) => [n.id, n]))
    assert.equal(byId.get('session-arc1').archived, true)
    assert.equal(byId.get('session-arc2').archived, false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('/list：workspaceRegistry 服务在场时优先于 durable 文件', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stl-routes-'))
  try {
    writeArchiveFile(home, ['session-arc1']) // durable 文件说 arc1 已归档
    writeSession(home, BUCKET_A, 'session-arc1', [header('session-arc1'), userMsg(1, 1100, 'hi')])
    writeSession(home, BUCKET_A, 'session-arc2', [header('session-arc2'), userMsg(1, 2100, 'hi')])
    const handler = boot(home, {
      get: (key) => (key === 'workspaceRegistry' ? { archivedSessionIds: ['session-arc2'] } : undefined),
    })
    const { code, data } = await call(handler, `/session-timeline/api/list?workspace=${BUCKET_A}`)
    assert.equal(code, 200)
    const byId = new Map(data.sessions.map((n) => [n.id, n]))
    assert.equal(byId.get('session-arc2').archived, true) // 服务优先
    assert.equal(byId.get('session-arc1').archived, false) // durable 文件不再参与
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('/list：先 archive 后取消，两次 /list 结果不同（parse 缓存不被污染）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stl-routes-'))
  try {
    const archiveFile = writeArchiveFile(home, ['session-arc1'])
    writeSession(home, BUCKET_A, 'session-arc1', [header('session-arc1'), userMsg(1, 1100, 'hi')])
    writeSession(home, BUCKET_A, 'session-arc2', [header('session-arc2'), userMsg(1, 2100, 'hi')])
    const handler = boot(home)
    const first = await call(handler, `/session-timeline/api/list?workspace=${BUCKET_A}`)
    assert.equal(first.data.sessions.find((n) => n.id === 'session-arc1').archived, true)
    // 取消归档：重写 durable 文件并强制 mtime 变化（会话文件本身不动 → parse 缓存必然命中）
    writeArchiveFile(home, [])
    setMtime(archiveFile, statSync(archiveFile).mtimeMs + 7000)
    const second = await call(handler, `/session-timeline/api/list?workspace=${BUCKET_A}`)
    assert.equal(second.data.sessions.find((n) => n.id === 'session-arc1').archived, false)
    assert.deepEqual(
      first.data.sessions.map((n) => [n.id, n.archived]),
      [['session-arc1', true], ['session-arc2', false]],
    )
    assert.deepEqual(
      second.data.sessions.map((n) => [n.id, n.archived]),
      [['session-arc1', false], ['session-arc2', false]],
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

/* ---- 错误码 ---- */

test('unknown 端点 404 + unknownEndpoint（method+path 进 params；方法不匹配同样 404）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stl-routes-'))
  try {
    writeSession(home, BUCKET_A, 'session-err1', [header('session-err1'), userMsg(1, 1100, 'hi')])
    const handler = boot(home)
    const nope = await call(handler, '/session-timeline/api/nope')
    assert.equal(nope.code, 404)
    assert.equal(nope.data.ok, false)
    assert.equal(nope.data.code, 'unknownEndpoint')
    assert.equal(nope.data.params.method, 'GET')
    assert.equal(nope.data.params.path, '/session-timeline/api/nope')
    const wrongMethod = await call(handler, '/session-timeline/api/list', 'POST')
    assert.equal(wrongMethod.code, 404)
    assert.equal(wrongMethod.data.code, 'unknownEndpoint')
    assert.equal(wrongMethod.data.params.method, 'POST')
    assert.equal(wrongMethod.data.params.path, '/session-timeline/api/list')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

/* ---- zstd 帧容错（scanZstdFrames / decompressLog 的路由级行为） ---- */

const FRAME_HEAD = [0x28, 0xb5, 0x2f, 0xfd] // zstd 魔数 LE
const HDR_NOFLAG = [...FRAME_HEAD, 0x00, 0x00] // 描述符 0x00 + 1 字节窗口描述符

test('zstd：合法帧后跟尾部垃圾 → 容忍撕裂帧，正常解析', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stl-routes-'))
  try {
    const dir = join(home, 'sessions', BUCKET_A, 'session-z01')
    mkdirSync(dir, { recursive: true })
    const lines = [JSON.stringify(header('session-z01')), JSON.stringify(userMsg(1, 1100, 'q1')), JSON.stringify(assistantMsg(2, 1200, [{ type: 'text', text: 'a1' }]))]
    const frame = zstdCompressSync(Buffer.from(lines.join('\n') + '\n'))
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([frame, Buffer.from('GARBAGE-TAIL-NOT-A-FRAME')]))
    const handler = boot(home)
    const { code, data } = await call(handler, '/session-timeline/api/turns?session=session-z01')
    assert.equal(code, 200)
    assert.equal(data.turns, 1)
    assert.equal(data.last.assistant, 'a1')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('zstd：双帧拼接 → 跨帧拼接解码，轮次完整', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stl-routes-'))
  try {
    const dir = join(home, 'sessions', BUCKET_A, 'session-z02')
    mkdirSync(dir, { recursive: true })
    const frameA = zstdCompressSync(Buffer.from([header('session-z02'), userMsg(1, 1100, 'q1')].map((l) => JSON.stringify(l)).join('\n') + '\n'))
    const frameB = zstdCompressSync(Buffer.from(JSON.stringify(assistantMsg(2, 1200, [{ type: 'text', text: 'a1' }])) + '\n'))
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([frameA, frameB]))
    const handler = boot(home)
    const { code, data } = await call(handler, '/session-timeline/api/turns?session=session-z02')
    assert.equal(code, 200)
    assert.equal(data.turns, 1)
    assert.equal(data.last.assistant, 'a1')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('zstd：截断帧（真实文件切半）→ 解码失败 500 decodeFailed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stl-routes-'))
  try {
    const dir = join(home, 'sessions', BUCKET_A, 'session-z03')
    mkdirSync(dir, { recursive: true })
    const lines = [JSON.stringify(header('session-z03')), JSON.stringify(userMsg(1, 1100, 'q1')), JSON.stringify(assistantMsg(2, 1200, [{ type: 'text', text: 'a1' }]))]
    const frame = zstdCompressSync(Buffer.from(lines.join('\n') + '\n'))
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), frame.subarray(0, Math.floor(frame.length / 2)))
    const handler = boot(home)
    const { code, data } = await call(handler, '/session-timeline/api/turns?session=session-z03')
    assert.equal(code, 500)
    assert.equal(data.code, 'decodeFailed')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('zstd：结构 craft 帧（坏魔数/保留位/头截断/块遍历撕裂）→ /list unreadable=1', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stl-routes-'))
  try {
    const crafts = {
      magicOnly4: [...FRAME_HEAD], // 仅魔数 → offset 越界
      magic2: [0x28, 0xb5], // 不足 4 字节
      reservedDescriptor: [...FRAME_HEAD, 0x18, 0x00], // 保留位非零
      singleSegmentHeaderTruncated: [...FRAME_HEAD, 0x20], // 缺 content size 字节
      walkUnder3Bytes: [...HDR_NOFLAG, 0x11, 0x22], // 块头不足 3 字节
      reservedBlockType: [...HDR_NOFLAG, 0x07, 0x00, 0x00], // blockType=3（保留）
      payloadShort: [...HDR_NOFLAG, 0x39, 0x1f, 0x00], // 块尺寸 999 > 剩余
      twoRawBlocks: [...HDR_NOFLAG, 0x08, 0x00, 0x00, 0xaa, 0x09, 0x00, 0x00, 0xbb], // 非 last → last 两块
    }
    for (const [label, bytes] of Object.entries(crafts)) {
      writeRaw(home, '--craft--', 'session-c-' + label, Buffer.from(bytes))
    }
    const handler = boot(home)
    const { code, data } = await call(handler, '/session-timeline/api/list?workspace=--craft--')
    assert.equal(code, 200)
    assert.equal(data.sessions.length, 0)
    assert.equal(data.unreadable, Object.keys(crafts).length)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('zstd：checksum 帧（尾部足 4 字节消费 / 不足则断）→ /list unreadable=1', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stl-routes-'))
  try {
    // 描述符 0x04 = checksum 位；窗口描述符 0x00；一块 raw last(size1)+校验和 4 字节
    writeRaw(home, '--craft--', 'session-c-chk-full', Buffer.from([...FRAME_HEAD, 0x04, 0x00, 0x09, 0x00, 0x00, 0xaa, 1, 2, 3, 4]))
    writeRaw(home, '--craft--', 'session-c-chk-short', Buffer.from([...FRAME_HEAD, 0x04, 0x00, 0x09, 0x00, 0x00, 0xaa])) // 校验和不足 4 字节
    const handler = boot(home)
    const { code, data } = await call(handler, '/session-timeline/api/list?workspace=--craft--')
    assert.equal(code, 200)
    assert.equal(data.sessions.length, 0)
    assert.equal(data.unreadable, 2)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('zstd：窗口描述符非法 → 帧完整但解码抛错 → 500 decodeFailed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stl-routes-'))
  try {
    // windowLog = 10 + (0xff >> 3) = 41 > zstd 上限 → scanZstdFrames 能圈出完整帧，解码必然抛错
    writeRaw(home, BUCKET_A, 'session-z04', Buffer.from([...FRAME_HEAD, 0x00, 0xff, 0x09, 0x00, 0x00, 0xaa]))
    const handler = boot(home)
    const { code, data } = await call(handler, '/session-timeline/api/turns?session=session-z04')
    assert.equal(code, 500)
    assert.equal(data.ok, false)
    assert.equal(data.code, 'decodeFailed')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
