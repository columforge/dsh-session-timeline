/** Index build worker entry: one message = one BuildJob → one BuildResult reply. */
import { parentPort } from 'node:worker_threads'
import { buildJob, type BuildJob } from './build.js'

parentPort?.on('message', (job: BuildJob) => {
  void buildJob(job).then((result) => parentPort?.postMessage(result))
})
