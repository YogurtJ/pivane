import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../shared/utils.js";
export const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_SUBAGENT_PI_BINARY_ENV = "PI_SUBAGENT_PI_BINARY";
export function findPiPackageRootFromEntry(entryPoint) {
    let dir = path.dirname(entryPoint);
    while (dir !== path.dirname(dir)) {
        const packageJsonPath = path.join(dir, "package.json");
        if (fs.existsSync(packageJsonPath)) {
            const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
            if (pkg.name === PI_CODING_AGENT_PACKAGE)
                return dir;
        }
        dir = path.dirname(dir);
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