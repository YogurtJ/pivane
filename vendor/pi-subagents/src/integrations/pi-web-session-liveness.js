import { hasLiveNestedDescendants, projectNestedEvents } from "../runs/shared/nested-events.js";
export const PI_WEB_SESSION_LIVENESS_REGISTRY_KEY = "@agegr/pi-web/session-liveness/v1";
const PI_WEB_SESSION_LIVENESS_PROTOCOL_VERSION = 1;
function resolveRegistry() {
    const value = globalThis[Symbol.for(PI_WEB_SESSION_LIVENESS_REGISTRY_KEY)];
    if (!value || typeof value !== "object")
        return null;
    const registry = value;
    if (registry.version !== PI_WEB_SESSION_LIVENESS_PROTOCOL_VERSION || typeof registry.register !== "function")
        return null;
    return registry;
}
export function retainLiveForegroundNestedRoute(state, route) {
    const nested = projectNestedEvents(route);
    if (!hasLiveNestedDescendants(nested.children))
        return false;
    state.retainedForegroundNestedRoutes ??= new Map();
    state.retainedForegroundNestedRoutes.set(route.rootRunId, route);
    return true;
}
export function hasLiveSubagentWork(state) {
    for (const job of state.asyncJobs.values()) {
        if (job.status === "queued" || job.status === "running" || hasLiveNestedDescendants(job.nestedChildren))
            return true;
    }
    for (const control of state.foregroundControls.values()) {
        if ((control.schedulingOwners ?? 0) > 0
            || (control.activeChildren?.size ?? 0) > 0
            || hasLiveNestedDescendants(control.nestedChildren))
            return true;
    }
    return (state.retainedForegroundNestedRoutes?.size ?? 0) > 0;
}
export function registerPiWebSessionLiveness(registration) {
    const registry = resolveRegistry();
    if (!registry)
        return { registered: false, release: () => { } };
    try {
        const release = registry.register({
            name: "pi-subagents",
            sessionId: registration.sessionId,
            ...(registration.sessionFile ? { sessionFile: registration.sessionFile } : {}),
            isActive: registration.isActive,
        });
        if (typeof release === "function")
            return { registered: true, release };
        console.error("Failed to register pi-web session liveness: host registry returned no release function.");
    }
    catch (error) {
        console.error("Failed to register pi-web session liveness:", error);
    }
    return { registered: false, release: () => { } };
}
//# sourceMappingURL=pi-web-session-liveness.js.map