/** Pi exposes replaced extension contexts as ordinary Errors without a stable code. */
export function isStaleExtensionContextError(error) {
    return error instanceof Error
        && /extension ctx is stale|extension context no longer active|stale after session replacement or reload/i.test(error.message);
}
/** Run a synchronous operation against a cached UI context without leaking replacement errors. */
export function withCachedUiContext(ctx, onStale, run) {
    if (!ctx)
        return undefined;
    try {
        if (!ctx.hasUI)
            return undefined;
        return run(ctx);
    }
    catch (error) {
        if (!isStaleExtensionContextError(error))
            throw error;
        onStale();
        return undefined;
    }
}
//# sourceMappingURL=extension-context.js.map