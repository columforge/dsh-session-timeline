/**
 * @dsh-external/session-timeline — client：右侧边栏页签（会话时间线）。
 * 鱼骨时间线：中央水平主轴（右端箭头），轴上日期刻度（YY-MM-DD，日期变化
 * 处标注、文字放鱼刺对侧）；会话按创建时间从左到右交替分布在轴上下两侧，
 * 鱼刺竖线连到轴。血缘（handoff/分支）为实线弯折线：父近轴边 → 轴侧通道 →
 * 水平至子列 → 进子节点左侧（箭头向右）；手工衔接为橙色虚线弯折线（同向
 * 左侧入口）。
 * handoff 新会话 = 首条用户消息内容含 handoff 文档引用（host 判定
 * handoffSeed）→「handoff」标签。首/末对话调用过 handoff skill 且对应方向
 * 无衔接边的节点：紫框 = 待接前驱，金框 = 待接后继。
 * 双击节点 = 切换到该会话；头部「全局时间线」开关聚合所有工作区。
 * 构建：tsdown → lib/client.js（ModuleLoader 注册）。
 * ⚠️ client 须 export const inject；slots.register 必须带 name 字段。
 */
const React = require('react') as typeof import('react')
const h = React.createElement
const { useEffect, useMemo, useRef, useState } = React

const P = require('@deepseek-ai/dsh-client-ui-primitives') as {
  Button: (props: Record<string, unknown>) => unknown
  Tag: (props: { tone?: string; children?: unknown }) => unknown
  IconBranchOutlineRegular: (props: { size?: number }) => unknown
}

const API_BASE = '/session-timeline/api'
const POLL_MS = 8000
const FETCH_TIMEOUT_MS = 15000
const PANEL_TITLE = '会话时间线'
const TAB_ID = '@dsh-external/session-timeline'
const TAB_KIND = 'session-timeline'

/** 版面常量：鱼骨——主轴居中，节点交替上下，鱼刺长 GAP。 */
const SPACING = 160
const NODE_W = 132
const NODE_H = 96
const GAP = 34
const ROW_GAP = 24
const DATE_BAND = 18
const TIMELINE_MAX_H = 420

type SNode = {
  id: string
  title: string | null
  /** 会话创建时间 = 首条真实用户消息时间（无用户消息时回落日志 header） */
  createdAt: number
  /** 日志 header.createdAt 原文（会话对象落盘时刻） */
  logCreatedAt: number
  /** 最后活动时间（时间线定位/显示用它） */
  lastAt: number
  parent: string | null
  seeded: boolean
  handoffSeed: boolean
  cwd: string | null
  bucket: string
  handoffFirst: boolean
  handoffLast: boolean
}
type NEdge = { from: string; to: string; kind: 'handoff' | 'branch' }
type MLink = { from: string; to: string; created_at: string }
type Workspace = { bucket: string; cwd: string | null; sessions: number; newest: number }
type Snapshot = {
  ok: boolean
  error?: string
  bucket?: string
  unreadable?: number
  sessions?: SNode[]
  edges?: NEdge[]
  manualLinks?: MLink[]
}

type Ctx = {
  slots: {
    inject: (slot: string, factory: () => unknown) => unknown
    register: (options: Record<string, unknown>, component: unknown) => unknown
  }
  sidebarRightTabs: {
    register: (definition: Record<string, unknown>) => unknown
  }
  uiWorkspace?: {
    openSession: (target: string) => void
  }
  effect: (fn: () => void, label?: string) => unknown
}

export const inject = ['slots', 'sidebarRightTabs', 'uiWorkspace']

const DIM = 'var(--dsw-alias-text-secondary, rgba(128,128,128,0.85))'
const ACCENT = 'var(--dsw-alias-accent-primary, #3b82f6)'   // handoff 衔接（实线弯折）
const BRANCH = '#8b5cf6'                                     // 分支（实线弯折）
const MANUAL = 'rgba(217,119,6,0.95)'                        // 手工衔接（虚线弯折）
const FIRST_NUDGE = '#8b5cf6'                                // 首对话 handoff 强调（紫）
const LAST_NUDGE = '#e0a11a'                                 // 末对话 handoff 强调（金）
const AXIS = 'var(--dsw-alias-text-primary, rgba(200,200,200,0.9))'
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

function pad(n: number): string { return n < 10 ? '0' + String(n) : String(n) }

