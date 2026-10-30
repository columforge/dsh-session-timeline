/**
 * @dsh-external/session-timeline — client: right sidebar tab (session timeline).
 * Fishbone timeline: central horizontal axis (arrow at the newest end) with
 * date ticks (YY-MM-DD at date changes, text on the side opposite the
 * spurs); sessions alternate above/below the axis left→right by creation
 * time, spurs connect vertically. A lineage chain = native edges
 * (handoff/branch) ∪ manual links; chain semantics (degrees, branch
 * detection, ⑂N badge, link display kind) are computed on the merged chain
 * (pure functions in ../geometry/lineage). Native links draw as solid bent
 * polylines (parent near-axis edge → axis-side channel → horizontal to the
 * child column → into the child's left side; blue = chained, purple =
 * fan-out); manual links draw as orange dashed polylines (same-side left
 * entry; with fan-out a native edge also displays as branch purple).
 * The "handoff" tag = handoff skill invoked (handoffUsed) or opened from a
 * handoff seed (isSeeded) — never by "handoff" text in the first message.
 * First-window handoff with no predecessor → purple frame (awaiting
 * predecessor); any handoff invocation with no successor → gold frame
 * (awaiting successor); the detail pane lists each invocation's
 * turn/time/message seq.
 * Double-click a node = switch to that session; the header "global timeline"
 * toggle aggregates all workspaces.
 * Archive display (header select, two modes over the host-stamped `archived`
 * flag): "show all" (default = current behavior) draws archived session boxes
 * with dashed borders plus an archived tag; "hide archived" filters archived
 * sessions out before layout — spurs/edges touching hidden nodes drop out via
 * the existing layout-presence checks. The mode is panel-ephemeral (like
 * sort/direction) and shared with the tab-title count via a module store.
 * Three interaction channels stay independent: wheel = native browser
 * scrolling (Ctrl+wheel = browser zoom, neither intercepted); left-drag on
 * empty canvas = pan (dragging from a node still creates a manual link);
 * canvas zoom only via the top-left −/+ controls (±10%, anchored to the
 * viewport center; click the percentage to reset to 100%).
 * Build: tsdown → lib/client.js (ModuleLoader registration).
 * All visible copy routes through the Client locale service (dictionaries in
 * ./locales, 8 languages) and follows the language configured in DSH; host
 * API errors surface as stable code+params and render localized too.
 * ⚠️ client must export const inject; slots.register requires a name field.
 */
const React = require('react') as typeof import('react')
import {
  computeLayout, colX, nodeTop, SPACING, NODE_W, NODE_H,
} from '../geometry/layout.js'
import { routeEdgePath, OBST_PAD, type Obstacle } from '../geometry/routing.js'
import { lineageDegrees, displayKind } from '../geometry/lineage.js'
import { NS, dictionaries, zh, type Translate } from './locales.js'
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
const TAB_ID = '@dsh-external/session-timeline'
const TAB_KIND = 'session-timeline'

/** {name} placeholder interpolation (same semantics as LocaleRuntime.translate). */
function interpolate(template: string, params?: Record<string, unknown>): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}

/** Module-level translate fallback: renders zh when the locale service is absent (pre-i18n behavior). */
let T: Translate = (key, params) => interpolate(zh[key as keyof typeof zh] ?? key, params)

/** Host API error → copy in the active language: error.<code> first, then the raw error text, then a generic failure. */
function errorText(t: Translate, r: { code?: string; params?: Record<string, unknown>; error?: string }): string {
  if (typeof r.code === 'string' && r.code !== '') {
    const key = 'error.' + r.code
    const text = t(key, r.params)
    if (text !== key) return text
  }
  return r.error !== undefined && r.error !== '' ? r.error : t('error.opFailed')
}

/** The panel's selected workspace (null = follow the current session's bucket). The tab title counts from this,
 *  kept consistent with the panel body; reset on unmount. */
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

/** The panel's archive display mode: 'all' = show every session, archived boxes dashed-marked
 *  (default = pre-feature behavior); 'hide' = archived sessions filtered out before layout.
 *  Panel-ephemeral like sort/direction; shared with the tab-title count (same pattern as viewBucket). */
type ArchiveMode = 'all' | 'hide'
const archiveView: { value: ArchiveMode; listeners: Set<() => void> } = { value: 'all', listeners: new Set() }
function setArchiveView(value: ArchiveMode): void {
  if (archiveView.value === value) return
  archiveView.value = value
  for (const listener of [...archiveView.listeners]) listener()
}
function subscribeArchiveView(listener: () => void): () => void {
  archiveView.listeners.add(listener)
  return () => { archiveView.listeners.delete(listener) }
}

