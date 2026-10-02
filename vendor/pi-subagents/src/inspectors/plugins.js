import { INSPECTOR_REGISTER_EVENT } from "../api/inspectors.js";
import { createHerdrInspectorPlugin } from "./herdr/plugin.js";
import { createGhosttyInspectorPlugin } from "./ghostty/plugin.js";
// Keyed by event bus: a runtime that claims a registration can be replaced by a duplicate
// pi-subagents runtime on the same bus, and the registration must survive that takeover.
const registries = new WeakMap();
/** Built-ins retain host preference; external providers follow registration order. */
export function getInspectorPlugins(pi) {
    return [createHerdrInspectorPlugin(), createGhosttyInspectorPlugin(), ...(registries.get(pi.events)?.plugins.values() ?? [])];
}
/** Registrations live while any owner runtime listens on this bus; child runtimes use their own bus. */
export function registerInspectorEventListener(pi) {
    let registry = registries.get(pi.events);
    if (!registry) {
        registry = { plugins: new Map(), owners: 0 };
        registries.set(pi.events, registry);
    }
    registry.owners += 1;
    const { plugins } = registry;
    const builtinNames = new Set([createHerdrInspectorPlugin().name, createGhosttyInspectorPlugin().name]);
    /* oxlint-disable anti-slop/no-runtime-typeof -- This listener validates the untyped event-bus boundary, including callable provider methods. */
    const unsubscribe = pi.events.on(INSPECTOR_REGISTER_EVENT, (rawRequest) => {
        if (!rawRequest || typeof rawRequest !== "object" || Array.isArray(rawRequest))
            return;
        // SAFETY: The envelope is an object; its version and plugin are validated below before storing callbacks.
        const request = rawRequest;
        if (request.result !== undefined)
            return;
        try {
            if (request.version !== 1)
                throw new Error(`Unsupported inspector registration version '${String(request.version)}'.`);
            const plugin = request.plugin;
            if (!plugin || typeof plugin !== "object" || Array.isArray(plugin))
                throw new Error("Inspector plugin must be an object.");
            const name = plugin.name;
            if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
                throw new Error("Inspector plugin name must contain 1–128 letters, digits, dots, underscores, or hyphens and start with a letter or digit.");
            }
            if (builtinNames.has(name) || plugins.has(name))
                throw new Error(`Inspector plugin '${name}' is already registered.`);
            for (const method of ["available", "owns", "open"]) {
                if (typeof plugin[method] !== "function")
                    throw new Error(`Inspector plugin '${name}' requires ${method}().`);
            }
            for (const method of ["status", "close"]) {
                if (plugin[method] !== undefined && typeof plugin[method] !== "function")
                    throw new Error(`Inspector plugin '${name}' ${method} must be a function when provided.`);
            }
            plugins.set(name, plugin);
            let disposed = false;
            request.result = {
                ok: true,
                registration: {
                    dispose() {
                        if (disposed)
                            return;
                        disposed = true;
                        plugins.delete(name);
                    },
                },
            };
        }
        catch (error) {
            request.result = { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
        }
    });
    /* oxlint-enable anti-slop/no-runtime-typeof */
    let closed = false;
    return () => {
        if (closed)
            return;
        closed = true;
        unsubscribe();
        registry.owners -= 1;
        if (registry.owners > 0)
            return;
        plugins.clear();
        if (registries.get(pi.events) === registry)
            registries.delete(pi.events);
    };
}
//# sourceMappingURL=plugins.js.map