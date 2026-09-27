import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
const MAX_PROBE_OUTPUT_BYTES = 256 * 1024;
const MAX_PROBE_TIMEOUT_MS = 5_000;
const MAX_REMOTE_PROBE_TIMEOUT_MS = 15_000;
const MAX_CACHE_ENTRIES = 64;
const MAX_AVAILABILITY_REASON_LENGTH = 256;
const cache = new Map();
const lookup = new Map();
function resolveBinary(command, env) {
    if (path.isAbsolute(command) || command.includes(path.sep)) {
        const resolved = path.resolve(command);
        fs.accessSync(resolved, fs.constants.X_OK);
        return resolved;
    }
    const extensions = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
    for (const directory of (env.PATH ?? "").split(path.delimiter)) {
        if (!directory)
            continue;
        for (const extension of extensions) {
            const candidate = path.join(directory, `${command}${extension}`);
            try {
                fs.accessSync(candidate, fs.constants.X_OK);
                return fs.realpathSync(candidate);
            }
            catch { }
        }
    }
    throw new Error(`External CLI binary '${command}' was not found on PATH.`);
}
/** Resolve only the configured command; unlike preflight, this never starts a child process. */
export function resolveExternalCliBinaryAvailability(command, env) {
    try {
        resolveBinary(command, env);
        return { available: true };
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { available: false, unavailableReason: reason.slice(0, MAX_AVAILABILITY_REASON_LENGTH) };
    }
}
function probeWithTimeout(binaryPath, args, env, label, timeoutMs, cwd) {
    const result = spawnSync(binaryPath, [...args], {
        cwd,
        env,
        encoding: "utf-8",
        killSignal: "SIGKILL",
        maxBuffer: MAX_PROBE_OUTPUT_BYTES,
        timeout: timeoutMs,
        windowsHide: true,
    });
    if (result.error)
        throw new Error(`External CLI ${label} preflight failed: ${result.error.message}`, { cause: result.error });
    if (result.status !== 0)
        throw new Error(`External CLI ${label} preflight exited with code ${result.status}: ${(result.stderr || result.stdout).trim()}`);
    return result.stdout.trim();
}
function narrowPositiveInteger(value, ceiling, label) {
    if (value === undefined)
        return ceiling;
    if (!Number.isSafeInteger(value) || value <= 0 || value > ceiling)
        throw new Error(`${label} may only narrow the code-owned ceiling of ${ceiling}.`);
    return value;
}
function specKey(spec) {
    return JSON.stringify([spec.id, spec.versionArgs, spec.helpArgs, spec.evidenceArgs, spec.evidenceLabel, spec.probeTimeoutMs, spec.remote === true]);
}
export function preflightExternalCli(command, spec, env, cwd) {
    const binaryPath = resolveBinary(command, env);
    const binaryMtimeMs = fs.statSync(binaryPath).mtimeMs;
    const lookupKey = JSON.stringify([binaryPath, binaryMtimeMs, specKey(spec)]);
    const cachedKey = lookup.get(lookupKey);
    const cached = cachedKey ? cache.get(cachedKey) : undefined;
    const ceiling = spec.remote === true ? MAX_REMOTE_PROBE_TIMEOUT_MS : MAX_PROBE_TIMEOUT_MS;
    const probeTimeoutMs = narrowPositiveInteger(spec.probeTimeoutMs, ceiling, "probeTimeoutMs");
    const base = cached ?? {
        binaryPath,
        binaryMtimeMs,
        version: probeWithTimeout(binaryPath, spec.versionArgs, env, "version", probeTimeoutMs, cwd),
        help: probeWithTimeout(binaryPath, spec.helpArgs, env, "help", probeTimeoutMs, cwd),
    };
    const evidence = spec.evidenceArgs
        ? probeWithTimeout(binaryPath, spec.evidenceArgs, env, spec.evidenceLabel ?? "evidence", probeTimeoutMs, cwd)
        : undefined;
    const result = { ...base, ...(evidence !== undefined ? { evidence } : {}), cacheHit: Boolean(cached) };
    spec.validate?.(result);
    if (!cached) {
        const cacheKey = JSON.stringify([binaryPath, base.version, binaryMtimeMs, specKey(spec)]);
        cache.set(cacheKey, base);
        lookup.set(lookupKey, cacheKey);
        while (cache.size > MAX_CACHE_ENTRIES) {
            const oldest = cache.keys().next().value;
            cache.delete(oldest);
            for (const [candidateLookup, candidateCache] of lookup)
                if (candidateCache === oldest)
                    lookup.delete(candidateLookup);
        }
    }
    return result;
}
export function invalidateExternalCliPreflight(command, spec, _reason) {
    const key = specKey(spec);
    for (const [cacheKey, entry] of cache) {
        if (entry.binaryPath === command || entry.binaryPath.endsWith(`${path.sep}${command}`) || cacheKey.includes(key))
            cache.delete(cacheKey);
    }
    for (const [lookupKey, cacheKey] of lookup)
        if (!cache.has(cacheKey))
            lookup.delete(lookupKey);
}
export function clearExternalCliPreflightCacheForTests() {
    cache.clear();
    lookup.clear();
}
//# sourceMappingURL=external-cli-preflight.js.map