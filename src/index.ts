/**
 * @dsh-external/session-timeline — session timeline (right-panel tab).
 * Host side: scans ~/.dsh/sessions/<bucket>/<sessionId>/session.v4.jsonl.zstd
 * for the header (createdAt / parentSession / isSeeded / cwd), the first real
 * user message time (creation-time criterion), the last session/title, and
 * handoff skill invocations (user/message + source.kind=skill-invocation +
 * name=handoff; seq/time/turn each — parsing in ./parse).
 * Top-level sessions (session- prefixed id) are timeline nodes; parentSession
 * pointing at an in-bucket top-level session forms a native edge — one child
 * = handoff link, multiple children = branch.
 * Manual drag links are stored per workspace at ~/.dsh/session-timeline/<bucket>.json.
 * API (/session-timeline/api):
 *   GET  /workspaces?session=…        workspace list (buckets)
 *   GET  /list?session=…&workspace=…  nodes (+archived flag) + native edges + manual links
 *   POST /link   { session?, workspace?, from, to }
 *   POST /unlink { session?, workspace?, from, to }
 * Error responses carry { ok:false, error:<zh text>, code, params? }: `code` is
 * stable and rendered client-side in the language configured in DSH; /turns
 * entries add userClipped / assistantClipped / assistantReasoning flags so
 * the clip/reasoning markers localize with the rest of the copy.
 * Archive state: the workspace registry's global archive set
 * (ctx 'workspaceRegistry' service when present, else the durable
 * ~/.dsh/storages/workspace.json global.archivedSessionIds) is stamped onto
 * each /list node at response time — never into the parse cache, because
 * archiving changes nothing in the session log file.
 */
import type { Context } from 'cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import z from 'schemastery'
import { parseLog } from './parse.js'
import type { HandoffHit } from './parse.js'

export const name = '@dsh-external/session-timeline'
export const inject = ['webServer']

export interface Config {
  /** Manual-link storage root; empty = <DSH_HOME>/session-timeline */
  storage_dir: string
}

export const Config = z.object({
  storage_dir: z.string().default(''),
})

/** Timeline node (top-level session). */
export interface SessionNode {
  id: string
  title: string | null
  /** Creation time = first real user message time; falls back to header.createdAt when none. */
  createdAt: number
  /** Raw header.createdAt (session object written time; display reconciliation). */
  logCreatedAt: number
  /** Raw header.parentSession (may point outside the bucket or to a deleted session). */
  parent: string | null
  /** header.isSeeded: opened from a handoff context seed. */
  seeded: boolean
  cwd: string | null
  /** Owning workspace (session bucket). */
  bucket: string
  /** Last activity (last log event time); used for positioning/display. */
  lastAt: number
  /** Handoff skill ran in the first conversation window. */
  handoffFirst: boolean
  /** Any handoff skill invocation appeared (gold "no successor" criterion; not last-window only). */
  handoffUsed: boolean
  /** Handoff skill invocations (seq/time/turn, in log order). */
  handoffHits: HandoffHit[]
  /** In the workspace registry's archive set (stamped at /list assembly; not part of the parse cache). */
  archived: boolean
}

/** Native edge: handoff (single child, chained) / branch (multiple children). */
export interface NativeEdge {
  from: string
  to: string
  kind: 'handoff' | 'branch'
}

/** Manual link (from = earlier-created side; semantics: "to" links from "from"). */
export interface ManualLink {
  from: string
  to: string
  created_at: string
}

/** Workspace (session bucket) summary. */
export interface WorkspaceInfo {
  bucket: string
  cwd: string | null
  sessions: number
  /** Newest session file mtime in the bucket (epoch ms). */
  newest: number
}

interface Doc {
  version: 1
  links: ManualLink[]
}

const SESSION_FILE = 'session.v4.jsonl.zstd'
const ZSTD_MAGIC = 0xFD2FB528
/** Sentinel bucket name for the global timeline (/list?workspace=__global__ aggregates all). */
export const GLOBAL_BUCKET = '__global__'

/* ---- zstd frame scan (same semantics as harness session-persistence-jsonl; tolerates torn trailing frames) ---- */

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

/* ---- Session bucket scan (mtime+size cache) ---- */

interface CacheEntry { mtimeMs: number; size: number; node: SessionNode | null; cwd: string | null }

