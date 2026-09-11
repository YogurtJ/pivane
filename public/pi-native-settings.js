(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const $ = id => document.getElementById(id);
    const node = (tag, text, attrs = {}) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
    const button = (text, id, action) => { const b = node('button', text, { type: 'button', ...(id ? { id } : {}) }); b.addEventListener('click', action); return b; };
    const select = (items, value, id) => { const s = node('select', undefined, id ? { id } : {}); for (const [v, text] of items) s.append(node('option', text, { value: v })); s.value = value; return s; };
    const label = (text, field) => { const l = node('label', text); l.append(field); return l; };
    const scopes = [['global', translateUi("所有项目")], ['project', translateUi("当前项目")]];
    const groups = [
        ['messages', translateUi("消息与模型"), translateUi("消息投递方式、常用模型范围"), 'fa-comment-dots', k => ['steeringMode', 'followUpMode', 'enabledModels'].includes(k)],
        ['tools', translateUi("工具"), translateUi("默认启用的内置工具与项目继承"), 'fa-toolbox', k => k === 'defaultTools'],
        ['trust', translateUi("项目信任"), translateUi("未决项目的全局默认策略"), 'fa-shield-halved', k => k === 'defaultProjectTrust'],
        ['context', translateUi("上下文"), translateUi("自动压缩与保留内容"), 'fa-layer-group', k => k.startsWith('compaction.')],
        ['images', translateUi("图片"), translateUi("自动缩放与图片输入"), 'fa-image', k => k.startsWith('images.')],
        ['connection', translateUi("连接与重试"), translateUi("连接方式、失败重试与超时"), 'fa-plug', k => k === 'transport' || k.startsWith('retry.') || k.endsWith('TimeoutMs')],
        ['privacy', translateUi("隐私与诊断"), translateUi("安装遥测与环境覆盖"), 'fa-shield-halved', k => k === 'enableInstallTelemetry'],
        ['other', translateUi("其他选项"), translateUi("其他原生设置"), 'fa-sliders', () => true]
    ];
    window.PiNativeUI = { node, button, select, label };
    function create({ apiFetch, currentCwd }) {
        let epoch = 0, resourceRequest = 0, skillRequest = 0, capabilities, config, focusKey;
        const panel = $('native-settings-panel'), packagePanel = $('native-packages'), skillPanel = $('native-skills');
        const status = (id, text) => { const e = $(id); if (e) e.textContent = text; };
        const contextCwd = () => currentCwd() || capabilities?.defaultProject || capabilities?.projectRoots?.[0] || '';
        const availableScopes = () => currentCwd() ? scopes : scopes.slice(0, 1);
        const valid = (n, cwd) => n === epoch && cwd === contextCwd() && !$('workspace-settings-dialog').classList.contains('hidden');
        const send = (url, method, data) => {
            if (data.cwd && data.cwd !== contextCwd()) throw new Error(translateUi("项目已切换，请重新打开设置"));
            return apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(result => {
                window.dispatchEvent(new CustomEvent('pi:native-config-saved', { detail: { cwd: data.cwd, scope: data.scope } }));
                return result;
            });
        };
        async function act(b, fn, statusId) {
            const n = epoch, cwd = contextCwd(); b.disabled = true;
            try { await fn(); } catch (e) { if (valid(n, cwd)) status(statusId, e.message); }
            finally { if (b.isConnected) b.disabled = false; }
        }
        function trustLink(cwd) { return button(translateUi("管理项目信任"), '', () => window.dispatchEvent(new CustomEvent('pi:project-trust', { detail: { cwd } }))); }
        function fieldValue(field, spec) {
            if (spec.type === 'tools') return JSON.parse(field.value);
            if (field.value === '') return null;
            if (spec.type === 'boolean') return field.value === 'true';
            if (spec.type === 'number') return Number(field.value);
            if (spec.type === 'lines') return field.value === '[]' ? [] : field.value.split('\n').map(s => s.trim()).filter(Boolean);
            return field.value;
        }
        function toolField(spec, current, scope, disabled) {
            const wrapper = node('div', undefined, { class: 'native-tool-field' });
            const field = node('input', undefined, { type: 'hidden' });
            const saved = current[scope]; field.value = JSON.stringify(saved);
            const mode = select([['inherit', scope === 'project' ? translateUi("继承全局") : translateUi("Pi 默认")], ['custom', translateUi("自定义")]], saved === null ? 'inherit' : 'custom', 'native-tools-mode');
            mode.disabled = disabled;
            wrapper.append(label(translateUi("工具选择方式"), mode));
            const list = node('fieldset', undefined, { class: 'native-tool-options' });
            list.append(node('legend', translateUi("内置工具")));
            const inherited = scope === 'project' ? current.global ?? spec.defaults : spec.defaults;
            let customSelection = saved ?? inherited;
            const selected = new Set(customSelection);
            // Preserve unknown existing names visibly; saving a changed list still needs server validation.
            for (const name of [...new Set([...spec.choices, ...inherited, ...selected])]) {
                const check = node('input', undefined, { type: 'checkbox', value: name });
                check.checked = selected.has(name);
                const caption = node('span', name + (!spec.choices.includes(name) ? translateUi("（当前版本不支持）") : name === 'powershell' ? translateUi("（需 PowerShell）") : ''));
                const row = node('label'); row.append(check, caption); list.append(row);
            }
            const summary = node('small', '', { id: 'native-tools-selection', 'aria-live': 'polite' });
            const update = () => {
                list.disabled = disabled || mode.value !== 'custom';
                const chosen = [...list.querySelectorAll('input:checked')].map(c => c.value);
                field.value = JSON.stringify(mode.value === 'custom' ? chosen : null);
                summary.textContent = mode.value === 'custom' ? chosen.length ? translateUi("已选择 {0} 个内置工具", chosen.length) : translateUi("未启用任何内置工具；扩展和自定义工具仍可启用。") : scope === 'project' ? translateUi("移除项目覆盖，使用全局配置或 Pi 默认。") : translateUi("Pi 默认：{0}", spec.defaults.join('、'));
            };
            mode.addEventListener('change', () => {
                if (mode.value === 'inherit') customSelection = [...list.querySelectorAll('input:checked')].map(c => c.value);
                const visible = new Set(mode.value === 'custom' ? customSelection : inherited);
                for (const check of list.querySelectorAll('input')) check.checked = visible.has(check.value);
                update();
            });
            list.addEventListener('change', update); update();
            field.value = JSON.stringify(saved); // Keep the original order until the user edits this field.
            wrapper.append(list, summary, field);
            return { wrapper, field };
        }
        function settingsForm(snapshot) {
            const scope = $('native-settings-scope').value, form = $('native-settings-form');
            const expanded = new Set([...form.querySelectorAll('details[open]')].map(d => d.dataset.group));
            form.replaceChildren();
            const used = new Set();
            for (const [id, title, description, icon, matches] of groups) {
                const fields = Object.entries(snapshot.schema).filter(([k, spec]) => !used.has(k) && matches(k) && !(scope === 'project' && spec.globalOnly));
                if (!fields.length) continue;
                const section = node('details', undefined, { class: 'native-setting-group', 'data-group': id });
                section.open = expanded.has(id) || fields.some(([k]) => k === focusKey);
                const heading = node('summary'), caption = node('span', undefined, { class: 'native-group-caption' });
                caption.append(node('strong', title), node('small', description));
                const count = fields.filter(([k]) => snapshot.settings[k][scope] !== null).length;
                heading.append(node('i', '', { class: `fa-solid ${icon}`, 'aria-hidden': 'true' }), caption, node('span', count ? translateUi("{0} 项自定义", count) : translateUi("默认"), { class: 'native-setting-count' }));
                const grid = node('div', undefined, { class: 'native-grid' });
                for (const [key, spec] of fields) {
                    used.add(key);
                    const current = snapshot.settings[key], saved = current[scope]; let field, tool;
                    if (spec.type === 'tools') {
                        tool = toolField(spec, current, scope, scope === 'project' && !snapshot.trust.effective); field = tool.field;
                    } else if (spec.type === 'select' || spec.type === 'boolean') {
                        const names = { ask: translateUi("询问（Pi 默认）"), always: translateUi("默认信任"), never: translateUi("默认不信任"), all: translateUi("全部投递"), 'one-at-a-time': translateUi("逐条投递"), auto: translateUi("自动选择") };
                        const choices = spec.choices?.map(v => [v, names[v] || v]) || [['true', translateUi("开启")], ['false', translateUi("关闭")]];
                        field = select([['', scope === 'project' ? translateUi("继承全局") : translateUi("Pi 默认")], ...choices], saved === null ? '' : String(saved));
                    } else {
                        field = node(spec.type === 'lines' ? 'textarea' : 'input');
                        if (spec.type === 'number') { field.type = 'number'; field.min = spec.min; field.max = spec.max; field.step = 1; }
                        if (spec.type === 'lines') { field.rows = 3; field.placeholder = translateUi("每行一个模型名称或匹配模式"); }
                        else field.placeholder = current.value === null ? translateUi("使用默认值") : String(current.value);
                        field.value = saved === null ? '' : Array.isArray(saved) ? saved.join('\n') || '[]' : String(saved);
                    }
                    field.name = key; field.dataset.initial = JSON.stringify(saved); field.disabled = scope === 'project' && !snapshot.trust.effective;
                    const row = tool ? tool.wrapper : label(translateUi(spec.label), field);
                    const value = key === 'defaultProjectTrust' ? ({ ask: translateUi("询问"), always: translateUi("默认信任"), never: translateUi("默认不信任") }[current.value] || current.value) : spec.type === 'tools' ? current.value?.join('、') || translateUi("未启用任何内置工具") : typeof current.value === 'boolean' ? current.value ? translateUi("开启") : translateUi("关闭") : Array.isArray(current.value) ? current.value.join('、') || translateUi("未限定") : current.value ?? translateUi("默认");
                    row.append(node('small', translateUi("当前配置：{0} · {1}", value, { project: translateUi("项目"), global: translateUi("全局"), default: translateUi("Pi 默认") }[current.source]))); grid.append(row);
                }
                if (id === 'tools') {
                    grid.append(node('p', translateUi("只选择模型初始可用的内置工具。扩展和自定义工具仍可启用；这不是只读或安全模式，也不控制手动 ! Shell。当前实际工具可在会话详情 → 当前加载的资源中查看。"), { class: 'native-setting-help' }));
                    const view = button(translateUi("查看当前实例的工具"), 'native-tools-runtime', () => {
                        const resources = $('pi-loaded-resources');
                        if (!resources || resources.hidden) return status('native-status', translateUi("请先打开会话，再查看当前实例的工具。"));
                        $('workspace-settings-close').click(); $('pi-details-tab').click(); resources.open = true;
                        resources.scrollIntoView({ block: 'nearest' });
                    });
                    view.disabled = !$('pi-loaded-resources') || $('pi-loaded-resources').hidden;
                    view.title = view.disabled ? translateUi("打开会话后可查看") : translateUi("读取当前实例实际启用的工具，不应用配置");
                    grid.append(view);
                }
                if (id === 'trust') {
                    grid.append(node('p', translateUi("仅作用于没有其他适用决定的项目，已有项目或父目录的允许／拒绝仍有效。Web 的 RPC 不弹出启动询问：选择“询问”时，未决项目的受信资源暂不加载，可从项目菜单或 /trust 授权。"), { class: 'native-setting-help' }));
                    if (currentCwd()) grid.append(node('p', translateUi("当前项目按配置推导：{0}。{1} 当前运行实例的实际状态在会话详情查看，扩展也可能参与信任决定。", snapshot.trust.effective ? translateUi("已信任") : translateUi("未信任"), snapshot.trust.override !== null ? translateUi("运行环境已固定信任决定。") : snapshot.trust.savedPath ? translateUi("信任决定来自：") + snapshot.trust.savedPath + '。' : translateUi("使用全局默认策略。")), { class: 'native-setting-help' }), trustLink(snapshot.cwd));
                }
                if (id === 'privacy') {
                    const env = snapshot.environment || {};
                    grid.append(node('p', translateUi("Web 会话已关闭版本检查。{0}{1}", env.offline ? translateUi("当前启用离线启动。") : '', env.telemetry !== null && env.telemetry !== undefined ? translateUi("环境变量将遥测固定为") + (env.telemetry ? translateUi("开启。") : translateUi("关闭。")) : translateUi("遥测独立于版本检查。"))));
                }
                section.append(heading, grid); form.append(section);
            }
            const save = node('button', translateUi("保存修改"), { type: 'submit', id: 'native-settings-save', class: 'settings-primary-button' });
            save.disabled = scope === 'project' && !snapshot.trust.effective;
            const footer = node('div', undefined, { class: 'native-save-row' }); footer.append(node('small', translateUi("修改后保存，新运行实例生效；已有线程请在任务结束后 /quit，再重新打开。")), save);
            footer.append(button(translateUi("查看当前实例的生效状态"), 'native-show-runtime-config', () => {
                if (!$('pi-loaded-resources') || $('pi-loaded-resources').hidden) return status('native-status', translateUi("请先打开线程，再查看运行实例。"));
                $('workspace-settings-close').click(); $('pi-details-tab').click(); $('pi-loaded-resources').open = true;
                $('pi-runtime-config-check')?.click();
            })); form.append(footer);
            if (focusKey) { form.querySelector(`[name="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true }); focusKey = null; }
            form.onsubmit = e => {
                e.preventDefault(); const n = epoch, cwd = snapshot.cwd, values = {};
                for (const field of form.querySelectorAll('[name]')) { const value = fieldValue(field, snapshot.schema[field.name]); if (JSON.stringify(value) !== field.dataset.initial) values[field.name] = value; }
                if (!Object.keys(values).length) return status('native-status', translateUi("没有需要保存的修改"));
                const before = [...form.querySelectorAll('[name]')].map(f => [f.name, f.value]);
                if (save.disabled) return;
                const controls = [...form.querySelectorAll('input, select, textarea, button, fieldset'), $('native-settings-scope'), $('native-refresh')].map(f => [f, f.disabled]);
                for (const [f] of controls) f.disabled = true;
                let committed = false;
                void act(save, async () => {
                    await send('/api/pi/settings/native', 'PUT', { cwd, scope, values, expectedRevision: config.revision });
                    committed = true;
                    if (!valid(n, cwd)) return;
                    const next = await apiFetch('/api/pi/settings/native?cwd=' + encodeURIComponent(cwd));
                    if (!valid(n, cwd)) return; config = next;
                    const unchanged = $('native-settings-scope').value === scope && form.isConnected && JSON.stringify([...form.querySelectorAll('[name]')].map(f => [f.name, f.value])) === JSON.stringify(before);
                    if (unchanged) settingsForm(next);
                    else for (const field of $('native-settings-form').querySelectorAll('[name]')) field.dataset.initial = JSON.stringify(next.settings[field.name][$('native-settings-scope').value]);
                    status('native-status', translateUi("已保存，新运行实例生效。已有线程请在任务结束后 /quit，再重新打开。"));
                }, 'native-status').finally(() => {
                    for (const [f, disabled] of controls) if (f.isConnected) f.disabled = disabled;
                    if (committed && valid(n, cwd) && config === snapshot) {
                        form.replaceChildren(node('p', translateUi("已保存，但配置读取失败。请点击刷新核对，勿重复提交。")));
                        status('native-status', translateUi("已保存，但配置读取失败。请刷新核对。"));
                    }
                });
            };
        }
        async function loadNative(n, cwd) {
            panel.replaceChildren(node('p', translateUi("正在读取配置…")));
            const snapshot = await apiFetch('/api/pi/settings/native?cwd=' + encodeURIComponent(cwd)); if (!valid(n, cwd)) return;
            config = snapshot;
            const heading = node('div', undefined, { class: 'settings-panel-header' }), caption = node('div');
            caption.append(node('h3', translateUi("Pi 配置")), node('p', currentCwd() ? translateUi("通常无需修改。需要时展开对应分类即可。") : translateUi("尚未选择项目，可先管理全局配置；选择项目后可设置项目覆盖。")));
            heading.append(caption, button(translateUi("刷新"), 'native-refresh', () => open('native')));
            const scope = select(availableScopes(), 'global', 'native-settings-scope');
            const scopeRow = node('div', undefined, { class: 'native-scope-row' });
            const hint = node('span', '', { class: 'native-scope-hint' });
            const updateScope = () => { hint.replaceChildren(node('span', scope.value === 'global' ? translateUi("作为所有项目的默认配置") : cwd)); if (scope.value === 'project' && !config.trust.effective) hint.append(node('span', translateUi("信任此项目后可保存项目配置。")), trustLink(cwd)); settingsForm(config); };
            scope.addEventListener('change', updateScope); scopeRow.append(label(translateUi("应用范围"), scope), hint);
            panel.replaceChildren(heading, scopeRow, node('form', undefined, { id: 'native-settings-form' }), node('p', '', { id: 'native-status', role: 'status', 'aria-live': 'polite' }));
            updateScope();
        }
        async function loadSkills(n, cwd, scope = $('native-skills-scope')?.value || 'global') {
            const request = ++skillRequest;
            for (const b of skillPanel.querySelectorAll('.native-skill-row button, #native-skills-search')) b.disabled = true;
            const active = () => valid(n, cwd) && request === skillRequest;
            try {
                const [snapshot, metadata] = await Promise.all([
                    apiFetch(`/api/pi/settings/native/resources?cwd=${encodeURIComponent(cwd)}&scope=${scope}`),
                    apiFetch('/api/pi/settings/resources?cwd=' + encodeURIComponent(cwd))
                ]);
                if (!active()) return;
                skillPanel.replaceChildren();
                const choice = select(availableScopes(), scope, 'native-skills-scope'); choice.setAttribute('aria-label', translateUi("Skill 应用范围"));
                choice.addEventListener('change', () => void loadSkills(n, cwd, choice.value));
                const search = node('input', undefined, { type: 'search', placeholder: translateUi("搜索 Skill"), 'aria-label': translateUi("搜索 Skill"), id: 'native-skills-search' });
                const toolbar = node('div', undefined, { class: 'native-skills-toolbar' });
                toolbar.append(search, choice, button(translateUi("刷新"), 'native-skills-refresh', () => loadSkills(n, cwd, choice.value)));
                const note = node('p', translateUi("停用会保留文件。选择会保存到所选范围，重新加载资源或下次打开会话后生效。"), { class: 'native-help' });
                skillPanel.append(toolbar, note);
                const disabled = scope === 'project' && !snapshot.trust.effective;
                if (disabled) { const hint = node('div', undefined, { class: 'native-scope-hint' }); hint.append(node('span', translateUi("当前项目未信任，暂不能修改此范围。")), trustLink(cwd)); skillPanel.append(hint); }
                const list = node('div', undefined, { class: 'native-skills-list' });
                skillPanel.append(node('p', '', { id: 'native-skills-status', role: 'status', 'aria-live': 'polite' }), list);
                const byPath = new Map((metadata.skills || []).map(s => [s.filePath, s]));
                const skills = snapshot.resources.filter(r => r.type === 'skills').map(r => {
                    const info = byPath.get(r.path), parts = r.path.split('/');
                    return { ...r, name: info?.name || (parts.at(-1) === 'SKILL.md' ? parts.at(-2) : parts.at(-1).replace(/\.md$/i, '')), description: info?.description };
                });
                let limit = 40;
                const render = () => {
                    const query = search.value.trim().toLowerCase(), found = skills.filter(s => `${s.name} ${s.description || ''} ${s.path} ${s.source}`.toLowerCase().includes(query));
                    list.replaceChildren();
                    for (const skill of found.slice(0, limit)) {
                        const row = node('article', undefined, { class: 'native-skill-row', 'data-skill-id': skill.id, 'data-enabled': String(skill.enabled) });
                        const main = node('div', undefined, { class: 'native-skill-main' }), title = node('div', undefined, { class: 'native-skill-title' });
                        title.append(node('strong', skill.name), node('span', skill.enabled ? translateUi("已启用") : translateUi("已停用"), { class: 'native-skill-badge' })); main.append(title);
                        if (skill.description) main.append(node('p', skill.description));
                        const info = node('details', undefined, { class: 'native-skill-source' }); info.append(node('summary', skill.scope === 'project' ? translateUi("来自项目 · 查看来源") : translateUi("全局资源 · 查看来源")), node('p', skill.source), node('code', skill.path)); main.append(info);
                        const actions = node('div', undefined, { class: 'native-skill-actions' });
                        async function change(state, b) {
                            if (!active()) return;
                            if (state === 'on' && !confirm(translateUi("启用 {0}？Skill 的指令和脚本会影响 Agent 行为。", skill.name))) return;
                            const controls = [...skillPanel.querySelectorAll('button, select')]; for (const c of controls) c.disabled = true;
                            await act(b, async () => {
                                await send('/api/pi/settings/native/resources', 'PUT', { cwd, scope, resourceId: skill.id, state, expectedRevision: snapshot.revision, confirmed: true });
                                if (!active()) return;
                                const refreshed = await loadSkills(n, cwd, scope);
                                if (valid(n, cwd) && $('native-skills-scope')?.value === scope) status('native-skills-status', refreshed ? translateUi("已保存。重新加载资源或下次打开会话后生效。") : translateUi("已保存，但列表读取失败。请刷新核对，不要重复提交。"));
                            }, 'native-skills-status');
                            for (const c of controls) if (c.isConnected) c.disabled = disabled && c.closest('.native-skill-row') !== null;
                        }
                        const toggle = button(skill.enabled ? translateUi("停用") : translateUi("启用"), '', () => change(skill.enabled ? 'off' : 'on', toggle)); toggle.className = 'native-skill-toggle'; toggle.setAttribute('aria-label', `${skill.enabled ? translateUi("停用") : translateUi("启用")} ${skill.name}`); toggle.disabled = disabled; actions.append(toggle);
                        if (scope === 'project' && skill.override !== 'inherit') { const reset = button(translateUi("恢复继承"), '', () => change('inherit', reset)); reset.disabled = disabled; actions.append(reset); }
                        row.append(main, actions); list.append(row);
                    }
                    if (!found.length) list.append(node('p', query ? translateUi("没有匹配的 Skill") : translateUi("此范围没有发现 Skill。可以让 Agent 帮你安装或整理。"), { class: 'settings-empty' }));
                    if (found.length > limit) list.append(button(translateUi("显示更多（剩余 {0} 项）", found.length - limit), '', () => { limit += 40; render(); }));
                };
                search.addEventListener('input', () => { limit = 40; render(); }); render(); return true;
            } catch (e) { if (active()) {
                if (!$('native-skills-status')) skillPanel.replaceChildren(node('p', '', { id: 'native-skills-status', role: 'status' }), button(translateUi("重试读取"), '', () => loadSkills(n, cwd, scope)));
                skillPanel.querySelector('.native-skills-list')?.replaceChildren(node('p', translateUi("暂时无法读取配置，请刷新核对。")));
                status('native-skills-status', e.message); return false;
            } }
        }
        async function loadPackages(n, cwd, scope = currentCwd() ? $('native-resource-scope')?.value || 'project' : 'global') {
            const request = ++resourceRequest;
            for (const b of packagePanel.querySelectorAll('button, .native-resource-row select')) b.disabled = true;
            const snapshot = await apiFetch(`/api/pi/settings/native/resources?cwd=${encodeURIComponent(cwd)}&scope=${scope}`); if (!valid(n, cwd) || request !== resourceRequest) return;
            packagePanel.replaceChildren(node('h3', translateUi("Packages 与资源")));
            packagePanel.append(node('p', translateUi("管理资源配置；当前实际加载情况可在会话详情查看。安装或启用的扩展可执行代码，请先审查来源。")));
            const compatibility = node('details', undefined, { class: 'native-runtime-note' });
            compatibility.append(node('summary', translateUi("扩展在网页中的兼容范围")), node('p', translateUi("工具、命令、基础确认／选择／输入／编辑窗口，以及文字状态可通过 Pi RPC 使用。安装成功仅代表配置完成，不代表已验证网页兼容。")), node('p', translateUi("终端专用 custom 界面、编辑器、快捷键和组件式 widget 不会自动转换为网页；启动阶段的阻塞交互在当前上游 RPC 中受限。请优先使用声明支持 RPC 的扩展。"))); packagePanel.append(compatibility);
            const choice = select(availableScopes(), scope, 'native-resource-scope'); choice.addEventListener('change', () => void loadPackages(n, cwd, choice.value).catch(e => { if (valid(n, cwd) && choice.isConnected) status('native-resource-status', e.message); }));
            packagePanel.append(label(translateUi("管理范围"), choice));
            if (!snapshot.trust.effective && scope === 'project') { packagePanel.append(node('p', translateUi("当前项目未信任，项目写入已禁用；可切换所有项目或管理信任。")), trustLink(cwd)); }
            const disabled = scope === 'project' && !snapshot.trust.effective;
            const source = node('input', undefined, { placeholder: translateUi("npm:package@version 或 git:https://…"), 'aria-label': translateUi("Package 来源") });
            const install = button(translateUi("安装"), 'native-package-install', () => packageAction(install, 'install', source.value)); install.disabled = disabled;
            const add = node('div', undefined, { class: 'native-actions' }); add.append(source, install); packagePanel.append(add);
            async function packageAction(b, action, source) {
                if (!confirm(translateUi("{0} {1}（{2}）？包操作可能执行代码；失败后请核对配置，不自动重试。", action, source, scope === 'global' ? translateUi("全局") : translateUi("项目")))) return;
                await act(b, async () => { await send('/api/pi/settings/native/packages', 'POST', { cwd, scope, source, action, expectedRevision: snapshot.revision, confirmed: true }); if (valid(n, cwd) && $('native-resource-scope')?.value === scope) { await loadPackages(n, cwd, scope); status('native-resource-status', translateUi("操作完成；空闲时重新加载资源。")); } }, 'native-resource-status');
            }
            for (const pkg of snapshot.packages) {
                const row = node('div', undefined, { class: 'native-card' }); row.append(node('strong', pkg.source), node('p', `${pkg.scope === 'user' ? translateUi("全局") : translateUi("项目")} · ${pkg.installed ? translateUi("已安装") : translateUi("尚未安装")}`));
                if (pkg.scope === (scope === 'global' ? 'user' : 'project')) for (const [text, action] of [[translateUi("更新"), 'update'], [translateUi("移除"), 'remove']]) { const b = button(text, '', () => packageAction(b, action, pkg.source)); b.disabled = disabled; row.append(b); }
                packagePanel.append(row);
            }
            const search = node('input', undefined, { type: 'search', placeholder: translateUi("筛选资源名称或来源"), 'aria-label': translateUi("筛选资源") }); packagePanel.append(search);
            const list = node('div', undefined, { class: 'native-resource-list' }); packagePanel.append(list); let limit = 40;
            const render = () => {
                list.replaceChildren(); const query = search.value.toLowerCase(), found = snapshot.resources.filter(r => `${r.path} ${r.type} ${r.source}`.toLowerCase().includes(query));
                for (const r of found.slice(0, limit)) {
                    const row = node('div', undefined, { class: 'native-resource-row', 'data-resource-id': r.id });
                    const title = node('div'); title.append(node('strong', r.path.split('/').at(-1)), node('small', `${r.type} · ${r.scope} · ${r.enabled ? translateUi("配置启用") : translateUi("配置停用")}`), node('small', r.path));
                    const value = select([['inherit', translateUi("继承 / 默认")], ['on', translateUi("启用")], ['off', translateUi("停用")]], scope === 'global' ? r.enabled ? 'on' : 'off' : r.override); value.setAttribute('aria-label', r.path + translateUi(" 开关")); value.disabled = disabled;
                    const save = button(translateUi("保存"), '', () => { if (!confirm(translateUi("将 {0} 在{1}设为{2}？", r.path, scope === 'global' ? translateUi("全局") : translateUi("项目"), value.selectedOptions[0].textContent))) return; void act(save, async () => { await send('/api/pi/settings/native/resources', 'PUT', { cwd, scope, resourceId: r.id, state: value.value, expectedRevision: snapshot.revision, confirmed: true }); if (valid(n, cwd) && $('native-resource-scope')?.value === scope) { await loadPackages(n, cwd, scope); status('native-resource-status', translateUi("已保存，空闲时重新加载资源。")); } }, 'native-resource-status'); });
                    save.disabled = disabled; row.append(title, value, save); list.append(row);
                }
                if (found.length > limit) list.append(button(translateUi("显示更多（剩余 {0} 项）", found.length - limit), '', () => { limit += 40; render(); }));
                if (!found.length) list.append(node('p', translateUi("没有匹配资源")));
            };
            search.addEventListener('input', () => { limit = 40; render(); }); render();
            packagePanel.append(node('p', '', { id: 'native-resource-status', role: 'status' }));
        }
        async function open(tab) {
            const n = ++epoch, selected = currentCwd();
            let cwd = contextCwd();
            try {
                capabilities ||= await apiFetch('/api/pi/status');
                cwd = contextCwd();
                if (!valid(n, cwd) || selected !== currentCwd()) return;
                if (!cwd) throw new Error(translateUi("服务器没有可用的项目目录，请检查项目范围设置（PI_PROJECT_ROOTS）。"));
                $('native-settings-nav').hidden = !capabilities.nativeSettings;
                if (tab === 'native') { if (!capabilities.nativeSettings) panel.textContent = translateUi("当前后端尚未启用 Pi 配置"); else await loadNative(n, cwd); }
                if (tab === 'packages' && capabilities.nativeResources) { for (const e of packagePanel.parentElement.children) e.hidden = e !== packagePanel; await loadPackages(n, cwd); }
                if (tab === 'skills' && capabilities.nativeResources) { $('settings-skills-legacy').hidden = true; skillPanel.hidden = false; await loadSkills(n, cwd); }
            } catch (e) { if (valid(n, cwd)) { if (tab === 'native') panel.textContent = e.message; else if (tab === 'packages') { packagePanel.hidden = false; packagePanel.textContent = e.message; } } }
        }
        return { open, focusSetting(key) { focusKey = key; }, close() { epoch++; focusKey = null; } };
    }
    window.PiNativeSettings = { create };
})();
