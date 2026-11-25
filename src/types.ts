/** Timeline data shapes shared by the host API and the pure modules (no logic). */
import type { HandoffHit } from './parse.js'

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
  /** Where the effective parent link came from: raw header.parentSession,
   *  or inferred from the fork's inherited-prefix signature (native forks
   *  stopped writing parentSession in DSH v0.2.2-alpha.2). */
  parentSource: 'header' | 'inferred' | null
  /** Own fork marker seq (= inherited prefix length; null = not a native fork). */
  forkMarkerSeq: number | null
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

/** Native edge kind: the child's lineage nature — 'branch' when the child is
 *  a fork (own inherited end-seed marker) or the parent has multiple children;
 *  'handoff' only for a chained single non-fork child. */
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
