import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';

// pi-subagents keeps detached work alive after the parent turn settles. Its
// optional host integration asks for this versioned process-global registry.
// A managed Pivane worker hosts the registry and reports only the aggregate
// state to the Supervisor, which decides retention and maintenance safety.
const REGISTRY_KEY = Symbol.for('@agegr/pi-web/session-liveness/v1');
const PIVANE_PROVIDERS = Symbol.for('pivane.session-liveness.providers.v1');
const POLL_MS = 2000;
const RPC_REQUEST = 'subagents:rpc:v1:request';
const RPC_REPLY = 'subagents:rpc:v1:reply:';
export const SUBAGENT_CONTROL_METHODS = ['status', 'cost', 'steer', 'stop', 'interrupt', 'resume'] as const;
const READS = new Set(['status', 'cost']);
const MAX_TEXT = 256 * 1024;

type Provider = { name: string; sessionId: string; sessionFile?: string; isActive(): boolean };

function providers(): Set<Provider> | null {
    const root = globalThis as any;
    const existing = root[REGISTRY_KEY];
    if (existing) return existing[PIVANE_PROVIDERS] instanceof Set ? existing[PIVANE_PROVIDERS] : null;
    const set = new Set<Provider>();
    const registry = Object.freeze({
        version: 1,
        register(provider: Provider) {
            if (!provider || typeof provider.name !== 'string' || typeof provider.sessionId !== 'string' || typeof provider.isActive !== 'function') {
                throw new TypeError('Invalid session liveness provider');
            }
            set.add(provider);
            return () => { set.delete(provider); };
        },
        [PIVANE_PROVIDERS]: set
    });
    Object.defineProperty(root, REGISTRY_KEY, { value: registry, configurable: false, enumerable: false, writable: false });
    return set;
}

// Installed at extension factory time, before any session_start handler runs.
const registered = providers();

export function backgroundWork(sessionId: string, sessionFile?: string) {
    if (!registered) return { supported: false, active: false, sources: [] as string[] };
    const sources = new Set<string>();
    for (const provider of registered) {
        if (provider.sessionId !== sessionId && (!sessionFile || provider.sessionFile !== sessionFile)) continue;
        let active: boolean;
        // A provider that cannot answer keeps its session: reaping is irreversible.
        try { active = provider.isActive() === true; } catch { active = true; }
        if (active) sources.add(provider.name.slice(0, 64));
    }
    return { supported: true, active: sources.size > 0, sources: [...sources].sort().slice(0, 8) };
}

export function registerSubagentHost(pi: ExtensionAPI) {
    const enabled = (ctx: any) => ctx?.mode === 'rpc' && Boolean(process.env.PI_WEB_NAVIGATION_TOKEN);
    let timer: ReturnType<typeof setInterval> | null = null;
    let current: any = null, signature = '';
    const publish = () => {
        if (!current) return;
        try {
            const sessionId = current.sessionManager.getSessionId();
            const state = backgroundWork(sessionId, current.sessionManager.getSessionFile() ?? undefined);
            const next = JSON.stringify([sessionId, state]);
            if (next === signature) return;
            current.ui.notify(JSON.stringify({ pivaneBackgroundWork: { version: 1, sessionId, ...state } }));
            signature = next;
        } catch { /* A stale context is replaced on the next session_start. */ }
    };
    const stop = () => { if (timer) clearInterval(timer); timer = null; current = null; signature = ''; };
    pi.on('session_start', (_event, ctx) => {
        stop();
        if (!enabled(ctx)) return;
        current = ctx;
        timer = setInterval(publish, POLL_MS); timer.unref?.();
        setTimeout(publish, 0).unref?.();
    });
    // Completion delivery usually starts or ends a turn; report without waiting for the poll.
    pi.on('agent_end', () => publish());
    pi.on('session_shutdown', stop);
}

const text = (value: unknown) => typeof value === 'string' ? value.slice(0, MAX_TEXT) : undefined;

function publicData(method: string, data: any) {
    if (!data || typeof data !== 'object') return {};
    if (method === 'status') return { text: text(data.text), asyncSnapshot: data.asyncSnapshot ?? null };
    if (method === 'stop') return { text: text(data.message), state: text(data.state), runId: text(data.runId) };
    // pi-subagents 0.71+ cost DTO: { version: 1, parent, children, childTotal, total, unresolvedAsyncChildren }.
    if (method === 'cost') return data.version === 1 ? { cost: {
        childTotal: data.childTotal ?? null, total: data.total ?? null, parent: data.parent ?? null,
        unresolvedAsyncChildren: Number.isInteger(data.unresolvedAsyncChildren) ? data.unresolvedAsyncChildren : 0,
        // Child session file paths stay private to the worker.
        children: Array.isArray(data.children) ? data.children.slice(0, 100).map((child: any) => ({ label: text(child?.label), agent: text(child?.agent), usage: child?.usage ?? null })) : [] } } : { cost: null };
    return { text: text(data.text), isError: data.isError === true };
}

function call(pi: ExtensionAPI, method: string, params: unknown, timeoutMs: number): Promise<any> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
        let unsubscribe: unknown;
        const timer = setTimeout(() => { if (typeof unsubscribe === 'function') unsubscribe(); reject(Object.assign(new Error('timeout'), { code: 'timeout' })); }, timeoutMs);
        unsubscribe = pi.events.on(RPC_REPLY + requestId, (reply: any) => {
            clearTimeout(timer); if (typeof unsubscribe === 'function') unsubscribe();
            if (reply?.success === true) resolve(reply.data);
            else reject(Object.assign(new Error(typeof reply?.error?.message === 'string' ? reply.error.message.slice(0, 2000) : 'Subagent request failed'),
                { code: typeof reply?.error?.code === 'string' ? reply.error.code : 'execution_failed' }));
        });
        pi.events.emit(RPC_REQUEST, { version: 1, requestId, method, ...(params === undefined ? {} : { params }), source: { extension: 'pivane' } });
    });
}

// Methods and parameters were validated by the Supervisor; pi-subagents still
// enforces current-session ownership and run state for every mutation.
export async function subagentControl(pi: ExtensionAPI, method: string, params: unknown) {
    if (!(SUBAGENT_CONTROL_METHODS as readonly string[]).includes(method)) throw new Error('Unsupported subagent control');
    let ping: any;
    try { ping = await call(pi, 'ping', undefined, 3000); }
    catch (error: any) { throw Object.assign(new Error('pi-subagents is not loaded in this session'), { code: error?.code === 'timeout' ? 'unavailable' : error?.code }); }
    if (method === 'cost' && !ping?.capabilities?.cost) throw Object.assign(new Error('This pi-subagents version does not report cost'), { code: 'unsupported_method' });
    try { return publicData(method, await call(pi, method, params, 40000)); }
    catch (error: any) { if (error?.code === 'timeout' && !READS.has(method)) error.code = 'uncertain'; throw error; }
}
