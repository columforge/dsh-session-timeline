/**
 * @dsh-external/session-timeline — 会话时间线（右栏页签）。
 * Host 侧：扫描 ~/.dsh/sessions/<bucket>/<sessionId>/session.v4.jsonl.zstd，
 * 提取 header（createdAt / parentSession / isSeeded / cwd）、最后一条
 * session/title 标题、以及首末对话是否调用过 handoff skill
 * （user/message + source.kind=skill-invocation + name=handoff）。
 * 顶层会话（id 带 session- 前缀）作为时间线节点；parentSession 指向桶内
 * 顶层会话构成原生边——父会话单子 = handoff 衔接，多子 = 分支。
 * 手工拖拽衔接按工作区隔离存 ~/.dsh/session-timeline/<bucket>.json。
 * API（/session-timeline/api）：
 *   GET  /workspaces?session=…      工作区清单（桶）
 *   GET  /list?session=…&workspace=…  节点 + 原生边 + 手工衔接
 *   POST /link   { session?, workspace?, from, to }
 *   POST /unlink { session?, workspace?, from, to }
 */
import type { Context } from 'cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import z from 'schemastery'

export const name = '@dsh-external/session-timeline'
export const inject = ['webServer']

export interface Config {
  /** 手工衔接存储根目录；空 = <DSH_HOME>/session-timeline */
  storage_dir: string
}

export const Config = z.object({
  storage_dir: z.string().default(''),
})

/** 时间线节点（顶层会话）。 */
export interface SessionNode {
  id: string
  title: string | null
  createdAt: number
  /** header.parentSession 原文（可能指向桶外/已删除会话） */
  parent: string | null
  /** header.isSeeded：以 handoff 上下文种子开場 */
  seeded: boolean
  /** 首条真实用户消息内容含 handoff 文档引用（handoff 新会话判据） */
  handoffSeed: boolean
  cwd: string | null
  /** 所属工作区（会话存储桶） */
  bucket: string
  /** 最后活动时间（日志末事件 time）；时间线定位/显示用它 */
  lastAt: number
  /** 首个对话内调用过 handoff skill */
  handoffFirst: boolean
  /** 最后一个对话内调用过 handoff skill */
  handoffLast: boolean
}

/** 原生边：handoff（父单子，链式衔接）/ branch（父多子，分叉）。 */
export interface NativeEdge {
  from: string
  to: string
  kind: 'handoff' | 'branch'
}

/** 手工衔接（from = 创建较早一方，语义“to 衔接自 from”）。 */
export interface ManualLink {
  from: string
  to: string
  created_at: string
}

/** 工作区（会话存储桶）摘要。 */
export interface WorkspaceInfo {
  bucket: string
  cwd: string | null
  sessions: number
  /** 桶内最新会话文件 mtime（epoch ms） */
  newest: number
}

interface Doc {
  version: 1
  links: ManualLink[]
}

const SESSION_FILE = 'session.v4.jsonl.zstd'
const TITLE_MARK = '"type":"session/title"'
const USER_MSG_MARK = '"type":"user/message"'
const HANDOFF_MARK = '"kind":"skill-invocation","name":"handoff"'
const ZSTD_MAGIC = 0xFD2FB528
/** 全局时间线哨兵桶名（/list?workspace=__global__ 聚合所有工作区）。 */
export const GLOBAL_BUCKET = '__global__'

/* ---- zstd 帧扫描（口径同 harness session-persistence-jsonl，容忍尾部撕裂帧） ---- */

interface FrameRange { start: number; end: number }

