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
        const previewButton = node('button', t('预览更新提醒'), { type: 'button', id: 'updates-notice-preview', class: 'settings-secondary-button', 'aria-expanded': 'false', 'aria-controls': 'updates-notice-preview-area' });
        const previewArea = node('div', undefined, { id: 'updates-notice-preview-area' }); previewArea.hidden = true;
        const previewCard = node('aside', undefined, { id: 'pi-update-notice-preview', class: 'pi-update-card', 'aria-label': t('提醒样式预览') });
        previewArea.append(node('p', t('示例版本，仅预览样式；不会检查更新或修改提醒设置。'), { class: 'settings-help' }), previewCard);
        element.append(previewButton, previewArea);
        const banner = node('aside', undefined, { id: 'pi-update-notice', class: 'pi-update-card', role: 'region', 'aria-label': t('Pi 更新提醒') });
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
        function closePreview() {
            previewArea.hidden = true; previewButton.setAttribute('aria-expanded', 'false');
            previewButton.textContent = t('预览更新提醒'); previewButton.focus({ preventScroll: true });
        }
        function renderCard(target, version, currentVersion, preview = false) {
            const close = node('button', undefined, { type: 'button', class: 'pi-update-close', id: target.id + '-close', 'aria-label': t('关闭提醒'), title: t('关闭提醒') });
            close.append(node('i', undefined, { class: 'fa-solid fa-xmark', 'aria-hidden': 'true' }));
            close.addEventListener('click', () => { if (preview) closePreview(); else target.hidden = true; });
            const icon = node('span', undefined, { class: 'pi-update-icon', 'aria-hidden': 'true' });
            icon.append(node('i', undefined, { class: 'fa-solid fa-arrow-up' }));
            const heading = node('div', undefined, { class: 'pi-update-heading' });
            const versions = node('div', undefined, { class: 'pi-update-versions', role: 'group', 'aria-label': t('Pi 版本：{0} → {1}', currentVersion, version) });
            versions.append(node('span', currentVersion, { class: 'pi-update-from' }), node('span', '→', { 'aria-hidden': 'true' }), node('span', version, { class: 'pi-update-to' }));
            heading.append(node('strong', t('Pi 有可用更新')), versions);
            const header = node('div', undefined, { class: 'pi-update-header' }); header.append(icon, heading);
            const row = node('div', undefined, { class: 'pi-update-actions' });
            const footer = node('div', undefined, { class: 'pi-update-footer' });
            footer.append(node('span', t('可在任务结束后更新。')));
            const status = node('p', '', { role: 'status', class: 'pi-update-feedback' });
            const button = (text, suffix, action, parent = row) => {
                const b = node('button', t(text), { type: 'button', id: target.id + '-' + suffix, class: 'pi-update-action pi-update-' + suffix });
                b.addEventListener('click', () => {
                    if (preview) status.textContent = t('这是样式预览，未执行任何操作。');
                    else void action();
                }); parent.append(b);
            };
            button('查看并更新', 'open', () => {
                target.hidden = true;
                window.dispatchEvent(new CustomEvent('workspace:open-settings', { detail: { tab: 'updates', updatePi: true } }));
            });
            for (const [action, text] of [['snooze', '3 天后提醒'], ['ignore', '忽略此版本']]) button(text, action, async () => {
                if (saving) return;
                const n = ++epoch; saving = true;
                target.querySelectorAll('button').forEach(b => { b.disabled = true; });
                try { const value = await request('notifications', { action, version }); if (n === epoch) { apply(value); target.hidden = true; } }
                catch { if (n === epoch) status.textContent = t('提醒设置保存失败，请重试。'); }
                finally { saving = false; target.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
            }, action === 'ignore' ? footer : row);
            target.replaceChildren(close, header, row, footer, status);
        }
        function show(version) { renderCard(banner, version, data.currentVersion); banner.hidden = false; }
        previewButton.addEventListener('click', () => {
            if (!previewArea.hidden) { closePreview(); return; }
            // Deliberate example versions; preview never claims a release or calls a maintenance endpoint.
            renderCard(previewCard, '0.87.0', '0.86.1', true);
            previewArea.hidden = false; previewButton.setAttribute('aria-expanded', 'true'); previewButton.textContent = t('收起预览');
        });
        for (const card of [banner, previewCard]) card.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || saving) return;
            event.stopPropagation();
            if (card === previewCard) closePreview();
            else { banner.hidden = true; document.getElementById('workspace-settings-toggle')?.focus({ preventScroll: true }); }
        });
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
