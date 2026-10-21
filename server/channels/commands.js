const { randomUUID } = require('node:crypto');
const { sessionStats } = require('../pi-session-store');
const { commandControl } = require('./command-control');
const same = (a, b) => a?.cwd === b?.cwd && a?.sessionId === b?.sessionId;
function fmtTokens(n) {
    if (!Number.isFinite(n) || n < 0) return null;
    if (n >= 1000000) return `${(n / 1000000).toFixed(n >= 10000000 ? 0 : 1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
    return String(Math.round(n));
}
async function handleSlash(job, slash, run) {
    const control = commandControl(this, job, run);
    control.check();
    const binding = this.bindingFor(job);
    if (!binding) return null;
    const busyWithOther = () => [...this.runs.entries()].some(([key, r]) => key !== job.id && same(r.target, job.target));
    const bindToSession = targetSession => this.withBindingTarget(targetSession.cwd, targetSession.id, (session, boundary) => {
        control.submit();
        const newBindingId = randomUUID();
        this.db.change(v => {
            v.bindings = v.bindings.filter(b => !(b.accountId === job.accountId && b.peerId === job.peerId));
            const target = { cwd: session.cwd, sessionId: session.id };
            v.bindings.push({ id: newBindingId, accountId: job.accountId, peerId: job.peerId, ...target,
                name: session.name || session.id, replyMode: binding.replyMode || 'all', ...boundary });
            const index = v.jobs.findIndex(j => j.id === job.id);
            for (const [i, current] of v.jobs.entries()) {
                if (current.id === job.id || i > index && current.status === 'queued' && current.kind !== 'cron'
                    && current.accountId === job.accountId && current.peerId === job.peerId
                    && current.bindingId === binding.id && !this.runs.has(current.id)) {
                    current.bindingId = newBindingId; current.target = target;
                }
            }
        }, { config: true });
        if (run) run.target = { cwd: session.cwd, sessionId: session.id };
    });
    if (slash.command === '/help') {
        return [
            '📋 微信可用指令：',
            '/status — 查看当前线程详情、上下文用量、模型与统计',
            '/stop — 停止当前正在运行的任务',
            '/confirm [卡片ID前缀] — 确认生成当前分支最新的待确认媒体卡片（如视频）',
            '/new [标题] — 新建线程并切换微信绑定（别名 /reset）',
            '/resume [序号|关键词|ID] — 查看最近线程列表或切换绑定线程',
            '/name <新标题> — 重命名当前绑定的线程',
            '/model [模型名] — 查看或切换当前线程模型',
            '/thinking [等级] — 查看或切换思考等级（如 off/low/medium/high）',
            '/compact [附加要求] — 手动压缩当前线程上下文',
            '/reload — 重新加载当前线程的技能、提示词与扩展资源',
            '/help — 查看此帮助说明'
        ].join('\n');
    }
    if (slash.command === '/stop') {
        const targetRun = [...this.runs.entries()].find(([key, r]) => key !== job.id && same(r.target, job.target) && r.worker);
        if (targetRun?.[1].worker) {
            await targetRun[1].worker.request('abort', {}, null, undefined, control.submit);
            return '';
        }
        const session = await this.store.getSession(binding.cwd, binding.sessionId);
        const active = this.supervisor.getActiveWorker(session.path);
        if (active && !active.isIdle()) {
            await active.request('abort', {}, null, undefined, control.submit);
            return '⏹ 已向当前线程发送停止请求。';
        }
        return '当前线程没有正在运行的任务。';
    }
    if (slash.command === '/status') {
        let offlineStats = null;
        const session = await this.store.withSessionRead(binding.cwd, binding.sessionId, (s, read) => {
            offlineStats = sessionStats(read.manager());
            return s;
        });
        const worker = this.supervisor.getActiveWorker(session.path);
        const running = [...this.runs.entries()].find(([key, r]) => key !== job.id && same(r.target, job.target) && r.worker);
        const waitingJob = running && this.job(running[0])?.waiting;
        let modelText = offlineStats?.model?.id ? `${offlineStats.model.provider ? offlineStats.model.provider + '/' : ''}${offlineStats.model.id}` : '将在首次运行时加载';
        let stateText = worker ? (worker.isIdle() ? '空闲' : '运行中') : '未打开（空闲）';
        if (waitingJob) stateText = '⚠️ 等待网页交互确认';
        let contextLine = null;
        let messagesCount = offlineStats?.messages ?? session.messageCount ?? 0;
        const compactionsCount = offlineStats?.compactions ?? 0;
        const contextKept = offlineStats?.context ?? messagesCount;
        let usageLine = null;
        if (worker) {
            try {
                const [state, stats] = await Promise.all([
                    worker.request('get_state'),
                    worker.request('get_session_stats').catch(() => null)
                ]);
                if (state.model) modelText = `${state.model.provider}/${state.model.id}（思考：${state.thinkingLevel || '默认'}）`;
                if (state.isCompacting) stateText = '正在压缩上下文';
                const autoCompact = state.autoCompactionEnabled !== false ? '开启' : '关闭';
                stateText += ` · 自动压缩：${autoCompact}`;
                if (stats?.totalMessages != null) messagesCount = stats.totalMessages;
                const cu = stats?.contextUsage;
                if (cu && Number.isFinite(cu.percent) && Number.isFinite(cu.tokens)) {
                    const cap = Number.isFinite(cu.contextWindow) ? ` / ${fmtTokens(cu.contextWindow)}` : '';
                    contextLine = `${Math.round(cu.percent)}%（${fmtTokens(cu.tokens)}${cap} tokens）`;
                } else if (cu && Number.isFinite(cu.contextWindow)) {
                    const est = offlineStats?.contextTokens ? `约 ${fmtTokens(offlineStats.contextTokens)}` : '--';
                    contextLine = `${est} / ${fmtTokens(cu.contextWindow)} tokens`;
                }
                const tok = stats?.tokens;
                if (tok && (tok.input || tok.output || tok.cacheRead)) {
                    const parts = [
                        `输入 ${fmtTokens(tok.input || 0)}`,
                        `输出 ${fmtTokens(tok.output || 0)}`,
                        ...(tok.cacheRead ? [`缓存 ${fmtTokens(tok.cacheRead)}`] : [])
                    ];
                    if (Number.isFinite(Number(stats.cost)) && Number(stats.cost) > 0) parts.push(`约 $${Number(stats.cost).toFixed(3)}`);
                    usageLine = parts.join(' / ');
                }
            } catch {}
        }
        if (!contextLine && offlineStats?.contextTokens) {
            contextLine = `最近约 ${fmtTokens(offlineStats.contextTokens)} tokens`;
        }
        const profileName = session.agentProfile?.name || '无身份';
        const recordParts = [`共 ${messagesCount} 条消息`];
        if (compactionsCount > 0) recordParts.push(`已压缩 ${compactionsCount} 次（当前保留 ${contextKept} 条）`);
        const lines = [
            `📌 线程：${session.name || session.id}`,
            `🆔 会话 ID：${session.id}`,
            `📁 项目：${session.cwd}`,
            `👤 身份：${profileName}`,
            `⚙️ 状态：${stateText}`,
            `🤖 模型：${modelText}`,
            `📊 上下文：${contextLine || '暂无统计'}`,
            `💬 记录：${recordParts.join(' · ')}`
        ];
        if (usageLine) lines.push(`💰 累计用量：${usageLine}`);
        if (session.modified) {
            const d = new Date(session.modified);
            if (Number.isFinite(d.getTime())) lines.push(`🕒 更新于：${d.toLocaleString('zh-CN', { hour12: false })}`);
        }
        return lines.join('\n');
    }
    if (slash.command === '/new' || slash.command === '/reset') {
        if (busyWithOther()) return '⚠️ 当前线程正在运行任务，请先发送 /stop 或等待完成后再新建线程。';
        const session = await this.store.getSession(binding.cwd, binding.sessionId);
        const active = this.supervisor.getActiveWorker(session.path);
        if (active && !active.isIdle()) return '⚠️ 当前线程正忙，请稍后再新建线程。';
        const title = slash.args ? slash.args.slice(0, 80) : '微信对话';
        return control.withWorker(async () => {
                control.submit();
                const created = await this.store.createSession(binding.cwd, title);
                await bindToSession(created);
                return `✅ 已新建并绑定线程：${created.name || created.id}\n🆔 会话 ID：${created.id}\n原线程历史已完整保留。`;
        });
    }
    if (slash.command === '/resume') {
        if (busyWithOther()) return '⚠️ 当前线程正在运行任务，请先发送 /stop 或等待完成后再切换线程。';
        const currentSession = await this.store.getSession(binding.cwd, binding.sessionId);
        const active = this.supervisor.getActiveWorker(currentSession.path);
        if (active && !active.isIdle()) return '⚠️ 当前线程正忙，请等待空闲后再切换线程。';
        const allSessions = await this.store.listSessions(binding.cwd);
        if (!allSessions.length) return '当前项目下暂无可切换的会话线程。';
        const formatList = (list, headerText) => {
            control.check();
            const candidateIds = list.map(s => s.id);
            this.db.change(v => {
                const p = v.peers.find(x => x.accountId === job.accountId && x.peerId === job.peerId);
                if (p) { p.resumeCandidates = candidateIds; p.resumeCwd = binding.cwd; p.resumeListedAt = Date.now(); }
            });
            const rows = list.map((s, idx) => {
                const currentMark = s.id === binding.sessionId ? '（当前绑定）' : '';
                const title = s.name || s.firstMessage?.slice(0, 28) || s.id.slice(0, 8);
                const count = s.stats?.messages ?? s.messageCount ?? 0;
                return `[${idx + 1}] ${title}${currentMark}\n    ID: ${s.id.slice(0, 8)}… · ${count} 条消息`;
            });
            return `${headerText}\n${rows.join('\n')}\n\n💡 发送 /resume <序号> 或 /resume <标题关键词> 即可切换绑定。`;
        };
        const arg = slash.args.trim();
        if (!arg || arg.toLowerCase() === 'list') {
            return formatList(allSessions.slice(0, 10), `📂 当前项目最近线程（共 ${allSessions.length} 条，显示前 ${Math.min(10, allSessions.length)} 条）：`);
        }
        const peer = this.db.value.peers.find(p => p.accountId === job.accountId && p.peerId === job.peerId);
        let chosen = null;
        if (/^\d{1,2}$/.test(arg)) {
            const index = Number(arg) - 1;
            if (!peer?.resumeCandidates?.length || peer.resumeCwd !== binding.cwd
                || !Number.isFinite(peer.resumeListedAt) || Date.now() - peer.resumeListedAt > 30 * 60 * 1000) {
                return '❌ 线程列表已失效，请先发送 /resume 查看当前项目列表。';
            }
            const candidates = peer.resumeCandidates;
            if (index < 0 || index >= candidates.length) {
                return `❌ 序号 ${arg} 超出范围（1–${candidates.length}）。请先发送 /resume 查看列表。`;
            }
            chosen = allSessions.find(s => s.id === candidates[index]);
            if (!chosen) return '❌ 该序号对应的线程已不存在，请重新发送 /resume 查看列表。';
        } else {
            const q = arg.toLowerCase();
            const exactId = allSessions.find(s => s.id.toLowerCase() === q);
            if (exactId) chosen = exactId;
            else {
                const matches = allSessions.filter(s => s.id.toLowerCase().startsWith(q)
                    || (s.name || '').toLowerCase().includes(q)
                    || (s.firstMessage || '').toLowerCase().includes(q));
                if (!matches.length) return `❌ 未找到匹配「${arg}」的线程。可发送 /resume 查看最近线程列表。`;
                if (matches.length > 1) {
                    return formatList(matches.slice(0, 10), `🔍 找到 ${matches.length} 条匹配「${arg}」的线程，请按序号选择：`);
                }
                chosen = matches[0];
            }
        }
        if (chosen.id === binding.sessionId) {
            return `📌 当前已绑定在该线程：${chosen.name || chosen.id}\n🆔 会话 ID：${chosen.id}`;
        }
        await control.withWorker(() => bindToSession(chosen));
        return `✅ 已切换微信绑定到线程：${chosen.name || chosen.id}\n🆔 会话 ID：${chosen.id}\n💬 消息数：${chosen.stats?.messages ?? chosen.messageCount ?? 0} 条`;
    }
    if (slash.command === '/name') {
        const newName = slash.args.trim().slice(0, 120);
        if (!newName) return '✏️ 请提供新线程名称，例如：/name 微信渠道优化讨论';
        if (busyWithOther()) return '⚠️ 当前线程正在运行任务，请等待完成后再修改名称。';
        const session = await this.store.getSession(binding.cwd, binding.sessionId);
        const active = this.supervisor.getActiveWorker(session.path);
        if (active && !active.isIdle()) return '⚠️ 当前线程正忙，请等待空闲后再修改名称。';
        const renamed = await control.withWorker(async (_worker, rpc, _state, currentSession) => {
            await rpc('set_session_name', { name: newName });
            this.store.sessionLists?.delete(binding.cwd);
            return { ...currentSession, name: newName };
        });
        this.db.change(v => {
            for (const b of v.bindings) if (b.cwd === binding.cwd && b.sessionId === binding.sessionId) b.name = renamed.name;
        }, { config: true });
        return `✅ 已将当前线程重命名为：${renamed.name}`;
    }
    if (slash.command === '/model') {
        if (busyWithOther()) return '⚠️ 当前线程正在运行，请等待完成后再查看或切换模型。';
        return control.withWorker(async (worker, rpc, state) => {
            const catalog = await rpc('get_available_models');
            const models = catalog?.models || [];
            if (!slash.args || slash.args.toLowerCase() === 'list') {
                const current = state.model ? `${state.model.provider}/${state.model.id}` : '未选择';
                const sample = models.slice(0, 12).map(m => `- ${m.provider}/${m.id}`).join('\n');
                return `🤖 当前模型：${current}\n思考等级：${state.thinkingLevel || '默认'}\n\n可用模型示例：\n${sample || '（暂无可用模型）'}\n\n发送 /model <provider/modelId> 即可切换。`;
            }
            const query = slash.args.trim().toLowerCase();
            const full = models.filter(m => `${m.provider}/${m.id}`.toLowerCase() === query);
            const bare = models.filter(m => String(m.id).toLowerCase() === query);
            const matches = full.length ? full : bare.length ? bare : models.filter(m => `${m.provider}/${m.id} ${m.name || ''}`.toLowerCase().includes(query));
            if (!matches.length) return `❌ 未找到匹配的可用模型：${slash.args}`;
            if (matches.length > 1) return `找到多个匹配模型，请指定完整名称：\n${matches.slice(0, 8).map(m => `- ${m.provider}/${m.id}`).join('\n')}`;
            const chosen = matches[0];
            await rpc('set_model', { provider: chosen.provider, modelId: chosen.id });
            return `✅ 已将当前线程模型切换为：${chosen.provider}/${chosen.id}`;
        });
    }
    if (slash.command === '/thinking') {
        if (busyWithOther()) return '⚠️ 当前线程正在运行，请等待完成后再查看或切换思考等级。';
        return control.withWorker(async (worker, rpc, state) => {
            const available = await rpc('get_available_thinking_levels');
            const levels = available?.levels || [];
            const arg = slash.args.trim().toLowerCase();
            if (!arg || arg === 'list') {
                return `🧠 当前思考等级：${state.thinkingLevel || '默认'}\n当前模型支持的等级：${levels.join('、') || '默认'}\n\n发送 /thinking <等级> 即可切换。`;
            }
            if (!levels.includes(arg)) {
                return `❌ 当前模型不支持思考等级「${slash.args.trim()}」。\n可选等级：${levels.join('、') || '无'}`;
            }
            await rpc('set_thinking_level', { level: arg });
            return `✅ 已将当前线程思考等级切换为：${arg}`;
        });
    }
    if (slash.command === '/compact') {
        if (busyWithOther()) return '⚠️ 当前线程正在运行任务，请等待完成后再压缩上下文。';
        return control.withWorker(async (worker, rpc, state) => {
            const account = this.db.value.accounts.find(a => a.id === job.accountId);
            const stopTyping = account ? await this.startTyping(account, job.peerId) : () => Promise.resolve();
            try {
                const customInstructions = slash.args.trim().slice(0, 4000);
                await rpc('compact', customInstructions ? { customInstructions } : {}, 11 * 60 * 1000);
                const after = await rpc('get_state');
                const c = after.webCompaction;
                if (c?.status === 'unchanged') return 'ℹ️ 当前上下文无需压缩（内容较少或刚刚压缩过）。';
                if (c?.status === 'cancelled') return '⏹ 上下文压缩已取消。';
                if (c?.status === 'error') return `❌ 上下文压缩未完成：${c.errorMessage || '请稍后重试'}`;
                if (c?.status !== 'success') throw new Error('未取得本次压缩的完成凭据');
                const details = [];
                if (Number.isFinite(c?.tokensBefore)) details.push(`压缩前 ${fmtTokens(c.tokensBefore)}`);
                if (Number.isFinite(c?.estimatedTokensAfter)) details.push(`压缩后约 ${fmtTokens(c.estimatedTokensAfter)} tokens`);
                return `✅ 上下文压缩完成${details.length ? `（${details.join(' → ')}）` : ''}。`;
            } catch (error) {
                if (/Already compacted|Nothing to compact/i.test(error.message || '')) return 'ℹ️ 当前上下文无需压缩（内容较少或刚刚压缩过）。';
                if (error.code === 'CHANNEL_ADMISSION_CHANGED' || error.code === 'RPC_TIMEOUT') throw error;
                const after = await rpc('get_state').catch(() => null);
                if (after?.webCompaction?.status === 'cancelled') return '⏹ 上下文压缩已取消。';
                if (after?.webCompaction?.status === 'error') return '❌ 上下文压缩失败，请在 Pivane 网页查看详情。';
                throw error;
            } finally {
                await stopTyping();
            }
        });
    }
    if (slash.command === '/reload') {
        if (busyWithOther()) return '⚠️ 当前线程正在运行任务，请等待完成后再重新加载资源。';
        return control.withWorker(async (worker, rpc, state) => {
            const commands = await worker.reloadResources({ rpc });
            const count = commands?.commands?.length ?? 0;
            return `✅ 已重新加载当前线程的技能、提示词与扩展资源（当前可用命令 ${count} 项）。`;
        });
    }
    if (slash.command === '/confirm') {
        if (!this.mediaLabService?.chatRequests) return '⚠️ 当前实例未启用媒体卡片服务。';
        if (busyWithOther()) return '⚠️ 当前线程正在运行任务，请等待完成后再确认媒体卡片。';
        return control.withWorker(async (_worker, _rpc, _state, session) => {
            let plans = [];
            await this.store.withSessionRead(session.cwd, session.id, (_s, read) => {
                plans = read.manager().getBranch().filter(e => e.type === 'message' && e.message?.role === 'toolResult'
                    && !e.message.isError && ['media_generate', 'media_plan_request'].includes(e.message.toolName))
                    .map(e => e.message.details?.plan).filter(p => typeof p?.id === 'string' && /^plan-[0-9a-f-]{36}$/.test(p.id)).slice(-50);
                read.validate();
            });
            if (!plans.length) return 'ℹ️ 当前线程分支没有媒体生成卡片。';
            const arg = slash.args.trim().toLowerCase();
            const chatReq = this.mediaLabService.chatRequests;
            const matchingPlans = arg ? plans.filter(plan => plan.id.toLowerCase().includes(arg)
                || (plan.summary || '').toLowerCase().includes(arg)) : plans;
            if (!matchingPlans.length) return 'ℹ️ 当前线程没有匹配的媒体生成卡片。';
            let chosen = null;
            for (const plan of [...matchingPlans].reverse()) {
                const state = chatReq.publicState(plan.id);
                if (!state.attempts?.length) { chosen = plan; break; }
            }
            if (!chosen) {
                const latest = matchingPlans.at(-1);
                const latestState = latest && chatReq.publicState(latest.id)?.attempts?.at(-1);
                if (latestState?.status === 'running' || latestState?.status === 'queued') {
                    return `⏳ 媒体卡片「${latest.summary || latest.modelId}」已在${latestState.status === 'queued' ? '排队' : '生成'}中，无需重复确认。`;
                }
                if (latestState?.status === 'done') {
                    const current = this.db.value.jobs.find(j => j.id === job.id);
                    control.check();
                    if (current) this.updateJob(job.id, { mediaPlans: [{ id: latest.id, kind: latest.kind, modelId: latest.modelId, summary: latest.summary }] });
                    return `✅ 媒体卡片「${latest.summary || latest.modelId}」已完成生成。`;
                }
                return 'ℹ️ 当前线程没有待确认的媒体生成卡片。';
            }
            const account = this.db.value.accounts.find(a => a.id === job.accountId);
            const stopTyping = account ? await this.startTyping(account, job.peerId) : () => Promise.resolve();
            try {
                control.submit();
                const submitted = await chatReq.run({ key: chosen.id, modelId: chosen.modelId, parameters: chosen.parameters, confirmed: true });
                if (submitted.status === 'changed') {
                    return `⚠️ 服务端规范化了部分参数，请打开 Pivane 网页端核对卡片「${chosen.summary || chosen.modelId}」后再确认。`;
                }
                const waitMs = chosen.kind === 'video' ? 15000 : 60000;
                const state = await chatReq.waitFor(chosen.id, waitMs);
                const last = state?.attempts?.at(-1);
                const current = this.db.value.jobs.find(j => j.id === job.id);
                control.check();
                if (current) this.updateJob(job.id, { mediaPlans: [{ id: chosen.id, kind: chosen.kind, modelId: chosen.modelId, summary: chosen.summary }] });
                if (last?.status === 'done') {
                    return `✅ 已确认并完成生成：${chosen.summary || chosen.modelId}（${chosen.modelId}）。`;
                }
                if (last?.status === 'running' || last?.status === 'queued') {
                    return `🎬 已确认并开始生成：${chosen.summary || chosen.modelId}（${chosen.modelId}）。\n当前状态：${last.status === 'queued' ? '排队中' : '后台生成中'}（可在网页查看进度，或稍后发送 /confirm 查看是否完成）。`;
                }
                return `❌ 媒体生成未完成（${last?.status || 'failed'}）：${last?.error || '请打开 Pivane 网页端查看卡片详情'}`;
            } finally {
                await stopTyping();
            }
        });
    }
    return null;
}
module.exports = { handleSlash };
