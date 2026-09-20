(() => {
    const t = (text, ...args) => (window.PiI18n?.t || ((s, ...values) => s.replace(/\{(\d+)\}/g, (_, i) => values[i] ?? '')))(text, ...args);
    const node = (tag, text, className) => { const el = document.createElement(tag); if (text) el.textContent = t(text); if (className) el.className = className; return el; };
    const literal = (tag, text, className) => { const el = node(tag, '', className); el.textContent = String(text ?? ''); return el; };
    const button = (text, className, action) => { const el = node('button', text, className); el.type = 'button'; el.onclick = action; return el; };
    const icon = name => { const el = node('i', '', 'fa-solid fa-' + name); el.setAttribute('aria-hidden', 'true'); return el; };
    const roles = {
        delegate: ['通用助手', '处理明确交办的独立任务', 'user-check'],
        'evidence-auditor': ['证据核查', '核对结论、测试结果与完成证据', 'clipboard-check'],
        oracle: ['深度顾问', '分析复杂问题，提供方案建议', 'lightbulb'],
        researcher: ['资料研究', '查找资料，整理背景与参考信息', 'book-open'],
        reviewer: ['代码审查', '检查代码、方案与潜在问题', 'shield-halved'],
        scout: ['代码探索', '快速了解代码结构与相关实现', 'compass'],
        worker: ['任务执行', '完成实现、修改与验证工作', 'screwdriver-wrench']
    };
    const thinkingNames = { off: '关闭思考', minimal: '极低', low: '低', medium: '中等', high: '高', xhigh: '很高', max: '最高' };
    class SubagentSettings {
        constructor({ apiFetch, currentCwd }) {
            this.api = apiFetch; this.currentCwd = currentCwd; this.root = document.getElementById('settings-subagents');
            this.epoch = 0; this.scope = 'global'; this.drafts = new Map(); this.expanded = new Set(); this.busy = false;
            document.querySelector('[data-settings-tab="media"] span').textContent = t('模型与能力');
            document.getElementById('settings-capabilities-title').textContent = t('模型与能力');
            document.getElementById('settings-multimodal-title').textContent = t('多模态');
        }
        close() { this.epoch++; this.closePicker(); }
        closePicker() { if (this.picker) { this.picker.close(); this.picker.remove(); this.picker = null; } }
        async open() {
            const epoch = ++this.epoch, selectedCwd = this.currentCwd();
            this.closePicker(); this.needsRefresh = true;
            this.root.replaceChildren(node('h4', '子 Agent'), node('p', '正在读取设置', 'sa-note'));
            try {
                const status = await this.api('/api/pi/status');
                const cwd = selectedCwd || status.defaultProject;
                const snapshot = await this.api('/api/pi/settings/subagents?cwd=' + encodeURIComponent(cwd));
                const catalog = snapshot.plugin.status === 'ready' ? await this.api('/api/pi/settings/models') : { models: [], providers: [] };
                if (epoch !== this.epoch) return false;
                if (selectedCwd !== this.currentCwd()) return this.open();
                this.snapshot = snapshot; this.models = catalog.models.filter(model => model.available);
                this.providers = new Map((catalog.providers || []).map(provider => [provider.id, provider.name || provider.id]));
                this.byModel = new Map(this.models.map(model => [`${model.provider}/${model.id}`, model]));
                this.needsRefresh = false;
                if (!selectedCwd) this.scope = 'global';
                this.render(); return true;
            } catch (error) {
                if (epoch !== this.epoch) return false;
                this.root.replaceChildren(node('h4', '子 Agent'), node('p', error.message, 'sa-note'));
                this.root.append(button('刷新状态', 'settings-secondary-button', () => this.open())); return false;
            }
        }
        draft() {
            const key = this.snapshot.cwd + '\0' + this.scope;
            if (!this.drafts.has(key)) this.drafts.set(key, {});
            return this.drafts.get(key);
        }
        value(key, saved) { return Object.hasOwn(this.draft(), key) ? this.draft()[key] : saved ?? null; }
        change(key, value, saved) {
            if (value === (saved ?? null)) delete this.draft()[key]; else this.draft()[key] = value;
            this.updateFooter();
        }
        modelLabel(value) {
            if (!value) return t('自动选择');
            if (value === 'inherit') return t('跟随主 Agent');
            const model = this.byModel.get(value);
            return model?.name || model?.id || value;
        }
        updateFooter() {
            const count = Object.keys(this.draft()).length;
            if (this.saveButton) this.saveButton.disabled = this.busy || this.needsRefresh || !count || this.scope === 'project' && !this.snapshot.trust.effective;
            if (this.resetButton) this.resetButton.disabled = this.busy || !count;
            if (this.dirtyLabel) this.dirtyLabel.textContent = count ? t('{0} 项待保存', count) : t('没有未保存的修改');
        }
        render() {
            this.closePicker();
            const data = this.snapshot, ready = data.plugin.status === 'ready';
            this.root.replaceChildren();
            const header = node('div', '', 'sa-header'), emblem = node('span', '', 'sa-emblem'); emblem.append(icon('people-group'));
            const copy = node('div', '', 'sa-heading'); copy.append(node('h4', '子 Agent'), node('p', '为不同任务分配合适的模型', 'sa-note'));
            const statusLabels = { ready: '已配置启用', missing: '尚未安装', disabled: '已停用', unsupported: '版本待适配' };
            const badge = node('span', statusLabels[data.plugin.status] || '状态未知', 'sa-badge'); badge.dataset.state = data.plugin.status;
            header.append(emblem, copy, badge); this.root.append(header);
            const toolbar = node('div', '', 'sa-toolbar');
            if (ready) {
                const scopeLabel = node('label', '', 'sa-scope'); scopeLabel.append(node('span', '应用范围'));
                const scope = node('select'); scope.dataset.saScope = ''; scope.setAttribute('aria-label', t('设置范围'));
                scope.append(new Option(t('所有项目'), 'global')); if (this.currentCwd()) scope.append(new Option(t('当前项目'), 'project'));
                scope.value = this.scope; scope.disabled = this.busy;
                scope.onchange = () => { this.scope = scope.value; this.render(); };
                scopeLabel.append(scope); toolbar.append(scopeLabel);
            }
            this.refreshButton = button('刷新状态', 'sa-refresh', () => this.open()); this.refreshButton.disabled = this.busy;
            this.refreshButton.prepend(icon('rotate')); toolbar.append(this.refreshButton); this.root.append(toolbar);
            this.message = node('p', '', 'sa-status'); this.message.setAttribute('role', 'status'); this.message.setAttribute('aria-live', 'polite'); this.root.append(this.message);
            if (!ready) {
                const messages = {
                    missing: '尚未安装 pi-subagents，暂时无法设置子 Agent。下载失败不影响 Pivane 的其他功能。',
                    disabled: 'pi-subagents 已安装但未启用，请在 Packages 中启用后刷新。',
                    unsupported: '已安装的 pi-subagents 版本尚未适配，暂时无法编辑。请在 Packages 中核对版本。'
                };
                const empty = node('div', '', 'sa-empty'); empty.append(icon('puzzle-piece'), node('p', messages[data.plugin.status]));
                if (data.plugin.canInstall) {
                    this.installButton = button('安装 pi-subagents', 'settings-primary-button', () => { if (window.confirm(t('将为所有项目安装 pi-subagents 指定版本，安装位置与 Pi CLI 共用。继续？'))) this.submit(true); });
                    this.installButton.disabled = this.busy || this.needsRefresh; empty.append(this.installButton);
                }
                this.root.append(empty);
            } else {
                const form = node('form'), controls = node('fieldset'); controls.disabled = this.busy || this.needsRefresh || this.scope === 'project' && !data.trust.effective;
                const defaults = node('section', '', 'sa-default-card'); defaults.append(node('h5', '默认配置'), node('p', '先设置通用偏好，需要时再为角色单独指定。', 'sa-note'));
                defaults.append(this.fields('', data.defaults[this.scope])); controls.append(defaults);
                const roleHeader = node('div', '', 'sa-role-heading'); roleHeader.append(node('h5', '按角色设置'), node('span', '点击角色可单独调整', 'sa-note')); controls.append(roleHeader);
                const list = node('div', '', 'sa-roles');
                for (const key of Object.keys(this.draft())) {
                    const match = /^agentOverrides\.([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\.(model|thinking)$/.exec(key);
                    if (match && !data.roles.some(role => role.name === match[1])) data.roles.push({ name: match[1], global: {}, project: {} });
                }
                for (const role of data.roles) {
                    const [title, description, symbol] = Object.hasOwn(roles, role.name) ? roles[role.name] : [role.name, '自定义角色', 'user-gear'];
                    const card = node('details', '', 'sa-role'); card.dataset.role = role.name;
                    const expansionKey = data.cwd + '\0' + this.scope + '\0' + role.name; card.open = this.expanded.has(expansionKey);
                    card.ontoggle = () => { if (!card.isConnected) return; if (card.open) this.expanded.add(expansionKey); else this.expanded.delete(expansionKey); };
                    const summary = node('summary'), mark = node('span', '', 'sa-role-icon'); mark.append(icon(symbol));
                    const text = node('span', '', 'sa-role-copy'); text.append(Object.hasOwn(roles, role.name) ? node('strong', title) : literal('strong', title), node('small', description));
                    const selection = node('span', '', 'sa-role-selection');
                    const update = () => {
                        const model = this.value(`agentOverrides.${role.name}.model`, role[this.scope].model);
                        const thinking = this.value(`agentOverrides.${role.name}.thinking`, role[this.scope].thinking);
                        selection.textContent = this.modelLabel(model) + (thinking ? ' · ' + t(thinkingNames[thinking] || thinking) : '');
                        selection.title = model && model !== 'inherit' ? model : selection.textContent;
                    };
                    update(); summary.append(mark, text, selection, icon('chevron-down')); card.append(summary);
                    const content = node('div', '', 'sa-role-body'); content.append(literal('span', role.name, 'sa-role-id'), this.fields(role.name, role[this.scope], update)); card.append(content); list.append(card);
                }
                controls.append(list); form.append(controls);
                this.root.append(form);
                const footer = node('div', '', 'sa-footer'); this.dirtyLabel = node('span', '', 'sa-note');
                this.resetButton = button('撤销修改', 'settings-secondary-button', () => { this.drafts.delete(data.cwd + '\0' + this.scope); this.render(); });
                this.saveButton = node('button', '保存设置', 'settings-primary-button'); this.saveButton.type = 'submit'; this.saveButton.prepend(icon('check'));
                footer.append(this.dirtyLabel, this.resetButton, this.saveButton); form.append(footer);
                form.onsubmit = event => { event.preventDefault(); this.submit(false); };
                if (this.scope === 'project' && !data.trust.effective) this.root.append(node('p', '请先信任项目', 'sa-status'));
                this.updateFooter();
            }
            const help = node('details', '', 'sa-help'); help.append(node('summary', '配置说明与插件信息'));
            const body = node('div');
            body.append(node('p', '自动选择表示不覆盖本层配置，沿用插件的默认规则；角色定义、供应商设置或单次任务可能优先。'),
                node('p', '安装和保存不会自动启动任务。当前任务不受影响，空闲后重开运行实例以应用配置。'),
                node('p', '角色列表包含随附角色与已有覆盖。中文名称仅用于显示，实际角色标识保持不变。'),
                node('p', t('适配版本：{0}；已安装：{1}', data.plugin.version, data.plugin.installedVersions.join(', ') || '—')));
            if (ready) {
                const addRow = node('div', '', 'sa-add-role'), name = node('input'); name.placeholder = t('自定义角色名称'); name.setAttribute('aria-label', t('自定义角色名称')); name.maxLength = 64;
                const add = button('添加角色覆盖', 'settings-secondary-button', () => {
                    const value = name.value.trim();
                    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value) || ['constructor', 'prototype', '__proto__'].includes(value) || data.roles.some(role => role.name === value)) {
                        name.setCustomValidity(t('请输入未重复的英文角色标识')); name.reportValidity(); return;
                    }
                    data.roles.push({ name: value, global: {}, project: {} }); this.expanded.add(data.cwd + '\0' + this.scope + '\0' + value); this.render();
                });
                name.oninput = () => name.setCustomValidity(''); name.disabled = add.disabled = this.busy || this.needsRefresh || this.scope === 'project' && !data.trust.effective;
                addRow.append(name, add); body.append(node('p', '按已有角色标识添加配置，不会创建新角色。'), addRow);
            }
            help.append(body); this.root.append(help);
        }
        fields(prefix, saved, updated = () => {}) {
            const fields = node('div', '', 'sa-fields');
            const modelKey = prefix ? `agentOverrides.${prefix}.model` : 'defaultModel';
            const thinkingKey = prefix ? `agentOverrides.${prefix}.thinking` : 'defaultThinking';
            const modelField = node('div', '', 'sa-field'); modelField.append(node('span', '模型'));
            const choose = button('', 'sa-model-trigger', () => this.openPicker(choose, prefix, this.value(modelKey, saved.model), value => {
                this.change(modelKey, value, saved.model); draw(); updated();
            })); choose.dataset.modelKey = modelKey; choose.setAttribute('aria-haspopup', 'dialog');
            const draw = () => {
                const value = this.value(modelKey, saved.model), model = this.byModel.get(value), copy = node('span', '', 'sa-model-copy');
                const label = this.modelLabel(value); copy.append(literal('strong', label));
                copy.append(literal('small', model ? this.providers.get(model.provider) || model.provider : t(!value ? '沿用默认规则' : value === 'inherit' ? '使用主会话当前模型' : '当前配置 · 未在可用目录中')));
                choose.replaceChildren(copy, icon('magnifying-glass')); choose.title = value || t('自动选择'); choose.setAttribute('aria-label', t('选择模型：{0}', label));
            }; draw(); modelField.append(choose);
            const thinkingField = node('label', '', 'sa-field'); thinkingField.append(node('span', '思考等级'));
            const select = node('select'); select.dataset.thinkingKey = thinkingKey; select.append(new Option(t('自动选择'), ''));
            for (const level of [...new Set(this.models.flatMap(model => model.thinkingLevels || []))]) select.append(new Option(t(thinkingNames[level] || level), level));
            const value = this.value(thinkingKey, saved.thinking);
            if (value && ![...select.options].some(option => option.value === value)) select.append(new Option(value, value));
            select.value = value || ''; select.onchange = () => { this.change(thinkingKey, select.value || null, saved.thinking); updated(); };
            thinkingField.append(select); fields.append(modelField, thinkingField); return fields;
        }
        openPicker(trigger, prefix, current, selected) {
            if (this.busy || this.needsRefresh) return;
            this.closePicker();
            const dialog = node('dialog', '', 'sa-picker'); this.picker = dialog;
            dialog.setAttribute('aria-labelledby', 'sa-picker-title');
            const heading = node('header'), title = node('h3', '选择模型'); title.id = 'sa-picker-title';
            const close = button('', 'sa-picker-close', () => this.closePicker()); close.append(icon('xmark')); close.setAttribute('aria-label', t('关闭')); heading.append(title, close);
            const filters = node('div', '', 'sa-picker-filters');
            const search = node('input'); search.type = 'search'; search.placeholder = t('搜索模型名称、ID 或供应商'); search.setAttribute('aria-label', t('搜索模型')); search.autocomplete = 'off';
            const provider = node('select'); provider.setAttribute('aria-label', t('筛选供应商')); provider.append(new Option(t('全部供应商'), ''));
            for (const id of [...new Set(this.models.map(model => model.provider))].sort()) provider.append(new Option(this.providers.get(id) || id, id));
            filters.append(search, provider);
            const automatic = node('div', '', 'sa-picker-automatic');
            const selectValue = value => { selected(value); this.closePicker(); };
            const auto = button('自动选择', 'sa-picker-mode', () => selectValue(null)); auto.setAttribute('aria-pressed', String(!current)); automatic.append(auto);
            if (prefix) { const inherit = button('跟随主 Agent', 'sa-picker-mode', () => selectValue('inherit')); inherit.setAttribute('aria-pressed', String(current === 'inherit')); automatic.append(inherit); }
            const count = node('p', '', 'sa-picker-count'); count.setAttribute('role', 'status'); count.setAttribute('aria-live', 'polite');
            const results = node('div', '', 'sa-picker-results'); results.setAttribute('aria-label', t('可用模型')); results.setAttribute('role', 'group');
            const footer = node('footer', '选择后仍需保存设置', 'sa-note');
            dialog.append(heading, filters, automatic, count, results, footer); document.body.append(dialog);
            let limit = 40;
            const render = (reset = true) => {
                if (reset) { limit = 40; results.scrollTop = 0; }
                const words = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
                const matching = this.models.filter(model => (!provider.value || model.provider === provider.value) && words.every(word => `${model.name || ''} ${model.provider}/${model.id} ${model.provider} ${this.providers.get(model.provider) || ''}`.toLocaleLowerCase().includes(word)));
                // Show the current selection first without changing the saved value.
                matching.sort((a, b) => Number(`${b.provider}/${b.id}` === current) - Number(`${a.provider}/${a.id}` === current));
                count.textContent = t('找到 {0} 个模型，显示 {1} 个', matching.length, Math.min(limit, matching.length)); results.replaceChildren();
                for (const model of matching.slice(0, limit)) {
                    const value = `${model.provider}/${model.id}`, item = button('', 'sa-picker-item', () => selectValue(value));
                    item.setAttribute('aria-pressed', String(value === current));
                    const copy = node('span', '', 'sa-picker-item-copy'); copy.append(literal('strong', model.name || model.id), literal('small', value));
                    item.append(copy, icon(value === current ? 'check' : 'plus')); results.append(item);
                }
                if (!matching.length) results.append(node('p', '没有匹配的模型，试试其他关键词或供应商。', 'sa-picker-empty'));
                if (matching.length > limit) results.append(button('显示更多模型', 'sa-picker-more', () => { limit += 40; render(false); results.querySelectorAll('.sa-picker-item')[limit - 40]?.focus(); }));
            };
            search.oninput = () => render(); provider.onchange = () => render();
            dialog.addEventListener('keydown', event => {
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.closePicker(); return; }
                if (event.key !== 'Tab') return;
                const controls = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')].filter(el => el.getClientRects().length);
                const first = controls[0], last = controls.at(-1);
                if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
            });
            dialog.addEventListener('cancel', event => { event.preventDefault(); this.closePicker(); });
            dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) this.closePicker(); } });
            dialog.addEventListener('close', () => { if (trigger.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true }); }, { once: true });
            render(); dialog.showModal(); search.focus();
        }
        async submit(install) {
            if (this.busy || this.needsRefresh || !install && this.saveButton?.disabled) return;
            const data = this.snapshot, scope = this.scope, changes = { ...this.draft() }, epoch = this.epoch;
            if (!install && !Object.keys(changes).length) return;
            this.busy = true; this.render(); this.message.textContent = t(install ? '正在安装，请等待结果；关闭页面不会取消安装。' : '正在保存');
            try {
                await this.api('/api/pi/settings/subagents' + (install ? '/install' : ''), { method: install ? 'POST' : 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cwd: data.cwd, expectedRevision: data.revision, ...(install ? { confirmed: true } : { scope, changes }) }) });
                if (!install) this.drafts.delete(data.cwd + '\0' + scope);
                if (epoch === this.epoch) {
                    this.busy = false;
                    const loaded = await this.open();
                    if (loaded && this.epoch === epoch + 1) this.message.textContent = t('已保存。请在任务结束后重开运行实例以应用配置。');
                }
            } catch (error) {
                if (epoch === this.epoch) {
                    this.needsRefresh = true; this.busy = false; this.render();
                    this.message.textContent = error.message + ' ' + t('请刷新核对后再操作；草稿已保留。');
                }
            } finally { this.busy = false; if (this.refreshButton?.isConnected) this.refreshButton.disabled = false; }
        }
    }
    window.PiSubagentSettings = { create: options => new SubagentSettings(options) };
})();
