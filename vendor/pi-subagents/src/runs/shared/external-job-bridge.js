import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.js";
import { readStatus } from "../../shared/utils.js";
import { isActiveAsyncState } from "../background/active-run-index.js";
import { ExternalJobProviderError, getExternalJobProvider, validateExternalJobHandle, validateExternalJobResult, } from "../../api/external-job-provider.js";
export const EXTERNAL_JOB_BRIDGE_REQUEST_DIR = "external-job-requests";
const EXTERNAL_JOB_BRIDGE_RESPONSE_DIR = "external-job-responses";
const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 50;
const CHILD_BRIDGE_SWEEP_INTERVAL_MS = 1_000;
const MAX_REQUESTS_PER_SWEEP = 100;
const inFlight = new Set();
function requestDir(asyncDir) {
    return path.join(asyncDir, EXTERNAL_JOB_BRIDGE_REQUEST_DIR);
}
function responseDir(asyncDir) {
    return path.join(asyncDir, EXTERNAL_JOB_BRIDGE_RESPONSE_DIR);
}
function requestPath(asyncDir, id) {
    return path.join(requestDir(asyncDir), `${id}.json`);
}
function isDispatchOperation(operation) {
    return operation === "start" || operation === "follow-up";
}
function dispatchClaimDir(asyncDir, id) {
    return path.join(requestDir(asyncDir), `${id}.claim`);
}
function dispatchClaimTempDir(asyncDir, id) {
    return path.join(requestDir(asyncDir), `${id}.claim.tmp-${randomUUID()}`);
}
function dispatchClaimCompletedPath(claimDir) {
    return path.join(claimDir, "completed.json");
}
function dispatchClaimHandlePath(claimDir) {
    return path.join(claimDir, "handle.json");
}
function completedDispatchClaimExists(asyncDir, id) {
    return fs.existsSync(dispatchClaimCompletedPath(dispatchClaimDir(asyncDir, id)));
}
function cancelDispatchRequest(asyncDir, request) {
    const claimDir = dispatchClaimDir(asyncDir, request.id);
    const tempClaimDir = dispatchClaimTempDir(asyncDir, request.id);
    try {
        fs.mkdirSync(tempClaimDir);
        writeAtomicJson(dispatchClaimCompletedPath(tempClaimDir), { completedAt: Date.now() });
        fs.renameSync(tempClaimDir, claimDir);
    }
    catch (error) {
        fs.rmSync(tempClaimDir, { recursive: true, force: true });
        if (isClaimConflictError(error))
            return false;
        throw error;
    }
    fs.rmSync(requestPath(asyncDir, request.id), { force: true });
    return true;
}
function responsePath(asyncDir, id) {
    return path.join(responseDir(asyncDir), `${id}.json`);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}
