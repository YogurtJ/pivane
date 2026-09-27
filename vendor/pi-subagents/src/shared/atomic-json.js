import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS, runFileSystemOperationWithRetry, waitForFileSystemRetry } from "./file-system-retry.js";
const MAX_PATH_COMPONENT_BYTES = 255;
function renameWithRetry(fsImpl, sourcePath, targetPath, retryDelaysMs, wait) {
    runFileSystemOperationWithRetry(() => {
        fsImpl.renameSync(sourcePath, targetPath);
    }, { retryDelaysMs, wait });
}
function tempBaseName(filePath, pid, nowMs, randomId) {
    const suffix = `.${pid}.${nowMs}.${randomId}.tmp`;
    const preferred = `.${path.basename(filePath)}${suffix}`;
    if (Buffer.byteLength(preferred, "utf-8") <= MAX_PATH_COMPONENT_BYTES)
        return preferred;
    return `.${createHash("sha256").update(path.basename(filePath)).digest("hex")}${suffix}`;
}
export function createAtomicJsonWriter(options = {}) {
    const fsImpl = options.fs ?? fs;
    const now = options.now ?? Date.now;
    const pid = options.pid ?? process.pid;
    const random = options.random ?? Math.random;
    const mode = options.mode;
    const retryRenameErrors = options.retryRenameErrors ?? process.platform === "win32";
    const retryDirectoryErrors = options.retryDirectoryErrors ?? retryRenameErrors;
    const ignoreCleanupErrorAfterSuccess = options.ignoreCleanupErrorAfterSuccess ?? false;
    const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS;
    const renameRetryDelaysMs = retryRenameErrors ? retryDelaysMs : [];
    const directoryRetryDelaysMs = retryDirectoryErrors ? retryDelaysMs : [];
    const wait = options.wait ?? waitForFileSystemRetry;
    return (filePath, payload) => {
        runFileSystemOperationWithRetry(() => {
            fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
        }, { retryDelaysMs: directoryRetryDelaysMs, wait });
        const tempPath = path.join(path.dirname(filePath), tempBaseName(filePath, pid, now(), random().toString(36).slice(2)));
        let writeError;
        try {
            fsImpl.writeFileSync(tempPath, JSON.stringify(payload, null, 2), mode === undefined ? "utf-8" : { encoding: "utf-8", mode });
            renameWithRetry(fsImpl, tempPath, filePath, renameRetryDelaysMs, wait);
        }
        catch (error) {
            writeError = error;
            throw error;
        }
        finally {
            try {
                fsImpl.rmSync(tempPath, { force: true });
            }
            catch (cleanupError) {
                // Preserve the write/rename failure: cleanup is best effort and must
                // not hide the error callers need to classify or report.
                if (writeError === undefined && !ignoreCleanupErrorAfterSuccess)
                    throw cleanupError;
            }
        }
    };
}
export const writeAtomicJson = createAtomicJsonWriter();
export const writePrivateAtomicJson = createAtomicJsonWriter({ mode: 0o600 });
//# sourceMappingURL=atomic-json.js.map