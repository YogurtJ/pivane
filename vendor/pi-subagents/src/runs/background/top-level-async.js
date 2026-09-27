export function applyForceTopLevelAsyncOverride(params, depth, forceTopLevelAsync) {
    if (params.foregroundOnly || !(depth === 0 && forceTopLevelAsync))
        return params;
    return { ...params, async: true, clarify: false };
}
//# sourceMappingURL=top-level-async.js.map