var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
/**
 * In-process child sessions.
 *
 * A child is a pi `AgentSession` created inside the process that owns it: the
 * parent pi process for foreground children, the detached runner process for
 * background children. The factory is injectable so tests can script a child
 * without the real runtime; the default implementation wraps
 * `createAgentSession` from a pi package module.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { pinChildCacheRetention } from "../../shared/child-cache-retention.js";
import { getAgentDir, PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../shared/utils.js";
import { resolvePackageSubpath } from "../background/runner-aliases.js";
import { PI_CODING_AGENT_PACKAGE, resolveInstalledPiPackageRoot, resolvePiPackageRoot } from "./pi-spawn.js";
/** Mirror pi's JSON event projection: `message_update` drops the partial message. */
export function projectChildSessionEventForJson(event) {
    if (event.type !== "message_update")
        return event;
    const assistantMessageEvent = event.assistantMessageEvent;
    if (!assistantMessageEvent || typeof assistantMessageEvent !== "object")
        return event;
    const { partial: _partial, ...delta } = assistantMessageEvent;
    return { type: "message_update", usage: event.message?.usage, assistantMessageEvent: delta };
}
export function childSessionHasQueuedMessages(session) {
    try {
        return session?.hasQueuedMessages?.() === true;
    }
    catch {
        return false;
    }
}
function inheritParentProviders(modelRuntime, parentProviders, claimedProviderIds, onError) {
    let providerIds;
    try {
        providerIds = parentProviders.getRegisteredProviderIds();
    }
    catch (error) {
        onError?.({ extensionPath: "<parent-providers>", event: "inherit_provider", error });
        throw new Error(`Failed to enumerate parent providers: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    let registered = false;
    for (const providerId of new Set(providerIds)) {
        if (claimedProviderIds.has(providerId))
            continue;
        try {
            const native = parentProviders.getRegisteredNativeProvider(providerId);
            const config = native ? undefined : parentProviders.getRegisteredProviderConfig(providerId);
            if (native)
                modelRuntime.registerNativeProvider(native);
            else if (config)
                modelRuntime.registerProvider(providerId, config);
            else
                throw new Error(`Parent provider '${providerId}' has no registered native provider or config.`);
            registered = true;
        }
        catch (error) {
            onError?.({ extensionPath: `<parent-provider:${providerId}>`, event: "inherit_provider", error });
            throw new Error(`Failed to inherit parent provider '${providerId}': ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
    }
    return registered;
}
const CHILD_PROMPT_RUNTIME_EXTENSION_PATH = "<inline:pi-subagents:prompt-runtime>";
/** The prompt runtime filters parent-only context before ambient extensions inspect
 *  the child prompt. Other inline hooks keep their normal position after ambient
 *  extensions, and ambient extension order stays unchanged. */
function prioritizeChildPromptRuntime(result) {
    const index = result.extensions.findIndex(({ path }) => path === CHILD_PROMPT_RUNTIME_EXTENSION_PATH);
    if (index <= 0)
        return result;
    const extensions = [...result.extensions];
    const [promptRuntime] = extensions.splice(index, 1);
    if (!promptRuntime)
        return result;
    extensions.unshift(promptRuntime);
    return { ...result, extensions };
}
/** One launch at a time from env application through `session_start`, so parallel launches never observe each other's `processEnv` while their extensions load and start. */
let loading = Promise.resolve();
/**
 * pi caches extension factories per process and clears that cache only when a
 * loader reloads a second time, so every child in one process would share each
 * extension's module state. Marking the child's loader as already loaded makes
 * its first `reload()` clear the cache, so the child gets its own instances the
 * way a separate process had them. The flag is a private field of pi's loader.
 */
function resetExtensionCacheOnReload(loader) {
    if (!("loaded" in loader))
        return false;
    loader.loaded = true;
    return true;
}
function applyProcessEnv(values) {
    if (!values)
        return;
    for (const [name, value] of Object.entries(values)) {
        if (value === undefined)
            delete process.env[name];
        else
            process.env[name] = value;
    }
}
function flushQueuedProviderRegistrations(loader, modelRuntime, onError, requiredPaths) {
    const claimedProviderIds = new Set();
    if (!("getExtensions" in loader) || typeof loader.getExtensions !== "function")
        return { claimedProviderIds, registered: false };
    const { runtime } = loader.getExtensions();
    let registered = false;
    for (const { name, config, extensionPath } of runtime.pendingProviderRegistrations ?? []) {
        claimedProviderIds.add(name);
        try {
            modelRuntime.registerProvider(name, config);
            registered = true;
        }
        catch (error) {
            onError?.({ extensionPath, event: "register_provider", error });
            if (requiredPaths.has(extensionPath))
                throw new Error(`Required child extension provider registration failed for '${extensionPath}': ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (Array.isArray(runtime.pendingProviderRegistrations))
        runtime.pendingProviderRegistrations = [];
    for (const { provider, extensionPath } of runtime.pendingNativeProviderRegistrations ?? []) {
        claimedProviderIds.add(provider.id);
        try {
            modelRuntime.registerNativeProvider(provider);
            registered = true;
        }
        catch (error) {
            onError?.({ extensionPath, event: "register_provider", error });
            if (requiredPaths.has(extensionPath))
                throw new Error(`Required child extension provider registration failed for '${extensionPath}': ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (Array.isArray(runtime.pendingNativeProviderRegistrations))
        runtime.pendingNativeProviderRegistrations = [];
    return { claimedProviderIds, registered };
}
/**
 * Load the host-owned pi-coding-agent module by absolute package entry so a
 * child cannot resolve an extension-owned copy. Root precedence is the running
 * host, an explicit override, then the install tree. Once any root is selected,
 * its manifest, package identity, entry, and import must all succeed; the bare
 * specifier is used only when no root resolves.
 */
export async function loadHostPiCodingAgent() {
    const overrideRoot = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV]?.trim() || undefined;
    const runningRoot = resolvePiPackageRoot();
    const selectedOverride = runningRoot === undefined ? overrideRoot : undefined;
    const root = runningRoot ?? selectedOverride ?? resolveInstalledPiPackageRoot();
    if (root) {
        const entry = fs.realpathSync(resolveHostPackageEntry(root, selectedOverride));
        return import(__rewriteRelativeImportExtension(pathToFileURL(entry).href));
    }
    return import(__rewriteRelativeImportExtension(PI_CODING_AGENT_PACKAGE));
}
function resolveHostPackageEntry(root, overrideRoot) {
    const packageJson = path.join(root, "package.json");
    const source = fs.readFileSync(packageJson, "utf8");
    let parsed;
    try {
        parsed = JSON.parse(source);
    }
    catch (error) {
        throw new Error(`invalid host SDK manifest at ${packageJson}: malformed JSON`, { cause: error });
    }
    if (!isUnknownRecord(parsed))
        throw new Error(`invalid host SDK manifest at ${packageJson}: expected a JSON object`);
    const pkg = parsed;
    if (pkg.name !== PI_CODING_AGENT_PACKAGE) {
        const source = overrideRoot !== undefined ? ` (${PI_CODING_AGENT_PACKAGE_ROOT_ENV} override)` : "";
        throw new Error(`refusing to load the host SDK from ${root}${source}: package.json name is "${String(pkg.name ?? "(none)")}", expected "${PI_CODING_AGENT_PACKAGE}"`);
    }
    const entry = resolvePackageSubpath(root, ".");
    if (!entry)
        throw new Error(`host SDK manifest at ${packageJson} has no resolvable root export`);
    return entry;
}
function isUnknownRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Default factory: detached/background sessions retain the existing shared
 * runtime; each parent-bound foreground launch gets an isolated runtime.
 */
export function createDefaultChildSessionFactory(options = {}) {
    const loadPiCodingAgent = options.loadPiCodingAgent ?? loadHostPiCodingAgent;
    const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
    let runtime;
    const live = new Set();
    /** Extension shutdowns still running for disposed children; `dispose()` waits for them. */
    const shutdowns = new Set();
    const sharedRuntime = async (pi) => {
        runtime ??= pi.ModelRuntime.create().catch((error) => {
            runtime = undefined;
            throw error;
        });
        return runtime;
    };
    return {
        async create(launch) {
            const pi = await loadPiCodingAgent();
            const modelRuntime = launch.parentProviderRegistry
                ? await pi.ModelRuntime.create()
                : await sharedRuntime(pi);
            const agentDir = getAgentDir();
            const settingsManager = pi.SettingsManager.create(launch.cwd, agentDir);
            // Foreground children share Pi's global theme with the parent, so reinitializing it
            // would overwrite the parent's active light/dark appearance. Detached runners have
            // no initialized theme and must initialize one for headless extension renderers.
            const themeKey = Symbol.for("@earendil-works/pi-coding-agent:theme");
            const themeInitialized = Boolean(globalThis[themeKey]);
            if (!themeInitialized && typeof pi.initTheme === "function")
                pi.initTheme(settingsManager.getTheme());
            const loader = new pi.DefaultResourceLoader({
                cwd: launch.cwd,
                agentDir,
                settingsManager,
                noExtensions: !launch.ambientExtensions,
                noSkills: launch.noSkills,
                noPromptTemplates: true,
                noThemes: true,
                noContextFiles: launch.noContextFiles,
                additionalExtensionPaths: launch.extensionPaths,
                extensionFactories: launch.hooks,
                extensionsOverride: prioritizeChildPromptRuntime,
                ...(launch.systemPrompt !== undefined ? { systemPrompt: launch.systemPrompt } : {}),
                ...(launch.appendSystemPrompt !== undefined ? { appendSystemPrompt: [launch.appendSystemPrompt] } : {}),
            });
            const open = async () => {
                const requiredPaths = new Set((launch.requiredExtensions ?? []).map(({ path }) => path));
                applyProcessEnv(launch.processEnv);
                if (!resetExtensionCacheOnReload(loader) && (launch.ambientExtensions || launch.extensionPaths.length))
                    launch.onExtensionError?.({ extensionPath: "<loader>", event: "load", error: new Error("pi's extension cache reset is unavailable; extensions loaded into this child share module state with other sessions in this process.") });
                await loader.reload();
                const loadErrors = requiredPaths.size > 0
                    ? loader.getExtensions().errors.filter(({ path }) => requiredPaths.has(path)) : [];
                if (loadErrors.length > 0)
                    throw new Error(`Required child extension failed to load: ${loadErrors.map(({ path, error }) => `${path}: ${error}`).join("; ")}`);
                const queued = flushQueuedProviderRegistrations(loader, modelRuntime, launch.onExtensionError, requiredPaths);
                const inherited = launch.parentProviderRegistry
                    ? inheritParentProviders(modelRuntime, launch.parentProviderRegistry, queued.claimedProviderIds, launch.onExtensionError)
                    : false;
                if (queued.registered || inherited) {
                    try {
                        await modelRuntime.refresh({ allowNetwork: false });
                    }
                    catch (error) {
                        launch.onExtensionError?.({ extensionPath: "<provider-refresh>", event: "refresh_providers", error });
                        throw new Error(`Failed to refresh child providers: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
                    }
                }
                const sessionManager = launch.storage.kind === "file"
                    ? pi.SessionManager.open(launch.storage.sessionFile, undefined, launch.cwd)
                    : launch.storage.kind === "dir"
                        ? pi.SessionManager.create(launch.cwd, launch.storage.sessionDir)
                        : launch.storage.kind === "memory"
                            ? pi.SessionManager.inMemory(launch.cwd)
                            : pi.SessionManager.create(launch.cwd);
                const resolvedModel = launch.model
                    ? pi.resolveCliModel({ cliModel: launch.model, modelRuntime })
                    : undefined;
                if (resolvedModel?.error)
                    throw new Error(resolvedModel.error);
                const { session } = await pi.createAgentSession({
                    cwd: launch.cwd,
                    agentDir,
                    modelRuntime,
                    ...(resolvedModel?.model ? { model: resolvedModel.model } : {}),
                    ...(resolvedModel?.thinkingLevel ? { thinkingLevel: resolvedModel.thinkingLevel } : {}),
                    ...(launch.tools ? { tools: launch.tools } : {}),
                    ...(launch.excludeTools?.length ? { excludeTools: launch.excludeTools } : {}),
                    resourceLoader: loader,
                    sessionManager,
                    settingsManager,
                    sessionStartEvent: { type: "session_start", reason: "startup" },
                });
                pinChildCacheRetention(session.agent);
                try {
                    await session.bindExtensions({
                        mode: "print",
                        onError: (error) => launch.onExtensionError?.({ extensionPath: error.extensionPath, event: error.event, error: error.error }),
                    });
                }
                catch (error) {
                    session.dispose();
                    throw error;
                }
                return session;
            };
            const opened = loading.catch(() => { }).then(open);
            loading = opened;
            const session = await opened;
            let pending;
            // pi's own hosts emit `session_shutdown` before disposing a session so the
            // extensions loaded into it (ambient extensions included) release their
            // watchers, servers, and timers. Do the same, then dispose.
            const shutdown = async () => {
                try {
                    const runner = session.extensionRunner;
                    if (runner.hasHandlers("session_shutdown")) {
                        await Promise.race([runner.emit({ type: "session_shutdown", reason: "quit" }), new Promise((resolve) => setTimeout(resolve, shutdownTimeoutMs).unref?.())]);
                    }
                }
                catch (error) {
                    launch.onExtensionError?.({ extensionPath: "<session>", event: "session_shutdown", error });
                }
                finally {
                    session.dispose();
                }
            };
            const child = {
                subscribe: (listener) => session.subscribe((event) => listener(event)),
                prompt: (text) => session.prompt(text),
                steer: (text) => session.steer(text),
                followUp: (text) => session.followUp(text),
                abort: () => session.abort(),
                hasQueuedMessages: () => session.agent?.hasQueuedMessages?.() === true,
                dispose: () => {
                    if (!pending) {
                        live.delete(child);
                        const shutdownDone = shutdown();
                        pending = shutdownDone;
                        shutdowns.add(shutdownDone);
                        void shutdownDone.finally(() => shutdowns.delete(shutdownDone));
                    }
                    return pending;
                },
                get messages() { return session.messages; },
                get sessionFile() { return session.sessionFile; },
                get sessionId() { return session.sessionId; },
                get modelId() { return session.model ? `${session.model.provider}/${session.model.id}` : undefined; },
            };
            live.add(child);
            return child;
        },
        async dispose() {
            const children = [...live].filter((child) => !child.detached);
            for (const child of children)
                child.shutDown = true;
            await Promise.allSettled(children.map((child) => child.abort()));
            for (const child of children) {
                try {
                    void child.dispose();
                }
                catch { /* best effort */ }
            }
            await Promise.allSettled([...shutdowns]);
            if (live.size === 0)
                runtime = undefined;
        },
    };
}
let activeFactory;
let activeFactoryModule;
/** The process-wide factory foreground runs use unless a run passes its own. */
export function childSessionFactory() {
    activeFactory ??= createLazyPlacementFactory(createDefaultChildSessionFactory());
    return activeFactory;
}
function createLazyPlacementFactory(local) {
    let placed;
    const factory = async () => placed ??= (await import("./herdr-placed-run.js")).createPlacementAwareChildSessionFactory(local);
    return {
        async create(launch) { return launch.machine ? (await factory()).create(launch) : local.create(launch); },
        async dispose() { if (placed)
            await placed.dispose();
        else
            await local.dispose(); },
    };
}
/** Default factory including pane-native placement; detached runners use the same boundary. */
export function createPlacementChildSessionFactory(options = {}) {
    return createLazyPlacementFactory(createDefaultChildSessionFactory(options));
}
/**
 * Replace the process-wide factory. Tests install a scripted factory; passing
 * undefined restores the default on next use.
 */
export function setChildSessionFactory(factory) {
    activeFactory = factory;
}
/**
 * Module path the detached background runner imports its child session factory
 * from. Tests point it at a scripted factory; production launches leave it
 * unset and the runner creates real sessions from the installed pi package.
 */
export function childSessionFactoryModule() {
    return activeFactoryModule;
}
export function setChildSessionFactoryModule(modulePath) {
    activeFactoryModule = modulePath;
}
/** Abort and dispose every live in-process child and release the shared runtime. */
export async function disposeChildSessions() {
    const factory = activeFactory;
    if (!factory)
        return;
    await factory.dispose();
}
//# sourceMappingURL=child-session.js.map