function scanZstdFrames(buffer: Buffer): FrameRange[] {
  const frames: FrameRange[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break
    offset += 4
    if (offset >= buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) break
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    let torn = false
    for (;;) {
      if (buffer.length - offset < 3) { torn = true; break }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) { torn = true; break }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) { torn = true; break }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (torn) break
    if (checksum) {
      if (buffer.length - offset < 4) break
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

function decompressLog(buffer: Buffer): string | null {
  const frames = scanZstdFrames(buffer)
  if (frames.length === 0) return null
  try {
    const parts: Buffer[] = []
    for (const f of frames) parts.push(zstdDecompressSync(buffer.subarray(f.start, f.end)))
    return Buffer.concat(parts).toString('utf8')
  } catch {
    return null
  }
}

interface ParsedLog {
  createdAt: number
  /** 日志末事件 time（最后活动） */
  lastAt: number
  parent: string | null
  seeded: boolean
  title: string | null
  cwd: string | null
  /** 首条真实用户消息内容含 handoff 文档引用（handoff 新会话判据） */
  handoffSeed: boolean
  handoffFirst: boolean
  handoffLast: boolean
}

function parseLog(text: string): ParsedLog | null {
  const nl = text.indexOf('\n')
  if (nl <= 0) return null
  let header: unknown
  try { header = JSON.parse(text.slice(0, nl)) } catch { return null }
  const hd = header as { type?: unknown; id?: unknown; createdAt?: unknown; parentSession?: unknown; isSeeded?: unknown; cwd?: unknown }
  if (hd?.type !== 'session' || typeof hd.id !== 'string') return null

  let title: string | null = null
  let idx = text.indexOf(TITLE_MARK)
  while (idx >= 0) {
    const lineStart = text.lastIndexOf('\n', idx - 1) + 1
    let lineEnd = text.indexOf('\n', idx)
    if (lineEnd < 0) lineEnd = text.length
    try {
      const ev = JSON.parse(text.slice(lineStart, lineEnd)) as { data?: { title?: unknown } }
      if (typeof ev?.data?.title === 'string' && ev.data.title.trim() !== '') title = ev.data.title
    } catch { /* 撕裂/损坏行跳过 */ }
    idx = text.indexOf(TITLE_MARK, idx + TITLE_MARK.length)
  }

  /* 轮次窗口：真实用户消息（source.kind=user）分隔；handoff skill 调用 =
   * user/message + source{kind:skill-invocation,name:handoff}。首窗口 = 第二条
   * 真实用户消息之前；末窗口 = 最后一条真实用户消息之后。
   * handoff 新会话判据：首条真实用户消息文本含 handoff 文档引用（含
   * handoff 字样即命中，如“读 handoff 文档”“handoff-xxx.md”）。 */
  const userPos: number[] = []
  let firstUserText: string | null = null
  let u = text.indexOf(USER_MSG_MARK)
  while (u >= 0) {
    const lineStart = text.lastIndexOf('\n', u - 1) + 1
    let lineEnd = text.indexOf('\n', u)
    if (lineEnd < 0) lineEnd = text.length
    try {
      const raw = text.slice(lineStart, lineEnd)
      const ev = JSON.parse(raw) as { type?: unknown; data?: { source?: { kind?: unknown }; content?: { type?: unknown; text?: unknown }[] } }
      if (ev?.type === 'user/message' && ev?.data?.source?.kind === 'user') {
        userPos.push(u)
        if (firstUserText === null && Array.isArray(ev.data.content)) {
          const joined = ev.data.content
            .filter((c) => c?.type === 'text' && typeof c.text === 'string')
            .map((c) => String(c.text))
            .join(' ')
          if (joined.trim() !== '') firstUserText = joined
        }
      }
    } catch { /* 跳过 */ }
    u = text.indexOf(USER_MSG_MARK, u + USER_MSG_MARK.length)
  }
  const handoffSeed = firstUserText !== null && firstUserText.toLowerCase().includes('handoff')

  /* 最后活动时间：从日志末尾向前找第一条可解析且带 time 的事件（容忍撕裂尾行） */
  let lastAt = typeof hd.createdAt === 'number' ? hd.createdAt : 0
  {
    let pos = text.length
    for (let guard = 0; guard < 64 && pos > 0; guard += 1) {
      const lineEnd = pos
      const lineStart = text.lastIndexOf('\n', pos - 2) + 1
      pos = lineStart > 0 ? lineStart - 1 : 0
      const raw = text.slice(lineStart, lineEnd).trim()
      if (raw === '' || !raw.includes('"time"')) continue
      try {
        const ev = JSON.parse(raw) as { time?: unknown }
        if (typeof ev.time === 'number' && ev.time > 0) { lastAt = ev.time; break }
      } catch { /* 撕裂/截断行继续向前 */ }
    }
  }

  let handoffFirst = false
  let handoffLast = false
  let hh = text.indexOf(HANDOFF_MARK)
  if (hh >= 0) {
    const firstEnd = userPos.length >= 2 ? userPos[1] : Number.MAX_SAFE_INTEGER
    const lastStart = userPos.length >= 1 ? userPos[userPos.length - 1] : 0
    while (hh >= 0) {
      if (hh < firstEnd) handoffFirst = true
      if (hh >= lastStart) handoffLast = true
      hh = text.indexOf(HANDOFF_MARK, hh + HANDOFF_MARK.length)
    }
  }

  return {
    createdAt: typeof hd.createdAt === 'number' ? hd.createdAt : 0,
    lastAt,
    parent: typeof hd.parentSession === 'string' && hd.parentSession !== '' ? hd.parentSession : null,
    seeded: hd.isSeeded === true,
    title,
    cwd: typeof hd.cwd === 'string' ? hd.cwd : null,
    handoffSeed,
    handoffFirst,
    handoffLast,
  }
}

/* ---- 会话桶扫描（mtime+size 缓存） ---- */

interface CacheEntry { mtimeMs: number; size: number; node: SessionNode | null; cwd: string | null }

function dshHomeDir(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 工作区路径 → 会话存储桶同款编码：/a/b → --a-b--（与 decisions-tracker 一致） */
export function encodeBucket(workspacePath: string): string {
  const clean = workspacePath.replace(/\/+$/, '').replace(/^\//, '')
  return '--' + clean.replaceAll('/', '-') + '--'
}

function loadDoc(root: string, bucket: string): { doc: Doc; error: string | null } {
  try {
    const file = join(root, bucket + '.json')
    if (!existsSync(file)) return { doc: { version: 1, links: [] }, error: null }
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Doc>
    if (!Array.isArray(parsed.links)) return { doc: { version: 1, links: [] }, error: '存储文件 links 字段缺失，已按空账处理' }
    return { doc: { version: 1, links: parsed.links as ManualLink[] }, error: null }
  } catch (e) {
    return { doc: { version: 1, links: [] }, error: '存储文件读取失败：' + String(e).slice(0, 120) }
  }
}

function saveDoc(root: string, bucket: string, doc: Doc): string | null {
  try {
    mkdirSync(root, { recursive: true })
    const file = join(root, bucket + '.json')
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
    return null
  } catch (e) {
    return '存储文件写入失败：' + String(e).slice(0, 120)
  }
}

export function apply(ctx: Context, config: Config): void {
  const root = config.storage_dir.trim() !== ''
    ? config.storage_dir
    : join(dshHomeDir(), 'session-timeline')
  const sessionsRoot = join(dshHomeDir(), 'sessions')
  mkdirSync(root, { recursive: true })

  /** 会话 → bucket（扫会话存储桶，正例缓存；与 decisions-tracker 同法） */
  const bucketCache = new Map<string, string>()
  const sessionBucket = (sessionId: string): string | null => {
    const hit = bucketCache.get(sessionId)
    if (hit !== undefined) return hit
    try {
      for (const ent of readdirSync(sessionsRoot, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue
        if (existsSync(join(sessionsRoot, ent.name, sessionId))) {
          bucketCache.set(sessionId, ent.name)
          return ent.name
        }
      }
    } catch { /* 会话根不可读按未定位处理 */ }
    return null
  }

  /** 单个会话文件 → 节点/目录信息（mtime+size 缓存）。 */
  const parseCache = new Map<string, CacheEntry>()
  const parseSessionDir = (bucket: string, sid: string): CacheEntry => {
    const file = join(sessionsRoot, bucket, sid, SESSION_FILE)
    let st
    try { st = statSync(file) } catch { return { mtimeMs: 0, size: 0, node: null, cwd: null } }
    const cached = parseCache.get(sid)
    if (cached !== undefined && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached
    let entry: CacheEntry = { mtimeMs: st.mtimeMs, size: st.size, node: null, cwd: null }
    try {
      const text = decompressLog(readFileSync(file))
      const parsed = text === null ? null : parseLog(text)
      if (parsed !== null) {
        entry = {
          mtimeMs: st.mtimeMs,
          size: st.size,
          cwd: parsed.cwd,
          node: sid.startsWith('session-')
            ? {
                id: sid,
                title: parsed.title,
                createdAt: parsed.createdAt,
                lastAt: parsed.lastAt,
                parent: parsed.parent,
                seeded: parsed.seeded,
                handoffSeed: parsed.handoffSeed,
                cwd: parsed.cwd,
                bucket,
                handoffFirst: parsed.handoffFirst,
                handoffLast: parsed.handoffLast,
              }
            : null,
        }
      }
    } catch { /* 单个会话文件损坏不拖垮整表 */ }
    parseCache.set(sid, entry)
    return entry
  }

  /** 桶内节点扫描（只保留顶层会话节点）。 */
  const listBucketNodes = (bucket: string): { nodes: SessionNode[]; unreadable: number } => {
    const nodes: SessionNode[] = []
    let unreadable = 0
    let ents
    try { ents = readdirSync(join(sessionsRoot, bucket), { withFileTypes: true }) } catch { return { nodes, unreadable } }
    for (const ent of ents) {
      if (!ent.isDirectory()) continue
      const e = parseSessionDir(bucket, ent.name)
      if (e.node !== null) nodes.push(e.node)
      else if (ent.name.startsWith('session-') && e.mtimeMs !== 0) unreadable += 1
    }
    nodes.sort((a, b) => a.lastAt - b.lastAt)
    return { nodes, unreadable }
  }

  /** 原生边：父单子 = handoff 衔接；父多子 = 分支。 */
  const nativeEdges = (nodes: SessionNode[]): NativeEdge[] => {
    const byId = new Set(nodes.map((n) => n.id))
    const childCount = new Map<string, number>()
    for (const n of nodes) {
      if (n.parent !== null && byId.has(n.parent)) childCount.set(n.parent, (childCount.get(n.parent) ?? 0) + 1)
    }
    const out: NativeEdge[] = []
    for (const n of nodes) {
      if (n.parent === null || !byId.has(n.parent)) continue
      out.push({ from: n.parent, to: n.id, kind: (childCount.get(n.parent) ?? 0) >= 2 ? 'branch' : 'handoff' })
    }
    return out
  }

  /** 工作区清单：桶名 + cwd（解析每桶一个会话头，缓存）+ 会话数 + 最新 mtime。 */
  const listWorkspaces = (): WorkspaceInfo[] => {
    const out: WorkspaceInfo[] = []
    let buckets
    try { buckets = readdirSync(sessionsRoot, { withFileTypes: true }) } catch { return out }
    for (const b of buckets) {
      if (!b.isDirectory()) continue
      let count = 0
      let newest = 0
      let sids: string[] = []
      try {
        sids = readdirSync(join(sessionsRoot, b.name), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
      } catch { continue }
      for (const sid of sids) {
        try {
          const st = statSync(join(sessionsRoot, b.name, sid, SESSION_FILE))
          count += 1
          if (st.mtimeMs > newest) newest = st.mtimeMs
        } catch { /* 无会话文件的目录不计 */ }
      }
      if (count === 0) continue
      let cwd: string | null = null
      for (const sid of sids) {
        const e = parseSessionDir(b.name, sid)
        if (e.cwd !== null) { cwd = e.cwd; break }
      }
      out.push({ bucket: b.name, cwd, sessions: count, newest })
    }
    out.sort((a, b2) => b2.newest - a.newest)
    return out
  }

  /* ---- 面板 API ---- */

  const json = (res: {
    writeHead: (code: number, headers: Record<string, string>) => unknown
    end: (body?: string) => unknown
  }, code: number, payload: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }

  const readBody = (req: { on: (ev: string, cb: (chunk: unknown) => void) => void }): Promise<string> =>
    new Promise((resolve) => {
      let body = ''
      req.on('data', (chunk: unknown) => { body += String(chunk) })
      req.on('end', () => resolve(body))
      req.on('error', () => resolve(body))
    })

  /** 定位工作区：workspace 参数（桶名）优先，缺省用 session 参数定位；__global__ = 全桶聚合。 */
  const locate = (workspace: string | null, sessionId: string | null): { bucket: string; error: null } | { bucket: null; error: string } => {
    if (workspace !== null && workspace.trim() !== '') {
      const bucket = workspace.trim()
      if (bucket === GLOBAL_BUCKET) return { bucket, error: null }
      if (!existsSync(join(sessionsRoot, bucket))) {
        return { bucket: null, error: '工作区 ' + bucket + ' 不存在（桶不可读）' }
      }
      return { bucket, error: null }
    }
    if (sessionId === null || sessionId.trim() === '') {
      return { bucket: null, error: '缺 session/workspace 参数' }
    }
    const bucket = sessionBucket(sessionId.trim())
    if (bucket === null) return { bucket: null, error: '会话 ' + sessionId + ' 不在任何工作区存储桶' }
    return { bucket, error: null }
  }

  /** 全局聚合：所有桶的节点 + 各桶内血缘边 + 各桶手工衔接（桶内血缘不跨桶）。 */
  const listGlobalNodes = (): { nodes: SessionNode[]; edges: NativeEdge[]; links: ManualLink[]; unreadable: number } => {
    const nodes: SessionNode[] = []
    const edges: NativeEdge[] = []
    const links: ManualLink[] = []
    let unreadable = 0
    let buckets: string[] = []
    try {
      buckets = readdirSync(sessionsRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch { /* 根不可读返回空 */ }
    for (const b of buckets) {
      const r = listBucketNodes(b)
      nodes.push(...r.nodes)
      unreadable += r.unreadable
      edges.push(...nativeEdges(r.nodes))
      const doc = loadDoc(root, b)
      if (doc.error === null) links.push(...doc.doc.links)
    }
    nodes.sort((a, b2) => a.lastAt - b2.lastAt)
    return { nodes, edges, links, unreadable }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/session-timeline/api',
    handler: async (req, res) => {
      const pathname = (req.url ?? '').split('?')[0]
      const query = new URL('http://x/' + (req.url ?? '')).searchParams

      if (pathname === '/session-timeline/api/workspaces' && req.method === 'GET') {
        json(res, 200, { ok: true, workspaces: listWorkspaces() })
        return
      }

      if (pathname === '/session-timeline/api/list' && req.method === 'GET') {
        const located = locate(query.get('workspace'), query.get('session'))
        if (located.error !== null) { json(res, 400, { ok: false, error: located.error }); return }
        if (located.bucket === GLOBAL_BUCKET) {
          const g = listGlobalNodes()
          json(res, 200, {
            ok: true,
            bucket: GLOBAL_BUCKET,
            unreadable: g.unreadable,
            sessions: g.nodes,
            edges: g.edges,
            manualLinks: g.links,
          })
          return
        }
        const { nodes, unreadable } = listBucketNodes(located.bucket)
        const doc = loadDoc(root, located.bucket)
        if (doc.error !== null) { json(res, 500, { ok: false, error: doc.error }); return }
        json(res, 200, {
          ok: true,
          bucket: located.bucket,
          unreadable,
          sessions: nodes,
          edges: nativeEdges(nodes),
          manualLinks: doc.doc.links,
        })
        return
      }

      if (pathname === '/session-timeline/api/link' && req.method === 'POST') {
        let body: Record<string, unknown> = {}
        try { body = JSON.parse(await readBody(req)) as Record<string, unknown> } catch { /* 空体按缺参处理 */ }
        const located = locate(
          typeof body.workspace === 'string' ? body.workspace : null,
          typeof body.session === 'string' ? body.session : null,
        )
        if (located.error !== null) { json(res, 400, { ok: false, error: located.error }); return }
        const from = typeof body.from === 'string' ? body.from.trim() : ''
        const to = typeof body.to === 'string' ? body.to.trim() : ''
        if (from === '' || to === '') { json(res, 400, { ok: false, error: 'from/to 不能为空' }); return }
        if (from === to) { json(res, 400, { ok: false, error: '不能与自己衔接' }); return }
        const { nodes } = listBucketNodes(located.bucket)
        const byId = new Map(nodes.map((n) => [n.id, n]))
        const a = byId.get(from)
        const b = byId.get(to)
        if (a === undefined || b === undefined) {
          json(res, 400, { ok: false, error: 'from/to 必须是该工作区的顶层会话' })
          return
        }
        for (const e of nativeEdges(nodes)) {
          if ((e.from === from && e.to === to) || (e.from === to && e.to === from)) {
            json(res, 409, { ok: false, error: '两会话已存在原生血缘（' + (e.kind === 'branch' ? '分支' : 'handoff') + '），无需手工连线' })
            return
          }
        }
        // 方向 = 拖拽语义：from = 落点节点（前驱/父），to = 被拖节点（后继/子），
        // 与原生血缘（parent → child）同向；不做创建时间归一
        const doc = loadDoc(root, located.bucket)
        if (doc.error !== null) { json(res, 500, { ok: false, error: doc.error }); return }
        const dup = doc.doc.links.some((l) => (l.from === from && l.to === to) || (l.from === to && l.to === from))
        if (dup) { json(res, 200, { ok: true, duplicate: true }); return }
        doc.doc.links.push({ from, to, created_at: new Date().toISOString() })
        const err = saveDoc(root, located.bucket, doc.doc)
        if (err !== null) { json(res, 500, { ok: false, error: err }); return }
        json(res, 200, { ok: true, from, to })
        return
      }

      if (pathname === '/session-timeline/api/unlink' && req.method === 'POST') {
        let body: Record<string, unknown> = {}
        try { body = JSON.parse(await readBody(req)) as Record<string, unknown> } catch { /* 空体按缺参处理 */ }
        const located = locate(
          typeof body.workspace === 'string' ? body.workspace : null,
          typeof body.session === 'string' ? body.session : null,
        )
        if (located.error !== null) { json(res, 400, { ok: false, error: located.error }); return }
        const from = typeof body.from === 'string' ? body.from.trim() : ''
        const to = typeof body.to === 'string' ? body.to.trim() : ''
        if (from === '' || to === '') { json(res, 400, { ok: false, error: 'from/to 不能为空' }); return }
        const doc = loadDoc(root, located.bucket)
        if (doc.error !== null) { json(res, 500, { ok: false, error: doc.error }); return }
        const before = doc.doc.links.length
        doc.doc.links = doc.doc.links.filter((l) => !((l.from === from && l.to === to) || (l.from === to && l.to === from)))
        const removed = before - doc.doc.links.length
        if (removed > 0) {
          const err = saveDoc(root, located.bucket, doc.doc)
          if (err !== null) { json(res, 500, { ok: false, error: err }); return }
        }
        json(res, 200, { ok: true, removed })
        return
      }

      if (pathname === '/session-timeline/api/turns' && req.method === 'GET') {
        const sid = (query.get('session') ?? '').trim()
        const ws = query.get('workspace')
        let dir: string | null = null
        if (ws !== null && ws.trim() !== '' && ws !== GLOBAL_BUCKET) {
          dir = join(sessionsRoot, ws.trim(), sid)
        } else {
          const bucket = sessionBucket(sid)
          if (bucket !== null) dir = join(sessionsRoot, bucket, sid)
        }
        if (dir === null || !existsSync(join(dir, SESSION_FILE))) {
          json(res, 404, { ok: false, error: '会话 ' + sid + ' 不存在' })
          return
        }
        try {
          const text = decompressLog(readFileSync(join(dir, SESSION_FILE)))
          if (text === null) { json(res, 500, { ok: false, error: '会话日志解码失败' }); return }
          const clip = (t: string): string => t.length > 4000 ? t.slice(0, 4000) + '…（已截断）' : t
          interface Turn { user: string; assistant: string; at: number }
          const turns: Turn[] = []
          let pos = 0
          for (;;) {
            const nl = text.indexOf('\n', pos)
            const lineEnd = nl < 0 ? text.length : nl
            const raw = text.slice(pos, lineEnd)
            pos = nl < 0 ? text.length : nl + 1
            if (raw.length > 2 && (raw.includes('"user/message"') || raw.includes('"assistant/message"'))) {
              try {
                const ev = JSON.parse(raw) as { type?: unknown; time?: unknown; data?: { source?: { kind?: unknown }; content?: { type?: unknown; text?: unknown }[] } }
                if (ev?.type === 'user/message' && ev?.data?.source?.kind === 'user' && Array.isArray(ev.data.content)) {
                  const t = ev.data.content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => String(c.text)).join('\n')
                  turns.push({ user: clip(t), assistant: '', at: typeof ev.time === 'number' ? ev.time : 0 })
                } else if (ev?.type === 'assistant/message' && turns.length > 0) {
                  // 该轮可能有多次 assistant 输出（工具调用分段）：记录最后一次正式回复；
                  // 整轮无正式回复时回退最后一次推理
                  const cur = turns[turns.length - 1]
                  const msg = ev.data as { message?: { content?: { type?: unknown; text?: unknown }[] } } | undefined
                  const blocks = Array.isArray(msg?.message?.content) ? msg.message.content : []
                  const text = blocks.filter((c) => c?.type === 'text' && typeof c.text === 'string')
                    .map((c) => String(c.text)).join('\n').trim()
                  if (text !== '') cur.assistant = clip(text)
                  else if (cur.assistant === '') {
                    const reasoning = blocks.filter((c) => c?.type === 'reasoning' && typeof c.text === 'string')
                      .map((c) => String(c.text)).join('\n').trim()
                    if (reasoning !== '') cur.assistant = '[推理] ' + reasoning
                  }
                }
              } catch { /* 跳过坏行 */ }
            }
            if (nl < 0) break
          }
          if (turns.length === 0) { json(res, 200, { ok: true, turns: 0 }); return }
          json(res, 200, {
            ok: true,
            turns: turns.length,
            first: turns[0],
            last: turns[turns.length - 1],
          })
        } catch (e) {
          json(res, 500, { ok: false, error: '解析失败：' + String(e).slice(0, 120) })
        }
        return
      }

      json(res, 404, { ok: false, error: '未知端点 ' + req.method + ' ' + pathname })
    },
  } satisfies WebRoute), 'session-timeline: api')

  ctx.logger?.info?.('[' + name + '] 会话时间线就绪：手工衔接存储 ' + root)
}
