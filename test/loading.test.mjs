/**
 * 加载策略（路由级）测试。DSH_HOME 指向临时目录，存储目录也在临时目录里。
 * T1 worker 线程冷启动：先回 partial + 骨架，轮询到稳定后与「内联构建」逐字节相等
 * T2 重启后走持久索引：不再读会话文件内容（首帧之后的字节全毁也照样返回）
 * T3 增量合并：追加一帧后只读首尾，结果 ≡「干净副本 + 同样追加」的整日志构建
 * T4 候选会话签名超过 SIG_CAP（被截断）时，fork 亲缘认证走整日志解码，结论不变
 * T5 worker 起不来 → 回退内联构建（不比现状差）
 * T9 同长度改写（仅 mtime 变）→ 先回旧记录，再回重建结果
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SIG_CAP } from '../lib/record.js'
import { scanZstdFrames } from '../lib/logfile.js'
import { SESSION_FILE, appendFrame, assistantMsg, endSeed, handoffCall, header, sessionFile, setMtime, titleEvent, userMsg, writeLog } from './fixtures.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const LIB = new URL('../lib/index.js', import.meta.url)
const B = '--w--'
const API = '/session-timeline/api'
const LIST = API + '/list?workspace=' + B
const T0 = 1700000000000

/** 起一个插件实例：收集 effect 的 disposer，返回路由 handler 与 dispose()。 */
async function boot(moduleUrl, config) {
  const mod = await import(moduleUrl)
  const routes = []
  const disposers = []
  const ctx = {
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
    get: () => undefined,
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    logger: { info() {} },
  }
  mod.apply(ctx, mod.Config(config))
  return { handler: routes[0].handler, dispose: () => { for (const d of disposers.reverse()) d() } }
}

async function call(handler, url) {
  const status = { code: 200 }
  let text = ''
  const res = { writeHead: (code) => { status.code = code }, end: (chunk) => { text += chunk ?? '' } }
  await handler({ url, method: 'GET', on: () => {} }, res)
  return { code: status.code, text, data: JSON.parse(text) }
}

/** 轮询到稳定响应（不再带 partial）。 */
async function settled(handler, url) {
  const first = await call(handler, url)
  let last = first
  for (let i = 0; i < 2000 && last.data.partial === true; i += 1) {
    await new Promise((r) => setTimeout(r, 5))
    last = await call(handler, url)
  }
  return { first, last }
}