/** UI-side panel height cap; geometry constants/pure functions live in ../geometry (unit-tested). */
const TIMELINE_MAX_H = 420

type SNode = {
  id: string
  title: string | null
  /** Creation time = first real user message time (falls back to the log header without one). */
  createdAt: number
  /** Raw log header.createdAt (session object written time). */
  logCreatedAt: number
  /** Last activity (used for timeline positioning/display). */
  lastAt: number
  parent: string | null
  seeded: boolean
  cwd: string | null
  bucket: string
  handoffFirst: boolean
  /** Any handoff skill invocation appeared (gold "no successor" criterion; not last-window only). */
  handoffUsed: boolean
  /** Handoff skill invocations (seq/time/turn, in log order). */
  handoffHits: { seq: number; at: number; turn: number }[]
  /** In the workspace registry's archive set (host-stamped at /list assembly). */
  archived?: boolean
}
type NEdge = { from: string; to: string; kind: 'handoff' | 'branch' }
type MLink = { from: string; to: string; created_at: string }
type Workspace = { bucket: string; cwd: string | null; sessions: number; newest: number }
type Snapshot = {
  ok: boolean
  error?: string
  /** Stable error code (client translates via the error.<code> dictionary key) + interpolation params. */
  code?: string
  params?: Record<string, unknown>
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
  /** Client locale service (provided by dsh-client-locale; the panel falls back to zh without it). */
  locale?: {
    bind: (ns: string) => Translate
    register: (ns: string, dicts: Record<string, Record<string, string>>) => unknown
  }
  effect: (fn: () => void, label?: string) => unknown
}

export const inject = ['slots', 'sidebarRightTabs', 'uiWorkspace', 'locale']

const DIM = 'var(--dsw-alias-text-secondary, rgba(128,128,128,0.85))'
const ACCENT = 'var(--dsw-alias-accent-primary, #3b82f6)'   // handoff link (solid bent)
const BRANCH = '#8b5cf6'                                     // branch (solid bent)
const MANUAL = 'rgba(217,119,6,0.95)'                        // manual link (dashed bent)
const FIRST_NUDGE = '#8b5cf6'                                // first-window handoff accent (purple)
const LAST_NUDGE = '#e0a11a'                                 // last-window handoff accent (gold)
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

type LinkResult = { ok?: boolean; error?: string; duplicate?: boolean; code?: string; params?: Record<string, unknown> }

function post(action: 'link' | 'unlink', payload: Record<string, unknown>): Promise<LinkResult | null> {
  return fetch(API_BASE + '/' + action, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then((r) => r.json() as Promise<LinkResult>)
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

/** Polls the host API; pauses while the page is hidden. workspace first, else locate by the current session. */
function useSnapshot(t: Translate, workspace: string | undefined, sessionId: string | undefined): [Snapshot | undefined, () => void] {
  const [snap, setSnap] = useState<Snapshot | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchOnce = (): void => {
    if (workspace === undefined && sessionId === undefined) { setSnap({ ok: false, code: 'noSession' }); return }
    const ctrl = new AbortController()
    const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    fetch(listUrl(workspace, sessionId), { signal: ctrl.signal })
      .then((r) => r.json())
      .then((data: Snapshot) => setSnap(data))
      .catch(() => { /* keep the last snapshot on poll failure */ })
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
  }, [t, workspace, sessionId])
  return [snap, fetchOnce]
}

function shortId(id: string): string {
  return id.startsWith('session-') ? id.slice(8, 8 + 8) + '…' : id.slice(0, 8) + '…'
}

/* Empty-state legend widgets: link color swatches (solid/dashed), frame swatches, tag badges. */
const legendLine = (color: string, dashed: boolean, label: string): unknown =>
  h('span', { key: label, style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
    h('span', { style: { display: 'inline-block', width: 22, height: 0, borderTop: '2px ' + (dashed ? 'dashed ' : 'solid ') + color } }),
    h('span', null, label))
const legendFrame = (color: string, label: string, dashed = false): unknown =>
  h('span', { key: label, style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
    h('span', { style: { display: 'inline-block', width: 11, height: 11, borderRadius: 3, border: '2px ' + (dashed ? 'dashed ' : 'solid ') + color, boxSizing: 'border-box' } }),
    h('span', null, label))
const legendTag = (label: string): unknown =>
  h('span', { key: label, style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
    h(P.Tag, { tone: 'info' }, 'handoff'),
    h('span', null, label))

/* Empty-state legend row: group label + "action = meaning" items; wraps in narrow columns (instead of a wall of text). */
const legendRow = (label: string, items: unknown[]): unknown =>
  h('div', { key: label, style: { display: 'flex', alignItems: 'flex-start', gap: 8 } },
    h('span', {
      style: {
        flexShrink: 0, fontSize: 10.5, lineHeight: '18px', padding: '0 6px', borderRadius: 4,
        border: '1px solid var(--dsw-alias-border-primary, rgba(128,128,128,0.3))',
        color: DIM, whiteSpace: 'nowrap',
      },
    }, label),
    h('span', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '2px 12px', minWidth: 0 } }, items))
/** One item: action word (accent foreground) = meaning (secondary color). */
const legendItem = (action: string, meaning: string): unknown =>
  h('span', { key: action, style: { display: 'inline-flex', alignItems: 'baseline', gap: 4 } },
    h('span', { style: { color: AXIS } }, action),
    h('span', { style: { color: DIM } }, '='),
    h('span', null, meaning))

/** Render error boundary: shows the error text instead of a blank panel. */
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
        T('state.renderFailed', { message: String(this.state.error.message ?? this.state.error) }))
    }
    return this.props.children
  }
}

