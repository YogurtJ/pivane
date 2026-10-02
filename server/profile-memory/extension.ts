import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import scope from './scope.js';
import backgroundIndexer from './background-index.js';
import mutation from './mutation-lock.js';
import documentIndex from './document-index.js';
import toolMutations from './tool-mutations.js';
import { profileMemoryCapability, safeFile } from './management.js';

function assertPrivateSkillTree(...roots: string[]) {
    let count = 0;
    const visit = (file: string) => {
        if (++count > 1000) throw new Error('Profile skill tree exceeds safety budget');
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink() || fs.realpathSync.native(file) !== file)
            throw new Error('Profile skill path is not private');
        if (stat.isDirectory()) for (const name of fs.readdirSync(file)) visit(path.join(file, name));
    };
    for (const root of roots) if (fs.existsSync(root)) visit(root);
}

// Loaded only in a worker whose native session already carries the matching marker.
export async function registerProfileMemory(pi: ExtensionAPI): Promise<void> {
    const context = scope.parseContext(process.env.PIVANE_AGENT_PROFILE_CONTEXT);
    if (!context || !context.sessionPath || (!context.memory.enabled && !context.skills.learnedEnabled)) return;
    const bundle = process.env.PIVANE_HERMES_BUNDLE;
    if (!bundle || !path.isAbsolute(bundle) || !profileMemoryCapability({ bundlePath: bundle }).installed
        || !scope.verifyNativeSession(context)) return;
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
    let sourceIndex: ReturnType<typeof backgroundIndexer.createBackgroundIndex> | null = null;
    let activeIdentity: any = null;
    const memoryMutation = mutation.createMutationLock(root);
    const knowledgePath = path.join(__dirname, 'knowledge-service.js');
    const registryPath = path.join(context.agentDir, 'pivane-profiles', 'profiles.json');
    const knowledge = fs.existsSync(knowledgePath) ? new (require(knowledgePath).ProfileKnowledgeService)({
        profiles: { getProfile: async (id: string) => {
            if (id !== context.profileId) return null;
            const registry = require('../pi-profile-registry.js').readRegistry(registryPath);
            return registry.state.profiles.find((record: any) => record.id === id) || null;
        } }, getAgentDir: async () => context.agentDir, bundlePath: bundle,
    }) : null;
    const knowledgeTools = knowledge ? toolMutations.createKnowledgeMemoryTools(knowledge, context.profileId) : null;
    const allowed = (ctx: any) => started && !stopped && ctx?.mode === 'rpc'
        && scope.eligibleManager(ctx.sessionManager, context, ctx.cwd)
        && scope.sameActiveFile(ctx.sessionManager.getSessionFile(), activeIdentity);
    const indexPending = (target?: string) => ['memory', 'user'].some(kind =>
        (!target || target === kind) && documentIndex.pendingDocumentIndex(root, kind));
    const indexUnavailable = async (target?: string) => {
        if (indexPending(target)) return true;
        for (const kind of ['memory', 'user'] as const) {
            if (target && target !== kind) continue;
            const file = path.join(root, kind === 'user' ? 'USER.md' : 'MEMORY.md');
            const before = safeFile(file);
            if (!await documentIndex.documentIndexSynced(root, kind, bundle, before?.text ?? '')
                || safeFile(file)?.revision !== before?.revision) return true;
        }
        return false;
    };
    const guarded = new Proxy(pi, {
        get(target, key) {
            if (key !== 'registerTool') return (target as any)[key];
            return (tool: any) => {
                const creates = tool.name === 'memory_add' || tool.name === 'skill_manage';
                const wrapped = { ...tool,
                    parameters: creates ? { ...tool.parameters, properties: { ...tool.parameters.properties,
                        comparisonToken: Type.String({ maxLength: 1024,
                            description: 'Pivane token returned with existing candidates on the first create attempt. Pass it with unchanged create arguments only after comparing those entries and deciding this information is independently new.' }) } } : tool.parameters,
                    description: tool.name === 'session_search'
                        ? `${tool.description}\n\nProject filters use the full canonical cwd. Results cover only indexed, verified native sessions; backfill may be partial.`
                        : knowledge && ['memory_replace', 'memory_remove'].includes(tool.name)
                            ? `${tool.description}\n\nFor profile MEMORY/USER, old_text must exactly match one complete active memory entry. A knowledge receipt confirms the result; do not retry uncertain writes without checking the receipt.`
                            : creates ? `${tool.description}\n\nPivane create calls first return existing candidates without saving. Compare them, then use an existing-entry update or submit unchanged create arguments with the returned comparisonToken. This internal comparison needs no additional user approval.` : tool.description,
                    promptGuidelines: tool.name === 'skill_manage' ? [
                        ...(tool.promptGuidelines || []).filter((guideline: string) => guideline !==
                            'Use the skill_manage tool after completing complex tasks that required trial and error or multiple tool calls.'),
                        'Task complexity, trial and error, tool-call count, and useful content alone are not reasons to create a skill. Do not turn individual knowledge points, exercises, explanations, or favorites into skills; save requested study content in the designated notes.',
                        'Before any skill write, inspect existing skills. Prefer a focused update to an existing skill for a verified general workflow improvement. Create a new skill only when the user explicitly requests one, or when a distinct, durable procedure transfers across tasks and cannot reasonably fit an existing skill. Topic-specific details belong in source notes or references, not separate skills.',
                        'Keep skill writes within the profile-owned scope and include verification steps. Never modify shared installed skills. Newly created or updated skills require reload.',
                        'A create without comparisonToken only reads related existing skills. Compare the returned candidates; use view and update for an existing workflow, skip duplicates, and pass the token only for an independently new workflow.' ]
                        : ['memory_add', 'memory_replace', 'memory_remove'].includes(tool.name) ? [ ...(tool.promptGuidelines || []),
                            'Before saving memory, compare existing USER and MEMORY entries in this profile and the verified current project. Same fact: skip. Clear additional detail or explicit correction: read the complete old entry and use memory_replace, preserving all other valid facts. Independent new fact: create. Stable personal facts and preferences belong in USER; resource locations and dated durable history belong in MEMORY. Generic knowledge points, exercises, explanations and completed-task logs belong in the designated notes, not identity memory.',
                            'A memory_add without comparisonToken returns related old entries and saves nothing. Read them before choosing update or new; pass the returned token only with unchanged create arguments. Multiple overlapping records require a consolidation proposal, not separate new copies. Do not ask the user to approve this internal check.' ] : tool.promptGuidelines,
                    execute: async (...args: any[]) => {
                        if (!allowed(args[args.length - 1])) throw new Error('Profile memory session binding is unavailable');
                        if ((tool.name === 'memory_search' || ['memory_add', 'memory_replace', 'memory_remove'].includes(tool.name))
                            && await indexUnavailable(args[1]?.target)) throw new Error('Profile document search index needs repair');
                        if (tool.name === 'session_search') {
                            if (!sourceIndex) throw new Error('Profile session index is unavailable');
                            const result = await sourceIndex.search(args[1]);
                            if (!allowed(args[args.length - 1])) throw new Error('Profile memory binding changed');
                            return result;
                        }
                        if (tool.name === 'skill_manage') assertPrivateSkillTree(skillStore.getGlobalSkillsDir(), skillStore.getProjectSkillsDir());
                        const execute = async () => tool.execute(...args);
                        const viaKnowledge = knowledgeTools && (['memory_add', 'memory_replace', 'memory_remove', 'skill_manage'].includes(tool.name))
                            ? await knowledgeTools(tool.name, args[1], args[2], () => allowed(args[args.length - 1]), args[args.length - 1]) : null;
                        if (knowledge && tool.name === 'skill_manage' && !viaKnowledge
                            && !['view', 'list', 'read', 'show', 'get'].includes(args[1]?.action))
                            throw new Error('Unsupported profile skill write action');
                        const result = viaKnowledge || (['memory_add', 'memory_replace', 'memory_remove'].includes(tool.name)
                            ? await memoryMutation.run(args[2], async () => {
                                await store?.loadFromDisk();
                                await projectStore?.loadFromDisk();
                                if (!allowed(args[args.length - 1])) throw new Error('Profile memory binding changed');
                                if (await indexUnavailable(args[1]?.target)) throw new Error('Profile document search index needs repair');
                                return execute();
                            }) : await execute());
                        if (tool.name === 'memory_search' && await indexUnavailable(args[1]?.target))
                            throw new Error('Profile document search index changed during search');
                        return result;
                    },
                };
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
            if (stopped || (event.cwd || ctx.cwd) !== context.cwd || !allowed(ctx)) return;
            return { skillPaths: [skillStore.getGlobalSkillsDir(), skillStore.getProjectSkillsDir()] };
        });
        upstream.registerSkillTool(guarded, skillStore);
    }
    const config = {
        memoryDir: root, memoryMode: 'legacy-inject', memoryCharLimit: context.memory.memoryCharLimit,
        userCharLimit: context.memory.userCharLimit, memoryOverflowStrategy: 'reject', autoConsolidate: false,
        failureInjectionEnabled: false,
    };
    const store = context.memory.enabled ? new upstream.MemoryStore(config) : null;
    const projectStore = context.memory.enabled ? new upstream.MemoryStore({ ...config, memoryDir: projectRoot }) : null;
    const db = context.memory.enabled ? new upstream.DatabaseManager(root) : null;
    if (db) {
        upstream.registerMemoryTool(guarded, store, () => projectStore, db, () => context.cwd);
        upstream.registerMemorySearchTool(guarded, db);
        upstream.registerSessionSearchTool(guarded, db, { variant: 'legacy' });
        pi.on('before_agent_start', async (event: any, ctx: any) => {
            if (!allowed(ctx)) return;
            const loaded = await memoryMutation.inspect(async (generation: number) => {
                await store.loadFromDisk();
                await projectStore.loadFromDisk();
                if (!allowed(ctx) || await indexUnavailable()) throw new Error('Profile memory changed or needs repair');
                const profileBlock = store.formatForSystemPrompt(), projectBlock = projectStore.formatProjectBlock(context.cwd);
                const block = [profileBlock, projectBlock].filter(Boolean).join('\n\n');
                // Entry count as rendered: profile MEMORY/USER entries plus this cwd's project entries.
                const entries = (profileBlock ? store.getMemoryEntries().length + store.getUserEntries().length : 0)
                    + (projectBlock ? projectStore.getMemoryEntries().length : 0);
                return { generation, block, entries };
            }, ctx.signal);
            if (!allowed(ctx)) return;
            const loadedAt = new Date().toISOString();
            if (typeof pi.appendEntry === 'function') pi.appendEntry('pivane-profile-memory-read', {
                version: 1, profileId: context.profileId, generation: loaded.generation, loadedAt,
                scope: 'profile-and-physical-cwd', provided: Boolean(loaded.block),
                chars: loaded.block.length, entries: loaded.entries });
            if (loaded.block) return { systemPrompt: event.systemPrompt + '\n\n' + loaded.block };
        });
    }
    pi.on('session_start', async (_event: any, ctx: any) => {
        if (stopped || ctx.mode !== 'rpc' || !scope.eligibleManager(ctx.sessionManager, context, ctx.cwd)) return;
        activeIdentity = scope.verifyNativeSession(context, ctx.sessionManager);
        if (!activeIdentity) return;
        if (store) {
            await store.loadFromDisk();
            await projectStore.loadFromDisk();
        }
        if (context.skills.learnedEnabled) await skillStore.ensureDiscoveredRoots();
        if (db) {
            sourceIndex = backgroundIndexer.createBackgroundIndex(context, bundle);
            sourceIndex.schedule(ctx.sessionManager.getSessionFile());
        }
        started = true;
    });
    pi.on('agent_settled', (_event: any, ctx: any) => {
        if (!db || !allowed(ctx)) return;
        sourceIndex?.schedule(ctx.sessionManager.getSessionFile());
    });
    pi.on('session_shutdown', async () => {
        if (stopped) return;
        stopped = true;
        try { await sourceIndex?.close(); }
        finally { db?.close(); }
    });
}
