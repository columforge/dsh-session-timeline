import type { BuildJob, BuildResult } from './build.js';
export interface BuildPool {
    /** Queue one build; resolves with its result, rejects only while the pool is down. */
    build(job: BuildJob): Promise<BuildResult>;
    dispose(): void;
}
/** Idle workers are terminated after this long without jobs. */
export declare const IDLE_MS = 15000;
/** Time a crashed pool stays down before it serves again. */
export declare const COOL_OFF_MS = 60000;
export declare function createPool(limit: number, script: string): BuildPool;
