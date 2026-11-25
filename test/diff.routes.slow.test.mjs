/**
 * 路由级新旧差分守卫（真实会话库；ST_DIFF=1 才跑）——加载策略改造的验收门槛。
 *
 * 旧实现 = `git archive <ST_OLD_REV|HEAD> lib`（或 ST_OLD_LIB 目录）；新实现 = 工作树 lib。
 * 逐条路由比较稳定响应（不再带 partial）是否逐字节相等：
 *   /list?workspace=<每个工作区>、__global__、/list?session=<id>、/workspaces
 * 三种情形：A worker 线程（冷启动 → 轮询到稳定）；B 内联构建（workers: 0）；
 *           C 主机重启后（在 A 落盘的索引上起全新实例）。
 * 会话库是活的（别的会话还在追加）：只在比对前后会话文件 size+mtime 一致的那一轮下结论，最多 6 轮。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NEW_LIB = join(ROOT, 'lib')
const API = '/session-timeline/api'
const SESSION_FILE = 'session.v4.jsonl.zstd'
const ROUNDS = 6

/** 会话库指纹（size+mtime）：比对期间库没变，比较才有结论。 */
function snapshot(sessions) {
  const out = []
  for (const bucket of readdirSync(sessions)) {
    const dir = join(sessions, bucket)
    if (!statSync(dir).isDirectory()) continue
    for (const sid of readdirSync(dir)) {
      const file = join(dir, sid, SESSION_FILE)
      if (!existsSync(file)) continue
      const s = statSync(file)
      out.push(bucket + '/' + sid + ':' + s.size + ':' + s.mtimeMs)
    }
  }
  return out.join('\n')
}

async function boot(lib, storage, workers) {
  const mod = await import(pathToFileURL(join(lib, 'index.js')).href)
  const routes = []
  const disposers = []
  const ctx = {
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
    get: () => undefined,
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    logger: { info() {} },
  }
  mod.apply(ctx, mod.Config({ storage_dir: storage, ...(workers === undefined ? {} : { workers }) }))
  return { handler: routes[0].handler, dispose: () => { for (const d of disposers.reverse()) d() } }
}

async function call(handler, url) {
  const started = performance.now()
  let text = ''
  const res = { writeHead: () => {}, end: (chunk) => { text += chunk ?? '' } }
  await handler({ url, method: 'GET', on: () => {} }, res)
  return { text, data: JSON.parse(text), ms: performance.now() - started }
}

/** 首个响应耗时 + 稳定响应文本。 */
async function settled(handler, url) {
  const started = performance.now()
  const first = await call(handler, url)
  let last = first
  for (let i = 0; i < 4000 && last.data.partial === true; i += 1) {
    await sleep(10)
    last = await call(handler, url)
  }
  assert.notEqual(last.data.partial, true, url + ': never settled')
  return { text: last.text, firstMs: first.ms, totalMs: performance.now() - started }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 库在整轮比对中未变才算数。 */
async function stableRound(sessions, run) {
  for (let round = 1; round <= ROUNDS; round += 1) {
    const before = snapshot(sessions)
    const out = await run()
    if (snapshot(sessions) === before) return out
    await sleep(200)
  }
  return null
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) return 'offset ' + i + '\n  old: …' + a.slice(Math.max(0, i - 60), i + 60) + '\n  new: …' + b.slice(Math.max(0, i - 60), i + 60)
  }
  return a.length === b.length ? '' : 'length ' + a.length + ' vs ' + b.length
}

