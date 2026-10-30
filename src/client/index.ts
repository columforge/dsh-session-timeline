/**
 * @dsh-external/session-timeline — client：右侧边栏页签（会话时间线）。
 * 鱼骨时间线：中央水平主轴（右端箭头），轴上日期刻度（YY-MM-DD，日期变化
 * 处标注、文字放鱼刺对侧）；会话按创建时间从左到右交替分布在轴上下两侧，
 * 鱼刺竖线连到轴。血缘链 = 原生边（handoff/分支）∪ 手工衔接，链上语义
 * （出入度、分支判定、⑂N 徽章、连线显形类别）按合并链计算（纯函数见
 * ../geometry/lineage）：原生为实线弯折线（父近轴边 → 轴侧通道 →
 * 水平至子列 → 进子节点左侧，蓝 = 链式、紫 = 扇出）；手工衔接为橙色
 * 虚线弯折线（同向左侧入口，扇出时原生边同样显形为分支紫）。
 * 「handoff」标签 = 调用过 handoff skill（handoffUsed）或以 handoff 种子
 * 开场（isSeeded）——不按首条消息含 handoff 字样判定。首对话调用过
 * handoff skill 且无前驱 → 紫框（待接前驱）；消息中出现过 handoff skill
 * 调用（不限末窗口）且无后继 → 金框（待接后继）；选中详情区列出每次调用
 * 的轮次/时间/消息 seq。
 * 双击节点 = 切换到该会话；头部「全局时间线」开关聚合所有工作区。
 * 交互三通道互不干扰：滚轮 = 浏览器原生滚动（Ctrl+滚轮 = 浏览器整体缩放，
 * 均不拦截）；画布空白处左键拖拽 = 平移（节点上拖拽仍是手工衔接）；
 * 画布缩放只走左上角 −/+ 控件（±10%，视口中心锚定；点击百分比复位 100%）。
 * 构建：tsdown → lib/client.js（ModuleLoader 注册）。
 * ⚠️ client 须 export const inject；slots.register 必须带 name 字段。
 */
const React = require('react') as typeof import('react')
import {
  computeLayout, colX, nodeTop, SPACING, NODE_W, NODE_H,
} from '../geometry/layout.js'
import { routeEdgePath, OBST_PAD, type Obstacle } from '../geometry/routing.js'
import { lineageDegrees, displayKind } from '../geometry/lineage.js'
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

/** 面板当前所选工作区（null = 跟随当前会话所属桶）。页签标题据此计数，
 *  与面板内容保持一致；面板卸载时复位。 */
const viewBucket: { value: string | null; listeners: Set<() => void> } = { value: null, listeners: new Set() }
function setViewBucket(value: string | null): void {
  if (viewBucket.value === value) return
  viewBucket.value = value
  for (const listener of [...viewBucket.listeners]) listener()
}
function subscribeViewBucket(listener: () => void): () => void {
  viewBucket.listeners.add(listener)
  return () => { viewBucket.listeners.delete(listener) }
}

/** UI 侧面板高度上限；几何常量与纯函数见 ../geometry（单测覆盖）。 */
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
  cwd: string | null
  bucket: string
  handoffFirst: boolean
  /** 消息中出现任意 handoff skill 调用（待接后继金框判据，不限末窗口） */
  handoffUsed: boolean
  /** handoff skill 调用明细（seq/time/轮次，按日志顺序） */
  handoffHits: { seq: number; at: number; turn: number }[]
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

