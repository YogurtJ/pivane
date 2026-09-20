(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, i) => values[i] ?? `{${i}}`));
    const $ = id => document.getElementById(id);
    const { node, button, select, label } = window.PiNativeUI;
    const kinds = ['append', 'base'];
    const title = kind => kind === 'append' ? translateUi("追加指令") : translateUi("高级：替换基础提示词");
    const scopeTitle = scope => scope === 'global' ? translateUi("所有项目") : translateUi("当前项目");
    const inheritedTitle = scope => scope === 'global' ? translateUi("Pi 默认") : translateUi("继承全局");
    function preview(target, text) {
        target.replaceChildren();
        if (window.marked && window.DOMPurify) target.innerHTML = DOMPurify.sanitize(marked.parse(text), { FORBID_TAGS: ['img', 'style', 'iframe', 'form', 'input', 'button'], FORBID_ATTR: ['style'] });
        else target.textContent = text;
    }
    function changes(target, before, after) {
        const a = (before ?? '').split('\n'), b = (after ?? '').split('\n');
        let start = 0, end = 0;
        while (start < a.length && start < b.length && a[start] === b[start]) start++;
        while (end < a.length - start && end < b.length - start && a[a.length - end - 1] === b[b.length - end - 1]) end++;
        target.replaceChildren(node('p', after === null ? translateUi("保存后移除本层文件，恢复默认或继承。") : before === null ? translateUi("保存后创建本层提示词文件。") : translateUi("以下显示本次替换的文本区域。")));
        if (before === after) { target.append(node('p', translateUi("没有需要保存的修改"))); return; }
        const lines = node('pre', undefined, { class: 'system-prompt-diff' });
        for (const line of a.slice(start, a.length - end)) lines.append(node('span', '- ' + line + '\n', { class: 'prompt-removed' }));
        for (const line of b.slice(start, b.length - end)) lines.append(node('span', '+ ' + line + '\n', { class: 'prompt-added' }));
        target.append(lines);
    }
    async function copy(text) {
        if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
        const field = node('textarea'); field.value = text; field.className = 'system-prompt-copy-buffer';
        const parent = $('system-prompt-dialog')?.open ? $('system-prompt-dialog') : document.body;
        const previous = document.activeElement; parent.append(field); field.select();
        try { if (!document.execCommand('copy')) throw new Error(translateUi("复制失败，请手动选择文本")); }
        finally { field.remove(); previous?.focus({ preventScroll: true }); }
    }
    function create({ apiFetch, currentCwd }) {
        const panel = $('system-prompts-panel');
        document.querySelector('[data-system-prompts-label]').textContent = translateUi("系统提示词");
        let epoch = 0, accessGeneration = 0, active = false, capabilities, selectedScope = 'global', writing = false;
        const projects = new Map();
        let focusKind;
        const cwdNow = () => currentCwd() || capabilities?.defaultProject || capabilities?.projectRoots?.[0] || '';
        const valid = (n, cwd) => active && n === epoch && cwdNow() === cwd;
        const dirty = draft => draft.content !== draft.original;
        const records = snapshot => Object.fromEntries(['global', 'project'].map(scope => [scope, Object.fromEntries(kinds.map(kind => {
            const value = snapshot.files[scope][kind].content;
            return [kind, { content: value, original: value, text: value ?? '', revision: snapshot.revision, uncertain: false }];
        }))]));
        function remember(snapshot, previous) {
            const drafts = records(snapshot);
            if (previous) for (const scope of ['global', 'project']) for (const kind of kinds) {
                const old = previous.drafts[scope][kind];
                if (dirty(old) || old.uncertain) drafts[scope][kind] = old;
            }
            const value = { snapshot, drafts }; projects.set(snapshot.cwd, value); return value;
        }
        function render(cwd, value, message = '') {
            const snapshot = value.snapshot, scope = currentCwd() ? selectedScope : 'global';
            selectedScope = scope;
            const heading = node('div', undefined, { class: 'settings-panel-header' });
            const caption = node('div'); caption.append(node('h3', translateUi("系统提示词")), node('p', translateUi("调整 Agent 的长期工作方式。通常只需追加指令。")));
            const refresh = button(translateUi("刷新并核对草稿"), 'system-prompts-refresh', async () => {
                if (writing) return;
                const n = ++epoch; refresh.disabled = true;
                try {
                    const next = await apiFetch('/api/pi/settings/system-prompts?cwd=' + encodeURIComponent(cwd));
                    if (!valid(n, cwd)) return;
                    // Explicit refresh rebases the retained draft against visible disk content.
                    for (const s of ['global', 'project']) for (const k of kinds) {
                        const draft = value.drafts[s][k];
                        if (dirty(draft) || draft.uncertain) {
                            draft.original = next.files[s][k].content; draft.revision = next.revision; draft.uncertain = false;
                        }
                    }
                    render(cwd, remember(next, value), translateUi("已读取磁盘内容并保留草稿，请查看修改差异后保存。"));
                } catch (e) { if (valid(n, cwd)) $('system-prompts-status').textContent = e.message; }
                finally { if (valid(n, cwd)) refresh.disabled = false; }
            });
            refresh.className = 'settings-header-refresh';
            refresh.prepend(node('i', undefined, { class: 'fa-solid fa-rotate', 'aria-hidden': 'true' }));
            heading.append(node('i', undefined, { class: 'fa-solid fa-file-lines', 'aria-hidden': 'true' }), caption, refresh);
            const scopeSelect = select(currentCwd() ? [['global', scopeTitle('global')], ['project', scopeTitle('project')]] : [['global', scopeTitle('global')]], scope, 'system-prompts-scope');
            scopeSelect.addEventListener('change', () => { selectedScope = scopeSelect.value; render(cwd, value); });
            const scopeRow = node('div', undefined, { class: 'native-scope-row' });
            scopeRow.append(label(translateUi("应用范围"), scopeSelect), node('span', scope === 'project' ? cwd : translateUi("作为所有项目的默认配置"), { class: 'native-scope-hint' }));
            const status = node('p', message, { id: 'system-prompts-status', role: 'status', 'aria-live': 'polite' });
            panel.replaceChildren(heading, scopeRow, node('p', translateUi("项目文件优先于全局文件；项目追加指令不会与全局追加指令自动叠加。")), status);
            const forbidden = scope === 'project' && !snapshot.trust.effective;
            if (forbidden) panel.append(node('p', translateUi("此项目未信任，项目提示词暂不加载；信任后可保存。")), button(translateUi("管理项目信任"), '', () => window.dispatchEvent(new CustomEvent('pi:project-trust', { detail: { cwd } }))));
            for (const kind of kinds) {
                const draft = value.drafts[scope][kind], file = snapshot.files[scope][kind];
                const card = node(kind === 'base' ? 'details' : 'section', undefined, { class: 'system-prompt-card', 'data-prompt-kind': kind });
                if (kind === 'base' && (dirty(draft) || focusKind === kind)) card.open = true;
                card.append(node(kind === 'base' ? 'summary' : 'h4', title(kind)));
                const form = node('form');
                const mode = select([['inherit', inheritedTitle(scope)], ['custom', translateUi("使用本层内容")]], draft.content === null ? 'inherit' : 'custom', `system-prompt-${kind}-mode`);
                const editor = node('textarea', undefined, { rows: '10', spellcheck: 'false', id: `system-prompt-${kind}-text`, 'aria-label': title(kind) }); editor.value = draft.text;
                const state = node('p', '', { class: 'system-prompt-state' });
                const source = node('details', undefined, { class: 'system-prompt-source' });
                source.append(node('summary', translateUi("文件与继承来源")), node('code', file.path));
                if (scope === 'project') {
                    source.append(node('p', translateUi("全局内容")), node('pre', snapshot.files.global[kind].content ?? translateUi("未设置，使用 Pi 默认。")));
                }
                const views = node('div', undefined, { class: 'system-prompt-actions' }), display = node('div', undefined, { class: 'system-prompt-preview', hidden: '' });
                let view = 'edit';
                const currentText = () => draft.content ?? (scope === 'project' ? snapshot.files.global[kind].content : '') ?? '';
                const update = () => {
                    editor.hidden = view !== 'edit'; editor.disabled = forbidden || writing || mode.value === 'inherit';
                    display.hidden = view === 'edit';
                    if (view === 'preview') preview(display, currentText());
                    if (view === 'changes') changes(display, draft.original, draft.content);
                    state.textContent = dirty(draft) ? translateUi("有未保存的修改") : draft.content === null ? inheritedTitle(scope) : translateUi("已保存的文件内容；当前会话需单独核对加载状态。");
                    save.disabled = forbidden || writing || draft.uncertain || !dirty(draft);
                    for (const b of views.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === view));
                };
                for (const [id, text] of [['edit', translateUi("编辑")], ['preview', translateUi("预览")], ['changes', translateUi("修改差异")]]) {
                    const b = button(text, '', () => { view = id; update(); }); b.dataset.view = id; views.append(b);
                }
                editor.addEventListener('input', () => { draft.text = editor.value; draft.content = editor.value; update(); });
                mode.addEventListener('change', () => { draft.content = mode.value === 'inherit' ? null : draft.text; update(); });
                const reset = button(scope === 'global' ? translateUi("恢复默认") : translateUi("恢复继承"), `system-prompt-${kind}-reset`, () => { mode.value = 'inherit'; draft.content = null; view = 'changes'; update(); });
                const save = node('button', translateUi("保存修改"), { type: 'submit', id: `system-prompt-${kind}-save`, class: 'system-prompt-primary' });
                const footer = node('div', undefined, { class: 'system-prompt-actions' }); footer.append(reset, save);
                form.append(node('p', kind === 'append' ? translateUi("保留 Pi 默认行为，补充回复偏好与工作习惯。") : translateUi("替换 Pi 默认基础行为说明。项目上下文和 Skills 仍可能追加；工具权限由工具配置控制。")), label(translateUi("内容来源"), mode), state, source, views, editor, display, footer);
                let liveMessage = '';
                form.addEventListener('submit', async e => {
                    e.preventDefault(); if (save.disabled || writing || cwd !== cwdNow()) return;
                    const submitted = draft.content, oldRevision = draft.revision, n = epoch, access = accessGeneration;
                    writing = true;
                    const controls = [...panel.querySelectorAll('button,select,textarea')].map(e => [e, e.disabled]); controls.forEach(([e]) => { e.disabled = true; });
                    status.textContent = translateUi("正在保存…");
                    let committed = false;
                    try {
                        await apiFetch('/api/pi/settings/system-prompts', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd, scope, kind, content: submitted, expectedRevision: oldRevision }) });
                        if (access !== accessGeneration) return;
                        committed = true; draft.original = submitted;
                        window.dispatchEvent(new CustomEvent('pi:system-prompts-saved', { detail: { cwd, scope } }));
                        const next = await apiFetch('/api/pi/settings/system-prompts?cwd=' + encodeURIComponent(cwd));
                        if (access !== accessGeneration) return;
                        // Only carry sibling revisions forward when their original disk
                        // contents are unchanged. External edits keep the old CAS revision.
                        for (const s of ['global', 'project']) for (const k of kinds) {
                            const other = value.drafts[s][k];
                            if (other.revision === oldRevision && next.files[s][k].content === other.original) other.revision = next.revision;
                        }
                        remember(next, value);
                        liveMessage = translateUi("已保存。当前会话尚未核对；空闲时可重新加载并核对。");
                    } catch (error) {
                        draft.uncertain = committed || !error.status || error.status >= 500;
                        liveMessage = committed ? translateUi("已保存，但读取失败。请刷新核对，勿重复提交。") : error.message;
                        if (valid(n, cwd)) status.textContent = liveMessage;
                    } finally {
                        writing = false;
                        if (active && projects.has(cwdNow())) {
                            render(cwdNow(), projects.get(cwdNow()), cwdNow() === cwd ? liveMessage : '');
                        }
                    }
                });
                mode.disabled = forbidden || writing; reset.disabled = forbidden || writing;
                card.append(form); panel.append(card); update();
            }
            const actions = node('div', undefined, { class: 'system-prompt-actions' });
            actions.append(button(translateUi("查看当前会话的系统提示词"), 'system-prompts-view-runtime', () => runtime.open(false)), button(translateUi("重新加载并核对"), 'system-prompts-reload-runtime', () => runtime.open(true)));
            panel.append(node('p', translateUi("保存不会中断任务。重新加载会更新当前会话的全部原生资源，其他已打开会话需分别加载。")), actions);
            if (focusKind) {
                panel.querySelector(`[data-prompt-kind="${focusKind}"]`)?.scrollIntoView({ block: 'nearest' }); focusKind = null;
            }
            syncSettings();
        }
        function syncSettings() {
            const c = window.PiNativeRuntime?.context();
            const same = c?.connected && c.systemPrompts && c.cwd === cwdNow();
            const view = $('system-prompts-view-runtime'), reload = $('system-prompts-reload-runtime');
            if (view) view.disabled = !same || writing;
            if (reload) reload.disabled = !same || c.busy || writing;
        }
        async function open() {
            active = true; const n = ++epoch, selected = currentCwd(); panel.replaceChildren(node('p', translateUi("正在读取配置…")));
            try {
                capabilities = await apiFetch('/api/pi/status'); const cwd = cwdNow();
                if (!valid(n, cwd) || selected !== currentCwd()) return;
                if (!capabilities.systemPrompts) throw new Error(translateUi("当前后端尚未启用系统提示词管理"));
                const snapshot = await apiFetch('/api/pi/settings/system-prompts?cwd=' + encodeURIComponent(cwd));
                if (valid(n, cwd)) render(cwd, remember(snapshot, projects.get(cwd)));
            } catch (e) { if (active && n === epoch) panel.replaceChildren(node('p', e.message), button(translateUi("重试读取"), '', () => open())); }
        }
        const runtime = createRuntime(syncSettings);
        window.addEventListener('workspace:access-locked', () => { accessGeneration++; projects.clear(); close(); runtime.clear(); panel.replaceChildren(); });
        window.addEventListener('beforeunload', e => { if ([...projects.values()].some(v => Object.values(v.drafts).some(s => Object.values(s).some(dirty)))) { e.preventDefault(); e.returnValue = ''; } });
        function close() { active = false; epoch++; }
        return { open, close, focus(kind, scope) { if (kinds.includes(kind)) focusKind = kind; selectedScope = scope === 'project' ? 'project' : 'global'; } };
    }
    function createRuntime(syncSettings) {
        const dialog = node('dialog', undefined, { id: 'system-prompt-dialog', 'aria-labelledby': 'system-prompt-dialog-title' });
        const heading = node('header'), dismiss = button(translateUi("关闭"), 'system-prompt-dialog-close', () => dialog.close());
        heading.append(node('h3', translateUi("当前运行实例的系统提示"), { id: 'system-prompt-dialog-title' }), dismiss);
        const status = node('p', '', { role: 'status', id: 'system-prompt-runtime-status' }), body = node('div', undefined, { id: 'system-prompt-runtime-body' });
        const toolbar = node('div', undefined, { class: 'system-prompt-actions' });
        const refresh = button(translateUi("刷新"), 'system-prompt-runtime-refresh', () => read(false));
        const reload = button(translateUi("重新加载并核对"), 'system-prompt-runtime-reload', () => read(true));
        toolbar.append(refresh, reload); dialog.append(heading, toolbar, status, body); document.body.append(dialog);
        const launch = button(translateUi("查看系统提示词"), 'pi-system-prompt-view', () => open(false));
        $('pi-loaded-resources').querySelector('.native-runtime-actions').append(launch);
        let epoch = 0, identity = '', reading = false, value, focus;
        const context = () => window.PiNativeRuntime?.context() || {};
        const key = () => { const c = context(); return JSON.stringify([c.cwd, c.sessionId, c.generation]); };
        function sync() {
            const c = context(); launch.hidden = !c.systemPrompts; launch.disabled = !c.connected;
            if (dialog.open && (identity !== key() || !c.connected)) { dialog.close(); clear(); }
            refresh.disabled = reading || !c.connected;
            reload.disabled = reading || !c.connected || c.busy;
            syncSettings();
        }
        function clear() { epoch++; reading = false; value = null; body.replaceChildren(); status.textContent = ''; }
        dialog.addEventListener('close', () => { clear(); if (focus?.isConnected) focus.focus({ preventScroll: true }); });
        window.addEventListener('pi:system-prompts-saved', e => {
            if (dialog.open && (e.detail.scope === 'global' || e.detail.cwd === context().cwd)) status.textContent = translateUi("提示词文件已保存，请重新核对当前实例。");
        });
        function render(snapshot) {
            value = snapshot;
            const tabs = node('div', undefined, { class: 'system-prompt-actions' });
            const sources = node('div', undefined, { class: 'system-prompt-runtime-sources' }), full = node('div'); full.hidden = true;
            const sourceTab = button(translateUi("来源"), '', () => { sources.hidden = false; full.hidden = true; sourceTab.setAttribute('aria-pressed', 'true'); bodyTab.setAttribute('aria-pressed', 'false'); });
            const bodyTab = button(translateUi("提示正文"), '', () => { sources.hidden = true; full.hidden = false; sourceTab.setAttribute('aria-pressed', 'false'); bodyTab.setAttribute('aria-pressed', 'true'); });
            sourceTab.setAttribute('aria-pressed', 'true'); bodyTab.setAttribute('aria-pressed', 'false'); tabs.append(sourceTab, bodyTab);
            body.replaceChildren(node('p', snapshot.cwd), node('p', translateUi("当前会话的项目资源：{0}", snapshot.projectTrusted ? translateUi("已信任") : translateUi("未信任"))), node('p', translateUi("读取时间：{0}", new Date(snapshot.capturedAt).toLocaleString())), tabs);
            for (const kind of kinds) {
                const section = node('details'), configured = snapshot.configured?.[kind];
                section.append(node('summary', title(kind)), node('p', configured ? translateUi("按文件与当前信任推导的来源：{0}", configured.scope === 'default' ? translateUi("Pi 默认") : scopeTitle(configured.scope)) : translateUi("文件来源暂时无法核对")));
                if (configured?.path) section.append(node('code', configured.path));
                section.append(node('p', translateUi("来源路径为配置推导；内容相同不代表能识别启动参数或扩展的来源。")), node('pre', (kind === 'base' ? snapshot.customPrompt : snapshot.appendSystemPrompt) ?? (kind === 'base' ? translateUi("使用 Pi 默认基础提示，完整内容见提示正文。") : translateUi("没有追加指令"))));
                section.append(button(translateUi("编辑提示词设置"), '', () => { dialog.close(); window.dispatchEvent(new CustomEvent('workspace:open-settings', { detail: { tab: 'system-prompts', promptKind: kind, promptScope: configured?.scope } })); }));
                sources.append(section);
            }
            const files = node('details'); files.append(node('summary', translateUi("项目上下文文件（{0}）", snapshot.contextFiles.length)));
            for (const file of snapshot.contextFiles) {
                const item = node('details'); item.append(node('summary', file.path), node('pre', file.content)); files.append(item);
            }
            sources.append(files);
            const skills = node('details'); skills.append(node('summary', `Skills (${snapshot.skills.length})`));
            for (const skill of snapshot.skills) skills.append(node('p', `${skill.name} · ${skill.path}`)); sources.append(skills);
            sources.append(node('p', translateUi("实际启用工具：{0}", snapshot.activeTools.join(', '))));
            const search = node('input', undefined, { type: 'search', placeholder: translateUi("搜索提示正文"), 'aria-label': translateUi("搜索提示正文") });
            const found = node('p', '', { role: 'status' }), text = node('pre', snapshot.body, { class: 'system-prompt-full' });
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
            full.append(search, copyButton, found, text); body.append(sources, full, node('p', translateUi("此处为 Pi 当前提示快照。扩展可逐轮修改提示，供应商请求改写不包含在此视图中。")));
        }
        async function read(apply) {
            if (reading || !context().connected || apply && context().busy) return;
            const n = ++epoch, parent = key(); reading = true; sync();
            status.textContent = apply ? translateUi("正在重新加载资源…") : translateUi("正在读取系统提示词…");
            body.replaceChildren(); value = null;
            let loaded = false;
            try {
                if (apply) { await window.PiNativeRuntime.reload(); loaded = true; }
                if (n !== epoch || parent !== key() || !dialog.open) return;
                const snapshot = await window.PiNativeRuntime.systemPrompt();
                if (n !== epoch || parent !== key() || !dialog.open) return;
                render(snapshot);
                status.textContent = snapshot.matchesSavedFiles === null ? translateUi("已读取当前提示，但无法核对磁盘文件。") : snapshot.matchesSavedFiles ? translateUi("当前基础与追加内容和已保存文件一致。") : translateUi("当前加载内容或信任与保存状态不同。请检查来源，必要时重新加载或重新打开运行实例。");
            } catch (e) { if (n === epoch && parent === key() && dialog.open) status.textContent = (loaded ? translateUi("资源已重新加载，但提示词核对失败。请点击刷新核对。") : '') + e.message; }
            finally { if (n === epoch) { reading = false; sync(); } }
        }
        function open(apply = false) {
            if (!context().connected || !context().systemPrompts) return;
            if (!dialog.open) { focus = document.activeElement; identity = key(); dialog.showModal(); }
            void read(apply);
        }
        window.PiSystemPromptRuntime = { sync, open, clear }; sync();
        return { open, clear };
    }
    window.PiSystemPrompts = { create };
})();
