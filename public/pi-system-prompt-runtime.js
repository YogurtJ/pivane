(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, i) => values[i] ?? `{${i}}`));
    const $ = id => document.getElementById(id);
    const { node, button } = window.PiNativeUI;
    const kinds = ['append', 'base'];
    const scopeTitle = scope => scope === 'global' ? translateUi("所有项目") : translateUi("当前项目");
    const icon = name => node('i', undefined, { class: `fa-solid fa-${name}`, 'aria-hidden': 'true' });
    const openSettings = (scope = 'global', kind = 'append') => window.dispatchEvent(new CustomEvent('workspace:open-settings', { detail: { tab: 'system-prompts', promptKind: kind, promptScope: scope } }));
    async function copy(text) {
        if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
        const field = node('textarea'); field.value = text; field.className = 'system-prompt-copy-buffer';
        const parent = $('system-prompt-dialog')?.open ? $('system-prompt-dialog') : document.body;
        const previous = document.activeElement; parent.append(field); field.select();
        try { if (!document.execCommand('copy')) throw new Error(translateUi("复制失败，请手动选择文本")); }
        finally { field.remove(); previous?.focus({ preventScroll: true }); }
    }
    let syncSettings = () => {};
    function createRuntime() {
        const dialog = node('dialog', undefined, { id: 'system-prompt-dialog', 'aria-labelledby': 'system-prompt-dialog-title' });
        const heading = node('header'), dismiss = button(translateUi("关闭"), 'system-prompt-dialog-close', () => dialog.close());
        const caption = node('div'); caption.append(node('h3', translateUi("当前对话的系统提示词"), { id: 'system-prompt-dialog-title' }), node('p', translateUi("查看 AI 在这段对话中收到的工作要求。只读，不会发送消息。")));
        heading.append(caption, dismiss);
        const status = node('p', '', { role: 'status', 'aria-live': 'polite', id: 'system-prompt-runtime-status', class: 'system-prompt-notice' });
        const body = node('div', undefined, { id: 'system-prompt-runtime-body' });
        const toolbar = node('div', undefined, { class: 'system-prompt-actions' });
        const refresh = button(translateUi("刷新"), 'system-prompt-runtime-refresh', () => read(false));
        const reload = button(translateUi("更新当前对话"), 'system-prompt-runtime-reload', () => read(true));
        reload.title = translateUi("重新加载当前对话的全部原生资源，然后核对提示词。不会发送消息。");
        const edit = button(translateUi("修改我的要求"), 'system-prompt-runtime-edit', () => {
            const scope = value?.configured?.append?.scope; dialog.close(); openSettings(scope);
        });
        edit.className = 'system-prompt-primary'; toolbar.append(edit, reload, refresh); dialog.append(heading, toolbar, status, body); document.body.append(dialog);
        // Keep the viewer visible in conversation details, not buried in resource metadata.
        const launch = button('', 'pi-system-prompt-view', () => open(false));
        launch.setAttribute('aria-haspopup', 'dialog');
        launch.setAttribute('aria-controls', 'system-prompt-dialog');
        launch.append(icon('file-lines'), node('span', translateUi("查看系统提示词")), icon('chevron-right'));
        const entry = node('div', undefined, { class: 'pi-inspector-section system-prompt-entry' }); entry.append(launch);
        $('pi-inspector-details').firstElementChild.after(entry);
        let epoch = 0, identity = '', reading = false, value, focus;
        const context = () => window.PiNativeRuntime?.context() || {};
        const key = () => { const c = context(); return JSON.stringify([c.cwd, c.sessionId, c.generation]); };
        function sync() {
            const c = context(); entry.hidden = !c.systemPrompts; launch.disabled = !c.connected;
            if (dialog.open && (identity !== key() || !c.connected)) { dialog.close(); clear(); }
            refresh.disabled = reading || !c.connected; edit.disabled = reading || !value;
            reload.disabled = reading || !c.connected || c.busy;
            syncSettings();
        }
        function clear() { epoch++; reading = false; value = null; body.replaceChildren(); status.textContent = ''; delete status.dataset.state; }
        dialog.addEventListener('close', () => { clear(); if (focus?.isConnected) focus.focus({ preventScroll: true }); });
        window.addEventListener('pi:system-prompts-saved', e => {
            if (dialog.open && (e.detail.scope === 'global' || e.detail.cwd === context().cwd)) status.textContent = translateUi("提示词文件已保存，请重新核对当前实例。");
        });
        function render(snapshot) {
            value = snapshot;
            const tabs = node('div', undefined, { class: 'system-prompt-editor-tabs', role: 'group', 'aria-label': translateUi("内容视图") });
            const sources = node('div', undefined, { class: 'system-prompt-runtime-sources' }), full = node('div', undefined, { class: 'system-prompt-reader' }); sources.hidden = true;
            const sourceTab = button(translateUi("组成与来源"), 'system-prompt-sources-tab', () => { sources.hidden = false; full.hidden = true; sourceTab.setAttribute('aria-pressed', 'true'); bodyTab.setAttribute('aria-pressed', 'false'); });
            const bodyTab = button(translateUi("完整提示词"), 'system-prompt-full-tab', () => { sources.hidden = true; full.hidden = false; sourceTab.setAttribute('aria-pressed', 'false'); bodyTab.setAttribute('aria-pressed', 'true'); });
            sourceTab.setAttribute('aria-pressed', 'false'); bodyTab.setAttribute('aria-pressed', 'true'); tabs.append(bodyTab, sourceTab);
            const metadata = node('p', translateUi("读取时间：{0}", new Date(snapshot.capturedAt).toLocaleString()), { class: 'system-prompt-metadata' });
            body.replaceChildren(tabs, metadata);
            for (const kind of kinds) {
                const section = node('details'), configured = snapshot.configured?.[kind];
                section.append(node('summary', kind === 'append' ? translateUi("我的要求") : translateUi("基础提示")), node('p', configured ? translateUi("按文件与当前信任推导的来源：{0}", configured.scope === 'default' ? translateUi("Pi 默认") : scopeTitle(configured.scope)) : translateUi("文件来源暂时无法核对")));
                section.append(node('pre', (kind === 'base' ? snapshot.customPrompt : snapshot.appendSystemPrompt) ?? (kind === 'base' ? translateUi("使用 Pi 默认基础提示，完整内容见提示正文。") : translateUi("没有追加指令"))));
                const origin = node('details'); origin.append(node('summary', translateUi("文件位置与范围说明")));
                if (configured?.path) origin.append(node('code', configured.path));
                origin.append(node('p', translateUi("来源路径为配置推导；内容相同不代表能识别启动参数或扩展的来源。"))); section.append(origin);
                section.append(button(translateUi("编辑提示词设置"), '', () => { dialog.close(); openSettings(configured?.scope, kind); })); sources.append(section);
            }
            const files = node('details'); files.append(node('summary', translateUi("项目上下文文件（{0}）", snapshot.contextFiles.length)));
            for (const file of snapshot.contextFiles) {
                const item = node('details'); item.append(node('summary', file.path), node('pre', file.content)); files.append(item);
            }
            sources.append(files);
            const skills = node('details'); skills.append(node('summary', `Skills (${snapshot.skills.length})`));
            for (const skill of snapshot.skills) skills.append(node('p', `${skill.name} · ${skill.path}`)); sources.append(skills);
            sources.append(node('p', translateUi("实际启用工具：{0}", snapshot.activeTools.join(', '))), node('p', snapshot.cwd), node('p', translateUi("当前会话的项目资源：{0}", snapshot.projectTrusted ? translateUi("已信任") : translateUi("未信任"))));
            const search = node('input', undefined, { type: 'search', placeholder: translateUi("搜索提示正文"), 'aria-label': translateUi("搜索提示正文") });
            const found = node('p', '', { role: 'status' }), text = node('pre', snapshot.body, { class: 'system-prompt-full', tabindex: '0', 'aria-label': translateUi("完整提示词") });
            search.addEventListener('input', () => {
                const term = search.value; text.replaceChildren(); let start = 0, count = 0;
                if (term) { let at;
                    while (count < 500 && (at = snapshot.body.indexOf(term, start)) !== -1) {
                        text.append(document.createTextNode(snapshot.body.slice(start, at)), node('mark', snapshot.body.slice(at, at + term.length))); start = at + term.length; count++;
                    }
                }
                text.append(document.createTextNode(snapshot.body.slice(start))); found.textContent = term ? translateUi("匹配 {0} 处（最多标记 500 处）", count) : '';
                text.querySelector('mark')?.scrollIntoView({ block: 'nearest' });
            });
            const copyButton = button(translateUi("复制全文"), 'system-prompt-copy', async () => {
                try { await copy(snapshot.body); if (value === snapshot && dialog.open) status.textContent = translateUi("已复制"); }
                catch (e) { if (value === snapshot && dialog.open) status.textContent = e.message; }
            });
            copyButton.prepend(icon('copy'));
            const searchRow = node('div', undefined, { class: 'system-prompt-search' }); searchRow.append(search, copyButton);
            full.append(searchRow, found, text); body.append(sources, full, node('p', translateUi("此处为 Pi 当前提示快照。扩展可逐轮修改提示，供应商请求改写不包含在此视图中。")));
        }
        async function read(apply) {
            if (reading || !context().connected || apply && context().busy) return;
            const n = ++epoch, parent = key(); reading = true; sync();
            status.textContent = apply ? translateUi("正在重新加载资源…") : translateUi("正在读取系统提示词…");
            delete status.dataset.state; body.replaceChildren(); value = null;
            if (!apply && window.PiSkeleton) { status.textContent = ''; body.innerHTML = window.PiSkeleton.html('lines', { rows: 6, label: translateUi("正在读取系统提示词…") }); }
            let loaded = false;
            try {
                if (apply) { await window.PiNativeRuntime.reload(); loaded = true; }
                if (n !== epoch || parent !== key() || !dialog.open) return;
                const snapshot = await window.PiNativeRuntime.systemPrompt();
                if (n !== epoch || parent !== key() || !dialog.open) return;
                render(snapshot);
                status.textContent = snapshot.matchesSavedFiles === null ? translateUi("已读取当前提示，但无法核对磁盘文件。") : snapshot.matchesSavedFiles ? translateUi("当前基础与追加内容和已保存文件一致。") : translateUi("当前加载内容或信任与保存状态不同。请检查来源，必要时重新加载或重新打开运行实例。");
                status.dataset.state = snapshot.matchesSavedFiles === true ? 'matched' : 'check';
            } catch (e) { if (n === epoch && parent === key() && dialog.open) status.textContent = (loaded ? translateUi("资源已重新加载，但提示词核对失败。请点击刷新核对。") : '') + e.message; }
            finally { if (n === epoch) { body.querySelector('.pv-skeleton')?.remove(); reading = false; sync(); } }
        }
        function open(apply = false) {
            if (!context().connected || !context().systemPrompts) return;
            if (!dialog.open) { focus = document.activeElement; identity = key(); dialog.showModal(); }
            void read(apply);
        }
        window.addEventListener('workspace:access-locked', () => { dialog.close(); clear(); sync(); });
        const runtime = { sync, open, clear, setSettingsSync(callback) { syncSettings = callback; } };
        window.PiSystemPromptRuntime = runtime; sync();
        return runtime;
    }
    const start = () => { if (!window.PiSystemPromptRuntime) createRuntime(); };
    window.PiSystemPromptViewer = { start };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
})();
