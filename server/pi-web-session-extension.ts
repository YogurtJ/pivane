import { randomUUID } from 'node:crypto';
import { searchHistory, previewHistory, setHistoryBookmark } from './pi-history-model.js';
import { sessionTree, checkNavigation } from './pi-session-tree.js';
import { promptFromEntry, validateMessage } from './pi-message-payload.js';
import { buildSessionContext, type ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
    // A managed process is bound to one file. Native replacement must not bypass Supervisor.
    const managed = () => Boolean(process.env.PI_WEB_NAVIGATION_TOKEN);
    const refuseReplacement = (_event: unknown, ctx: any) => {
        if (ctx.mode !== 'rpc' || !managed()) return;
        ctx.ui.notify('请使用网页的新建、切换或分叉入口；扩展不能替换受管会话。', 'warning');
        return { cancel: true };
    };
    pi.on('session_before_switch', refuseReplacement);
    pi.on('session_before_fork', refuseReplacement);
    let webNavigation = false;
    pi.on('session_before_tree', (_event, ctx) => {
        if (ctx.mode === 'rpc' && managed() && !webNavigation) {
            ctx.ui.notify('请使用网页的会话树、历史重试或恢复入口；扩展不能直接导航受管会话。', 'warning');
            return { cancel: true };
        }
    });
    pi.registerCommand('pi5-web-navigate', {
        description: `Pivane internal session navigation and context snapshot; managed-v1; model-catalog-v1; resources-v1; history-v1; tree-v1; tree-presentation-v1; history-presentation-v1; history-body-v1; reload-v1:${randomUUID()}`,
        handler: async (args, ctx) => {
            const request = JSON.parse(args);
            if (ctx.mode !== 'rpc' || request.token !== process.env.PI_WEB_NAVIGATION_TOKEN) throw new Error('Invalid navigation request');
            const notify = (data: object) => ctx.ui.notify(JSON.stringify({ pi5Navigation: request.id, ...data }));
            if (request.mode === 'models') {
                try {
                    if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error('busy');
                    const refreshed = await ctx.modelRegistry.refresh({ allowNetwork: false, signal: AbortSignal.timeout(8000) });
                    if (refreshed.aborted) throw new Error('aborted');
                    const available = ctx.modelRegistry.getAvailable();
                    if (available.length > 5000) throw new Error('model-limit');
                    const models = available.map(m => ({ id: m.id, provider: m.provider, name: m.name, input: m.input,
                        reasoning: m.reasoning, contextWindow: m.contextWindow, maxTokens: m.maxTokens, cost: m.cost }));
                    const response = { pi5Models: request.id, success: true, data: { models } };
                    if (Buffer.byteLength(JSON.stringify(response)) > 1024 * 1024) throw new Error('model-budget');
                    ctx.ui.notify(JSON.stringify(response));
                } catch { ctx.ui.notify(JSON.stringify({ pi5Models: request.id, success: false })); }
                return;
            }
            if (request.mode === 'resources') {
                try {
                    const options = ctx.getSystemPromptOptions();
                    const source = (value: any) => ({ path: String(value?.path || '').slice(0, 4096), source: String(value?.source || '').slice(0, 1000), scope: value?.scope, origin: value?.origin });
                    const active = new Set(pi.getActiveTools());
                    const commands = pi.getCommands().filter(c => !c.name.startsWith('pi5-web-navigate'));
                    const tools = pi.getAllTools();
                    const skills = options.skills || [];
                    const files = options.contextFiles || [];
                    if (commands.length + tools.length + skills.length + files.length > 3000) throw new Error('资源数量超过 3000 项');
                    const data = {
                        cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), projectTrusted: ctx.isProjectTrusted(),
                        contextFiles: files.map(f => ({ path: f.path })),
                        systemPrompt: { custom: Boolean(options.customPrompt), appended: Boolean(options.appendSystemPrompt) },
                        skills: skills.map(s => ({ name: s.name, path: s.filePath, source: source(s.sourceInfo) })),
                        commands: commands.map(c => ({ name: c.name, kind: c.source, source: source(c.sourceInfo) })),
                        tools: tools.map(t => ({ name: t.name, active: active.has(t.name), source: source(t.sourceInfo) })),
                    };
                    if (Buffer.byteLength(JSON.stringify(data)) > 512 * 1024) throw new Error('资源信息超过 512 KiB');
                    ctx.ui.notify(JSON.stringify({ pi5Resources: request.id, success: true, data }));
                } catch { ctx.ui.notify(JSON.stringify({ pi5Resources: request.id, success: false, error: '无法读取当前资源，或结果超过资源预算' })); }
                return;
            }
            if (request.mode === 'history') {
                let response;
                try {
                    let data;
                    if (request.kind === 'tree') data = sessionTree(ctx.sessionManager, request.input, { settled: ctx.isIdle() && !ctx.hasPendingMessages() });
                    else if (request.kind === 'search') data = searchHistory(ctx.sessionManager, request.input, { settled: ctx.isIdle() && !ctx.hasPendingMessages() });
                    else if (request.kind === 'preview') data = previewHistory(ctx.sessionManager, request.input, { settled: ctx.isIdle() && !ctx.hasPendingMessages() });
                    else if (request.kind === 'bookmark') data = setHistoryBookmark(ctx.sessionManager, request.input, (id, label) => pi.setLabel(id, label));
                    else throw new Error('不支持的历史操作');
                    response = { pi5History: request.id, success: true, data };
                    if (Buffer.byteLength(JSON.stringify(response), 'utf8') > 256 * 1024) throw new Error('历史查询结果超过传输上限，请缩小查询');
                } catch (error) {
                    response = { pi5History: request.id, success: false, error: error instanceof Error ? error.message : '历史操作失败', code: (error as any)?.code };
                }
                ctx.ui.notify(JSON.stringify(response));
                return;
            }
            if (request.mode === 'reload') {
                if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error('会话尚未空闲');
                // Do not use this ctx/pi after reload: the public API replaces the extension instance.
                await ctx.reload();
                return;
            }
            if (request.mode === 'context') {
                // Synchronous reads provide one coherent branch snapshot even while the Agent runs.
                // The supervisor consumes this private response before any browser broadcast.
                let response;
                try {
                    const branch = ctx.sessionManager.getBranch();
                    const context = buildSessionContext(branch, ctx.sessionManager.getLeafId());
                    const messages = context.messages.map(message => {
                        if (message.role === 'toolResult' || message.role === 'custom') {
                            const { details, ...visible } = message;
                            return visible;
                        }
                        return message;
                    });
                    response = { pi5Context: request.id, success: true, snapshot: {
                        systemPrompt: ctx.getSystemPrompt(), messages, thinkingLevel: pi.getThinkingLevel(),
                        model: ctx.model && { provider: ctx.model.provider, id: ctx.model.id, name: ctx.model.name,
                            contextWindow: ctx.model.contextWindow, maxTokens: ctx.model.maxTokens, input: ctx.model.input },
                        source: { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), name: ctx.sessionManager.getSessionName() || '主会话' },
                        capturedAt: new Date().toISOString(),
                    } };
                    if (Buffer.byteLength(JSON.stringify(response), 'utf8') > 32 * 1024 * 1024) throw new Error('context-limit');
                } catch {
                    response = { pi5Context: request.id, success: false, error: '无法读取主上下文，或背景超过 32 MiB 传输限额；未截断背景。' };
                }
                ctx.ui.notify(JSON.stringify(response));
                return;
            }
            if (request.mode === 'tree') {
                const initialLeaf = ctx.sessionManager.getLeafId();
                let persisted = false;
                try {
                    if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error('请等待当前任务和队列结束');
                    const target = checkNavigation(ctx.sessionManager, request.input);
                    const draft = target.type === 'message' && target.message.role === 'user' ? validateMessage(promptFromEntry(target)) : null;
                    webNavigation = true;
                    const result = await ctx.navigateTree(target.id, { summarize: request.input.summarize, customInstructions: request.input.customInstructions || undefined });
                    if (!result.cancelled) {
                        pi.appendEntry('pi5-web-navigation', { fromLeafId: initialLeaf, targetId: target.id, mode: 'tree' });
                        persisted = true;
                    }
                    notify({ success: true, data: { cancelled: result.cancelled, leafId: ctx.sessionManager.getLeafId(), draft: result.cancelled ? null : draft } });
                } catch (error) {
                    // A post-navigation hook may fail after the native leaf changed. Persist and report the actual context.
                    if (!persisted && ctx.sessionManager.getLeafId() !== initialLeaf) pi.appendEntry('pi5-web-navigation', { fromLeafId: initialLeaf, targetId: request.input?.entryId, mode: 'tree' });
                    notify({ success: false, error: error instanceof Error ? error.message : '导航失败，请核对当前位置' });
                } finally { webNavigation = false; }
                return;
            }
            try {
                if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error('会话尚未空闲');
                if (ctx.sessionManager.getLeafId() !== request.expectedLeafId) throw new Error('会话已变化，请重新打开编辑');
                const entries = ctx.sessionManager.getEntries();
                if (request.mode === 'retry') {
                    const last = ctx.sessionManager.getBranch().filter(entry => entry.type === 'message' && entry.message.role === 'user').at(-1);
                    if (last?.id !== request.entryId) throw new Error('只能编辑当前分支的最近一条问题');
                } else if (request.mode === 'restore') {
                    if (!entries.some(entry => entry.type === 'custom' && entry.customType === 'pi5-web-navigation' && entry.data?.fromLeafId === request.entryId)) throw new Error('历史版本不存在');
                } else throw new Error('Invalid navigation mode');
                let result;
                webNavigation = true;
                try { result = await ctx.navigateTree(request.entryId, { summarize: false }); }
                finally { webNavigation = false; }
                if (result.cancelled) throw new Error('会话回退已被扩展取消');
                // Persist the new active leaf, including navigation before the first user message.
                pi.appendEntry('pi5-web-navigation', { fromLeafId: request.expectedLeafId, targetId: request.entryId, mode: request.mode });
                notify({ success: true });
            } catch (error) {
                notify({ success: false, error: error instanceof Error ? error.message : '会话回退失败' });
            }
        }
    });
}