/* 空态图例小件：连线色卡（实/虚）、框色卡、标签徽章 */
const legendLine = (color: string, dashed: boolean, label: string): unknown =>
  h('span', { key: label, style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
    h('span', { style: { display: 'inline-block', width: 22, height: 0, borderTop: '2px ' + (dashed ? 'dashed ' : 'solid ') + color } }),
    h('span', null, label))
const legendFrame = (color: string, label: string): unknown =>
  h('span', { key: label, style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
    h('span', { style: { display: 'inline-block', width: 11, height: 11, borderRadius: 3, border: '2px solid ' + color, boxSizing: 'border-box' } }),
    h('span', null, label))
const legendTag = (label: string): unknown =>
  h('span', { key: label, style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
    h(P.Tag, { tone: 'info' }, 'handoff'),
    h('span', null, label))

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

  /* 同步面板所选工作区给页签标题（null = 跟随当前会话所属桶） */
  useEffect(() => {
    setViewBucket(workspace ?? null)
    return () => setViewBucket(null)
  }, [workspace])

  /* 当前会话所属桶（工作区下拉首项 = 跟随它；首次加载快照时捕获） */
  const sessionBucketRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (workspace === undefined && snap?.bucket !== undefined) sessionBucketRef.current = snap.bucket
  }, [workspace, snap])

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

  /* 缩放：100% = 原始比例；只走左上角控件（−/+ ±10%，点击百分比复位 100%），
   * 围绕视口中心锚定。滚轮不参与缩放——让位浏览器原生滚动（上下滑动）与
   * 浏览器整体缩放（Ctrl+滚轮），三通道互不干扰，缩放无模式、不存在退出问题。 */
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [zoom, setZoom] = useState(1)
  const clampZoom = (z: number): number => Math.max(0.1, Math.min(3, z))
  const applyZoom = (next: number, cx?: number, cy?: number): void => {
    const vp = viewportRef.current
    const prev = zoom
    const z = clampZoom(next)
    if (vp !== undefined && vp !== null && cx !== undefined && cy !== undefined) {
      // 围绕锚点缩放：保持锚点下的布局点视觉位置不变
      const k = z / prev
      vp.scrollLeft = (vp.scrollLeft + cx) * k - cx
      vp.scrollTop = (vp.scrollTop + cy) * k - cy
    }
    setZoom(z)
  }
  const zoomAtCenter = (next: number): void => {
    const vp = viewportRef.current
    if (vp === null) { setZoom(clampZoom(next)); return }
    applyZoom(next, vp.clientWidth / 2, vp.clientHeight / 2)
  }

  /* 画布平移：空白处（非节点）按住左键拖拽 → 1:1 移动视口滚动条（grab →
   * grabbing；setPointerCapture 兜底出窗收尾）。节点上的拖拽仍是手工衔接
   * 连线——入口按 data-node-id 分流；触屏不拦截（原生触摸滚动已可用）。 */
  const panStartRef = useRef<{ x: number; y: number; sl: number; st: number } | null>(null)
  const [panning, setPanning] = useState(false)
  const onViewportPointerDown = (ev: React.PointerEvent): void => {
    if (ev.pointerType !== 'mouse' || ev.button !== 0) return
    const target = ev.target as Element | null
    if (target !== null && typeof target.closest === 'function' &&
        target.closest('[data-node-id]') !== null) return
    const vp = viewportRef.current
    if (vp === null) return
    ev.preventDefault()
    try { vp.setPointerCapture(ev.pointerId) } catch { /* 指针已失效时忽略 */ }
    panStartRef.current = { x: ev.clientX, y: ev.clientY, sl: vp.scrollLeft, st: vp.scrollTop }
    setPanning(true)
  }
  useEffect(() => {
    if (!panning) return
    const move = (ev: PointerEvent): void => {
      const p = panStartRef.current
      const vp = viewportRef.current
      if (p === null || vp === null) return
      vp.scrollLeft = p.sl - (ev.clientX - p.x)
      vp.scrollTop = p.st - (ev.clientY - p.y)
    }
    const finish = (): void => {
      panStartRef.current = null
      setPanning(false)
    }
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
  }, [panning])
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

  /* 选中会话的轮次条：横向排列，每轮一根横条（首/末轮较大，handoff 调用轮
   * 金色高亮）；点击任意条展示该轮对话——首/末/handoff 轮内容随 /turns 附带，
   * 其余轮按需取 /turns&turn=N（fetchedTurns 缓存）。末轮即 handoff 轮时单条
   * 同时具备两语义，不再重复显示。 */
  interface TurnView { user: string; assistant: string; at: number }
  interface HandoffTurnView extends TurnView { turn: number }
  const wheelPageAt = useRef(0)
  const [selTurn, setSelTurn] = useState<number>(1)
  const [turnsData, setTurnsData] = useState<{ turns: number; first?: TurnView; last?: TurnView; handoffTurns?: HandoffTurnView[] } | null>(null)
  const [fetchedTurns, setFetchedTurns] = useState<Map<number, TurnView>>(new Map())
  useEffect(() => {
    setTurnsData(null)
    setFetchedTurns(new Map())
    setSelTurn(1)
    if (selected === null) return
    const q = new URLSearchParams({ session: selected })
    if (workspace !== undefined) q.set('workspace', workspace)
    const ctrl = new AbortController()
    const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    fetch(API_BASE + '/turns?' + q.toString(), { signal: ctrl.signal })
      .then((r) => r.json() as Promise<{ ok?: boolean; turns?: number; first?: TurnView; last?: TurnView; handoffTurns?: HandoffTurnView[] }>)
      .then((d) => { if (d?.ok === true) setTurnsData({ turns: d.turns ?? 0, first: d.first, last: d.last, handoffTurns: d.handoffTurns ?? [] }) })
      .catch(() => { /* 保持 null，界面显示加载失败占位 */ })
      .finally(() => clearTimeout(tid))
    return () => { ctrl.abort() }
  }, [selected, workspace])

  /** 轮 T 的对话内容：首/末/handoff 轮随 /turns 附带；其余取按需缓存 */
  const turnContent = (turn: number): TurnView | undefined => {
    if (turnsData === null || turn < 1 || turn > turnsData.turns) return undefined
    if (turn === 1) return turnsData.first
    if (turn === turnsData.turns) return turnsData.last
    const ht = (turnsData.handoffTurns ?? []).find((x) => x.turn === turn)
    if (ht !== undefined) return ht
    return fetchedTurns.get(turn)
  }
  const fetchTurn = (turn: number): void => {
    if (selected === null || fetchedTurns.has(turn)) return
    const q = new URLSearchParams({ session: selected, turn: String(turn) })
    if (workspace !== undefined) q.set('workspace', workspace)
    const ctrl = new AbortController()
    const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    fetch(API_BASE + '/turns?' + q.toString(), { signal: ctrl.signal })
      .then((r) => r.json() as Promise<{ ok?: boolean; data?: TurnView }>)
      .then((d) => {
        if (d?.ok === true && d.data !== undefined) {
          setFetchedTurns((prev) => { const next = new Map(prev); next.set(turn, d.data as TurnView); return next })
        }
      })
      .catch(() => { /* 保持占位 */ })
      .finally(() => clearTimeout(tid))
  }
  const selectTurn = (turn: number): void => {
    setSelTurn(turn)
    if (turnContent(turn) === undefined) fetchTurn(turn)
  }

  /* 血缘链合并出入度（原生 + 手工同权）：金紫框判据、⑂N 徽章、分支显形
   * 判定、详情区血缘/衔接到叙述共用一份（纯函数 lineageDegrees）。 */
  const degree = useMemo(() => lineageDegrees(edges, manualLinks), [edges, manualLinks])

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
    if (!byId.has(from) || !byId.has(to)) return ''
    return routeEdgePath({ layout, obstacles, occupied: occupiedRef.current, from, to, step })
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
  /* 合并链叙述：后继 = 原生出边 + 手工出边（详情「衔接到」行共用；
   * 手工出边带 unlink 引用，供内联断开按钮）。 */
  const selOut = sel !== undefined
    ? [
        ...edges.filter((e) => e.from === sel.id).map((e) => ({
          id: e.to,
          mark: displayKind(e, degree) === 'branch' ? '（分支）' : '',
          unlink: null as { from: string; to: string } | null,
        })),
        ...selManualOut.map((l) => ({ id: l.to, mark: '（手工）', unlink: { from: l.from, to: l.to } as { from: string; to: string } | null })),
      ]
    : []
  const titleOf = (id: string): string => byId.get(id)?.title ?? shortId(id)
  const wsLabel = (w: Workspace): string => {
    const tail = w.cwd !== null && w.cwd !== '' ? w.cwd.split('/').filter(Boolean).pop() ?? w.cwd : w.bucket
    return tail + '（' + String(w.sessions) + '）'
  }
  /* 统计口径 = 连线显形类别（合并出度判定），与画布上实际颜色一致 */
  const handoffCount = edges.filter((e) => displayKind(e, degree) === 'handoff').length
  const branchCount = edges.filter((e) => displayKind(e, degree) === 'branch').length

  const nodeCard = (n: SNode): unknown => {
    const i = layout.colOf.get(n.id) ?? 0
    const up = layout.sideOf.get(n.id) !== 'down'
    const top = nodeTop(layout, n.id)
    const isDragSrc = drag !== null && drag.moved && drag.from === n.id
    const isSel = selected === n.id
    const deg = degree.get(n.id)
    const nudgeFirst = n.handoffFirst && (deg?.in ?? 0) === 0
    /* 金框（待接后继）= 消息中出现任意 handoff skill 调用且无后继边 */
    const nudgeLast = n.handoffUsed && (deg?.out ?? 0) === 0
    let border = 'var(--dsw-alias-border-primary, rgba(128,128,128,0.35))'
    let shadow = 'none'
    if (nudgeFirst) border = FIRST_NUDGE
    else if (nudgeLast) border = LAST_NUDGE
    if (nudgeFirst && nudgeLast) shadow = 'inset 0 0 0 2px ' + LAST_NUDGE
    if (isSel) shadow = (shadow === 'none' ? '' : shadow + ', ') + '0 0 0 2px ' + ACCENT
    else if (isDragSrc) shadow = '0 0 0 2px ' + MANUAL
    /* ⑂N 徽章 = 合并出度（原生 + 手工后继），血缘链扇出口径 */
    const kids = deg?.out ?? 0
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
        /* 「handoff」标签 = 调用过 handoff skill 或以 handoff 种子开场；
         * 不按首条消息含 handoff 字样判定（讨论 handoff 的会话会误标） */
        (n.seeded || n.handoffUsed) ? h(P.Tag, { tone: 'info' }, 'handoff') : null,
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
        value: workspace ?? '',
        title: '查看哪个工作区的时间线',
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
        h('option', { value: '' }, '当前会话工作区'),
        ...(workspaces ?? [])
          .filter((w) => w.bucket !== sessionBucketRef.current)
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
    /* 鱼骨时间线：横向 + 纵向滚动（滚轮原生滚动，不缩放）；左上角缩放控件；
     * 空白处左键拖拽 = 平移画布（grab/grabbing） */
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
          onClick: (): void => zoomAtCenter(zoom - 0.1),
        }, '−'),
        h('span', {
          title: zoom === 1 ? '100%（原始比例）' : '点击复位 100%',
          style: { minWidth: 40, textAlign: 'center', cursor: zoom === 1 ? 'default' : 'pointer' },
          onClick: (): void => { if (zoom !== 1) zoomAtCenter(1) },
        }, String(Math.round(zoom * 100)) + '%'),
        h('span', {
          title: '放大（10%）',
          style: { cursor: 'pointer', padding: '0 5px', color: zoom < 3 - 1e-9 ? 'inherit' : DIM },
          onClick: (): void => zoomAtCenter(zoom + 0.1),
        }, '+'),
      ),
      h('div', {
        ref: viewportRef,
        title: '空白处按住拖拽 = 平移 · 滚轮 = 上下滚动（Ctrl+滚轮 = 浏览器缩放）· 画布缩放用左上角 −/+',
        onPointerDown: onViewportPointerDown,
        style: {
          overflowX: 'auto', overflowY: 'auto',
          height: TIMELINE_MAX_H,
          border: '1px solid var(--dsw-alias-border-primary, rgba(128,128,128,0.25))',
          borderRadius: 8,
          cursor: panning ? 'grabbing' : 'grab',
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
          /* 原生血缘弯折线：显形类别按合并出度判定——蓝 = 链式 handoff，
           * 紫 = 分支/扇出（父另有手工后继时单子边也显形为分支） */
          ...edges.map((e, i) => {
            if (!layout.colOf.has(e.from) || !layout.colOf.has(e.to)) return null
            const kind = displayKind(e, degree)
            const color = kind === 'branch' ? BRANCH : ACCENT
            return h('path', {
              key: 'n' + String(i),
              d: routeEdge(e.from, e.to, i),
              fill: 'none',
              stroke: color,
              strokeWidth: 1.6,
              markerEnd: kind === 'branch' ? 'url(#st-arrow-branch)' : 'url(#st-arrow-handoff)',
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
    /* 详情区：未选中 = 操作 + 图例（连线色卡 / 框与标签）+ 布局一句话 */
    sel === undefined
      ? h('div', { style: { color: DIM, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 5 } },
          h('div', null,
            '拖动节点到另一节点 = 手工衔接 · 双击 = 切换会话 · 单击 = 详情 · 空白处拖拽 = 平移。',
            '滚轮 = 滚动画布（Ctrl+滚轮 = 浏览器缩放）；画布缩放只走左上角 −/+。血缘链 = 原生边 ∪ 手工衔接：⑂N 徽章、分支判定、金紫框、详情血缘叙述均按合并链计算。'),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '3px 18px' } },
            legendLine(ACCENT, false, '链式 handoff（父单子）'),
            legendLine(BRANCH, false, '分支/扇出（父后继 ≥ 2，手工后继计入）'),
            legendLine(MANUAL, true, '手工衔接（host 按创建时间定向）')),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '3px 18px' } },
            legendFrame(FIRST_NUDGE, '待接前驱：首对话调用过 handoff 且无前驱'),
            legendFrame(LAST_NUDGE, '待接后继：出现过 handoff 调用且无后继'),
            legendTag('调用过 handoff skill 或以 handoff 种子开场')),
          h('div', null,
            '选中会话可在详情区查看 handoff 调用的轮次与时间。'))
      : h('div', {
          title: '外框滚轮 = 上一轮/下一轮 · 点轮次条直达 · 内容框内滚轮翻看对话',
          onWheel: (ev: React.WheelEvent): void => {
            if (turnsData === null || turnsData.turns === 0) return
            const now = Date.now()
            if (now - wheelPageAt.current < 300) return
            wheelPageAt.current = now
            const next = ev.deltaY > 0
              ? Math.min(turnsData.turns, selTurn + 1)
              : Math.max(1, selTurn - 1)
            if (next !== selTurn) selectTurn(next)
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
            (sel.seeded ? ' · handoff 种子开场' : '')),
          /* 血缘行 = 合并链前驱叙述：原生父（在/不在视图）+ 手工入边（标注手工，
           * 内联断开）；全无前驱才报根会话。分支标注按合并出度（父的后继 ≥ 2）。 */
          (() => {
            const parts: unknown[] = []
            let nativeNote: string | null = null
            let nativeMissing = false
            if (sel.parent !== null) {
              if (byId.has(sel.parent)) {
                nativeNote = '衔接自「' + titleOf(sel.parent) + '」' +
                  ((degree.get(sel.parent)?.out ?? 0) >= 2 ? '（分支）' : '')
              } else {
                nativeNote = '父会话 ' + shortId(sel.parent) + ' 不在当前视图（跨区 handoff 或已删除）'
                nativeMissing = true
              }
            }
            if (nativeNote !== null) parts.push(h('span', { key: 'nat' }, nativeNote))
            for (const l of selManualIn) {
              parts.push(h('span', { key: 'mi-' + l.from + l.to, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
                h('span', null, '衔接自「' + titleOf(l.from) + '」（手工）'),
                h(P.Button, {
                  variant: 'ghost', size: 'sm', disabled: busy, title: '断开该手工衔接',
                  onClick: () => { void act('unlink', l.from, l.to) },
                }, '断开')))
            }
            /* 全无前驱 = 根会话；仅剩视图外原生父（无手工入边）保持弱化灰 */
            const dim = parts.length === 0 || (nativeMissing && selManualIn.length === 0)
            return h('div', { style: { fontSize: 12, color: dim ? DIM : undefined, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 6px' } },
              h('span', null, '血缘：'),
              parts.length > 0
                ? parts.flatMap((p, i) => (i < parts.length - 1 ? [p, h('span', { key: 'sep-' + String(i) }, '；')] : [p]))
                : h('span', null, '无父会话（根会话）'))
          })(),
          /* handoff skill 调用明细：每次调用的轮次/时间/消息 seq；金紫框状态对账 */
          sel.handoffHits.length > 0
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                h('div', { style: { fontSize: 12 } },
                  'handoff skill：共 ' + String(sel.handoffHits.length) + ' 次调用',
                  sel.handoffFirst && (degree.get(sel.id)?.in ?? 0) === 0
                    ? h('span', { style: { color: FIRST_NUDGE } }, '（待接前驱·紫）')
                    : null,
                  sel.handoffUsed && (degree.get(sel.id)?.out ?? 0) === 0
                    ? h('span', { style: { color: LAST_NUDGE } }, '（待接后继·金）')
                    : null),
                ...sel.handoffHits.map((hit) => h('div', {
                  key: 'handoff-hit-' + String(hit.seq) + '-' + String(hit.at),
                  style: { color: DIM, fontSize: 11.5, fontFamily: MONO },
                }, '· 第 ' + String(hit.turn) + ' 轮 · ' + (hit.at > 0 ? fmtFull(hit.at) : '时间未知') + ' · 消息 #' + String(hit.seq))),
              )
            : null,
          /* 衔接到行 = 合并链后继叙述（手工出边内联断开） */
          selOut.length > 0
            ? h('div', { style: { fontSize: 12, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 6px' } },
                h('span', null, '衔接到：'),
                ...selOut.flatMap((o, i) => {
                  const frags: unknown[] = [h('span', { key: 'out-' + String(i) }, '「' + titleOf(o.id) + '」' + o.mark)]
                  const u = o.unlink
                  if (u !== null) {
                    frags.push(h(P.Button, {
                      key: 'outb-' + String(i), variant: 'ghost', size: 'sm', disabled: busy, title: '断开该手工衔接',
                      onClick: () => { void act('unlink', u.from, u.to) },
                    }, '断开'))
                  }
                  if (i < selOut.length - 1) frags.push(h('span', { key: 'outs-' + String(i) }, '、'))
                  return frags
                }))
            : null,
          /* 轮次条：横向排列，每轮一根横条；首/末轮较大，handoff 调用轮金色
           * 高亮（选中蓝色填充 + 金边）；点击任意条展示该轮——末轮即 handoff
           * 轮时单条同时具备两语义，不再重复显示。 */
          h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 3, flexWrap: 'wrap' } },
            ...(turnsData === null
              ? []
              : Array.from({ length: turnsData.turns }, (_, i) => i + 1).map((t) => {
                  const isHandoff = (turnsData.handoffTurns ?? []).some((x) => x.turn === t)
                  const big = t === 1 || t === turnsData.turns
                  const active = t === selTurn
                  return h('div', {
                    key: 'turn-bar-' + String(t),
                    title: '第 ' + String(t) + ' 轮' + (t === 1 ? ' · 首轮' : '') + (t === turnsData.turns ? ' · 末轮' : '') + (isHandoff ? ' · handoff 调用轮' : ''),
                    onClick: () => selectTurn(t),
                    style: {
                      width: big ? 24 : 14,
                      height: big ? 16 : 9,
                      borderRadius: 3,
                      cursor: 'pointer',
                      boxSizing: 'border-box',
                      background: active ? ACCENT : isHandoff ? LAST_NUDGE : 'var(--dsw-alias-surface-raised, rgba(128,128,128,0.28))',
                      border: isHandoff ? '1px solid ' + LAST_NUDGE : '1px solid transparent',
                      opacity: active ? 1 : isHandoff ? 0.8 : 0.7,
                    },
                  })
                })),
            turnsData !== null && turnsData.turns > 0
              ? h('span', { style: { color: DIM, fontSize: 11, marginLeft: 6 } },
                  '第 ' + String(selTurn) + ' / ' + String(turnsData.turns) + ' 轮' +
                  ((turnsData.handoffTurns ?? []).some((x) => x.turn === selTurn) ? ' · handoff 调用轮' : '') +
                  (selTurn === 1 ? ' · 首轮' : '') +
                  (selTurn === turnsData.turns ? ' · 末轮' : ''))
              : (turnsData !== null ? h('span', { style: { color: DIM, fontSize: 11 } }, '无对话轮') : null),
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
                  const t = turnContent(selTurn)
                  if (t === undefined) return h('span', { style: { color: DIM } }, '加载中…')
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
        ),
  )
}

/** 页签标题：文字 + 当前面板视图的顶层会话数（轻轮询）。
 *  视图 = 面板所选工作区；面板未选时跟随当前会话所属桶——切换工作区即时跟随。 */
function TabTitle(props: { sessionId?: string }): unknown {
  const { sessionId } = props
  const [count, setCount] = useState(0)
  const [bucket, setBucket] = useState<string | null>(viewBucket.value)
  useEffect(() => subscribeViewBucket(() => setBucket(viewBucket.value)), [])

  useEffect(() => {
    const workspace = bucket ?? undefined
    if (workspace === undefined && sessionId === undefined) return
    const tick = (): void => {
      const ctrl = new AbortController()
      const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
      fetch(listUrl(workspace, sessionId), { signal: ctrl.signal })
        .then((r) => r.json())
        .then((data: Snapshot) => setCount(data?.ok === true ? (data.sessions?.length ?? 0) : 0))
        .catch(() => { /* 保上次值 */ })
        .finally(() => clearTimeout(tid))
    }
    tick()
    const t = setInterval(tick, 12000)
    return () => clearInterval(t)
  }, [bucket, sessionId])

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
