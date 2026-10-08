(() => {
    const key = 'pivane.reply.requestStats';
    const translate = (text, ...args) => globalThis.PiI18n?.t(text, ...args) || text.replace(/\{(\d+)\}/g, (_, i) => args[Number(i)] ?? '');
    let enabled = false;
    try { enabled = localStorage.getItem(key) === 'true'; } catch {}
    const apply = () => {
        const input = document.getElementById('pi-show-request-stats');
        if (input) input.checked = enabled;
        document.querySelectorAll('.pi-request-stats').forEach(node => { node.hidden = !enabled; });
    };
    function append(footer, message) {
        const stats = message?.pivaneRequestStats;
        if (stats?.version !== 1 || !Number.isSafeInteger(stats.outputTokens) || stats.outputTokens <= 0
            || !Number.isFinite(stats.requestMs) || stats.requestMs <= 0
            || !Number.isSafeInteger(stats.requests) || stats.requests <= 0
            || !Number.isSafeInteger(stats.excludedRequests) || stats.excludedRequests < 0
            || !['stop', 'length'].includes(message.stopReason)) return;
        const rate = stats.outputTokens * 1000 / stats.requestMs;
        if (!Number.isFinite(rate) || rate <= 0) return;
        const node = document.createElement('span');
        node.className = 'pi-request-stats'; node.hidden = !enabled;
        node.textContent = translate('请求平均 ≈ {0} tok/s', rate.toLocaleString(globalThis.PiI18n?.locale || 'zh-CN', { maximumFractionDigits: 1 }));
        if (stats.excludedRequests) node.textContent += translate('（部分）');
        node.title = translate('{0} 次有效请求 · {1} 输出 Token · {2} 秒。含首次输出等待、思考、网络及请求内重试；不含工具执行、压缩摘要及请求之间的等待。',
            stats.requests, stats.outputTokens, (stats.requestMs / 1000).toFixed(2));
        if (stats.excludedRequests) node.title += translate('已排除 {0} 次失败、用量缺失或计时不可用的请求。', stats.excludedRequests);
        node.tabIndex = 0;
        node.setAttribute('aria-label', `${node.textContent}。${node.title}`);
        footer.append(node);
    }
    document.getElementById('pi-show-request-stats')?.addEventListener('change', event => {
        enabled = event.target.checked;
        try { localStorage.setItem(key, String(enabled)); } catch {}
        apply();
    });
    window.addEventListener('storage', event => {
        if (event.key === key || event.key === null) { enabled = event.newValue === 'true'; apply(); }
    });
    document.getElementById('pi-request-stats-label').textContent = translate('显示回复请求平均速度');
    document.getElementById('pi-request-stats-hint').textContent = translate('回复结束后显示 Token/s；包含请求等待，不含工具执行与压缩摘要。默认隐藏，仅影响当前浏览器。');
    apply();
    window.PiRequestStats = { append };
})();