/** YYYY-MM-DD HH:MM */
function fmt(ms: number): string {
  const d = new Date(ms)
  return String(d.getFullYear()) + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

function fmtDate(ms: number): string {
  const d = new Date(ms)
  return String(d.getFullYear()) + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

function fmtFull(ms: number): string {
  const d = new Date(ms)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
}

function listUrl(workspace: string | undefined, sessionId: string | undefined): string {
  const q = new URLSearchParams()
  if (workspace !== undefined) q.set('workspace', workspace)
  else if (sessionId !== undefined) q.set('session', sessionId)
  const s = q.toString()
  return API_BASE + '/list' + (s === '' ? '' : '?' + s)
}

function post(action: 'link' | 'unlink', payload: Record<string, unknown>): Promise<{ ok?: boolean; error?: string; duplicate?: boolean } | null> {
  return fetch(API_BASE + '/' + action, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then((r) => r.json() as Promise<{ ok?: boolean; error?: string; duplicate?: boolean }>)
    .catch(() => null)
}

function fetchWorkspaces(): Promise<Workspace[] | null> {
  const ctrl = new AbortController()
  const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  return fetch(API_BASE + '/workspaces', { signal: ctrl.signal })
    .then((r) => r.json() as Promise<{ ok?: boolean; workspaces?: Workspace[] }>)
    .then((d) => (d?.ok === true ? (d.workspaces ?? []) : null))
    .catch(() => null)
    .finally(() => clearTimeout(tid))
}

/** 轮询 host API；页面隐藏时暂停。workspace 优先，缺省用当前会话定位。 */
function useSnapshot(workspace: string | undefined, sessionId: string | undefined): [Snapshot | undefined, () => void] {
  const [snap, setSnap] = useState<Snapshot | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchOnce = (): void => {
    if (workspace === undefined && sessionId === undefined) { setSnap({ ok: false, error: '未定位当前会话，无法确定工作区' }); return }
    const ctrl = new AbortController()
    const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    fetch(listUrl(workspace, sessionId), { signal: ctrl.signal })
      .then((r) => r.json())
      .then((data: Snapshot) => setSnap(data))
      .catch(() => { /* 轮询失败保留上次快照 */ })
      .finally(() => clearTimeout(tid))
  }

  useEffect(() => {
    fetchOnce()
    timer.current = setInterval(() => { if (!document.hidden) fetchOnce() }, POLL_MS)
    const onVis = (): void => { if (!document.hidden) fetchOnce() }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      if (timer.current !== null) clearInterval(timer.current)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [workspace, sessionId])
  return [snap, fetchOnce]
}

function shortId(id: string): string {
  return id.startsWith('session-') ? id.slice(8, 8 + 8) + '…' : id.slice(0, 8) + '…'
}

/**
 * 鱼骨 + 深度行布局：列 = 创建时间序；side = 独立节点奇偶交替、血缘子继承父侧；
 * depth = 独立/分支子 0（鱼骨层，鱼刺接轴），handoff 子 = 父 + 1（向轴外侧
 * 叠行 = 血缘深度行）。行高 LH = NODE_H + ROW_GAP。
 */
interface Layout {
  nodes: SNode[]
  colOf: Map<string, number>
  sideOf: Map<string, 'up' | 'down'>
  depthOf: Map<string, number>
  axisY: number
  innerW: number
  innerH: number
  maxDepth: number
  corridorUp: number
  corridorDown: number
}

function computeLayout(nodesIn: SNode[], edges: NEdge[], manualLinks: MLink[]): Layout {
  const nodes = nodesIn
  const colOf = new Map<string, number>()
  const sideOf = new Map<string, 'up' | 'down'>()
  const depthOf = new Map<string, number>()
  // 原生血缘（handoff 链与分支）：子会话一律下沉深度行
  const nativeParent = new Map<string, string>()
  for (const e of edges) nativeParent.set(e.to, e.from)
  // 手工衔接（from 创建较早 → to 较晚）：to 未被子会话化时同样下沉深度行
  const manualParent = new Map<string, string>()
  for (const l of manualLinks) manualParent.set(l.to, l.from)
  /* 分派（side/depth）按拓扑序：依赖（原生父 / 手工 from）已分派才处理该节点，
   * 依赖未定则延后到下一轮——手工链的父创建可晚于子（拖拽语义），创建序不可靠；
   * 同时与显示排序键（lastAt 等）解耦。 */
  const byCreation = [...nodesIn].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
  let flip = 0
  let upMax = 0
  let downMax = 0
  const pending = byCreation
  let progressed = true
  while (pending.length > 0 && progressed) {
    progressed = false
    for (let pi = pending.length - 1; pi >= 0; pi--) {
      const n = pending[pi]
      const np = nativeParent.get(n.id)
      const mp = manualParent.get(n.id)
      const dep = np ?? mp
      if (dep !== undefined && !sideOf.has(dep)) continue
      let side: 'up' | 'down'
      let depth: number
      if (dep !== undefined) {
        // 血缘（handoff 链/分支）或手工链：继承父侧，深度 + 1（血缘深度行）
        side = sideOf.get(dep) ?? 'up'
        depth = (depthOf.get(dep) ?? 0) + 1
      } else {
        side = flip % 2 === 0 ? 'up' : 'down'
        depth = 0
        flip += 1
      }
      sideOf.set(n.id, side)
      depthOf.set(n.id, depth)
      if (side === 'up' && depth > upMax) upMax = depth
      if (side === 'down' && depth > downMax) downMax = depth
      pending.splice(pi, 1)
      progressed = true
    }
  }
  // 兜底：仅理论成环才会残留，按独立分派
  for (const n of pending) {
    const side: 'up' | 'down' = flip % 2 === 0 ? 'up' : 'down'
    sideOf.set(n.id, side)
    depthOf.set(n.id, 0)
    flip += 1
  }
  nodesIn.forEach((n, i) => { colOf.set(n.id, i) })
  const upBlock = (upMax + 1) * NODE_H + upMax * ROW_GAP
  const downBlock = (downMax + 1) * NODE_H + downMax * ROW_GAP
  const axisY = DATE_BAND + upBlock + GAP
  /* 外侧走廊（所有连线的水平通道）：按该侧最外框的实际外缘再外移 12px，
   * 保证深度行叠高后走廊仍在所有框与鱼刺之外 */
  const rowTop = (side: 'up' | 'down', depth: number): number =>
    side === 'up'
      ? axisY - GAP - NODE_H - depth * (NODE_H + ROW_GAP)
      : axisY + GAP + depth * (NODE_H + ROW_GAP)
  let upOuter = Infinity
  let downOuter = -Infinity
  for (const n of nodes) {
    const t = rowTop(sideOf.get(n.id) ?? 'up', depthOf.get(n.id) ?? 0)
    if ((sideOf.get(n.id) ?? 'up') === 'up') upOuter = Math.min(upOuter, t)
    else downOuter = Math.max(downOuter, t + NODE_H)
  }
  const corridorUp = (upOuter === Infinity ? DATE_BAND : upOuter) - 12
  const corridorDown = (downOuter === -Infinity ? axisY + GAP + NODE_H : downOuter) + 12
  return {
    nodes,
    colOf,
    sideOf,
    depthOf,
    axisY,
    innerW: Math.max(nodes.length * SPACING + 24, 320),
    innerH: axisY + GAP + downBlock + DATE_BAND,
    maxDepth: Math.max(upMax, downMax),
    corridorUp,
    corridorDown,
  }
}

function colX(layout: Layout, id: string): number {
  return (layout.colOf.get(id) ?? 0) * SPACING + SPACING / 2
}

function nodeTop(layout: Layout, id: string): number {
  const side = layout.sideOf.get(id) ?? 'up'
  const depth = layout.depthOf.get(id) ?? 0
  if (side === 'up') {
    // 轴上方：depth 0 最靠轴，深度行向上（远离轴）叠
    return layout.axisY - GAP - NODE_H - depth * (NODE_H + ROW_GAP)
  }
  return layout.axisY + GAP + depth * (NODE_H + ROW_GAP)
}

/**
 * 正交避障路由（系统性解法，替代模板走线）：
 * 节点框（外扩 2px）为障碍，画布取框缘 ±8px 生成正交通道网格；
 * 每条边在网格上跑 A\*（代价 = 长度 + 转折 ×10 + 已占用通道拥挤 ×30），
 * 得到不穿任何框的正交折线，任意布局/连线组合自动适配。
 */
interface Obstacle { x: number; y: number; w: number; h: number }

const OBST_PAD = 2
const EDGE_PAD = 8
const TURN_COST = 10
const CROWD_COST = 30

/** 线段 (x1,y1)-(x2,y2)（正交）是否穿过任一障碍（开区间，端点贴边允许）。 */
function segHitsObstacle(x1: number, y1: number, x2: number, y2: number, obs: Obstacle[]): boolean {
  for (const o of obs) {
    const l = o.x; const r = o.x + o.w; const t = o.y; const b = o.y + o.h
    if (x1 === x2) {
      // 竖直段
      if (x1 > l && x1 < r) {
        const lo = Math.min(y1, y2); const hi = Math.max(y1, y2)
        if (hi > t && lo < b) return true
      }
    } else if (y1 === y2) {
      if (y1 > t && y1 < b) {
        const lo = Math.min(x1, x2); const hi = Math.max(x1, x2)
        if (hi > l && lo < r) return true
      }
    }
  }
  return false
}

function routeOrthogonal(
  obstacles: Obstacle[],
  sx: number, sy: number,
  tx: number, ty: number,
  occupied: Map<string, number>,
  corridorYs: number[] = [],
): string {
  /* 通道坐标：所有框缘 ±8 + 起/终点，去重并合并近邻 */
  const xsRaw: number[] = [sx, tx]
  const ysRaw: number[] = [sy, ty]
  for (const o of obstacles) {
    xsRaw.push(o.x - EDGE_PAD, o.x + o.w + EDGE_PAD)
    ysRaw.push(o.y - EDGE_PAD, o.y + o.h + EDGE_PAD)
  }
  const merge = (arr: number[]): number[] => {
    const a = [...arr].sort((p, q) => p - q)
    const out: number[] = []
    for (const v of a) {
      if (out.length === 0 || v - out[out.length - 1] > 6) out.push(v)
    }
    return out
  }
  const xs = merge(xsRaw)
  const ys = merge(ysRaw)
  const xIdx = new Map<number, number>(xs.map((v, i) => [v, i]))
  const yIdx = new Map<number, number>(ys.map((v, i) => [v, i]))
  const near = (arr: number[], v: number): number => {
    let best = arr[0]
    for (const c of arr) if (Math.abs(c - v) < Math.abs(best - v)) best = c
    return best
  }
  const s = { x: xIdx.get(near(xs, sx)) ?? 0, y: yIdx.get(near(ys, sy)) ?? 0 }
  const t = { x: xIdx.get(near(xs, tx)) ?? 0, y: yIdx.get(near(ys, ty)) ?? 0 }

  /* A*：代价 = 步长 + 转折 ×10 + 通道拥挤 ×30（occupied 由调用方传入跨边共享） */
  const crowd = (x1: number, y1: number, x2: number, y2: number): number => {
    const key = x1 === x2 ? 'v' + String(x1) : 'h' + String(y1)
    return (occupied.get(key) ?? 0) * CROWD_COST
  }
  const mark = (x1: number, y1: number, x2: number, y2: number): void => {
    const key = x1 === x2 ? 'v' + String(x1) : 'h' + String(y1)
    occupied.set(key, (occupied.get(key) ?? 0) + 1)
  }
  const keyOf = (x: number, y: number): string => String(x) + ',' + String(y)
  const open: { x: number; y: number; g: number; f: number; dir: string; parent: string | null }[] = [{ x: s.x, y: s.y, g: 0, f: 0, dir: '', parent: null }]
  const bestG = new Map<string, number>([[keyOf(s.x, s.y), 0]])
  const parentMap = new Map<string, string>()
  const h = (x: number, y: number): number => Math.abs(x - xs[t.x]) + Math.abs(y - ys[t.y])
  let expanded = 0
  while (open.length > 0 && expanded < 60000) {
    open.sort((a, b) => a.f - b.f)
    const cur = open.shift()
    if (cur === undefined) break
    expanded += 1
    const ck = keyOf(cur.x, cur.y)
    if ((bestG.get(ck) ?? Infinity) < cur.g) continue
    if (cur.x === t.x && cur.y === t.y) break
    const neighbors: [number, number, string][] = [
      [cur.x + 1, cur.y, 'h'], [cur.x - 1, cur.y, 'h'],
      [cur.x, cur.y + 1, 'v'], [cur.x, cur.y - 1, 'v'],
    ]
    for (const [nx, ny, ndir] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= xs.length || ny >= ys.length) continue
      const ax = xs[cur.x]; const ay = ys[cur.y]
      const bx = xs[nx]; const by = ys[ny]
      if (segHitsObstacle(ax, ay, bx, by, obstacles)) continue
      const turn = cur.dir !== '' && cur.dir !== ndir ? TURN_COST : 0
      const g = cur.g + (Math.abs(bx - ax) + Math.abs(by - ay)) + turn + crowd(ax, ay, bx, by)
      const nk = keyOf(nx, ny)
      if (g < (bestG.get(nk) ?? Infinity)) {
        bestG.set(nk, g)
        parentMap.set(nk, ck)
        open.push({ x: nx, y: ny, g, f: g + h(xs[nx], ys[ny]), dir: ndir, parent: ck })
      }
    }
  }
  if (!parentMap.has(keyOf(t.x, t.y))) {
    /* 兜底（A* 网格死角时）：① 经外侧走廊的 U 形（走廊在所有框外，保证不穿框）；
     * ② 正交 L 形折线（绝不出斜线，穿障碍时取段少的） */
    const bad = (path: string): number => {
      const nums = path.match(/-?\d+(\.\d+)?/g) ?? []
      const pts: [number, number][] = []
      for (let i = 0; i < nums.length; i += 2) pts.push([Number(nums[i]), Number(nums[i + 1])])
      let n = 0
      for (let i = 0; i + 1 < pts.length; i++) {
        for (const o of obstacles) {
          const l = o.x; const r = o.x + o.w; const tp = o.y; const bt = o.y + o.h
          if (pts[i][0] === pts[i + 1][0]) {
            if (pts[i][0] > l && pts[i][0] < r && Math.max(pts[i][1], pts[i + 1][1]) > tp && Math.min(pts[i][1], pts[i + 1][1]) < bt) n += 1
          } else if (pts[i][1] > tp && pts[i][1] < bt && Math.max(pts[i][0], pts[i + 1][0]) > l && Math.min(pts[i][0], pts[i + 1][0]) < r) n += 1
        }
      }
      return n
    }
    const candidates: string[] = []
    for (const cy of corridorYs) {
      candidates.push('M ' + String(sx) + ' ' + String(sy) + ' L ' + String(sx) + ' ' + String(cy) + ' L ' + String(tx) + ' ' + String(cy) + ' L ' + String(tx) + ' ' + String(ty))
    }
    candidates.push('M ' + String(sx) + ' ' + String(sy) + ' L ' + String(sx) + ' ' + String(ty) + ' L ' + String(tx) + ' ' + String(ty))
    candidates.push('M ' + String(sx) + ' ' + String(sy) + ' L ' + String(tx) + ' ' + String(sy) + ' L ' + String(tx) + ' ' + String(ty))
    let best: string | null = null
    let bestBad = Infinity
    for (const c of candidates) {
      const b = bad(c)
      if (b === 0) return c
      if (b < bestBad) { bestBad = b; best = c }
    }
    return best ?? candidates[0]
  }
  /* 回溯折点 */
  const pts: [number, number][] = []
  let ck = keyOf(t.x, t.y)
  const seen = new Set<string>()
  for (;;) {
    pts.unshift([xs[Number(ck.split(',')[0])], ys[Number(ck.split(',')[1])]])
    seen.add(ck)
    const par = parentMap.get(ck)
    if (par === undefined || seen.has(par)) break
    ck = par
  }
  pts.unshift([sx, sy])
  pts.push([tx, ty])
  /* 折线转 path：同向点合并 + mark 通道拥挤（供后续边代价） */
  const outPts: [number, number][] = []
  for (const pt of pts) {
    const n = outPts.length
    if (n >= 2 && ((outPts[n - 1][0] === pt[0]) === (outPts[n - 2][0] === outPts[n - 1][0]))) {
      outPts[outPts.length - 1] = pt
    } else if (n === 0 || outPts[n - 1][0] !== pt[0] || outPts[n - 1][1] !== pt[1]) {
      outPts.push(pt)
    }
  }
  for (let i = 0; i + 1 < outPts.length; i++) mark(outPts[i][0], outPts[i][1], outPts[i + 1][0], outPts[i + 1][1])
  return 'M ' + outPts.map((p) => String(p[0]) + ' ' + String(p[1])).join(' L ')
}

/** 渲染错误边界：异常显示错误文本而非空白。 */
class PanelBoundary extends React.Component<{ children?: unknown }, { error: Error | null }> {
  constructor(props: { children?: unknown }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  render(): unknown {
    if (this.state.error !== null) {
      return h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12.5, padding: 12 } },
        '会话时间线渲染失败：' + String(this.state.error.message ?? this.state.error))
    }
    return this.props.children
  }
}

function PanelBody(props: { sessionId?: string; openSession: (id: string) => void }): unknown {
  const { sessionId, openSession } = props
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null)
  const [workspace, setWorkspace] = useState<string | undefined>(undefined)
  const [snap, refresh] = useSnapshot(workspace, sessionId)
  const [selected, setSelected] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const innerRef = useRef<HTMLDivElement | null>(null)
  const [drag, setDrag] = useState<{ from: string; x: number; y: number; sx: number; sy: number; moved: boolean } | null>(null)
  const dragRef = useRef(drag)
  dragRef.current = drag

  useEffect(() => {
    void fetchWorkspaces().then((ws) => { if (ws !== null) setWorkspaces(ws) })
  }, [])

  /* 排序：创建时间（默认）/ 最后活动时间；方向：从老到新（默认）/ 从新到老 */
  const [sortBy, setSortBy] = useState<'createdAt' | 'lastAt'>('createdAt')
  const [newestFirst, setNewestFirst] = useState(true)
  const sortedNodes = useMemo(() => {
    const list = [...(snap?.sessions ?? [])]
    list.sort((a, b) => (sortBy === 'createdAt' ? a.createdAt - b.createdAt : a.lastAt - b.lastAt) || (a.id < b.id ? -1 : 1))
    if (newestFirst) list.reverse()
    return list
  }, [snap, sortBy, newestFirst])
  const layout = useMemo(() => computeLayout(sortedNodes, snap?.edges ?? [], snap?.manualLinks ?? []), [sortedNodes, snap])
  const { nodes } = layout
  const edges = snap?.edges ?? []
  const manualLinks = snap?.manualLinks ?? []
  const displayAt = (n: SNode): number => (sortBy === 'createdAt' ? n.createdAt : n.lastAt)

  /* 缩放：100% = 原始比例；按钮 ±10%，窗口内滚轮 ±5% */
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [zoom, setZoom] = useState(1)
  const clampZoom = (z: number): number => Math.max(0.1, Math.min(3, z))
  const applyZoom = (next: number, cx?: number, cy?: number): void => {
    const vp = viewportRef.current
    const prev = zoom
    const z = clampZoom(next)
    if (vp !== undefined && vp !== null && cx !== undefined && cy !== undefined) {
      // 围绕光标锚点缩放：保持光标下的布局点视觉位置不变
      const k = z / prev
      vp.scrollLeft = (vp.scrollLeft + cx) * k - cx
      vp.scrollTop = (vp.scrollTop + cy) * k - cy
    }
    setZoom(z)
  }
  useEffect(() => {
    const vp = viewportRef.current
    if (vp === null) return
    const onWheel = (ev: WheelEvent): void => {
      ev.preventDefault()
      const rect = vp.getBoundingClientRect()
      const delta = ev.deltaY < 0 ? 0.05 : -0.05
      applyZoom(zoom + delta, ev.clientX - rect.left, ev.clientY - rect.top)
    }
    vp.addEventListener('wheel', onWheel, { passive: false })
    return () => vp.removeEventListener('wheel', onWheel)
  }, [zoom])
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])

  /* 日期刻度：日期变化处 + 首列；文字放鱼刺对侧 */
  const dateMarks = useMemo(() => {
    const marks: { x: number; date: string; below: boolean }[] = []
    let last = ''
    for (const n of nodes) {
      const d = fmtDate(displayAt(n))
      const i = layout.colOf.get(n.id) ?? 0
      const below = layout.sideOf.get(n.id) !== 'down'
      if (d !== last || i === 0) {
        marks.push({ x: i * SPACING + SPACING / 2, date: d, below })
        last = d
      }
    }
    return marks
  }, [nodes, layout])

  const wheelPageAt = useRef(0)
  /* 选中会话的首/末轮对话（详情区翻页显示，默认首轮；滚轮上下滚动切换首/末页） */
  interface TurnView { user: string; assistant: string; at: number }
  const [turnPage, setTurnPage] = useState<'first' | 'last'>('first')
  const [turnsData, setTurnsData] = useState<{ turns: number; first?: TurnView; last?: TurnView } | null>(null)
  useEffect(() => {
    setTurnsData(null)
    setTurnPage('first')
    if (selected === null) return
    const q = new URLSearchParams({ session: selected })
    if (workspace !== undefined) q.set('workspace', workspace)
    const ctrl = new AbortController()
    const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    fetch(API_BASE + '/turns?' + q.toString(), { signal: ctrl.signal })
      .then((r) => r.json() as Promise<{ ok?: boolean; turns?: number; first?: TurnView; last?: TurnView }>)
      .then((d) => { if (d?.ok === true) setTurnsData({ turns: d.turns ?? 0, first: d.first, last: d.last }) })
      .catch(() => { /* 保持 null，界面显示加载失败占位 */ })
      .finally(() => clearTimeout(tid))
    return () => { ctrl.abort() }
  }, [selected, workspace])

  /* 出入度（原生 + 手工），用于 handoff 强调判定与详情展示 */
  const degree = useMemo(() => {
    const m = new Map<string, { in: number; out: number }>()
    for (const n of nodes) m.set(n.id, { in: 0, out: 0 })
    for (const e of edges) {
      const f = m.get(e.from); const t = m.get(e.to)
      if (f !== undefined) f.out += 1
      if (t !== undefined) t.in += 1
    }
    for (const l of manualLinks) {
      const f = m.get(l.from); const t = m.get(l.to)
      if (f !== undefined) f.out += 1
      if (t !== undefined) t.in += 1
    }
    return m
  }, [nodes, edges, manualLinks])
  const childCount = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of edges) m.set(e.from, (m.get(e.from) ?? 0) + 1)
    return m
  }, [edges])

  /* 障碍集：全部节点框（外扩 2px）；跨边共享的通道占用表（拥挤惩罚） */
  const obstacles = useMemo<Obstacle[]>(() => nodes.map((n) => ({
    x: (layout.colOf.get(n.id) ?? 0) * SPACING + (SPACING - NODE_W) / 2 - OBST_PAD,
    y: nodeTop(layout, n.id) - OBST_PAD,
    w: NODE_W + OBST_PAD * 2,
    h: NODE_H + OBST_PAD * 2,
  })), [nodes, layout])
  const occupiedRef = useRef<Map<string, number>>(new Map())
  useEffect(() => { occupiedRef.current = new Map() }, [snap])

  /* handoff 连线引出/接入边优先级（用户规则）：
   * 引出（父）：down 框 = 下方（外侧底边），up 框 = 上方（外侧顶边）；
   *   从新到老次选左侧缘，从老到新次选右侧缘。
   * 接入（子）：从新到老主选右侧缘（次选下方/上方外侧边）；
   *   从老到新主选左侧缘（次选下方/上方外侧边）。
   * A* 依次尝试组合，可达（非兜底直连）即用。 */
  const routeEdge = (from: string, to: string, step: number): string => {
    const fEl = byId.get(from)
    const tEl = byId.get(to)
    if (fEl === undefined || tEl === undefined) return ''
    const fUp = (layout.sideOf.get(from) ?? 'up') === 'up'
    const tUp = (layout.sideOf.get(to) ?? 'up') === 'up'
    const fTop = nodeTop(layout, from)
    const tTop = nodeTop(layout, to)
    const fx = colX(layout, from)
    const tx = colX(layout, to)
    const j = (step % 3) - 1
    /* 引出/接入候选（用户矩阵，覆盖父在子左/右全部组合）：
     * 侧缘恒取父子相对的面向侧——父在子左 => 父出右缘、子入左缘；
     * 父在子右 => 父出左缘、子入右缘。
     * 引出主选 = 外侧边（down 底 / up 顶），次选面向侧缘；
     * 接入主选 = 面向侧缘，次选外侧边。 */
    const childOnRight = tx > fx
    const exitSideX = childOnRight ? fx + NODE_W / 2 + 3 : fx - NODE_W / 2 - 3
    const entrySideX = childOnRight ? tx - NODE_W / 2 - 3 : tx + NODE_W / 2 + 3
    /* 微扰沿边滑动（j*10/j*6），不垂直推回框内——否则起终点落回障碍内而孤立 */
    const exitCandidates = [
      { x: fx + j * 10, y: fUp ? fTop - 3 : fTop + NODE_H + 3 },
      { x: exitSideX, y: fTop + NODE_H / 2 + j * 6 },
    ]
    const entryCandidates = [
      { x: entrySideX, y: tTop + NODE_H / 2 + j * 6 },
      { x: tx + j * 10, y: tUp ? tTop - 3 : tTop + NODE_H + 3 },
    ]
    const occ = occupiedRef.current
    let fallback: string | null = null
    for (const ec of exitCandidates) {
      for (const en of entryCandidates) {
        const d = routeOrthogonal(obstacles, ec.x, ec.y, en.x, en.y, occ)
        if (d === '') continue
        /* 2 点直连 = A* 判定不可达的兜底；换下一组合 */
        const segs = (d.match(/L/g) || []).length
        if (segs >= 1) return d
        if (fallback === null) fallback = d
      }
    }
    return fallback ?? ''
  }

  const bucketTail = (bucket: string): string => {
    const w = (workspaces ?? []).find((x) => x.bucket === bucket)
    if (w !== undefined && w.cwd !== null && w.cwd !== '') return w.cwd.split('/').filter(Boolean).pop() ?? w.cwd
    return bucket.replaceAll('-', '/').split('/').filter(Boolean).pop() ?? bucket
  }

  const act = async (action: 'link' | 'unlink', from: string, to: string): Promise<void> => {
    setBusy(true)
    setMsg(null)
    const payload: Record<string, unknown> = { from, to }
    if (workspace !== undefined) payload.workspace = workspace
    else if (sessionId !== undefined) payload.session = sessionId
    const r = await post(action, payload)
    setBusy(false)
    if (r === null) { setMsg('请求失败（网络/服务不可达），稍后自动重试轮询'); return }
    if (r.ok !== true) { setMsg(r.error ?? '操作失败'); return }
    if (action === 'link') setMsg(r.duplicate === true ? '已存在手工衔接' : '已建立手工衔接')
    else setMsg('已断开手工衔接')
    refresh()
  }

  /* 拖拽：pointerdown 于节点 → window 追踪 → pointerup 命中另一节点则连线。 */
  useEffect(() => {
    if (drag === null) return
    const move = (ev: PointerEvent): void => {
      const rect = innerRef.current?.getBoundingClientRect()
      const nx = rect !== undefined ? (ev.clientX - rect.left) / zoom : 0
      const ny = rect !== undefined ? (ev.clientY - rect.top) / zoom : 0
      setDrag((d) => d === null ? d : { ...d, x: nx, y: ny, moved: d.moved || Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) > 5 })
    }
    const finish = (ev: PointerEvent): void => {
      const cur = dragRef.current
      setDrag(null)
      if (cur === null) return
      if (!cur.moved) { setSelected((s) => (s === cur.from ? null : cur.from)); return }
      const el = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest?.('[data-node-id]') as HTMLElement | null
      const target = el?.getAttribute('data-node-id') ?? null
      if (target !== null && target !== cur.from) void act('link', cur.from, target)
    }
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
  }, [drag === null ? null : drag.from, workspace, sessionId, zoom])

  if (snap === undefined) {
    return h('div', { style: { color: DIM, fontSize: 12.5, padding: 12 } }, '加载中…')
  }
  if (snap.ok !== true) {
    return h('div', { style: { color: DIM, fontSize: 12.5, padding: 12 } }, snap.error ?? '')
  }

  const sel = selected !== null ? byId.get(selected) : undefined
  const selManualIn = sel !== undefined ? manualLinks.filter((l) => l.to === sel.id) : []
  const selManualOut = sel !== undefined ? manualLinks.filter((l) => l.from === sel.id) : []
  const selNativeOut = sel !== undefined ? edges.filter((e) => e.from === sel.id) : []
  const titleOf = (id: string): string => byId.get(id)?.title ?? shortId(id)
  const wsLabel = (w: Workspace): string => {
    const tail = w.cwd !== null && w.cwd !== '' ? w.cwd.split('/').filter(Boolean).pop() ?? w.cwd : w.bucket
    return tail + '（' + String(w.sessions) + '）'
  }
  const handoffCount = edges.filter((e) => e.kind === 'handoff').length
  const branchCount = edges.filter((e) => e.kind === 'branch').length

  const nodeCard = (n: SNode): unknown => {
    const i = layout.colOf.get(n.id) ?? 0
    const up = layout.sideOf.get(n.id) !== 'down'
    const top = nodeTop(layout, n.id)
    const isDragSrc = drag !== null && drag.moved && drag.from === n.id
    const isSel = selected === n.id
    const deg = degree.get(n.id)
    const nudgeFirst = n.handoffFirst && (deg?.in ?? 0) === 0
    const nudgeLast = n.handoffLast && (deg?.out ?? 0) === 0
    let border = 'var(--dsw-alias-border-primary, rgba(128,128,128,0.35))'
    let shadow = 'none'
    if (nudgeFirst) border = FIRST_NUDGE
    else if (nudgeLast) border = LAST_NUDGE
    if (nudgeFirst && nudgeLast) shadow = 'inset 0 0 0 2px ' + LAST_NUDGE
    if (isSel) shadow = (shadow === 'none' ? '' : shadow + ', ') + '0 0 0 2px ' + ACCENT
    else if (isDragSrc) shadow = '0 0 0 2px ' + MANUAL
    const kids = childCount.get(n.id) ?? 0
    return h('div', {
      key: n.id,
      'data-node-id': n.id,
      title: (n.title ?? n.id) + '\n双击切换到该会话；拖到另一节点建立手工衔接',
      style: {
        position: 'absolute',
        left: i * SPACING + (SPACING - NODE_W) / 2,
        top,
        width: NODE_W,
        height: NODE_H,
        boxSizing: 'border-box',
        borderRadius: 8,
        border: (nudgeFirst || nudgeLast) ? '2px solid ' + border : '1px solid ' + border,
        boxShadow: shadow,
        opacity: isDragSrc ? 0.55 : 1,
        padding: (nudgeFirst || nudgeLast) ? '5px 7px' : '6px 8px',
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        overflow: 'hidden',
        cursor: 'grab',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        background: 'var(--dsw-alias-surface-raised, rgba(128,128,128,0.06))',
        touchAction: 'none',
      },
      onPointerDown: (ev: React.PointerEvent): void => {
        if (ev.button !== 0) return
        ev.preventDefault()
        setDrag({
          from: n.id,
          x: i * SPACING + SPACING / 2,
          y: top + NODE_H,
          sx: ev.clientX,
          sy: ev.clientY,
          moved: false,
        })
      },
      onDoubleClick: (): void => {
        setSelected(n.id)
        openSession(n.id)
      },
    },
      h('div', { style: { color: DIM, fontSize: 10.5, fontFamily: MONO } }, fmt(displayAt(n))),
      h('div', {
        style: {
          fontSize: 12,
          lineHeight: 1.3,
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          minHeight: 31,
        },
      }, n.title ?? '（无标题）'),
      h('div', { style: { display: 'flex', gap: 4, marginTop: 'auto', flexWrap: 'wrap' } },
        n.handoffSeed ? h(P.Tag, { tone: 'info' }, 'handoff') : null,
        kids >= 2 ? h(P.Tag, { tone: 'info' }, '⑂' + String(kids)) : null,
        nudgeFirst ? h(P.Tag, { tone: 'info' }, '待接前驱') : null,
        nudgeLast ? h(P.Tag, { tone: 'warning' }, '待接后继') : null,
        n.parent !== null && !byId.has(n.parent) ? h(P.Tag, { tone: 'quiet' }, '外部父') : null,
      ),
    )
  }

  const axisY = layout.axisY

  return h('div', {
    style: {
      height: '100%', overflow: 'hidden', boxSizing: 'border-box',
      padding: '8px 12px 12px', display: 'flex', flexDirection: 'column', gap: 8,
    },
  },
    /* 头部：全局开关 + 工作区选择 + 统计 + 刷新 */
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: DIM, flexWrap: 'wrap' } },
      h('select', {
        value: workspace ?? snap.bucket ?? '',
        style: {
          fontSize: 12, maxWidth: 150, padding: '2px 4px', borderRadius: 6,
          border: '1px solid var(--dsw-alias-border-primary, rgba(128,128,128,0.35))',
          background: 'var(--dsw-alias-surface-raised, transparent)', color: 'inherit',
        },
        onChange: (ev: React.ChangeEvent<HTMLSelectElement>): void => {
          setSelected(null)
          setWorkspace(ev.target.value === '' ? undefined : ev.target.value)
        },
      },
        h('option', { value: snap.bucket ?? '' }, snap.bucket === undefined ? '当前工作区' : '本会话工作区'),
        ...(workspaces ?? [])
          .filter((w) => w.bucket !== snap.bucket)
          .map((w) => h('option', { key: w.bucket, value: w.bucket, title: w.cwd ?? w.bucket }, wsLabel(w))),
      ),
      h('select', {
        value: newestFirst ? 'newOld' : 'oldNew',
        title: '时间方向',
        style: {
          fontSize: 12, padding: '2px 4px', borderRadius: 6,
          border: '1px solid var(--dsw-alias-border-primary, rgba(128,128,128,0.35))',
          background: 'var(--dsw-alias-surface-raised, transparent)', color: 'inherit',
        },
        onChange: (ev: React.ChangeEvent<HTMLSelectElement>): void => {
          setSelected(null)
          setNewestFirst(ev.target.value === 'newOld')
        },
      },
        h('option', { value: 'oldNew' }, '从老到新'),
        h('option', { value: 'newOld' }, '从新到老'),
      ),
      h('select', {
        value: sortBy,
        title: '排序方式',
        style: {
          fontSize: 12, padding: '2px 4px', borderRadius: 6,
          border: '1px solid var(--dsw-alias-border-primary, rgba(128,128,128,0.35))',
          background: 'var(--dsw-alias-surface-raised, transparent)', color: 'inherit',
        },
        onChange: (ev: React.ChangeEvent<HTMLSelectElement>): void => {
          setSelected(null)
          setSortBy(ev.target.value === 'lastAt' ? 'lastAt' : 'createdAt')
        },
      },
        h('option', { value: 'createdAt' }, '按创建时间'),
        h('option', { value: 'lastAt' }, '按最后活动'),
      ),
      h('span', null,
        String(nodes.length) + ' 会话 · 衔接 ' + String(handoffCount) +
        ' · 分支 ' + String(branchCount) + ' · 手工 ' + String(manualLinks.length) +
        ((snap.unreadable ?? 0) > 0 ? ' · ' + String(snap.unreadable ?? 0) + ' 个不可读' : '')),
      msg !== null ? h('span', { style: { color: MANUAL, fontSize: 11.5 } }, msg) : null,
      h('span', { style: { marginLeft: 'auto' } },
        h(P.Button, {
          variant: 'ghost', size: 'sm', disabled: busy,
          onClick: (): void => {
            refresh()
            void fetchWorkspaces().then((ws) => { if (ws !== null) setWorkspaces(ws) })
          },
        }, '刷新')),
    ),
    /* 鱼骨时间线：横向 + 纵向滚动；左上角缩放控件 + 滚轮联动 */
    h('div', { style: { position: 'relative', flex: '0 0 auto' } },
      /* 缩放控件（窗口左上角浮层，置顶不被内容遮挡） */
      h('div', {
        style: {
          position: 'absolute', left: 8, top: 8, zIndex: 50,
          display: 'flex', alignItems: 'center', gap: 2,
          padding: '2px 6px', borderRadius: 6,
          boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
          background: 'var(--dsw-alias-surface-overlay, var(--dsw-alias-surface-primary, #1a1c20))',
          border: '1px solid var(--dsw-alias-border-primary, rgba(128,128,128,0.3))',
          fontSize: 11.5, fontFamily: MONO, userSelect: 'none',
        },
      },
        h('span', {
          title: '缩小（10%）',
          style: { cursor: 'pointer', padding: '0 5px', color: zoom > 0.1 + 1e-9 ? 'inherit' : DIM },
          onClick: (): void => setZoom((z) => clampZoom(z - 0.1)),
        }, '−'),
        h('span', { style: { minWidth: 40, textAlign: 'center' } }, String(Math.round(zoom * 100)) + '%'),
        h('span', {
          title: '放大（10%）',
          style: { cursor: 'pointer', padding: '0 5px', color: zoom < 3 - 1e-9 ? 'inherit' : DIM },
          onClick: (): void => setZoom((z) => clampZoom(z + 0.1)),
        }, '+'),
      ),
      h('div', {
        ref: viewportRef,
        style: {
          overflowX: 'auto', overflowY: 'auto',
          height: TIMELINE_MAX_H,
          border: '1px solid var(--dsw-alias-border-primary, rgba(128,128,128,0.25))',
          borderRadius: 8,
        },
      },
        /* sizer：占位缩放后的布局尺寸，使滚动范围正确 */
        h('div', { style: { width: layout.innerW * zoom, height: layout.innerH * zoom, overflow: 'hidden' } },
          h('div', {
            ref: innerRef,
            style: {
              position: 'relative', width: layout.innerW, height: layout.innerH,
              userSelect: 'none', WebkitUserSelect: 'none',
              transform: 'scale(' + String(zoom) + ')', transformOrigin: '0 0',
            },
          },
        h('svg', {
          width: layout.innerW, height: layout.innerH,
          style: { position: 'absolute', inset: 0, pointerEvents: 'none' },
        },
          h('defs', null,
            h('marker', { id: 'st-arrow-handoff', markerWidth: 7, markerHeight: 7, refX: 6, refY: 3.5, orient: 'auto' },
              h('path', { d: 'M0,0 L7,3.5 L0,7 z', fill: ACCENT })),
            h('marker', { id: 'st-arrow-branch', markerWidth: 7, markerHeight: 7, refX: 6, refY: 3.5, orient: 'auto' },
              h('path', { d: 'M0,0 L7,3.5 L0,7 z', fill: BRANCH })),
            h('marker', { id: 'st-arrow-manual', markerWidth: 7, markerHeight: 7, refX: 6, refY: 3.5, orient: 'auto' },
              h('path', { d: 'M0,0 L7,3.5 L0,7 z', fill: MANUAL })),
            h('marker', { id: 'st-arrow-axis', markerWidth: 10, markerHeight: 8, refX: 8, refY: 4, orient: 'auto' },
              h('path', { d: 'M0,0 L9,4 L0,8 z', fill: AXIS })),
          ),
          /* 主轴：中央水平线 + 末端箭头（从新到老时朝左、箭头在最左端） */
          h('line', {
            x1: newestFirst ? layout.innerW - 8 : 8, y1: axisY,
            x2: newestFirst ? 14 : layout.innerW - 14, y2: axisY,
            stroke: AXIS, strokeWidth: 1.4, opacity: 0.7,
            markerEnd: 'url(#st-arrow-axis)',
          }),
          /* 日期刻度 + 文字（放鱼刺对侧） */
          ...dateMarks.map((m, i) => h('g', { key: 'd' + String(i) },
            h('line', {
              x1: m.x, y1: m.below ? axisY - 4 : axisY, x2: m.x, y2: m.below ? axisY : axisY + 4,
              stroke: AXIS, strokeWidth: 1.2, opacity: 0.8,
            }),
            h('text', {
              x: m.x, y: m.below ? axisY + 14 : axisY - 6,
              textAnchor: 'middle',
              fontSize: 10.5,
              fontFamily: MONO,
              fill: AXIS,
              opacity: 0.85,
            }, m.date),
          )),
          /* 鱼刺：全部节点都贴框居中竖直连到主轴。
           * 深度行与轴之间的同列框体不画线（接力分段）：每列每侧按深度排序，
           * 画 [轴 -> 最浅框近轴边]、[上一框远轴边 -> 下一框近轴边] 等空隙段 */
          ...(() => {
            const groups = new Map()
            for (const n of nodes) {
              const up = layout.sideOf.get(n.id) !== 'down'
              const depth = layout.depthOf.get(n.id) ?? 0
              const top = nodeTop(layout, n.id)
              const key = String(layout.colOf.get(n.id) ?? 0) + '|' + (up ? 'up' : 'down')
              const list = groups.get(key) ?? []
              list.push({ top, near: up ? top + NODE_H : top, far: up ? top : top + NODE_H, depth })
              groups.set(key, list)
            }
            const lines = []
            let fi = 0
            for (const [key, list] of groups) {
              const cx = Number(key.split('|')[0]) * SPACING + SPACING / 2
              list.sort((a, b) => a.depth - b.depth)
              let prevY = axisY
              for (const b of list) {
                if (Math.abs(prevY - b.near) > 2) {
                  lines.push(h('line', {
                    key: 'f' + String(fi++),
                    x1: cx, y1: prevY, x2: cx, y2: b.near,
                    stroke: AXIS, strokeWidth: 1.2, opacity: 0.45,
                  }))
                }
                prevY = b.far
              }
            }
            return lines
          })(),
          /* 原生血缘弯折线：蓝 = handoff，紫 = 分支（箭头向右进子左侧） */
          ...edges.map((e, i) => {
            if (!layout.colOf.has(e.from) || !layout.colOf.has(e.to)) return null
            const color = e.kind === 'branch' ? BRANCH : ACCENT
            return h('path', {
              key: 'n' + String(i),
              d: routeEdge(e.from, e.to, i),
              fill: 'none',
              stroke: color,
              strokeWidth: 1.6,
              markerEnd: e.kind === 'branch' ? 'url(#st-arrow-branch)' : 'url(#st-arrow-handoff)',
              opacity: 0.85,
            })
          }),
          /* 手工弯折线（虚线橙，箭头向右进目标左侧） */
          ...manualLinks.map((l, i) => {
            if (!layout.colOf.has(l.from) || !layout.colOf.has(l.to)) return null
            return h('path', {
              key: 'm' + String(i),
              d: routeEdge(l.from, l.to, i + 2),
              fill: 'none',
              stroke: MANUAL,
              strokeWidth: 1.6,
              strokeDasharray: '6 4',
              markerEnd: 'url(#st-arrow-manual)',
              opacity: 0.9,
            })
          }),
          /* 拖拽幽灵线 */
          drag !== null && drag.moved
            ? h('line', {
                x1: colX(layout, drag.from), y1: nodeTop(layout, drag.from) + NODE_H / 2,
                x2: drag.x, y2: drag.y,
                stroke: MANUAL, strokeWidth: 1.6, strokeDasharray: '4 4',
              })
            : null,
        ),
        ...nodes.map((n) => nodeCard(n)),
          ),
        ),
      ),
    ),
    /* 详情区：选中节点 */
    sel === undefined
      ? h('div', { style: { color: DIM, fontSize: 12 } },
          '会话按创建时间分布在时间轴上下（handoff 链向轴外侧叠深度行）；拖动节点到另一节点建立手工衔接；双击切换到该会话。弯折线：蓝 = handoff 衔接、紫 = 分支、虚线橙 = 手工衔接（均从左侧进入目标）。紫框 = 首对话调用过 handoff 且无前驱；金框 = 末对话调用过 handoff 且无后继；handoff 标签 = 首条消息含 handoff 文档。')
      : h('div', {
          title: '滚轮上下滚动切换：首轮 ⇄ 末轮',
          onWheel: (ev: React.WheelEvent): void => {
            const now = Date.now()
            if (now - wheelPageAt.current < 300) return
            wheelPageAt.current = now
            setTurnPage(ev.deltaY > 0 ? 'last' : 'first')
          },
          style: {
            flex: '1 1 auto', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6,
            border: '1px solid var(--dsw-alias-border-primary, rgba(128,128,128,0.25))',
            borderRadius: 8, padding: '8px 10px', minHeight: 0,
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('div', { style: { fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              sel.title ?? '（无标题）'),
            h(P.Button, { variant: 'ghost', size: 'sm', onClick: (): void => openSession(sel.id) }, '切换到该会话'),
          ),
          h('div', { style: { color: DIM, fontSize: 11.5, fontFamily: MONO } },
            shortId(sel.id) + ' · 活动至 ' + fmtFull(sel.lastAt) +
            '（创建 ' + fmt(sel.createdAt) + '）' +
            (sel.logCreatedAt > 0 && sel.logCreatedAt !== sel.createdAt
              ? ' · 日志创建 ' + fmt(sel.logCreatedAt) : '') +
            ' · ' + bucketTail(sel.bucket) +
            (sel.handoffSeed ? ' · handoff 新会话' : (sel.seeded ? ' · 种子' : ''))),
          sel.parent === null
            ? h('div', { style: { fontSize: 12, color: DIM } }, '血缘：无父会话（根会话）')
            : byId.has(sel.parent)
              ? h('div', { style: { fontSize: 12 } }, '血缘：衔接自「' + titleOf(sel.parent) + '」' +
                  ((childCount.get(sel.parent) ?? 0) >= 2 ? '（分支）' : ''))
              : h('div', { style: { fontSize: 12, color: DIM } },
                  '血缘：父会话 ' + shortId(sel.parent) + ' 不在当前视图（跨区 handoff 或已删除）'),
          sel.handoffFirst || sel.handoffLast
            ? h('div', { style: { fontSize: 12 } },
                'handoff skill：' +
                (sel.handoffFirst ? '首个对话' + ((degree.get(sel.id)?.in ?? 0) === 0 ? '（待接前驱·紫）' : '') : '') +
                (sel.handoffFirst && sel.handoffLast ? ' + ' : '') +
                (sel.handoffLast ? '最后对话' + ((degree.get(sel.id)?.out ?? 0) === 0 ? '（待接后继·金）' : '') : ''))
            : null,
          selNativeOut.length > 0
            ? h('div', { style: { fontSize: 12 } },
                '衔接到：' + selNativeOut.map((e) => '「' + titleOf(e.to) + '」' + (e.kind === 'branch' ? '（分支）' : '')).join('、'))
            : null,
          /* 首/末轮对话（翻页，默认首轮；内容区滚轮上下滑动） */
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h(P.Button, {
              variant: turnPage === 'first' ? 'primary' : 'ghost', size: 'sm',
              onClick: (): void => setTurnPage('first'),
            }, '首轮对话'),
            h(P.Button, {
              variant: turnPage === 'last' ? 'primary' : 'ghost', size: 'sm',
              onClick: (): void => setTurnPage('last'),
            }, '末轮对话'),
            h('span', { style: { color: DIM, fontSize: 11 } },
              turnsData === null ? '' : '（共 ' + String(turnsData.turns) + ' 轮；框内滚轮看内容，框外滚轮切页）'),
          ),
          h('div', {
            title: '滚轮上下滑动翻看对话内容',
            onWheel: (ev: React.WheelEvent): void => { ev.stopPropagation() },
            style: {
              maxHeight: 180, overflowY: 'auto', fontSize: 12, lineHeight: 1.45,
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              padding: '6px 8px', borderRadius: 6,
              background: 'var(--dsw-alias-surface-raised, rgba(128,128,128,0.06))',
            },
          },
            turnsData === null
              ? h('span', { style: { color: DIM } }, '加载中…')
              : (() => {
                  const t = turnPage === 'first' ? turnsData.first : turnsData.last
                  if (t === undefined) return h('span', { style: { color: DIM } }, '无对话内容')
                  return [
                    h('div', { key: 'u', style: { marginBottom: 6 } },
                      h('span', { style: { color: ACCENT, fontWeight: 600 } }, '用户：'),
                      t.user === '' ? h('span', { style: { color: DIM } }, '（无文本）') : t.user),
                    h('div', { key: 'a' },
                      h('span', { style: { color: BRANCH, fontWeight: 600 } }, '助手：'),
                      t.assistant === '' ? h('span', { style: { color: DIM } }, '（本轮暂无助手回复）') : t.assistant),
                  ]
                })(),
          ),
          selManualIn.length + selManualOut.length > 0
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                ...selManualIn.map((l) => h('div', { key: 'in' + l.from + l.to, style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 } },
                  h('span', null, '← 手工衔接自「' + titleOf(l.from) + '」'),
                  h(P.Button, {
                    variant: 'ghost', size: 'sm', disabled: busy,
                    onClick: () => { void act('unlink', l.from, l.to) },
                  }, '断开'))),
                ...selManualOut.map((l) => h('div', { key: 'out' + l.from + l.to, style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 } },
                  h('span', null, '→ 手工衔接到「' + titleOf(l.to) + '」'),
                  h(P.Button, {
                    variant: 'ghost', size: 'sm', disabled: busy,
                    onClick: () => { void act('unlink', l.from, l.to) },
                  }, '断开'))),
              )
            : h('div', { style: { fontSize: 12, color: DIM } }, '手工衔接：无'),
        ),
  )
}

