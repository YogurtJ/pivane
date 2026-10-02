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
            this.history = [];
            this.limits = { messageCharacters: 8000 };
            this.phase = 'draft';
            this.toolEvents = new Map();
            this.toolMode = manager.toolsEnabled ? 'assist' : 'none';
            this.toolAccess = 'read';
            this.input = $('pi-side-input');
            this.quotes = [];
            this.quoteHost = document.createElement('div'); this.quoteHost.className = 'pi-side-quotes';
            $('pi-side-form').before(this.quoteHost);
            this.content = $('pi-side-messages');
            this.source = $('pi-side-source');
            this.scroll = new window.PiTranscriptScroll({ viewport: $('pi-side-transcript'), content: $('pi-side-content'),
                track: $('pi-side-track'), thumb: $('pi-side-thumb'), latest: $('pi-side-latest') });
            $('pi-side-reference').addEventListener('toggle', () => this.scroll.update());
            $('pi-side-refresh').querySelector('span').textContent = translateUi('更新背景并新开');
            $('pi-side-refresh').addEventListener('click', () => this.run(() => this.newSegment({ mode: this.fullContext ? 'context' : 'recent', count: 6 })));
            $('pi-side-new').textContent = translateUi('新开侧聊');
            $('pi-side-new').addEventListener('click', () => this.run(() => this.newSegment()));
            this.source.addEventListener('change', () => this.run(async () => {
                if (!await this.newSegment(this.options())) this.source.value = this.referenceValue || this.defaultSource();
            }));
            $('pi-side-end').addEventListener('click', () => this.run(() => this.end()));
            $('pi-side-stop').addEventListener('click', () => this.run(async () => { await this.request('abort', {}, 65000); await this.synchronize(); }));
            $('pi-side-parent-state').addEventListener('click', () => this.host.focusMain());
            $('pi-side-form').addEventListener('submit', event => { event.preventDefault(); void this.send(); });
            this.input.addEventListener('input', () => this.controls());
            this.input.addEventListener('keydown', event => {
                if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void this.send(); }
            });
            $('pi-side-transcript').addEventListener('click', event => {
                const button = event.target.closest('[data-side-action]');
                if (!button) return;
                this.run(async () => {
                    if (button.dataset.sideAction === 'copy') {
                        await host.copyText(button._sideText);
                        button.innerHTML = '<i class="fa-solid fa-check"></i>';
                        setTimeout(() => { button.innerHTML = '<i class="fa-regular fa-copy"></i>'; }, 1200);
                    }
                });
            });
            $('pi-side-model-controls').hidden = !manager.modelsEnabled;
            $('pi-side-model-select').setAttribute('aria-label', translateUi('侧聊模型'));
            this.input.placeholder = translateUi('想问些什么？');
            $('pi-side-reference-label').textContent = translateUi('背景与模型');
            $('pi-side-info').title = translateUi('关于侧聊');
            $('pi-side-info').setAttribute('aria-label', translateUi('关于侧聊'));
            $('pi-side-info-title').textContent = translateUi('关于侧聊');
            $('pi-side-info-close').title = translateUi('关闭说明');
            $('pi-side-info-close').setAttribute('aria-label', translateUi('关闭说明'));
            for (const text of [
                '独立讨论，不打断主对话；可以参考主对话，也可以单独聊。',
                '新开侧聊不会继承此前讨论，需要的内容请自行复制。',
                '闲置 12 小时后结束运行。记录仅留在当前页面，刷新或关页后不保留。',
                '修改文件或运行命令前，需要你确认。主侧共享文件，请避免同时修改同一处。'
            ]) { const item = document.createElement('li'); item.textContent = translateUi(text); $('pi-side-info-points').append(item); }
            $('pi-side-info').addEventListener('click', () => this.toggleInfo());
            $('pi-side-info-close').addEventListener('click', () => this.toggleInfo(false, true));
            root.addEventListener('keydown', event => {
                if (event.key === 'Escape' && !$('pi-side-info-panel').hidden) {
                    event.preventDefault(); event.stopPropagation(); this.toggleInfo(false, true);
                }
            });
            this.pickerId = `pi-side-model-dialog-${manager.nextPickerId++}`;
            $('pi-side-thinking-select').addEventListener('change', () => this.run(() => this.changeModel(true)));
            this.speedSelect = document.createElement('select'); this.speedSelect.className = 'pi-side-speed-select'; this.speedSelect.hidden = true;
            this.speedSelect.setAttribute('aria-label', translateUi('速度')); $('pi-side-model-controls').append(this.speedSelect);
            this.speedSelect.addEventListener('change', () => this.run(() => this.changeSpeed()));
            this.render([]);
        }

        identity() { const ctx = this.host.context(); return JSON.stringify([ctx.cwd, ctx.session?.id]); }
        async run(action) { try { return await action(); } catch (error) { if (error.code === 'SIDE_CANCELLED') return false; this.status(error.message, true); this.host.toast(error.message, 'error'); return false; } }
        defaultSource() { return this.fullContext ? 'context' : 'recent-6'; }
        setEnabled(enabled, fullContext = false) {
            this.enabled = enabled; this.fullContext = fullContext;
            $('pi-side-model-controls').hidden = !this.manager.modelsEnabled;
            this.source.querySelector('[value="context"]').hidden = !fullContext;
            for (const value of ['recent-6', 'recent-12']) this.source.querySelector(`[value="${value}"]`).hidden = fullContext;
            if (!this.connected && !this.starting) this.source.value = this.referenceValue || this.defaultSource();
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
            const locked = Boolean(this.busy || this.starting || this.submitting || this.configuring || this.confirmation || this.transitioning);
            $('pi-side-refresh').disabled = !ready || locked;
            $('pi-side-new').disabled = !ready || locked;
            this.source.disabled = !ready || locked;
            $('pi-side-tool-mode').textContent = this.toolMode !== 'assist' ? translateUi('无工具') : this.confirmation ? translateUi('等待确认') : this.toolAccess === 'write' ? translateUi('本次可修改') : translateUi('可读取');
            $('pi-side-end').disabled = !this.hasState() || Boolean(this.transitioning);
            this.input.disabled = !ready || Boolean(this.starting || this.transitioning);
            $('pi-side-send').hidden = this.busy;
            $('pi-side-stop').hidden = !this.busy;
            $('pi-side-stop').disabled = !this.connected;
            $('pi-side-send').disabled = !ready || locked || this.phase === 'expired' || this.phase === 'ended' || (!this.input.value.trim() && !this.quotes.length);
            const modelDisabled = !ready || locked || !this.catalog?.length;
            if (this.modelPicker) this.modelPicker.setDisabled(modelDisabled);
            else $('pi-side-model-select').disabled = true;
            $('pi-side-thinking-select').disabled = !ready || locked || !$('pi-side-thinking-select').options.length;
            this.speedSelect.disabled = !this.connected || !ready || locked || !this.modelState?.speed?.levels?.length;
            if (this.configuring) { this.input.disabled = true; $('pi-side-send').disabled = true; }
            this.manager.host.changed?.();
        }
        showModel(state) {
            this.modelState = state;
            $('pi-side-model').textContent = state.model?.name || state.model?.id || translateUi('侧聊');
            $('pi-side-model').title = `${state.model?.provider}/${state.model?.id}`;
            this.modelPicker?.update(this.catalog || [], state.model, $('pi-side-model-select').disabled);
            $('pi-side-thinking-select').value = state.thinkingLevel || 'off';
            const speed = state.speed, levels = speed?.levels || [];
            this.speedSelect.hidden = levels.length === 0;
            const labels = { auto: translateUi('跟随供应商'), standard: translateUi('标准 Standard'), fast: 'Fast', ultrafast: 'Ultrafast' };
            this.speedSelect.replaceChildren(...levels.map(level => new Option(`${translateUi('速度')} · ${labels[level]}${speed.modes[level] ? ` · ${translateUi('费用 {0}×', speed.modes[level].costMultiplier)}` : ''}`, level)));
            this.speedSelect.value = speed?.level || 'auto';
        }
        async loadModels() {
            if (!this.manager.modelsEnabled) return;
            if (!this.connected && (!this.manager.lifecycleEnabled || !this.host.context().connected)) return;
            const generation = this.generation;
            const data = this.connected ? await this.request('get_side_models') : await this.host.modelOptions();
            if (generation !== this.generation) return;
            this.catalog = data.models;
            this.modelPicker ||= new window.PiModelPicker({ button: $('pi-side-model-select'), id: this.pickerId,
                onSelect: model => this.run(() => this.changeModel(false, model)) });
            if (!this.connected) {
                if (!this.modelState || !this.modelOverride && this.phase === 'draft') this.modelState = { model: data.model, thinkingLevel: data.thinkingLevel || 'off' };
                const chosen = data.models.find(m => m.provider === this.modelState.model?.provider && m.id === this.modelState.model?.id);
                this.showLevels(chosen?.levels || ['off']);
            } else this.showLevels(data.levels);
            if (this.modelState) this.showModel(this.modelState);
            this.controls();
        }
        showLevels(levels) {
            $('pi-side-thinking-select').replaceChildren(...levels.map(level => { const option = document.createElement('option'); option.value = level; option.textContent = `Thinking · ${level}`; return option; }));
        }
        async changeSpeed() {
            if (!this.connected || this.configuring || this.busy || this.confirmation || this.starting || this.destroyed) return;
            const speed = this.modelState?.speed, generation = this.generation; if (!speed) return;
            const level = this.speedSelect.value; this.configuring = true; this.controls();
            try {
                const data = await this.request('set_side_speed', { runtimeId: speed.runtimeId, revision: speed.revision, provider: speed.provider, modelId: speed.modelId, level });
                if (generation === this.generation) this.showModel(data.state);
            } finally { if (generation === this.generation) { this.configuring = false; await this.synchronize(); this.controls(); } }
        }
        async changeModel(thinking, selection = this.modelState?.model) {
            if (this.manager.current !== this || this.destroyed || this.busy || this.confirmation || this.configuring || this.submitting || this.starting) return;
            if (!this.connected) {
                const { provider, id } = selection || {};
                const model = this.catalog?.find(m => m.provider === provider && m.id === id);
                if (!model) return;
                const level = $('pi-side-thinking-select').value;
                if (!thinking) this.showLevels(model.levels || ['off']);
                this.modelState = { model, thinkingLevel: (model.levels || ['off']).includes(level) ? level : (model.levels || ['off'])[0] };
                this.modelOverride = true; this.showModel(this.modelState); this.controls(); return;
            }
            const generation = this.generation;
            const { provider, id: modelId } = selection || {};
            this.configuring = true; this.controls();
            try {
                const data = await this.request(thinking ? 'set_side_thinking' : 'set_side_model', thinking ? { thinkingLevel: $('pi-side-thinking-select').value } : { provider, modelId });
                if (generation !== this.generation) return;
                this.modelOverride = true;
                this.limits = data.limits; this.input.maxLength = data.limits.messageCharacters;
                this.showLevels(data.levels); this.showModel(data.state);
                this.status(translateUi('侧聊模型设置已更新，记录保持不变'));
            } finally {
                if (generation === this.generation) { this.configuring = false; await this.synchronize(); this.controls(); }
            }
        }
        toggleInfo(open = $('pi-side-info-panel').hidden, restoreFocus = false) {
            $('pi-side-info-panel').hidden = !open;
            $('pi-side-info').setAttribute('aria-expanded', String(open));
            if (restoreFocus) $('pi-side-info').focus();
            this.scroll.update();
        }
        status(text, error = false) {
            const quiet = ['', '侧聊已就绪', '侧聊已完成', '侧聊已结束', '侧聊模型设置已更新，记录保持不变', '新侧聊已准备，发送时才创建运行实例'].some(value => text === translateUi(value));
            $('pi-side-status').textContent = text;
            $('pi-side-status').dataset.error = String(error);
            $('pi-side-status').hidden = quiet && !error;
        }
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
            if (!this.manager.lifecycleEnabled && !this.connected && !await this.startRuntime()) return false;
            if (this.manager.lifecycleEnabled && !this.connected) void this.run(() => this.loadModels());
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
        updateSessionNote() {
            const visible = ['expired', 'ended'].includes(this.phase);
            $('pi-side-session-note').hidden = !visible;
            $('pi-side-session-title').textContent = translateUi(this.phase === 'expired' ? '这段侧聊已过期' : '这段侧聊已结束');
            $('pi-side-session-description').textContent = translateUi('记录和草稿仅保留在本页。新开后不会继承旧讨论；需要的内容请自行复制。');
        }
        async newSegment(options = this.options()) {
            if (this.busy || this.confirmation || this.starting || this.submitting || this.configuring || this.transitioning) return false;
            const hasRecord = this.messages.length > 0;
            if (hasRecord && this.history.length >= 20) throw new Error(translateUi('本线程已保留 20 段侧聊，请先复制所需内容并清空侧聊；已有记录不会自动删除。'));
            if ((this.connected && hasRecord || !this.manager.lifecycleEnabled && this.input.value.trim()) && !window.confirm(translateUi('将结束当前侧聊，下次发送使用新的背景。旧记录仍可查看，但不会传给新 Agent。继续？'))) return false;
            const generation = this.generation;
            this.transitioning = true; this.controls();
            try {
                if (this.connected && this.manager.lifecycleEnabled) {
                    const final = await this.request('close_side_segment');
                    if (generation !== this.generation) return false;
                    this.render(final.messages || this.messages); this.showModel(final.state); this.updateUsage(final.stats);
                    this.modelOverride = true; this.dropSocket();
                } else {
                    if (this.connected) await this.synchronize();
                    if (generation !== this.generation) return false;
                    if (this.connected && this.modelState) this.modelOverride = true;
                    await this.shutdownSocket();
                }
                if (this.destroyed) return false;
                if (this.messages.length) {
                    if (this.modelState?.model) this.modelOverride = true;
                    const details = document.createElement('details'); details.className = 'pi-side-archive';
                    const summary = document.createElement('summary');
                    const title = document.createElement('strong'); title.textContent = translateUi('侧聊 {0}', this.history.length + 1);
                    const meta = document.createElement('span'); meta.textContent = `${new Date(this.segmentStarted || this.reference?.capturedAt || Date.now()).toLocaleTimeString(globalThis.PiI18n?.locale, { hour: '2-digit', minute: '2-digit' })} · ${translateUi(this.phase === 'expired' ? '已过期' : '已结束')} · ${this.modelState?.model?.name || this.modelState?.model?.id || ''}`;
                    summary.append(title, meta); details.append(summary);
                    const body = document.createElement('div'); body.className = 'pi-side-archive-body';
                    const note = document.createElement('p'); note.className = 'pi-side-archive-note';
                    note.textContent = translateUi('历史讨论，仅供你查看。未传给新侧聊；背景捕获于 {0}。', this.reference?.capturedAt ? new Date(this.reference.capturedAt).toLocaleString(globalThis.PiI18n?.locale) : '--');
                    body.append(note, ...this.content.childNodes); details.append(body);
                    if (!this.history.length) {
                        const heading = document.createElement('p'); heading.className = 'pi-side-history-title'; heading.textContent = translateUi('此前侧聊 · 仅本页可见');
                        $('pi-side-history').append(heading);
                    }
                    this.history.push(details); $('pi-side-history').append(details); $('pi-side-history').hidden = false;
                }
                this.phase = 'draft'; this.live = null; this.uncertain = false; this.toolEvents.clear();
                this.reference = null; this.referenceValue = options.mode === 'context' ? 'context' : options.mode === 'blank' ? 'blank' : `recent-${options.count || 6}`;
                this.source.value = this.referenceValue;
                $('pi-side-reference-label').textContent = translateUi('背景与模型'); $('pi-side-reference-preview').replaceChildren();
                $('pi-side-usage').textContent = ''; this.render([]); this.updateSessionNote();
                this.status(translateUi('新侧聊已准备，发送时才创建运行实例')); this.input.focus();
                if (!this.manager.lifecycleEnabled) return this.startRuntime(options);
                return true;
            } catch (error) {
                if (error.code === 'RPC_TIMEOUT') {
                    this.phase = 'ended'; this.dropSocket(); this.updateSessionNote();
                }
                throw error;
            } finally { this.transitioning = false; this.controls(); this.manager.reconcile(this); }
        }
        async startRuntime(options = this.options()) {
            this.manager.reserve(this);
            if (this.starting) return this.starting;
            const key = this.identity(), draft = this.input.value;
            const promise = (async () => {
                await this.shutdownSocket();
                if (key !== this.identity() || !this.host.context().connected) return false;
                const generation = ++this.generation;
                this.parentKey = key; this.uncertain = false; this.live = null;
                this.render([]); this.scroll.reset();
                this.status(translateUi("正在准备只读引用"));
                const prepared = await this.host.prepare({ ...options, ...(this.manager.lifecycleEnabled && this.modelOverride && this.modelState?.model ? { model: { provider: this.modelState.model.provider, id: this.modelState.model.id }, thinkingLevel: this.modelState.thinkingLevel || 'off' } : {}) });
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
                            this.phase = 'active'; this.segmentStarted = Date.now(); this.updateSessionNote();
                            this.connected = true; this.busy = Boolean(data.state?.isStreaming || data.state?.isCompacting);
                            this.limits = data.limits;
                            this.input.maxLength = data.limits.messageCharacters;
                            this.input.value = draft;
                            $('pi-side-model').textContent = data.state.model?.name || data.state.model?.id || translateUi("侧聊");
                            $('pi-side-model').title = `${data.state.model?.provider}/${data.state.model?.id}`;
                            this.showModel(data.state); void this.run(() => this.loadModels());
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
                        if (this.transitioning) { this.connected = false; this.controls(); return; }
                        if (this.phase !== 'expired') { this.phase = 'ended'; this.status(translateUi('连接已断开，记录仍可复制；请新开侧聊'), true); }
                        this.updateSessionNote(); this.controls(); this.manager.reconcile(this); reject(new Error(translateUi("侧聊已结束")));
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
            $('pi-side-reference-label').textContent = `${reference.mode === 'context' ? translateUi("主上下文 · {0} 条", reference.messageCount || 0) : reference.mode === 'quote' ? translateUi("所选文本") : reference.mode === 'blank' ? translateUi("空白背景") : translateUi("{0} 条正文{1}", reference.messageCount, reference.summaryIncluded ? translateUi(" + 摘要") : '')} · ${captured}`;
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
            const sameRequest = panel.dataset.requestId === this.confirmation?.id;
            const detailsOpen = sameRequest && panel.querySelector('details')?.open;
            const scrollTop = sameRequest ? panel.querySelector('.pi-side-confirm-body')?.scrollTop || 0 : 0;
            panel.dataset.requestId = this.confirmation?.id || '';
            panel.replaceChildren(); panel.hidden = !this.confirmation;
            if (!this.confirmation) { this.confirmationAnswer = null; return; }
            const request = this.confirmation;
            const node = (tag, className, text) => {
                const element = document.createElement(tag); element.className = className;
                if (text !== undefined) element.textContent = text;
                return element;
            };
            let operation;
            try {
                const value = JSON.parse(request.message || '');
                if (value && !Array.isArray(value) && typeof value.tool === 'string' && value.tool.length <= 128
                    && value.arguments && typeof value.arguments === 'object' && !Array.isArray(value.arguments)) operation = value;
            } catch { /* Older/unstructured confirmations retain their exact text preview. */ }
            const deciding = this.confirmationAnswer?.id === request.id && this.confirmationAnswer.generation === this.generation;
            panel.setAttribute('aria-busy', String(Boolean(deciding)));
            const header = node('header', 'pi-side-confirm-header');
            const shield = node('span', 'pi-side-confirm-icon'); shield.setAttribute('aria-hidden', 'true');
            shield.append(node('i', 'fa-solid fa-shield-halved'));
            const heading = node('div', 'pi-side-confirm-heading');
            const title = node('strong', '', translateUi('允许侧聊执行操作？')); title.id = 'pi-side-confirm-title';
            title.title = translateUi(request.title);
            heading.append(title, node('span', 'pi-side-confirm-badge', translateUi('仅本次回复')));
            header.append(shield, heading);
            const body = node('div', 'pi-side-confirm-body');
            body.append(node('p', 'pi-side-confirm-scope', translateUi('允许后，本次回复可修改文件和运行命令；结束后重新询问。')));
            const preview = (label, text) => {
                const section = node('div', 'pi-side-confirm-preview');
                const code = node('pre', '', text); code.tabIndex = 0; code.setAttribute('aria-label', translateUi(label));
                section.append(node('span', 'pi-side-confirm-caption', translateUi(label)), code);
                body.append(section);
            };
            if (operation) {
                const captions = { bash: '运行命令', powershell: '运行命令', edit: '编辑文件', write: '写入文件' };
                const action = node('div', 'pi-side-confirm-operation');
                action.append(node('span', '', translateUi(captions[operation.tool] || '待执行操作')), node('code', 'pi-side-confirm-tool', operation.tool));
                body.append(action);
                for (const [label, text] of [['工作目录', operation.cwd], ['文件', operation.arguments.path]]) {
                    if (typeof text !== 'string' || !text) continue;
                    const row = node('div', 'pi-side-confirm-location');
                    row.append(node('span', '', translateUi(label)), node('code', '', text)); body.append(row);
                }
                const args = operation.arguments;
                if (['bash', 'powershell'].includes(operation.tool) && typeof args.command === 'string') preview('命令', args.command);
                else if (operation.tool === 'write' && typeof args.content === 'string') preview('写入内容', args.content);
                else if (operation.tool === 'edit' && typeof args.oldText === 'string' && typeof args.newText === 'string') {
                    preview('替换前', args.oldText); preview('替换后', args.newText);
                } else if (operation.tool === 'edit' && Array.isArray(args.edits)) preview('修改内容', JSON.stringify(args.edits, null, 2));
                const details = node('details', 'pi-side-confirm-details'); details.open = Boolean(detailsOpen);
                const parameters = node('pre', '', request.message || ''); parameters.tabIndex = 0; parameters.setAttribute('aria-label', translateUi('查看完整参数'));
                details.append(node('summary', '', translateUi('查看完整参数')), parameters);
                body.append(details);
            } else preview('待执行操作', request.message || '');
            const footer = node('div', 'pi-side-confirm-footer');
            footer.append(node('p', 'pi-side-confirm-note', translateUi('主侧共享文件，请避免同时修改同一处。')));
            const actions = node('div', 'pi-side-confirm-actions');
            for (const [allowed, label] of [[false, '取消执行'], [true, '允许本次回复执行']]) {
                const button = node('button', allowed ? 'pi-side-confirm-allow' : 'pi-side-confirm-deny'); button.type = 'button';
                button.dataset.sideConfirmed = String(allowed); button.disabled = Boolean(deciding);
                const pending = deciding && this.confirmationAnswer.allowed === allowed;
                if (pending) { const spinner = node('i', 'fa-solid fa-spinner fa-spin'); spinner.setAttribute('aria-hidden', 'true'); button.append(spinner); }
                button.append(node('span', '', translateUi(pending ? '正在提交确认…' : label)));
                button.addEventListener('click', () => this.run(async () => {
                    if (this.manager.current !== this || this.confirmation?.id !== request.id
                        || this.confirmationAnswer?.id === request.id && this.confirmationAnswer.generation === this.generation) return;
                    const generation = this.generation;
                    const answer = { id: request.id, generation, allowed };
                    this.confirmationAnswer = answer; this.renderConfirmation();
                    try {
                        await this.request('answer_side_confirmation', { requestId: request.id, confirmed: allowed });
                        if (generation === this.generation && this.confirmation?.id === request.id) { this.confirmation = null; this.renderConfirmation(); }
                    } finally {
                        if (this.confirmationAnswer === answer) {
                            this.confirmationAnswer = null;
                            if (generation === this.generation) this.renderConfirmation();
                        }
                    }
                }));
                actions.append(button);
            }
            footer.append(actions); panel.append(header, body, footer); body.scrollTop = scrollTop;
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
            this.generation++; this.socket = null; this.connected = false; this.busy = false; this.submitting = false; this.configuring = false;
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
            if (this.hasState() && !window.confirm(translateUi('结束并清空当前主线程的全部侧聊、草稿和此前记录？主会话与其他线程不受影响。'))) return false;
            this.starting = null;
            await this.shutdownSocket();
            this.history = []; $('pi-side-history').replaceChildren(); $('pi-side-history').hidden = true;
            this.phase = 'draft'; this.modelState = null; this.modelOverride = false; this.updateSessionNote();
            this.render([]); this.input.value = ''; this.quotes = []; this.renderQuotes(); this.live = null; this.uncertain = false; this.toolEvents.clear();
            this.reference = null; this.referenceValue = this.defaultSource(); this.source.value = this.referenceValue;
            $('pi-side-reference-label').textContent = translateUi('背景与模型'); $('pi-side-reference-preview').replaceChildren();
            $('pi-side-model').textContent = translateUi("临时侧聊"); $('pi-side-model').title = ''; $('pi-side-usage').textContent = '';
            this.status(translateUi("侧聊已结束")); this.controls(); this.manager.reconcile(this);
            return true;
        }
        async send() {
            if (this.manager.current !== this || this.destroyed) return false;
            if (this.busy || this.submitting || this.starting || this.configuring || this.transitioning || ['expired', 'ended'].includes(this.phase)) return false;
            if (!this.input.value.trim() && !this.quotes.length) return false;
            if (!this.connected) {
                try { if (!await this.startRuntime()) return false; } catch (error) { this.status(error.message, true); this.controls(); return false; }
                if (this.destroyed || this.manager.current !== this) return false;
            }
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
            if (event.type === 'gateway_side_expired') {
                this.revision++; this.phase = 'expired'; this.busy = false; this.live = null;
                this.confirmation = null; this.toolAccess = 'read'; this.renderConfirmation();
                this.render(event.messages || this.messages); this.updateUsage(event.stats); this.dropSocket();
                this.status(translateUi('闲置 12 小时，运行资源已释放')); this.updateSessionNote(); this.controls(); return;
            }
            if (event.type === 'gateway_model_speed') {
                this.showModel({ ...this.modelState, speed: event.speed }); this.controls(); return;
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
                    for (const [action, title, icon] of [['copy', translateUi("复制侧聊回复"), 'fa-regular fa-copy']]) {
                        const button = document.createElement('button'); button.type = 'button'; button.className = 'pi-message-action';
                        button.dataset.sideAction = action; button.title = title; button.setAttribute('aria-label', title); button.innerHTML = `<i class="${icon}" aria-hidden="true"></i>`; button._sideText = text; footer.appendChild(button);
                    }
                    article.appendChild(footer);
                }
                this.content.appendChild(article);
                if (message === live) this.liveNode = article;
            }
            if (!this.content.children.length) { const empty = document.createElement('p'); empty.className = 'pi-side-empty'; empty.textContent = translateUi('在这里聊，不打断主对话。'); this.content.appendChild(empty); }
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
                this.showModel(state); this.setToolState(state);
                this.updateUsage(stats); this.controls();
            } catch {}
        }
        hasState() { return Boolean(this.socket || this.starting || this.messages.length || this.history.length || this.input.value || this.quotes.length); }
        destroy() {
            this.destroyed = true;
            this.starting = null;
            this.dropSocket();
            this.history = []; this.messages = []; this.quotes = []; this.toolEvents.clear(); this.input.value = '';
            this.scroll.resizeObserver.disconnect(); this.scroll.mutationObserver.disconnect();
            if (this.scroll.frame !== null) cancelAnimationFrame(this.scroll.frame);
            if (this.frame) cancelAnimationFrame(this.frame);
            if (this.toolFrame) cancelAnimationFrame(this.toolFrame);
            this.modelPicker?.dispose(); this.root.remove();
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
            this.nextPickerId = 1;
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
        activity() {
            const entry = this.current;
            // Retained work from another thread must never decorate this thread.
            if (!entry || entry.destroyed || (entry.retainOnSwitch ? entry.key : entry.parentKey) !== this.key()) return {};
            return { busy: entry.connected && (entry.busy || entry.submitting), waiting: entry.connected && Boolean(entry.confirmation),
                starting: Boolean(entry.starting), uncertain: Boolean(entry.uncertain) };
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
                modelOptions: guard(() => this.host.modelOptions()), focusMain: guard(() => this.host.focusMain()),
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
            const liveCount = [...this.entries.values()].filter(item => item !== entry && (item.socket || item.starting)).length;
            if (liveCount >= this.maxEntries) throw new Error(translateUi('本页最多同时运行 3 段侧聊，请先结束其他线程的侧聊；历史记录不会自动删除。'));
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
                old.modelPicker?.close(); old.root.remove(); old.scroll.restore(reading);
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
        setEnabled(enabled, fullContext = false, retention = false, toolsEnabled = false, modelsEnabled = false, lifecycleEnabled = false) {
            this.lifecycleEnabled = lifecycleEnabled;
            this.modelsEnabled = modelsEnabled;
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
                entry.phase = 'ended'; entry.updateSessionNote();
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
