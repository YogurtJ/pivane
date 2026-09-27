import { isStorageCapacityError } from "./file-system-retry.js";
import { writeAtomicJson } from "./atomic-json.js";
const defaultTimerApi = {
    setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
    clearTimeout: (handle) => clearTimeout(handle),
};
/**
 * Defers only storage-capacity failures, retaining the newest payload per path.
 * Initial/ordinary writes remain synchronous and preserve their throwing contract;
 * only ENOSPC-like failures enter the guarded retry loop.
 */
export function createCapacityResilientJsonWriter(options = {}) {
    const defaultWrite = options.write ?? writeAtomicJson;
    const keepAlive = options.keepAlive ?? false;
    const retryDelayMs = options.retryDelayMs ?? 1_000;
    const timerApi = options.timerApi ?? defaultTimerApi;
    const onError = options.onError ?? ((error, filePath) => console.error(`Failed to persist JSON '${filePath}':`, error));
    const onSuccess = options.onSuccess;
    const reportError = (error, filePath) => {
        try {
            onError(error, filePath);
        }
        catch (callbackError) {
            console.error(`Failed to report JSON persistence error for '${filePath}':`, callbackError);
        }
    };
    const notifySuccess = (filePath, payload) => {
        if (!onSuccess)
            return;
        try {
            onSuccess(filePath, payload);
        }
        catch (error) {
            reportError(error, filePath);
        }
    };
    const pending = new Map();
    let retryTimer;
    const scheduleRetry = () => {
        if (retryTimer !== undefined)
            return;
        retryTimer = timerApi.setTimeout(() => {
            retryTimer = undefined;
            for (const [filePath, entry] of pending) {
                try {
                    entry.write(filePath, entry.payload);
                    pending.delete(filePath);
                    notifySuccess(filePath, entry.payload);
                }
                catch (error) {
                    if (isStorageCapacityError(error))
                        continue;
                    pending.delete(filePath);
                    reportError(error, filePath);
                }
            }
            if (pending.size > 0)
                scheduleRetry();
        }, retryDelayMs);
        if (!keepAlive && typeof retryTimer === "object" && retryTimer !== null && "unref" in retryTimer && typeof retryTimer.unref === "function") {
            retryTimer.unref();
        }
    };
    return {
        write(filePath, payload, writeOperation = defaultWrite) {
            try {
                writeOperation(filePath, payload);
                pending.delete(filePath);
                notifySuccess(filePath, payload);
            }
            catch (error) {
                if (!isStorageCapacityError(error))
                    throw error;
                pending.set(filePath, { payload, write: writeOperation });
                scheduleRetry();
            }
        },
        pendingCount: () => pending.size,
        dispose: () => {
            if (retryTimer !== undefined)
                timerApi.clearTimeout(retryTimer);
            retryTimer = undefined;
            pending.clear();
        },
    };
}
//# sourceMappingURL=capacity-resilient-json.js.map