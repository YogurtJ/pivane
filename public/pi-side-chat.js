(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const $ = id => document.getElementById(id);
    const textOf = message => typeof message?.content === 'string' ? message.content : (message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
    const tokenText = value => typeof value === 'number' && Number.isFinite(value) ? value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value) : '--';

    function createThread(host, root, manager) {
    const $ = id => root.querySelector(`#${id}`);
    class SideThread {
        constructor(host) {
            this.root = root;
            this.manager = manager;
            this.host = host;
            this.enabled = false;
            this.generation = 0;
            this.revision = 0;
            this.requests = new Map();
            this.nextId = 0;
            this.connected = false;
            this.busy = false;
            this.messages = [];
            this.toolEvents = new Map();
            this.toolMode = manager.toolsEnabled ? 'assist' : 'none';
            this.toolAccess = 'read';
            this.input = $('pi-side-input');
            this.quotes = [];
            this.quoteHost = document.createElement('div'); this.quoteHost.className = 'pi-side-quotes';
            $('pi-side-form').before(this.quoteHost);
            this.content = $('pi-side-messages');
            this.source = $('pi-side-source');
            this.scroll = new window.PiTranscriptScroll({ viewport: $('pi-side-transcript'), content: this.content,
                track: $('pi-side-track'), thumb: $('pi-side-thumb'), latest: $('pi-side-latest') });
            $('pi-side-reference').addEventListener('toggle', () => this.scroll.update());
            $('pi-side-refresh').addEventListener('click', () => this.run(() => this.restart()));
            this.source.addEventListener('change', () => this.run(async () => {
                if (!await this.restart()) this.source.value = this.referenceValue || this.defaultSource();
            }));
            $('pi-side-end').addEventListener('click', () => this.run(() => this.end()));
            $('pi-side-stop').addEventListener('click', () => this.run(async () => { await this.request('abort', {}, 65000); await this.synchronize(); }));
            $('pi-side-parent-state').addEventListener('click', () => this.host.focusMain());
            $('pi-side-form').addEventListener('submit', event => { event.preventDefault(); void this.send(); });
            this.input.addEventListener('input', () => this.controls());
            this.input.addEventListener('keydown', event => {
                if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void this.send(); }
            });
            this.content.addEventListener('click', event => {
                const button = event.target.closest('[data-side-action]');
                if (!button) return;
                this.run(async () => {
                    if (button.dataset.sideAction === 'copy') {
                        await host.copyText(button._sideText);
                        button.innerHTML = '<i class="fa-solid fa-check"></i>';
                        setTimeout(() => { button.innerHTML = '<i class="fa-regular fa-copy"></i>'; }, 1200);
                    } else {
                        if (this.parentKey !== this.identity()) throw new Error(translateUi("主会话已切换，请复制文本后自行选择目标会话"));
                        host.insertDraft(button._sideText);
                    }
                });
            });
            this.render([]);
        }

        identity() { const ctx = this.host.context(); return JSON.stringify([ctx.cwd, ctx.session?.id]); }
        async run(action) { try { return await action(); } catch (error) { if (error.code === 'SIDE_CANCELLED') return false; this.status(error.message, true); this.host.toast(error.message, 'error'); return false; } }
        defaultSource() { return this.fullContext ? 'context' : 'recent-6'; }
        setEnabled(enabled, fullContext = false) {
            this.enabled = enabled; this.fullContext = fullContext;
            this.source.querySelector('[value="context"]').hidden = !fullContext;
            for (const value of ['recent-6', 'recent-12']) this.source.querySelector(`[value="${value}"]`).hidden = fullContext;
            if (!this.connected && !this.starting) this.source.value = this.defaultSource();
            this.updateParent();
        }
        showPane(mode) { if (this.manager.current === this) this.manager.showPane(mode); }
        updateParent() {
            const ctx = this.host.context();
            $('pi-side-parent-state').textContent = !ctx.connected ? translateUi("主会话未连接") : ctx.waiting ? translateUi("主会话等待确认") : ctx.busy ? translateUi("主会话处理中") : translateUi("主会话空闲");
            $('pi-side-parent-state').dataset.waiting = String(Boolean(ctx.waiting));
            if (!this.retainOnSwitch && this.parentKey && (this.parentKey !== this.identity() || !ctx.connected) && (this.connected || this.starting)) {
                this.dropSocket(); this.starting = null;
                this.status(translateUi("主连接已变化，临时侧聊已结束"), true);
            }
            this.controls();
        }
        controls() {
            const ready = this.enabled && this.host.context().connected;
            $('pi-side-refresh').disabled = !ready || Boolean(this.starting);
            this.source.disabled = !ready || Boolean(this.starting);
            $('pi-side-tool-mode').textContent = this.toolMode !== 'assist' ? translateUi('无工具') : this.confirmation ? translateUi('等待确认') : this.toolAccess === 'write' ? translateUi('本次可修改') : translateUi('可读取');
            $('pi-side-end').disabled = !this.socket && !this.starting && !this.messages.length && !this.input.value && !this.quotes.length;
            this.input.disabled = !this.connected || Boolean(this.starting);
            $('pi-side-send').hidden = this.busy;
            $('pi-side-stop').hidden = !this.busy;
            $('pi-side-stop').disabled = !this.connected;
            $('pi-side-send').disabled = !this.connected || this.busy || this.submitting || (!this.input.value.trim() && !this.quotes.length);
        }
        status(text, error = false) { $('pi-side-status').textContent = text; $('pi-side-status').dataset.error = String(error); }
        options(value = this.source.value) {
            return value === 'context' ? { mode: 'context' } : value === 'blank' ? { mode: 'blank' } : { mode: 'recent', count: value === 'recent-12' ? 12 : 6 };
        }
        renderQuotes() {
            this.quoteHost.replaceChildren(...this.quotes.map(quote => window.PiQuotes.card(quote, () => {
                this.quotes = this.quotes.filter(item => item !== quote); this.renderQuotes(); this.controls();
            })));
        }
        async open({ question, quote } = {}) {
            const key = this.identity();
            if (!this.enabled) throw new Error(translateUi("当前后端尚未启用侧聊"));
            if (!this.host.context().connected) throw new Error(translateUi("请先连接主会话"));
            this.showPane('side');
            if (this.starting) await this.starting;
            if (!this.connected && !await this.restart()) return false;
            if (this.destroyed || this.manager.current !== this || key !== this.identity()) return false;
            if (quote) {
                const quotes = [...this.quotes, quote];
                if (quotes.length > 8 || (quotes.map(window.PiQuotes.serialize).join('') + this.input.value).length > this.limits.messageCharacters) throw new Error(translateUi('引用与问题超过侧聊长度限制，请减少选中文字'));
                this.quotes = quotes; this.renderQuotes(); this.controls();
            }
            if (question) {
                if (this.input.value.trim() && this.input.value !== question) throw new Error(translateUi("侧聊已有未发送草稿，请先处理该草稿"));
                this.input.value = question;
                this.controls();
                return this.send();
            }
            this.input.focus();
            return true;
        }
        async restart(options = this.options()) {
            this.manager.reserve(this);
            if (this.starting) return this.starting;
            if ((this.messages.length || this.busy || this.input.value.trim() || this.quotes.length) && !window.confirm(translateUi("重新引用会开始新的临时侧聊，已有侧聊记录将清空。继续？"))) return false;
            const key = this.identity(), draft = this.input.value;
            const promise = (async () => {
                await this.shutdownSocket();
                if (key !== this.identity() || !this.host.context().connected) return false;
                const generation = ++this.generation;
                this.parentKey = key; this.uncertain = false; this.live = null;
                this.render([]); this.scroll.reset();
                this.status(translateUi("正在准备只读引用"));
                const prepared = await this.host.prepare(options);
                if (generation !== this.generation || key !== this.identity()) return false;
                this.referenceValue = options.mode === 'context' ? 'context' : options.mode === 'blank' ? 'blank' : `recent-${options.count || 6}`;
                this.source.value = this.referenceValue;
                this.showReference(prepared.reference);
                const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
                const socket = new WebSocket(`${protocol}//${location.host}/api/pi/ws`);
                this.socket = socket;
                this.status(this.manager.toolsEnabled ? translateUi('正在启动侧聊') : translateUi("正在启动无工具侧聊"));
                await new Promise((resolve, reject) => {
                    const handshake = setTimeout(() => {
                        if (socket.readyState === WebSocket.CONNECTING) { socket.close(); reject(new Error(translateUi("侧聊连接超时"))); }
                    }, 15000);
                    socket.addEventListener('open', async () => {
                        clearTimeout(handshake);
                        if (generation !== this.generation) { reject(Object.assign(new Error(translateUi("侧聊已结束")), { code: 'SIDE_CANCELLED' })); return; }
                        try {
                            const data = await this.request('open_side_chat', { token: this.host.context().token, ticket: prepared.ticket }, 90000);
                            if (generation !== this.generation) return reject(new Error(translateUi("侧聊已结束")));
                            this.connected = true; this.busy = Boolean(data.state?.isStreaming || data.state?.isCompacting);
                            this.limits = data.limits;
                            this.input.maxLength = data.limits.messageCharacters;
                            this.input.value = draft;
                            $('pi-side-model').textContent = data.state.model?.name || data.state.model?.id || translateUi("侧聊");
                            $('pi-side-model').title = `${data.state.model?.provider}/${data.state.model?.id}`;
                            this.setToolState(data.state);
                            this.showReference(data.reference); this.render(data.messages || []); this.updateUsage(data.stats);
                            this.status(translateUi("侧聊已就绪")); this.controls(); resolve();
                        } catch (error) { if (generation === this.generation) this.dropSocket(); reject(error); }
                    });
                    socket.addEventListener('message', event => { if (generation === this.generation) this.record(event.data); });
                    socket.addEventListener('close', () => {
                        clearTimeout(handshake);
                        reject(Object.assign(new Error(translateUi("侧聊已结束")), { code: generation === this.generation ? 'SIDE_DISCONNECTED' : 'SIDE_CANCELLED' }));
                        if (generation !== this.generation) return;
                        this.connected = false; this.busy = false; this.live = null;
                        this.confirmation = null; this.toolAccess = 'read'; this.renderConfirmation();
                        if (this.socket === socket) this.socket = null;
                        this.rejectRequests(new Error(translateUi("侧聊连接已断开")));
                        this.status(translateUi("连接已断开，临时侧聊已结束"), true); this.controls(); this.manager.reconcile(this); reject(new Error(translateUi("侧聊已结束")));
                    });
                    socket.addEventListener('error', () => { if (generation === this.generation) this.status(translateUi("侧聊连接失败"), true); });
                });
                return true;
            })();
            this.starting = promise; this.controls();
            try { return await promise; }
            finally { if (this.starting === promise) { this.starting = null; this.controls(); this.manager.reconcile(this); } }
        }
        showReference(reference) {
            this.reference = reference;
            const captured = new Date(reference.capturedAt).toLocaleTimeString(globalThis.PiI18n?.locale || 'zh-CN', { hour: '2-digit', minute: '2-digit' });
            $('pi-side-reference-label').textContent = `${reference.mode === 'context' ? translateUi("主上下文 · {0} 条", reference.messageCount) : reference.mode === 'quote' ? translateUi("所选文本") : reference.mode === 'blank' ? translateUi("空白背景") : translateUi("{0} 条正文{1}", reference.messageCount, reference.summaryIncluded ? translateUi(" + 摘要") : '')} · ${captured}`;
            const preview = $('pi-side-reference-preview'); preview.replaceChildren();
            const meta = document.createElement('small');
            const scope = reference.mode === 'context' ? translateUi("{0} 次工具调用 · {1} 条结果 · {2} 份摘要{3} · 创建时冻结", reference.toolCalls || 0, reference.toolResults || 0, reference.summaryCount || 0, reference.systemIncluded ? translateUi(" · 主会话指令") : '') : reference.mode === 'recent' ? translateUi("不含图片、思考与工具输出") : reference.mode === 'quote' ? translateUi("仅所选文本") : translateUi("无主会话背景");
            meta.textContent = translateUi("{0} · 约 {1} tokens{2} · {3}", reference.source?.name || translateUi("主会话"), tokenText(reference.estimatedTokens), reference.omittedMessages ? translateUi(" · {0} 条正文未引用", reference.omittedMessages) : '', scope);
            preview.appendChild(meta);
            if (reference.mode === 'context') {
                const note = document.createElement('p');
                note.textContent = translateUi(reference.toolMode === 'assist' ? '历史工具是只读背景；侧聊可读取当前文件，修改和命令需确认。{0}{1}' : "历史工具作为只读记录，侧聊无执行工具。{0}{1}", reference.omittedThinking ? translateUi("未复制 {0} 块思考及签名。", reference.omittedThinking) : '', reference.omittedImages ? translateUi("当前模型不支持图像，{0} 张图片仅保留占位说明。", reference.omittedImages) : reference.images ? translateUi("含 {0} 张图片。", reference.images) : '');
                preview.appendChild(note);
            }
            for (const item of reference.preview || []) { const p = document.createElement('p'); p.textContent = item.text; preview.appendChild(p); }
        }
        setToolState(state = {}) {
            this.toolMode = state.toolMode || 'none';
            this.toolAccess = state.toolAccess === 'write' ? 'write' : 'read';
            this.confirmation = (state.pendingUi || []).find(item => item.method === 'confirm') || null;
            this.renderConfirmation(); this.controls();
        }
        renderConfirmation() {
            const panel = $('pi-side-confirm');
            panel.replaceChildren(); panel.hidden = !this.confirmation;
            if (!this.confirmation) return;
            const request = this.confirmation;
            const title = document.createElement('strong'); title.textContent = translateUi(request.title);
            const scope = document.createElement('p');
            scope.textContent = translateUi('允许后，本次回复可编辑、写入和运行命令；结束后恢复询问。主侧共享目录，请避免同时修改相同文件。');
            const preview = document.createElement('pre'); preview.textContent = request.message || '';
            const actions = document.createElement('div'); actions.className = 'pi-side-confirm-actions';
            for (const [allowed, label] of [[false, '取消执行'], [true, '允许本次回复执行']]) {
                const button = document.createElement('button'); button.type = 'button'; button.textContent = translateUi(label);
                button.addEventListener('click', () => this.run(async () => {
                    if (this.manager.current !== this || this.confirmation?.id !== request.id) return;
                    const generation = this.generation;
                    for (const node of actions.children) node.disabled = true;
                    try {
                        await this.request('answer_side_confirmation', { requestId: request.id, confirmed: allowed });
                        if (generation === this.generation && this.confirmation?.id === request.id) { this.confirmation = null; this.renderConfirmation(); }
                    } finally { if (generation === this.generation) for (const node of actions.children) node.disabled = false; }
                }));
                actions.appendChild(button);
            }
            panel.append(title, scope, preview, actions);
        }
        request(type, payload = {}, timeout = 45000) {
            if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error(translateUi("侧聊未连接")));
            const id = `side-${++this.nextId}`;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => { this.requests.delete(id); reject(Object.assign(new Error(translateUi("侧聊请求超时，结果不确定")), { code: 'RPC_TIMEOUT' })); }, timeout);
                this.requests.set(id, { resolve, reject, timer });
                this.socket.send(JSON.stringify({ id, type, ...payload }));
            });
        }
        rejectRequests(error) { for (const pending of this.requests.values()) { clearTimeout(pending.timer); pending.reject(error); } this.requests.clear(); }
        dropSocket() {
            const socket = this.socket;
            this.generation++; this.socket = null; this.connected = false; this.busy = false; this.submitting = false;
            this.rejectRequests(Object.assign(new Error(translateUi("侧聊已结束")), { code: 'SIDE_CANCELLED' }));
            this.confirmation = null; this.renderConfirmation(); this.toolAccess = 'read';
            socket?.close(1000, 'Side chat ended');
            this.controls();
        }
        async shutdownSocket() {
            try { if (this.connected) await this.request('quit_side_chat', {}, 10000); } catch {}
            this.dropSocket();
        }
        async end() {
            if ((this.busy || this.messages.length || this.input.value || this.quotes.length) && !window.confirm(translateUi("结束并清空这段临时侧聊？主会话不受影响。"))) return false;
            this.starting = null;
            await this.shutdownSocket();
            this.render([]); this.input.value = ''; this.quotes = []; this.renderQuotes(); this.live = null; this.uncertain = false; this.toolEvents.clear();
            this.reference = null; this.referenceValue = this.defaultSource(); this.source.value = this.referenceValue;
            $('pi-side-reference-label').textContent = translateUi("尚未引用上下文"); $('pi-side-reference-preview').replaceChildren();
            $('pi-side-model').textContent = translateUi("临时侧聊"); $('pi-side-model').title = ''; $('pi-side-usage').textContent = '';
            this.status(translateUi("侧聊已结束")); this.controls(); this.manager.reconcile(this);
            return true;
        }
        async send() {
            if (this.manager.current !== this || this.destroyed) return false;
            if (!this.connected || this.busy || this.submitting || this.starting) return false;
            const draft = this.input.value, quotes = this.quotes;
            const message = quotes.map(window.PiQuotes.serialize).join('') + draft.trim(); if (!message.trim()) return false;
            if (message.length > this.limits.messageCharacters) { this.status(translateUi('引用与问题超过侧聊长度限制，请减少选中文字'), true); return false; }
            if (/^\//.test(message)) { this.status(translateUi("侧聊不执行斜杠命令，请用普通文字提问"), true); return false; }
            if (this.parentKey !== this.identity()) { this.status(translateUi("主会话已切换，请开始新的侧聊"), true); return false; }
            const confirmUncertain = this.uncertain && window.confirm(translateUi("上次发送结果不确定，请先核对侧聊记录。确认仍要发送？"));
            if (this.uncertain && !confirmUncertain) return false;
            const generation = this.generation;
            this.submitting = true; this.status(translateUi("正在提交侧聊问题")); this.controls();
            try {
                await this.request('prompt', { message, ...(confirmUncertain ? { confirmUncertain: true } : {}) }, 65000);
                if (generation !== this.generation) return false;
                if (this.input.value === draft && this.quotes === quotes) { this.input.value = ''; this.quotes = []; this.renderQuotes(); }
                this.uncertain = false;
                return true;
            } catch (error) {
                if (generation === this.generation) {
                    this.uncertain = !['RPC_REJECTED', 'SESSION_BUSY'].includes(error.code);
                    this.status(error.message, true); void this.synchronize();
                }
                return false;
            } finally { if (generation === this.generation) { this.submitting = false; this.controls(); } }
        }
        record(raw) {
            let event; try { event = JSON.parse(raw); } catch { return; }
            const pending = this.requests.get(event.id);
            if (event.type === 'response' && pending) {
                this.requests.delete(event.id); clearTimeout(pending.timer);
                if (event.success) pending.resolve(event.data);
                else pending.reject(Object.assign(new Error(event.error || translateUi("侧聊请求失败")), { code: event.errorCode || 'RPC_REJECTED' }));
                return;
            }
            if (event.type === 'gateway_side_tool_access') {
                this.revision++; this.toolAccess = event.access === 'write' ? 'write' : 'read'; this.controls(); return;
            }
            if (event.type === 'extension_ui_request' && event.method === 'confirm' && this.toolMode === 'assist') {
                this.revision++; this.confirmation = event; this.renderConfirmation();
                this.status(translateUi('侧聊等待执行确认')); this.controls(); return;
            }
            if (event.type === 'gateway_ui_resolved' && this.confirmation?.id === event.id) {
                this.revision++; this.confirmation = null; this.renderConfirmation();
                if (this.busy) this.status(translateUi('侧聊回复中'));
                this.controls(); return;
            }
            if (['tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(event.type)) {
                this.toolEvents.set(event.toolCallId, event);
                if (!this.toolFrame) this.toolFrame = requestAnimationFrame(() => {
                    this.toolFrame = null;
                    if (!this.destroyed && this.root.isConnected) this.render(this.messages, this.live);
                });
            }
            if (event.type === 'gateway_side_parent_ended' && event.reason === 'deleted') {
                this.manager.forget(this.key); return;
            }
            if (['agent_start', 'agent_settled', 'compaction_start', 'compaction_end', 'auto_retry_start', 'auto_retry_end'].includes(event.type)) this.revision++;
            if (event.type === 'agent_start') { this.busy = true; this.status(translateUi("侧聊回复中")); }
            if (event.type === 'message_start' && event.message?.role === 'assistant') {
                this.live = { ...event.message, content: [] }; this.liveBlocks = new Map(); this.render(this.messages, this.live);
            }
            if (event.type === 'message_update' && this.live) {
                const delta = event.assistantMessageEvent;
                if (delta?.type === 'text_delta') {
                    this.liveBlocks.set(delta.contentIndex, (this.liveBlocks.get(delta.contentIndex) || '') + delta.delta);
                    this.live.content = [...this.liveBlocks.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => ({ type: 'text', text }));
                    this.scheduleRender();
                }
            }
            if (event.type === 'message_end' && ['user', 'assistant', 'toolResult'].includes(event.message?.role)) {
                if (!this.messages.some(item => item.role === event.message.role && (event.message.role !== 'toolResult' || item.toolCallId === event.message.toolCallId) && item.timestamp === event.message.timestamp && textOf(item) === textOf(event.message))) this.messages.push(event.message);
                if (event.message.role === 'assistant') this.live = null;
                if (event.message.role === 'toolResult') this.toolEvents.delete(event.message.toolCallId);
                this.render(this.messages, this.live);
            }
            if (event.type === 'agent_settled') {
                this.toolAccess = 'read'; this.confirmation = null; this.renderConfirmation();
                this.busy = false;
                const last = this.messages.filter(message => message.role === 'assistant').at(-1);
                this.status(last?.stopReason === 'aborted' ? translateUi("侧聊回复已停止") : last?.errorMessage || last?.stopReason === 'error' ? translateUi("侧聊回复失败") : translateUi("侧聊已完成"), Boolean(last?.errorMessage || last?.stopReason === 'error'));
                void this.synchronize();
            }
            if (event.type === 'compaction_start') { this.busy = true; this.status(translateUi("侧聊上下文压缩中")); }
            if (event.type === 'compaction_end') { this.status(event.errorMessage || translateUi("侧聊上下文已更新"), Boolean(event.errorMessage)); void this.synchronize(); }
            if (event.type === 'auto_retry_start') this.status(translateUi("侧聊重试中 · {0}", event.attempt));
            if (event.type === 'gateway_error') this.status(translateUi("侧聊 runtime 已停止"), true);
            this.controls();
        }
        scheduleRender() {
            if (this.frame) return;
            this.frame = requestAnimationFrame(() => {
                this.frame = null;
                if (!this.live || !this.liveNode?.isConnected) return;
                this.liveNode.querySelector('.pi-markdown').innerHTML = this.host.renderMarkdown(textOf(this.live));
                this.scroll.update();
            });
        }
        renderTool(call, result) {
            const event = this.toolEvents.get(call.id), output = result || event?.result || event?.partialResult;
            const details = document.createElement('details'); details.className = 'pi-side-tool'; details.dataset.detailKey = call.id;
            const label = document.createElement('summary');
            const status = result || event?.type === 'tool_execution_end' ? (result?.isError || event?.isError ? '工具失败' : '工具完成') : '工具执行中';
            label.textContent = `${call.name} · ${translateUi(status)}`;
            const params = document.createElement('pre'); params.textContent = JSON.stringify(call.arguments || event?.args || {}, null, 2);
            details.append(label, params);
            if (output) {
                const pre = document.createElement('pre'); pre.textContent = textOf(output) || translateUi('工具返回了非文本内容'); details.appendChild(pre);
            }
            return details;
        }
        render(messages, live = null) {
            this.messages = messages;
            const position = this.scroll.capture();
            this.content.replaceChildren(); this.liveNode = null;
            const sequence = [...messages, ...(live ? [live] : [])];
            const finalReplies = this.host.finalReplyIndices(sequence, this.busy);
            for (const [index, message] of sequence.entries()) {
                if (!['user', 'assistant', 'toolResult', 'compactionSummary'].includes(message.role)) continue;
                if (message.role === 'toolResult') {
                    const paired = sequence.some(item => Array.isArray(item.content) && item.content.some(block => block.type === 'toolCall' && block.id === message.toolCallId));
                    if (!paired) this.content.appendChild(this.renderTool({ id: message.toolCallId, name: message.toolName }, message));
                    continue;
                }
                const text = message.role === 'compactionSummary' ? message.summary : textOf(message);
                const article = document.createElement('article'); article.className = `pi-message ${message.role}`;
                article.dataset.messageKey = JSON.stringify(['side', message.role, message.timestamp]);
                const header = document.createElement('header'); const strong = document.createElement('strong');
                strong.textContent = message.role === 'user' ? translateUi("你") : message.role === 'compactionSummary' ? translateUi("侧聊摘要") : translateUi("Pi · 侧聊"); header.appendChild(strong); article.appendChild(header);
                const body = document.createElement('div'); body.className = 'pi-message-body'; body.dataset.readingKey = article.dataset.messageKey;
                const markdown = document.createElement('div'); markdown.className = 'pi-markdown';
                if (message.role === 'assistant') markdown.innerHTML = text ? this.host.renderMarkdown(text) : `<p class="pi-side-empty">${translateUi("思考中")}</p>`;
                else window.PiQuotes.renderUser(markdown, text);
                body.appendChild(markdown);
                if (message.errorMessage || ['error', 'aborted'].includes(message.stopReason)) {
                    const error = document.createElement('p'); error.className = 'pi-inline-error'; error.textContent = message.errorMessage || translateUi("回复已停止"); body.appendChild(error);
                }
                const toolCalls = Array.isArray(message.content) ? message.content.filter(block => block.type === 'toolCall') : [];
                if (message.role === 'assistant' && toolCalls.length && !text) markdown.replaceChildren();
                for (const call of toolCalls) body.appendChild(this.renderTool(call, sequence.find(item => item.role === 'toolResult' && item.toolCallId === call.id)));
                article.appendChild(body);
                if (message.role === 'assistant' && text && finalReplies.has(index)) {
                    const footer = document.createElement('footer'); footer.className = 'pi-message-actions';
                    for (const [action, title, icon] of [['copy', translateUi("复制侧聊回复"), 'fa-regular fa-copy'], ['insert', translateUi("放入主输入框"), 'fa-solid fa-arrow-left']]) {
                        const button = document.createElement('button'); button.type = 'button'; button.className = 'pi-message-action';
                        button.dataset.sideAction = action; button.title = title; button.setAttribute('aria-label', title); button.innerHTML = `<i class="${icon}" aria-hidden="true"></i>`; button._sideText = text; footer.appendChild(button);
                    }
                    article.appendChild(footer);
                }
                this.content.appendChild(article);
                if (message === live) this.liveNode = article;
            }
            if (!this.content.children.length) { const empty = document.createElement('p'); empty.className = 'pi-side-empty'; empty.textContent = translateUi("暂无侧聊消息"); this.content.appendChild(empty); }
            this.scroll.restore(position);
        }
        async synchronize() {
            if (!this.connected) return;
            const generation = this.generation, revision = this.revision;
            try {
                const [state, data, stats] = await Promise.all([this.request('get_state'), this.request('get_messages'), this.request('get_session_stats')]);
                if (generation !== this.generation || revision !== this.revision) return;
                this.busy = Boolean(state.isStreaming || state.isCompacting); this.uncertain ||= Boolean(state.uncertain);
                if (!this.busy) { this.live = null; this.render(data.messages || []); }
                this.setToolState(state);
                this.updateUsage(stats); this.controls();
            } catch {}
        }
        hasState() { return Boolean(this.socket || this.starting || this.messages.length || this.input.value || this.quotes.length); }
        destroy() {
            this.destroyed = true;
            this.starting = null;
            this.dropSocket();
            this.scroll.resizeObserver.disconnect(); this.scroll.mutationObserver.disconnect();
            if (this.scroll.frame !== null) cancelAnimationFrame(this.scroll.frame);
            if (this.frame) cancelAnimationFrame(this.frame);
            if (this.toolFrame) cancelAnimationFrame(this.toolFrame);
            this.root.remove();
        }
        updateUsage(stats = {}) {
            const usage = stats.contextUsage;
            $('pi-side-usage').textContent = translateUi("侧聊上下文 {0} / {1}{2}", tokenText(usage?.tokens), tokenText(usage?.contextWindow), typeof stats.cost === 'number' ? ` · $${stats.cost.toFixed(4)}` : '');
        }
    }
    return new SideThread(host);
    }

    class PiSideChat {
        constructor(host) {
            this.host = host;
            this.enabled = false;
            this.retention = false;
            this.entries = new Map();
            this.maxEntries = 3;
            const root = $('pi-side-chat');
            this.template = root.cloneNode(true);
            this.anchor = document.createComment('side-chat-panel'); root.before(this.anchor);
            this.current = this.create(host.context(), root);
            $('pi-toggle-side-chat').addEventListener('click', () => this.run(() => this.open()));
            $('pi-side-tab').addEventListener('click', () => this.run(() => this.open()));
            $('pi-details-tab').addEventListener('click', () => this.showPane('details'));
            $('pi-inspector-tabs').addEventListener('keydown', event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || event.target.getAttribute('role') !== 'tab') return;
                event.preventDefault();
                const tabs = [...$('pi-inspector-tabs').querySelectorAll('[role="tab"]')].filter(tab => !tab.hidden);
                const index = tabs.indexOf(event.target);
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
                tabs[next].click(); tabs[next].focus();
            });
        }
        key(ctx = this.host.context()) { return JSON.stringify([ctx.cwd, ctx.session?.id]); }
        create(ctx, root = this.template.cloneNode(true)) {
            const saved = { ...ctx, session: ctx.session && { ...ctx.session } }, key = this.key(ctx);
            let entry;
            const isCurrent = () => this.current === entry && this.key() === key;
            const guard = action => (...args) => {
                if (this.retention && !isCurrent()) throw new Error(translateUi("侧聊属于其他线程，请先返回原线程"));
                return action(...args);
            };
            entry = createThread({ ...this.host,
                context: () => !this.retention || isCurrent() ? this.host.context() : { ...saved, connected: false },
                prepare: guard(options => this.host.prepare({ ...options, ...(this.toolsEnabled ? { toolMode: 'assist' } : {}), ...(entry.retainOnSwitch ? { retainOnSwitch: true } : {}) })),
                insertDraft: guard(text => this.host.insertDraft(text)), focusMain: guard(() => this.host.focusMain()),
                toast: (...args) => { if (!this.retention || isCurrent()) this.host.toast(...args); }
            }, root, this);
            entry.key = key; entry.ephemeral = Boolean(ctx.session?.ephemeral);
            entry.retainOnSwitch = this.retention && !entry.ephemeral && Boolean(ctx.session?.id);
            entry.setEnabled(this.enabled, this.fullContext);
            return entry;
        }
        reserve(entry) {
            if (entry.destroyed || this.current !== entry) throw new Error(translateUi("请先返回这段侧聊所属的线程"));
            if (!entry.retainOnSwitch) return;
            if (!this.entries.has(entry.key) && this.entries.size >= this.maxEntries) throw new Error(translateUi("本页最多保留 3 段侧聊，请回到原线程结束一段后再开始；已有侧聊不会被清除"));
            this.entries.set(entry.key, entry);
        }
        reconcile(entry) {
            if (!entry.hasState()) {
                if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
                if (this.current !== entry && !entry.destroyed) entry.destroy();
            }
        }
        sync() {
            const ctx = this.host.context(), key = this.key(ctx);
            if (!this.retention || this.current?.key === key) return;
            const old = this.current;
            if (old) {
                const reading = old.scroll.capture();
                old.panelTop = old.root.scrollTop;
                old.root.remove(); old.scroll.restore(reading);
                if (old.retainOnSwitch && old.hasState()) this.entries.set(old.key, old);
                else { this.entries.delete(old.key); old.destroy(); }
            }
            const entry = this.entries.get(key) || this.create(ctx);
            this.current = entry;
            if (entry.live) entry.render(entry.messages, entry.live);
            this.anchor.after(entry.root);
            entry.root.hidden = !$('pi-inspector').classList.contains('show-side');
            entry.scroll.update();
            requestAnimationFrame(() => { if (this.current === entry) entry.root.scrollTop = entry.panelTop || 0; });
            if (entry.connected) void entry.synchronize();
        }
        setEnabled(enabled, fullContext = false, retention = false, toolsEnabled = false) {
            this.toolsEnabled = toolsEnabled;
            this.enabled = enabled; this.fullContext = fullContext;
            // Capability changes are only applied before an entry has a running conversation.
            if (retention !== this.retention && !this.current.hasState() && !this.entries.size) {
                this.retention = retention;
                const old = this.current;
                this.current = this.create(this.host.context());
                old.destroy(); this.anchor.after(this.current.root);
            }
            this.updateParent();
        }
        updateParent() {
            this.sync();
            $('pi-toggle-side-chat').hidden = !this.enabled;
            $('pi-side-tab').hidden = !this.enabled;
            $('pi-toggle-side-chat').disabled = !this.host.context().connected;
            if (!this.current.hasState()) { this.current.toolMode = this.toolsEnabled ? 'assist' : 'none'; this.current.toolAccess = 'read'; }
            this.current.setEnabled(this.enabled, this.fullContext);
        }
        async run(action) {
            this.sync();
            const entry = this.current;
            try { return await action(); }
            catch (error) {
                if (error.code === 'SIDE_CANCELLED') return false;
                if (!entry.destroyed) entry.status(error.message, true);
                if (this.current === entry) this.host.toast(error.message, 'error');
                return false;
            }
        }
        open(options) { this.sync(); return this.current.open(options); }
        showPane(mode) {
            this.sync();
            const side = mode === 'side';
            $('pi-inspector-details').hidden = mode !== 'details';
            this.current.root.hidden = !side;
            $('pi-changes').hidden = mode !== 'changes';
            $('pi-history').hidden = mode !== 'history';
            for (const [id, selected] of [['pi-details-tab', mode === 'details'], ['pi-side-tab', side], ['pi-changes-tab', mode === 'changes'], ['pi-history-tab', mode === 'history']]) {
                $(id).setAttribute('aria-selected', String(selected)); $(id).tabIndex = selected ? 0 : -1;
            }
            const panel = $('pi-inspector');
            panel.classList.toggle('show-side', side); panel.classList.toggle('show-history', mode === 'history'); panel.classList.toggle('show-changes', mode === 'changes'); panel.classList.add('open');
            if (innerWidth <= 900) $('pi-session-pane').classList.remove('open');
            this.current.scroll.update();
        }
        parentDisconnected() {
            const entry = this.current;
            if (entry?.connected || entry?.starting) {
                entry.starting = null; entry.dropSocket(); entry.status(translateUi("主连接已断开，侧聊已结束；记录仍可复制"), true);
                this.reconcile(entry);
            }
        }
        forget(key) {
            const entry = this.entries.get(key) || (this.current?.key === key ? this.current : null);
            this.entries.delete(key);
            if (!entry) return;
            if (this.current === entry) {
                this.current = this.create(this.host.context());
                this.current.root.hidden = !$('pi-inspector').classList.contains('show-side');
                this.anchor.after(this.current.root);
            }
            entry.destroy();
        }
        disposeAll() {
            const entries = new Set([...this.entries.values(), this.current]);
            this.entries.clear();
            for (const entry of entries) entry?.destroy();
            this.current = this.create(this.host.context()); this.anchor.after(this.current.root);
            this.current.root.hidden = !$('pi-inspector').classList.contains('show-side');
        }
    }
    window.PiSideChat = PiSideChat;
})();
