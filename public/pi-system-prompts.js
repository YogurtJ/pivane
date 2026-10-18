(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, i) => values[i] ?? `{${i}}`));
    const $ = id => document.getElementById(id);
    const { node, button, select, label } = window.PiNativeUI;
    const kinds = ['append', 'base'];
    const title = kind => kind === 'append' ? translateUi("我的要求") : translateUi("高级：替换基础提示词");
    const scopeTitle = scope => scope === 'global' ? translateUi("所有项目") : translateUi("当前项目");
    const inheritedTitle = scope => scope === 'global' ? translateUi("未添加额外要求") : translateUi("沿用所有项目的要求");
    const icon = name => node('i', undefined, { class: `fa-solid fa-${name}`, 'aria-hidden': 'true' });
    const openSettings = (scope = 'global', kind = 'append') => window.dispatchEvent(new CustomEvent('workspace:open-settings', { detail: { tab: 'system-prompts', promptKind: kind, promptScope: scope } }));
    function preview(target, text) {
        target.replaceChildren();
        if (!text) { target.append(node('p', translateUi("还没有额外要求。可以直接输入，或从示例开始。"))); return; }
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
            const caption = node('div'); caption.append(node('h3', translateUi("系统提示词")), node('p', translateUi("告诉 AI 你希望它怎样回答、怎样做事。这里的要求会持续使用，不必每次重复。")));
            const refresh = button(translateUi("刷新并核对草稿"), 'system-prompts-refresh', async () => {
                if (writing) return;
                const n = ++epoch;
                const controls = [...panel.querySelectorAll('button,select,textarea')].map(e => [e, e.disabled]);
                controls.forEach(([e]) => { e.disabled = true; });
                status.textContent = translateUi("正在读取配置…");
                try {
                    const next = await apiFetch('/api/pi/settings/system-prompts?cwd=' + encodeURIComponent(cwd));
                    if (!valid(n, cwd)) return;
                    // Only explicit reconciliation rebases retained edits against disk.
                    for (const s of ['global', 'project']) for (const k of kinds) {
                        const draft = value.drafts[s][k];
                        if (dirty(draft) || draft.uncertain) {
                            draft.original = next.files[s][k].content; draft.revision = next.revision; draft.uncertain = false;
                        }
                    }
                    render(cwd, remember(next, value), translateUi("已读取磁盘内容并保留草稿，请查看修改差异后保存。"));
                } catch (e) {
                    if (valid(n, cwd)) { status.textContent = e.message; controls.forEach(([e, disabled]) => { e.disabled = disabled; }); syncSettings(); }
                }
            });
            refresh.className = 'settings-header-refresh'; refresh.prepend(icon('rotate'));
            const headingActions = node('div', undefined, { class: 'settings-header-actions' });
            const viewRuntime = button(translateUi("查看当前对话"), 'system-prompts-view-runtime', () => runtime.open(false));
            viewRuntime.prepend(icon('file-lines')); headingActions.append(viewRuntime, refresh);
            heading.append(icon('sliders'), caption, headingActions);
            const scopeRow = node('section', undefined, { class: 'system-prompt-scope', 'aria-label': translateUi("应用范围") });
            scopeRow.append(node('h4', translateUi("1 · 这些要求用在哪里？")));
            const scopeOptions = node('div', undefined, { id: 'system-prompts-scope', class: 'system-prompt-scope-options' });
            for (const s of currentCwd() ? ['global', 'project'] : ['global']) {
                const option = button('', '', () => { selectedScope = s; render(cwd, value); });
                option.dataset.scope = s; option.setAttribute('aria-pressed', String(s === scope)); option.disabled = writing;
                const text = node('span'); text.append(node('strong', s === 'global' ? scopeTitle(s) : translateUi("当前项目 · {0}", cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd)), node('small', s === 'global' ? translateUi("通用的回复偏好与工作习惯") : translateUi("只为这个项目设置不同要求")));
                option.append(icon(s === 'global' ? 'globe' : 'folder-open'), text, icon('check')); scopeOptions.append(option);
            }
            scopeRow.append(scopeOptions);
            const status = node('p', message, { id: 'system-prompts-status', role: 'status', 'aria-live': 'polite', class: 'system-prompt-notice' });
            panel.replaceChildren(heading, scopeRow, status);
            const forbidden = scope === 'project' && !snapshot.trust.effective;
            if (forbidden) {
                const warning = node('div', undefined, { class: 'system-prompt-notice' });
                warning.append(node('p', translateUi("此项目未信任，项目提示词暂不加载；信任后可保存。")), button(translateUi("管理项目信任"), '', () => window.dispatchEvent(new CustomEvent('pi:project-trust', { detail: { cwd } })))); panel.append(warning);
            }
            for (const kind of kinds) {
                const draft = value.drafts[scope][kind], file = snapshot.files[scope][kind], isBase = kind === 'base';
                const inherited = scope === 'project' ? snapshot.files.global[kind].content ?? '' : '';
                const card = node(isBase ? 'details' : 'section', undefined, { class: 'system-prompt-card', 'data-prompt-kind': kind });
                if (isBase && (dirty(draft) || focusKind === kind)) card.open = true;
                const cardHeading = node(isBase ? 'summary' : 'header', undefined, { class: 'system-prompt-card-heading' });
                cardHeading.append(node(isBase ? 'strong' : 'h4', isBase ? title(kind) : translateUi("2 · 希望 AI 怎么配合你？")));
                const state = node('span', '', { class: 'system-prompt-state' }); cardHeading.append(state); card.append(cardHeading);
                const form = node('form');
                const mode = isBase ? select([['inherit', scope === 'global' ? translateUi("Pi 默认") : translateUi("继承全局")], ['custom', translateUi("使用本层内容")]], draft.content === null ? 'inherit' : 'custom', 'system-prompt-base-mode') : null;
                const editor = node('textarea', undefined, { rows: '9', spellcheck: 'false', id: `system-prompt-${kind}-text`, 'aria-label': title(kind), 'aria-describedby': `system-prompt-${kind}-help system-prompt-${kind}-validation`, placeholder: translateUi("例如：先给我结论，再解释原因。遇到不确定的地方请直接说明。") });
                editor.value = draft.content === null ? inherited : draft.text;
                const source = node('details', undefined, { class: 'system-prompt-source' });
                source.append(node('summary', translateUi("文件位置与范围说明")), node('code', file.path));
                if (scope === 'project') source.append(node('p', translateUi("全局内容")), node('pre', snapshot.files.global[kind].content ?? translateUi("未设置，使用 Pi 默认。")));
                else if (snapshot.files.project[kind].content !== null && snapshot.trust.effective) source.append(node('p', translateUi("当前项目已有专属设置，会优先使用项目内容。修改这里不会覆盖它。")));
                const views = node('div', undefined, { class: 'system-prompt-editor-tabs', role: 'group', 'aria-label': translateUi("内容视图") });
                const display = node('div', undefined, { class: 'system-prompt-preview', hidden: '' });
                const validation = node('p', '', { id: `system-prompt-${kind}-validation`, class: 'system-prompt-validation', role: 'status' });
                const meter = node('span', '', { class: 'system-prompt-meter' });
                const helper = node('p', '', { id: `system-prompt-${kind}-help`, class: 'system-prompt-help' });
                let view = 'edit';
                const currentText = () => draft.content ?? inherited;
                const update = () => {
                    const bytes = new TextEncoder().encode(draft.content ?? '').length;
                    const invalid = draft.content !== null && (!draft.content.trim() || draft.content.includes('\0') || bytes > snapshot.maxBytes);
                    editor.hidden = view !== 'edit'; editor.disabled = forbidden || writing || isBase && mode.value === 'inherit';
                    display.hidden = view === 'edit';
                    if (view === 'preview') preview(display, currentText());
                    if (view === 'changes') changes(display, draft.original, draft.content);
                    state.textContent = draft.uncertain ? translateUi("需要核对") : dirty(draft) ? translateUi("未保存") : draft.content === null ? (isBase ? translateUi("Pi 默认") : inheritedTitle(scope)) : translateUi("已保存");
                    state.dataset.dirty = String(dirty(draft) || draft.uncertain);
                    helper.textContent = isBase ? translateUi("替换 Pi 默认基础行为说明。项目上下文和 Skills 仍可能追加；工具权限由工具配置控制。") : scope === 'project' ? (draft.content === null ? translateUi("下方显示所有项目的要求。直接修改即可为此项目定制；保存后将替代通用要求，不会自动叠加。") : translateUi("这里的内容只用于当前项目，会替代所有项目的通用要求，不会自动叠加。")) : translateUi("保留 AI 默认能力，只补充你的偏好。有专属要求的项目会优先使用项目设置。");
                    validation.textContent = draft.uncertain ? translateUi("保存结果需要核对。请先刷新并核对草稿，不要重复提交。") : invalid ? translateUi("要求不能为空、包含空字符或超过 64 KiB。要移除要求，请使用恢复按钮。") : '';
                    editor.setAttribute('aria-invalid', String(invalid));
                    meter.textContent = translateUi("{0} 字符", Array.from(currentText()).length);
                    save.disabled = forbidden || writing || draft.uncertain || invalid || !dirty(draft);
                    save.textContent = dirty(draft) && draft.content === null ? translateUi("保存恢复操作") : translateUi("保存要求");
                    discard.hidden = !dirty(draft) || draft.uncertain;
                    reset.disabled = forbidden || writing || draft.content === null;
                    for (const b of views.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === view));
                    for (const b of examples.querySelectorAll('button')) b.disabled = forbidden || writing;
                };
                for (const [id, text] of [['edit', translateUi("编辑")], ['preview', translateUi("阅读预览")], ['changes', translateUi("修改差异")]]) {
                    const b = button(text, '', () => { view = id; update(); }); b.dataset.view = id; views.append(b);
                }
                const examples = node('div', undefined, { class: 'system-prompt-examples' });
                if (!isBase) {
                    examples.append(node('span', translateUi("试试添加")));
                    const samples = [
                        [translateUi("简洁回答"), translateUi("请简洁回答，优先给出重点，避免重复和不必要的铺垫。")],
                        [translateUi("先给结论"), translateUi("请先给出结论或建议，再解释原因；需要时用具体例子帮助我理解。")],
                        [translateUi("修改前先说明"), translateUi("修改文件前，请先简要说明计划与影响范围；遇到可能丢失数据的操作，先征求我的确认。")]
                    ];
                    for (const [name, text] of samples) {
                        const sample = button(name, '', () => {
                            const previous = currentText();
                            if (!previous.split('\n').includes(text)) { draft.text = (previous ? previous.trimEnd() + '\n\n' : '') + text; draft.content = draft.text; editor.value = draft.text; }
                            view = 'edit'; update(); editor.focus();
                        });
                        sample.title = text; sample.prepend(icon('plus')); examples.append(sample);
                    }
                }
                editor.addEventListener('input', () => { draft.text = editor.value; draft.content = editor.value; update(); });
                mode?.addEventListener('change', () => { draft.content = mode.value === 'inherit' ? null : draft.text; editor.value = currentText(); update(); });
                const reset = button(scope === 'global' ? translateUi("恢复默认") : translateUi("沿用所有项目的要求"), `system-prompt-${kind}-reset`, () => {
                    if (mode) mode.value = 'inherit'; draft.content = null; editor.value = inherited; view = 'changes'; update();
                });
                const discard = button(translateUi("撤销本次修改"), `system-prompt-${kind}-discard`, () => {
                    draft.content = draft.original; draft.text = draft.original ?? ''; editor.value = currentText();
                    if (mode) mode.value = draft.content === null ? 'inherit' : 'custom'; view = 'edit'; update();
                });
                const save = node('button', translateUi("保存要求"), { type: 'submit', id: `system-prompt-${kind}-save`, class: 'system-prompt-primary' });
                const footer = node('div', undefined, { class: 'system-prompt-footer' });
                const secondary = node('div', undefined, { class: 'system-prompt-actions' }); secondary.append(reset, discard); footer.append(secondary, save);
                const editorBar = node('div', undefined, { class: 'system-prompt-editor-bar' }); editorBar.append(views, meter);
                form.append(helper);
                if (mode) form.append(label(translateUi("内容来源"), mode));
                else form.append(examples);
                form.append(editorBar, editor, display, validation, footer, source);
                let liveMessage = '';
                form.addEventListener('submit', async e => {
                    e.preventDefault(); if (save.disabled || writing || cwd !== cwdNow()) return;
                    const submitted = draft.content, oldRevision = draft.revision, n = epoch, access = accessGeneration;
                    writing = true;
                    panel.querySelectorAll('button,select,textarea').forEach(e => { e.disabled = true; });
                    status.textContent = translateUi("正在保存…"); save.textContent = translateUi("正在保存…");
                    let committed = false;
                    try {
                        await apiFetch('/api/pi/settings/system-prompts', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd, scope, kind, content: submitted, expectedRevision: oldRevision }) });
                        if (access !== accessGeneration) return;
                        committed = true; draft.original = submitted;
                        window.dispatchEvent(new CustomEvent('pi:system-prompts-saved', { detail: { cwd, scope } }));
                        const next = await apiFetch('/api/pi/settings/system-prompts?cwd=' + encodeURIComponent(cwd));
                        if (access !== accessGeneration) return;
                        // Do not rebase sibling drafts if an external edit changed their baseline.
                        for (const s of ['global', 'project']) for (const k of kinds) {
                            const other = value.drafts[s][k];
                            if (other.revision === oldRevision && next.files[s][k].content === other.original) other.revision = next.revision;
                        }
                        remember(next, value);
                        liveMessage = translateUi("已保存要求。要让当前对话使用新设置，请在空闲时点击「更新当前对话」。");
                    } catch (error) {
                        draft.uncertain = committed || !error.status || error.status === 409 || error.status >= 500;
                        liveMessage = committed ? translateUi("已保存，但读取失败。请刷新核对，勿重复提交。") : error.message;
                        if (valid(n, cwd)) status.textContent = liveMessage;
                    } finally {
                        writing = false;
                        if (active && projects.has(cwdNow())) render(cwdNow(), projects.get(cwdNow()), cwdNow() === cwd ? liveMessage : '');
                    }
                });
                if (mode) mode.disabled = forbidden || writing;
                discard.disabled = forbidden || writing;
                card.append(form); panel.append(card); update();
                if (!isBase) {
                    const apply = node('section', undefined, { class: 'system-prompt-apply' });
                    const intro = node('div'); intro.append(node('h4', translateUi("3 · 让当前对话用上新要求")), node('p', '', { id: 'system-prompts-runtime-hint', 'aria-live': 'polite' }));
                    const reload = button(translateUi("更新当前对话"), 'system-prompts-reload-runtime', () => runtime.open(true));
                    reload.title = translateUi("重新加载当前对话的全部原生资源，然后核对提示词。不会发送消息。"); reload.prepend(icon('rotate'));
                    apply.append(icon('comment-dots'), intro, reload); panel.append(apply);
                }
            }
            if (focusKind) {
                panel.querySelector(`[data-prompt-kind="${focusKind}"]`)?.scrollIntoView({ block: 'nearest' }); focusKind = null;
            }
            syncSettings();
        }
        function syncSettings() {
            const c = window.PiNativeRuntime?.context();
            const same = c?.connected && c.systemPrompts && c.cwd === cwdNow();
            const view = $('system-prompts-view-runtime'), reload = $('system-prompts-reload-runtime'), hint = $('system-prompts-runtime-hint');
            if (view) view.disabled = !same || writing;
            if (reload) reload.disabled = !same || c.busy || writing;
            if (hint) hint.textContent = !same ? translateUi("保存后，新启动的对话会读取这些要求。要更新已有对话，请先连接这个项目中的对话。") : c.busy ? translateUi("当前对话正在工作。你可以先保存要求，等任务结束后再更新，不会打断任务。") : translateUi("保存只更新设置，不会自动改变已打开的对话。更新会重新加载全部原生资源；其他对话需分别更新。");
        }
        async function open() {
            active = true; const n = ++epoch, selected = currentCwd(); panel.replaceChildren(node('p', translateUi("正在读取配置…")));
            if (window.PiSkeleton) panel.innerHTML = window.PiSkeleton.html('lines', { rows: 6, label: translateUi("正在读取配置…") });
            try {
                capabilities = await apiFetch('/api/pi/status'); const cwd = cwdNow();
                if (!valid(n, cwd) || selected !== currentCwd()) return;
                if (!capabilities.systemPrompts) throw new Error(translateUi("当前后端尚未启用系统提示词管理"));
                const snapshot = await apiFetch('/api/pi/settings/system-prompts?cwd=' + encodeURIComponent(cwd));
                if (valid(n, cwd)) {
                    render(cwd, remember(snapshot, projects.get(cwd)));
                }
            } catch (e) { if (active && n === epoch) panel.replaceChildren(node('p', e.message), button(translateUi("重试读取"), '', () => open())); }
        }
        window.PiSystemPromptViewer.start();
        const runtime = window.PiSystemPromptRuntime; runtime.setSettingsSync(syncSettings);
        window.addEventListener('workspace:access-locked', () => { accessGeneration++; projects.clear(); close(); runtime.clear(); panel.replaceChildren(); });
        window.addEventListener('beforeunload', e => { if ([...projects.values()].some(v => Object.values(v.drafts).some(s => Object.values(s).some(dirty)))) { e.preventDefault(); e.returnValue = ''; } });
        function close() { active = false; epoch++; }
        return { open, close, focus(kind, scope) { if (kinds.includes(kind)) focusKind = kind; selectedScope = scope === 'project' ? 'project' : 'global'; } };
    }
    window.PiSystemPrompts = { create };
})();
