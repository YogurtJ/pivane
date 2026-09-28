(() => {
    // Presentation for pi-subagents custom messages. Content stays the package's
    // own text; only the heading, tone and folding are adapted for the web.
    const t = (text, ...values) => globalThis.PiI18n?.t ? globalThis.PiI18n.t(text, ...values) : text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? '');
    const TYPES = {
        'subagent-notify': ['子 Agent 结果', 'fa-solid fa-people-group', 'result'],
        'subagent-incremental-child-notify': ['子 Agent 进展', 'fa-solid fa-people-group', 'progress'],
        'subagent_supervisor_request': ['子 Agent 请求指示', 'fa-solid fa-hand', 'attention'],
        'subagent_supervisor_reply': ['已回复子 Agent', 'fa-regular fa-comment', 'progress'],
        'subagent_control_notice': ['子 Agent 状态提醒', 'fa-solid fa-circle-info', 'attention'],
        'subagent_steering_notice': ['子 Agent 引导记录', 'fa-regular fa-comment-dots', 'progress'],
        'subagent_watchdog_warning': ['子 Agent 监督提醒', 'fa-solid fa-triangle-exclamation', 'attention'],
        'subagent-wait-subscription': ['子 Agent 等待提醒', 'fa-regular fa-clock', 'progress'],
        'subagent-slash-result': ['子 Agent 命令结果', 'fa-solid fa-terminal', 'result'],
        'subagent-slash-text-result': ['子 Agent 命令结果', 'fa-solid fa-terminal', 'result'],
        'subagent-workflow-result-write-failed': ['工作流结果保存失败', 'fa-solid fa-circle-exclamation', 'error'],
        'subagent-compaction-resume': ['子 Agent 压缩后继续', 'fa-solid fa-compress', 'progress']
    };
    function decorate(article, header, message) {
        const entry = typeof message?.customType === 'string' && Object.hasOwn(TYPES, message.customType) ? TYPES[message.customType] : null;
        if (!entry) return false;
        const [label, iconClass, tone] = entry;
        article.classList.add('pi-subagent-notice');
        article.dataset.subagentTone = tone;
        const strong = header.querySelector('strong');
        strong.textContent = t(label);
        const icon = document.createElement('i'); icon.className = iconClass; icon.setAttribute('aria-hidden', 'true');
        strong.before(icon);
        const source = document.createElement('span'); source.className = 'pi-subagent-notice-source'; source.textContent = 'pi-subagents';
        header.append(source);
        return true;
    }
    // One-line preview: first meaningful line without Markdown punctuation.
    function preview(source) {
        const line = String(source || '').split(/\r\n|\r|\n/).map(item => item.replace(/^[\s>#*\-+`|]+|[*_`~]+/g, '').trim()).find(Boolean) || '';
        return line.length > 160 ? line.slice(0, 159) + '…' : line;
    }
    // Notices are collapsed to a single row: the plugin writes them for the main
    // Agent, and people rarely read them. Markdown renders on first expansion.
    function collapse(article, header, body, source, render) {
        const fold = document.createElement('details'); fold.className = 'pi-subagent-notice-fold';
        const summary = document.createElement('summary');
        const hint = document.createElement('span'); hint.className = 'pi-subagent-notice-preview';
        hint.textContent = preview(source); hint.title = hint.textContent;
        const chevron = document.createElement('i'); chevron.className = 'fa-solid fa-chevron-right pi-subagent-notice-chevron'; chevron.setAttribute('aria-hidden', 'true');
        const origin = header.querySelector('.pi-subagent-notice-source');
        summary.append(...[...header.childNodes].filter(node => node !== origin), hint, ...(origin ? [origin] : []), chevron);
        header.remove(); body.remove();
        fold.append(summary, body);
        const ensure = () => { for (const node of body.querySelectorAll('[data-pending-markdown]')) { node.innerHTML = render(node._piMarkdown || ''); node.removeAttribute('data-pending-markdown'); delete node._piMarkdown; } };
        fold.addEventListener('toggle', () => { if (fold.open) ensure(); });
        article.append(fold);
        article._piExpandNotice = () => { fold.open = true; ensure(); };
    }
    window.PiSubagentNotices = { decorate, collapse, preview, types: Object.keys(TYPES) };
})();
