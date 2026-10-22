import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import upstream from '../vendor/pi-subagents/index.js';
import { setChildSessionFactory, setChildSessionFactoryModule } from '../vendor/pi-subagents/src/runs/shared/child-session.js';
import childFactory from './pi-subagent-child-factory.mjs';

const delegationTools = new Set(['subagents_enable', 'subagent', 'contact_supervisor', 'subagent_supervisor', 'bg_wait']);

export default function bundledSubagents(pi) {
    setChildSessionFactory(childFactory());
    setChildSessionFactoryModule(fileURLToPath(new URL('./pi-subagent-child-factory.mjs', import.meta.url)));
    const calls = new AsyncLocalStorage();
    const definitions = new Map();
    let lazy = true, replaySelection;
    const selected = () => pi.getActiveTools().filter(name => delegationTools.has(name));
    const preserve = (names, selection) => [...names.filter(name => !delegationTools.has(name)), ...selection];
    const capture = (event, ctx) => {
        const recorded = ctx.sessionManager.getBranch().some(entry => entry.type === 'message' && entry.message.role === 'system'
            && (Object.hasOwn(entry.message, 'toolsAdded') || Object.hasOwn(entry.message, 'toolsRemoved')));
        replaySelection = recorded || event.type === 'session_tree' || event.reason === 'reload' ? selected() : undefined;
    };
    pi.on('session_start', capture);
    pi.on('session_tree', capture);
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
            pi.registerTool(lazy ? { ...definition, defaultActive: false } : definition);
            const call = calls.getStore();
            if (lazy && call?.open && call.selection && pi.getActiveTools().includes(tool.name) && !call.selection.includes(tool.name)) {
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
    // Eager configuration has no loader and retains its original registration defaults.
    if (!definitions.has('subagents_enable')) {
        lazy = false;
        for (const definition of definitions.values()) pi.registerTool(definition);
    }
    return result;
}
