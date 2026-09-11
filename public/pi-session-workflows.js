(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const $ = id => document.getElementById(id);
    const attachments = window.PiAttachments;
    const statusText = { scheduled: translateUi("等待发送"), waiting: translateUi("等待会话空闲"), paused: translateUi("已暂停"), expired: translateUi("已过期，待确认"), failed: translateUi("投递失败"), uncertain: translateUi("投递结果待确认"), dispatching: translateUi("投递中"), sent: translateUi("已投递"), cancelled: translateUi("已取消") };
    const terminal = new Set(['sent', 'cancelled']);
    const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const date = value => new Date(value).toLocaleString(globalThis.PiI18n?.locale || 'zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const uuid = () => {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
        const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    };
    const icon = (action, glyph, title, disabled = false) => `<button type="button" class="icon-btn subtle" data-workflow-action="${action}" title="${title}" aria-label="${title}" ${disabled ? 'disabled' : ''}><i class="fa-solid ${glyph}" aria-hidden="true"></i></button>`;

    class PiSessionWorkflows {
        constructor(host) {
            this.host = host;
            this.enabled = false;
            this.key = '';
            this.snapshot = null;
            this.jobs = [];
            this.sequence = 0;
            this.historySequence = 0;
            this.dialog = $('pi-workflow-dialog');
            this.content = $('pi-workflow-content');
            this.submit = $('pi-workflow-submit');
            this.error = $('pi-workflow-error');
            this.inFlight = false;
            attachments.bindTransfers({ zone: this.content, input: this.content,
                onFiles: files => this.run(() => this.addFiles(files)), onError: message => this.host.toast(message, 'error') });
            $('pi-schedule-button').addEventListener('click', () => this.run(() => this.openSchedule()));
            $('pi-deferred-open').addEventListener('click', () => this.run(() => this.openList('deferred')));
            $('pi-workflow-close').addEventListener('click', () => this.close());
            $('pi-workflow-cancel').addEventListener('click', () => this.close());
            this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
            $('pi-workflow-form').addEventListener('submit', event => { event.preventDefault(); void this.confirm(); });
            this.content.addEventListener('click', event => {
                const button = event.target.closest('[data-workflow-action]');
                if (button) this.run(() => this.listAction(button));
            });
            $('pi-transcript-content').addEventListener('click', event => {
                const button = event.target.closest('[data-message-workflow]');
                if (!button) return;
                this.run(async () => {
                    const article = button.closest('article');
                    const key = this.identity();
                    const message = button.dataset.messageWorkflow === 'reply-fork' ? article._piAssistantMessage : article._piUserMessage;
                    await this.refresh(true);
                    if (key !== this.identity()) return;
                    if (button.dataset.messageWorkflow === 'reply-fork') {
                        const candidates = this.matchReplies(message);
                        if (candidates.length !== 1) throw new Error(translateUi("无法定位这条回复，请刷新后重试"));
                        return this.openReplyFork(candidates[0]);
                    }
                    const candidates = this.snapshot?.prompts.filter(item => item.timestamp === message.timestamp && item.text === this.messageText(message).slice(0, 180)) || [];
                    if (candidates.length !== 1) return this.openList('history');
                    await this.openPrompt(candidates[0].entryId, button.dataset.messageWorkflow);
                });
            });
        }

        context() { return this.host.getContext(); }
        identity(context = this.context()) { return JSON.stringify([context.cwd, context.session?.id]); }
        usable() { const ctx = this.context(); return this.enabled && ctx.connected && ctx.session && !ctx.session.ephemeral; }
        busy() { const ctx = this.context(); return ctx.busy || !this.usable(); }
        url(tail, ctx = this.context()) { return `/api/pi/sessions/${encodeURIComponent(ctx.session.id)}/${tail}`; }
        async get(tail, ctx = this.context()) { return this.host.apiFetch(`${this.url(tail, ctx)}${tail.includes('?') ? '&' : '?'}cwd=${encodeURIComponent(ctx.cwd)}`); }
        async post(tail, body, method = 'POST', ctx = this.target || this.context()) {
            return this.host.apiFetch(this.url(tail, ctx), { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, cwd: ctx.cwd }), signal: AbortSignal.timeout(150000) });
        }
        async run(action) { try { await action(); } catch (error) { this.host.toast(error.message, 'error'); } }
        setStoreError(error) { this.storeError = error || null; this.update(); }
        setEnabled(enabled) { this.enabled = enabled; this.update(); }
        update() {
            const key = this.identity();
            if (key !== this.key) {
                this.key = key; this.sequence++; this.historySequence++; this.snapshot = null; this.jobs = [];
                if (!this.inFlight) this.close();
            }
            $('pi-current-thread-menu').disabled = !this.context().session;
            $('pi-history-more').hidden = !this.enabled || !this.context().session || this.context().session.ephemeral;
            $('pi-history-more').disabled = !this.usable();
            $('pi-schedule-button').hidden = !this.enabled;
            $('pi-schedule-button').disabled = !this.usable() || this.context().draftBusy;
            const count = this.jobs.filter(job => !terminal.has(job.status)).length;
            $('pi-deferred-banner').hidden = !this.usable() || !count && !this.storeError;
            $('pi-deferred-count').textContent = this.storeError || translateUi("{0} 条待发送{1}", count, this.jobs.some(job => ['expired', 'paused', 'uncertain', 'failed'].includes(job.status)) ? translateUi(" · 需确认") : '');
            this.decorate();
        }

        async refresh(includeHistory = false) {
            if (!this.usable()) { this.update(); return; }
            const ctx = { ...this.context() }, key = this.identity(ctx), sequence = ++this.sequence;
            const historySequence = includeHistory ? ++this.historySequence : null;
            const requests = [this.get('deferred', ctx)];
            if (includeHistory) requests.push(this.get('workflow', ctx));
            const [deferred, snapshot] = await Promise.all(requests);
            if (key !== this.identity()) return;
            if (sequence === this.sequence) this.jobs = deferred.jobs || [];
            if (snapshot && historySequence === this.historySequence) this.snapshot = snapshot;
            this.update();
            if (this.dialog.open && this.mode === 'deferred' && !this.inFlight) this.renderList();
        }

        messageText(message) { return typeof message.content === 'string' ? message.content : (message.content || []).filter(block => block.type === 'text').map(block => block.text).join(''); }
        matchReplies(message) {
            if (!message) return [];
            const text = (typeof message.content === 'string' ? message.content : (message.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n')).trim();
            return this.snapshot?.replies?.filter(item => item.timestamp === message.timestamp && item.text === text.slice(0, 180)) || [];
        }
        updateMessageAction(container, action, title, glyph, visible) {
            let button = container.querySelector(`[data-message-workflow="${action}"]`);
            if (!visible) { button?.remove(); return; }
            if (!button) {
                button = document.createElement('button');
                button.className = 'pi-message-action';
                button.type = 'button'; button.dataset.messageWorkflow = action;
                button.title = title; button.setAttribute('aria-label', title);
                button.innerHTML = `<i class="fa-solid ${glyph}" aria-hidden="true"></i>`;
                container.appendChild(button);
            }
            button.disabled = this.busy();
        }
        decorate() {
            document.querySelectorAll('#pi-transcript-content article.user').forEach(article => {
                const message = article._piUserMessage;
                const actions = article.querySelector('.pi-user-actions');
                if (!message || !actions) return;
                const matches = this.snapshot?.prompts.filter(item => item.timestamp === message.timestamp && item.text === this.messageText(message).slice(0, 180)) || [];
                const canRetry = this.usable() && matches.length === 1 && matches[0].entryId === this.snapshot.lastUserId;
                this.updateMessageAction(actions, 'retry', translateUi("编辑并重试"), 'fa-pen', canRetry);
            });
            document.querySelectorAll('#pi-transcript-content article.assistant').forEach(article => {
                const actions = article.querySelector('.pi-message-actions');
                if (!actions) return;
                const canFork = this.usable() && this.matchReplies(article._piAssistantMessage).length === 1;
                this.updateMessageAction(actions, 'reply-fork', translateUi("从此回复后分叉"), 'fa-code-branch', canFork);
            });
        }

        openReplyFork(reply) {
            if (this.busy()) throw new Error(translateUi("请等待会话空闲后操作"));
            this.entryId = reply.entryId; this.expectedLeafId = this.snapshot.leafId;
            this.show('reply-fork', translateUi("从此回复后分叉"), translateUi("创建分叉"));
            this.content.innerHTML = `${this.warning(translateUi("新线程与原线程共享项目文件，不复制目录。"))}<pre class="pi-workflow-preview">${escape(reply.text)}</pre>`;
        }

        show(mode, title, command) {
            if (!this.usable()) throw new Error(translateUi("请先打开持久会话"));
            this.mode = mode;
            this.target = { ...this.context() };
            this.targetKey = this.identity();
            $('pi-workflow-title').textContent = title;
            this.error.hidden = true;
            this.content.replaceChildren();
            $('pi-workflow-actions').hidden = !command;
            this.submit.textContent = command || translateUi("确认");
            this.submit.disabled = false;
            if (!this.dialog.open) this.dialog.showModal();
        }
        close() {
            if (this.inFlight) return;
            this.dialog.close(); this.mode = null; this.editor = null; this.originalDraft = null;
        }
        assertTarget() {
            if (!this.usable() || this.targetKey !== this.identity()) throw new Error(translateUi("会话已切换，请重新打开操作面板"));
        }
        warning(text = translateUi("只改变会话上下文，不撤销项目文件或外部操作。")) { return `<p class="pi-workflow-warning"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>${text}</p>`; }
        editorFields(payload, timed) {
            this.editor = { images: structuredClone(payload.images || []), addedTexts: 0, reads: 0, queue: Promise.resolve() };
            this.content.innerHTML = `${this.mode === 'retry' ? this.warning() : ''}<label class="pi-workflow-field">${translateUi("消息")}<textarea id="pi-workflow-message" rows="7" maxlength="400000" required></textarea></label><div id="pi-workflow-images" class="pi-workflow-images"></div><div class="pi-workflow-file"><button id="pi-workflow-attach" type="button" class="icon-btn subtle" title="${translateUi("添加附件")}" aria-label="${translateUi("添加附件")}"><i class="fa-solid fa-paperclip"></i></button><input id="pi-workflow-files" type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,text/*,.md,.json,.js,.ts,.py,.sh,.csv" hidden></div>${timed ? `<div class="pi-workflow-time"><label class="pi-workflow-field">${translateUi("发送时间")}<select id="pi-workflow-time-mode"><option value="delay">${translateUi("延迟")}</option><option value="at">${translateUi("指定时间")}</option></select></label><label id="pi-workflow-delay-field" class="pi-workflow-field">${translateUi("分钟后")}<input id="pi-workflow-delay" type="number" value="10" min="1" max="527040" step="1"></label><label id="pi-workflow-at-field" class="pi-workflow-field" hidden>${translateUi("日期与时间")}<input id="pi-workflow-at" type="datetime-local"></label></div>` : ''}`;
            $('pi-workflow-message').value = payload.message;
            $('pi-workflow-files').accept = attachments.accept;
            const status = document.createElement('div'); status.id = 'pi-workflow-file-status'; status.className = 'pi-attachment-status'; status.setAttribute('role', 'status'); this.content.appendChild(status);
            $('pi-workflow-attach').addEventListener('click', () => $('pi-workflow-files').click());
            $('pi-workflow-files').addEventListener('change', event => this.run(() => this.addFiles(event.target.files)));
            if (timed) $('pi-workflow-time-mode').addEventListener('change', () => this.updateTime());
            this.renderImages();
            $('pi-workflow-message').focus();
        }
        updateTime() {
            const at = $('pi-workflow-time-mode').value === 'at';
            $('pi-workflow-delay-field').hidden = at;
            $('pi-workflow-at-field').hidden = !at;
            $('pi-workflow-at').required = at;
            $('pi-workflow-at').disabled = !at;
            $('pi-workflow-delay').disabled = at;
            if (at && !$('pi-workflow-at').value) this.setTime(Date.now() + 600000);
        }
        setTime(value) {
            const local = new Date(value - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
            $('pi-workflow-at').value = local;
        }
        renderImages() {
            $('pi-workflow-images').innerHTML = this.editor.images.map((image, index) => `<span><a href="data:${escape(image.mimeType)};base64,${escape(image.data)}" target="_blank" rel="noopener"><img alt="${translateUi("附件 {0}", index + 1)}" src="data:${escape(image.mimeType)};base64,${escape(image.data)}"></a><button type="button" data-remove-image="${index}" aria-label="${translateUi("移除附件 {0}", index + 1)}" title="${translateUi("移除附件")}"><i class="fa-solid fa-xmark"></i></button></span>`).join('');
            $('pi-workflow-images').querySelectorAll('[data-remove-image]').forEach(button => button.addEventListener('click', () => { this.editor.images.splice(Number(button.dataset.removeImage), 1); this.renderImages(); }));
            $('pi-workflow-message').required = !this.editor.images.length;
        }
        addFiles(fileList) {
            const editor = this.editor, files = [...fileList];
            if (!editor || this.inFlight) return;
            $('pi-workflow-files').value = '';
            editor.reads++; this.loadingFiles = editor; this.submit.disabled = true;
            $('pi-workflow-file-status').textContent = translateUi("正在读取附件…");
            editor.queue = editor.queue.then(async () => {
                const errors = [];
                for (const file of files) {
                    if (this.editor !== editor) return;
                    try {
                        if (editor.images.length + editor.addedTexts >= attachments.limits.files) throw new Error(translateUi("一次最多添加 8 个附件"));
                        if (attachments.classify(file).kind === 'image' && editor.images.length >= attachments.limits.images) throw new Error(translateUi("一次最多添加 6 张图片"));
                        const item = await attachments.read(file);
                        if (this.editor !== editor) return;
                        const message = $('pi-workflow-message').value + (item.kind === 'text' ? attachments.textBlock(item) : '');
                        const images = item.kind === 'image' ? [...editor.images, { type: 'image', mimeType: item.mimeType, data: item.data }] : editor.images;
                        attachments.validatePayload({ message, images });
                        editor.images = images;
                        if (item.kind === 'text') { $('pi-workflow-message').value = message; editor.addedTexts++; }
                        this.renderImages();
                    } catch (error) { if (this.editor === editor) errors.push(`${file.name}: ${error.message}`); }
                }
                if (errors.length) this.host.toast(attachments.errorSummary(errors), 'error', 6500);
            }).finally(() => {
                editor.reads--;
                if (this.editor === editor && !editor.reads) {
                    this.loadingFiles = null; this.submit.disabled = this.inFlight;
                    $('pi-workflow-file-status').textContent = '';
                }
            });
            return editor.queue;
        }
        async openSchedule(job) {
            const key = this.identity();
            if (job) {
                const data = await this.get('deferred?detail=true');
                job = data.jobs.find(item => item.id === job.id);
                if (!job?.payload || terminal.has(job.status) || job.status === 'dispatching') throw new Error(translateUi("消息状态已变化，请刷新"));
            }
            if (key !== this.identity()) return;
            const originalDraft = job ? null : this.host.getDraft();
            this.show(job ? 'schedule-edit' : 'schedule', job ? translateUi("修改延迟消息") : translateUi("延迟发送"), job ? translateUi("保存并预约") : translateUi("预约发送"));
            this.job = job;
            this.scheduleId = uuid();
            this.originalDraft = originalDraft;
            this.editorFields(job?.payload || this.originalDraft.payload, true);
            if (job) { $('pi-workflow-time-mode').value = 'at'; this.setTime(Math.max(job.dueAt, Date.now() + 60000)); }
            this.updateTime();
            if (job?.status === 'uncertain') this.content.insertAdjacentHTML('beforeend', `<label class="pi-workflow-check"><input id="pi-workflow-uncertain" type="checkbox" required>${translateUi("已检查会话，确认没有重复消息")}</label>`);
        }
        async openPrompt(entryId, mode) {
            if (this.busy()) throw new Error(translateUi("请等待会话空闲后操作"));
            const key = this.identity();
            const payload = await this.get(`prompt/${encodeURIComponent(entryId)}`);
            if (key !== this.identity()) return;
            this.entryId = entryId; this.expectedLeafId = payload.leafId;
            this.show(mode, mode === 'retry' ? translateUi("编辑并重试") : translateUi("从此处分叉"), mode === 'retry' ? translateUi("回退并发送") : translateUi("创建分叉"));
            if (mode === 'retry') this.editorFields(payload, false);
            else this.content.innerHTML = `${this.warning(translateUi("新线程与原线程共享项目文件，不复制目录。"))}<pre class="pi-workflow-preview">${escape(payload.message || translateUi("图片消息"))}</pre>`;
        }
        async openClone() {
            if (this.busy()) throw new Error(translateUi("请等待会话空闲后操作"));
            const key = this.identity();
            await this.refresh(true);
            if (key !== this.identity() || !this.snapshot) return;
            this.expectedLeafId = this.snapshot.leafId;
            this.show('clone', translateUi("复制为新线程"), translateUi("创建线程"));
            this.content.innerHTML = this.warning(translateUi("新线程与原线程共享项目文件，不复制目录。"));
        }
        async openList(mode) {
            const key = this.identity();
            await this.refresh(mode !== 'deferred');
            if (key !== this.identity()) return;
            this.show(mode, { history: translateUi("历史问题"), versions: translateUi("历史版本"), deferred: translateUi("待发送消息") }[mode]);
            this.renderList();
        }
        renderList() {
            const items = this.mode === 'history' ? [...(this.snapshot?.prompts || [])].reverse() : this.mode === 'versions' ? this.snapshot?.versions || [] : [...this.jobs].reverse();
            const focused = document.activeElement?.closest('[data-workflow-action]');
            const focusKey = focused ? [focused.closest('[data-item-id]')?.dataset.itemId, focused.dataset.workflowAction] : null;
            const scrollTop = this.content.scrollTop;
            this.content.innerHTML = items.length ? items.map(item => {
                let tools;
                if (this.mode === 'history') tools = icon('fork', 'fa-code-branch', translateUi("从此处分叉"), this.busy()) + (item.entryId === this.snapshot.lastUserId ? icon('retry', 'fa-pen', translateUi("编辑并重试"), this.busy()) : '');
                else if (this.mode === 'versions') tools = icon('restore', 'fa-rotate-left', translateUi("恢复此版本"), this.busy());
                else tools = terminal.has(item.status) || item.status === 'dispatching' ? '' : icon('edit', 'fa-pen', translateUi("修改消息和时间")) + icon('send', 'fa-paper-plane', translateUi("立即发送")) + (['scheduled', 'waiting'].includes(item.status) ? icon('pause', 'fa-pause', translateUi("暂停发送")) : '') + icon('cancel', 'fa-xmark', translateUi("取消发送"));
                return `<div class="pi-workflow-row" data-item-id="${escape(item.id || item.entryId)}"><div><strong>${escape(this.mode === 'deferred' ? statusText[item.status] : date(item.timestamp))}</strong><p>${escape(item.preview || item.text || (item.imageCount ? translateUi("{0} 张图片", item.imageCount) : ''))}</p>${this.mode === 'deferred' ? `<small>${escape(date(item.dueAt))}${item.imageCount ? translateUi(" · {0} 张图片", item.imageCount) : ''}</small>${item.reason ? `<small>${escape(item.reason)}</small>` : ''}` : ''}</div><div class="pi-workflow-row-actions">${tools}</div></div>`;
            }).join('') : `<p class="pi-workflow-empty">${translateUi("暂无记录")}</p>`;
            this.content.scrollTop = scrollTop;
            if (focusKey) [...this.content.querySelectorAll('[data-workflow-action]')].find(button => button.dataset.workflowAction === focusKey[1] && button.closest('[data-item-id]').dataset.itemId === focusKey[0])?.focus({ preventScroll: true });
        }
        async listAction(button) {
            if (this.inFlight) return;
            const id = button.closest('[data-item-id]').dataset.itemId, action = button.dataset.workflowAction;
            if (['fork', 'retry'].includes(action)) return this.openPrompt(id, action);
            if (action === 'restore') {
                this.entryId = id; this.expectedLeafId = this.snapshot.leafId;
                this.show('restore', translateUi("恢复历史版本"), translateUi("恢复"));
                this.content.innerHTML = this.warning(); return;
            }
            const job = this.jobs.find(item => item.id === id);
            if (action === 'edit') return this.openSchedule(job);
            if (['send', 'cancel'].includes(action)) {
                this.job = job;
                this.show(`job-${action}`, action === 'send' ? translateUi("立即发送") : translateUi("取消延迟消息"), action === 'send' ? translateUi("确认发送") : translateUi("确认取消"));
                this.content.innerHTML = `<pre class="pi-workflow-preview">${escape(job.preview || translateUi("图片消息"))}</pre>${job.status === 'uncertain' && action === 'send' ? `<label class="pi-workflow-check"><input id="pi-workflow-uncertain" type="checkbox" required>${translateUi("已检查会话，确认没有重复消息")}</label>` : ''}`;
                return;
            }
            await this.post(`deferred/${id}`, { action, revision: job.revision }, 'PATCH');
            await this.refresh();
        }
        async confirm() {
            if (this.inFlight || this.editor && this.loadingFiles === this.editor) return;
            this.inFlight = true; this.submit.disabled = true; this.error.hidden = true;
            const mode = this.mode;
            try {
                this.assertTarget();
                const confirmUncertain = $('pi-workflow-uncertain')?.checked;
                if (['schedule', 'schedule-edit', 'retry'].includes(mode)) {
                    const message = $('pi-workflow-message').value, images = this.editor.images;
                    attachments.validatePayload({ message, images });
                    if (/^\s*\//.test(message)) throw new Error(translateUi("此操作仅支持普通消息，不支持斜杠命令"));
                    if (images.length && !this.context().model?.input?.includes('image')) throw new Error(translateUi("当前模型不支持图片输入"));
                    if (mode === 'retry') await this.post('retry', { message, images, entryId: this.entryId, expectedLeafId: this.expectedLeafId });
                    else {
                        const dueAt = $('pi-workflow-time-mode').value === 'delay' ? Date.now() + Number($('pi-workflow-delay').value) * 60000 : new Date($('pi-workflow-at').value).getTime();
                        await this.post(mode === 'schedule' ? 'deferred' : `deferred/${this.job.id}`, { message, images, dueAt, id: this.scheduleId, action: 'save', revision: this.job?.revision, confirmUncertain }, mode === 'schedule' ? 'POST' : 'PATCH');
                        if (mode === 'schedule' && this.targetKey === this.identity()) this.host.consumeDraft(this.originalDraft);
                    }
                } else if (['clone', 'fork', 'reply-fork'].includes(mode)) {
                    const result = await this.post('fork', { entryId: mode === 'clone' ? undefined : this.entryId,
                        position: mode === 'reply-fork' ? 'at' : undefined, expectedLeafId: this.expectedLeafId });
                    if (this.targetKey === this.identity()) await this.host.openFork(result);
                } else if (mode === 'restore') await this.post('restore', { entryId: this.entryId, expectedLeafId: this.expectedLeafId });
                else if (mode.startsWith('job-')) await this.post(`deferred/${this.job.id}`, { action: mode.slice(4), revision: this.job.revision, confirmUncertain }, 'PATCH');
                this.inFlight = false; this.close();
                this.host.toast(mode === 'retry' ? translateUi("已回退并提交新问题") : mode === 'restore' ? translateUi("已恢复历史版本") : ['clone', 'fork', 'reply-fork'].includes(mode) ? translateUi("已创建新线程") : translateUi("延迟消息已更新"), 'success');
                await this.host.reconcile();
                await this.refresh(true);
            } catch (error) {
                this.error.textContent = error.name === 'TimeoutError' ? translateUi("请求超时，结果不确定，请先查看会话或待发送列表再操作") : error.message; this.error.hidden = false;
                if (mode === 'retry' || mode === 'restore') void this.host.reconcile();
            } finally { this.inFlight = false; this.submit.disabled = false; }
        }
    }
    window.PiSessionWorkflows = PiSessionWorkflows;
})();
