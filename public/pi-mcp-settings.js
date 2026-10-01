(() => {
    const t = (zh, en) => globalThis.PiI18n?.locale === 'en' ? en : zh;
    const el = (tag, text, attrs = {}) => { const n = document.createElement(tag); if (text != null) n.textContent = text; for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
    const icon = name => el('i', null, { class: `fa-solid ${name}`, 'aria-hidden': 'true' });
    // Icons are decorative and keep each button's accessible name equal to its text.
    const button = (text, fn, { glyph, variant } = {}) => {
        const n = el('button', text, { type: 'button' });
        if (glyph) n.prepend(icon(glyph));
        if (variant) n.classList.add(`mcp-button-${variant}`);
        n.addEventListener('click', fn); return n;
    };
    const select = (items, value) => { const n = el('select'); for (const [v, text] of items) n.append(el('option', text, { value: v })); n.value = value; return n; };
    const label = (text, field) => { const n = el('label', text); n.append(field); return n; };
    const badge = (text, kind = '') => { const n = el('span', text, { class: 'mcp-badge' }); if (kind) n.dataset.kind = kind; return n; };
    const exposures = ['codemode', 'codemode-deferred', 'deferred', 'direct', 'hidden'].map(v => [v, v]);
    // Card heading: icon, title, optional explanation and trailing actions.
    function heading(glyph, title, description, ...actions) {
        const head = el('div', null, { class: 'mcp-card-head' });
        const mark = el('span', null, { class: 'mcp-card-icon' }); mark.append(icon(glyph));
        const copy = el('div', null, { class: 'mcp-card-copy' }); copy.append(el('h3', title));
        if (description) copy.append(el('p', description));
        head.append(mark, copy);
        if (actions.length) { const tail = el('div', null, { class: 'mcp-card-actions' }); tail.append(...actions); head.append(tail); }
        return head;
    }
    function fieldLabel(caption, key, field, wide = false) {
        const n = el('label', null, { class: wide ? 'mcp-field mcp-field-wide' : 'mcp-field' });
        const title = el('span', caption, { class: 'mcp-field-caption' });
        if (key) title.append(el('code', key));
        n.append(title, field); return n;
    }
    function create(host) {
        const root = el('section', null, { class: 'workspace-settings-panel mcp-settings', 'data-settings-panel': 'mcp', 'aria-label': 'MCP' });
        let active = false, epoch = 0, busy = false, blocked = false, snapshot = null, cwd = '', runtime = null, runtimeUncertain = false;
        const scope = select([['global', t('所有项目', 'Global')], ['project', t('当前项目', 'Project')]], 'global');
        scope.setAttribute('aria-label', t('配置范围', 'Configuration scope'));
        const feedback = el('p', '', { role: 'status', class: 'mcp-status' });
        const trust = el('p', null, { class: 'mcp-trust' });
        const saved = el('section', null, { class: 'mcp-card mcp-saved' }), live = el('section', null, { class: 'mcp-card mcp-live' });
        const editor = el('section', null, { class: 'mcp-card mcp-editor', hidden: '' });
        const refresh = button(t('刷新已保存配置', 'Refresh saved configuration'), () => void load(), { glyph: 'fa-rotate' });
        refresh.classList.add('settings-header-refresh');
        const header = el('header', null, { class: 'settings-panel-header mcp-header' });
        const intro = el('div');
        intro.append(el('h3', t('原生 MCP', 'Native MCP')), el('p', t('保存配置与会话连接分别管理。打开此页不会连接服务器或执行命令。', 'Saved configuration and session connections are separate. Opening this page does not connect servers or execute commands.')));
        header.append(icon('fa-plug'), intro, refresh);
        const toolbar = el('div', null, { class: 'mcp-toolbar' });
        const scopeField = el('label', null, { class: 'mcp-scope' }); scopeField.append(el('span', t('配置范围', 'Scope')), scope);
        toolbar.append(scopeField, trust, button(t('管理项目信任', 'Manage project trust'), () => window.dispatchEvent(new CustomEvent('pi:project-trust', { detail: { cwd } })), { glyph: 'fa-shield-halved', variant: 'quiet' }));
        root.append(header, toolbar, feedback, saved, editor, live);
        const writable = () => snapshot && scope.value === snapshot.scope && !busy && !blocked && (snapshot.scope === 'global' || snapshot.trust?.effective === true);
        const context = () => JSON.stringify([host.currentCwd(), host.currentSession?.() || null]);
        const valid = (ticket, key) => active && epoch === ticket && context() === key;
        function controls() { root.querySelectorAll('[data-mcp-write]').forEach(n => { n.disabled = !writable(); }); scope.disabled = busy; refresh.disabled = busy; }
        function session() { const s = host.currentSession?.(); return s?.id && s.runtimeId && s.cwd === cwd ? s : null; }
        const stateKind = state => state === 'connected' ? 'on' : state === 'error' || state === 'failed' ? 'error' : 'off';
        function renderLive() {
            const s = session();
            const read = button(t('读取运行快照', 'Read runtime snapshot'), () => void runtimeAction('snapshot'), { glyph: 'fa-satellite-dish' }); read.disabled = !s || busy;
            live.replaceChildren(heading('fa-wave-square', t('所选会话运行状态', 'Selected session runtime'),
                s ? t('只在明确操作后读取或连接；配置保存不会自动更新此会话。', 'Read or connect only after an explicit action; saving does not update this session.') : t('请选择已打开的会话。此页不会启动 worker。', 'Select an already open session. This page never starts a worker.'), read));
            if (!runtime || runtime.runtimeId !== s?.runtimeId) return;
            const servers = el('div', null, { class: 'mcp-list' });
            for (const server of runtime.servers || []) {
                const row = el('article', null, { class: 'mcp-item' });
                const mark = el('span', null, { class: 'mcp-item-icon' }); mark.append(icon('fa-server'));
                const main = el('div', null, { class: 'mcp-item-main' });
                const title = el('div', null, { class: 'mcp-item-title' });
                title.append(el('strong', server.name), badge(server.state || 'unknown', stateKind(server.state)));
                main.append(title, el('p', `${server.toolCount ?? '?'} tools · ${server.exposure || 'unknown'}`));
                const actions = el('div', null, { class: 'mcp-actions' });
                for (const [action, text, glyph] of [['reconnect', t('重新连接', 'Reconnect'), 'fa-arrows-rotate'], ['login', t('登录 OAuth', 'Sign in with OAuth'), 'fa-right-to-bracket'], ['logout', t('退出 OAuth', 'Sign out of OAuth'), 'fa-right-from-bracket']]) { const b = button(text, () => void runtimeAction(action, server.name), { glyph }); b.disabled = busy || runtimeUncertain; actions.append(b); }
                row.append(mark, main, actions); servers.append(row);
            }
            if (!servers.childElementCount) servers.append(el('p', t('当前会话没有 MCP 服务器。', 'No MCP servers in this session.'), { class: 'mcp-empty' }));
            live.append(servers);
            if (Array.isArray(runtime.tools) && runtime.tools.length) {
                const tools = el('ul', null, { class: 'mcp-tools', 'aria-label': t('工具', 'Tools') });
                for (const tool of runtime.tools) {
                    const item = el('li'); item.append(el('code', tool.name), badge(tool.exposure || 'unknown'), badge(tool.active === true ? 'active' : 'inactive', tool.active === true ? 'on' : 'off'));
                    tools.append(item);
                }
                live.append(tools);
            }
            const footer = el('div', null, { class: 'mcp-footer' });
            footer.append(el('p', t('原生 OAuth 待处理对话在聊天中继续。', 'Continue pending native OAuth dialogs in chat.')), button(t('返回聊天', 'Return to chat'), () => window.PiWorkspaceRoute?.returnToConversation(), { glyph: 'fa-arrow-left', variant: 'quiet' }));
            live.append(footer);
        }
        async function runtimeAction(action, server) {
            if (busy || runtimeUncertain && action !== 'snapshot') return;
            const s = session();
            if (!s || action !== 'snapshot' && runtime?.runtimeId !== s.runtimeId) { runtime = null; renderLive(); return; }
            if (!window.confirm(action === 'snapshot' ? t('读取当前唯一 worker 的 MCP 状态？', 'Read MCP status from the current unique worker?') : t(`确认 ${action} ${server}？可能连接网络或修改原生 OAuth 凭据。结果不确定时不会重试。`, `Confirm ${action} ${server}? This may connect to the network or change native OAuth credentials. Uncertain results are never retried.`))) return;
            const ticket = epoch, key = context(); busy = true; controls(); renderLive();
            try {
                const result = await host.apiFetch(`/api/pi/sessions/${encodeURIComponent(s.id)}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd, runtimeId: s.runtimeId, action, ...(server ? { server } : {}), confirmed: true }) });
                if (!valid(ticket, key)) return;
                if (result.runtimeId !== s.runtimeId || !Array.isArray(result.servers)) throw new Error('Invalid runtime snapshot');
                runtime = result; runtimeUncertain = result.outcome === 'unknown' || result.notices?.some(item => item.kind === 'unknown') === true;
                const failed = result.outcome === 'failed' || result.notices?.some(item => item.kind === 'error') === true;
                feedback.textContent = result.outcome === 'cancelled' ? t('原生授权已取消；未自动重试。', 'Native authorization was cancelled; no automatic retry.')
                    : failed ? t('原生操作未成功；请核对当前状态，不会重试。', 'Native action did not succeed. Check the current state; no retry.')
                    : runtimeUncertain ? t('原生状态未能完整确认；请明确读取快照核对。', 'Native status could not be fully confirmed. Explicitly read a snapshot to check.')
                    : t('运行操作完成。', 'Runtime action completed.');
            } catch { if (valid(ticket, key)) { runtime = null; runtimeUncertain = true; feedback.textContent = t('运行操作失败或结果不确定。请明确读取快照核对；不会自动重试。', 'Runtime action failed or its result is uncertain. Explicitly read a snapshot to check; no automatic retry.'); } }
            finally { busy = false; if (valid(ticket, key)) { controls(); renderLive(); } }
        }
        function setTrust(result) {
            const trusted = result.trust?.effective === true;
            trust.dataset.trusted = String(trusted);
            trust.replaceChildren(icon(trusted ? 'fa-circle-check' : 'fa-lock'), document.createTextNode(t('配置推导信任：', 'Configuration-derived trust: ') + (trusted ? t('受信任', 'trusted') : t('未受信任（项目只读）', 'untrusted (project read-only)'))));
        }
        async function load() {
            if (busy) return;
            if (editor.childElementCount && !window.confirm(t('刷新会清除当前编辑草稿和替换值。确认先丢弃草稿并重新读取？', 'Refresh clears this editing draft and replacement values. Discard the draft and read again?'))) {
                if (snapshot) scope.value = snapshot.scope;
                controls(); return;
            }
            const ticket = ++epoch, key = context(); snapshot = null; runtime = null; editor.replaceChildren(); editor.hidden = true; saved.replaceChildren(); controls(); renderLive();
            feedback.textContent = t('正在读取配置…', 'Reading configuration…');
            try {
                cwd = host.currentCwd() || (await host.apiFetch('/api/pi/status')).defaultProject;
                if (!valid(ticket, key)) return;
                if (!cwd) throw new Error('No project context');
                scope.querySelector('[value="project"]').hidden = !host.currentCwd(); if (!host.currentCwd()) scope.value = 'global';
                const requestScope = scope.value;
                const result = await host.apiFetch(`/api/pi/settings/mcp?cwd=${encodeURIComponent(cwd)}&scope=${requestScope}`);
                if (!valid(ticket, key)) return;
                if (result.cwd !== cwd || result.scope !== requestScope || typeof result.revision !== 'string' || !Array.isArray(result.servers)) throw new Error('Invalid saved configuration');
                snapshot = result; blocked = false;
                setTrust(result);
                feedback.textContent = t('已读取已保存配置；连接状态请在下方显式核对。', 'Saved configuration loaded; explicitly check connections below.'); renderSaved();
            } catch { if (valid(ticket, key)) feedback.textContent = t('无法读取安全配置。请刷新核对。', 'Could not read safe configuration. Refresh to check.'); }
            finally { if (valid(ticket, key)) { controls(); renderLive(); } }
        }
        async function save(change) {
            if (!writable()) return;
            if (!window.confirm(t('确认保存到所选范围？保存不会自动连接或重载。', 'Save to the selected scope? Saving does not connect or reload.'))) return;
            const targetScope = snapshot.scope;
            const ticket = epoch, key = context(); busy = true; controls(); renderLive();
            try {
                await host.apiFetch(`/api/pi/settings/mcp?cwd=${encodeURIComponent(cwd)}&scope=${targetScope}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd, scope: targetScope, expectedRevision: snapshot.revision, confirmed: true, ...change }) });
                if (!valid(ticket, key)) return;
                blocked = true; editor.replaceChildren(); editor.hidden = true;
                feedback.textContent = t('配置已保存。当前运行实例未更新；请刷新配置再核对。', 'Configuration saved. Existing runtimes are unchanged; refresh configuration to check.');
            } catch { if (valid(ticket, key)) { blocked = true; feedback.textContent = t('保存冲突、失败或结果不确定。草稿保留；请先刷新核对，不会重试。', 'Save conflicted, failed or is uncertain. Draft retained; refresh to check first. No retry.'); } }
            finally { busy = false; if (valid(ticket, key)) { controls(); renderLive(); } }
        }
        function writeButton(text, fn, options) { const b = button(text, fn, options); b.dataset.mcpWrite = ''; return b; }
        function renderSaved() {
            saved.replaceChildren(heading('fa-server', t('已保存配置', 'Saved configuration'), t('mcp.json 中的服务器。保存不会自动连接或重载会话。', 'Servers in mcp.json. Saving does not connect or reload sessions.'),
                writeButton(t('添加服务器', 'Add server'), () => edit(), { glyph: 'fa-plus', variant: 'primary' })));
            const pref = snapshot.autoEnableCodemode || {};
            const auto = select([['inherit', t('默认 / 继承', 'Default / inherit')], ['true', t('自动启用', 'Auto-enable')], ['false', t('不自动启用', 'Do not auto-enable')]], pref[scope.value] == null ? 'inherit' : String(pref[scope.value]));
            auto.dataset.mcpWrite = '';
            const prefRow = el('div', null, { class: 'mcp-pref' });
            const prefCopy = el('div', null, { class: 'mcp-pref-copy' });
            prefCopy.append(fieldLabel(t('自动启用 Codemode', 'Auto-enable Codemode'), 'autoEnableCodemode', auto), el('p', t('配置有效值：', 'Effective saved value: ') + String(pref.value)));
            prefRow.append(prefCopy, writeButton(t('保存偏好', 'Save preference'), () => void save({ action: 'preferences', autoEnableCodemode: auto.value === 'inherit' ? null : auto.value === 'true' }), { glyph: 'fa-check' }));
            saved.append(prefRow);
            const list = el('div', null, { class: 'mcp-list' });
            for (const server of snapshot.servers) {
                const row = el('article', null, { class: 'mcp-item' });
                if (server.enabled === false) row.classList.add('is-off');
                const mark = el('span', null, { class: 'mcp-item-icon' }); mark.append(icon(server.transport === 'http' ? 'fa-globe' : 'fa-terminal'));
                const main = el('div', null, { class: 'mcp-item-main' });
                const title = el('div', null, { class: 'mcp-item-title' });
                title.append(el('strong', server.name), badge(server.enabled ? t('已启用', 'enabled') : t('已停用', 'disabled'), server.enabled ? 'on' : 'off'), badge(server.transport), badge(server.exposure || 'unknown'), badge(server.scope, 'scope'));
                main.append(title);
                const actions = el('div', null, { class: 'mcp-actions' });
                if (server.valid !== false) actions.append(writeButton(t('编辑', 'Edit'), () => edit(server), { glyph: 'fa-pen' }));
                else { row.classList.add('is-invalid'); main.append(el('p', t('无效配置：仅可删除；其他字段保留。', 'Invalid configuration: removal only; other fields retained.'), { class: 'mcp-warning' })); }
                actions.append(writeButton(t('删除', 'Remove'), () => void save({ action: 'remove', name: server.name }), { glyph: 'fa-trash', variant: 'danger' }));
                row.append(mark, main, actions); list.append(row);
            }
            if (!snapshot.servers.length) {
                const empty = el('div', null, { class: 'mcp-empty' });
                empty.append(icon('fa-plug-circle-plus'), el('strong', t('还没有 MCP 服务器', 'No MCP servers yet')), el('p', t('点击“添加服务器”填写 stdio 命令或 HTTP 地址。', 'Choose “Add server” to enter a stdio command or HTTP URL.')));
                list.append(empty);
            }
            saved.append(list);
            controls();
        }
        function edit(server) {
            if (!writable()) return;
            editor.replaceChildren(); editor.hidden = false;
            editor.append(heading('fa-pen-to-square', server ? t('编辑服务器', 'Edit server') : t('添加服务器', 'Add server'), t('现有私密值不会显示。默认保留；替换和移除需明确选择。环境变量或命令引用不在此求值。未知字段保留。', 'Existing private values are never shown. Keep is the default; explicitly choose replace or remove. Environment/command references are not evaluated here. Unknown fields are retained.')));
            const fields = el('div', null, { class: 'mcp-grid' }), readers = [];
            const name = el('input', null, { 'aria-label': t('服务器名称', 'Server name'), autocomplete: 'off', placeholder: 'my-server' }); name.value = server?.name || ''; name.disabled = !!server;
            if (!server) name.dataset.mcpWrite = '';
            fields.append(fieldLabel(t('服务器名称', 'Server name'), null, name));
            function control(key, caption, input, read, wide) { input.dataset.mcpWrite = ''; fields.append(fieldLabel(caption, key, input, wide)); readers.push(config => { config[key] = read(input); }); }
            control('type', t('传输方式', 'Transport'), select([['stdio', 'stdio'], ['http', 'http']], server?.transport || 'stdio'), n => n.value);
            control('enabled', t('状态', 'State'), select([['true', t('启用', 'Enabled')], ['false', t('停用', 'Disabled')]], String(server?.enabled ?? true)), n => n.value === 'true');
            control('exposure', t('工具暴露', 'Tool exposure'), select(exposures, server?.exposure || 'codemode'), n => n.value);
            const timeout = el('input', null, { type: 'number', min: '0', step: 'any' }); timeout.value = server?.timeout ?? 60;
            control('timeout', t('超时（秒）', 'Timeout (seconds)'), timeout, n => { const v = Number(n.value); if (!n.value || !Number.isFinite(v) || v <= 0) throw new Error('timeout'); return v; });
            const tools = el('textarea', null, { spellcheck: 'false' }); tools.value = JSON.stringify(server?.config?.toolExposure || {}, null, 2);
            control('toolExposure', t('逐个工具暴露（有序 JSON）', 'Per-tool exposure (ordered JSON)'), tools, n => { const v = JSON.parse(n.value); if (!v || Array.isArray(v) || typeof v !== 'object' || Object.values(v).some(x => !exposures.some(([e]) => e === x))) throw new Error('toolExposure'); return v; }, true);
            editor.append(fields);
            function group(title, description) {
                const box = el('fieldset', null, { class: 'mcp-group' });
                box.append(el('legend', title));
                if (description) box.append(el('p', description));
                editor.append(box); return box;
            }
            function privateField(target, path, present) {
                const row = el('div', null, { class: 'mcp-secret' });
                const mode = select([['keep', t('保留', 'Keep')], ['replace', t('替换', 'Replace')], ['remove', t('移除', 'Remove')]], 'keep'); mode.dataset.mcpWrite = '';
                const input = path === 'args' ? el('textarea', null, { autocomplete: 'off', spellcheck: 'false', 'aria-label': path + ' replacement', placeholder: '["--flag", "value"]' }) : el('input', null, { type: 'password', autocomplete: 'new-password', spellcheck: 'false', 'aria-label': path + ' replacement' }); input.hidden = true; input.dataset.mcpWrite = '';
                mode.addEventListener('change', () => { input.hidden = mode.value !== 'replace'; if (mode.value !== 'replace') input.value = ''; });
                const caption = el('label', null, { class: 'mcp-secret-label' });
                const nameLine = el('span', null, { class: 'mcp-secret-name' });
                nameLine.append(el('code', path), el('span', ` · ${present ? t('已存在', 'present') : t('未设置', 'absent')}`, { class: 'mcp-secret-state', 'data-present': String(present) }));
                caption.append(nameLine, mode);
                row.append(caption, input); target.append(row);
                readers.push(config => {
                    if (mode.value === 'keep') return;
                    const op = { op: mode.value };
                    if (mode.value === 'replace') { op.value = path === 'args' ? JSON.parse(input.value) : input.value; if (path === 'args' && (!Array.isArray(op.value) || op.value.some(v => typeof v !== 'string'))) throw new Error('args'); }
                    const parts = path.split('.');
                    if (parts.length === 1) config[path] = op;
                    else { config[parts[0]] ||= Object.create(null); config[parts[0]][parts.slice(1).join('.')] = op; }
                });
            }
            const connection = group(t('连接', 'Connection'), t('stdio 使用 command／args／cwd，HTTP 使用 url。', 'stdio uses command/args/cwd; HTTP uses url.'));
            for (const key of ['command', 'args', 'cwd', 'url']) privateField(connection, key, server?.secretFields?.[key]?.present === true);
            for (const [kind, title] of [['env', t('环境变量', 'Environment variables')], ['headers', t('请求头', 'Headers')]]) {
                const box = group(title), rows = el('div', null, { class: 'mcp-secret-list' });
                box.append(rows);
                const keys = new Set(Object.keys(server?.config?.[kind] || {}));
                for (const key of keys) privateField(rows, `${kind}.${key}`, true);
                const newKey = el('input', null, { 'aria-label': `${kind} field name`, placeholder: kind === 'env' ? 'API_KEY' : 'Authorization' }); newKey.dataset.mcpWrite = '';
                const adder = el('div', null, { class: 'mcp-add-field' });
                adder.append(label(t('新增字段：', 'New field: ') + kind, newKey), writeButton(t('添加字段', 'Add field'), () => { const k = newKey.value.trim(); if (!k || ['__proto__', 'constructor', 'prototype'].includes(k) || keys.has(k)) return; keys.add(k); privateField(rows, `${kind}.${k}`, false); newKey.value = ''; controls(); }, { glyph: 'fa-plus' }));
                box.append(adder);
            }
            const oauth = group('OAuth');
            for (const key of ['clientId', 'clientSecret', 'callbackUrl', 'scope']) privateField(oauth, `oauth.${key}`, server?.secretFields?.[`oauth.${key}`]?.present === true);
            const port = el('input', null, { type: 'number', min: '1', max: '65535', 'aria-label': 'oauth.callbackPort' }); port.value = server?.config?.oauth?.callbackPort ?? ''; port.dataset.mcpWrite = '';
            oauth.append(fieldLabel('', 'oauth.callbackPort', port)); const previousPort = port.value;
            readers.push(config => { if (port.value === previousPort) return; const value = port.value === '' ? null : Number(port.value); if (value !== null && (!Number.isInteger(value) || value < 1 || value > 65535)) throw new Error('callbackPort'); config.oauth ||= Object.create(null); config.oauth.callbackPort = value; });
            const footer = el('div', null, { class: 'mcp-footer mcp-editor-footer' });
            footer.append(button(t('取消编辑', 'Cancel editing'), () => { editor.replaceChildren(); editor.hidden = true; }, { variant: 'quiet' }), writeButton(t('确认保存服务器', 'Save server'), () => {
                if (!writable()) return;
                try { if (!/^[A-Za-z0-9_-]+$/.test(name.value) || ['__proto__', 'constructor', 'prototype'].includes(name.value)) throw new Error('name'); const config = {}; for (const read of readers) read(config); void save({ action: 'upsert', name: name.value, config }); }
                catch { feedback.textContent = t('请核对名称、数字、参数数组和工具暴露 JSON。', 'Check the name, numbers, args array and tool exposure JSON.'); }
            }, { glyph: 'fa-floppy-disk', variant: 'primary' }));
            editor.append(footer);
            controls();
            editor.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
        }
        scope.addEventListener('change', () => void load());
        const close = () => { active = false; epoch++; snapshot = null; runtime = null; editor.replaceChildren(); saved.replaceChildren(); live.replaceChildren(); root.classList.remove('active'); };
        window.addEventListener('workspace:settings-closed', close); window.addEventListener('workspace:access-locked', close);
        return { root, open() { active = true; root.classList.add('active'); void load(); }, close };
    }
    window.PiMcpSettings = { create };
})();
