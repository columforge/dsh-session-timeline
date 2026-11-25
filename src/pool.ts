/**
 * Build worker pool: whole-log builds run on worker threads so the host
 * event loop stays free. Jobs are served FIFO; workers spawn on demand up to
 * `limit` and are released after an idle period. A crashing worker takes the
 * pool down for a cool-off — queued and running jobs are rejected, and the
 * caller builds them on the request path instead (never worse than no pool).
 */
import { Worker } from 'node:worker_threads'
import type { BuildJob, BuildResult } from './build.js'

interface Queued { job: BuildJob; resolve: (r: BuildResult) => void; reject: (e: Error) => void }
interface Slot { worker: Worker; current: Queued | null }

export interface BuildPool {
  /** Queue one build; resolves with its result, rejects only while the pool is down. */
  build(job: BuildJob): Promise<BuildResult>
  dispose(): void
}

/** Idle workers are terminated after this long without jobs. */
export const IDLE_MS = 15000
/** Time a crashed pool stays down before it serves again. */
export const COOL_OFF_MS = 60000

export function createPool(limit: number, script: string): BuildPool {
  const queue: Queued[] = []
  const slots = new Set<Slot>()
  let failure: Error | null = null
  let idle: NodeJS.Timeout | null = null
  let coolOff: NodeJS.Timeout | null = null

  const fail = (q: Queued | null): void => {
    if (q !== null) q.reject(failure ?? new Error('build pool stopped'))
  }

  const stop = (slot: Slot): void => {
    slots.delete(slot)
    void slot.worker.terminate()
  }

  const crash = (err: Error): void => {
    if (failure !== null) return
    failure = err
    for (const slot of [...slots]) {
      fail(slot.current)
      stop(slot)
    }
    for (const q of queue.splice(0)) fail(q)
    coolOff = setTimeout(() => { failure = null }, COOL_OFF_MS)
    coolOff.unref()
  }

  const spawn = (): Slot | null => {
    let worker: Worker
    try {
      worker = new Worker(script)
    } catch (err) {
      crash(err instanceof Error ? err : new Error(String(err)))
      return null
    }
    const slot: Slot = { worker, current: null }
    slots.add(slot)
    slot.worker.on('message', (result: BuildResult) => {
      const q = slot.current
      slot.current = null
      if (q !== null) q.resolve(result)
      pump()
    })
    slot.worker.on('error', crash)
    slot.worker.on('exit', (code) => {
      if (slots.has(slot)) crash(new Error('build worker exited (code ' + code + ')'))
    })
    return slot
  }

  const pump = (): void => {
    while (queue.length > 0) {
      const free = [...slots].find((s) => s.current === null)
      const slot = free ?? (slots.size < limit ? spawn() : null)
      if (slot === null) return
      const q = queue.shift()!
      slot.current = q
      slot.worker.postMessage(q.job)
    }
    if (idle === null && slots.size > 0 && [...slots].every((s) => s.current === null)) {
      idle = setTimeout(() => {
        idle = null
        for (const slot of [...slots]) stop(slot)
      }, IDLE_MS)
      idle.unref()
    }
  }

  return {
    build(job: BuildJob): Promise<BuildResult> {
      if (failure !== null) return Promise.reject(failure)
      if (idle !== null) {
        clearTimeout(idle)
        idle = null
      }
      return new Promise<BuildResult>((resolve, reject) => {
        queue.push({ job, resolve, reject })
        pump()
      })
    },
    dispose(): void {
      if (idle !== null) clearTimeout(idle)
      if (coolOff !== null) clearTimeout(coolOff)
      failure = new Error('build pool disposed')
      for (const slot of [...slots]) stop(slot)
      for (const q of queue.splice(0)) fail(q)
    },
  }
}
