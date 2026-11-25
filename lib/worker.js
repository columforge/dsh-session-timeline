/** Index build worker entry: one message = one BuildJob → one BuildResult reply. */
import { parentPort } from 'node:worker_threads';
import { buildJob } from './build.js';
parentPort?.on('message', (job) => {
    void buildJob(job).then((result) => parentPort?.postMessage(result));
});
//# sourceMappingURL=worker.js.map