(() => {
    const t = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const node = (tag, text, attrs = {}) => {
        const element = document.createElement(tag);
        if (text !== undefined) element.textContent = text;
        for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
        return element;
    };
    const link = (text, href) => {
        const element = node('a', text, { target: '_blank', rel: 'noopener noreferrer', referrerpolicy: 'no-referrer' });
        try {
            const url = new URL(href);
            if (url.protocol === 'https:' && !url.username && !url.password && !url.port && ['github.com', 'www.npmjs.com'].includes(url.hostname)) element.href = url.href;
        } catch {}
        return element;
    };
    const statuses = {
        unchecked: '尚未检查', available: '发现新版本', current: '已是最新', ahead: '当前版本较新',
        unknown: '版本无法比较', 'no-release': '暂无发布版本', error: '暂时无法检查'
    };
    const agentPrompt = '请协助我更新部署机器上的 Pivane，并评估是否需要同步更新其使用的 Pi Coding Agent。先只读核对当前运行实例、源码/运行版本、官方仓库发布版本、Pi 实际版本和锁定依赖；阅读 https://github.com/YogurtJ/pivane 的 docs/AGENT_GUIDE.md、docs/INSTALL_RECOVERY.md 及目标版本说明；只有涉及修改源码时再遵循仓库 AGENTS.md，不要用旧发布包覆盖尚未发布的修复。先向我说明差异、兼容性、备份范围、实施及回退计划，等我明确确认后才执行。执行前确认所有任务、子 Agent、Shell、侧聊、预约及外部共用身份的写入已安全结束，保存草稿与附件；停机备份身份、会话、配置、媒体与项目数据，校验下载来源及包哈希，保留旧版并验证升级后的版本和数据。不要自动重试不确定的操作，不要删除用户数据。如果你本身运行在待更新的 Pivane 实例里，不要在当前会话中停止或重启承载你的服务；请让部署机器上的独立 Agent 或管理员在安全窗口执行，并从外部核对结果。';
    function create({ apiFetch }) {
        const panel = document.getElementById('settings-updates-panel');
        const notifications = window.PiUpdateNotifications.create({ apiFetch });
        let epoch = 0, snapshot, requested = false;
        const active = n => n === epoch && panel.classList.contains('active') && !document.getElementById('workspace-settings-dialog').classList.contains('hidden');
        function render(data, busy = false, checking = false) {
            const promptOpen = panel.querySelector('#updates-agent-guide')?.open || false;
            panel.replaceChildren();
            const header = node('div', undefined, { class: 'updates-header' });
            const heading = node('div');
            heading.append(node('span', t('保持了解'), { class: 'updates-eyebrow' }), node('h3', t('版本与更新')),
                node('p', t('查看当前版本与可用新版本。检查不会安装任何内容。')));
            const check = node('button', undefined, { type: 'button', id: 'updates-check', class: 'settings-primary-button' });
            check.append(node('i', undefined, { class: 'fa-solid fa-arrows-rotate', 'aria-hidden': 'true' }), node('span', t(busy ? checking ? '正在检查更新…' : '正在读取版本信息…' : '检查更新')));
            check.disabled = busy; check.addEventListener('click', () => void load(true));
            header.append(heading, check); panel.append(header);
            const cards = node('div', undefined, { class: 'updates-cards', 'aria-busy': String(busy) });
            for (const [key, name, current, info] of [['pivane', 'Pivane', data.appVersion, data.pivane], ['pi', 'Pi Coding Agent', data.piVersion, data.pi]]) {
                const card = node('article', undefined, { class: 'updates-card', id: 'updates-' + key });
                const top = node('div', undefined, { class: 'updates-card-top' });
                const icon = node('span', undefined, { class: 'updates-card-icon', 'aria-hidden': 'true' });
                icon.append(node('i', undefined, { class: key === 'pi' ? 'fa-solid fa-cube' : 'fa-solid fa-layer-group' }));
                top.append(icon, node('h4', name));
                const status = node('span', t(statuses[info.status] || statuses.unknown), { class: 'updates-status', 'data-state': info.status });
                top.append(status); card.append(top);
                const versions = node('div', undefined, { class: 'updates-versions' });
                for (const [label, value] of [[t('当前版本'), current], [t('最新版本'), info.version || '—']]) {
                    const item = node('div', undefined, { class: 'updates-version' });
                    item.append(node('span', label), node('strong', value)); versions.append(item);
                }
                card.append(versions);
                if (key === 'pi' && !data.dependencyMatches) card.append(node('p', t('当前 Pi 与发布包配套版本不同。'), { class: 'updates-note' }));
                const links = node('div', undefined, { class: 'updates-links' });
                links.append(link(t(key === 'pi' ? 'Pi 官方页面' : 'Pivane 发布页面'), info.releasesUrl));
                card.append(links); cards.append(card);
            }
            panel.append(cards);
            const feedback = node('p', data.checkedAt ? t('上次检查：{0}', new Date(data.checkedAt).toLocaleString(globalThis.PiI18n?.locale || undefined)) : t('尚未手动检查。Pi 可能显示自动检查的结果。'), { id: 'updates-feedback', role: 'status', 'aria-live': 'polite' });
            panel.append(feedback);
            const networkLink = node('a', t('网络代理设置'), { href: '#/settings?tab=access&section=proxy', class: 'network-settings-link' });
            panel.append(networkLink);
            const guide = node('details', undefined, { class: 'updates-agent-guide', id: 'updates-agent-guide' }); guide.open = promptOpen;
            guide.append(node('summary', t('交给独立 Agent 协助更新')));
            const content = node('div', undefined, { class: 'updates-agent-content' });
            content.append(node('p', t('在部署机器上使用独立 Agent；不要让正在被更新的 Pivane 会话重启自身。先让它核对并提出计划，确认后再执行。')));
            const prompt = node('textarea', t(agentPrompt), { id: 'updates-agent-prompt', readonly: '', 'aria-label': t('更新提示词') });
            const copy = node('button', t('复制提示词'), { type: 'button', class: 'settings-secondary-button', id: 'updates-copy-prompt' });
            const copyFeedback = node('span', '', { role: 'status', 'aria-live': 'polite', class: 'updates-copy-feedback' });
            copy.addEventListener('click', async () => {
                try { await navigator.clipboard.writeText(prompt.value); copyFeedback.textContent = t('已复制'); }
                catch { prompt.focus(); prompt.select(); copyFeedback.textContent = t('无法自动复制，已选中提示词，请手动复制。'); }
            });
            const action = node('div', undefined, { class: 'updates-agent-action' }); action.append(copy, copyFeedback);
            content.append(prompt, action); guide.append(content); panel.append(guide, notifications.element);
        }
        async function load(check) {
            const n = ++epoch;
            if (snapshot) render(snapshot, true, check);
            else panel.replaceChildren(node('p', t('正在读取版本信息…'), { role: 'status' }));
            try {
                const data = await apiFetch(check ? '/api/pi/settings/updates/check' : '/api/pi/settings/updates', check ? {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
                } : {});
                if (!active(n)) return;
                if (!data?.appVersion || !data.pi || !data.pivane) throw new Error('Unsupported update service');
                snapshot = data; render(data); void notifications.refresh();
                if (!check && !requested && !data.checkedAt) { requested = true; void load(true); }
            } catch {
                if (!active(n)) return;
                if (snapshot) render(snapshot);
                else panel.replaceChildren(node('h3', t('版本与更新')));
                const feedback = panel.querySelector('#updates-feedback');
                const message = t('暂时无法读取版本信息，请稍后再试。');
                if (feedback) feedback.textContent = message;
                else {
                    panel.append(node('p', message, { role: 'status' }));
                    const retry = node('button', t('重试读取'), { type: 'button', class: 'settings-secondary-button' });
                    retry.addEventListener('click', () => void load(false)); panel.append(retry);
                }
            }
        }
        window.addEventListener('workspace:access-locked', () => { epoch++; snapshot = null; requested = false; });
        window.addEventListener('workspace:access-ready', () => { epoch++; snapshot = null; requested = false; if (active(epoch)) void load(false); });
        return { open() { void load(false); }, close() { epoch++; } };
    }
    window.PiUpdates = { create };
})();
