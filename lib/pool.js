/**
 * Build worker pool: whole-log builds run on worker threads so the host
 * event loop stays free. Jobs are served FIFO; workers spawn on demand up to
 * `limit` and are released after an idle period. A crashing worker takes the
 * pool down for a cool-off — queued and running jobs are rejected, and the
 * caller builds them on the request path instead (never worse than no pool).
 */
import { Worker } from 'node:worker_threads';
/** Idle workers are terminated after this long without jobs. */
export const IDLE_MS = 15000;
/** Time a crashed pool stays down before it serves again. */
export const COOL_OFF_MS = 60000;
export function createPool(limit, script) {
    const queue = [];
    const slots = new Set();
    let failure = null;
    let idle = null;
    let coolOff = null;
    const fail = (q) => {
        if (q !== null)
            q.reject(failure ?? new Error('build pool stopped'));
    };
    const stop = (slot) => {
        slots.delete(slot);
        void slot.worker.terminate();
    };
    const crash = (err) => {
        if (failure !== null)
            return;
        failure = err;
        for (const slot of [...slots]) {
            fail(slot.current);
            stop(slot);
        }
        for (const q of queue.splice(0))
            fail(q);
        coolOff = setTimeout(() => { failure = null; }, COOL_OFF_MS);
        coolOff.unref();
    };
    const spawn = () => {
        let worker;
        try {
            worker = new Worker(script);
        }
        catch (err) {
            crash(err instanceof Error ? err : new Error(String(err)));
            return null;
        }
        const slot = { worker, current: null };
        slots.add(slot);
        slot.worker.on('message', (result) => {
            const q = slot.current;
            slot.current = null;
            if (q !== null)
                q.resolve(result);
            pump();
        });
        slot.worker.on('error', crash);
        slot.worker.on('exit', (code) => {
            if (slots.has(slot))
                crash(new Error('build worker exited (code ' + code + ')'));
        });
        return slot;
    };
    const pump = () => {
        while (queue.length > 0) {
            const free = [...slots].find((s) => s.current === null);
            const slot = free ?? (slots.size < limit ? spawn() : null);
            if (slot === null)
                return;
            const q = queue.shift();
            slot.current = q;
            slot.worker.postMessage(q.job);
        }
        if (idle === null && slots.size > 0 && [...slots].every((s) => s.current === null)) {
            idle = setTimeout(() => {
                idle = null;
                for (const slot of [...slots])
                    stop(slot);
            }, IDLE_MS);
            idle.unref();
        }
    };
    return {
        build(job) {
            if (failure !== null)
                return Promise.reject(failure);
            if (idle !== null) {
                clearTimeout(idle);
                idle = null;
            }
            return new Promise((resolve, reject) => {
                queue.push({ job, resolve, reject });
                pump();
            });
        },
        dispose() {
            if (idle !== null)
                clearTimeout(idle);
            if (coolOff !== null)
                clearTimeout(coolOff);
            failure = new Error('build pool disposed');
            for (const slot of [...slots])
                stop(slot);
            for (const q of queue.splice(0))
                fail(q);
        },
    };
}
//# sourceMappingURL=pool.js.map