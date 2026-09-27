export function isParallelGroup(step) {
    return "parallel" in step && Array.isArray(step.parallel);
}
export function isDynamicRunnerGroup(step) {
    return "expand" in step && "collect" in step && "parallel" in step && !Array.isArray(step.parallel);
}
export function flattenSteps(steps) {
    const flat = [];
    for (const step of steps) {
        if (isParallelGroup(step)) {
            for (const task of step.parallel)
                flat.push(task);
        }
        else if (isDynamicRunnerGroup(step)) {
            continue;
        }
        else {
            flat.push(step);
        }
    }
    return flat;
}
export const DEFAULT_GLOBAL_CONCURRENCY_LIMIT = 20;
/**
 * A promise-based semaphore for limiting concurrent access across multiple
 * mapConcurrent calls within a single run. Enforces a global cap on the total
 * number of subagent tasks executing simultaneously, regardless of each step's
 * per-step concurrency limit.
 */
export class Semaphore {
    available;
    queue = [];
    constructor(limit) {
        this.available = Math.max(1, Math.floor(limit) || 1);
    }
    acquire() {
        if (this.available > 0) {
            this.available--;
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.queue.push(resolve);
        });
    }
    release() {
        const next = this.queue.shift();
        if (next) {
            next();
        }
        else {
            this.available++;
        }
    }
}
export async function mapConcurrent(items, limit, fn, globalSemaphore, 
/** Invoked after every worker has stopped, including workers outliving an early rejection. */
onSchedulingSettled) {
    const safeLimit = Math.max(1, Math.floor(limit) || 1);
    const results = new Array(items.length);
    let next = 0;
    let liveWorkers = Math.min(safeLimit, items.length);
    const notifySchedulingSettled = () => {
        try {
            onSchedulingSettled?.();
        }
        catch {
            // Scheduling lifecycle cleanup must not replace the worker result.
        }
    };
    async function worker(_workerIndex) {
        try {
            while (next < items.length) {
                const i = next++;
                if (!(i in items))
                    throw new Error(`Missing parallel item at index ${i}`);
                const item = items[i];
                if (globalSemaphore) {
                    await globalSemaphore.acquire();
                    try {
                        results[i] = await fn(item, i);
                    }
                    finally {
                        globalSemaphore.release();
                    }
                }
                else {
                    results[i] = await fn(item, i);
                }
            }
        }
        finally {
            liveWorkers--;
            if (liveWorkers === 0)
                notifySchedulingSettled();
        }
    }
    if (liveWorkers === 0)
        notifySchedulingSettled();
    await Promise.all(Array.from({ length: liveWorkers }, (_, wi) => worker(wi)));
    return results;
}
export function aggregateParallelOutputs(results, headerFormat = (i, agent) => `=== Parallel Task ${i + 1} (${agent}) ===`) {
    return results
        .map((r, i) => {
        const header = headerFormat(r.taskIndex ?? i, r.agent);
        const hasOutput = Boolean(r.output?.trim());
        const status = r.timedOut
            ? `TIMED OUT${r.error ? `: ${r.error}` : ""}`
            : r.exitCode === -1
                ? "SKIPPED"
                : r.exitCode !== 0 && r.exitCode !== null
                    ? `FAILED (exit code ${r.exitCode})${r.error ? `: ${r.error}` : ""}`
                    : r.error
                        ? `WARNING: ${r.error}`
                        : !hasOutput && r.outputTargetPath && r.outputTargetExists === false
                            ? `EMPTY OUTPUT (expected output file missing: ${r.outputTargetPath})`
                            : !hasOutput && !r.outputTargetPath
                                ? "EMPTY OUTPUT (no textual response returned)"
                                : "";
        const body = status ? (hasOutput ? `${status}\n${r.output}` : status) : r.output;
        return `${header}\n${body}`;
    })
        .join("\n\n");
}
export const MAX_PARALLEL_CONCURRENCY = 4;
//# sourceMappingURL=parallel-utils.js.map