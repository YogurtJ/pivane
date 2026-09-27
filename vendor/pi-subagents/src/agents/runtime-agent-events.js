import { registerRuntimeAgent } from "./runtime-agent-registry.js";
export const RUNTIME_AGENT_REGISTER_EVENT = "pi-subagents:runtime-agent-register:v1";
export const RUNTIME_AGENT_REGISTER_VERSION = 1;
function errorFrom(value) {
    return value instanceof Error ? value : new Error(String(value));
}
/** Register through the installed pi-subagents owner in this Pi process. */
export function registerAgentViaEvents(input) {
    const request = {
        version: RUNTIME_AGENT_REGISTER_VERSION,
        name: input.name,
        definition: input.definition,
    };
    input.pi.events.emit(RUNTIME_AGENT_REGISTER_EVENT, request);
    const result = request.result;
    if (result === undefined) {
        throw new Error("pi-subagents is not installed, not ready, or does not support runtime agent event registration.");
    }
    if (result && typeof result === "object" && !Array.isArray(result)) {
        const candidate = result;
        if (candidate.ok === true && candidate.registration && typeof candidate.registration === "object" && typeof candidate.registration.dispose === "function") {
            return candidate.registration;
        }
        if (candidate.ok === false && candidate.error instanceof Error)
            throw candidate.error;
    }
    throw new Error("pi-subagents returned a malformed runtime agent registration result.");
}
/** Install the process-local registration listener for the owning pi-subagents runtime. */
export function registerRuntimeAgentEventListener(pi) {
    return pi.events.on(RUNTIME_AGENT_REGISTER_EVENT, (rawRequest) => {
        if (!rawRequest || typeof rawRequest !== "object" || Array.isArray(rawRequest))
            return;
        const request = rawRequest;
        if (request.result !== undefined)
            return;
        try {
            if (request.version !== RUNTIME_AGENT_REGISTER_VERSION) {
                throw new Error(`Unsupported runtime agent registration event version '${String(request.version)}'.`);
            }
            const registration = registerRuntimeAgent({
                pi,
                name: request.name,
                definition: request.definition,
            });
            request.result = { ok: true, registration };
        }
        catch (error) {
            request.result = { ok: false, error: errorFrom(error) };
        }
    });
}
//# sourceMappingURL=runtime-agent-events.js.map