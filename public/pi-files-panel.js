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
            const modes = node('div', 'pi-files-modes'); modes.append(this.projectButton, this.historyButton);
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
            $('pi-changes-tab').addEventListener('click', () => {
                if (!this.enabled && this.history?.rounds.size) { this.showHistory(); this.history.open(); }
                else this.openProject(true);
            });
            document.addEventListener('click', event => {
                const link = event.target.closest('a[href]');
                if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || !link
                    || !link.closest('#pi-transcript-content .assistant .pi-markdown, #pi-side-messages .assistant .pi-markdown, .pi-file-markdown')) return;
                const target = window.PiFileViewer.linkTarget(link.getAttribute('href')); if (!target) return;
                event.preventDefault(); this.returnLink = link; this.openPath(target);
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
            new ResizeObserver(() => {
                cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
                    const wide = $('pi-changes').clientWidth >= 760;
                    if (wide !== this.wide) { this.wide = wide; this.sync(); }
                });
            }).observe($('pi-changes'));
            this.sync();
        }
        bindHistory(history) { this.history = history; }
        setEnabled(value) { this.enabled = value; this.sync(); }
        reset() {
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
        returnFocus() { if (this.returnLink?.isConnected) this.returnLink.focus({ preventScroll: true }); else if (this.mode === 'history') this.history.returnFocus(); else $('pi-changes-tab').focus(); }
        showHistory() {
            this.mode = 'history'; this.browsing = false; this.returnLink = null; this.history.active = true;
            this.host.showPane('changes'); this.sync();
        }
        openProject(browse = true) {
            this.viewer.rememberPosition();
            this.mode = 'project'; this.browsing = browse || !this.viewer.file; if (this.history) this.history.active = false;
            this.host.showPane('changes'); this.sync(); if (this.browsing) void this.browser.open();
        }
        openPath(target) {
            if (this.history) this.history.active = false;
            this.mode = 'project'; this.browsing = Boolean(this.wide && this.browsing);
            $('pi-changes-diffs').replaceChildren(); $('pi-changes-empty').hidden = true; $('pi-changes-content').hidden = false;
            $('pi-changes-file-list').hidden = true;
            this.viewer.setFile({ ...target, identity: `project:${target.path}:${target.line || ''}`, hasDiff: false, writes: [] });
            this.host.showPane('changes'); this.sync(); this.viewer.restorePosition(); $('pi-changes-title').focus({ preventScroll: true });
        }
        selected(file) {
            this.breadcrumb.replaceChildren();
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
            $('pi-file-reader').hidden = this.mode === 'project' && this.browsing && (!this.wide || !hasFile);
            this.projectButton.setAttribute('aria-pressed', String(this.mode === 'project'));
            this.historyButton.setAttribute('aria-pressed', String(this.mode === 'history'));
            this.browseButton.setAttribute('aria-pressed', String(this.mode === 'project' && this.browsing));
            this.expandButton.setAttribute('aria-pressed', String($('pi-inspector').classList.contains('files-expanded')));
            this.expandButton.title = this.expandButton.ariaLabel = $('pi-inspector').classList.contains('files-expanded') ? translateUi("收起阅读区") : translateUi("展开阅读");
            this.locate.hidden = !this.enabled; this.browseButton.hidden = !this.enabled;
        }
    }
    window.PiFilesPanel = PiFilesPanel;
})();
