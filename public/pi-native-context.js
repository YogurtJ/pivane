(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const $ = id => document.getElementById(id);
    function create({ apiFetch, context, resources, reload, configuration, restart }) {
        const { node, button } = window.PiNativeUI;
        const dialog = $('pi-project-trust-dialog'), body = $('pi-project-trust-body'), message = $('pi-project-trust-status');
        const section = $('pi-loaded-resources'), content = $('pi-loaded-resources-body'), refresh = $('pi-loaded-resources-refresh'), reloadButton = $('pi-loaded-resources-reload');
        let dialogEpoch = 0, trustContext, returnFocus, reading = false, readEpoch = 0, identity = '';
        let configEpoch = 0, configIdentity = '', configValue = null;
        const feedback = node('p', '', { id: 'pi-runtime-config-status', role: 'status' });
        const checkConfig = button(translateUi("核对配置"), 'pi-runtime-config-check', () => void inspectConfiguration());
        const restartButton = button(translateUi("重新打开运行实例"), 'pi-runtime-restart', async () => {
            if (!configValue || context().busy || !context().connected) return;
            if (!confirm(translateUi("重新打开此线程的运行实例以应用已保存的配置？对话与当前草稿保留，延迟发送将暂停。"))) return;
            const value = configValue, parent = key(); restartButton.disabled = true;
            try { await restart(value); if (parent === key()) feedback.textContent = translateUi("已接受，正在重新打开；请等待连接恢复后核对配置。"); }
            catch (e) { if (parent === key()) feedback.textContent = e.message; }
        });
        const configPanel = node('div', undefined, { class: 'native-runtime-config' }); configPanel.append(feedback, checkConfig, restartButton);
        section.querySelector('.native-runtime-actions').before(configPanel);
        const trustBanner = node('div', undefined, { id: 'pi-project-resource-notice', class: 'pi-project-resource-notice' });
        trustBanner.hidden = true;
        trustBanner.append(node('span', translateUi("此项目的 Skills、扩展与项目设置尚未获准加载。")), button(translateUi("查看项目信任"), '', () => openTrust(context().cwd)), button(translateUi("暂不处理"), '', () => { trustBanner.hidden = true; }));
        $('pi-pending-ui-banner').before(trustBanner);
        async function inspectConfiguration() {
            const c = context(); if (!c.connected || !c.configurationSupported) return;
            const n = ++configEpoch, parent = key(); checkConfig.disabled = true;
            try {
                const value = await configuration(); if (n !== configEpoch || parent !== key() || !context().connected) return;
                configValue = value;
                feedback.textContent = value.matchesSavedConfig === null ? translateUi("无法核对本实例的启动配置；可在空闲时重新打开实例后核对。") : value.matchesSavedConfig ? translateUi("配置文件与本实例启动时一致。资源文件内容修改后，可重新加载资源。") : translateUi("已保存的配置与当前实例不同。重新打开运行实例后应用；仅刷新网页不会生效。");
                feedback.dataset.state = value.matchesSavedConfig === null ? 'unknown' : value.matchesSavedConfig ? 'current' : 'changed';
                const trust = value.trust;
                trustBanner.hidden = !(trust.requiresTrust && !value.actualProjectTrusted && trust.decision === null && trust.override === null && trust.defaultPolicy === 'ask');
                restartButton.hidden = value.ephemeral;
                restartButton.disabled = c.busy || Boolean(value.recoveries || value.drafts);
            } catch (e) { if (n === configEpoch && parent === key()) { feedback.textContent = translateUi("配置状态暂时无法核对：") + e.message; feedback.dataset.state = 'unknown'; } }
            finally { if (n === configEpoch) checkConfig.disabled = false; }
        }
        window.addEventListener('pi:native-config-saved', event => {
            const c = context(), change = event.detail || {};
            if (change.scope === 'global' || change.cwd === c.cwd) void inspectConfiguration();
        });
        const key = () => { const c = context(); return JSON.stringify([c.cwd, c.sessionId, c.generation]); };
        const trustValid = (n, parent) => dialog.open && n === dialogEpoch && parent === key();
        async function loadTrust(cwd, n, parent) {
            body.replaceChildren(node('p', translateUi("正在读取项目信任…")));
            try {
                const snapshot = await apiFetch('/api/pi/settings/native?cwd=' + encodeURIComponent(cwd));
                if (!trustValid(n, parent)) return;
                const trust = snapshot.trust;
                $('pi-project-trust-name').textContent = cwd.split('/').filter(Boolean).at(-1) || cwd;
                body.replaceChildren(node('p', cwd, { class: 'native-trust-path' }));
                const state = node('span', trust.effective ? translateUi("已信任") : translateUi("未信任"), { id: 'native-trust-state', class: 'native-trust-badge', 'data-trusted': String(trust.effective) });
                body.append(state, node('p', translateUi("以上为按配置推导的状态；当前运行实例的实际信任请在会话详情查看。")), node('p', translateUi("信任后，Pi 可以加载这个项目的设置、Skills 和扩展。扩展可执行代码，请只信任熟悉的来源。")));
                const actions = node('div', undefined, { class: 'native-trust-actions' });
                async function save(decision, b) {
                    if (!trustValid(n, parent)) return;
                    if (decision === true && !confirm(translateUi("信任项目 {0}？允许加载其中的扩展和资源。", cwd))) return;
                    const buttons = [...body.querySelectorAll('button')]; for (const item of buttons) item.disabled = true;
                    message.textContent = translateUi("正在保存…");
                    try {
                        await apiFetch('/api/pi/settings/native/trust', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd, decision, confirmed: true, expectedRevision: snapshot.revision }) });
                        void inspectConfiguration();
                        if (!trustValid(n, parent)) return;
                        const refreshed = await loadTrust(cwd, n, parent);
                        if (trustValid(n, parent)) message.textContent = refreshed ? translateUi("已保存，新运行实例生效。已有线程请在任务结束后 /quit，再重新打开。") : translateUi("已保存，但状态读取失败。请重新读取核对。");
                    } catch (e) { if (trustValid(n, parent)) message.textContent = e.message; }
                    finally { for (const item of buttons) if (item.isConnected) item.disabled = false; }
                }
                const allow = button(translateUi("信任此项目"), 'native-trust-allow', () => save(true, allow)); allow.className = 'native-trust-primary';
                const deny = button(translateUi("不信任"), 'native-trust-deny', () => save(false, deny));
                allow.disabled = trust.savedPath === snapshot.cwd && trust.decision === true;
                deny.disabled = trust.savedPath === snapshot.cwd && trust.decision === false;
                actions.append(allow, deny); body.append(actions);
                const details = node('details', undefined, { class: 'native-trust-details' }); details.append(node('summary', translateUi("继承与生效范围")));
                details.append(node('p', trust.savedPath ? translateUi("信任决定来自：") + trust.savedPath : translateUi("未单独设置，使用默认策略。")));
                const policyNames = { ask: translateUi("询问（Web 未决项目暂不加载受信资源）"), always: translateUi("默认信任"), never: translateUi("默认不信任") };
                details.append(node('p', translateUi("全局默认策略：") + (policyNames[trust.defaultPolicy] || trust.defaultPolicy || translateUi("未知"))));
                if (snapshot.schema.defaultProjectTrust) details.append(button(translateUi("设置全局默认策略"), 'native-trust-global', () => {
                    dialog.close();
                    window.dispatchEvent(new CustomEvent('workspace:open-settings', { detail: { tab: 'native', setting: 'defaultProjectTrust' } }));
                }));
                details.append(node('p', translateUi("默认策略仅在没有其他适用决定时使用，已有项目或父目录决定仍有效。保存不会重启当前会话，项目信任不等同于工具权限隔离。")));
                const reset = button(translateUi("恢复继承"), 'native-trust-reset', () => save(null, reset)); details.append(reset); body.append(details);
                if (trust.override !== null) body.append(node('p', translateUi("运行环境已将信任固定为") + (trust.override ? translateUi("允许") : translateUi("拒绝")) + translateUi("；这里保存的选择暂不会改变该结果。"), { class: 'native-trust-notice' }));
                return true;
            } catch (e) { if (trustValid(n, parent)) { body.replaceChildren(button(translateUi("重新读取"), '', () => loadTrust(cwd, n, parent))); message.textContent = e.message; } return false; }
        }
        function openTrust(cwd) {
            if (!context().trustSupported || !cwd) return;
            if (!dialog.open) returnFocus = document.activeElement;
            trustContext = key();
            const n = ++dialogEpoch;
            $('pi-project-trust-name').textContent = cwd.split('/').filter(Boolean).at(-1) || cwd;
            message.textContent = ''; if (!dialog.open) dialog.showModal();
            void loadTrust(cwd, n, trustContext);
        }
        dialog.addEventListener('close', () => { if (dialog.open) return; dialogEpoch++; body.replaceChildren(); message.textContent = ''; if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); returnFocus = null; });
        $('pi-project-trust-close').addEventListener('click', () => dialog.close());
        window.addEventListener('pi:project-trust', e => { const cwd = e.detail?.cwd; if (typeof cwd === 'string') openTrust(cwd); });
        function updateControls() {
            const c = context(); refresh.disabled = !c.connected || reading;
            reloadButton.disabled = !c.connected || !c.reloadSupported || c.busy || reading;
            reloadButton.title = c.busy ? translateUi("当前任务结束后可重新加载") : translateUi("重新加载已保存的资源配置");
            restartButton.disabled = !c.connected || c.busy || !configValue || Boolean(configValue.recoveries || configValue.drafts);
            configPanel.hidden = !c.configurationSupported;
        }
        async function inventory() {
            const c = context(); if (!c.connected || !c.supported || reading) return;
            const n = ++readEpoch, parent = key(); reading = true; updateControls();
            content.replaceChildren(node('p', translateUi("正在读取当前会话的资源…")));
            try {
                const value = await resources();
                if (n !== readEpoch || parent !== key() || !context().connected) return;
                content.replaceChildren(node('p', translateUi("当前会话的项目资源：{0}", value.projectTrusted ? translateUi("已信任") : translateUi("未信任")), { class: 'native-runtime-trust' }));
                const groups = [
                    [translateUi("项目指令"), value.contextFiles.map(f => f.path)],
                    ['Skills', value.skills.map(s => `${s.name} · ${s.path}`)],
                    [translateUi("命令与模板"), value.commands.map(c => `/${c.name} · ${c.source.path}`)],
                    [translateUi("工具"), value.tools.map(t => `${t.name}${t.active ? '' : translateUi("（未启用）")} · ${t.source.path}`)]
                ];
                for (const [title, items] of groups) {
                    const details = node('details'); details.append(node('summary', `${title}（${items.length}）`));
                    const list = node('ul'); for (const text of items) list.append(node('li', text));
                    if (items.length) details.append(list); else details.append(node('p', translateUi("没有此类资源"))); content.append(details);
                }
                const note = node('details', undefined, { class: 'native-runtime-note' }); note.append(node('summary', translateUi("清单说明")), node('p', translateUi("这里显示当前会话实际加载的来源。配置修改后可能需要重新加载；只注册 hooks 的扩展不在清单中。")), node('p', translateUi("系统提示：{0}{1}。", value.systemPrompt.custom ? translateUi("自定义") : translateUi("Pi 默认"), value.systemPrompt.appended ? translateUi("，含追加指令") : ''))); content.append(note);
            } catch (e) { if (n === readEpoch && parent === key()) content.replaceChildren(node('p', e.message)); }
            finally { if (n === readEpoch) { reading = false; updateControls(); } }
        }
        refresh.addEventListener('click', inventory);
        reloadButton.addEventListener('click', async () => {
            const c = context(); if (!c.connected || c.busy || reading || !c.reloadSupported) return;
            const n = ++readEpoch, parent = key(); reading = true; updateControls(); content.replaceChildren(node('p', translateUi("正在重新加载资源…")));
            try {
                await reload(); if (n !== readEpoch || parent !== key()) return;
                reading = false; await inventory();
            } catch (e) { if (n === readEpoch && parent === key()) content.replaceChildren(node('p', e.message + translateUi("；未自动重试。"))); }
            finally { if (n === readEpoch) { reading = false; updateControls(); } }
        });
        section.addEventListener('toggle', () => { if (section.open && !content.childElementCount) void inventory(); });
        function sync() {
            const c = context(), next = key(); section.hidden = !c.supported || !c.connected;
            if (next !== identity || !c.connected) {
                readEpoch++; reading = false; content.replaceChildren(); section.open = false; identity = next;
            }
            if (configIdentity !== (c.connected ? next : '')) {
                configEpoch++; configValue = null; configIdentity = c.connected ? next : ''; trustBanner.hidden = true; feedback.textContent = '';
                if (c.connected && c.configurationSupported) void inspectConfiguration();
            }
            if (dialog.open && trustContext !== next) dialog.close();
            updateControls();
        }
        sync(); return { openTrust, sync, inspectConfiguration, resourcesChanged() { if (!reading && content.childElementCount) content.replaceChildren(node('p', translateUi("资源已更新，刷新清单查看当前加载情况。"))); } };
    }
    window.PiNativeContext = { create };
})();