function dshHomeDir(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** Workspace path → bucket encoding: /a/b → --a-b-- (matches decisions-tracker). */
export function encodeBucket(workspacePath: string): string {
  const clean = workspacePath.replace(/\/+$/, '').replace(/^\//, '')
  return '--' + clean.replaceAll('/', '-') + '--'
}

/** One API failure: stable machine code (+ interpolation params) for client-side i18n,
 *  plus the human-readable Chinese text kept for old clients and logs. */
interface ApiFail { code: string; text: string; params?: Record<string, unknown> }

function loadDoc(root: string, bucket: string): { doc: Doc; fail: ApiFail | null } {
  try {
    const file = join(root, bucket + '.json')
    if (!existsSync(file)) return { doc: { version: 1, links: [] }, fail: null }
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Doc>
    if (!Array.isArray(parsed.links)) return { doc: { version: 1, links: [] }, fail: { code: 'storageRead', text: '存储文件 links 字段缺失，已按空账处理' } }
    return { doc: { version: 1, links: parsed.links as ManualLink[] }, fail: null }
  } catch (e) {
    return { doc: { version: 1, links: [] }, fail: { code: 'storageRead', text: '存储文件读取失败：' + String(e).slice(0, 120), params: { message: String(e).slice(0, 120) } } }
  }
}

function saveDoc(root: string, bucket: string, doc: Doc): ApiFail | null {
  try {
    mkdirSync(root, { recursive: true })
    const file = join(root, bucket + '.json')
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
    return null
  } catch (e) {
    return { code: 'storageWrite', text: '存储文件写入失败：' + String(e).slice(0, 120), params: { message: String(e).slice(0, 120) } }
  }
}

export function apply(ctx: Context, config: Config): void {
  const root = config.storage_dir.trim() !== ''
    ? config.storage_dir
    : join(dshHomeDir(), 'session-timeline')
  const sessionsRoot = join(dshHomeDir(), 'sessions')
  mkdirSync(root, { recursive: true })

  /* ---- Workspace archive set (service first, durable file fallback) ---- */

  const archiveFile = join(dshHomeDir(), 'storages', 'workspace.json')
  let archiveCache: { mtimeMs: number; ids: Set<string> } | null = null
  /** The registry-global archive set; read failures degrade to "nothing archived". */
  const archivedIds = (): Set<string> => {
    // Runtime mirror first (works with any storage backend); optional get —
    // absent/unstarted registry falls through to the durable file below.
    const reg = (ctx as unknown as { get?: (key: string) => { archivedSessionIds?: readonly string[] } | undefined })
      .get?.('workspaceRegistry')
    if (reg?.archivedSessionIds !== undefined) return new Set(reg.archivedSessionIds)
    try {
      const st = statSync(archiveFile)
      if (archiveCache !== null && archiveCache.mtimeMs === st.mtimeMs) return archiveCache.ids
      const parsed = JSON.parse(readFileSync(archiveFile, 'utf8')) as { global?: { archivedSessionIds?: unknown } }
      const ids = Array.isArray(parsed?.global?.archivedSessionIds)
        ? new Set((parsed.global.archivedSessionIds as unknown[]).filter((x): x is string => typeof x === 'string'))
        : new Set<string>()
      archiveCache = { mtimeMs: st.mtimeMs, ids }
      return ids
    } catch { /* unreadable/absent storage file = no archive info */ }
    return new Set()
  }

  /** Stamp the response-only archived flag (parse cache stays flag-free). */
  const stampArchived = (nodes: SessionNode[]): SessionNode[] => {
    const ids = archivedIds()
    return nodes.map((n) => ({ ...n, archived: ids.has(n.id) }))
  }

  /** Session id → bucket (scans session buckets; positive results cached). */
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
    } catch { /* unreadable sessions root = unresolved */ }
    return null
  }

  /** One session file → node/dir info (mtime+size cache). */
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
                createdAt: parsed.firstUserAt > 0 ? parsed.firstUserAt : parsed.createdAt,
                logCreatedAt: parsed.createdAt,
                lastAt: parsed.lastAt,
                parent: parsed.parent,
                seeded: parsed.seeded,
                cwd: parsed.cwd,
                bucket,
                handoffFirst: parsed.handoffFirst,
                handoffUsed: parsed.handoffUsed,
                handoffHits: parsed.handoffHits,
                // Response-time flag: the parse cache always carries false;
                // stampArchived overwrites it at /list assembly.
                archived: false,
              }
            : null,
        }
      }
    } catch { /* one corrupt session file must not break the whole table */ }
    parseCache.set(sid, entry)
    return entry
  }

  /** Bucket node scan (top-level session nodes only). */
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

  /** Native edges: one child = handoff link; multiple children = branch. */
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

  /** Workspace list: bucket + cwd (one cached session header per bucket) + top-level session count (= node count) + newest mtime. */
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
          /* Count = timeline node criterion (top-level session-* only;
           * subagent child sessions are excluded), aligned with /list sessions.length */
          if (sid.startsWith('session-')) count += 1
          if (st.mtimeMs > newest) newest = st.mtimeMs
        } catch { /* directories without a session file don't count */ }
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

  /* ---- Panel API ---- */

  const json = (res: {
    writeHead: (code: number, headers: Record<string, string>) => unknown
    end: (body?: string) => unknown
  }, code: number, payload: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }

  /** Error payload: `code`/`params` drive the client's localized copy; `error` keeps the zh text. */
  const failPayload = (f: ApiFail): Record<string, unknown> => ({
    ok: false,
    error: f.text,
    code: f.code,
    ...(f.params !== undefined ? { params: f.params } : {}),
  })

  const readBody = (req: { on: (ev: string, cb: (chunk: unknown) => void) => void }): Promise<string> =>
    new Promise((resolve) => {
      let body = ''
      req.on('data', (chunk: unknown) => { body += String(chunk) })
      req.on('end', () => resolve(body))
      req.on('error', () => resolve(body))
    })

  /** Resolve workspace: workspace param (bucket name) first, else locate via session param; __global__ = all buckets. */
  const locate = (workspace: string | null, sessionId: string | null): { bucket: string; fail: null } | { bucket: null; fail: ApiFail } => {
    if (workspace !== null && workspace.trim() !== '') {
      const bucket = workspace.trim()
      if (bucket === GLOBAL_BUCKET) return { bucket, fail: null }
      if (!existsSync(join(sessionsRoot, bucket))) {
        return { bucket: null, fail: { code: 'workspaceMissing', text: '工作区 ' + bucket + ' 不存在（桶不可读）', params: { bucket } } }
      }
      return { bucket, fail: null }
    }
    if (sessionId === null || sessionId.trim() === '') {
      return { bucket: null, fail: { code: 'locateMissing', text: '缺 session/workspace 参数' } }
    }
    const bucket = sessionBucket(sessionId.trim())
    if (bucket === null) return { bucket: null, fail: { code: 'sessionNotInBucket', text: '会话 ' + sessionId + ' 不在任何工作区存储桶', params: { session: sessionId } } }
    return { bucket, fail: null }
  }

  /** Global aggregation: all buckets' nodes + per-bucket lineage edges + manual links (lineage never crosses buckets). */
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
    } catch { /* unreadable root returns empty */ }
    for (const b of buckets) {
      const r = listBucketNodes(b)
      nodes.push(...r.nodes)
      unreadable += r.unreadable
      edges.push(...nativeEdges(r.nodes))
      const doc = loadDoc(root, b)
      if (doc.fail === null) links.push(...doc.doc.links)
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
        if (located.fail !== null) { json(res, 400, failPayload(located.fail)); return }
        if (located.bucket === GLOBAL_BUCKET) {
          const g = listGlobalNodes()
          json(res, 200, {
            ok: true,
            bucket: GLOBAL_BUCKET,
            unreadable: g.unreadable,
            sessions: stampArchived(g.nodes),
            edges: g.edges,
            manualLinks: g.links,
          })
          return
        }
        const { nodes, unreadable } = listBucketNodes(located.bucket)
        const doc = loadDoc(root, located.bucket)
        if (doc.fail !== null) { json(res, 500, failPayload(doc.fail)); return }
        json(res, 200, {
          ok: true,
          bucket: located.bucket,
          unreadable,
          sessions: stampArchived(nodes),
          edges: nativeEdges(nodes),
          manualLinks: doc.doc.links,
        })
        return
      }

      if (pathname === '/session-timeline/api/link' && req.method === 'POST') {
        let body: Record<string, unknown> = {}
        try { body = JSON.parse(await readBody(req)) as Record<string, unknown> } catch { /* empty body = missing params */ }
        const located = locate(
          typeof body.workspace === 'string' ? body.workspace : null,
          typeof body.session === 'string' ? body.session : null,
        )
        if (located.fail !== null) { json(res, 400, failPayload(located.fail)); return }
        const from = typeof body.from === 'string' ? body.from.trim() : ''
        const to = typeof body.to === 'string' ? body.to.trim() : ''
        if (from === '' || to === '') { json(res, 400, failPayload({ code: 'emptyFromTo', text: 'from/to 不能为空' })); return }
        if (from === to) { json(res, 400, failPayload({ code: 'linkSelf', text: '不能与自己衔接' })); return }
        const { nodes } = listBucketNodes(located.bucket)
        const byId = new Map(nodes.map((n) => [n.id, n]))
        const a = byId.get(from)
        const b = byId.get(to)
        if (a === undefined || b === undefined) {
          json(res, 400, failPayload({ code: 'notTopLevel', text: 'from/to 必须是该工作区的顶层会话' }))
          return
        }
        for (const e of nativeEdges(nodes)) {
          if ((e.from === from && e.to === to) || (e.from === to && e.to === from)) {
            json(res, 409, e.kind === 'branch'
              ? failPayload({ code: 'nativeBranch', text: '两会话已存在原生血缘（分支），无需手工连线' })
              : failPayload({ code: 'nativeHandoff', text: '两会话已存在原生血缘（handoff），无需手工连线' }))
            return
          }
        }
        // Normalize direction by creation time: from = earlier side (predecessor),
        // to = later side (successor); creation time = first real user message
        // time, falling back to header.createdAt — same direction as native
        // parent→child (older points to newer).
        const [nf, nt] = a.createdAt <= b.createdAt ? [from, to] : [to, from]
        const doc = loadDoc(root, located.bucket)
        if (doc.fail !== null) { json(res, 500, failPayload(doc.fail)); return }
        const dup = doc.doc.links.some((l) => (l.from === nf && l.to === nt) || (l.from === nt && l.to === nf))
        if (dup) { json(res, 200, { ok: true, duplicate: true }); return }
        doc.doc.links.push({ from: nf, to: nt, created_at: new Date().toISOString() })
        const err = saveDoc(root, located.bucket, doc.doc)
        if (err !== null) { json(res, 500, failPayload(err)); return }
        json(res, 200, { ok: true, from: nf, to: nt })
        return
      }

      if (pathname === '/session-timeline/api/unlink' && req.method === 'POST') {
        let body: Record<string, unknown> = {}
        try { body = JSON.parse(await readBody(req)) as Record<string, unknown> } catch { /* empty body = missing params */ }
        const located = locate(
          typeof body.workspace === 'string' ? body.workspace : null,
          typeof body.session === 'string' ? body.session : null,
        )
        if (located.fail !== null) { json(res, 400, failPayload(located.fail)); return }
        const from = typeof body.from === 'string' ? body.from.trim() : ''
        const to = typeof body.to === 'string' ? body.to.trim() : ''
        if (from === '' || to === '') { json(res, 400, failPayload({ code: 'emptyFromTo', text: 'from/to 不能为空' })); return }
        const doc = loadDoc(root, located.bucket)
        if (doc.fail !== null) { json(res, 500, failPayload(doc.fail)); return }
        const before = doc.doc.links.length
        doc.doc.links = doc.doc.links.filter((l) => !((l.from === from && l.to === to) || (l.from === to && l.to === from)))
        const removed = before - doc.doc.links.length
        if (removed > 0) {
          const err = saveDoc(root, located.bucket, doc.doc)
          if (err !== null) { json(res, 500, failPayload(err)); return }
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
          json(res, 404, failPayload({ code: 'sessionMissing', text: '会话 ' + sid + ' 不存在', params: { session: sid } }))
          return
        }
        try {
          const text = decompressLog(readFileSync(join(dir, SESSION_FILE)))
          if (text === null) { json(res, 500, failPayload({ code: 'decodeFailed', text: '会话日志解码失败' })); return }
          /** 4000-char clip; the truncation marker is rendered client-side from the
           *  clipped flag so it follows the configured language. */
          const clip = (t: string): { text: string; clipped: boolean } => t.length > 4000
            ? { text: t.slice(0, 4000), clipped: true }
            : { text: t, clipped: false }
          interface Turn {
            user: string
            assistant: string
            at: number
            userClipped?: boolean
            assistantClipped?: boolean
            assistantReasoning?: boolean
          }
          const turns: Turn[] = []
          /** Turns containing a handoff skill call (1-based); same-turn calls deduplicated. */
          const handoffTurnSet = new Set<number>()
          let pos = 0
          for (;;) {
            const nl = text.indexOf('\n', pos)
            const lineEnd = nl < 0 ? text.length : nl
            const raw = text.slice(pos, lineEnd)
            pos = nl < 0 ? text.length : nl + 1
            if (raw.length > 2 && (raw.includes('"user/message"') || raw.includes('"assistant/message"'))) {
              try {
                const ev = JSON.parse(raw) as { type?: unknown; time?: unknown; data?: { source?: { kind?: unknown; name?: unknown }; content?: { type?: unknown; text?: unknown }[] } }
                if (ev?.type === 'user/message' && ev?.data?.source?.kind === 'user' && Array.isArray(ev.data.content)) {
                  const t = ev.data.content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => String(c.text)).join('\n')
                  const clipped = clip(t)
                  turns.push({ user: clipped.text, userClipped: clipped.clipped, assistant: '', at: typeof ev.time === 'number' ? ev.time : 0 })
                } else if (ev?.type === 'user/message'
                  && ev?.data?.source?.kind === 'skill-invocation'
                  && ev?.data?.source?.name === 'handoff') {
                  /* Call lines belong to the turn already open; with no user
                   * message yet (turns.length === 0) there is nothing to show — skip. */
                  if (turns.length > 0) handoffTurnSet.add(turns.length)
                } else if (ev?.type === 'assistant/message' && turns.length > 0) {
                  // A turn may have several assistant outputs (tool-call segments):
                  // keep the last formal reply; fall back to the last reasoning
                  // when the turn has none.
                  const cur = turns[turns.length - 1]
                  const msg = ev.data as { message?: { content?: { type?: unknown; text?: unknown }[] } } | undefined
                  const blocks = Array.isArray(msg?.message?.content) ? msg.message.content : []
                  const text = blocks.filter((c) => c?.type === 'text' && typeof c.text === 'string')
                    .map((c) => String(c.text)).join('\n').trim()
                  if (text !== '') {
                    const clipped = clip(text)
                    cur.assistant = clipped.text
                    cur.assistantClipped = clipped.clipped
                  } else if (cur.assistant === '') {
                    const reasoning = blocks.filter((c) => c?.type === 'reasoning' && typeof c.text === 'string')
                      .map((c) => String(c.text)).join('\n').trim()
                    if (reasoning !== '') {
                      cur.assistant = reasoning
                      cur.assistantReasoning = true
                    }
                  }
                }
              } catch { /* skip bad line */ }
            }
            if (nl < 0) break
          }
          if (turns.length === 0) { json(res, 200, { ok: true, turns: 0, handoffTurns: [] }); return }
          /* Single turn on demand (clicking any turn bar): GET /turns&turn=N → that turn's dialog. */
          const wantTurn = Number(query.get('turn') ?? '')
          if (Number.isInteger(wantTurn) && wantTurn >= 1 && wantTurn <= turns.length) {
            json(res, 200, { ok: true, turns: turns.length, turn: wantTurn, data: turns[wantTurn - 1] })
            return
          }
          json(res, 200, {
            ok: true,
            turns: turns.length,
            first: turns[0],
            last: turns[turns.length - 1],
            /* Full dialog of handoff-skill turns (user/assistant, same 4000-char clip). */
            handoffTurns: [...handoffTurnSet].sort((a, b) => a - b)
              .filter((turn) => turn >= 1 && turn <= turns.length)
              .map((turn) => ({ turn, ...turns[turn - 1] })),
          })
        } catch (e) {
          json(res, 500, failPayload({ code: 'parseFailed', text: '解析失败：' + String(e).slice(0, 120), params: { message: String(e).slice(0, 120) } }))
        }
        return
      }

      json(res, 404, failPayload({ code: 'unknownEndpoint', text: '未知端点 ' + req.method + ' ' + pathname, params: { method: req.method ?? '', path: pathname } }))
    },
  } satisfies WebRoute), 'session-timeline: api')

  ctx.logger?.info?.('[' + name + '] 会话时间线就绪：手工衔接存储 ' + root)
}
