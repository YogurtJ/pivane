(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const node = (tag, text, className) => {
        const el = document.createElement(tag); if (text !== undefined) el.textContent = text;
        if (className) el.className = className; return el;
    };
    const labels = { starting: translateUi("正在准备"), running: translateUi("执行中"), stopping: translateUi("正在停止"), uncertain: translateUi("结果不确定"), completed: translateUi("完成"), failed: translateUi("失败"), cancelled: translateUi("已停止"), rejected: translateUi("未执行") };
    class PiShell {
        constructor(options) {
            this.options = options; this.value = null; this.modes = null; this.epoch = 0; this.modePending = false;
            this.messages = []; this.card = null;
            this.hint = document.getElementById('pi-shell-hint');
            this.modeArea = document.getElementById('pi-queue-modes');
            this.modeStatus = document.getElementById('pi-queue-mode-status');
            this.selects = ['steeringMode', 'followUpMode'].map(key => {
                const select = document.getElementById(`pi-${key}`);
                select.addEventListener('change', () => this.setMode(key, select.value)); return select;
            });
        }
        static parse(text) {
            if (!text.startsWith('!') || text.startsWith('![')) return null;
            const excluded = text.startsWith('!!');
            return { command: text.slice(excluded ? 2 : 1).trim(), excludeFromContext: excluded };
        }
        get busy() { return Boolean(this.value?.busy); }
        reset() {
            this.epoch++; this.value = null; this.modes = null; this.modePending = false; this.messages = [];
            this.card?.remove(); this.card = null; this.hint.hidden = true; this.modeArea.hidden = true; this.modeStatus.textContent = '';
        }
        apply(value) {
            if (!value || this.value?.runtimeId === value.runtimeId && this.value.revision >= value.revision) return;
            const previous = this.value;
            this.value = value;
            this.mount(); this.sync();
            if (previous?.busy !== value.busy || previous?.job?.status !== value.job?.status) this.options.changed();
        }
        applyModes(modes) {
            if (!modes || this.modes?.runtimeId === modes.runtimeId && this.modes.revision > modes.revision) return;
            this.modes = modes; this.sync();
        }
        sync() {
            const ctx = this.options.context();
            const input = PiShell.parse(ctx.text);
            const pending = ctx.streaming ? 0 : this.pendingCount();
            this.hint.hidden = !input && !pending;
            this.hint.textContent = input ? translateUi("{0} · {1} · 默认在服务器当前项目执行", ctx.enabled ? 'Shell' : translateUi("当前后端尚未启用 Shell"), input.excludeFromContext ? translateUi("输出不加入模型上下文，仍保留原生记录") : translateUi("输出加入模型上下文，不自动发起回答")) : translateUi("{0} 条 Shell 记录可供下次提问使用，不会自动发起回答", pending);
            this.modeArea.hidden = !ctx.queueModes || !this.modes;
            this.selects.forEach((select, index) => {
                select.value = this.modes?.[index ? 'followUpMode' : 'steeringMode'] || '';
                select.disabled = !ctx.connected || ctx.blocked || this.busy || this.modePending;
            });
            if (this.card) {
                const stop = this.card.querySelector('button');
                stop.disabled = !ctx.connected || this.value?.job?.status !== 'running';
            }
        }
        pendingCount() {
            const lastPrompt = this.messages.findLastIndex(message => message.role === 'user');
            return this.messages.slice(lastPrompt + 1).filter(message => message.role === 'bashExecution' && !message.excludeFromContext).length;
        }
        setMessages(messages) { this.messages = messages; this.mount(); this.sync(); }
        mount() {
            const job = this.value?.job;
            const represented = job?.recorded && this.messages.some(message => message.role === 'bashExecution' && message.command === job.command && message.timestamp >= job.startedAt && Boolean(message.excludeFromContext) === job.excludeFromContext);
            if (!job || represented && !this.busy) { this.card?.remove(); this.card = null; return; }
            const container = this.options.transcript;
            if (!this.card || this.card.dataset.executionId !== job.id) {
                this.card?.remove(); this.card = node('article', undefined, 'pi-shell-live'); this.card.dataset.executionId = job.id;
                this.card.dataset.messageKey = `shell:${job.id}`;
                const header = node('header');
                header.append(node('strong', translateUi("手动执行 Shell")), node('span', '', 'pi-shell-state'));
                const stop = node('button', translateUi("停止命令")); stop.type = 'button'; stop.addEventListener('click', () => this.abort()); header.append(stop);
                this.card.append(header, node('code', job.command, 'pi-shell-command'), node('p', '', 'pi-shell-detail'), node('pre', '', 'pi-shell-output'));
                this.card.querySelector('pre').tabIndex = 0;
            }
            if (!container.contains(this.card)) {
                container.querySelector('.pi-empty-state')?.remove(); container.append(this.card);
            }
            this.card.dataset.state = job.status;
            this.card.querySelector('.pi-shell-state').textContent = `${labels[job.status] || job.status}${job.finishedAt ? translateUi(" · {0} 秒", ((job.finishedAt - job.startedAt) / 1000).toFixed(1)) : ''}${Number.isInteger(job.exitCode) ? ` · exit ${job.exitCode}` : ''}`;
            this.card.querySelector('.pi-shell-detail').textContent = [job.excludeFromContext ? translateUi("不加入模型上下文") : translateUi("完成后供后续提问使用"), job.displayTruncated ? translateUi("显示最近部分输出") : '', job.truncated ? translateUi("原生结果已截断") : '', job.error || ''].filter(Boolean).join(' · ');
            const output = this.card.querySelector('pre');
            const following = output.scrollTop + output.clientHeight >= output.scrollHeight - 8;
            output.textContent = job.output || (this.busy ? translateUi("等待输出…") : translateUi("无输出"));
            if (following) output.scrollTop = output.scrollHeight;
            this.card.querySelector('button').hidden = !this.busy;
            this.options.scroll();
        }
        async abort() {
            if (!this.options.context().connected || this.value?.job?.status !== 'running') return;
            const epoch = this.epoch, executionId = this.value.job.id;
            try { const value = await this.options.request('abort_bash', { executionId }); if (epoch === this.epoch) this.apply(value); }
            catch (error) { if (epoch === this.epoch) { this.options.toast(translateUi("{0}；请核对命令状态，未自动重试", error.message), 'error'); this.options.reconcile(); } }
        }
        async setMode(key, mode) {
            const epoch = this.epoch;
            if (this.modePending || !this.modes) return;
            this.modePending = true; this.modeStatus.textContent = translateUi("正在保存投递设置…"); this.sync();
            try {
                const value = await this.options.request(key === 'steeringMode' ? 'set_steering_mode' : 'set_follow_up_mode', { mode, runtimeId: this.modes.runtimeId, revision: this.modes.revision });
                if (epoch !== this.epoch) return;
                this.applyModes(value); this.modeStatus.textContent = translateUi("当前运行实例已更新，并交由 Pi 保存全局默认");
            } catch (error) {
                if (epoch !== this.epoch) return;
                this.modeStatus.textContent = translateUi("{0}；请核对设置，未自动重试", error.message);
                this.options.reconcile();
            } finally { if (epoch === this.epoch) { this.modePending = false; this.sync(); } }
        }
        static history(message) {
            const el = node('details', undefined, `pi-bash-message${!message.cancelled && message.exitCode ? ' error' : ''}`);
            const summary = node('summary');
            summary.append(node('span', translateUi("手动 Shell")), node('code', message.command || ''), node('span', message.cancelled ? translateUi("已停止") : `exit ${message.exitCode ?? '--'}`));
            const flags = node('p', `${message.excludeFromContext ? translateUi("不加入模型上下文 · 原生记录保留") : translateUi("可加入模型上下文")}${message.truncated ? translateUi(" · 原生输出已截断") : ''}`, 'pi-shell-detail');
            const output = node('pre', message.output || translateUi("无输出")); output.tabIndex = 0;
            el.append(summary, flags, output);
            if (message.fullOutputPath) el.append(node('p', translateUi("原生完整输出路径：{0}", message.fullOutputPath), 'pi-shell-detail'));
            return el;
        }
    }
    window.PiShell = PiShell;
})();
