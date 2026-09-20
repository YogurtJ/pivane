(() => {
    const t = (text, ...values) => globalThis.PiI18n?.t(text, ...values) || text;
    const node = (tag, text, attrs = {}) => {
        const e = document.createElement(tag); if (text !== undefined) e.textContent = text;
        for (const [key, value] of Object.entries(attrs)) e.setAttribute(key, value);
        return e;
    };
    function create({ apiFetch }) {
        const element = node('section', undefined, { class: 'updates-notification-settings' }); element.hidden = true;
        const checkbox = node('input', undefined, { type: 'checkbox', id: 'updates-auto-check' });
        const label = node('label', undefined, { class: 'maintenance-check' });
        label.append(checkbox, node('span', t('自动检查 Pi 更新')));
        const feedback = node('p', '', { role: 'status', class: 'settings-help' });
        element.append(label, node('p', t('最多每 24 小时检查一次 Pi 正式版，只查询版本信息，不会自动下载或安装。此设置由本实例所有设备共用。'), { class: 'settings-help' }), feedback);
        const banner = node('aside', undefined, { id: 'pi-update-notice', role: 'region', 'aria-label': t('Pi 更新提醒') });
        banner.hidden = true; document.body.append(banner);
        let epoch = 0, pending = false, saving = false, data, shownVersion, timer;
        const visible = () => !document.hidden && !document.body.classList.contains('workspace-access-locked');
        const canShow = () => visible() && document.getElementById('workspace-settings-dialog')?.classList.contains('hidden') && !document.querySelector('dialog[open]');
        const request = (path, body) => apiFetch('/api/pi/settings/updates/' + path, { signal: AbortSignal.timeout(20000), ...(body === undefined ? {} : {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        }) });
        function apply(value) {
            if (typeof value?.enabled !== 'boolean') return false;
            data = value; element.hidden = false; checkbox.checked = value.enabled;
            for (const e of document.querySelectorAll('#workspace-settings-toggle, [data-settings-tab="updates"]')) {
                e.toggleAttribute('data-pi-update', value.available === true);
                let badge = e.querySelector('.pi-update-badge');
                if (!badge) { badge = node('span', t('Pi 有可用更新'), { class: 'pi-update-badge' }); e.append(badge); }
                badge.hidden = !value.available;
            }
            if (!value.available || shownVersion !== value.version || !value.idle) banner.hidden = true;
            return true;
        }
        function show(version) {
            banner.replaceChildren(node('strong', t('Pi 有新版本：{0}', version)), node('p', t('当前版本为 {0}，可在任务结束后更新。', data.currentVersion)));
            const row = node('div', undefined, { class: 'updates-links' });
            const button = (text, id, action) => {
                const b = node('button', t(text), { type: 'button', id, class: 'settings-secondary-button' });
                b.addEventListener('click', action); row.append(b);
            };
            button('查看并更新', 'pi-update-notice-open', () => {
                banner.hidden = true;
                window.dispatchEvent(new CustomEvent('workspace:open-settings', { detail: { tab: 'updates', updatePi: true } }));
            });
            for (const [action, text] of [['snooze', '3 天后提醒'], ['ignore', '忽略此版本']]) button(text, 'pi-update-notice-' + action, async () => {
                if (saving) return;
                const n = ++epoch; saving = true;
                row.querySelectorAll('button').forEach(b => { b.disabled = true; });
                try { const value = await request('notifications', { action, version }); if (n === epoch) { apply(value); banner.hidden = true; } }
                catch { if (n === epoch) status.textContent = t('提醒设置保存失败，请重试。'); }
                finally { saving = false; row.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
            });
            button('关闭提醒', 'pi-update-notice-close', () => { banner.hidden = true; });
            const status = node('p', '', { role: 'status' }); banner.append(row, status); banner.hidden = false;
        }
        async function refresh(automatic = false) {
            if (pending || saving || !visible()) return;
            pending = true; const n = epoch;
            try {
                await window.WorkspaceAccess?.ready;
                if (n !== epoch || !visible()) return;
                let value = await request('notifications');
                if (n !== epoch || !apply(value)) return;
                if (automatic && visible() && value.enabled && (!value.nextCheckAt || value.nextCheckAt <= Date.now())) {
                    value = await request('automatic', {});
                    if (n !== epoch || !apply(value)) return;
                }
                if (!value.available || !value.idle || !canShow()) return;
                if (value.eligible) {
                    const claimed = await request('notifications', { action: 'claim', version: value.version });
                    if (n !== epoch || !apply(claimed) || !claimed.claimed || !canShow()) return;
                    shownVersion = claimed.version; show(claimed.version);
                }
            } catch { /* Automatic checks and old servers remain silent; explicit settings failures are local. */ }
            finally { pending = false; }
        }
        checkbox.addEventListener('change', async () => {
            if (saving) return;
            saving = true; checkbox.disabled = true; const n = ++epoch;
            try { const value = await request('notifications', { enabled: checkbox.checked }); if (n === epoch) { apply(value); feedback.textContent = ''; } }
            catch { if (n === epoch) { checkbox.checked = data?.enabled !== false; feedback.textContent = t('提醒设置保存失败，请重试。'); } }
            finally { saving = false; checkbox.disabled = false; }
        });
        function schedule(delay = 5000) { clearTimeout(timer); timer = setTimeout(async () => { await refresh(true); schedule(60000); }, delay); }
        window.addEventListener('workspace:access-locked', () => {
            epoch++; banner.hidden = true; element.hidden = true; shownVersion = null;
            document.querySelectorAll('.pi-update-badge').forEach(e => { e.hidden = true; });
        });
        window.addEventListener('workspace:access-ready', () => { epoch++; schedule(); });
        window.addEventListener('pi:maintenance-completed', () => { epoch++; banner.hidden = true; schedule(); });
        document.addEventListener('visibilitychange', () => { if (document.hidden) banner.hidden = true; else schedule(); });
        window.addEventListener('focus', () => schedule());
        window.addEventListener('workspace:settings-closed', () => schedule());
        schedule();
        return { element, refresh: () => refresh(false) };
    }
    window.PiUpdateNotifications = { create };
})();
