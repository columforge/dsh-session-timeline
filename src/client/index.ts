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
import {
  computeLayout, colX, nodeTop, SPACING, NODE_W, NODE_H,
} from '../geometry/layout.js'
import { routeEdgePath, OBST_PAD, type Obstacle } from '../geometry/routing.js'
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
