(() => {
    const t = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, i) => values[i] ?? `{${i}}`));
    const node = (tag, text, attrs = {}) => {
        const e = document.createElement(tag); if (text !== undefined) e.textContent = text;
        for (const [key, value] of Object.entries(attrs)) e.setAttribute(key, value);
        return e;
    };
    const phases = { downloading: '正在下载并校验 Pivane…', preparing: '正在准备维护…', installing: '正在安装独立的 Pi 依赖…', verifying: '正在验证 SDK、RPC 和会话格式…',
        stopping: '正在等待服务安全退出…', 'backing-up': '正在备份数据…', starting: '正在启动服务…', succeeded: '维护操作已完成', failed: '维护操作失败', interrupted: '维护操作中断，未自动重试' };
    function create({ apiFetch }) {
        const element = node('section', undefined, { class: 'updates-maintenance', id: 'updates-maintenance' });
        const feedback = node('p', '', { id: 'maintenance-feedback', role: 'status', 'aria-live': 'polite' });
        const status = node('p', '', { id: 'maintenance-state', role: 'status', 'aria-live': 'polite' });
        const actions = node('div', undefined, { class: 'updates-links' });
        const dialog = node('dialog', undefined, { class: 'maintenance-dialog', id: 'maintenance-dialog', 'aria-labelledby': 'maintenance-dialog-title' });
        const result = node('p', '', { id: 'maintenance-result' });
        const output = node('pre', t('点击“更新 Pi”后，执行过程会显示在这里。'), { id: 'maintenance-output', tabindex: '0', role: 'log', 'aria-live': 'off', 'aria-label': t('更新命令输出') });
        const consoleBox = node('div', undefined, { class: 'maintenance-console' });
        consoleBox.append(node('strong', t('更新命令输出')), output);
        const buttons = [];
        let lastFinished;
        let opened = false, epoch = 0, request = 0, timer, state, reviewing = false, pendingId = null, pendingGeneration;
        element.append(node('h4', t('安装与维护')), node('p', t('点击更新即可在服务器执行，命令输出和结果会显示在下方。')), actions, status, result, consoleBox, feedback, dialog);
        const ready = () => opened && element.isConnected;
        const updateButtons = () => buttons.forEach(([button, action]) => { button.disabled = reviewing || Boolean(pendingId) || !state?.supported || state.busy || action === 'application' && !state.appUpdateSupported || action === 'update' && !state.updateSupported; });
        for (const [action, text] of [['update', '更新 Pi'], ['backup', '仅备份'], ['restart', '重启实例']]) {
            const button = node('button', t(text), { type: 'button', class: action === 'update' ? 'settings-primary-button' : 'settings-secondary-button', id: 'maintenance-' + action });
            button.disabled = true; button.addEventListener('click', () => void review(action)); actions.append(button); buttons.push([button, action]);
        }
        const refresh = node('button', t('刷新状态'), { type: 'button', class: 'settings-secondary-button', id: 'maintenance-refresh' });
        refresh.addEventListener('click', () => void read()); actions.append(refresh);
        async function read() {
            const n = epoch, r = ++request;
            try {
                const data = await apiFetch('/api/pi/settings/updates/maintenance');
                if (!ready() || n !== epoch || r !== request) return;
                state = data;
                if (pendingId && pendingGeneration && data.generation !== pendingGeneration && !data.busy && data.job?.id !== pendingId) {
                    pendingId = null; feedback.textContent = t('服务已重新启动，上次提交未被确认；请核对后手动决定，不会自动重试。');
                }
                if (!data.supported) status.textContent = t('当前为开发直连模式或旧后端，更新功能暂不可用；普通启动方式加载新版后端后即可使用。');
                else if (data.job) {
                    status.textContent = t(phases[data.job.phase] || '正在准备维护…');
                    if (data.job.backup) status.textContent += '\n' + t('备份目录：{0}', data.job.backup.directory);
                    if (data.job.error) status.textContent += '\n' + t('失败阶段：{0}。请核对状态后再决定，不会自动重新执行。', t(phases[data.job.error] || data.job.error));
                    const follow = output.scrollTop + output.clientHeight >= output.scrollHeight - 24;
                    const text = (data.job.outputTruncated ? t('较早的输出已截断。') + '\n' : '') + (data.job.output || t('等待命令输出…'));
                    if (output.textContent !== text) { output.textContent = text; if (follow) output.scrollTop = output.scrollHeight; }
                    const parts = [];
                    if (data.job.fromVersion && data.job.installedVersion) parts.push(t(data.job.action === 'application' ? 'Pivane 版本：{0} → {1}' : 'Pi 版本：{0} → {1}', data.job.fromVersion, data.job.installedVersion));
                    if (Number.isInteger(data.job.exitCode)) parts.push(t('退出码：{0}', data.job.exitCode));
                    result.textContent = parts.join(' · ');
                    if (!data.busy && ['succeeded', 'failed', 'interrupted'].includes(data.job.phase) && lastFinished !== data.job.id) {
                        lastFinished = data.job.id;
                        if (pendingId === data.job.id) pendingId = null;
                        feedback.textContent = t('请核对当前版本与会话；预约保持暂停，需要逐项恢复。');
                        window.dispatchEvent(new CustomEvent('pi:maintenance-completed'));
                    }
                } else status.textContent = data.updateSupported ? t('维护启动器已连接') : t('Pi 更新需要 Node 22 或 24 和默认的本地 Pi 安装');
                updateButtons();
            } catch {
                if (ready() && n === epoch && r === request) {
                    status.textContent = pendingId || state?.busy ? t('服务暂时不可达，正在等待重连；请勿重复提交。') : t('维护状态暂不可用，请稍后刷新。');
                    state = { ...state, supported: false }; updateButtons();
                }
            } finally {
                if (ready() && n === epoch && r === request) { clearTimeout(timer); timer = setTimeout(() => void read(), pendingId || state?.busy ? 1500 : 5000); }
            }
        }
        async function review(action, channel) {
            if (reviewing || pendingId) return;
            reviewing = true; updateButtons(); const n = epoch;
            feedback.textContent = t('正在检查维护条件…');
            try {
                const ticket = await apiFetch('/api/pi/settings/updates/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...(channel ? { channel } : {}) }) });
                if (!ready() || n !== epoch) return;
                feedback.textContent = '';
                dialog.replaceChildren(node('h3', action === 'application' ? t('更新 Pivane：{0} → {1}', ticket.currentVersion, ticket.version) : action === 'update' ? t('更新 Pi：{0} → {1}', ticket.currentVersion, ticket.version) : t(action === 'backup' ? '确认备份并重启' : '确认重启实例'), { id: 'maintenance-dialog-title' }));
                dialog.append(node('p', t('操作会暂时断开所有设备连接，并暂停预约。请先完成任务，保存草稿、附件和临时对话。')));
                if (action !== 'restart') dialog.append(node('p', t('备份包含 Pi 身份、会话、配置及媒体记录和文件；不包含项目源码、外置 Package 或符号链接指向的内容。备份保存在部署机器的私有目录。')), node('p', t('备份位置：{0}', ticket.storage)));
                if (action === 'update') dialog.append(node('p', t('自动验证只覆盖启动、SDK、RPC 和会话格式，第三方扩展与真实供应商仍需更新后核对。旧依赖目录会保留。')));
                const drafts = node('input', undefined, { type: 'checkbox', id: 'maintenance-drafts' });
                const external = node('input', undefined, { type: 'checkbox', id: 'maintenance-external' });
                for (const [field, text] of [[drafts, '已保存草稿、附件和临时对话'], [external, '已停止使用同一数据的外部 Pi CLI 和其他写入进程']]) {
                    const label = node('label', undefined, { class: 'maintenance-check' }); label.append(field, node('span', t(text))); dialog.append(label);
                }
                const row = node('div', undefined, { class: 'updates-links' });
                const cancel = node('button', t('取消'), { type: 'button', class: 'settings-secondary-button' }); cancel.addEventListener('click', () => dialog.close());
                const execute = node('button', t('确认并执行'), { type: 'button', class: 'settings-primary-button', id: 'maintenance-confirm' });
                execute.disabled = true;
                const change = () => { execute.disabled = !drafts.checked || !external.checked; };
                drafts.addEventListener('change', change); external.addEventListener('change', change);
                execute.addEventListener('click', async () => {
                    if (execute.disabled || pendingId) return;
                    execute.disabled = true; pendingId = ticket.id; pendingGeneration = state?.generation; dialog.close(); updateButtons();
                    feedback.textContent = t('已提交维护操作，正在等待服务器状态。');
                    try {
                        await apiFetch('/api/pi/settings/updates/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: ticket.id, confirmed: true, draftsSaved: true, externalWritersStopped: true }) });
                    } catch (error) {
                        if (error.status >= 400 && error.status < 500) pendingId = null;
                        if (ready() && n === epoch) feedback.textContent = error.status >= 400 && error.status < 500 ? error.message : t('提交结果尚未确认，请查看状态，不要重复执行。');
                    }
                    if (ready() && n === epoch) { updateButtons(); void read(); }
                });
                row.append(cancel, execute); dialog.append(row); dialog.showModal();
            } catch (error) { if (ready() && n === epoch) feedback.textContent = error.message; }
            finally { if (n === epoch) { reviewing = false; if (ready()) updateButtons(); } }
        }
        return { element,
            open() { if (opened) return; opened = true; epoch++; void read(); },
            async reviewApplication(channel) { await read(); if (ready()) { if (!state?.appUpdateSupported) { feedback.textContent = t('当前启动器不支持 Pivane 应用更新，请先加载新版启动器'); return; } await review('application', channel); } },
            async reviewUpdate() { await read(); if (ready() && state?.supported && state.updateSupported && !state.busy) await review('update'); },
            close() { opened = false; epoch++; reviewing = false; clearTimeout(timer); if (dialog.open) dialog.close(); }
        };
    }
    window.PiMaintenance = { create };
})();
