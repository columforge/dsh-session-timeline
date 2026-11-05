/**
 * @columforge/session-timeline — session timeline (right-panel tab).
 * Host side: scans ~/.dsh/sessions/<bucket>/<sessionId>/session.v4.jsonl.zstd
 * for the header (createdAt / parentSession / isSeeded / cwd), the first real
 * user message time (creation-time criterion), the last session/title, and
 * handoff skill invocations (user/message + source.kind=skill-invocation +
 * name=handoff; seq/time/turn each — parsing in ./parse).
 * Top-level sessions (session- prefixed id) are timeline nodes; parentSession
 * pointing at an in-bucket top-level session forms a native edge — one child
 * = handoff link, multiple children = branch. Native forks stopped writing
 * parentSession (DSH v0.2.2-alpha.2): children with an own fork marker
 * (last session/end-seed carrying inherited:true; parse.ts) recover their
 * source via inherited-prefix signature matching (lineage-infer.ts, same
 * bucket only, earliest header.createdAt tie-break) — parentSource marks
 * header vs inferred lineage.
 * Manual drag links are stored per workspace at ~/.dsh/session-timeline/<bucket>.json.
 * API (/session-timeline/api):
 *   GET  /workspaces?session=…        workspace list (buckets)
 *   GET  /list?session=…&workspace=…  nodes (+archived flag) + native edges + manual links
 *   POST /link   { session?, workspace?, from, to }
 *   POST /unlink { session?, workspace?, from, to }
 * workspace=__global__ (all-workspaces canvas) is accepted by /list to
 * aggregate every bucket, and by /link and /unlink — there each endpoint is
 * resolved back to its own bucket (lineage never crosses workspaces; a
 * cross-workspace link pair fails with the stable `crossWorkspace` code).
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
import type { Context } from 'cordis';
import z from 'schemastery';
import type { HandoffHit } from './parse.js';
export declare const name = "@columforge/session-timeline";
export declare const inject: string[];
export interface Config {
    /** Manual-link storage root; empty = <DSH_HOME>/session-timeline */
    storage_dir: string;
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    storage_dir: z<string, string, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    storage_dir: z<string, string, "defined">;
}>>, "plain">;
/** Timeline node (top-level session). */
export interface SessionNode {
    id: string;
    title: string | null;
    /** Creation time = first real user message time; falls back to header.createdAt when none. */
    createdAt: number;
    /** Raw header.createdAt (session object written time; display reconciliation). */
    logCreatedAt: number;
    /** Raw header.parentSession (may point outside the bucket or to a deleted session). */
    parent: string | null;
    /** Where the effective parent link came from: raw header.parentSession,
     *  or inferred from the fork's inherited-prefix signature (native forks
     *  stopped writing parentSession in DSH v0.2.2-alpha.2). */
    parentSource: 'header' | 'inferred' | null;
    /** Own fork marker seq (= inherited prefix length; null = not a native fork). */
    forkMarkerSeq: number | null;
    /** header.isSeeded: opened from a handoff context seed. */
    seeded: boolean;
    cwd: string | null;
    /** Owning workspace (session bucket). */
    bucket: string;
    /** Last activity (last log event time); used for positioning/display. */
    lastAt: number;
    /** Handoff skill ran in the first conversation window. */
    handoffFirst: boolean;
    /** Any handoff skill invocation appeared (gold "no successor" criterion; not last-window only). */
    handoffUsed: boolean;
    /** Handoff skill invocations (seq/time/turn, in log order). */
    handoffHits: HandoffHit[];
    /** In the workspace registry's archive set (stamped at /list assembly; not part of the parse cache). */
    archived: boolean;
}
/** Native edge: handoff (single child, chained) / branch (multiple children). */
export interface NativeEdge {
    from: string;
    to: string;
    kind: 'handoff' | 'branch';
}
/** Manual link (from = earlier-created side; semantics: "to" links from "from"). */
export interface ManualLink {
    from: string;
    to: string;
    created_at: string;
}
/** Workspace (session bucket) summary. */
export interface WorkspaceInfo {
    bucket: string;
    cwd: string | null;
    sessions: number;
    /** Newest session file mtime in the bucket (epoch ms). */
    newest: number;
}
/** Sentinel bucket name for the global timeline (/list?workspace=__global__ aggregates all;
 *  /link and /unlink resolve each endpoint back to its own bucket). */
export declare const GLOBAL_BUCKET = "__global__";
/** Workspace path → bucket encoding: /a/b → --a-b-- (matches decisions-tracker). */
export declare function encodeBucket(workspacePath: string): string;
export declare function apply(ctx: Context, config: Config): void;