function processStartIdentity(pid) {
    if (process.platform === "linux") {
        try {
            const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
            const commandEnd = stat.lastIndexOf(")");
            if (commandEnd === -1)
                return undefined;
            const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
            const startTicks = fields[19];
            return startTicks ? `linux:${startTicks}` : undefined;
        }
        catch {
            return undefined;
        }
    }
    return undefined;
}
function processIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        const code = error.code;
        if (code === "ESRCH")
            return false;
        if (code === "EPERM")
            return true;
        return undefined;
    }
}
function currentClaimOwner() {
    const startIdentity = processStartIdentity(process.pid);
    return {
        version: 1,
        pid: process.pid,
        hostname: os.hostname(),
        claimedAt: Date.now(),
        ...(startIdentity ? { processStartIdentity: startIdentity } : {}),
    };
}
function isClaimConflictError(error) {
    if (typeof error !== "object" || error === null || !("code" in error))
        return false;
    const code = error.code;
    return code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM";
}
function isNotFoundError(error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function bridgeError(error) {
    if (error instanceof ExternalJobProviderError) {
        return { code: error.code, message: error.message, ...(error.blockingJobId ? { blockingJobId: error.blockingJobId } : {}) };
    }
    if (error && typeof error === "object") {
        const record = error;
        const code = typeof record.code === "string" && record.code.trim() ? record.code : "provider-error";
        const blockingJobId = typeof record.blockingJobId === "string" && record.blockingJobId.trim() ? record.blockingJobId : undefined;
        return {
            code,
            message: error instanceof Error ? error.message : String(error),
            ...(blockingJobId ? { blockingJobId } : {}),
        };
    }
    return { code: "provider-error", message: String(error) };
}
function assertRequest(value, filePath) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`External-job bridge request '${filePath}' must be an object.`);
    const request = value;
    if (typeof request.id !== "string" || !request.id)
        throw new Error(`External-job bridge request '${filePath}' has invalid id.`);
    if (request.operation !== "start" && request.operation !== "follow-up" && request.operation !== "status" && request.operation !== "result" && request.operation !== "reattach")
        throw new Error(`External-job bridge request '${filePath}' has invalid operation.`);
    if (typeof request.provider !== "string" || !request.provider.trim())
        throw new Error(`External-job bridge request '${filePath}' has invalid provider.`);
    if (typeof request.createdAt !== "number")
        throw new Error(`External-job bridge request '${filePath}' has invalid createdAt.`);
    if (request.claimedAt !== undefined && typeof request.claimedAt !== "number")
        throw new Error(`External-job bridge request '${filePath}' has invalid claimedAt.`);
    if (request.operation === "start") {
        if (!request.start || typeof request.start !== "object" || Array.isArray(request.start))
            throw new Error(`External-job bridge start request '${filePath}' is missing start input.`);
    }
    else if (request.operation === "follow-up") {
        if (!request.followUp || typeof request.followUp !== "object" || Array.isArray(request.followUp))
            throw new Error(`External-job bridge follow-up request '${filePath}' is missing follow-up input.`);
    }
    else if (typeof request.providerJobId !== "string" || !request.providerJobId.trim()) {
        throw new Error(`External-job bridge ${request.operation} request '${filePath}' is missing providerJobId.`);
    }
    return request;
}
async function executeBridgeRequest(request, claimDir) {
    const provider = getExternalJobProvider(request.provider);
    if (!provider) {
        return {
            id: request.id,
            ok: false,
            operation: request.operation,
            provider: request.provider,
            code: "provider-unavailable",
            message: `External-job provider '${request.provider}' is not registered. Load the Surf Pi extension and its external-job provider bridge before starting this agent.`,
            completedAt: Date.now(),
        };
    }
    try {
        let raw;
        if (request.operation === "start") {
            raw = await provider.start(request.start);
        }
        else if (request.operation === "follow-up") {
            if (typeof provider.followUp !== "function") {
                throw new ExternalJobProviderError(`External-job provider '${request.provider}' does not support follow-up. Update or reload the provider package, then retry action='resume'.`, { code: "follow-up-unsupported" });
            }
            raw = await provider.followUp(request.followUp);
        }
        else {
            raw = request.operation === "status"
                ? await provider.status(request.providerJobId)
                : request.operation === "reattach"
                    ? await provider.reattach(request.providerJobId)
                    : await provider.result(request.providerJobId);
        }
        const result = request.operation === "result"
            ? validateExternalJobResult(provider.name, raw, "External-job bridge result")
            : validateExternalJobHandle(provider.name, raw, "External-job bridge handle");
        if (isDispatchOperation(request.operation) && claimDir)
            writeAtomicJson(dispatchClaimHandlePath(claimDir), result);
        return { id: request.id, ok: true, operation: request.operation, provider: request.provider, result, completedAt: Date.now() };
    }
    catch (error) {
        const details = bridgeError(error);
        return {
            id: request.id,
            ok: false,
            operation: request.operation,
            provider: request.provider,
            ...details,
            completedAt: Date.now(),
        };
    }
}
function claimDispatchRequest(asyncDir, filePath, request) {
    const owner = currentClaimOwner();
    const claimed = { ...request, claimedAt: owner.claimedAt };
    const claimDir = dispatchClaimDir(asyncDir, request.id);
    const tempClaimDir = dispatchClaimTempDir(asyncDir, request.id);
    try {
        fs.mkdirSync(tempClaimDir);
        writeAtomicJson(path.join(tempClaimDir, "owner.json"), owner);
        writeAtomicJson(path.join(tempClaimDir, "request.json"), claimed);
        fs.renameSync(tempClaimDir, claimDir);
    }
    catch (error) {
        fs.rmSync(tempClaimDir, { recursive: true, force: true });
        if (isClaimConflictError(error))
            return undefined;
        throw error;
    }
    fs.rmSync(filePath, { force: true });
    return { request: claimed, filePath: claimDir };
}
function parseClaimOwner(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const owner = value;
    if (owner.version !== 1 || typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.hostname !== "string" || typeof owner.claimedAt !== "number")
        return undefined;
    if (owner.processStartIdentity !== undefined && typeof owner.processStartIdentity !== "string")
        return undefined;
    return owner;
}
function claimOwnerIsDead(owner) {
    if (!owner || owner.hostname !== os.hostname())
        return false;
    const alive = processIsAlive(owner.pid);
    if (alive === false)
        return true;
    if (alive !== true || !owner.processStartIdentity)
        return false;
    const currentIdentity = processStartIdentity(owner.pid);
    return currentIdentity !== undefined && currentIdentity !== owner.processStartIdentity;
}
function readClaimOwner(claimDir) {
    try {
        return parseClaimOwner(readJson(path.join(claimDir, "owner.json")));
    }
    catch {
        return undefined;
    }
}
function readClaimHandle(provider, claimDir) {
    try {
        return validateExternalJobHandle(provider, readJson(dispatchClaimHandlePath(claimDir)), "External-job bridge recovered dispatch handle");
    }
    catch {
        return undefined;
    }
}
export function externalJobBridgeEligibility(steps) {
    if (!Array.isArray(steps))
        return "unknown";
    for (const step of steps) {
        const runner = step?.runner;
        if (runner === undefined)
            continue;
        if (!runner || typeof runner !== "object" || Array.isArray(runner))
            return "unknown";
        const runnerType = runner.type;
        if (typeof runnerType !== "string")
            return "unknown";
        if (runnerType === "external-job")
            return "required";
        if (runnerType !== "pi" && runnerType !== "external-cli")
            return "unknown";
    }
    return "not-required";
}
/** Services the bridges of external-job runs that a child session launched; only the root has an async job tracker. */
export function createChildExternalJobBridgeSweeper() {
    const runs = new Map();
    let timer;
    const sweep = () => {
        for (const [runId, asyncDir] of runs) {
            try {
                const status = readStatus(asyncDir);
                // The launch status has no runner metadata until the runner starts, so re-check on every sweep.
                if (externalJobBridgeEligibility(status?.steps) !== "not-required")
                    serviceExternalJobBridgeRequests(asyncDir);
                if (status && !isActiveAsyncState(status.state))
                    runs.delete(runId);
            }
            catch (error) {
                console.error(`Failed to service external-job bridge requests for '${asyncDir}':`, error);
            }
        }
        if (runs.size === 0 && timer) {
            clearInterval(timer);
            timer = undefined;
        }
        return runs.size;
    };
    return {
        track(runId, asyncDir) {
            runs.set(runId, asyncDir);
            if (timer)
                return;
            timer = setInterval(sweep, CHILD_BRIDGE_SWEEP_INTERVAL_MS);
            timer.unref?.();
        },
        sweep,
        dispose() {
            runs.clear();
            if (timer)
                clearInterval(timer);
            timer = undefined;
        },
    };
}
export function serviceExternalJobBridgeRequests(asyncDir) {
    let files;
    try {
        files = fs.readdirSync(requestDir(asyncDir), { withFileTypes: true })
            .filter((entry) => (entry.isFile() && entry.name.endsWith(".json") && !completedDispatchClaimExists(asyncDir, entry.name.replace(/\.json$/, ""))) || (entry.isDirectory() && entry.name.endsWith(".claim") && !fs.existsSync(dispatchClaimCompletedPath(path.join(requestDir(asyncDir), entry.name)))))
            .map((entry) => entry.name)
            .slice(0, MAX_REQUESTS_PER_SWEEP);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return;
        throw error;
    }
    fs.mkdirSync(responseDir(asyncDir), { recursive: true });
    for (const file of files) {
        serviceExternalJobBridgeRequestFile(asyncDir, file);
    }
}
export function serviceExternalJobBridgeRequestFile(asyncDir, file) {
    fs.mkdirSync(responseDir(asyncDir), { recursive: true });
    if (file.endsWith(".claim")) {
        serviceExternalJobDispatchClaim(asyncDir, file);
        return;
    }
    const filePath = path.join(requestDir(asyncDir), file);
    let request;
    try {
        request = assertRequest(readJson(filePath), filePath);
    }
    catch (error) {
        if (isNotFoundError(error))
            return;
        const id = file.replace(/\.json$/, "");
        writeAtomicJson(responsePath(asyncDir, id), {
            id,
            ok: false,
            operation: "status",
            provider: "unknown",
            code: "malformed-request",
            message: error instanceof Error ? error.message : String(error),
            completedAt: Date.now(),
        });
        fs.rmSync(filePath, { force: true });
        return;
    }
    if (isDispatchOperation(request.operation) && completedDispatchClaimExists(asyncDir, request.id)) {
        fs.rmSync(filePath, { force: true });
        return;
    }
    if (inFlight.has(request.id) || fs.existsSync(responsePath(asyncDir, request.id)))
        return;
    if (isDispatchOperation(request.operation) && request.claimedAt !== undefined)
        return;
    const claimed = isDispatchOperation(request.operation) ? claimDispatchRequest(asyncDir, filePath, request) : { request, filePath };
    if (!claimed)
        return;
    const claimedRequest = claimed.request;
    inFlight.add(claimedRequest.id);
    void executeBridgeRequest(claimedRequest, isDispatchOperation(claimedRequest.operation) ? claimed.filePath : undefined).then((response) => {
        writeAtomicJson(responsePath(asyncDir, claimedRequest.id), response);
        if (isDispatchOperation(claimedRequest.operation)) {
            writeAtomicJson(dispatchClaimCompletedPath(claimed.filePath), { completedAt: Date.now() });
        }
        else {
            fs.rmSync(claimed.filePath, { recursive: true, force: true });
        }
    }).catch((error) => {
        writeAtomicJson(responsePath(asyncDir, claimedRequest.id), {
            id: claimedRequest.id,
            ok: false,
            operation: claimedRequest.operation,
            provider: claimedRequest.provider,
            code: "bridge-error",
            message: error instanceof Error ? error.message : String(error),
            completedAt: Date.now(),
        });
        if (isDispatchOperation(claimedRequest.operation))
            writeAtomicJson(dispatchClaimCompletedPath(claimed.filePath), { completedAt: Date.now() });
    }).finally(() => {
        inFlight.delete(claimedRequest.id);
    });
}
function serviceExternalJobDispatchClaim(asyncDir, file) {
    const claimDir = path.join(requestDir(asyncDir), file);
    if (fs.existsSync(dispatchClaimCompletedPath(claimDir)))
        return;
    const owner = readClaimOwner(claimDir);
    if (!owner && fs.existsSync(requestPath(asyncDir, file.replace(/\.claim$/, ""))) && !fs.existsSync(responsePath(asyncDir, file.replace(/\.claim$/, "")))) {
        fs.rmSync(claimDir, { recursive: true, force: true });
        return;
    }
    if (!claimOwnerIsDead(owner))
        return;
    let request;
    try {
        request = assertRequest(readJson(path.join(claimDir, "request.json")), path.join(claimDir, "request.json"));
    }
    catch {
        return;
    }
    if (!isDispatchOperation(request.operation) || fs.existsSync(responsePath(asyncDir, request.id)))
        return;
    const handle = readClaimHandle(request.provider, claimDir);
    if (handle) {
        writeAtomicJson(responsePath(asyncDir, request.id), {
            id: request.id,
            ok: true,
            operation: request.operation,
            provider: request.provider,
            result: handle,
            completedAt: Date.now(),
        });
        writeAtomicJson(dispatchClaimCompletedPath(claimDir), { completedAt: Date.now() });
        fs.rmSync(requestPath(asyncDir, request.id), { force: true });
        return;
    }
    writeAtomicJson(responsePath(asyncDir, request.id), {
        id: request.id,
        ok: false,
        operation: request.operation,
        provider: request.provider,
        code: `${request.operation}-dispatch-abandoned`,
        message: `External-job ${request.operation} for provider '${request.provider}' was claimed by a host process that is no longer alive before a provider job id was committed. Refusing to redispatch the prompt automatically.`,
        completedAt: Date.now(),
    });
    fs.rmSync(claimDir, { recursive: true, force: true });
    fs.rmSync(requestPath(asyncDir, request.id), { force: true });
}
export async function requestExternalJobOperation(asyncDir, request, timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS, cancel) {
    const id = randomUUID();
    fs.mkdirSync(requestDir(asyncDir), { recursive: true });
    fs.mkdirSync(responseDir(asyncDir), { recursive: true });
    const bridgeRequest = { ...request, id, createdAt: Date.now() };
    writeAtomicJson(requestPath(asyncDir, id), bridgeRequest);
    const deadline = isDispatchOperation(request.operation) ? undefined : Date.now() + timeoutMs;
    const outPath = responsePath(asyncDir, id);
    while (!fs.existsSync(outPath)) {
        const canceled = cancel?.();
        if (canceled) {
            if (isDispatchOperation(request.operation) && !cancelDispatchRequest(asyncDir, bridgeRequest)) {
                await sleep(POLL_INTERVAL_MS);
                continue;
            }
            if (!isDispatchOperation(request.operation))
                fs.rmSync(requestPath(asyncDir, id), { force: true });
            throw canceled;
        }
        if (deadline !== undefined && Date.now() >= deadline) {
            throw new ExternalJobProviderError(`External-job provider bridge did not respond to ${request.operation} for provider '${request.provider}' within ${timeoutMs}ms.`, { code: "bridge-timeout" });
        }
        await sleep(POLL_INTERVAL_MS);
    }
    const response = readJson(outPath);
    fs.rmSync(outPath, { force: true });
    if (!response.ok)
        throw new ExternalJobProviderError(response.message, { code: response.code, ...(response.blockingJobId ? { blockingJobId: response.blockingJobId } : {}) });
    return response.result;
}
//# sourceMappingURL=external-job-bridge.js.map