function PanelBody(props: { sessionId?: string; openSession: (id: string) => void; t?: Translate }): unknown {
  const { sessionId, openSession } = props
  const t: Translate = props.t ?? T
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null)
  const [workspace, setWorkspace] = useState<string | undefined>(undefined)
  const [snap, refresh] = useSnapshot(t, workspace, sessionId)
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

  /* Publish the panel's selected workspace to the tab title (null = follow the current session's bucket). */
  useEffect(() => {
    setViewBucket(workspace ?? null)
    return () => setViewBucket(null)
  }, [workspace])

  /* The current session's bucket (first dropdown item = follow it; captured on the first loaded snapshot). */
  const sessionBucketRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (workspace === undefined && snap?.bucket !== undefined) sessionBucketRef.current = snap.bucket
  }, [workspace, snap])

  /* Sort: creation time (default) / last activity; direction: old→new (default) / new→old.
   * Archive mode applies before both: 'hide' drops archived sessions from the timeline entirely. */
  const [archiveMode, setArchiveModeState] = useState<ArchiveMode>(archiveView.value)
  const setArchiveMode = (mode: ArchiveMode): void => {
    setArchiveModeState(mode)
    setArchiveView(mode)
  }
  const [sortBy, setSortBy] = useState<'createdAt' | 'lastAt'>('createdAt')
  const [newestFirst, setNewestFirst] = useState(true)
  const sortedNodes = useMemo(() => {
    const all = snap?.sessions ?? []
    const list = archiveMode === 'hide' ? all.filter((n) => !n.archived) : [...all]
    list.sort((a, b) => (sortBy === 'createdAt' ? a.createdAt - b.createdAt : a.lastAt - b.lastAt) || (a.id < b.id ? -1 : 1))
    if (newestFirst) list.reverse()
    return list
  }, [snap, sortBy, newestFirst, archiveMode])
  const layout = useMemo(() => computeLayout(sortedNodes, snap?.edges ?? [], snap?.manualLinks ?? []), [sortedNodes, snap])
  const { nodes } = layout
  const edges = snap?.edges ?? []
  const manualLinks = snap?.manualLinks ?? []
  const displayAt = (n: SNode): number => (sortBy === 'createdAt' ? n.createdAt : n.lastAt)

  /* Zoom: 100% = natural scale; only via the top-left controls (−/+ ±10%, click the percentage to reset),
   * anchored to the viewport center. The wheel never zooms — it yields to native scrolling and browser
   * zoom (Ctrl+wheel); the three channels stay independent, zoom is modeless with no exit state. */
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [zoom, setZoom] = useState(1)
  const clampZoom = (z: number): number => Math.max(0.1, Math.min(3, z))
  const applyZoom = (next: number, cx?: number, cy?: number): void => {
    const vp = viewportRef.current
    const prev = zoom
    const z = clampZoom(next)
    if (vp !== undefined && vp !== null && cx !== undefined && cy !== undefined) {
      // Zoom around an anchor: keep the layout point under the anchor visually fixed.
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

  /* Canvas pan: left-drag on empty space (non-node) → 1:1 viewport scrollbar move (grab →
   * grabbing; setPointerCapture covers drag-outs). Dragging from a node still creates a
   * manual link — the entry point branches on data-node-id; touch is untouched (native
   * touch scrolling already works). */
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
    try { vp.setPointerCapture(ev.pointerId) } catch { /* pointer already gone — ignore */ }
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

  /* Date ticks: at date changes + first column; text on the side opposite the spurs. */
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

  /* Turn bars of the selected session: horizontal, one bar per turn (first/last larger, handoff-call turns
   * highlighted gold); clicking any bar shows that turn's dialog — first/last/handoff turns ship with /turns,
   * others are fetched on demand (/turns&turn=N, cached in fetchedTurns). When the last turn is itself a
   * handoff turn, one bar carries both meanings and is not shown twice. */
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
      .catch(() => { /* stay null; UI shows the loading-failed placeholder */ })
      .finally(() => clearTimeout(tid))
    return () => { ctrl.abort() }
  }, [selected, workspace])

  /** Turn T's dialog: first/last/handoff turns ship with /turns; the rest come from the on-demand cache. */
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
      .catch(() => { /* keep the placeholder */ })
      .finally(() => clearTimeout(tid))
  }
  const selectTurn = (turn: number): void => {
    setSelTurn(turn)
    if (turnContent(turn) === undefined) fetchTurn(turn)
  }

  /* Merged lineage degrees (native + manual, equal weight): one shared copy for the gold/purple frame
   * criteria, ⑂N badge, branch display detection, and the detail pane's lineage/successor narration
   * (pure function lineageDegrees). */
  const degree = useMemo(() => lineageDegrees(edges, manualLinks), [edges, manualLinks])

  /* Obstacles: all node boxes (padded 2px); cross-edge shared channel-occupancy table (crowding penalty). */
  const obstacles = useMemo<Obstacle[]>(() => nodes.map((n) => ({
    x: (layout.colOf.get(n.id) ?? 0) * SPACING + (SPACING - NODE_W) / 2 - OBST_PAD,
    y: nodeTop(layout, n.id) - OBST_PAD,
    w: NODE_W + OBST_PAD * 2,
    h: NODE_H + OBST_PAD * 2,
  })), [nodes, layout])
  const occupiedRef = useRef<Map<string, number>>(new Map())
  useEffect(() => { occupiedRef.current = new Map() }, [snap])

  /* Handoff link exit/entry priority (user rule):
   * exit (parent): down box = bottom (outer bottom edge), up box = top (outer top edge);
   *   new→old order: secondary is the left side edge; old→new: the right side edge.
   * entry (child): new→old order: primary is the right side edge (secondary the outer edge);
   *   old→new order: primary is the left side edge (secondary the outer edge).
   * A* tries combinations in order and uses the first reachable (non-fallback) result. */
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
    if (r === null) { setMsg(t('error.requestFailed')); return }
    if (r.ok !== true) { setMsg(errorText(t, r)); return }
    if (action === 'link') setMsg(r.duplicate === true ? t('msg.linkDuplicate') : t('msg.linked'))
    else setMsg(t('msg.unlinked'))
    refresh()
  }

  /* Link drag: pointerdown on a node → window tracking → pointerup on another node links them. */
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
    return h('div', { style: { color: DIM, fontSize: 12.5, padding: 12 } }, t('state.loading'))
  }
  if (snap.ok !== true) {
    return h('div', { style: { color: DIM, fontSize: 12.5, padding: 12 } }, errorText(t, snap))
  }

  const sel = selected !== null ? byId.get(selected) : undefined
  const selManualIn = sel !== undefined ? manualLinks.filter((l) => l.to === sel.id) : []
  const selManualOut = sel !== undefined ? manualLinks.filter((l) => l.from === sel.id) : []
  /* Merged-chain narration: successors = native out-edges + manual out-edges (shared by the detail
   * "links to" row; manual out-edges carry an unlink ref for the inline disconnect button). */
  const selOut = sel !== undefined
    ? [
        ...edges.filter((e) => e.from === sel.id).map((e) => ({
          id: e.to,
          mark: displayKind(e, degree) === 'branch' ? t('edge.kind.branch') : '',
          unlink: null as { from: string; to: string } | null,
        })),
        ...selManualOut.map((l) => ({ id: l.to, mark: t('edge.kind.manual'), unlink: { from: l.from, to: l.to } as { from: string; to: string } | null })),
      ]
    : []
  const titleOf = (id: string): string => byId.get(id)?.title ?? shortId(id)
  const wsLabel = (w: Workspace): string => {
    const tail = w.cwd !== null && w.cwd !== '' ? w.cwd.split('/').filter(Boolean).pop() ?? w.cwd : w.bucket
    return tail + t('fmt.count', { count: w.sessions })
  }
  /* Stats criterion = link display kind (merged out-degree), matching the actual canvas colors. */
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
    /* Gold frame (awaiting successor) = any handoff skill invocation and no successor edge. */
    const nudgeLast = n.handoffUsed && (deg?.out ?? 0) === 0
    let border = 'var(--dsw-alias-border-primary, rgba(128,128,128,0.35))'
    let shadow = 'none'
    if (nudgeFirst) border = FIRST_NUDGE
    else if (nudgeLast) border = LAST_NUDGE
    if (nudgeFirst && nudgeLast) shadow = 'inset 0 0 0 2px ' + LAST_NUDGE
    if (isSel) shadow = (shadow === 'none' ? '' : shadow + ', ') + '0 0 0 2px ' + ACCENT
    else if (isDragSrc) shadow = '0 0 0 2px ' + MANUAL
    /* ⑂N badge = merged out-degree (native + manual successors), lineage-chain fan-out criterion. */
    const kids = deg?.out ?? 0
    return h('div', {
      key: n.id,
      'data-node-id': n.id,
      title: (n.title ?? n.id) + '\n' + t('node.hint'),
      style: {
        position: 'absolute',
        left: i * SPACING + (SPACING - NODE_W) / 2,
        top,
        width: NODE_W,
        height: NODE_H,
        boxSizing: 'border-box',
        borderRadius: 8,
        /* Archived sessions draw dashed frames ("show all" mode marker; hide mode removes them entirely). */
        border: (nudgeFirst || nudgeLast) ? '2px ' + (n.archived ? 'dashed ' : 'solid ') + border : '1px ' + (n.archived ? 'dashed ' : 'solid ') + border,
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
      }, n.title ?? t('node.untitled')),
      h('div', { style: { display: 'flex', gap: 4, marginTop: 'auto', flexWrap: 'wrap' } },
        /* The "handoff" tag = handoff skill invoked or opened from a handoff seed;
         * never by "handoff" text in the first message (would mislabel sessions discussing handoff). */
        (n.seeded || n.handoffUsed) ? h(P.Tag, { tone: 'info' }, 'handoff') : null,
        kids >= 2 ? h(P.Tag, { tone: 'info' }, '⑂' + String(kids)) : null,
        nudgeFirst ? h(P.Tag, { tone: 'info' }, t('node.tag.awaitParent')) : null,
        nudgeLast ? h(P.Tag, { tone: 'warning' }, t('node.tag.awaitChild')) : null,
        n.parent !== null && !byId.has(n.parent) ? h(P.Tag, { tone: 'quiet' }, t('node.tag.externalParent')) : null,
        n.archived === true ? h(P.Tag, { tone: 'quiet' }, t('node.tag.archived')) : null,
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
    /* Header: global toggle + workspace select + stats + refresh. */
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: DIM, flexWrap: 'wrap' } },
      h('select', {
        value: workspace ?? '',
        title: t('header.workspaceTitle'),
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
        h('option', { value: '' }, t('header.workspaceCurrent')),
        ...(workspaces ?? [])
          .filter((w) => w.bucket !== sessionBucketRef.current)
          .map((w) => h('option', { key: w.bucket, value: w.bucket, title: w.cwd ?? w.bucket }, wsLabel(w))),
      ),
      h('select', {
        value: newestFirst ? 'newOld' : 'oldNew',
        title: t('header.orderTitle'),
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
        h('option', { value: 'oldNew' }, t('header.orderOldNew')),
        h('option', { value: 'newOld' }, t('header.orderNewOld')),
      ),
      h('select', {
        value: sortBy,
        title: t('header.sortTitle'),
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
        h('option', { value: 'createdAt' }, t('header.sortCreated')),
        h('option', { value: 'lastAt' }, t('header.sortLast')),
      ),
      h('select', {
        value: archiveMode,
        title: t('header.archiveTitle'),
        style: {
          fontSize: 12, padding: '2px 4px', borderRadius: 6,
          border: '1px solid var(--dsw-alias-border-primary, rgba(128,128,128,0.35))',
          background: 'var(--dsw-alias-surface-raised, transparent)', color: 'inherit',
        },
        onChange: (ev: React.ChangeEvent<HTMLSelectElement>): void => {
          setSelected(null)
          setArchiveMode(ev.target.value === 'hide' ? 'hide' : 'all')
        },
      },
        h('option', { value: 'all' }, t('header.archiveShowAll')),
        h('option', { value: 'hide' }, t('header.archiveHide')),
      ),
      h('span', null,
        t('stats.summary', { sessions: nodes.length, handoff: handoffCount, branch: branchCount, manual: manualLinks.length }) +
        ((snap.sessions ?? []).some((n) => n.archived === true)
          ? ' ' + t('stats.archived', { count: (snap.sessions ?? []).filter((n) => n.archived === true).length })
          : '') +
        ((snap.unreadable ?? 0) > 0 ? ' ' + t('stats.unreadable', { count: snap.unreadable ?? 0 }) : '')),
      msg !== null ? h('span', { style: { color: MANUAL, fontSize: 11.5 } }, msg) : null,
      h('span', { style: { marginLeft: 'auto' } },
        h(P.Button, {
          variant: 'ghost', size: 'sm', disabled: busy,
          onClick: (): void => {
            refresh()
            void fetchWorkspaces().then((ws) => { if (ws !== null) setWorkspaces(ws) })
          },
        }, t('header.refresh'))),
    ),
    /* Fishbone timeline: horizontal + vertical scrolling (native wheel, no zoom); top-left zoom controls;
     * left-drag on empty space = pan (grab/grabbing). */
    h('div', { style: { position: 'relative', flex: '0 0 auto' } },
      /* Zoom controls (floating top-left overlay, on top so content never covers them). */
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
          title: t('zoom.out'),
          style: { cursor: 'pointer', padding: '0 5px', color: zoom > 0.1 + 1e-9 ? 'inherit' : DIM },
          onClick: (): void => zoomAtCenter(zoom - 0.1),
        }, '−'),
        h('span', {
          title: zoom === 1 ? t('zoom.fit') : t('zoom.reset'),
          style: { minWidth: 40, textAlign: 'center', cursor: zoom === 1 ? 'default' : 'pointer' },
          onClick: (): void => { if (zoom !== 1) zoomAtCenter(1) },
        }, String(Math.round(zoom * 100)) + '%'),
        h('span', {
          title: t('zoom.in'),
          style: { cursor: 'pointer', padding: '0 5px', color: zoom < 3 - 1e-9 ? 'inherit' : DIM },
          onClick: (): void => zoomAtCenter(zoom + 0.1),
        }, '+'),
      ),
      h('div', {
        ref: viewportRef,
        title: t('canvas.hint'),
        onPointerDown: onViewportPointerDown,
        style: {
          overflowX: 'auto', overflowY: 'auto',
          height: TIMELINE_MAX_H,
          border: '1px solid var(--dsw-alias-border-primary, rgba(128,128,128,0.25))',
          borderRadius: 8,
          cursor: panning ? 'grabbing' : 'grab',
        },
      },
        /* sizer: reserves the zoomed layout size so scroll ranges stay correct. */
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
          /* Main axis: central horizontal line + end arrow (pointing left when newest-first, arrow at the far left). */
          h('line', {
            x1: newestFirst ? layout.innerW - 8 : 8, y1: axisY,
            x2: newestFirst ? 14 : layout.innerW - 14, y2: axisY,
            stroke: AXIS, strokeWidth: 1.4, opacity: 0.7,
            markerEnd: 'url(#st-arrow-axis)',
          }),
          /* Date ticks + text (opposite side of the spurs). */
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
          /* Spurs: every node connects vertically, box-centered, to the axis.
           * Segments between the axis and same-column boxes on depth rows are drawn in
           * relay pieces: per column/side, sorted by depth, draw [axis → nearest edge of
           * the shallowest box], [far edge of the previous box → near edge of the next], etc. */
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
          /* Native lineage polylines: display kind by merged out-degree — blue = chained handoff,
           * purple = branch/fan-out (a single-child edge also displays as branch when the parent
           * has a manual successor). */
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
          /* Manual polylines (dashed orange, arrow entering the target's left side). */
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
          /* Drag ghost line. */
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
    /* Detail pane: no selection = actions + legend (link swatches / frames & tags) + one-line layout note. */
    sel === undefined
      ? h('div', { style: { color: DIM, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 5 } },
          legendRow(t('legend.groupActions'), [
            legendItem(t('legend.action.dragNode'), t('legend.meaning.manual')),
            legendItem(t('legend.action.doubleClick'), t('legend.meaning.switchSession')),
            legendItem(t('legend.action.click'), t('legend.meaning.details')),
            legendItem(t('legend.action.dragEmpty'), t('legend.meaning.pan')),
          ]),
          legendRow(t('legend.groupCanvas'), [
            legendItem(t('legend.action.wheel'), t('legend.meaning.scroll')),
            legendItem(t('legend.action.zoom'), t('legend.meaning.zoomControls')),
          ]),
          legendRow(t('legend.groupLineage'), [
            h('span', { key: 'def' }, t('legend.lineageDefinition')),
            legendItem(t('legend.action.mergedCriteria'), t('legend.meaning.mergedChain')),
          ]),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '3px 18px' } },
            legendLine(ACCENT, false, t('legend.line.handoff')),
            legendLine(BRANCH, false, t('legend.line.branch')),
            legendLine(MANUAL, true, t('legend.line.manual'))),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '3px 18px' } },
            legendFrame(FIRST_NUDGE, t('legend.frame.awaitParent')),
            legendFrame(LAST_NUDGE, t('legend.frame.awaitChild')),
            legendFrame('var(--dsw-alias-border-primary, rgba(128,128,128,0.35))', t('legend.frame.archived'), true),
            legendTag(t('legend.tag.handoff'))),
          h('div', null,
            t('legend.footer')))
      : h('div', {
          title: t('detail.hint'),
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
              sel.title ?? t('node.untitled')),
            h(P.Button, { variant: 'ghost', size: 'sm', onClick: (): void => openSession(sel.id) }, t('detail.open')),
          ),
          h('div', { style: { color: DIM, fontSize: 11.5, fontFamily: MONO } },
            [
              shortId(sel.id),
              t('detail.lastActive', { time: fmtFull(sel.lastAt) }),
              t('detail.created', { time: fmt(sel.createdAt) }),
              ...(sel.logCreatedAt > 0 && sel.logCreatedAt !== sel.createdAt
                ? [t('detail.logCreated', { time: fmt(sel.logCreatedAt) })]
                : []),
              bucketTail(sel.bucket),
              ...(sel.seeded ? [t('detail.seeded')] : []),
              ...(sel.archived === true ? [t('detail.archived')] : []),
            ].join(' · ')),
          /* Lineage row = merged-chain predecessor narration: native parent (in/out of view) + manual
           * in-edges (marked manual, inline disconnect); "root session" only when no predecessor at all.
           * Branch marking follows the merged out-degree (parent successors ≥ 2). */
          (() => {
            const parts: unknown[] = []
            let nativeNote: string | null = null
            let nativeMissing = false
            if (sel.parent !== null) {
              if (byId.has(sel.parent)) {
                nativeNote = t('lineage.from', { title: titleOf(sel.parent) }) +
                  ((degree.get(sel.parent)?.out ?? 0) >= 2 ? t('edge.kind.branch') : '')
              } else {
                nativeNote = t('lineage.fromMissing', { id: shortId(sel.parent) })
                nativeMissing = true
              }
            }
            if (nativeNote !== null) parts.push(h('span', { key: 'nat' }, nativeNote))
            for (const l of selManualIn) {
              parts.push(h('span', { key: 'mi-' + l.from + l.to, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
                h('span', null, t('lineage.from', { title: titleOf(l.from) }) + t('edge.kind.manual')),
                h(P.Button, {
                  variant: 'ghost', size: 'sm', disabled: busy, title: t('link.disconnectTitle'),
                  onClick: () => { void act('unlink', l.from, l.to) },
                }, t('link.disconnect'))))
            }
            /* No predecessor at all = root session; a native parent merely out of view (no manual in-edge) stays dimmed gray. */
            const dim = parts.length === 0 || (nativeMissing && selManualIn.length === 0)
            return h('div', { style: { fontSize: 12, color: dim ? DIM : undefined, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 6px' } },
              h('span', null, t('lineage.prefix')),
              parts.length > 0
                ? parts.flatMap((p, i) => (i < parts.length - 1 ? [p, h('span', { key: 'sep-' + String(i) }, t('fmt.listSep'))] : [p]))
                : h('span', null, t('lineage.root')))
          })(),
          /* Handoff skill invocations: turn/time/message seq each; reconciles the gold/purple frame states. */
          sel.handoffHits.length > 0
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                h('div', { style: { fontSize: 12 } },
                  t('handoff.summary', { count: sel.handoffHits.length }),
                  sel.handoffFirst && (degree.get(sel.id)?.in ?? 0) === 0
                    ? h('span', { style: { color: FIRST_NUDGE } }, t('handoff.mark.awaitParent'))
                    : null,
                  sel.handoffUsed && (degree.get(sel.id)?.out ?? 0) === 0
                    ? h('span', { style: { color: LAST_NUDGE } }, t('handoff.mark.awaitChild'))
                    : null),
                ...sel.handoffHits.map((hit) => h('div', {
                  key: 'handoff-hit-' + String(hit.seq) + '-' + String(hit.at),
                  style: { color: DIM, fontSize: 11.5, fontFamily: MONO },
                }, t('handoff.hit', { turn: hit.turn, time: hit.at > 0 ? fmtFull(hit.at) : t('handoff.timeUnknown'), seq: hit.seq }))),
              )
            : null,
          /* "Links to" row = merged-chain successor narration (manual out-edges disconnect inline). */
          selOut.length > 0
            ? h('div', { style: { fontSize: 12, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 6px' } },
                h('span', null, t('lineage.outPrefix')),
                ...selOut.flatMap((o, i) => {
                  const frags: unknown[] = [h('span', { key: 'out-' + String(i) }, t('lineage.outItem', { title: titleOf(o.id), mark: o.mark }))]
                  const u = o.unlink
                  if (u !== null) {
                    frags.push(h(P.Button, {
                      key: 'outb-' + String(i), variant: 'ghost', size: 'sm', disabled: busy, title: t('link.disconnectTitle'),
                      onClick: () => { void act('unlink', u.from, u.to) },
                    }, t('link.disconnect')))
                  }
                  if (i < selOut.length - 1) frags.push(h('span', { key: 'outs-' + String(i) }, t('fmt.enumSep')))
                  return frags
                }))
            : null,
          /* Turn bars: horizontal, one bar per turn; first/last larger, handoff-call turns gold
           * (selected = blue fill + gold edge); clicking any bar shows that turn — when the last
           * turn is itself a handoff turn, one bar carries both meanings, not shown twice. */
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

/** Tab title: text + top-level session count of the current panel view (light polling).
 *  View = the panel's selected workspace; when unselected it follows the current session's bucket —
 *  switching workspaces applies immediately. */
function TabTitle(props: { sessionId?: string }): unknown {
  const { sessionId } = props
  const [count, setCount] = useState(0)
  const [bucket, setBucket] = useState<string | null>(viewBucket.value)
  useEffect(() => subscribeViewBucket(() => setBucket(viewBucket.value)), [])
  /* Archive mode mirrors the panel body so the title count matches what the canvas shows. */
  const [archMode, setArchMode] = useState<ArchiveMode>(archiveView.value)
  useEffect(() => subscribeArchiveView(() => setArchMode(archiveView.value)), [])

  useEffect(() => {
    const workspace = bucket ?? undefined
    if (workspace === undefined && sessionId === undefined) return
    const tick = (): void => {
      const ctrl = new AbortController()
      const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
      fetch(listUrl(workspace, sessionId), { signal: ctrl.signal })
        .then((r) => r.json())
        .then((data: Snapshot) => setCount(data?.ok === true
          ? (data.sessions ?? []).filter((n) => !(archMode === 'hide' && n.archived === true)).length
          : 0))
        .catch(() => { /* keep the previous count */ })
        .finally(() => clearTimeout(tid))
    }
    tick()
    const t = setInterval(tick, 12000)
    return () => clearInterval(t)
  }, [bucket, sessionId, archMode])

  return h('span', null, T('panel.title') + (count > 0 ? '（' + String(count) + '）' : ''))
}

export function apply(ctx: Ctx): void {
  /* Locale wiring: register this namespace's dictionaries and rebind the
   * module translate so all copy follows the language configured in DSH;
   * falls back to the zh module dictionary when the service is absent. */
  if (ctx.locale) {
    try {
      ctx.locale.register(NS, dictionaries)
      T = ctx.locale.bind(NS)
    } catch { /* keep the zh fallback on any registration failure */ }
  }
  const openSession = (id: string): void => {
    try {
      ctx.uiWorkspace?.openSession(id)
    } catch { /* silent when the service is missing (only this panel is affected) */ }
  }
  const Panel = (props: { sessionId?: string }): unknown =>
    h(PanelBoundary, null, h(PanelBody, { sessionId: props.sessionId, openSession }))

  // Part 1: tab type (guide entry card; clicking it = openTab('session-timeline'))
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    priority: 'extension',
    title: () => T('panel.title'),
    guide: [{
      id: 'session-timeline',
      order: 91,
      title: () => T('panel.title'),
      description: () => T('guide.description'),
      icon: P.IconBranchOutlineRegular,
    }],
  }), 'session-timeline: tab type')
  // Part 2: tab body (key = definition id)
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: TAB_ID },
    Panel,
  )), 'session-timeline: tab body')
  // Part 3: tab title (with this workspace's session count)
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: TAB_ID },
    TabTitle,
  )), 'session-timeline: tab title')
}
