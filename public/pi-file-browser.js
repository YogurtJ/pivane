(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, i) => values[i] ?? `{${i}}`));
    const node = (tag, className, text) => { const el = document.createElement(tag); el.className = className; if (text) el.textContent = text; return el; };
    const icon = name => { const el = node('i', `fa-solid fa-${name}`); el.setAttribute('aria-hidden', 'true'); return el; };
    const button = (label, glyph, action) => {
        const el = node('button', 'pi-files-icon'); el.type = 'button'; el.title = el.ariaLabel = label; el.append(icon(glyph)); el.addEventListener('click', action); return el;
    };
    class PiFileBrowser {
        constructor(host) {
            this.host = host; this.root = document.getElementById('pi-file-explorer'); this.sequence = 0; this.memories = new Map(); this.controllers = new Set();
            const heading = node('div', 'pi-explorer-heading');
            this.project = node('strong', 'pi-explorer-project');
            this.hiddenButton = button(translateUi("显示隐藏文件"), 'eye', () => {
                this.hidden = !this.hidden; this.hiddenButton.setAttribute('aria-pressed', String(this.hidden)); this.reload();
            });
            this.hiddenButton.setAttribute('aria-pressed', 'false');
            heading.append(icon('folder-open'), this.project, this.hiddenButton,
                button(translateUi("刷新目录"), 'rotate', () => this.reload()));
            const search = node('label', 'pi-explorer-search'); search.append(icon('magnifying-glass'));
            this.input = node('input', ''); this.input.type = 'search'; this.input.maxLength = 200; this.input.autocomplete = 'off'; this.input.spellcheck = false;
            this.input.placeholder = this.input.ariaLabel = translateUi("查找文件名或路径"); search.append(this.input);
            this.input.addEventListener('input', () => this.queueSearch());
            this.status = node('p', 'pi-explorer-status'); this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
            this.tree = node('div', 'pi-explorer-tree'); this.tree.setAttribute('role', 'tree'); this.tree.ariaLabel = translateUi("项目文件");
            this.tree.addEventListener('keydown', event => this.keydown(event));
            this.root.append(heading, search, this.status, this.tree);
            this.reset();
        }
        cancel() { this.sequence++; clearTimeout(this.timer); for (const c of this.controllers) c.abort(); this.controllers.clear(); this.searchController?.abort(); }
        reset() {
            if (this.cwd && this.expanded) {
                this.memories.delete(this.cwd); this.memories.set(this.cwd, { expanded: [...this.expanded].slice(0, 128), scroll: this.tree.scrollTop, hidden: this.hidden });
                if (this.memories.size > 8) this.memories.delete(this.memories.keys().next().value);
            }
            this.cancel(); this.cwd = this.host.context().cwd; this.contextKey = this.host.context().key; this.generation = this.host.context().generation;
            const saved = this.memories.get(this.cwd);
            this.expanded = new Set(saved?.expanded || ['']); this.hidden = saved?.hidden || false;
            this.hiddenButton.setAttribute('aria-pressed', String(this.hidden)); this.input.value = ''; this.query = ''; this.searchEntries = null;
            this.directories = new Map(); this.selected = ''; this.restoreScroll = saved?.scroll || 0;
            this.project.textContent = this.cwd?.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || translateUi("项目文件"); this.project.title = this.cwd || '';
            this.tree.replaceChildren(); this.status.textContent = ''; this.focusPath = null;
        }
        valid(sequence) { const c = this.host.context(); return sequence === this.sequence && c.cwd === this.cwd && c.key === this.contextKey && c.generation === this.generation; }
        async open() {
            const c = this.host.context();
            if (c.cwd !== this.cwd || c.key !== this.contextKey || c.generation !== this.generation) this.reset();
            if (!this.cwd) { this.status.textContent = translateUi("选择项目后即可浏览文件"); return; }
            if (!this.host.enabled()) { this.status.textContent = translateUi("当前后端尚未启用项目文件浏览"); return; }
            if (!this.directories.has('')) await this.load('');
        }
        async reload() {
            this.cancel(); this.directories.clear(); this.searchEntries = null;
            if (this.input.value.trim()) this.queueSearch(0); else await this.open();
        }
        async load(relative) {
            if (this.directories.get(relative)?.loading) return;
            if (this.directories.size >= 80 && !this.directories.has(relative)) {
                this.status.textContent = translateUi("已展开较多目录，请刷新目录后继续"); return;
            }
            const sequence = this.sequence, controller = new AbortController(); this.controllers.add(controller);
            this.directories.set(relative, { loading: true, entries: [] }); this.render();
            try {
                const data = await this.host.api(`/api/pi/files/list?${new URLSearchParams({ cwd: this.cwd, path: relative, hidden: String(this.hidden) })}`, { signal: controller.signal });
                if (!this.valid(sequence)) return;
                const cached = [...this.directories.values()].reduce((total, value) => total + value.entries.length, 0);
                const entries = (data.entries || []).slice(0, Math.max(0, 4000 - cached));
                this.directories.set(relative, { entries, partial: data.partial || entries.length < (data.entries || []).length });
                this.render();
                // Restore only the branches the user had expanded, serially and within the cache budget.
                for (const entry of entries) {
                    if (!this.valid(sequence)) return;
                    if (entry.kind === 'directory' && this.expanded.has(entry.path) && !this.directories.has(entry.path)) await this.load(entry.path);
                }
                if (relative === '' && this.restoreScroll) { this.tree.scrollTop = this.restoreScroll; this.restoreScroll = 0; }
            } catch (error) {
                if (!this.valid(sequence) || error.name === 'AbortError') return;
                this.directories.set(relative, { entries: [], error: error.message }); this.render();
            } finally { this.controllers.delete(controller); }
        }
        queueSearch(delay = 240) {
            clearTimeout(this.timer); this.searchController?.abort(); this.searchSerial = (this.searchSerial || 0) + 1;
            this.query = this.input.value.trim(); this.searchEntries = null; this.searchError = ''; this.searchPartial = false;
            if (!this.query) { this.render(); return; }
            this.render();
            const serial = this.searchSerial, sequence = this.sequence, query = this.query;
            this.timer = setTimeout(async () => {
                this.searchController = new AbortController();
                try {
                    const data = await this.host.api(`/api/pi/files/search?${new URLSearchParams({ cwd: this.cwd, q: query, hidden: String(this.hidden) })}`, { signal: this.searchController.signal });
                    if (!this.valid(sequence) || serial !== this.searchSerial) return;
                    this.searchEntries = data.entries || []; this.searchPartial = data.partial;
                } catch (error) {
                    if (!this.valid(sequence) || serial !== this.searchSerial || error.name === 'AbortError') return;
                    this.searchEntries = []; this.searchError = error.message;
                }
                if (this.valid(sequence) && serial === this.searchSerial) this.render();
            }, delay);
        }
        async toggle(entry) {
            if (entry.kind !== 'directory') { this.selected = entry.path; this.render(); this.host.openFile(entry.path); return; }
            if (this.expanded.has(entry.path)) this.expanded.delete(entry.path);
            else { this.expanded.add(entry.path); if (!this.directories.has(entry.path)) await this.load(entry.path); }
            this.render();
        }
        row(entry, depth) {
            const row = node('button', 'pi-file-tree-row'); row.type = 'button'; row.dataset.path = entry.path; row.dataset.kind = entry.kind;
            row.setAttribute('role', 'treeitem'); row.setAttribute('aria-level', String(depth + 1)); row.setAttribute('aria-selected', String(entry.path === this.selected));
            row.tabIndex = -1; row.style.setProperty('--depth', Math.min(depth, 14)); row.title = entry.path;
            const folder = entry.kind === 'directory', open = this.expanded.has(entry.path);
            if (folder) row.setAttribute('aria-expanded', String(open));
            const arrow = node('span', 'pi-tree-chevron'); if (folder) arrow.append(icon(open ? 'chevron-down' : 'chevron-right'));
            const ext = entry.name.split('.').at(-1).toLowerCase();
            const glyph = folder ? (open ? 'folder-open' : 'folder') : ['md', 'txt'].includes(ext) ? 'file-lines' : ['png', 'jpg', 'svg', 'webp'].includes(ext) ? 'file-image' : 'file-code';
            const fileIcon = icon(glyph); fileIcon.classList.add('pi-tree-file-icon'); fileIcon.dataset.kind = folder ? 'folder' : ['md', 'txt'].includes(ext) ? 'document' : 'code';
            const name = node('span', 'pi-tree-name', this.query ? entry.path : entry.name);
            row.append(arrow, fileIcon, name); if (entry.link) row.append(icon('link'));
            row.addEventListener('click', () => { this.focusPath = entry.path; void this.toggle(entry); });
            row.addEventListener('focus', () => { this.focusPath = entry.path; for (const item of this.tree.querySelectorAll('[role=treeitem]')) item.tabIndex = item === row ? 0 : -1; });
            return row;
        }
        render() {
            const focused = this.tree.contains(document.activeElement), scroll = this.tree.scrollTop;
            const fragment = document.createDocumentFragment(); let partial = false;
            const branch = (relative, depth) => {
                const value = this.directories.get(relative);
                if (!value) return;
                partial ||= Boolean(value.partial);
                if (value.loading || value.error) {
                    const line = node('div', 'pi-tree-note', value.loading ? translateUi("正在读取目录…") : value.error);
                    if (value.error) line.append(button(translateUi("重试"), 'rotate', () => this.load(relative)));
                    fragment.append(line); return;
                }
                for (const entry of value.entries) {
                    fragment.append(this.row(entry, depth));
                    if (entry.kind === 'directory' && this.expanded.has(entry.path)) branch(entry.path, depth + 1);
                }
                if (!value.entries.length && relative) fragment.append(node('div', 'pi-tree-note', translateUi("空目录")));
            };
            if (this.query) {
                for (const entry of this.searchEntries || []) fragment.append(this.row(entry, 0));
                this.status.textContent = this.searchError || (this.searchEntries === null ? translateUi("正在查找文件…") : this.searchPartial ? translateUi("仅显示部分结果，请缩小搜索范围") : this.searchEntries.length ? translateUi("找到 {0} 个文件", this.searchEntries.length) : translateUi("未找到匹配文件"));
            } else {
                branch('', 0);
                this.status.textContent = partial ? translateUi("目录内容较多，仅显示部分条目") : this.directories.get('')?.entries.length === 0 && !this.directories.get('')?.loading && !this.directories.get('')?.error ? translateUi("此目录没有可显示的文件") : '';
            }
            this.tree.replaceChildren(fragment); this.tree.scrollTop = scroll;
            const rows = [...this.tree.querySelectorAll('[role=treeitem]')];
            const target = rows.find(row => row.dataset.path === this.focusPath) || rows.find(row => row.dataset.path === this.selected) || rows[0];
            if (target) { target.tabIndex = 0; if (focused) target.focus({ preventScroll: true }); }
        }
        keydown(event) {
            const row = event.target.closest('[role=treeitem]'); if (!row) return;
            const rows = [...this.tree.querySelectorAll('[role=treeitem]')], index = rows.indexOf(row); let next;
            if (event.key === 'ArrowDown') next = rows[Math.min(index + 1, rows.length - 1)];
            else if (event.key === 'ArrowUp') next = rows[Math.max(index - 1, 0)];
            else if (event.key === 'Home') next = rows[0];
            else if (event.key === 'End') next = rows.at(-1);
            else if (event.key === 'ArrowRight') { if (row.getAttribute('aria-expanded') === 'false') row.click(); else if (row.getAttribute('aria-expanded') === 'true') next = rows[index + 1]; }
            else if (event.key === 'ArrowLeft') {
                if (row.getAttribute('aria-expanded') === 'true') row.click();
                else { const parent = row.dataset.path.split('/').slice(0, -1).join('/'); next = rows.find(r => r.dataset.path === parent); }
            } else return;
            event.preventDefault(); next?.focus();
        }
        async reveal(file) {
            const context = this.host.context();
            await this.open();
            const currentContext = this.host.context();
            if (context.cwd !== currentContext.cwd || context.key !== currentContext.key || context.generation !== currentContext.generation) return;
            const sequence = this.sequence;
            let relative = file.replace(/\\/g, '/'), prefix = this.cwd.replace(/\\/g, '/').replace(/\/$/, '') + '/';
            if (relative.startsWith(prefix)) relative = relative.slice(prefix.length);
            if (relative.startsWith('/') || /^[a-z]:/i.test(relative) || relative.split('/').includes('..')) return;
            this.input.value = ''; this.queueSearch(); this.selected = relative;
            const parts = relative.split('/'); parts.pop(); let current = '';
            for (const part of parts) {
                if (!this.valid(sequence)) return;
                current = current ? `${current}/${part}` : part; this.expanded.add(current);
                if (!this.directories.has(current)) await this.load(current);
            }
            if (!this.valid(sequence)) return;
            this.focusPath = relative; this.render();
            [...this.tree.querySelectorAll('[role=treeitem]')].find(row => row.dataset.path === relative)?.scrollIntoView({ block: 'nearest' });
        }
    }
    window.PiFileBrowser = PiFileBrowser;
    window.PiFileElements = { node, icon, button };
})();