/** 临时 DSH_HOME；每个实例一个存储目录（同名 = 共用索引）。 */
function scratch(t) {
  const home = mkdtempSync(join(tmpdir(), 'st-loading-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const instances = []
  t.after(() => {
    for (const i of instances) i.dispose()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  })
  return {
    home,
    tmpdir: () => {
      const dir = mkdtempSync(join(tmpdir(), 'st-loading-extra-'))
      t.after(() => rmSync(dir, { recursive: true, force: true }))
      return dir
    },
    start: async (opts = {}) => {
      const url = opts.lib ? pathToFileURL(join(opts.lib, 'index.js')) : LIB
      // DSH_HOME is read when the plugin applies: another home only for this boot
      const outer = process.env.DSH_HOME
      process.env.DSH_HOME = opts.home ?? home
      let i
      try {
        i = await boot(url, { storage_dir: join(opts.home ?? home, 'tl-' + (opts.store ?? 'a')), ...(opts.workers === undefined ? {} : { workers: opts.workers }) })
      } finally {
        process.env.DSH_HOME = outer
      }
      instances.push(i)
      return i
    },
  }
}

const LOG_OLD = [[header('session-old')], [userMsg(1, 1010), titleEvent(2, 1020, 'old title'), handoffCall(3, 1030), assistantMsg(4, 1040)]]
const LOG_MID = [[header('session-mid')], [assistantMsg(1, 1510), assistantMsg(2, 1520)]]
const LOG_NEW = [[header('session-new')], [userMsg(1, 2010), titleEvent(2, 2020, 'new title'), assistantMsg(3, 2030)]]

test('T1 worker 线程冷启动：先回 partial + 骨架，稳定后与内联构建逐字节相等', async (t) => {
  const { home, start } = scratch(t)
  writeLog(home, B, 'session-old', LOG_OLD)
  writeLog(home, B, 'session-mid', LOG_MID)
  writeLog(home, B, 'session-new', LOG_NEW)
  writeLog(home, B, 'agent-child-1', [[header('agent-child-1')], [assistantMsg(1, 9000)]])
  const workers = await start({ store: 'workers' })
  const inline = await start({ store: 'inline', workers: 0 })

  const { first, last } = await settled(workers.handler, LIST)
  assert.equal(first.data.partial, true)
  assert.equal(first.data.build.total, 3, 'one build per session without a record')
  assert.ok(first.data.build.done < first.data.build.total, 'the first response does not wait for the builds')
  assert.equal(first.data.unreadable, 0)
  assert.deepEqual(first.data.sessions.map((n) => [n.id, n.title, n.lastAt]), [
    ['session-old', null, 1040], ['session-mid', null, 1520], ['session-new', null, 2030],
  ], 'skeleton: header fields + last activity from the last frame, no title')
  assert.equal(last.data.partial, undefined)
  assert.equal(last.data.build, undefined)

  const ref = await call(inline.handler, LIST)
  assert.equal(ref.data.partial, undefined)
  assert.equal(last.text, ref.text, 'settled worker response === inline response (bytes)')
  assert.deepEqual(last.data.sessions.map((n) => n.title), ['old title', null, 'new title'])
  assert.deepEqual(last.data.sessions[0].handoffHits, [{ seq: 3, at: 1030, turn: 1 }])

  const globalWorkers = await settled(workers.handler, API + '/list?workspace=__global__')
  const globalInline = await call(inline.handler, API + '/list?workspace=__global__')
  assert.equal(globalWorkers.last.text, globalInline.text)

  const workspaces = await call(workers.handler, API + '/workspaces')
  assert.equal(workspaces.data.workspaces.length, 1)
  assert.equal(workspaces.data.workspaces[0].sessions, 3, 'child sessions are not counted')

  workers.dispose()
  const index = JSON.parse(readFileSync(join(home, 'tl-workers', 'index', B + '.json'), 'utf8'))
  assert.deepEqual(Object.keys(index.recs).sort(), ['session-mid', 'session-new', 'session-old'])
  assert.equal(index.recs['session-old'].title, 'old title')
})

test('T2 重启后走持久索引：不再读会话文件内容', async (t) => {
  const { home, start } = scratch(t)
  for (const [sid, log] of [['session-old', LOG_OLD], ['session-mid', LOG_MID], ['session-new', LOG_NEW]]) {
    writeLog(home, B, sid, log)
    setMtime(sessionFile(home, B, sid), T0)
  }
  const a = await start({ workers: 0 })
  const ref = await call(a.handler, LIST)
  a.dispose()

  // everything after the first frame is destroyed; size and mtime stay
  const file = sessionFile(home, B, 'session-new')
  const size = statSync(file).size
  const buf = readFileSync(file)
  const [, body] = scanZstdFrames(buf)
  buf.fill(0, body.start + 8, body.end)
  writeFileSync(file, buf)
  setMtime(file, T0)
  assert.equal(statSync(file).size, size)

  const b = await start({ workers: 0 })
  assert.equal((await call(b.handler, LIST)).text, ref.text, 'same answer from the index alone')

  // discrimination: really reading the destroyed file cannot get that answer
  const fresh = await start({ workers: 0, store: 'fresh' })
  const rebuilt = await call(fresh.handler, LIST)
  assert.equal(rebuilt.data.unreadable, 1)
  assert.deepEqual(rebuilt.data.sessions.map((n) => n.id), ['session-old', 'session-mid'])
  assert.notEqual(rebuilt.text, ref.text)
})

test('T3 增量合并：追加一帧后只读首尾，结果 ≡ 干净副本 + 同样追加', async (t) => {
  const { home, start, tmpdir } = scratch(t)
  const refHome = tmpdir()
  const file = writeLog(home, B, 'session-s', [[header('session-s')], [userMsg(1, 10), titleEvent(2, 11, 't1')], [assistantMsg(3, 12), assistantMsg(4, 13)]])
  const refFile = join(refHome, 'sessions', B, 'session-s', SESSION_FILE)
  mkdirSync(join(refHome, 'sessions', B, 'session-s'), { recursive: true })
  cpSync(file, refFile)
  setMtime(file, T0)
  setMtime(refFile, T0)

  const a = await start({ workers: 0 })
  await call(a.handler, LIST)
  a.dispose()

  // the middle frame of the indexed file is destroyed (the merge path never reads it again)
  const buf = readFileSync(file)
  const frames = scanZstdFrames(buf)
  buf.fill(0, frames[1].start + 8, frames[1].end)
  writeFileSync(file, buf)
  const more = [titleEvent(5, 14, 't2'), userMsg(6, 15)]
  appendFrame(file, more)
  appendFrame(refFile, more)
  setMtime(file, T0 + 60000)
  setMtime(refFile, T0 + 60000)
  assert.equal(statSync(file).size, statSync(refFile).size)

  const merged = await start({ workers: 0 })
  const got = await call(merged.handler, LIST)
  assert.equal(got.data.sessions[0].title, 't2')
  assert.deepEqual(got.data.sessions[0].handoffHits, [])
  const reference = await start({ workers: 0, home: refHome, store: 'ref' })
  assert.equal(got.text, (await call(reference.handler, LIST)).text)

  // discrimination: a full read of the destroyed file cannot get there
  const fresh = await start({ workers: 0, store: 'fresh' })
  const rebuilt = await call(fresh.handler, LIST)
  assert.equal(rebuilt.data.unreadable, 1)
  assert.equal(rebuilt.data.sessions.length, 0)
})

test('T4 候选会话签名超过 SIG_CAP 被截断：fork 亲缘认证改读整日志，结论不变', async (t) => {
  const { home, start, tmpdir } = scratch(t)
  const cut = SIG_CAP + 944
  const events = (n) => Array.from({ length: n }, (_, i) => (i % 5 === 0 ? userMsg(i + 1, 10000 + i) : assistantMsg(i + 1, 10000 + i)))
  const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size))
  const parentEvents = events(cut + 4000)
  writeLog(home, B, 'session-p', [[header('session-p')], ...chunks(parentEvents, 8000)])
  writeLog(home, B, 'session-c', [[header('session-c')], ...chunks(parentEvents.slice(0, cut), 8000), [endSeed(cut, 9999999, true), userMsg(cut + 1, 9999999)]])
  writeLog(home, B, 'session-x', [[header('session-x')], [assistantMsg(1, 5)]])
  const forked = (list) => {
    const child = list.sessions.find((n) => n.id === 'session-c')
    return [child.parent, child.parentSource, list.edges]
  }

  const app = await start({ workers: 0 })
  assert.deepEqual(forked((await call(app.handler, LIST)).data), ['session-p', 'inferred', [{ from: 'session-p', to: 'session-c', kind: 'branch' }]])

  // the same with signatures that fit the cap: decided from the indexed signatures
  const small = tmpdir()
  writeLog(small, B, 'session-p', [[header('session-p')], ...chunks(parentEvents.slice(0, 50), 20)])
  writeLog(small, B, 'session-c', [[header('session-c')], ...chunks(parentEvents.slice(0, 30), 20), [endSeed(30, 8888888, true), userMsg(31, 8888888)]])
  const smallApp = await start({ workers: 0, home: small, store: 'small' })
  assert.deepEqual(forked((await call(smallApp.handler, LIST)).data), ['session-p', 'inferred', [{ from: 'session-p', to: 'session-c', kind: 'branch' }]])
})