test('路由差分：真实会话库上新旧实现的 /list、/workspaces 逐字节相等', { skip: process.env.ST_DIFF === '1' ? false : 'set ST_DIFF=1' }, async (t) => {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const sessions = join(home, 'sessions')
  if (!existsSync(sessions)) { t.skip('no session store at ' + sessions); return }
  const work = mkdtempSync(join(tmpdir(), 'st-diff-'))
  const instances = []
  t.after(() => {
    for (const i of instances) i.dispose()
    rmSync(work, { recursive: true, force: true })
  })

  // old implementation
  let oldLib = process.env.ST_OLD_LIB
  if (oldLib === undefined) {
    const old = join(work, 'old')
    mkdirSync(old)
    execFileSync('git', ['-C', ROOT, 'archive', '--format=tar', '-o', join(work, 'old.tar'), process.env.ST_OLD_REV ?? 'HEAD', 'lib'])
    execFileSync('tar', ['-xf', join(work, 'old.tar'), '-C', old])
    oldLib = join(old, 'lib')
    symlinkSync(join(ROOT, 'node_modules'), join(old, 'node_modules'), 'dir')
  }
  assert.equal(existsSync(join(oldLib, 'worker.js')), false, 'the old implementation already contains the new loader: point ST_OLD_REV at the commit before the change')

  // storage dirs in tmp with the real manual-link docs (the session store itself is only read)
  const linkDocs = join(home, 'session-timeline')
  const storage = (name) => {
    const dir = join(work, 'storage-' + name)
    mkdirSync(dir)
    if (existsSync(linkDocs)) {
      for (const f of readdirSync(linkDocs, { withFileTypes: true })) if (f.isFile() && f.name.endsWith('.json')) cpSync(join(linkDocs, f.name), join(dir, f.name))
    }
    return dir
  }
  const start = async (lib, store, workers) => { const i = await boot(lib, store, workers); instances.push(i); return i }

  const buckets = readdirSync(sessions, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  const routes = buckets.map((b) => API + '/list?workspace=' + encodeURIComponent(b))
  routes.push(API + '/list?workspace=__global__', API + '/workspaces')
  const bySession = buckets.map((b) => readdirSync(join(sessions, b)).find((s) => s.startsWith('session-'))).find((s) => s !== undefined)
  if (bySession !== undefined) routes.push(API + '/list?session=' + encodeURIComponent(bySession))

  const oldI = await start(oldLib, storage('old'))
  const newStore = storage('new') // shared by the worker instance and its restart
  const newI = await start(NEW_LIB, newStore)
  const inlineI = await start(NEW_LIB, storage('inline'), 0)

  const failures = []
  const timings = []
  let unstable = 0
  for (const route of routes) {
    const out = await stableRound(sessions, async () => {
      const o = await call(oldI.handler, route)
      const a = await settled(newI.handler, route)
      const b = await settled(inlineI.handler, route)
      return { o, a, b }
    })
    if (out === null) { unstable += 1; continue }
    timings.push([route.slice((API + '/list?workspace=').length), Math.round(out.o.ms), Math.round(out.a.firstMs), Math.round(out.a.totalMs)])
    for (const [name, r] of [['worker', out.a], ['inline', out.b]]) {
      if (r.text !== out.o.text) failures.push(route + ' [' + name + ']: ' + firstDiff(out.o.text, r.text))
    }
  }
  // restart: a fresh host over the index the worker instance flushed
  newI.dispose()
  const restartI = await start(NEW_LIB, newStore)
  const restartMs = []
  for (const route of routes) {
    const first = await call(restartI.handler, route)
    restartMs.push(first.ms)
    const out = await stableRound(sessions, async () => ({ o: await call(oldI.handler, route), c: await settled(restartI.handler, route) }))
    if (out === null) { unstable += 1; continue }
    if (out.c.text !== out.o.text) failures.push(route + ' [restart]: ' + firstDiff(out.o.text, out.c.text))
  }
  restartMs.sort((x, y) => x - y)
  const slowest = timings.filter(([, o]) => o > 500).map(([b, o, f, s]) => '    ' + b.slice(0, 40).padEnd(40) + ' old ' + o + ' ms → first ' + f + ' ms, settled ' + s + ' ms')
  t.diagnostic('routes ' + routes.length + ', unstable ' + unstable + '; cold first response max ' + Math.max(...timings.map((r) => r[2])).toFixed(1) +
    ' ms; after restart first response median ' + restartMs[Math.floor(restartMs.length / 2)].toFixed(1) + ' ms, max ' + restartMs.at(-1).toFixed(1) + ' ms')
  for (const line of slowest) t.diagnostic(line)
  assert.deepEqual(failures, [])
})
