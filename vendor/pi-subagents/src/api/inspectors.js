export const INSPECTOR_REGISTER_EVENT = "pi-subagents:inspector-register:v1";
/** Register with the installed owner, even when each extension has its own module root. */
export function registerInspector(pi, plugin) {
    const request = { version: 1, plugin };
    pi.events.emit(INSPECTOR_REGISTER_EVENT, request);
    if (!request.result)
        throw new Error("pi-subagents is not installed, not ready, or does not support inspector registration.");
    if (!request.result.ok)
        throw request.result.error;
    return request.result.registration;
}
//# sourceMappingURL=inspectors.js.map