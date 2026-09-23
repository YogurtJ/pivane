import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import scope from './scope.js';

// Loaded only in a worker whose native session already carries the matching marker.
export async function registerProfileMemory(pi: ExtensionAPI): Promise<void> {
    const context = scope.parseContext(process.env.PIVANE_AGENT_PROFILE_CONTEXT);
    if (!context || (!context.memory.enabled && !context.skills.learnedEnabled)
        || !scope.verifyNativeSession(context)) return;
    const bundle = process.env.PIVANE_HERMES_BUNDLE;
    if (!bundle || !path.isAbsolute(bundle) || !fs.existsSync(bundle) || !fs.statSync(bundle).isFile()) return;
    const upstream = await import(pathToFileURL(bundle).href);
    const root = context.profileRoot;
    const projectKey = createHash('sha256').update(context.cwd).digest('hex');
    const projectRoot = path.join(root, 'projects', projectKey);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(root) !== root) throw new Error('Profile memory root is not canonical');
    fs.mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(projectRoot) !== projectRoot) throw new Error('Profile project root is not canonical');

    let started = false;
    let stopped = false;
    const allowed = (ctx: any) => started && !stopped && ctx?.mode === 'rpc'
        && scope.eligibleManager(ctx.sessionManager, context, ctx.cwd);
    const guarded = new Proxy(pi, {
        get(target, key) {
            if (key !== 'registerTool') return (target as any)[key];
            return (tool: any) => pi.registerTool({ ...tool,
                description: tool.name === 'session_search'
                    ? `${tool.description}\n\nProject filters in Pivane use the full canonical cwd, not a basename.`
                    : tool.description,
                execute: (...args: any[]) => {
                    if (!allowed(args[args.length - 1])) throw new Error('Profile memory session binding is unavailable');
                    return tool.execute(...args);
                },
            });
        },
    }) as ExtensionAPI;
    const skillStore = new upstream.SkillStore({
        globalSkillsDir: path.join(root, 'skills'),
        piGlobalSkillsDir: path.join(context.agentDir, 'skills'),
        projectSkillsDir: path.join(projectRoot, 'skills'),
        projectName: context.cwd,
        legacySkillsDir: path.join(root, 'legacy-skills-disabled'),
        migrationSentinelPath: path.join(root, '.no-legacy-migration'),
    });
    if (context.skills.learnedEnabled) {
        pi.on('resources_discover', (event: any) => {
            if (stopped || event.cwd !== context.cwd || !scope.verifyNativeSession(context)) return;
            return { skillPaths: [skillStore.getGlobalSkillsDir(), skillStore.getProjectSkillsDir()] };
        });
        upstream.registerSkillTool(guarded, skillStore);
    }
    const config = {
        memoryDir: root, memoryMode: 'legacy-inject', memoryCharLimit: 16000,
        userCharLimit: 8000, memoryOverflowStrategy: 'reject', autoConsolidate: false,
        failureInjectionEnabled: false,
    };
    const store = context.memory.enabled ? new upstream.MemoryStore(config) : null;
    const projectStore = context.memory.enabled ? new upstream.MemoryStore({ ...config, memoryDir: projectRoot }) : null;
    const db = context.memory.enabled ? new upstream.DatabaseManager(root) : null;
    function index(file: string) {
        if (!db || !scope.eligibleFile(file, context)) return;
        const before = fs.statSync(file);
        const parsed = upstream.parseSessionFile(file);
        const after = fs.statSync(file);
        if (!parsed || before.dev !== after.dev || before.ino !== after.ino
            || before.size !== after.size || before.mtimeMs !== after.mtimeMs
            || !scope.eligibleFile(file, context)) return;
        parsed.project = fs.realpathSync(parsed.cwd);
        upstream.indexSession(db, parsed);
        upstream.upsertSessionFileMetadata(db, file, parsed.id);
    }
    if (db) {
        upstream.registerMemoryTool(guarded, store, () => projectStore, db, () => context.cwd);
        upstream.registerMemorySearchTool(guarded, db);
        upstream.registerSessionSearchTool(guarded, db, { variant: 'legacy' });
        pi.on('before_agent_start', (_event: any, ctx: any) => {
            if (!allowed(ctx)) return;
            const block = [store.formatForSystemPrompt(), projectStore.formatProjectBlock(context.cwd)].filter(Boolean).join('\n\n');
            if (block) return { systemPrompt: _event.systemPrompt + '\n\n' + block };
        });
    }
    pi.on('session_start', async (_event: any, ctx: any) => {
        if (stopped || ctx.mode !== 'rpc' || !scope.eligibleManager(ctx.sessionManager, context, ctx.cwd)) return;
        if (store) {
            await store.loadFromDisk();
            await projectStore.loadFromDisk();
        }
        if (context.skills.learnedEnabled) await skillStore.ensureDiscoveredRoots();
        started = true;
        if (db) {
            for (const file of scope.listEligibleFiles(context, 20)) {
                try { index(file); } catch { /* missing or changing sessions remain native, not indexed */ }
            }
        }
    });
    pi.on('agent_settled', (_event: any, ctx: any) => {
        if (!db || !allowed(ctx)) return;
        try { index(ctx.sessionManager.getSessionFile()); } catch { /* next settled turn or startup can retry */ }
    });
    pi.on('session_shutdown', (_event: any, ctx: any) => {
        if (stopped) return;
        if (db && allowed(ctx)) {
            try { index(ctx.sessionManager.getSessionFile()); } catch { /* best effort */ }
        }
        stopped = true;
        db?.close();
    });
}
