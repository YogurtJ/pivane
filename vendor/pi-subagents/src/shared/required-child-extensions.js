import * as fs from "node:fs";
import * as path from "node:path";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_REQUIRED_EXTENSIONS = 32;
const MAX_PATH_BYTES = 4096;
const EMPTY_SNAPSHOT = Object.freeze([]);
/** Validate and freeze a snapshot; registration canonicalizes once, while retained launches preserve that identity. */
export function snapshotRequiredChildExtensions(value, label = "Required child extensions", canonicalizeFiles = false) {
    if (!Array.isArray(value) || value.length > MAX_REQUIRED_EXTENSIONS)
        throw new Error(`${label} must be an array of at most ${MAX_REQUIRED_EXTENSIONS} entries.`);
    const ids = new Set();
    const paths = new Set();
    return Object.freeze(value.map((entry, index) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).some((key) => key !== "id" && key !== "path"))
            throw new Error(`${label} entry ${index} requires only id and path.`);
        const id = "id" in entry ? entry.id : undefined;
        const rawPath = "path" in entry ? entry.path : undefined;
        if (typeof id !== "string" || !ID_PATTERN.test(id))
            throw new Error(`${label} entry ${index} requires a safe id of at most 128 characters.`);
        if (ids.has(id))
            throw new Error(`${label} id '${id}' is duplicated.`);
        if (typeof rawPath !== "string" || !rawPath.trim() || rawPath.includes("\0") || Buffer.byteLength(rawPath, "utf8") > MAX_PATH_BYTES || (!canonicalizeFiles && !path.isAbsolute(rawPath)))
            throw new Error(`${label} '${id}' requires ${canonicalizeFiles ? "a" : "an absolute"} non-empty path of at most ${MAX_PATH_BYTES} bytes without NUL.`);
        let extensionPath = rawPath;
        if (canonicalizeFiles) {
            try {
                extensionPath = fs.realpathSync(path.resolve(rawPath));
                if (!fs.statSync(extensionPath).isFile())
                    throw new Error("not a file");
            }
            catch (error) {
                throw new Error(`${label} '${id}' is not an importable file: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        if (paths.has(extensionPath))
            throw new Error(`${label} path '${extensionPath}' is duplicated.`);
        ids.add(id);
        paths.add(extensionPath);
        return Object.freeze({ id, path: extensionPath });
    }));
}
function registry() {
    const key = Symbol.for("pi-subagents.required-child-extensions.v1");
    const root = globalThis;
    const existing = root[key];
    if (existing === undefined) {
        const created = { version: 1, bySession: new Map() };
        root[key] = created;
        return created;
    }
    if (!existing || typeof existing !== "object" || !("version" in existing) || existing.version !== 1 || !("bySession" in existing) || !(existing.bySession instanceof Map))
        throw new Error("Malformed or unsupported required child extension registry.");
    return { version: 1, bySession: existing.bySession };
}
/** Register one immutable host-required extension snapshot for a parent session. */
export function registerRequiredChildExtensions(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => key !== "sessionId" && key !== "extensions"))
        throw new Error("Required child extension registration requires only sessionId and extensions.");
    if (typeof input.sessionId !== "string" || !input.sessionId || input.sessionId.trim() !== input.sessionId || input.sessionId.length > 256 || input.sessionId.includes("\0"))
        throw new Error("Required child extension registration requires a non-empty trimmed sessionId of at most 256 characters without NUL.");
    const frozen = snapshotRequiredChildExtensions(input.extensions, "Required child extensions", true);
    const store = registry();
    if (store.bySession.has(input.sessionId))
        throw new Error(`Required child extensions are already registered for session '${input.sessionId}'; dispose them first.`);
    store.bySession.set(input.sessionId, frozen);
    return { dispose() { if (store.bySession.get(input.sessionId) === frozen)
            store.bySession.delete(input.sessionId); } };
}
export function resolveRequiredChildExtensions(sessionId) {
    if (!sessionId)
        return EMPTY_SNAPSHOT;
    return registry().bySession.get(sessionId) ?? EMPTY_SNAPSHOT;
}
//# sourceMappingURL=required-child-extensions.js.map