/** 页签标题：文字 + 会话数（轻轮询，当前会话工作区）。 */
function TabTitle(props: { sessionId?: string }): unknown {
  const { sessionId } = props
  const [count, setCount] = useState(0)

  useEffect(() => {
    if (sessionId === undefined) return
    const tick = (): void => {
      const ctrl = new AbortController()
      const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
      fetch(listUrl(undefined, sessionId), { signal: ctrl.signal })
        .then((r) => r.json())
        .then((data: Snapshot) => setCount(data?.ok === true ? (data.sessions?.length ?? 0) : 0))
        .catch(() => { /* 保上次值 */ })
        .finally(() => clearTimeout(tid))
    }
    tick()
    const t = setInterval(tick, 12000)
    return () => clearInterval(t)
  }, [sessionId])

  return h('span', null, PANEL_TITLE + (count > 0 ? '（' + String(count) + '）' : ''))
}

export function apply(ctx: Ctx): void {
  const openSession = (id: string): void => {
    try {
      ctx.uiWorkspace?.openSession(id)
    } catch { /* 服务缺失时静默（仅本面板失效） */ }
  }
  const Panel = (props: { sessionId?: string }): unknown =>
    h(PanelBoundary, null, h(PanelBody, { sessionId: props.sessionId, openSession }))

  // 段一：页签类型（guide 入口卡；点卡 = openTab('session-timeline')）
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    priority: 'extension',
    title: () => PANEL_TITLE,
    guide: [{
      id: 'session-timeline',
      order: 91,
      title: () => PANEL_TITLE,
      description: () => '鱼骨时间线：会话按创建时间交替分布在主轴上下，handoff/分支血缘弯折线衔接；可切全局时间线，拖动节点手工衔接，双击切换会话',
      icon: P.IconBranchOutlineRegular,
    }],
  }), 'session-timeline: tab type')
  // 段二：页签正文（key = 定义 id）
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: TAB_ID },
    Panel,
  )), 'session-timeline: tab body')
  // 段三：页签标题（带本工作区会话数）
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: TAB_ID },
    TabTitle,
  )), 'session-timeline: tab title')
}
