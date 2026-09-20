(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const node = (tag, text, attrs = {}) => {
        const e = document.createElement(tag);
        if (text !== undefined) e.textContent = text;
        for (const [key, value] of Object.entries(attrs)) e.setAttribute(key, value);
        return e;
    };
    const link = (text, href) => {
        const a = node('a', text, { target: '_blank', rel: 'noopener noreferrer', referrerpolicy: 'no-referrer' });
        try {
            const url = new URL(href);
            if (url.protocol === 'https:' && !url.username && !url.password && !url.port && ['github.com', 'www.npmjs.com'].includes(url.hostname)) a.href = url.href;
        } catch {}
        return a;
    };
    const statuses = {
        unchecked: '尚未检查', available: '有可用更新', current: '与可用版本一致', ahead: '当前版本高于此渠道',
        unknown: '无法比较版本', 'no-release': '此渠道暂无发布', error: '检查失败，请稍后重试或打开官方页面。'
    };
    function create({ apiFetch }) {
        const panel = document.getElementById('settings-updates-panel');
        const maintenance = window.PiMaintenance.create({ apiFetch });
        const notifications = window.PiUpdateNotifications.create({ apiFetch });
        const versionPanel = node('div'), manualPanel = node('div');
        let epoch = 0, channel, snapshot;
        const active = n => n === epoch && panel.classList.contains('active') && !document.getElementById('workspace-settings-dialog').classList.contains('hidden');
        function guide(data) {
            const details = node('details', undefined, { class: 'updates-guide', id: 'updates-guide' });
            details.append(node('summary', translateUi('如何更新 Pivane 和 Pi')));
            details.append(node('p', translateUi('以下为手动更新步骤，也适用于更新 Pivane 应用本身。')));
            const steps = node('ol');
            for (const text of [
                '阅读目标版本说明，下载发布包及 SHA-256 校验文件，按平台指南核对哈希。',
                '保存草稿与附件，完成 Agent、Shell、侧聊、媒体、设置和导入导出操作，并暂停所有预约。',
                '停止服务及使用同一身份的 Pi CLI，等进程退出后备份配置、会话、项目和媒体数据。',
                '解压到新的空目录，运行 npm ci 安装配套依赖，沿用原数据路径和启动配置，然后启动新版本。',
                '核对版本与数据后再恢复预约；若更新失败，停止新服务，按平台指南恢复旧版本和配套备份。'
            ]) steps.append(node('li', translateUi(text)));
            details.append(steps);
            const guides = node('div', undefined, { class: 'updates-links' });
            const files = { linux: ['Linux', 'INSTALL_RECOVERY.md'], darwin: ['macOS', 'MACOS.md'], win32: ['Windows', 'WINDOWS.md'] };
            const ordered = [...Object.keys(files)].sort((a, b) => Number(b === data.platform) - Number(a === data.platform));
            for (const key of ordered) {
                const [name, file] = files[key];
                guides.append(link(translateUi('{0} 更新指南', name), `https://github.com/YogurtJ/pivane/blob/main/docs/${file}`));
            }
            details.append(guides);
            details.append(node('p', translateUi('Pi 随 Pivane 发布包的锁定依赖一起安装。全局安装的 Pi CLI 与此工作台独立；在 Packages 中更新扩展也不会更新 Pi 内核。')));
            return details;
        }
        function render(data, busy = false, checking = busy) {
            const expanded = panel.querySelector('#updates-guide')?.open;
            if (versionPanel.parentElement !== panel) panel.replaceChildren(versionPanel, notifications.element, maintenance.element, manualPanel);
            versionPanel.replaceChildren();
            const header = node('div', undefined, { class: 'settings-panel-header' });
            const caption = node('div');
            caption.append(node('h3', translateUi('版本与更新')), node('p', translateUi('查看 Pivane 和 Pi Coding Agent 的版本与更新方式。')));
            header.append(node('i', undefined, { class: 'fa-solid fa-cloud-arrow-down', 'aria-hidden': 'true' }), caption);
            const toolbar = node('div', undefined, { class: 'updates-toolbar' });
            const label = node('label', translateUi('Pivane 更新渠道'));
            const select = node('select', undefined, { id: 'updates-channel' });
            select.append(node('option', translateUi('正式版'), { value: 'stable' }), node('option', translateUi('包含预发布版'), { value: 'preview' }));
            select.value = data.channel; select.disabled = busy;
            select.addEventListener('change', () => { channel = select.value; void load(false); });
            label.append(select);
            const check = node('button', translateUi(busy ? checking ? '正在检查更新…' : '正在读取版本信息…' : '检查更新'), { type: 'button', id: 'updates-check', class: 'settings-primary-button' });
            check.disabled = busy; check.addEventListener('click', () => void load(true));
            toolbar.append(label, check);
            versionPanel.append(header, toolbar, node('p', translateUi('点击检查时由服务器访问 GitHub 和 npm，结果缓存 5 分钟。预发布版适合愿意参与测试的用户。'), { class: 'settings-help' }));
            const cards = node('div', undefined, { class: 'updates-cards', 'aria-busy': String(busy) });
            for (const [key, name, current, info] of [['pivane', 'Pivane', data.appVersion, data.pivane], ['pi', 'Pi Coding Agent', data.piVersion, data.pi]]) {
                const card = node('article', undefined, { class: 'updates-card', id: 'updates-' + key });
                card.append(node('h4', name), node('p', translateUi('当前运行版本：{0}', current)));
                if (info.version) card.append(node('p', translateUi(key === 'pi' ? '上游最新正式版：{0}' : '此渠道可用版本：{0}', info.version)));
                const status = node('p', translateUi(statuses[info.status] || statuses.unknown), { class: 'updates-status', 'data-state': info.status });
                card.append(status);
                if (key === 'pi') {
                    card.append(node('p', translateUi('本版 Pivane 配套 Pi：{0}', data.bundledPiVersion)));
                    card.append(node('p', translateUi('Pi 可通过下方受管更新单独升级，也可随新的 Pivane 发布包安装。上游新版仍需核对第三方扩展兼容性。'), { class: 'settings-help' }));
                    if (!data.dependencyMatches) card.append(node('p', translateUi('实际 Pi 版本与发布包声明不一致，请按锁定依赖核对安装。'), { class: 'updates-mismatch' }));
                }
                const links = node('div', undefined, { class: 'updates-links' });
                links.append(link(translateUi(key === 'pi' ? 'Pi 官方页面' : '发布说明'), info.releasesUrl));
                if (key === 'pivane' && info.downloadUrl && info.checksumUrl) {
                    links.append(link(translateUi('下载发布包'), info.downloadUrl), link(translateUi('下载校验文件'), info.checksumUrl));
                }
                if (key === 'pivane' && info.version && (!info.downloadUrl || !info.checksumUrl)) card.append(node('p', translateUi('发布包或校验文件尚未齐备，请到发布页面核对。'), { class: 'settings-help' }));
                const steps = node('button', translateUi('查看更新步骤'), { type: 'button', class: 'settings-secondary-button' });
                steps.addEventListener('click', () => {
                    const details = panel.querySelector('#updates-guide'); details.open = true;
                    details.querySelector('summary').focus(); details.scrollIntoView({ block: 'nearest' });
                });
                links.append(steps); card.append(links); cards.append(card);
            }
            const status = node('p', busy ? translateUi(checking ? '正在检查更新…' : '正在读取版本信息…') : data.checkedAt ? translateUi('上次检查：{0}', new Date(data.checkedAt).toLocaleString(globalThis.PiI18n?.locale || undefined)) : translateUi('尚未手动检查。自动检查仅查询 Pi 正式版。'), { id: 'updates-feedback', role: 'status', 'aria-live': 'polite' });
            const instructions = guide(data); instructions.open = Boolean(expanded);
            versionPanel.append(cards, status);
            manualPanel.replaceChildren(instructions);
            maintenance.open();
        }
        async function load(check, review = false) {
            const n = ++epoch;
            if (snapshot) render(snapshot, true, check);
            else panel.replaceChildren(node('p', translateUi('正在读取版本信息…'), { role: 'status' }));
            try {
                const suffix = channel ? '?channel=' + encodeURIComponent(channel) : '';
                const data = await apiFetch(check ? '/api/pi/settings/updates/check' : '/api/pi/settings/updates' + suffix, check ? {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(channel ? { channel } : {})
                } : {});
                if (!active(n)) return;
                if (!data?.appVersion || !data.pi || !data.pivane) throw new Error('Unsupported update service');
                snapshot = data; channel = data.channel; render(data);
                void notifications.refresh();
                if (review) await maintenance.reviewUpdate();
            } catch {
                if (!active(n)) return;
                if (snapshot) { channel = snapshot.channel; render(snapshot); }
                else panel.replaceChildren(node('h3', translateUi('版本与更新')));
                const message = translateUi('无法读取更新信息。旧服务需在维护时加载新版后端；网络错误可稍后重试。');
                const feedback = panel.querySelector('#updates-feedback');
                if (feedback) feedback.textContent = message;
                else {
                    panel.append(node('p', message, { role: 'status' }));
                    const retry = node('button', translateUi('重试读取'), { type: 'button', class: 'settings-secondary-button' });
                    retry.addEventListener('click', () => void load(false));
                    panel.append(retry, link(translateUi('发布说明'), 'https://github.com/YogurtJ/pivane/releases'));
                }
            }
        }
        window.addEventListener('pi:maintenance-completed', () => {
            if (panel.classList.contains('active') && !document.getElementById('workspace-settings-dialog').classList.contains('hidden')) void load(false);
        });
        window.addEventListener('workspace:access-locked', () => { epoch++; snapshot = null; maintenance.close(); });
        window.addEventListener('workspace:access-ready', () => {
            epoch++; snapshot = null; maintenance.close();
            if (active(epoch)) void load(false);
        });
        return { open() { void load(false); }, reviewUpdate() { void load(false, true); }, close() { epoch++; maintenance.close(); } };
    }
    window.PiUpdates = { create };
})();
