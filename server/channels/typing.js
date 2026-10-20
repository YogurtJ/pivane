const HEARTBEAT_MS = 5000;
const MAX_FAILURES = 2;
const MAX_DIAGNOSTICS = 100;
const states = new WeakMap();

function typingSnapshot(service) {
    return [...(states.get(service)?.values() || [])].map(row => ({ ...row }));
}

// Tickets live only for this run. No upstream lifetime is assumed, and legacy
// persisted peer.typingTicket values are deliberately never reused.
function startTyping(service, account, peerId) {
    let rows = states.get(service);
    if (!rows) { rows = new Map(); states.set(service, rows); }
    const key = JSON.stringify([account.id, peerId]);
    const diagnostic = { accountId: account.id, peerId, status: 'starting', failures: 0, reason: null };
    rows.delete(key);
    rows.set(key, diagnostic);
    if (rows.size > MAX_DIAGNOSTICS) rows.delete(rows.keys().next().value);
    const adapter = service.adapter;
    const identity = { ...account };
    const originalPeer = service.db?.value.peers.find(p => p.accountId === account.id && p.peerId === peerId);
    const peer = originalPeer ? { ...originalPeer } : null;
    let ticket = '', stopped = false, timer, flight, stopPromise;
    let attempted = false, cleanupPromise;
    const valid = () => {
        const current = service.db?.value.accounts.find(a => a.id === identity.id);
        const currentPeer = service.db?.value.peers.find(p => p.accountId === identity.id && p.peerId === peerId);
        return !stopped && !service.stopping && !service.isSuspended?.() && service.adapter === adapter
            && current?.enabled && current.allowedUsers?.includes(peerId)
            && current.token === identity.token && current.baseUrl === identity.baseUrl && current.userId === identity.userId
            && peer?.contextToken && currentPeer?.contextToken === peer.contextToken;
    };
    const cleanup = () => {
        if (!cleanupPromise) cleanupPromise = (async () => {
            if (!attempted || !ticket) return;
            try { await adapter.typing(identity, peer, ticket, false); }
            catch { diagnostic.status = 'degraded'; diagnostic.reason = 'cancel-failed'; }
        })();
        return cleanupPromise;
    };
    const finish = async reason => {
        stopped = true;
        clearTimeout(timer);
        if (reason) { diagnostic.status = 'stopped'; diagnostic.reason = reason; }
        await cleanup();
    };
    const tick = async () => {
        if (!valid()) return finish('permission-or-context-changed');
        try {
            if (!ticket) {
                ticket = await adapter.typingTicket(identity, peer);
                if (!valid()) return finish('permission-or-context-changed');
                if (!ticket) throw new Error('ticket-unavailable');
            }
            // There is no await between the final permission check and send.
            if (!valid()) return finish('permission-or-context-changed');
            attempted = true;
            await adapter.typing(identity, peer, ticket, true);
            if (!valid()) return finish('permission-or-context-changed');
            diagnostic.status = 'active'; diagnostic.failures = 0; diagnostic.reason = null;
        } catch {
            diagnostic.failures++;
            diagnostic.status = 'degraded'; diagnostic.reason = ticket ? 'typing-failed' : 'ticket-failed';
            // Cancel the possibly accepted active request before discarding its
            // ticket. A transport failure does not establish non-delivery.
            await cleanup();
            ticket = ''; attempted = false; cleanupPromise = undefined;
            if (!valid()) return finish('permission-or-context-changed');
            if (diagnostic.failures >= MAX_FAILURES) { stopped = true; return; }
        }
        if (valid()) {
            timer = setTimeout(launch, HEARTBEAT_MS);
            timer.unref?.();
        }
    };
    const launch = () => {
        // A new heartbeat is scheduled only after this one has settled.
        flight = tick();
        service.track?.(flight);
    };
    const stop = () => {
        if (!stopPromise) {
            stopped = true;
            clearTimeout(timer);
            stopPromise = (async () => {
                await flight;
                if (diagnostic.status !== 'degraded') diagnostic.status = 'stopped';
                await cleanup();
            })();
            service.track?.(stopPromise);
        }
        return stopPromise;
    };
    if (!peer?.contextToken || !adapter?.typing || !adapter?.typingTicket) {
        stopped = true; diagnostic.status = 'unavailable'; diagnostic.reason = 'typing-unavailable';
    } else launch();
    return stop;
}

module.exports = { startTyping, typingSnapshot };