test('T5 worker 起不来 → 回退内联构建', async (t) => {
  const { home, start, tmpdir } = scratch(t)
  writeLog(home, B, 'session-old', LOG_OLD)
  writeLog(home, B, 'session-mid', LOG_MID)
  const lib = join(tmpdir(), 'lib')
  cpSync(join(ROOT, 'lib'), lib, { recursive: true })
  writeFileSync(join(lib, 'worker.js'), "throw new Error('worker is broken')\n")
  symlinkSync(join(ROOT, 'node_modules'), join(lib, '..', 'node_modules'), 'dir')

  const broken = await start({ store: 'broken', lib })
  const inline = await start({ store: 'inline', workers: 0 })
  const { first, last } = await settled(broken.handler, LIST)
  assert.equal(first.data.partial, true)
  assert.equal(last.data.partial, undefined)
  assert.equal(last.text, (await call(inline.handler, LIST)).text)

  // after the crash the pool stays out of the way: the next cold bucket is built inline
  writeLog(home, '--cold--', 'session-new', LOG_NEW)
  const cold = API + '/list?workspace=--cold--'
  assert.equal((await call(broken.handler, cold)).data.partial, true, 'a build is still announced first')
  const coldDone = await settled(broken.handler, cold)
  assert.equal(coldDone.last.data.sessions[0].title, 'new title')
})

test('T9 同长度改写（仅 mtime 变）：先回旧记录，再回重建结果', async (t) => {
  const { home, start } = scratch(t)
  const file = writeLog(home, B, 'session-s', [[header('session-s')], [titleEvent(1, 10, 'aaa')]])
  setMtime(file, T0)
  const a = await start({ workers: 0 })
  await call(a.handler, LIST)
  a.dispose()

  const size = statSync(file).size
  writeLog(home, B, 'session-s', [[header('session-s')], [titleEvent(1, 10, 'bbb')]])
  setMtime(file, T0 + 1000)
  assert.equal(statSync(file).size, size, 'same length, only the mtime moved')
  const workers = await start({})
  const { first, last } = await settled(workers.handler, LIST)
  assert.equal(first.data.partial, true)
  assert.equal(first.data.sessions[0].title, 'aaa', 'stale record until the rebuild lands')
  assert.equal(last.data.sessions[0].title, 'bbb')
  const inline = await start({ store: 'inline', workers: 0 })
  assert.equal(last.text, (await call(inline.handler, LIST)).text)
})
