(() => {
    const t = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, i) => values[i] ?? `{${i}}`));
    const { node, icon, button } = window.PiFileElements;
    const name = path => path?.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || path || '';
    class PiFileRoots {
        constructor(host) {
            this.host = host; this.enabled = false; this.serial = 0; this.roots = []; this.revision = 0;
            this.element = node('div', 'pi-file-roots'); this.element.hidden = true;
            const mark = icon('folder-open');
            this.select = node('select'); this.select.id = 'pi-file-root-select'; this.select.ariaLabel = t('浏览位置');
            this.select.addEventListener('change', () => this.choose(this.select.value));
            this.manage = button(t('添加或管理目录'), 'folder-plus', () => this.openManager()); this.manage.id = 'pi-file-roots-manage';
            this.element.append(mark, this.select, this.manage);
            this.dialog = node('dialog', 'pi-file-roots-dialog'); this.dialog.id = 'pi-file-roots-dialog';
            this.dialog.setAttribute('aria-labelledby', 'pi-file-roots-title');
            document.body.append(this.dialog);
            this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
            this.dialog.addEventListener('click', event => { if (event.target === this.dialog) { const r = this.dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) this.close(); } });
            this.dialog.addEventListener('close', () => { if (!this.dialog.open) { this.finish?.(null); this.finish = null; this.dialogController?.abort(); } });
        }
        context() {
            const c = this.host.context();
            if (this.key !== c.key || this.generation !== c.generation || this.cwd !== c.cwd) {
                this.reset(); this.cwd = c.cwd; this.key = c.key; this.generation = c.generation; this.current = c.cwd; this.render();
            }
            return c;
        }
        reset() {
            this.serial++; this.controller?.abort(); this.dialogController?.abort(); this.close(false);
            this.loading = null; this.loaded = false; this.roots = []; this.revision = 0; this.current = null;
            this.key = null; this.generation = null; this.cwd = null;
        }
        valid(c, serial) { const now = this.host.context(); return serial === this.serial && c.cwd === now.cwd && c.key === now.key && c.generation === now.generation; }
        root() { this.context(); return this.current || this.cwd; }
        setEnabled(value) { this.enabled = value; this.element.hidden = !value; this.context(); this.render(); }
        render() {
            this.select.replaceChildren();
            const options = [...new Set([this.cwd, ...this.roots, this.current].filter(Boolean))];
            for (const root of options) {
                const label = `${name(root)}${root === this.cwd ? ' · ' + t('主目录') : !this.roots.includes(root) ? ' · ' + t('临时浏览') : ''}`;
                const option = new Option(label, root); option.title = root; this.select.append(option);
            }
            this.select.value = this.current || this.cwd || ''; this.select.title = this.current || this.cwd || '';
        }
        choose(root, notify = true) {
            this.context(); if (!root) return;
            const changed = this.current !== root; this.current = root; this.render();
            if (changed && notify) this.host.change(root);
        }
        async load(force = false) {
            if (!this.enabled) return;
            const c = this.context(); if (!c.cwd || this.loaded && !force) return;
            if (this.loading) return this.loading;
            const serial = this.serial, controller = new AbortController(); this.controller = controller;
            const promise = this.host.api(`/api/pi/files/roots?${new URLSearchParams({ cwd: c.cwd })}`, { signal: controller.signal }).then(data => {
                if (!this.valid(c, serial)) return;
                if (!Array.isArray(data.roots) || !Number.isSafeInteger(data.revision)) throw new Error(t('文件目录响应无效'));
                this.roots = data.roots; this.revision = data.revision; this.loaded = true; this.render();
            });
            this.loading = promise;
            try { await promise; } finally { if (this.loading === promise) this.loading = null; }
        }
        close(restore = true) {
            this.dialogSerial = (this.dialogSerial || 0) + 1; this.dialogController?.abort();
            this.finish?.(null); this.finish = null;
            if (this.dialog.open) this.dialog.close();
            if (restore && this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
        }
        shell(title, description) {
            this.close(false); this.returnFocus = document.activeElement;
            this.dialog.replaceChildren();
            const header = node('header', 'pi-roots-header'), heading = node('div');
            heading.append(node('h2', '', title)); heading.firstChild.id = 'pi-file-roots-title';
            heading.append(node('p', '', description)); header.append(heading, button(t('关闭'), 'xmark', () => this.close()));
            this.body = node('div', 'pi-roots-body'); this.feedback = node('p', 'pi-roots-feedback'); this.feedback.setAttribute('role', 'status');
            this.footer = node('footer', 'pi-roots-footer'); this.dialog.append(header, this.body, this.feedback, this.footer);
        }
        show() { if (!this.dialog.open) this.dialog.showModal(); }
        error(error) { if (error.name !== 'AbortError') { this.feedback.textContent = error.message; this.feedback.dataset.error = 'true'; } }
        async change(root, action) {
            if (this.saving) throw new Error(t('正在保存，请稍候'));
            const c = this.context(), serial = this.serial;
            this.saving = true;
            try {
                const data = await this.host.api('/api/pi/files/roots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: c.cwd, root, action, expectedRevision: this.revision }) });
                if (!this.valid(c, serial)) return null;
                this.roots = data.roots; this.revision = data.revision; this.loaded = true; this.render(); return data;
            } catch (error) {
                if (this.valid(c, serial)) { this.loaded = false; throw error; }
                return null;
            } finally { this.saving = false; }
        }
        async openManager() {
            this.context(); this.shell(t('浏览目录'), t('关联目录只影响文件浏览，不改变会话工作目录或 Agent 权限。'));
            const serial = this.dialogSerial, c = this.context();
            this.feedback.textContent = t('正在读取目录…'); this.show();
            try { await this.load(true); }
            catch (error) { if (serial === this.dialogSerial) { this.error(error); const retry = node('button', 'pi-roots-secondary', t('重试')); retry.onclick = () => this.openManager(); this.footer.append(retry); } return; }
            if (serial !== this.dialogSerial || c.key !== this.host.context().key) return;
            this.feedback.textContent = '';
            this.saved = node('div', 'pi-roots-saved'); this.renderSaved();
            const form = node('form', 'pi-roots-path-form'), label = node('label', '', t('打开服务器目录'));
            this.input = node('input'); this.input.id = 'pi-file-root-path'; this.input.type = 'text'; this.input.placeholder = t('输入绝对路径，或在下方选择'); this.input.maxLength = 4096; this.input.autocomplete = 'off'; this.input.spellcheck = false;
            label.htmlFor = this.input.id;
            const controls = node('div'), go = node('button', 'pi-roots-secondary', t('前往')); go.type = 'submit'; controls.append(this.input, go); form.append(label, controls);
            form.onsubmit = event => { event.preventDefault(); void this.navigate(this.input.value.trim()); };
            this.directoryBar = node('div', 'pi-roots-directory-bar'); this.directories = node('div', 'pi-roots-directories'); this.directories.setAttribute('aria-label', t('服务器目录'));
            this.body.append(this.saved, form, this.directoryBar, this.directories);
            const note = node('p', 'pi-roots-note', t('路径属于运行 Pivane 的服务器，不是当前设备。敏感目录仍受保护。')); this.body.append(note);
            this.openButton = node('button', 'pi-roots-secondary', t('临时打开')); this.openButton.type = 'button'; this.openButton.disabled = true;
            this.openButton.onclick = () => { if (this.location) { this.choose(this.location); this.close(); } };
            this.addButton = node('button', 'pi-roots-primary', t('关联并打开')); this.addButton.type = 'button'; this.addButton.disabled = true;
            this.addButton.onclick = () => void this.saveSelected(); this.footer.append(this.openButton, this.addButton);
            await this.navigate('');
        }
        renderSaved() {
            if (!this.saved) return;
            this.saved.replaceChildren();
            for (const root of [this.cwd, ...this.roots]) {
                const row = node('div', 'pi-roots-saved-row'), open = node('button', 'pi-roots-saved-open'); open.type = 'button';
                const label = node('span'); label.append(node('strong', '', name(root)), node('small', '', root)); open.append(icon(root === this.cwd ? 'house' : 'folder'), label);
                open.onclick = () => { this.choose(root); this.close(); }; row.append(open);
                if (root === this.cwd) row.append(node('span', 'pi-roots-badge', t('主目录')));
                else {
                    const remove = button(t('移除关联，不删除文件'), 'minus', async () => {
                        if (this.saving) return; const serial = this.dialogSerial; remove.disabled = true;
                        try { const result = await this.change(root, 'remove'); if (result && serial === this.dialogSerial) { if (this.current === root) this.choose(this.cwd); this.renderSaved(); this.feedback.textContent = t('已移除关联，文件未删除'); } }
                        catch (error) { if (serial === this.dialogSerial) this.error(error); }
                        finally { remove.disabled = false; }
                    }); row.append(remove);
                }
                this.saved.append(row);
            }
        }
        async navigate(path) {
            this.dialogController?.abort(); const controller = new AbortController(); this.dialogController = controller;
            const serial = this.dialogSerial; this.location = null; this.openButton.disabled = this.addButton.disabled = true;
            this.input.value = path; this.feedback.textContent = t('正在读取目录…'); delete this.feedback.dataset.error;
            this.directories.replaceChildren(); this.directoryBar.replaceChildren();
            try {
                const data = await this.host.api(`/api/pi/files/directories?${new URLSearchParams({ path })}`, { signal: controller.signal });
                if (serial !== this.dialogSerial || controller !== this.dialogController) return;
                this.location = data.current; this.input.value = data.current || ''; this.openButton.disabled = this.addButton.disabled = !data.current;
                const roots = button(t('允许的位置'), 'hard-drive', () => this.navigate(''));
                this.directoryBar.append(roots);
                if (data.parent) this.directoryBar.append(button(t('上一级目录'), 'arrow-up', () => this.navigate(data.parent)));
                const current = node('span', '', data.current || t('允许的位置')); current.title = data.current || ''; this.directoryBar.append(current);
                for (const entry of data.directories || []) {
                    const row = node('button', 'pi-roots-directory'); row.type = 'button'; row.append(icon('folder'), node('span', '', entry.name), icon('chevron-right')); row.title = entry.path;
                    row.onclick = () => this.navigate(entry.path); this.directories.append(row);
                }
                if (!data.directories?.length) this.directories.append(node('p', 'pi-roots-note', t('没有可显示的子目录，可直接打开当前位置。')));
                this.feedback.textContent = data.partial ? t('仅显示部分目录，可输入完整路径前往。') : '';
            } catch (error) { if (serial === this.dialogSerial && controller === this.dialogController) this.error(error); }
        }
        async saveSelected() {
            if (!this.location || this.saving) return;
            const root = this.location, serial = this.dialogSerial; this.addButton.disabled = true; this.addButton.textContent = t('正在保存…');
            try { const data = await this.change(root, 'add'); if (data && serial === this.dialogSerial) { this.choose(data.roots.includes(root) ? root : data.roots.at(-1) || data.cwd); this.close(); } }
            catch (error) { if (serial === this.dialogSerial) this.error(error); }
            finally { if (serial === this.dialogSerial) { this.addButton.disabled = false; this.addButton.textContent = t('关联并打开'); } }
        }
        confirmFile(file) {
            this.context(); this.shell(t('打开项目外文件'), t('此文件不在已关联的目录中。可以只查看它，或关联所在目录。'));
            const card = node('div', 'pi-roots-external'); card.append(icon('file-lines'), node('strong', '', name(file.absolutePath)), node('p', '', file.absolutePath)); this.body.append(card);
            this.body.append(node('p', 'pi-roots-note', t('仅打开文件不会列出父目录，也不会把文件加入模型上下文。')));
            const cancel = node('button', 'pi-roots-secondary', t('取消')), single = node('button', 'pi-roots-secondary', t('仅打开文件')), add = node('button', 'pi-roots-primary', t('关联目录并打开'));
            for (const b of [cancel, single, add]) b.type = 'button';
            this.footer.append(cancel, single, add); this.show();
            return new Promise(resolve => {
                this.finish = resolve;
                const done = value => { this.finish = null; resolve(value); this.close(); };
                cancel.onclick = () => done(null); single.onclick = () => done('single');
                add.onclick = async () => {
                    if (this.saving) return; const serial = this.dialogSerial; add.disabled = true;
                    try { await this.load(); const result = await this.change(file.root, 'add'); if (result && serial === this.dialogSerial) done('associated'); }
                    catch (error) { if (serial === this.dialogSerial) this.error(error); }
                    finally { add.disabled = false; }
                };
                single.focus();
            });
        }
    }
    window.PiFileRoots = PiFileRoots;
})();
