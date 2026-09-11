(() => {
    const $ = id => document.getElementById(id);
    const node = (tag, text, className) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (className) n.className = className; return n; };
    const examples = [
        ['review-changes', '检查当前改动', '检查当前项目的改动，关注正确性、回归风险与测试缺口。先阅读项目约定；没有 Git 时根据当前文件与可用备份核对，不假设存在 Git。\n额外要求：${1:-优先指出需要修复的问题}'],
        ['finish-task', '按项目约定收尾', '按当前项目的 AGENTS.md 和开发约定完成收尾：核对改动、运行相关验证、更新必要文档，并说明结果及尚未完成的事项。\n范围：${1:-本轮任务}'],
        ['explain-file', '解释选中的文件', '请读取并解释 $1，说明职责、关键流程、依赖与值得注意的边界。\n${2:-使用简洁中文，结合具体代码说明}'],
        ['handoff', '生成交接说明', '为${1:-当前任务}生成交接说明，包含目标、已完成改动、验证证据、仍待处理事项和关键文件路径；不要包含凭据。']
    ];
    class PiComposerTools {
        constructor(host) {
            this.host = host; this.input = $('pi-input'); this.menu = $('pi-command-menu');
            this.dialog = $('pi-template-dialog'); this.search = $('pi-template-search'); this.body = $('pi-template-body');
            this.addButton = $('pi-composer-add-button'); this.addMenu = $('pi-composer-add-menu');
            this.enabled = false; this.epoch = 0; this.request = 0; this.remote = []; this.builtins = []; this.templates = [];
            this.items = []; this.active = -1; this.catalog = null;
            this.catalogRequest = 0;
            this.input.setAttribute('aria-autocomplete', 'list');
            this.input.setAttribute('aria-controls', this.menu.id); this.input.setAttribute('aria-expanded', 'false');
            this.menu.setAttribute('role', 'listbox'); this.menu.setAttribute('aria-label', '命令与文件补全');
            this.menu.addEventListener('mousedown', e => e.preventDefault());
            this.menu.addEventListener('click', e => { const b = e.target.closest('[data-completion]'); if (b) this.choose(this.items[Number(b.dataset.completion)]); });
            this.input.addEventListener('click', () => this.complete());
            this.input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== this.input && !this.dialog.open) this.hide(); }, 150));
            this.addButton.addEventListener('click', () => this.addMenu.hidden ? this.openActions() : this.closeActions(true));
            this.addButton.addEventListener('keydown', e => { if (!e.isComposing && ['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); this.openActions(e.key === 'ArrowUp'); } });
            this.addMenu.addEventListener('click', e => { const button = e.target.closest('button'); if (button && !button.disabled) this.closeActions(true); }, true);
            this.addMenu.addEventListener('keydown', e => this.actionsKey(e));
            document.addEventListener('pointerdown', e => { if (!this.addButton.parentElement.contains(e.target)) this.closeActions(); });
            document.addEventListener('focusin', e => { if (!this.addButton.parentElement.contains(e.target)) this.closeActions(); });
            window.addEventListener('resize', () => this.closeActions());
            $('settings-manage-templates').addEventListener('click', () => this.openTemplates());
            $('pi-template-close').addEventListener('click', () => this.dialog.close());
            this.dialog.addEventListener('keydown', e => { if (e.key === 'Escape') e.stopPropagation(); });
            this.dialog.addEventListener('close', () => {
                this.request++;
                if (this.returnFocus?.isConnected && this.returnFocus.getClientRects().length) this.returnFocus.focus();
            });
            this.dialog.addEventListener('cancel', () => { this.request++; });
            this.search.addEventListener('input', () => { clearTimeout(this.panelTimer); this.panelTimer = setTimeout(() => this.run(() => this.renderPanel()), 100); });
        }
        key() { return this.host.context().key; }
        async run(fn) { try { return await fn(); } catch (e) { this.host.toast(e.message, 'error'); } }
        setEnabled(value) {
            this.enabled = value;
            $('settings-manage-templates').disabled = !value;
            $('settings-manage-templates').title = value ? '管理 Pi 原生提示词模板' : '模板管理等待后台启用';
        }
        closeActions(focus = false) {
            this.addMenu.hidden = true; this.addButton.setAttribute('aria-expanded', 'false');
            if (focus) this.addButton.focus();
        }
        actionItems() { return [...this.addMenu.querySelectorAll('button')].filter(b => !b.hidden && !b.disabled); }
        openActions(last = false) {
            this.hide(); this.addMenu.hidden = false; this.addButton.setAttribute('aria-expanded', 'true');
            const items = this.actionItems(); (last ? items.at(-1) : items[0])?.focus();
        }
        actionsKey(e) {
            if (e.isComposing || e.keyCode === 229) return;
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeActions(true); return; }
            if (e.key === 'Tab') { this.closeActions(true); return; }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
            const items = this.actionItems(); if (!items.length) return;
            e.preventDefault(); const index = items.indexOf(document.activeElement);
            const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            items[next].focus();
        }
        reset() {
            this.closeActions();
            this.epoch++; this.request++; clearTimeout(this.timer); clearTimeout(this.panelTimer);
            this.remote = []; this.templates = []; this.catalog = null; this.body.replaceChildren();
            this.hide(); if (this.dialog.open) this.dialog.close();
        }
        setCommands(commands) {
            this.remote = (commands || []).filter(c => !/^pi5-web-navigate(?::\d+)?$/.test(c.name));
            this.host.commands(this.commands());
            if (!this.dialog.open && this.input.value.startsWith('/') && this.active < 0) this.complete();
        }
        commands() {
            const local = this.host.locals();
            const merged = [...local, ...this.builtins.filter(c => !local.some(l => l.name === c.name))];
            const seen = new Set(merged.map(c => c.name));
            const priority = { extension: 0, skill: 1, prompt: 2 };
            const remote = [...this.remote].sort((a, b) => (priority[a.source] ?? 3) - (priority[b.source] ?? 3))
                .filter(c => { if (seen.has(c.name)) return false; seen.add(c.name); return true; });
            return [...merged, ...remote.map(c => ({ ...c,
                argumentHint: c.argumentHint || (c.source === 'prompt' ? this.templates.find(t => t.filePath === (c.path || c.sourceInfo?.path))?.argumentHint : '')
            }))];
        }
        async load() {
            if (!this.enabled) return;
            const cwd = this.host.context().cwd, epoch = this.epoch, revision = ++this.catalogRequest;
            let data;
            try { data = await this.host.api(`/api/pi/composer/catalog?cwd=${encodeURIComponent(cwd)}`); }
            catch (error) { if (epoch === this.epoch && revision === this.catalogRequest) throw error; return; }
            if (epoch !== this.epoch || revision !== this.catalogRequest || cwd !== this.host.context().cwd) return;
            this.catalog = data; this.templates = data.templates || []; this.builtins = data.builtins || [];
            this.host.commands(this.commands());
            if (!this.dialog.open && this.input.value.startsWith('/') && this.active < 0) this.complete();
        }
        hide() {
            this.request++; clearTimeout(this.timer); this.menu.classList.add('hidden'); this.items = []; this.active = -1;
            this.input.setAttribute('aria-expanded', 'false'); this.input.removeAttribute('aria-activedescendant');
        }
        token() {
            const at = this.input.selectionStart, before = this.input.value.slice(0, at);
            if (at === this.input.selectionEnd && /^\/[^\s/]*$/.test(before) && at === this.input.value.length) return { type: 'command', query: before.slice(1), start: 0, end: at };
            const match = before.match(/(?:^|\s)@([^\s@]*)$/);
            if (at === this.input.selectionEnd && match && this.enabled) return { type: 'file', query: match[1], start: at - match[1].length - 1, end: at };
            return null;
        }
        complete() {
            this.closeActions();
            this.hide(); if (!this.host.context().connected || this.input.disabled) return;
            const token = this.token(); if (!token) return;
            this.completionToken = token;
            if (token.type === 'command') {
                const query = token.query.toLowerCase();
                const items = this.commands().filter(c => `${c.name} ${c.description || ''}`.toLowerCase().includes(query))
                    .sort((a, b) => Number(b.name.startsWith(query)) - Number(a.name.startsWith(query)));
                this.show(items.map(command => ({ type: 'command', command })));
            } else {
                const request = this.request, key = this.key(), text = this.input.value;
                this.timer = setTimeout(() => this.run(async () => {
                    let data;
                    try { data = await this.files(token.query); }
                    catch (error) { if (request === this.request && key === this.key()) throw error; return; }
                    if (request !== this.request || key !== this.key() || text !== this.input.value || this.token()?.end !== token.end) return;
                    this.show((data.files || []).map(file => ({ type: 'file', file })));
                }), 180);
            }
        }
        show(items) {
            this.items = items; this.active = -1; this.menu.replaceChildren();
            if (!items.length) { this.menu.append(node('p', '没有匹配项', 'pi-composer-empty')); }
            items.forEach((item, i) => {
                const c = item.command; const b = node('button'); b.type = 'button'; b.tabIndex = -1;
                b.id = `pi-completion-${i}`; b.dataset.completion = i; b.setAttribute('role', 'option'); b.setAttribute('aria-selected', 'false');
                if (c?.available === false) b.setAttribute('aria-disabled', 'true');
                b.append(node('strong', c ? `/${c.name}` : `@${item.file.path}`), node('span', c ? `${this.source(c)} · ${c.argumentHint || ''} ${c.description || ''}` : '项目文件路径引用'));
                this.menu.append(b);
            });
            this.menu.classList.remove('hidden'); this.input.setAttribute('aria-expanded', 'true');
        }
        source(c) { return { builtin: '内置命令', web: '网页操作', prompt: '模板', skill: 'Skill', extension: '扩展' }[c.source] || c.source || '命令'; }
        handleKey(e) {
            if (e.isComposing || e.keyCode === 229 || this.menu.classList.contains('hidden')) return false;
            if (e.key === 'Escape') { e.preventDefault(); this.hide(); return true; }
            if (['ArrowDown', 'ArrowUp'].includes(e.key) && this.items.length) {
                e.preventDefault(); const step = e.key === 'ArrowDown' ? 1 : -1;
                this.active = this.active < 0 ? (step > 0 ? 0 : this.items.length - 1) : (this.active + step + this.items.length) % this.items.length;
                [...this.menu.querySelectorAll('[role=option]')].forEach((b, i) => b.setAttribute('aria-selected', String(i === this.active)));
                const b = this.menu.children[this.active]; this.input.setAttribute('aria-activedescendant', b.id); b.scrollIntoView({ block: 'nearest' }); return true;
            }
            if ((e.key === 'Tab' || e.key === 'Enter' && !e.shiftKey && this.active >= 0) && this.items.length) {
                e.preventDefault(); this.choose(this.items[Math.max(0, this.active)]); return true;
            }
            return false;
        }
        choose(item) {
            if (!item) return;
            if (item.command?.available === false) return this.host.toast(item.command.description, 'info');
            const token = this.completionToken;
            const replacement = item.command ? `/${item.command.name} ` : this.reference(item.file.path) + ' ';
            this.input.setRangeText(replacement, token.start, token.end, 'end');
            this.hide(); this.host.changed(); this.input.focus();
        }
        reference(file) { return /\s|["\\]/.test(file) ? `@${JSON.stringify('./' + file)}` : `@./${file}`; }
        files(query) { return this.host.api(`/api/pi/composer/files?cwd=${encodeURIComponent(this.host.context().cwd)}&q=${encodeURIComponent(query)}`); }
        openTemplates() {
            if (!this.host.context().cwd) return this.host.toast('请先选择项目，再管理全局或项目模板', 'info');
            this.hide(); this.closeActions(); this.search.value = '';
            this.body.replaceChildren(node('p', '正在加载…'));
            this.openKey = this.key();
            if (!this.dialog.open) { this.returnFocus = document.activeElement; this.dialog.showModal(); }
            this.search.hidden = false; this.search.focus();
            this.run(async () => { if (this.enabled) await this.load(); if (this.dialog.open && this.openKey === this.key()) await this.renderPanel(); });
        }
        valid() { if (this.openKey !== this.key()) throw new Error('项目或会话已变化，请重新打开模板管理'); }
        button(text, fn) { const b = node('button', text); b.type = 'button'; b.addEventListener('click', () => this.run(fn)); return b; }
        async renderPanel() {
            this.request++; const query = this.search.value.toLowerCase();
            const restoreSearchFocus = this.body.contains(document.activeElement);
            this.body.replaceChildren();
            if (!this.enabled) { this.body.append(node('p', '模板管理暂不可用，请等待后台启用。')); return; }
            const actions = node('div', null, 'pi-composer-actions-row');
            const reload = this.button('重新加载当前会话资源', () => this.reload()); reload.disabled = !this.host.context().connected;
            actions.append(this.button('新建模板', () => this.editor()), reload);
            this.body.append(actions, node('p', '模板是按需调用的任务快捷方式：在聊天输入框输入 /名称 和参数才会展开，不会自动加入每轮对话。长期项目约定放在 AGENTS.md，README 用于项目说明。', 'pi-composer-help'));
            this.body.append(node('p', '与终端共用原生 prompts 目录。保存后，已打开的会话需空闲时重新加载；项目模板受 Pi trust 控制。覆盖与删除会留备份，同名模板被遮蔽时需改名。', 'pi-composer-help'));
                const sample = node('details'); sample.append(node('summary', '从常用任务开始'));
                for (const example of examples) sample.append(this.button(example[1], () => this.editor({ name: example[0], scope: 'user', content: `---\ndescription: ${example[1]}\n---\n${example[2]}\n` })));
                this.body.append(sample);
                for (const t of this.templates.filter(t => `${t.name} ${t.description}`.toLowerCase().includes(query))) {
                    const row = node('div', null, 'pi-composer-template'); row.append(node('strong', `/${t.name} · ${t.scope === 'user' ? '全局' : '当前项目'}`), node('small', t.description));
                    const c = this.commands().find(c => c.source === 'prompt' && (c.path || c.sourceInfo?.path) === t.filePath);
                    row.append(this.button('编辑', async () => { const key = this.key(), request = ++this.request; const record = await this.host.api(`/api/pi/composer/template?cwd=${encodeURIComponent(this.host.context().cwd)}&scope=${t.scope}&name=${encodeURIComponent(t.name)}`); if (key === this.key() && request === this.request && this.dialog.open) this.editor(record); }));
                    row.append(node('small', c ? `已加载，在输入框输入 /${c.name}${c.argumentHint ? ' ' + c.argumentHint : ''} 使用` : '尚未加载到当前会话；打开会话或重新加载后使用'));
                    row.append(this.button('删除', async () => {
                        this.valid(); if (!window.confirm(`删除 ${t.scope}/${t.name}？旧文件保留在模板备份中。`)) return;
                        const key = this.key(); await this.host.api('/api/pi/composer/template', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: this.host.context().cwd, scope: t.scope, name: t.name, expectedRevision: t.revision }) });
                        if (key !== this.key()) return;
                        await this.load(); this.host.toast('模板已删除；重新加载后从当前命令目录移除', 'success'); if (this.dialog.open) await this.renderPanel();
                    })); this.body.append(row);
                }
                for (const warning of this.catalog?.warnings || []) this.body.append(node('p', warning, 'pi-composer-help'));
                if (restoreSearchFocus && !this.search.hidden) this.search.focus();
        }
        editor(record = {}) {
            this.request++;
            this.search.hidden = true; this.body.replaceChildren(this.button('返回模板列表', () => this.openTemplates()), node('h3', record.revision ? '编辑模板' : '新建模板'));
            const form = node('form');
            const nameLabel = node('label', '命令名（字母、数字、-、_；不含 / 和 .md）'), name = node('input'); name.value = record.name || ''; name.required = true; name.pattern = '[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}'; name.disabled = Boolean(record.revision); name.id = 'pi-template-name'; nameLabel.append(name);
            const scopeLabel = node('label', '保存位置'), scope = node('select'); scope.id = 'pi-template-scope';
            for (const [value, text] of [['user', '全局 · 与所有项目共用'], ['project', '当前项目 · 需 Pi 信任后加载']]) { const option = node('option', text); option.value = value; scope.append(option); }
            scope.value = record.scope || 'user'; scope.disabled = Boolean(record.revision); scopeLabel.append(scope);
            const contentLabel = node('label', '原生 Markdown 模板'), content = node('textarea'); content.id = 'pi-template-content'; content.rows = 12; content.required = true; content.value = record.content || '---\ndescription: 简要说明此模板的用途\nargument-hint: "[补充要求]"\n---\n请完成以下任务：\n${1:-补充默认要求}\n'; contentLabel.append(content);
            const submit = node('button', '保存模板'); submit.type = 'submit';
            form.append(nameLabel, scopeLabel, contentLabel, node('p', '$1、$2 为位置参数，$@ 表示全部参数，${1:-默认值} 为可选参数；由 Pi 原生展开。', 'pi-composer-help'), submit);
            form.addEventListener('submit', e => { e.preventDefault(); this.run(async () => {
                this.valid(); const key = this.key(); submit.disabled = true;
                try {
                    await this.host.api('/api/pi/composer/template', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: this.host.context().cwd, name: name.value, scope: scope.value, content: content.value, expectedRevision: record.revision || null }) });
                    if (key !== this.key()) return;
                    this.host.toast('模板已保存。空闲时重新加载当前会话资源后可使用。', 'success'); this.openTemplates();
                } finally { submit.disabled = false; }
            }); }); this.body.append(form); name.disabled ? content.focus() : name.focus();
        }
        async reload() {
            this.valid(); const key = this.key(), request = this.request; await this.host.reload();
            if (key !== this.key()) return;
            await this.load();
            if (this.dialog.open && request === this.request) await this.renderPanel();
        }
    }
    window.PiComposerTools = PiComposerTools;
})();
