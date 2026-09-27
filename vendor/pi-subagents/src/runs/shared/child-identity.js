export function asyncStatusChildIdentity(step, index) {
    return asyncStatusChildIdentityCandidates(step, index)[0];
}
export function asyncStatusChildIdentityCandidates(step, index) {
    return [...new Set([step.childId, step.workflowKey, step.runId, `step:${index}`].filter((value) => typeof value === "string" && value.length > 0))];
}
export function resolveAsyncStatusChild(status, childId, options = {}) {
    const matches = [];
    for (const [index, step] of (status.steps ?? []).entries()) {
        if (asyncStatusChildIdentityCandidates(step, index).includes(childId)) {
            matches.push({ index, step, id: asyncStatusChildIdentity(step, index) });
        }
        if (options.includeNested) {
            const findNested = (children) => {
                for (const nested of children ?? []) {
                    if (nested.id === childId)
                        matches.push({ index, step, id: nested.id, nested });
                    findNested(nested.children);
                }
            };
            findNested(step.children);
        }
    }
    if (matches.length === 1)
        return { ok: true, child: matches[0] };
    if (matches.length > 1)
        return { ok: false, code: "ambiguous", message: `Child '${childId}' is ambiguous under async run '${status.runId}'.` };
    return { ok: false, code: "not_found", message: `Child '${childId}' was not found under async run '${status.runId}'.` };
}
export function isStoppableAsyncStatusStep(step) {
    return step.status === "pending" || step.status === "running";
}
export function stopStoppableAsyncStatusChildren(status, stopChild, message) {
    if (!stopChild)
        return;
    for (const [index, step] of (status.steps ?? []).entries()) {
        if (isStoppableAsyncStatusStep(step))
            stopChild(asyncStatusChildIdentity(step, index), message);
    }
}
//# sourceMappingURL=child-identity.js.map