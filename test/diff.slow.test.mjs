/**
 * 常驻慢测试：old lib（git HEAD）vs new lib（工作树）差分对账。
 *
 * 设计意图：这不是常规单测，而是给未来任何 parse/geometry 重构的行为护栏。
 * old lib 在运行时从 `git archive HEAD lib` 解包到临时目录；HEAD 的 lib 已提交
 * 且与当前工作树 lib 一致，所以"现在跑必然 PASS"。一旦某次重构改变了 lib 的
 * 行为（先构建 lib 再跑本测试），首个差异的 label + 两侧输出前 400 字符会直接
 * 指出行为变化点。改码后请以本次构建的 lib 输出为准跑一次：PASS = 行为未变。
 *
 * 门：默认整个文件 skip（输出大、耗时分钟级），ST_DIFF=1 才执行：
 *   ST_DIFF=1 node --test test/diff.slow.test.mjs
 *
 * 两个段落：
 *  a) 真实日志段：会话存储（<DSH_HOME||~/.dsh>/sessions）下全部会话日志的
 *     parseLog/signatureLog 逐字节对比 + 每桶 inferForkParents 对比。
 *     会话根缺失/无日志、或系统无 zstd CLI 时本段 skip。
 *  b) 确定性随机段：固定种子 0x5eed1234 的 LCG 生成 400 组 computeLayout/
 *     nodeTop/computeLanesLayout、300 组 routeOrthogonal（含 occupied map）、
 *     200 组 routeEdgePath；不依赖会话存储，ST_DIFF=1 时总是跑。
 *
 * 差分逻辑（norm/check/LCG/zstd 容错解码/inferForkParents 输入组装）逐行照搬自
 * 一次性原型 .scratch/ubmode/diff.mjs，仅测试外壳（skip 门、临时目录、断言）不同。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const NEW = join(REPO, 'lib')
/* 会话根与产品一致（lib/index.js dshHomeDir）：DSH_HOME 是 .dsh 根，sessions 在其下。 */
const SESSIONS_ROOT = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
const ST_DIFF = process.env.ST_DIFF === '1'
const ST_DIFF_SKIP = '差分对账耗时分钟级，设 ST_DIFF=1 启用（ST_DIFF=1 node --test test/diff.slow.test.mjs）'

/* ---- old lib：git archive HEAD lib 解包到临时目录，两个段落共用，测试结束后清理 ---- */
let oldLibDir = null
let oldLib = null
async function extractOldLib() {
  if (oldLib) return oldLib
  oldLibDir = mkdtempSync(join(tmpdir(), 'st-diff-old-lib-'))
  const tar = execFileSync('git', ['archive', 'HEAD', 'lib'], { cwd: REPO, maxBuffer: 512 * 1024 * 1024 })
  execFileSync('tar', ['-x', '-C', oldLibDir], { input: tar, maxBuffer: 512 * 1024 * 1024 })
  const oldDir = join(oldLibDir, 'lib')
  oldLib = {
    oldParse: await import(join(oldDir, 'parse.js')),
    newParse: await import(join(NEW, 'parse.js')),
    oldInfer: await import(join(oldDir, 'lineage-infer.js')),
    newInfer: await import(join(NEW, 'lineage-infer.js')),
    oldLayout: await import(join(oldDir, 'geometry/layout.js')),
    newLayout: await import(join(NEW, 'geometry/layout.js')),
    oldLanes: await import(join(oldDir, 'geometry/lanes.js')),
    newLanes: await import(join(NEW, 'geometry/lanes.js')),
    oldRouting: await import(join(oldDir, 'geometry/routing.js')),
    newRouting: await import(join(NEW, 'geometry/routing.js')),
  }
  return oldLib
}
after(() => {
  if (oldLibDir) rmSync(oldLibDir, { recursive: true, force: true })
})

