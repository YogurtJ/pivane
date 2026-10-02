// Version-reviewed Pi 1.0.0 boundary. Capture, never replace, native /mcp.
export const nativePiEntry = () => import.meta.resolve('@earendil-works/pi-coding-agent');
const handlers = new WeakMap();
const running = new WeakSet();
const registrySymbol = Symbol.for('pivane.native-mcp-control.v1');
function registry() { return globalThis[registrySymbol] ??= new Map(); }
function contextKey(ctx) {
    const id = ctx.sessionManager?.getSessionId();
    if (typeof id !== 'string' || !id || typeof ctx.cwd !== 'string' || !ctx.cwd) throw failure('MCP_RUNTIME_IDENTITY_REQUIRED');
    return JSON.stringify([id, ctx.cwd]);
}
export async function requestRegisteredNativeMcpControl(ctx, request) {
    const entry = registry().get(contextKey(ctx));
    if (!entry) return { servers: [], tools: [], notices: [{ kind: 'unknown', code: 'MCP_NATIVE_HANDLER_UNAVAILABLE' }] };
    return entry.request(ctx, request);
}
const exposure = '(codemode|codemode-deferred|deferred|direct|hidden)';
const statusLine = new RegExp(`^([A-Za-z0-9_-]+): (disabled|starting|connecting|connected|failed|disconnected, reconnects on next call)(?:, ([0-9]+) tools)? \\(${exposure}\\)$`);
const authLine = new RegExp(`^([A-Za-z0-9_-]+): needs sign-in, run /mcp login ([A-Za-z0-9_-]+) \\(${exposure}\\)$`);
const failure = code => Object.assign(new Error(code), { code });
export function captureNativeMcpControl(factory) {
    return pi => {
        const wrapped = new Proxy(pi, { get(target, key) {
            if (key === 'registerCommand') return (name, command) => {
                if (name === 'mcp') handlers.set(pi, command.handler);
                return target.registerCommand(name, command);
            };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
        } });
        const result = factory(wrapped);
        const owned = new Map();
        pi.on('session_start', (_event, ctx) => {
            const key = contextKey(ctx);
            if (registry().has(key)) throw failure('MCP_DUPLICATE_RUNTIME');
            const entry = { request: (current, request) => {
                if (contextKey(current) !== key || registry().get(key) !== entry) throw failure('MCP_RUNTIME_CHANGED');
                return requestNativeMcpControl(pi, current, request);
            } };
            registry().set(key, entry); owned.set(key, entry);
        });
        pi.on('session_shutdown', () => {
            for (const [key, entry] of owned) if (registry().get(key) === entry) registry().delete(key);
            owned.clear();
        });
        return result;
    };
}
export function parseNativeMcpStatus(text) {
    const servers = [], seen = new Set();
    let unknown = false;
    if (typeof text !== 'string' || text.length > 32768) return { servers, unknown: true };
    if (text.startsWith('No MCP servers configured. Add them to ') && !text.includes('\n')) return { servers, unknown: false };
    for (const line of text.split('\n')) {
        // Official failure continuations may contain arbitrary stderr. Never parse or return them.
        if (/^    /.test(line)) continue;
        const status = statusLine.exec(line), auth = authLine.exec(line);
        if (!status && !auth) { unknown = true; continue; }
        const name = (status || auth)[1];
        if (seen.has(name) || servers.length >= 256) { unknown = true; continue; }
        seen.add(name);
        if (auth && auth[1] !== auth[2]) { unknown = true; continue; }
        servers.push({ name, state: auth ? 'needs-auth' : status[2].startsWith('disconnected') ? 'disconnected' : status[2], toolCount: status?.[2] === 'connected' && status[3] !== undefined && Number.isSafeInteger(Number(status[3])) ? Number(status[3]) : null, exposure: auth ? auth[3] : status[4] });
    }
    return { servers, unknown };
}
function authorizationNotice(message, server) {
    const prefix = `Sign in to MCP server "${server}" in your browser:\n`;
    if (typeof message !== 'string' || !message.startsWith(prefix) || message.length > 8192) return null;
    const authorizationUrl = message.slice(prefix.length);
    // Native RPC emits one URL.href line. URL parsing otherwise silently strips
    // controls, potentially folding arbitrary notification text into the link.
    if (/[\u0000-\u0020\u007f]/.test(authorizationUrl)) return null;
    try { const url = new URL(authorizationUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null; return { kind: 'authorization', url: url.href }; } catch { return null; }
}
// Caller must already own the managed worker's idle/exclusive slot and verify runtime identity.
// No timeout here: caller timeout does not release native OAuth/connection ownership.
export async function requestNativeMcpControl(pi, ctx, request) {
    if (!request || !['snapshot', 'reconnect', 'login', 'logout'].includes(request.action)) throw failure('MCP_INVALID_ACTION');
    const action = request.action;
    if (action !== 'snapshot' && (request.confirmed !== true || typeof request.server !== 'string' || !/^[A-Za-z0-9_-]+$/.test(request.server))) throw failure('MCP_CONFIRMATION_REQUIRED');
    if (ctx.mode !== 'rpc' || typeof ctx.isIdle !== 'function' || !ctx.isIdle()) throw failure('MCP_RUNTIME_NOT_IDLE');
    const handler = handlers.get(pi);
    if (!handler) return { servers: [], tools: [], notices: [{ kind: 'unknown', code: 'MCP_NATIVE_HANDLER_UNAVAILABLE' }] };
    if (running.has(pi)) throw failure('MCP_RUNTIME_BUSY');
    running.add(pi);
    const notices = [], captures = [];
    let captureBytes = 0, errored = false, cancelled = false;
    const notify = (message, type) => {
        if (action === 'snapshot') {
            if (typeof message === 'string' && (captureBytes += message.length) <= 32768 && captures.length < 8) captures.push(message);
            else errored = true;
        } else {
            // Only the native, exact authorization notification is forwarded to pending UI.
            const auth = action === 'login' && authorizationNotice(message, request.server);
            if (auth) { notices.push(auth); ctx.ui.notify(`Sign in to MCP server "${request.server}" in your browser:\n${auth.url}`, 'info'); }
            else if (action === 'login' && message === 'Sign-in cancelled.') cancelled = true;
            else if (type === 'error' || type === 'warning') errored = true;
        }
    };
    const ui = new Proxy(ctx.ui, { get(target, key) { if (key === 'notify') return notify; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
    const commandCtx = new Proxy(ctx, { get(target, key) { if (key === 'ui') return ui; return Reflect.get(target, key); } });
    try {
        try { await handler(action === 'snapshot' ? '' : `${action} ${request.server}`, commandCtx); }
        catch { errored = true; }
        let parsed = { servers: [], unknown: true };
        if (action === 'snapshot' && captures.length === 1 && !errored) parsed = parseNativeMcpStatus(captures[0]);
        if (action !== 'snapshot') {
            captures.length = 0; captureBytes = 0;
            // Separate readback; suppress every raw notification, including transport/error text.
            const snapshotUi = new Proxy(ctx.ui, { get(target, key) { if (key === 'notify') return message => { if (typeof message === 'string' && message.length <= 32768 && captures.length < 8) captures.push(message); }; return Reflect.get(target, key); } });
            try { await handler('', new Proxy(ctx, { get(target, key) { return key === 'ui' ? snapshotUi : Reflect.get(target, key); } })); if (captures.length === 1) parsed = parseNativeMcpStatus(captures[0]); } catch { /* Unknown, not inferred from tools. */ }
        }
        if (action === 'login' && !cancelled && !parsed.servers.some(server => server.name === request.server && server.state === 'connected')) errored = true;
        if (cancelled) notices.push({ kind: 'cancelled', code: 'MCP_NATIVE_SIGN_IN_CANCELLED' });
        if (errored) notices.push({ kind: 'error', code: 'MCP_NATIVE_ACTION_FAILED' });
        if (parsed.unknown) notices.push({ kind: 'unknown', code: 'MCP_NATIVE_STATUS_UNKNOWN' });
        let tools = [];
        try {
            const active = new Set(pi.getActiveTools());
            tools = pi.getAllTools().filter(tool => typeof tool.name === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(tool.name)).slice(0, 2048).map(tool => ({ name: tool.name, exposure: ['codemode', 'codemode-deferred', 'deferred', 'direct', 'hidden'].includes(tool.exposure) ? tool.exposure : 'unknown', active: active.has(tool.name) }));
        } catch { notices.push({ kind: 'unknown', code: 'MCP_NATIVE_TOOLS_UNKNOWN' }); }
        return { servers: parsed.servers, tools, notices, outcome: cancelled ? 'cancelled' : errored ? 'failed' : parsed.unknown ? 'unknown' : 'completed' };
    } finally { running.delete(pi); }
}
