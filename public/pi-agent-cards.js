// Compact, collapsed-by-default cards for Agent-to-Agent records (task handoffs,
// creation receipts, returned results, direct Agent messages) and for context
// summaries. Bodies are Agent/model text: rendered with the host's
// marked + DOMPurify renderer; every other value uses safe DOM text.
(() => {
    const t = (s, ...args) => globalThis.PiI18n?.t ? globalThis.PiI18n.t(s, ...args) : s.replace(/\{(\d+)\}/g, (_, i) => args[i] ?? '');
    const TASK = ['pivane-agent-task-message', 'pi5-agent-task-message'];
    const RECEIPT = ['pivane-agent-task-receipt', 'pi5-agent-task-receipt'];
    const RESULT = 'pivane-agent-task-result', MESSAGE = 'pivane-agent-message';
    const str = (value, max = 4096) => typeof value === 'string' && value.length <= max ? value : '';
    const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : '';
    const RECEIPT_LABELS = { saved: '任务已保存，尚未确认启动', submitted: '任务已提交', running: '运行中', tool: '运行中', retrying: '运行中', compacting: '运行中',
        waiting: '等待处理', completed: '已完成', error: '执行失败', stopped: '已停止', uncertain: '启动状态待核实' };
    const RESULT_LABELS = { completed: '本轮已结束', error: '执行失败', stopped: '已中止', needs_attention: '需要处理', uncertain: '状态待核实' };
    const handles = message => message?.role === 'custom' && (TASK.includes(message.customType) || RECEIPT.includes(message.customType)
        || message.customType === RESULT || message.customType === MESSAGE);

    function preview(source) {
        return source.replace(/```[^\n]*\n?/g, ' ').replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '').replace(/[*_`~]+/g, '')
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim().slice(0, 240);
    }
    function time(value) {
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) return '';
        return date.toLocaleTimeString(globalThis.PiI18n?.locale || 'zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    }
    function span(className, text) {
        const node = document.createElement('span'); node.className = className; node.textContent = text; return node;
    }
    // One-line preview while closed; the full body scrolls inside a bounded panel when opened.
    function collapsible(source, markdown, { label = t("展开全文") } = {}) {
        const details = document.createElement('details'); details.className = 'pi-agent-card-body';
        const summary = document.createElement('summary');
        const toggle = span('pi-agent-card-toggle', label);
        summary.append(span('pi-agent-card-preview', preview(source) || t("（没有正文）")), toggle);
        const content = document.createElement('div'); content.className = 'pi-agent-card-content pi-markdown';
        details.append(summary, content);
        let rendered = false;
        const sync = () => {
            if (details.open && !rendered) { rendered = true; content.innerHTML = markdown(source); }
            toggle.textContent = details.open ? t("收起") : label;
        };
        details.addEventListener('toggle', sync);
        details._piRenderNow = () => { if (!rendered) { rendered = true; content.innerHTML = markdown(source); } };
        return details;
    }

    function render(message, { link, markdown }) {
        if (!handles(message)) return null;
        const details = message.details && typeof message.details === 'object' ? message.details : {};
        const article = document.createElement('article');
        article.className = 'pi-message custom pi-agent-thread-message pi-agent-card';
        const header = document.createElement('header');
        const icon = document.createElement('i'); icon.setAttribute('aria-hidden', 'true');
        const title = document.createElement('strong');
        header.append(icon, title);
        const meta = [];
        let body = '', target = null, targetLabel = '', peer = '';
        if (TASK.includes(message.customType)) {
            article.dataset.agentCard = 'task'; article.classList.add('pi-agent-turn-start');
            icon.className = 'fa-solid fa-inbox'; title.textContent = t("来自 Agent 的任务");
            body = textOf(message.content);
            target = { cwd: details.source?.cwd, id: details.source?.sessionId }; targetLabel = t("查看来源线程");
        } else if (RECEIPT.includes(message.customType)) {
            article.dataset.agentCard = 'receipt';
            icon.className = 'fa-solid fa-code-branch'; title.textContent = t("已创建任务线程");
            peer = str(details.session?.name, 300) || textOf(message.content).slice(0, 300);
            const status = typeof details.status === 'string' && Object.hasOwn(RECEIPT_LABELS, details.status) ? RECEIPT_LABELS[details.status] : RECEIPT_LABELS.uncertain;
            const model = [str(details.model?.provider, 500), str(details.model?.modelId, 500)].filter(Boolean).join('/');
            meta.push(t("创建时状态：{0}", t(status)), model, str(details.thinkingLevel, 100));
            target = details.session; targetLabel = t("打开任务线程");
        } else if (message.customType === RESULT) {
            article.dataset.agentCard = 'result';
            icon.className = 'fa-solid fa-flag-checkered'; title.textContent = t("Agent 任务结果");
            peer = str(details.session?.name, 300) || str(details.requestId, 160);
            meta.push(t(Object.hasOwn(RESULT_LABELS, details.status) ? RESULT_LABELS[details.status] : RESULT_LABELS.uncertain));
            if (details.status === 'error' || details.status === 'needs_attention') article.dataset.state = 'attention';
            body = str(details.preview, 6000) + (details.truncated ? `\n\n_${t("此处仅显示部分原文。")}_` : '');
            target = details.session; targetLabel = t("查看完整结果");
        } else {
            article.dataset.agentCard = 'message';
            if (details.wake === true) article.classList.add('pi-agent-turn-start');
            icon.className = 'fa-solid fa-comments'; title.textContent = t(details.replyTo ? "Agent 回复" : "来自 Agent 的消息");
            peer = str(details.from?.name, 160) || (str(details.from?.sessionId, 160) ? `${details.from.sessionId.slice(0, 8)}…` : '');
            const offset = Number.isInteger(details.bodyOffset) && details.bodyOffset >= 0 ? details.bodyOffset : 0;
            body = textOf(message.content).slice(offset);
            meta.push(details.wake === true ? t("已唤醒处理") : details.wakeSuppressed === 'hop-limit' ? t("未唤醒：自动往返已达上限")
                : details.wakeSuppressed === 'rate-limit' ? t("未唤醒：唤醒过于频繁") : t("仅留言"));
            target = { cwd: details.from?.cwd, id: details.from?.sessionId }; targetLabel = t("打开来源线程");
        }
        if (peer) { const node = span('pi-agent-card-peer', peer); node.title = peer; header.append(node); }
        const when = time(message.timestamp);
        const metaText = [...meta, when].filter(Boolean).join(' · ');
        if (metaText) { const node = span('pi-agent-thread-meta', metaText); node.title = metaText; header.append(node); }
        link(header, target, targetLabel);
        article.append(header);
        if (body.trim()) {
            const container = document.createElement('div'); container.className = 'pi-message-body';
            // Short single-line bodies are shown as-is; anything longer starts collapsed.
            if (body.length <= 160 && !/\n/.test(body.trim())) {
                const inline = document.createElement('div'); inline.className = 'pi-agent-card-inline pi-markdown';
                inline.innerHTML = markdown(body.trim()); container.append(inline);
            } else container.append(collapsible(body, markdown));
            article.append(container);
        }
        return article;
    }

    // Compaction and branch summaries: one line by default, the summary on demand.
    function summary(type, message) {
        const details = document.createElement('details');
        details.className = `pi-event-notice pi-summary-notice ${type}`;
        const head = document.createElement('summary');
        const icon = document.createElement('i'); icon.className = `fa-solid ${type === 'compactionSummary' ? 'fa-compress' : 'fa-code-branch'}`; icon.setAttribute('aria-hidden', 'true');
        const title = document.createElement('strong'); title.textContent = type === 'compactionSummary' ? t("上下文已压缩") : t("分支摘要");
        head.append(icon, title);
        const tokens = Number(message.tokensBefore);
        if (type === 'compactionSummary' && Number.isFinite(tokens) && tokens > 0)
            head.append(span('pi-summary-meta', t("压缩前约 {0} tokens", Math.round(tokens).toLocaleString(globalThis.PiI18n?.locale || 'zh-CN'))));
        const toggle = span('pi-agent-card-toggle', t("查看摘要")); head.append(toggle);
        const text = String(message.summary || textOf(message.content) || '');
        const content = document.createElement('div'); content.className = 'pi-summary-content';
        details.append(head, content);
        let rendered = false;
        details.addEventListener('toggle', () => {
            // Summaries keep their original paths, tags and line breaks: plain text, not Markdown.
            if (details.open && !rendered) { rendered = true; const p = document.createElement('p'); p.textContent = text; content.append(p); }
            toggle.textContent = details.open ? t("收起") : t("查看摘要");
        });
        return details;
    }
    globalThis.PiAgentCards = { handles, render, summary, preview };
})();
