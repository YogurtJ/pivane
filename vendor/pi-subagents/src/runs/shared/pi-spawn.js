import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../shared/utils.js";
export const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_SUBAGENT_PI_BINARY_ENV = "PI_SUBAGENT_PI_BINARY";
export const PI_PACKAGE_DIR_ENV = "PI_PACKAGE_DIR";
export function findPiPackageRootFromEntry(entryPoint, deps = {}) {
    const pathApi = (deps.platform ?? process.platform) === "win32" ? path.win32 : path.posix;
    const existsSync = deps.existsSync ?? fs.existsSync;
    const readFileSync = deps.readFileSync ?? ((filePath, encoding) => fs.readFileSync(filePath, encoding));
    let dir = pathApi.dirname(entryPoint);
    while (dir !== pathApi.dirname(dir)) {
        const packageJsonPath = pathApi.join(dir, "package.json");
        if (existsSync(packageJsonPath)) {
            const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
            if (pkg.name === PI_CODING_AGENT_PACKAGE)
                return dir;
        }
        dir = pathApi.dirname(dir);
    }
    return undefined;
}
export function resolveInstalledPiPackageRoot() {
    try {
        return findPiPackageRootFromEntry(fileURLToPath(import.meta.resolve(PI_CODING_AGENT_PACKAGE)));
    }
    catch {
        return undefined;
    }
}
export function resolvePiPackageRoot() {
    try {
        const entry = process.argv[1];
        return entry
            ? findPiPackageRootFromEntry(fs.realpathSync(entry))
            : undefined;
    }
    catch {
        // process.argv[1] probing is best-effort; callers can fall back to PATH/package resolution.
        return undefined;
    }
}
function validateRunningPiRoot(root, source, readFileSync, manifestPath) {
    const sourceLabel = source === "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT" ? `${source} override` : source;
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { reason: `Could not read a valid Pi package manifest at ${manifestPath} (${sourceLabel}): ${message}` };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.name !== PI_CODING_AGENT_PACKAGE) {
        return { reason: `${manifestPath} is not ${PI_CODING_AGENT_PACKAGE} (${sourceLabel})` };
    }
    return { root, source };
}
/** Resolve only package roots that can be attributed to the process that owns this session. */
export function resolveRunningPiPackageRoot(deps = {}) {
    const env = deps.env ?? process.env;
    const platform = deps.platform ?? process.platform;
    const pathApi = platform === "win32" ? path.win32 : path.posix;
    const argv1 = deps.argv1 ?? process.argv[1];
    const readFileSync = deps.readFileSync ?? ((filePath, encoding) => fs.readFileSync(filePath, encoding));
    const existsSync = deps.existsSync ?? fs.existsSync;
    const realpathSync = deps.realpathSync ?? fs.realpathSync;
    if (argv1) {
        let entry;
        try {
            entry = realpathSync(argv1);
        }
        catch {
            // Virtual Bun entries and non-filesystem launchers continue to explicit host evidence.
        }
        if (entry) {
            try {
                const root = findPiPackageRootFromEntry(entry, { platform, existsSync, readFileSync });
                if (root)
                    return { root, source: "argv" };
            }
            catch (error) {
                return { reason: `Could not inspect the running Pi entry at ${entry}: ${error instanceof Error ? error.message : String(error)}` };
            }
        }
    }
    for (const [source, value] of [
        [PI_PACKAGE_DIR_ENV, env[PI_PACKAGE_DIR_ENV]],
        [PI_CODING_AGENT_PACKAGE_ROOT_ENV, env[PI_CODING_AGENT_PACKAGE_ROOT_ENV]],
    ]) {
        const root = value?.trim();
        if (root)
            return validateRunningPiRoot(root, source, readFileSync, pathApi.join(root, "package.json"));
    }
    const bunVersion = deps.bunVersion ?? process.versions.bun;
    if (!bunVersion || !argv1 || !/^(?:\/\$bunfs\/|B:[\\/]~BUN[\\/])/.test(argv1))
        return undefined;
    const imagePath = deps.execPath ?? process.execPath;
    let canonicalImage = imagePath;
    try {
        canonicalImage = realpathSync(imagePath);
    }
    catch {
        // A validated adjacent manifest can still establish ownership when canonicalization is unavailable.
    }
    const imageDir = pathApi.dirname(canonicalImage);
    const candidates = [
        { root: imageDir, source: "bun-adjacent" },
        { root: pathApi.resolve(imageDir, "..", "share", "pi-coding-agent"), source: "bun-share" },
    ];
    for (const candidate of candidates) {
        const manifestPath = pathApi.join(candidate.root, "package.json");
        if (!existsSync(manifestPath))
            continue;
        return validateRunningPiRoot(candidate.root, candidate.source, readFileSync, manifestPath);
    }
    return undefined;
}
/** Compiled Pi's entrypoint is virtual; execPath is the real (possibly renamed) image. */
export function resolveBunPiExecutable(deps = {}) {
    const bunVersion = deps.bunVersion ?? process.versions.bun;
    const entry = deps.argv1 ?? process.argv[1];
    if (!bunVersion || !entry || !/^(?:\/\$bunfs\/|B:[\\/]~BUN[\\/])/.test(entry))
        return undefined;
    const env = deps.env ?? process.env;
    return env[PI_SUBAGENT_PI_BINARY_ENV]?.trim() || (deps.execPath ?? process.execPath);
}
function isNodeScriptPath(filePath) {
    return /\.(?:mjs|cjs|js)$/i.test(filePath);
}
function isRunnableNodeScript(filePath, existsSync) {
    if (!existsSync(filePath))
        return false;
    return isNodeScriptPath(filePath);
}
function normalizePath(filePath) {
    return path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
}
function isStandalonePiExecutable(execPath) {
    const executableName = execPath.split(/[\\/]/).pop();
    return /^pi(?:\.exe)?$/i.test(executableName ?? "");
}
function resolvePiCliScriptFromPackageJson(packageJsonPath, readFileSync, existsSync) {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    if (packageJson.name !== PI_CODING_AGENT_PACKAGE)
        return undefined;
    const binField = packageJson.bin;
    const binPath = typeof binField === "string"
        ? binField
        : (binField?.pi ?? Object.values(binField ?? {})[0]);
    if (!binPath)
        return undefined;
    const candidate = path.resolve(path.dirname(packageJsonPath), binPath);
    return isRunnableNodeScript(candidate, existsSync) ? candidate : undefined;
}
export function resolvePiCliScript(deps = {}) {
    const existsSync = deps.existsSync ?? fs.existsSync;
    const realpathSync = deps.realpathSync ?? fs.realpathSync;
    const readFileSync = deps.readFileSync ??
        ((filePath, encoding) => fs.readFileSync(filePath, encoding));
    const argv1 = deps.argv1 ?? process.argv[1];
    const env = deps.env ?? process.env;
    if (argv1) {
        const argvPath = normalizePath(argv1);
        if (isRunnableNodeScript(argvPath, existsSync)) {
            try {
                const canonicalArgvPath = realpathSync(argvPath);
                if (isRunnableNodeScript(canonicalArgvPath, existsSync) && findPiPackageRootFromEntry(canonicalArgvPath)) {
                    return canonicalArgvPath;
                }
            }
            catch {
                // Host package metadata is untrusted here; keep resolving the installed Pi CLI.
            }
        }
    }
    const packageJsonCandidates = [];
    if (deps.resolvePackageJson)
        packageJsonCandidates.push(deps.resolvePackageJson);
    for (const root of [deps.piPackageRoot, env[PI_CODING_AGENT_PACKAGE_ROOT_ENV], resolvePiPackageRoot()]) {
        const trimmed = root?.trim();
        if (trimmed)
            packageJsonCandidates.push(() => path.join(trimmed, "package.json"));
    }
    packageJsonCandidates.push(() => {
        const packageRoot = deps.resolvePackageEntry
            ? findPiPackageRootFromEntry(deps.resolvePackageEntry())
            : resolveInstalledPiPackageRoot();
        return packageRoot ? path.join(packageRoot, "package.json") : undefined;
    });
    for (const candidatePackageJson of packageJsonCandidates) {
        try {
            const packageJsonPath = candidatePackageJson();
            if (!packageJsonPath)
                continue;
            const candidate = resolvePiCliScriptFromPackageJson(packageJsonPath, readFileSync, existsSync);
            if (candidate)
                return candidate;
        }
        catch {
            // Keep resolving; callers decide whether a PATH fallback is safe.
        }
    }
    return undefined;
}
export function getPiSpawnCommand(args, deps = {}) {
    const platform = deps.platform ?? process.platform;
    const env = deps.env ?? process.env;
    const piBinary = env[PI_SUBAGENT_PI_BINARY_ENV]?.trim();
    if (piBinary) {
        if (platform === "win32" && isNodeScriptPath(piBinary)) {
            return {
                command: deps.execPath ?? process.execPath,
                args: [piBinary, ...args],
            };
        }
        return { command: piBinary, args };
    }
    const execPath = deps.execPath ?? process.execPath;
    if (isStandalonePiExecutable(execPath)) {
        return { command: execPath, args };
    }
    const piCliPath = resolvePiCliScript(deps);
    if (piCliPath) {
        return {
            command: execPath,
            args: [piCliPath, ...args],
        };
    }
    if (platform === "win32") {
        throw new Error(`Could not resolve the Pi CLI on Windows. Set ${PI_SUBAGENT_PI_BINARY_ENV} or ensure ${PI_CODING_AGENT_PACKAGE} is installed.`);
    }
    return { command: "pi", args };
}
//# sourceMappingURL=pi-spawn.js.map