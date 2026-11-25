/**
 * @columforge/session-timeline — session timeline (right-panel tab).
 * Host side: scans ~/.dsh/sessions/<bucket>/<sessionId>/session.v4.jsonl.zstd
 * for the header (createdAt / parentSession / isSeeded / cwd), the first real
 * user message time (creation-time criterion), the last session/title, and
 * handoff skill invocations (user/message + source.kind=skill-invocation +
 * name=handoff; seq/time/turn each — parsing in ./parse). Turn dialogs for
 * /turns extract in ./turns (single source of the turn-attribution rules,
 * served through an mtime+size cache).
 * Top-level sessions (session- prefixed id) are timeline nodes; parentSession
 * pointing at an in-bucket top-level session forms a native edge — one child
 * = handoff link, multiple children = branch. Native forks stopped writing
 * parentSession (DSH v0.2.2-alpha.2): children with an own fork marker
 * (last session/end-seed carrying inherited:true; parse.ts) recover their
 * source via inherited-prefix signature matching (lineage-infer.ts, same
 * bucket only, earliest header.createdAt tie-break) — parentSource marks
 * header vs inferred lineage.
 * Manual drag links are stored per workspace at ~/.dsh/session-timeline/<bucket>.json.
 *
 * Loading strategy (the table is an index, the logs are the truth):
 * - Each top-level session has a record (./record) kept at
 *   <storage>/index/<bucket>.json (+ event signatures in <bucket>.sig.json),
 *   validated against its log file by size + mtime on every request.
 * - Unchanged file → the record as is (no read, no decompress).
 * - Grown file (logs are append-only zstd frames) → the appended frames are
 *   decoded and merged into the record on the request path.
 * - New or otherwise changed file → rebuilt from the whole log on a worker
 *   thread (./worker, ./pool). While that runs the table answers at once
 *   with the previous record or a skeleton (first frame header + last frame
 *   activity) and `partial: true`; the client polls fast until it settles.
 * - Child (subagent) sessions are never parsed in full: /workspaces reads
 *   their header from the first frame alone.
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
 * each /list node at response time — never into the index, because
 * archiving changes nothing in the session log file.
 */
import type { Context } from 'cordis';
import z from 'schemastery';
export type { ManualLink, NativeEdge, SessionNode, WorkspaceInfo } from './types.js';
export declare const name = "@columforge/session-timeline";
export declare const inject: string[];
export interface Config {
    /** Manual-link storage root; empty = <DSH_HOME>/session-timeline (the session index lives in its index/ subfolder) */
    storage_dir: string;
    /** Worker threads for whole-log index builds: -1 = auto (cores − 1, capped at 4);
     *  0 = build on the request path (blocks the host like earlier versions); N = thread count. */
    workers: number;
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    storage_dir: z<string, string, "defined">;
    workers: z<number, number, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    storage_dir: z<string, string, "defined">;
    workers: z<number, number, "defined">;
}>>, "plain">;
/** Sentinel bucket name for the global timeline (/list?workspace=__global__ aggregates all;
 *  /link and /unlink resolve each endpoint back to its own bucket). */
export declare const GLOBAL_BUCKET = "__global__";
/** Workspace path → bucket encoding: /a/b → --a-b-- (matches decisions-tracker). */
export declare function encodeBucket(workspacePath: string): string;
export declare function apply(ctx: Context, config: Config): void;
