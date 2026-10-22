import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { getCurrentTools } from '@earendil-works/pi-ai';
import upstream from '../vendor/pi-subagents/index.js';
import { setChildSessionFactory, setChildSessionFactoryModule } from '../vendor/pi-subagents/src/runs/shared/child-session.js';
import childFactory from './pi-subagent-child-factory.mjs';

const delegationTools = new Set(['subagents_enable', 'subagent', 'contact_supervisor', 'subagent_supervisor', 'bg_wait']);
// One live native reload handoff, consumed at the next start. Weak identity and
// session/leaf checks prevent reuse after replacement; nothing is persisted.
const reloadSelections = new WeakMap();

export default function bundledSubagents(pi) {
    setChildSessionFactory(childFactory());
    setChildSessionFactoryModule(fileURLToPath(new URL('./pi-subagent-child-factory.mjs', import.meta.url)));
    const calls = new AsyncLocalStorage();
    const definitions = new Map();
    let lazy = true, replaySelection;
    const selected = () => pi.getActiveTools().filter(name => delegationTools.has(name));
    const preserve = (names, selection) => [...names.filter(name => !delegationTools.has(name)), ...selection];
    const capture = (event, ctx) => {
        const prior = reloadSelections.get(ctx.sessionManager);
        reloadSelections.delete(ctx.sessionManager);
        const messages = ctx.sessionManager.getBranch().flatMap(entry => entry.type === 'message' && entry.message.role === 'system' ? [entry.message] : []);
        const recorded = messages.some(message => Object.hasOwn(message, 'toolsAdded') || Object.hasOwn(message, 'toolsRemoved'));
        if (!lazy && event.reason === 'reload' && prior?.sessionId === ctx.sessionManager.getSessionId() && prior.leafId === ctx.sessionManager.getLeafId()) {
            const active = new Set(getCurrentTools(messages).map(tool => tool.name));
            const mentioned = new Set(messages.flatMap(message => [...(message.toolsAdded || []), ...(message.toolsRemoved || [])]).map(tool => tool.name));
            const removed = new Set([...mentioned].filter(name => !active.has(name)));
            const names = selected().filter(name => prior.names.includes(name)
                || (prior.names.includes('subagents_enable') && !active.has(name) && !removed.has(name)
                    && name !== 'subagent_supervisor' && definitions.get(name)?.defaultActive !== false));
            // Eager registration during reload is not an explicit re-enable.
            // Preserve prior choices; only a cold loader -> eager transition adds new defaults.
            pi.setActiveTools(preserve(pi.getActiveTools(), names));
        }
        replaySelection = recorded || event.type === 'session_tree' || event.reason === 'reload' ? selected() : undefined;
    };
    pi.on('session_start', capture);
    pi.on('session_tree', capture);
    pi.on('session_shutdown', (event, ctx) => {
        if (event.reason === 'reload') reloadSelections.set(ctx.sessionManager, {
            sessionId: ctx.sessionManager.getSessionId(), leafId: ctx.sessionManager.getLeafId(), names: selected(),
        });
        else reloadSelections.delete(ctx.sessionManager);
    });
    const guarded = new Proxy(pi, { get(target, key) {
        if (key === 'setActiveTools') return names => {
            const call = calls.getStore();
            if (call?.open && (call.activate || call.fresh)) return pi.setActiveTools(names);
            if (call?.open && call.selection) return pi.setActiveTools(preserve(names, call.selection));
            // A pending reply or background poll is not authority to restore tools.
            const active = new Set(selected());
            return pi.setActiveTools(names.filter(name => !delegationTools.has(name) || active.has(name)));
        };
        if (key === 'registerTool') return tool => {
            if (!delegationTools.has(tool.name)) return pi.registerTool(tool);
            definitions.set(tool.name, tool);
            const definition = tool.name === 'subagents_enable' ? { ...tool, execute: async (...args) => {
                const call = { open: true, activate: true };
                try { return await calls.run(call, () => tool.execute(...args)); }
                finally { call.open = false; }
            } } : tool;
            // Pi owns restoration and explicit CLI selection. Registration alone
            // must not enable an undeclared sibling on resume or every tool on reload.
            const inactive = lazy || tool.name === 'subagent_supervisor';
            pi.registerTool(inactive ? { ...definition, defaultActive: false } : definition);
            const call = calls.getStore();
            if (inactive && call?.open && call.selection && pi.getActiveTools().includes(tool.name) && !call.selection.includes(tool.name)) {
                // A default-inactive late registration can be active only through
                // Pi's explicit allowlist or pending native selection.
                call.selection.push(tool.name);
            }
        };
        if (key === 'on') return (event, handler) => {
            if (!['session_start', 'session_tree', 'before_agent_start'].includes(event)) return pi.on(event, handler);
            return pi.on(event, async (value, ctx) => {
                const selection = event === 'before_agent_start' ? selected() : replaySelection;
                const call = { open: true, selection, fresh: selection === undefined };
                try { return await calls.run(call, () => handler(value, ctx)); }
                finally {
                    call.open = false;
                    if (selection) {
                        pi.setActiveTools(preserve(pi.getActiveTools(), selection));
                        if (value.systemPromptOptions?.selectedTools) value.systemPromptOptions.selectedTools = preserve(value.systemPromptOptions.selectedTools, selection);
                    }
                }
            });
        };
        return Reflect.get(target, key);
    } });
    const result = upstream(guarded);
    // A configured eager factory has no loader definition. Preserve original
    // defaults so Pi can activate never-mentioned tools while retaining removals.
    if (!definitions.has('subagents_enable')) {
        lazy = false;
        for (const definition of definitions.values()) guarded.registerTool(definition);
    }
    // Decide after native filtering: an excluded loader is still a definition,
    // but a fresh session without an available loader keeps eager delegation.
    pi.on('session_start', () => {
        if (replaySelection !== undefined) return;
        const available = pi.getAllTools();
        if (available.some(tool => tool.name === 'subagents_enable')) return;
        const eager = available.filter(tool => delegationTools.has(tool.name) && definitions.get(tool.name)?.defaultActive !== false).map(tool => tool.name);
        pi.setActiveTools([...new Set([...pi.getActiveTools(), ...eager])]);
    });
    return result;
}
