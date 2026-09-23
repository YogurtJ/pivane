import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import scope from './scope.js';
import indexer from './index.js';
import autoLearn from './auto-learn.js';

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
    if (fs.realpathSync.native(root) !== root) throw new Error('Profile memory root is not canonical');
    fs.mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
    if (fs.realpathSync.native(projectRoot) !== projectRoot) throw new Error('Profile project root is not canonical');

    let started = false;
    let stopped = false;
    let sourceIndex: ReturnType<typeof indexer.createIndex> | null = null;
    let coverage = { limited: true, initialSweepComplete: false };
    const registered = new Map<string, any>();
    const allowed = (ctx: any) => started && !stopped && ctx?.mode === 'rpc'
        && scope.eligibleManager(ctx.sessionManager, context, ctx.cwd)
        && scope.snapshot(ctx.sessionManager.getSessionFile(), context)?.header.id === context.sessionId;
    const guarded = new Proxy(pi, {
        get(target, key) {
            if (key !== 'registerTool') return (target as any)[key];
            return (tool: any) => {
                const wrapped = { ...tool,
                    description: tool.name === 'session_search'
                        ? `${tool.description}\n\nProject filters use the full canonical cwd. Results cover only indexed, verified native sessions; backfill may be partial.`
                        : tool.description,
                    promptGuidelines: tool.name === 'skill_manage' ? [ ...(tool.promptGuidelines || []),
                        'After a useful repeated procedure or correction, consider creating or updating a profile-owned skill with verification steps. Never modify shared installed skills. Newly created skills are available after reload.' ] : tool.promptGuidelines,
                    execute: async (...args: any[]) => {
                        if (!allowed(args[args.length - 1])) throw new Error('Profile memory session binding is unavailable');
                        if (tool.name === 'session_search') sourceIndex?.reconcile();
                        const result = await tool.execute(...args);
                        if (tool.name === 'session_search' && sourceIndex?.reconcile())
                            throw new Error('Profile session sources changed; retry search');
                        if (tool.name === 'session_search') {
                            result.details = { ...result.details, coverage };
                            if (coverage.limited || !coverage.initialSweepComplete) result.content.push({ type: 'text',
                                text: 'Profile session recall is partial; backfill is still progressing or the scan limit was reached.' });
                        }
                        return result;
                    },
                };
                registered.set(tool.name, wrapped);
                pi.registerTool(wrapped);
            };
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
        pi.on('resources_discover', (event: any, ctx: any) => {
            if (stopped || event.cwd !== context.cwd || !scope.eligibleManager(ctx.sessionManager, context, ctx.cwd)
                || scope.snapshot(ctx.sessionManager.getSessionFile(), context)?.header.id !== context.sessionId) return;
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
    if (db) {
        upstream.registerMemoryTool(guarded, store, () => projectStore, db, () => context.cwd);
        upstream.registerMemorySearchTool(guarded, db);
        upstream.registerSessionSearchTool(guarded, db, { variant: 'legacy' });
        pi.on('before_agent_start', (event: any, ctx: any) => {
            if (!allowed(ctx)) return;
            const block = [store.formatForSystemPrompt(), projectStore.formatProjectBlock(context.cwd)].filter(Boolean).join('\n\n');
            if (block) return { systemPrompt: event.systemPrompt + '\n\n' + block };
        });
        if (context.memory.autoLearn) {
            const reviewer = autoLearn.createReviewer(pi, { context, store, projectStore, tools: registered, allowed });
            pi.on('agent_before_settle', reviewer.review);
        }
    }
    pi.on('session_start', async (_event: any, ctx: any) => {
        if (stopped || ctx.mode !== 'rpc' || !scope.eligibleManager(ctx.sessionManager, context, ctx.cwd)
            || !scope.snapshot(ctx.sessionManager.getSessionFile(), context)) return;
        if (store) {
            await store.loadFromDisk();
            await projectStore.loadFromDisk();
        }
        if (context.skills.learnedEnabled) await skillStore.ensureDiscoveredRoots();
        if (db) {
            sourceIndex = indexer.createIndex(db, upstream, context);
            sourceIndex.reconcile();
            sourceIndex.index(ctx.sessionManager.getSessionFile());
            coverage = sourceIndex.advance();
        }
        started = true;
    });
    pi.on('agent_settled', (_event: any, ctx: any) => {
        if (!db || !allowed(ctx)) return;
        try { sourceIndex?.index(ctx.sessionManager.getSessionFile()); if (sourceIndex) coverage = sourceIndex.advance(); }
        catch { /* native sessions remain authoritative; search still checks persisted rows */ }
    });
    pi.on('session_shutdown', (_event: any, ctx: any) => {
        if (stopped) return;
        if (db && allowed(ctx)) {
            try { sourceIndex?.index(ctx.sessionManager.getSessionFile()); } catch { /* best effort */ }
        }
        stopped = true;
        sourceIndex?.close();
        if (!sourceIndex) db?.close();
    });
}
