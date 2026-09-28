(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, i) => values[i] ?? `{${i}}`));
    const $ = id => document.getElementById(id);
    const { node, icon, button } = window.PiFileElements;
    class PiFilesPanel {
        constructor(host) {
            this.host = host; this.mode = 'project'; this.browsing = true; this.enabled = false;
            this.viewer = new window.PiFileViewer({ ...host, selected: file => this.selected(file) });
            this.browser = new window.PiFileBrowser({ ...host, enabled: () => this.enabled, openFile: path => this.openPath({ path }) });
            this.projectButton = node('button', '', translateUi("项目文件")); this.projectButton.id = 'pi-files-project'; this.projectButton.type = 'button';
            this.historyButton = node('button', '', translateUi("本轮文件")); this.historyButton.id = 'pi-files-history'; this.historyButton.type = 'button';
            this.projectButton.addEventListener('click', () => this.openProject());
            this.historyButton.addEventListener('click', () => { this.showHistory(); this.history.open(); });
            this.deliveriesButton = node('button', '', translateUi('交付物')); this.deliveriesButton.id = 'pi-files-deliveries'; this.deliveriesButton.type = 'button'; this.deliveriesButton.hidden = true;
            this.deliveriesButton.addEventListener('click', () => this.openDeliveries());
            this.deliveriesList = node('section', 'pi-deliveries-list'); this.deliveriesList.id = 'pi-deliveries-list'; this.deliveriesList.hidden = true;
            this.deliveriesList.setAttribute('aria-label', translateUi('当前分支交付物')); $('pi-file-explorer').before(this.deliveriesList);
            this.openSequence = 0;
            const modes = node('div', 'pi-files-modes'); modes.append(this.projectButton, this.historyButton, this.deliveriesButton);
            this.browseButton = button(translateUi("浏览项目文件"), 'folder-tree', () => this.openProject(!this.browsing)); this.browseButton.id = 'pi-files-browse';
            this.expandButton = button(translateUi("展开阅读"), 'expand', () => {
                $('pi-inspector').classList.toggle('files-expanded'); this.sync();
            }); this.expandButton.id = 'pi-files-expand';
            $('pi-files-toolbar').append(modes, this.browseButton, this.expandButton);
            this.breadcrumb = node('nav', 'pi-file-breadcrumb'); this.breadcrumb.ariaLabel = translateUi("文件路径");
            this.copyPath = button(translateUi("复制文件路径"), 'copy', () => {
                if (this.viewer.file) void host.copy(this.viewer.file.path).then(() => host.notify(translateUi("已复制文件路径"), 'success')).catch(e => host.notify(e.message, 'error'));
            }); this.copyPath.id = 'pi-file-copy-path';
            this.locate = button(translateUi("在项目中定位"), 'crosshairs', () => {
                const path = this.viewer.file?.path;
                this.openProject(true); if (path) void this.browser.reveal(path);
            }); this.locate.id = 'pi-file-locate';
            $('pi-changes-title').after(this.breadcrumb, this.locate, this.copyPath);
            $('pi-changes-tab').addEventListener('click', () => this.reopen());
            document.addEventListener('click', event => {
                const link = event.target.closest('a[href]');
                if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || !link
                    || !link.closest('#pi-transcript-content .assistant .pi-markdown, #pi-side-messages .assistant .pi-markdown, .pi-file-markdown')) return;
                const target = window.PiFileViewer.linkTarget(link.getAttribute('href')); if (!target) return;
                event.preventDefault(); this.returnLink = link; void this.openLink(target);
            });
            $('pi-close-inspector').addEventListener('click', () => { if ($('pi-inspector').classList.contains('show-changes')) this.returnFocus(); });
            $('pi-inspector').addEventListener('keydown', event => {
                if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || !$('pi-inspector').classList.contains('show-changes') || document.querySelector('dialog[open]')) return;
                event.preventDefault(); event.stopPropagation();
                const menu = ['pi-file-info', 'pi-changes-file-list'].map($).find(el => el.open);
                if (menu) { menu.open = false; menu.querySelector('summary').focus(); }
                else if (this.browsing && this.viewer.file) { this.browsing = false; this.sync(); this.browseButton.focus(); }
                else if ($('pi-inspector').classList.contains('files-expanded')) { $('pi-inspector').classList.remove('files-expanded'); this.sync(); this.expandButton.focus(); }
                else { $('pi-inspector').classList.remove('open'); this.returnFocus(); }
            });
            let frame;
            this.panelWasOpen = false;
            new MutationObserver(() => {
                const pane = $('pi-inspector'), open = pane.classList.contains('open') && pane.classList.contains('show-changes');
                if (open && !this.panelWasOpen && this.mode === 'project' && this.browsing) void this.browser.open();
                this.panelWasOpen = open;
            }).observe($('pi-inspector'), { attributes: true, attributeFilter: ['class'] });
            new ResizeObserver(() => {
                cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
                    const wide = $('pi-changes').clientWidth >= 760;
                    if (wide !== this.wide) { this.wide = wide; this.sync(); }
                });
            }).observe($('pi-changes'));
            this.sync();
        }
        bindHistory(history) { this.history = history; }
        rememberContext() { this.paneContext = { ...this.host.context() }; }
        reopen() {
            const current = this.host.context(), saved = this.paneContext;
            if (saved && saved.cwd === current.cwd && saved.key === current.key && saved.generation === current.generation) {
                // Keep the current source, diff/full mode, directory/list position
                // and reader DOM. Reopening is not a refresh or a new selection.
                if (this.history) this.history.active = this.mode === 'history';
                this.host.showPane('changes'); this.sync();
                if (this.mode === 'project' && this.browsing) void this.browser.open();
                return;
            }
            if (saved) this.reset();
            if (!this.enabled && this.history?.rounds.size) { this.showHistory(); this.history.open(); }
            else this.openProject(true);
        }
        setEnabled(value) { this.enabled = value; this.sync(); }
        setCapabilities({ previews, deliverables }) {
            this.viewer.previewsEnabled = Boolean(previews); this.deliverablesEnabled = Boolean(deliverables);
            this.viewer.deliverablesEnabled = Boolean(deliverables); this.deliveriesButton.hidden = !deliverables; this.sync();
        }
        cancelOpen() { this.openSequence++; this.openController?.abort(); this.openController = null; }
        sameContext(context, sequence) { const now = this.host.context(); return sequence === this.openSequence && context.key === now.key && context.generation === now.generation; }
        async openLink(target) {
            this.cancelOpen();
            if (target.deliveryId) { this.openDelivery(target); return; }
            const context = this.host.context(), sequence = this.openSequence;
            if (this.deliverablesEnabled && context.sessionId) {
                this.openController = new AbortController();
                try {
                    const data = await this.host.api(`/api/pi/deliverables?${new URLSearchParams({ cwd: context.cwd, sessionId: context.sessionId, path: target.path })}`, { signal: this.openController.signal });
                    if (!this.sameContext(context, sequence)) return;
                    if (data.items?.[0]) { this.openDelivery({ deliveryId: data.items[0].id, index: data.items[0].index, path: data.items[0].name }); return; }
                } catch (error) {
                    if (!this.sameContext(context, sequence) || error.name === 'AbortError') return;
                    this.host.notify(error.message, 'error'); return;
                }
            }
            if (this.sameContext(context, sequence)) this.openPath(target);
        }
        openDelivery(target) {
            this.cancelOpen();
            if (!this.deliverablesEnabled || !this.host.context().sessionId) { this.host.notify(translateUi('当前会话尚不能读取交付物'), 'error'); return; }
            this.rememberContext();
            if (this.history) this.history.active = false;
            this.mode = 'delivery'; this.browsing = false;
            $('pi-changes-diffs').replaceChildren(); $('pi-changes-empty').hidden = true; $('pi-changes-content').hidden = false; $('pi-changes-file-list').hidden = true;
            this.viewer.setFile({ ...target, path: target.path || translateUi('交付文件'), identity: `delivery:${target.deliveryId}/${target.index}`, hasDiff: false, writes: [] });
            this.host.showPane('changes'); this.sync(); $('pi-changes-title').focus({ preventScroll: true });
        }
        async openDeliveries() {
            this.cancelOpen(); this.rememberContext(); this.viewer.clear(); this.mode = 'deliveries'; this.browsing = false;
            if (this.history) this.history.active = false;
            this.deliveriesList.replaceChildren(); $('pi-changes-content').hidden = false; $('pi-changes-empty').hidden = true;
            this.host.showPane('changes'); this.sync();
            const context = this.host.context(), sequence = this.openSequence;
            if (!context.sessionId) { this.deliveriesList.append(node('p', 'pi-file-large-note', translateUi('打开线程后查看已交付的成果'))); return; }
            const message = node('p', 'pi-file-large-note', translateUi('正在读取交付物…')); this.deliveriesList.append(message);
            this.openController = new AbortController();
            try {
                const data = await this.host.api(`/api/pi/deliverables?${new URLSearchParams({ cwd: context.cwd, sessionId: context.sessionId })}`, { signal: this.openController.signal });
                if (!this.sameContext(context, sequence)) return;
                this.deliveriesList.replaceChildren();
                const toolbar = node('div', 'pi-deliveries-heading'); toolbar.append(node('p', '', translateUi('交付时保存的版本，不随源文件变化')), button(translateUi('刷新'), 'rotate', () => this.openDeliveries())); this.deliveriesList.append(toolbar);
                for (const item of data.items || []) {
                    const card = node('button', 'pi-delivery-card'); card.type = 'button'; card.disabled = Boolean(item.unavailable);
                    card.append(icon('file'), node('strong', '', item.name), node('span', '', item.unavailable ? translateUi('交付文件暂不可用') : `${item.title} · ${Math.ceil(item.size / 1024)} KiB`));
                    card.addEventListener('click', () => { this.returnLink = card; this.openDelivery({ deliveryId: item.id, index: item.index, path: item.name }); }); this.deliveriesList.append(card);
                }
                if (!data.items?.length) this.deliveriesList.append(node('p', 'pi-file-large-note', translateUi('尚无交付物。Agent 使用 deliver_files 登记成果后会显示在这里。')));
                if (data.partial) this.deliveriesList.append(node('p', 'pi-file-large-note', translateUi('仅展示最近 200 个文件；较早成果仍可通过原链接打开。')));
            } catch (error) { if (this.sameContext(context, sequence) && error.name !== 'AbortError') { this.deliveriesList.replaceChildren(node('p', 'pi-file-large-note', error.message)); } }
        }
        reset() {
            this.cancelOpen(); this.paneContext = null; this.deliveriesList.replaceChildren();
            this.viewer.clear(); this.browser.reset(); this.mode = 'project'; this.browsing = true; this.returnLink = null;
            $('pi-changes-content').hidden = true;
            for (const id of ['pi-changes-diffs', 'pi-changes-files', 'pi-changes-round', 'pi-file-source']) $(id).replaceChildren();
            $('pi-file-path').textContent = ''; $('pi-file-status').textContent = '';
            $('pi-changes-title').textContent = translateUi("文件");
            this.breadcrumb.replaceChildren(); this.sync();
            // The coordinator updates the thread and socket identity in the same
            // turn. Reopen metadata only after that context transition is complete.
            queueMicrotask(() => {
                const pane = $('pi-inspector');
                if (pane.classList.contains('open') && pane.classList.contains('show-changes') && this.mode === 'project') void this.browser.open();
            });
        }
        returnFocus() {
            queueMicrotask(() => {
                if ($('pi-inspector').classList.contains('open')) return;
                if (this.returnLink?.isConnected) this.returnLink.focus({ preventScroll: true });
                else if (this.mode === 'history') this.history.returnFocus();
                else $(innerWidth <= 900 ? 'pi-tools-toggle' : 'pi-tool-changes')?.focus({ preventScroll: true });
            });
        }
        showHistory() {
            this.cancelOpen(); this.rememberContext(); this.viewer.stopInteractive();
            this.mode = 'history'; this.browsing = false; this.returnLink = null; this.history.active = true;
            this.host.showPane('changes'); this.sync();
        }
        openProject(browse = true) {
            this.cancelOpen(); this.rememberContext();
            this.viewer.rememberPosition(); this.viewer.stopInteractive();
            if (this.viewer.file?.deliveryId) this.viewer.clear();
            this.mode = 'project'; this.browsing = browse || !this.viewer.file; if (this.history) this.history.active = false;
            this.host.showPane('changes'); this.sync(); if (this.browsing) void this.browser.open();
        }
        openPath(target) {
            this.cancelOpen(); this.rememberContext();
            if (this.history) this.history.active = false;
            this.mode = 'project'; this.browsing = Boolean(this.wide && this.browsing);
            $('pi-changes-diffs').replaceChildren(); $('pi-changes-empty').hidden = true; $('pi-changes-content').hidden = false;
            $('pi-changes-file-list').hidden = true;
            this.viewer.setFile({ ...target, identity: `project:${target.path}:${target.line || ''}`, hasDiff: false, writes: [] });
            this.host.showPane('changes'); this.sync(); this.viewer.restorePosition(); $('pi-changes-title').focus({ preventScroll: true });
        }
        selected(file) {
            this.rememberContext(); this.breadcrumb.replaceChildren();
            if (file.deliveryId) {
                this.breadcrumb.append(button(translateUi('交付物'), 'box', () => this.openDeliveries()), icon('chevron-right'), node('span', 'pi-breadcrumb-current', file.path));
                this.breadcrumb.title = translateUi('交付快照'); $('pi-changes').classList.add('file-current-only'); this.locate.hidden = true; return;
            }
            const cwd = this.host.context().cwd.replace(/\\/g, '/').replace(/\/$/, '');
            let relative = file.path.replace(/\\/g, '/'); if (relative.startsWith(cwd + '/')) relative = relative.slice(cwd.length + 1);
            const parts = relative.split('/');
            const home = button(translateUi("项目根目录"), 'folder', () => { this.openProject(true); void this.browser.reveal(''); });
            this.breadcrumb.append(home);
            parts.forEach((part, index) => {
                this.breadcrumb.append(icon('chevron-right'));
                if (index === parts.length - 1) this.breadcrumb.append(node('span', 'pi-breadcrumb-current', part));
                else {
                    const item = node('button', '', part); item.type = 'button';
                    item.addEventListener('click', () => { this.openProject(true); void this.browser.reveal(parts.slice(0, index + 1).join('/') + '/'); });
                    this.breadcrumb.append(item);
                }
            });
            this.breadcrumb.title = relative; this.browser.selected = relative; this.browser.render();
            $('pi-changes').classList.toggle('file-current-only', !file.hasDiff && !file.writes.length);
        }
        sync() {
            const hasFile = Boolean(this.viewer.file);
            $('pi-changes').classList.toggle('files-wide', Boolean(this.wide));
            $('pi-changes').classList.toggle('files-browsing', this.mode === 'project' && this.browsing);
            $('pi-changes').classList.toggle('files-has-file', hasFile);
            $('pi-file-explorer').hidden = this.mode !== 'project' || !this.browsing;
            this.deliveriesList.hidden = this.mode !== 'deliveries';
            $('pi-file-reader').hidden = this.mode === 'deliveries' || this.mode === 'project' && this.browsing && (!this.wide || !hasFile);
            this.deliveriesButton.setAttribute('aria-pressed', String(['deliveries', 'delivery'].includes(this.mode)));
            this.projectButton.setAttribute('aria-pressed', String(this.mode === 'project'));
            this.historyButton.setAttribute('aria-pressed', String(this.mode === 'history'));
            this.browseButton.setAttribute('aria-pressed', String(this.mode === 'project' && this.browsing));
            this.expandButton.setAttribute('aria-pressed', String($('pi-inspector').classList.contains('files-expanded')));
            this.expandButton.title = this.expandButton.ariaLabel = $('pi-inspector').classList.contains('files-expanded') ? translateUi("收起阅读区") : translateUi("展开阅读");
            this.locate.hidden = !this.enabled || Boolean(this.viewer.file?.deliveryId); this.browseButton.hidden = !this.enabled;
        }
    }
    window.PiFilesPanel = PiFilesPanel;
})();
