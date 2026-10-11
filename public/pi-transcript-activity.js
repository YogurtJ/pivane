(() => {
    // Live status at the end of the conversation: what Pi is doing before visible output arrives
    // (sending, waiting for the first token, thinking, running a tool, retrying, compacting) and the
    // result of the last context compaction. Presentation only: pi-chat owns the runtime state and
    // calls in on events; nothing here sends requests or infers that work has finished.
    const t = (text, ...values) => globalThis.PiI18n?.t ? globalThis.PiI18n.t(text, ...values)
        : String(text).replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`);
    const SLOW_MS = 30000;
    const REASONS = { manual: '手动压缩', overflow: '溢出恢复压缩', threshold: '自动压缩' };
    const QUIET = new Set(['text']);

    function elapsed(ms) {
        const seconds = Math.max(0, Math.floor(ms / 1000));
        return seconds < 60 ? t('{0} 秒', seconds) : t('{0} 分 {1} 秒', Math.floor(seconds / 60), seconds % 60);
    }

    function formatTokens(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return '';
        if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
        if (n >= 1000) return `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k`;
        return String(n);
    }

    function node(tag, className, text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    }

    class PiTranscriptActivity {
        constructor({ root, content, onChange, locateSummary }) {
            this.root = root;
            this.content = content;
            this.onChange = onChange || (() => {});
            this.locateSummary = locateSummary || (() => false);
            this.phase = null; // { kind, since, label?, compaction? }
            this.notice = null; // { tone, text, action? }
            this.noticeTimer = null;
            this.timer = null;
            this.root.replaceChildren();
            this.noticeNode = node('div', 'pi-activity-notice');
            this.noticeNode.hidden = true;
            this.liveNode = node('div', 'pi-activity-live');
            this.liveNode.hidden = true;
            this.liveNode.setAttribute('role', 'status');
            this.root.append(this.noticeNode, this.liveNode);
            this.root.hidden = true;
        }

        // Thread switch or disconnect: forget everything shown for the previous thread.
        reset() {
            this.phase = null;
            this.setNotice(null);
            this.render();
        }

        // Reconcile with authoritative runtime flags after snapshots, reconnects and settles.
        sync({ connected, streaming, compacting, compaction }) {
            if (!connected) { this.phase = null; this.render(); return; }
            if (compacting) {
                if (this.phase?.kind !== 'compacting') this.phase = { kind: 'compacting', since: Date.now() };
                this.phase.compaction = compaction || this.phase.compaction || { status: 'running' };
            } else if (streaming) {
                if (!this.phase || this.phase.kind === 'sending' || this.phase.kind === 'compacting') this.phase = { kind: 'waiting', since: Date.now() };
            } else if (this.phase?.kind !== 'sending') this.phase = null;
            this.render();
        }

        sending() {
            this.setNotice(null);
            this.phase = { kind: 'sending', since: Date.now() };
            this.render();
        }

        // The prompt was accepted. Input hooks may consume it without starting a run, so a
        // 'sending' state that never sees agent_start clears itself instead of spinning forever.
        accepted() {
            const phase = this.phase;
            if (phase?.kind !== 'sending') return;
            clearTimeout(this.acceptTimer);
            this.acceptTimer = setTimeout(() => { if (this.phase === phase) { this.phase = null; this.render(); } }, 5000);
        }

        // The prompt request failed or was rejected before the agent started.
        cancelSending() {
            if (this.phase?.kind === 'sending') { this.phase = null; this.render(); }
        }

        agentStart() {
            if (this.phase?.kind === 'compacting') return;
            this.phase = { kind: 'waiting', since: this.phase?.kind === 'sending' ? this.phase.since : Date.now() };
            this.render();
        }

        idle() {
            if (this.phase?.kind === 'compacting') return;
            this.phase = null;
            this.render();
        }

        // Streaming deltas: visible answer text needs no indicator; other output gets a precise label.
        output(type) {
            if (!this.phase || this.phase.kind === 'compacting') return;
            const kind = type?.startsWith('text') ? 'text' : type?.startsWith('thinking') ? 'thinking' : type?.startsWith('toolcall') ? 'toolcall' : null;
            if (!kind || this.phase.kind === kind) return;
            this.phase = { kind, since: Date.now() };
            this.render();
        }

        tool(label) {
            if (this.phase?.kind === 'compacting') return;
            this.phase = { kind: 'tool', since: Date.now(), label: label || '' };
            this.render();
        }

        // After a tool finishes the model reads its result before anything new streams.
        toolEnd() {
            if (this.phase?.kind !== 'tool') return;
            this.phase = { kind: 'waiting', since: Date.now(), afterTool: true };
            this.render();
        }

        retry(attempt, delayMs) {
            if (this.phase?.kind === 'compacting') return;
            this.phase = { kind: 'retry', since: Date.now(), attempt, until: Date.now() + Math.max(0, Number(delayMs) || 0) };
            this.render();
        }

        retryEnd() {
            if (this.phase?.kind !== 'retry') return;
            this.phase = { kind: 'waiting', since: Date.now() };
            this.render();
        }

        // Compaction lifecycle, including its final result for the reader at the bottom.
        compaction(compaction, { streaming = false } = {}) {
            const status = compaction?.status;
            if (status === 'running' || status === 'retrying') {
                if (this.phase?.kind !== 'compacting') this.phase = { kind: 'compacting', since: Date.now() };
                this.phase.compaction = compaction;
                this.setNotice(null);
                this.render();
                return;
            }
            if (this.phase?.kind === 'compacting') this.phase = streaming ? { kind: 'waiting', since: Date.now() } : null;
            const reason = t(REASONS[compaction?.reason] || REASONS.threshold);
            if (status === 'success') {
                const before = formatTokens(compaction.tokensBefore), after = formatTokens(compaction.estimatedTokensAfter);
                const sizes = before && after ? t('约 {0} → {1} tokens', before, after) : before ? t('压缩前约 {0} tokens', before) : '';
                this.setNotice({ tone: 'success', icon: 'fa-compress', title: t('上下文已压缩'), detail: [reason, sizes].filter(Boolean).join(' · '),
                    action: { label: t('查看摘要'), run: () => this.locateSummary() } });
            } else if (status === 'unchanged') this.setNotice({ tone: 'info', icon: 'fa-circle-info', title: t('无需压缩'), detail: t('暂无新增内容需要压缩'), timeout: 8000 });
            else if (status === 'cancelled') this.setNotice({ tone: 'info', icon: 'fa-circle-info', title: t('{0}已取消', reason), timeout: 8000 });
            else if (status === 'error') this.setNotice({ tone: 'error', icon: 'fa-circle-exclamation', title: t('{0}失败', reason), detail: compaction.errorMessage || t('未返回压缩结果') });
            this.render();
        }

        setNotice(notice) {
            clearTimeout(this.noticeTimer);
            this.notice = notice;
            if (notice?.timeout) this.noticeTimer = setTimeout(() => { if (this.notice === notice) { this.notice = null; this.render(); } }, notice.timeout);
        }

        render() {
            this.renderNotice();
            this.renderLive();
            const visible = !this.noticeNode.hidden || !this.liveNode.hidden;
            if (this.root.hidden === visible) this.root.hidden = !visible;
            this.content.classList.toggle('pi-activity-active', visible);
            clearInterval(this.timer);
            this.timer = !this.liveNode.hidden ? setInterval(() => this.tick(), 1000) : null;
            this.onChange();
        }

        renderNotice() {
            const notice = this.notice;
            this.noticeNode.hidden = !notice;
            if (!notice) { this.noticeNode.replaceChildren(); return; }
            this.noticeNode.dataset.tone = notice.tone;
            this.noticeNode.setAttribute('role', notice.tone === 'error' ? 'alert' : 'status');
            const icon = node('i', `fa-solid ${notice.icon}`); icon.setAttribute('aria-hidden', 'true');
            const copy = node('span', 'pi-activity-notice-copy');
            copy.append(node('strong', '', notice.title));
            if (notice.detail) copy.append(node('span', 'pi-activity-notice-detail', notice.detail));
            const children = [icon, copy];
            if (notice.action) {
                const button = node('button', 'pi-activity-notice-action', notice.action.label); button.type = 'button';
                button.addEventListener('click', () => notice.action.run());
                children.push(button);
            }
            const close = node('button', 'pi-activity-notice-close'); close.type = 'button';
            close.title = t('关闭'); close.setAttribute('aria-label', t('关闭'));
            close.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
            close.addEventListener('click', () => { this.setNotice(null); this.render(); });
            children.push(close);
            this.noticeNode.replaceChildren(...children);
        }

        renderLive() {
            const phase = this.phase;
            const visible = Boolean(phase) && !QUIET.has(phase.kind);
            this.liveNode.hidden = !visible;
            if (!visible) { this.liveNode.replaceChildren(); delete this.liveNode.dataset.phase; return; }
            this.liveNode.dataset.phase = phase.kind;
            if (phase.kind === 'compacting') return this.renderCompaction(phase);
            const mark = node('span', 'pi-activity-dots'); mark.setAttribute('aria-hidden', 'true');
            mark.append(node('i'), node('i'), node('i'));
            const label = node('span', 'pi-activity-label', this.label(phase));
            const time = node('span', 'pi-activity-time'); time.setAttribute('aria-hidden', 'true');
            const hint = node('span', 'pi-activity-hint'); hint.hidden = true;
            this.liveNode.replaceChildren(mark, label, time, hint);
            this.tick();
        }

        renderCompaction(phase) {
            const compaction = phase.compaction || {};
            const icon = node('span', 'pi-activity-compact-icon'); icon.setAttribute('aria-hidden', 'true');
            icon.innerHTML = '<i class="fa-solid fa-compress"></i>';
            const copy = node('span', 'pi-activity-compact-copy');
            const title = node('strong', '', compaction.status === 'retrying'
                ? t('压缩摘要将在 {0} 秒后重试（{1}/{2}）', Math.ceil((compaction.delayMs || 0) / 1000), compaction.attempt, compaction.maxAttempts)
                : t('正在压缩上下文'));
            const reason = t(REASONS[compaction.reason] || REASONS.threshold);
            const detail = node('span', 'pi-activity-compact-detail', compaction.reason === 'manual'
                ? t('{0}：正在把较早的对话整理成摘要，完成前暂不能发送新消息', reason)
                : t('{0}：上下文接近上限，正在把较早的对话整理成摘要，完成后自动继续', reason));
            copy.append(title, detail);
            const time = node('span', 'pi-activity-time'); time.setAttribute('aria-hidden', 'true');
            const bar = node('span', 'pi-activity-progress'); bar.setAttribute('aria-hidden', 'true');
            this.liveNode.replaceChildren(icon, copy, time, bar);
            this.tick();
        }

        label(phase) {
            if (phase.kind === 'sending') return t('正在发送…');
            if (phase.kind === 'thinking') return t('正在思考');
            if (phase.kind === 'toolcall') return t('正在准备工具调用');
            if (phase.kind === 'tool') return phase.label ? t('正在执行：{0}', phase.label) : t('正在执行工具');
            if (phase.kind === 'retry') return t('请求失败，等待第 {0} 次重试', phase.attempt || 1);
            return phase.afterTool ? t('正在根据结果继续') : t('正在等待模型响应');
        }

        tick() {
            const phase = this.phase;
            if (!phase || this.liveNode.hidden) return;
            const time = this.liveNode.querySelector('.pi-activity-time');
            const now = Date.now();
            if (phase.kind === 'retry') {
                const left = Math.max(0, Math.ceil((phase.until - now) / 1000));
                if (time) time.textContent = left ? t('{0} 秒后', left) : '';
                return;
            }
            const spent = now - phase.since;
            if (time) time.textContent = spent >= 2000 ? elapsed(spent) : '';
            const hint = this.liveNode.querySelector('.pi-activity-hint');
            if (hint) {
                const slow = ['waiting', 'sending'].includes(phase.kind) && spent >= SLOW_MS;
                hint.hidden = !slow;
                if (slow) hint.textContent = t('响应较慢，可继续等待或停止');
            }
        }
    }

    window.PiTranscriptActivity = { create: options => new PiTranscriptActivity(options) };
})();
