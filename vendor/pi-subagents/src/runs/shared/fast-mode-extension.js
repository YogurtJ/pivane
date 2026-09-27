export function rewriteFastModeProviderRequest(event) {
    if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload))
        return event.payload;
    return { ...event.payload, service_tier: "priority" };
}
export default function registerSubagentFastModeExtension(pi) {
    pi.on("before_provider_request", rewriteFastModeProviderRequest);
}
//# sourceMappingURL=fast-mode-extension.js.map