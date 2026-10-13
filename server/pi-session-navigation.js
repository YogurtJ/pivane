// Pi 1.1 SDK boundary: navigateTree selects *before* user/custom messages.
// Neutral native children express exact positions without copying messages or
// replacing AgentSession's context. All writes use the one managed SDK manager.
const ANCHOR = 'pivane-web-navigation-anchor';
const registryKey = Symbol.for('pivane.session-navigation.v1');
const managers = () => globalThis[registryKey] ??= new WeakSet();
function bindSessionNavigation(manager) { managers().add(manager); }
const editable = entry => entry?.type === 'custom_message' || entry?.type === 'message' && entry.message?.role === 'user';
async function navigateSession(ctx, entryId, { exact = false, ...options } = {}) {
    const manager = ctx.sessionManager;
    if (!managers().has(manager) || ctx.mode !== 'rpc' || !ctx.isIdle() || ctx.hasPendingMessages()) throw new Error('受管会话导航尚未就绪');
    const target = manager.getEntry(entryId);
    if (!target) throw new Error('历史位置不存在');
    const initial = manager.getLeafId();
    // Preserve a neutral child of an unanswered question, and avoid native's
    // early no-op when re-editing the current user leaf (including a root user).
    if (editable(manager.getEntry(initial))) manager.appendCustomEntry(ANCHOR, { entryId: initial });
    let destination = entryId;
    if (exact && editable(target)) {
        const existing = manager.getEntries().find(entry => entry.type === 'custom' && entry.customType === ANCHOR
            && entry.parentId === entryId && entry.data?.entryId === entryId);
        if (existing) destination = existing.id;
        else {
            // Legacy versions may reference a user leaf without an anchor.
            // Append a child on that branch, then durably reselect the original
            // position synchronously before native cancellation hooks run.
            const origin = manager.getLeafId();
            manager.branch(entryId);
            try { destination = manager.appendCustomEntry(ANCHOR, { entryId }); }
            finally {
                if (origin === null) manager.resetLeaf(); else manager.branch(origin);
                manager.appendCustomEntry(ANCHOR, { entryId: origin });
            }
        }
    }
    return ctx.navigateTree(destination, options);
}
module.exports = { ANCHOR, bindSessionNavigation, navigateSession };