/* ---- 差分逻辑（照搬原型）：Map/对象按排序键序列化后逐字节对比 ---- */
function norm(v) {
  if (v instanceof Map) {
    return { __map: [...v.entries()].map(([k, x]) => [k, norm(x)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) }
  }
  if (Array.isArray(v)) return v.map(norm)
  if (v && typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = norm(v[k])
    return out
  }
  return v
}

function makeChecker(section) {
  let diffs = 0
  let first = null
  function check(label, a, b, input) {
    const ja = JSON.stringify(norm(a))
    const jb = JSON.stringify(norm(b))
    if (ja === jb) return true
    diffs += 1
    if (!first) first = { label, ja, jb, input }
    if (diffs <= 5) {
      console.error(`DIFF ${label}\n old: ${ja.slice(0, 400)}\n new: ${jb.slice(0, 400)}`)
      if (input) console.error(` INPUT ${JSON.stringify(input)}`)
    }
    return false
  }
  return {
    check,
    get diffs() { return diffs },
    failMessage() {
      const f = first
      const lines = [
        `${section}：${diffs} 处差异，首个差异 ${f.label}`,
        ` old: ${f.ja.slice(0, 400)}`,
        ` new: ${f.jb.slice(0, 400)}`,
      ]
      if (f.input) lines.push(` INPUT ${JSON.stringify(f.input)}`)
      return lines.join('\n')
    },
  }
}

/* ---- zstd 容错解码（照搬原型）：失败时用已产出的 stdout（撕裂尾帧） ---- */
function decode(file) {
  try {
    return execFileSync('zstd', ['-dc', file], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8')
  } catch (e) {
    return e.stdout ? e.stdout.toString('utf8') : ''
  }
}
function hasZstd() {
  const r = spawnSync('zstd', ['-V'], { encoding: 'utf8' })
  return !r.error && r.status === 0
}

/* ---- 真实日志收集（照搬原型）：sessions/<bucket>/<sid>/session.v4.jsonl.zstd ---- */
function collectSessionFiles() {
  const files = []
  let buckets
  try { buckets = readdirSync(SESSIONS_ROOT) } catch { return files }
  for (const bucket of buckets) {
    let sids
    try { sids = readdirSync(join(SESSIONS_ROOT, bucket)) } catch { continue }
    for (const sid of sids) {
      const file = join(SESSIONS_ROOT, bucket, sid, 'session.v4.jsonl.zstd')
      try { readFileSync(file); files.push({ bucket, sid, file }) } catch { /* not a session dir */ }
    }
  }
  return files
}

test('真实日志差分：parseLog/signatureLog 逐字节 + 每桶 inferForkParents（old lib vs new lib）', { skip: ST_DIFF ? false : ST_DIFF_SKIP }, async (t) => {
  if (!hasZstd()) return t.skip('系统无 zstd CLI，无法解码会话日志')
  const files = collectSessionFiles()
  if (files.length === 0) return t.skip(`会话存储缺失或为空：${SESSIONS_ROOT}`)
  const { oldParse, newParse, oldInfer, newInfer } = await extractOldLib()
  const real = makeChecker('真实日志段')

  for (const { bucket, sid, file } of files) {
    const text = decode(file)
    real.check(`parseLog ${bucket}/${sid}`, oldParse.parseLog(text), newParse.parseLog(text))
    real.check(`signatureLog ${bucket}/${sid}`, oldParse.signatureLog(text), newParse.signatureLog(text))
  }

  /* inferForkParents on the real buckets (same node-shape rule as the host) */
  const byBucket = new Map()
  for (const { bucket, sid, file } of files) {
    const text = decode(file)
    const p = newParse.parseLog(text)
    if (p === null || !sid.startsWith('session-')) continue
    const list = byBucket.get(bucket) ?? []
    list.push({ id: sid, parent: p.parent, forkMarkerSeq: p.forkMarkerSeq, logCreatedAt: p.createdAt, text })
    byBucket.set(bucket, list)
  }
  for (const [bucket, nodes] of byBucket) {
    const sigs = new Map(nodes.map((n) => [n.id, newParse.signatureLog(n.text)]))
    const args = [nodes.map(({ text, ...n }) => n), (id) => sigs.get(id) ?? null]
    real.check(`inferForkParents ${bucket}`, oldInfer.inferForkParents(...args), newInfer.inferForkParents(...args))
  }

  t.diagnostic(`真实日志：${files.length} 个会话、${byBucket.size} 个桶`)
  if (real.diffs !== 0) assert.fail(real.failMessage())
})

test('确定性随机差分：computeLayout/nodeTop/computeLanesLayout/routeOrthogonal/routeEdgePath（种子 0x5eed1234）', { skip: ST_DIFF ? false : ST_DIFF_SKIP }, async (t) => {
  const { oldLayout, newLayout, oldLanes, newLanes, oldRouting, newRouting } = await extractOldLib()
  const rnd = makeChecker('随机段')

  /* Deterministic random differential for geometry (same inputs, both implementations) */
  let seed = 0x5eed1234
  function next() {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 0x100000000
  }
  function pick(n) { return Math.floor(next() * n) }

  function randGraph() {
    const n = pick(9)
    const nodes = Array.from({ length: n }, (_, i) => ({ id: 'n' + i, createdAt: 1 + pick(30), extra: i }))
    const edges = []
    const links = []
    for (let i = 0; i < n; i += 1) {
      if (n > 1 && next() < 0.35) edges.push({ from: 'n' + pick(n), to: 'n' + i })
      if (n > 1 && next() < 0.35) links.push({ from: 'n' + pick(n), to: 'n' + i })
    }
    return { nodes, edges, links }
  }

  for (let i = 0; i < 400; i += 1) {
    const { nodes, edges, links } = randGraph()
    const oldL = oldLayout.computeLayout(nodes, edges, links)
    const newL = newLayout.computeLayout(nodes, edges, links)
    rnd.check(`computeLayout ${i}`, oldL, newL)
    rnd.check(`nodeTop ${i}`, nodes.map((n) => oldLayout.nodeTop(oldL, n.id)), nodes.map((n) => newLayout.nodeTop(newL, n.id)))
    const laneOf = (n) => 'lane' + (Number(n.id.slice(1)) % 3)
    const collapsed = next() < 0.4 ? new Set(['lane1']) : undefined
    rnd.check(`computeLanesLayout ${i}`, oldLanes.computeLanesLayout(nodes, edges, links, laneOf, collapsed), newLanes.computeLanesLayout(nodes, edges, links, laneOf, collapsed))
  }

  for (let i = 0; i < 300; i += 1) {
    const obstacleCount = pick(5)
    const obstacles = Array.from({ length: obstacleCount }, () => ({ x: pick(400) - 50, y: pick(300) - 50, w: 10 + pick(120), h: 10 + pick(100) }))
    const sx = pick(500) - 50; const sy = pick(400) - 50
    const tx = pick(500) - 50; const ty = pick(400) - 50
    const corridors = Array.from({ length: pick(3) }, () => pick(600) - 100)
    const m1 = new Map(); const m2 = new Map()
    const input = { obstacles, sx, sy, tx, ty, corridors }
    const a = oldRouting.routeOrthogonal(obstacles, sx, sy, tx, ty, m1, corridors)
    const b = newRouting.routeOrthogonal(obstacles, sx, sy, tx, ty, m2, corridors)
    rnd.check(`routeOrthogonal ${i}`, a, b, input)
    rnd.check(`routeOrthogonal occupied ${i}`, m1, m2, input)
  }

  for (let i = 0; i < 200; i += 1) {
    const { nodes, edges, links } = randGraph()
    if (nodes.length === 0) continue
    const oldL = oldLayout.computeLayout(nodes, edges, links)
    const newL = newLayout.computeLayout(nodes, edges, links)
    const obstacles = nodes.map((n) => ({
      x: oldLayout.colX(oldL, n.id) - oldLayout.NODE_W / 2 - 2,
      y: oldLayout.nodeTop(oldL, n.id) - 2,
      w: oldLayout.NODE_W + 4,
      h: oldLayout.NODE_H + 4,
    }))
    const from = nodes[0].id
    const to = nodes[nodes.length - 1].id
    const step = pick(3)
    const m1 = new Map(); const m2 = new Map()
    rnd.check(
      `routeEdgePath ${i}`,
      oldRouting.routeEdgePath({ layout: oldL, obstacles, occupied: m1, from, to, step }),
      newRouting.routeEdgePath({ layout: newL, obstacles, occupied: m2, from, to, step }),
    )
  }

  t.diagnostic('随机段：layout/lanes 400 + routeOrthogonal 300 + routeEdgePath 200')
  if (rnd.diffs !== 0) assert.fail(rnd.failMessage())
})
