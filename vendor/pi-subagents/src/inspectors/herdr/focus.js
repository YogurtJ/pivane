export function herdrPaneRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const record = value;
    return record.pane && typeof record.pane === "object" && !Array.isArray(record.pane)
        ? record.pane
        : record;
}
function text(record, ...keys) {
    for (const key of keys)
        if (typeof record[key] === "string" && record[key])
            return record[key];
    return undefined;
}
export function herdrPaneFocusTarget(value) {
    const pane = herdrPaneRecord(value);
    if (!pane)
        return {};
    return {
        paneId: text(pane, "pane_id", "paneId", "id"),
        tabId: text(pane, "tab_id", "tabId"),
        workspaceId: text(pane, "workspace_id", "workspaceId"),
    };
}
export async function focusHerdrPane(client, paneId, signal) {
    const live = await client.run(["pane", "get", paneId], { timeoutMs: 5_000, signal });
    if (live.ok === false)
        return live;
    const target = herdrPaneFocusTarget(live.data);
    if (!target.paneId) {
        return { ok: false, error: { code: "INVALID_PANE_RESPONSE", message: `Herdr pane get returned no pane id for '${paneId}'.`, details: live.data } };
    }
    if (target.tabId) {
        const focused = await client.run(["tab", "focus", target.tabId], { timeoutMs: 5_000, signal });
        return focused.ok ? { ok: true, data: { paneId: target.paneId, tabId: target.tabId, ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}) } } : focused;
    }
    if (target.workspaceId) {
        const focused = await client.run(["workspace", "focus", target.workspaceId], { timeoutMs: 5_000, signal });
        return focused.ok ? { ok: true, data: { paneId: target.paneId, workspaceId: target.workspaceId } } : focused;
    }
    return {
        ok: false,
        error: {
            code: "PANE_FOCUS_UNSUPPORTED",
            message: `Herdr pane '${paneId}' has no tab_id or workspace_id. Select it in Herdr manually, or upgrade Herdr focus support.`,
            details: live.data,
        },
    };
}
//# sourceMappingURL=focus.js.map