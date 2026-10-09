/* A self-contained detail drawer. Never moves or rebinds the chat file inspector. */
(() => {
    const ui = window.PiArtifactsUI, { tr, node, icon, button } = ui;
    function bytes(data) {
        if (data.encoding === 'utf8' && typeof data.content === 'string') {
            const value = new TextEncoder().encode(data.content); if (value.length <= 2 * 1024 * 1024) return value;
        }
        if (data.encoding === 'base64' && typeof data.base64 === 'string' && data.base64.length <= 90 * 1024 * 1024
            && data.base64.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data.base64)) return Uint8Array.from(atob(data.base64), c => c.charCodeAt(0));
        throw new Error(tr('文件响应无效或超过预览预算', 'Invalid file response or preview budget exceeded'));
    }
    const TEXT_KINDS = ['text', 'markdown', 'html', 'table', 'svg'];
    class ArtifactPreview {
        constructor(api) {
            this.api = api; this.urls = new Set(); this.sequence = 0;
            // Page hooks: manage(action, file, extra), isSaved(fileKey), savedItem(fileKey), collections()
            this.dialog = node('dialog', null, 'artifacts-detail'); this.dialog.id = 'artifacts-detail'; this.dialog.setAttribute('aria-labelledby', 'artifacts-detail-title');
            const header = node('header', null, 'artifacts-detail-header');
            this.badge = node('span', null, 'artifacts-detail-badge');
            const names = node('div', null, 'artifacts-detail-names');
            this.title = node('h2'); this.title.id = 'artifacts-detail-title';
            this.meta = node('p', null, 'artifacts-detail-meta');
            names.append(this.title, this.meta);
            this.toolbar = node('div', null, 'artifacts-detail-actions');
            const act = (action, label, iconName, cls = '', iconOnly = false, iconStyle) => {
                const b = button(label, () => { void this.act(action); }, 'artifacts-btn ' + cls, { icon: iconName, iconOnly, iconStyle }); b.dataset.action = action; return b;
            };
            this.buttons = {
                save: act('save', tr('保存到成果库', 'Save to library'), 'fa-bookmark', 'is-primary'),
                restore: act('restore', tr('恢复', 'Restore'), 'fa-rotate-left', 'is-primary'),
                favorite: act('favorite', tr('加星标', 'Star'), 'fa-star', 'is-icon', true, 'fa-regular'),
                download: button(tr('下载到设备', 'Download to device'), () => { void this.downloadFile(); }, 'artifacts-btn', { icon: 'fa-download' }),
                purge: act('purge', tr('永久删除', 'Delete permanently'), 'fa-trash-can', 'is-danger'),
                delete: act('delete', tr('删除', 'Delete'), 'fa-trash-can', 'is-icon is-danger-quiet', true, 'fa-regular')
            };
            this.buttons.download.dataset.action = 'download';
            const more = button(tr('更多操作', 'More actions'), null, 'artifacts-btn is-icon', { icon: 'fa-ellipsis', iconOnly: true });
            this.moreMenu = ui.menu(more, () => this.menuItems());
            this.closeButton = button(tr('关闭预览', 'Close preview'), () => this.dialog.close(), 'artifacts-btn is-icon artifacts-close', { icon: 'fa-xmark', iconOnly: true });
            this.toolbar.append(this.buttons.save, this.buttons.restore, this.buttons.favorite, this.buttons.download, this.buttons.purge, this.buttons.delete, this.moreMenu);
            const top = node('div', null, 'artifacts-detail-top'); top.append(this.badge, names, this.toolbar, this.closeButton);
            this.chips = node('div', null, 'artifacts-detail-chips');
            header.append(top, this.chips);
            this.files = node('div', null, 'artifacts-detail-files'); this.files.setAttribute('role', 'tablist'); this.files.setAttribute('aria-label', tr('成果文件', 'Artifact files'));
            this.banner = node('div', null, 'artifacts-detail-banner');
            this.status = node('p', '', 'artifacts-detail-status'); this.status.setAttribute('role', 'status');
            this.banner.append(icon('fa-circle-info'), this.status);
            const stage = node('div', null, 'artifacts-detail-stage');
            this.modes = node('div', null, 'artifacts-detail-modes'); this.modes.setAttribute('role', 'group'); this.modes.setAttribute('aria-label', tr('显示方式', 'Display'));
            this.previewMode = button(tr('预览', 'Preview'), () => { this.source = false; this.render(); });
            this.toggle = button(tr('源码', 'Source'), () => { this.source = true; this.render(); });
            this.modes.append(this.previewMode, this.toggle);
            this.body = node('div', null, 'artifacts-preview-body'); this.body.id = 'artifacts-preview-body';
            stage.append(this.modes, this.body);
            this.dialog.append(header, this.files, this.banner, stage); document.body.append(this.dialog);
            this.dialog.addEventListener('close', () => { if (!this.dialog.open) this.release(); });
            this.dialog.addEventListener('cancel', e => { if (ui.closeMenus(true)) e.preventDefault(); });
            this.dialog.addEventListener('click', e => { if (e.target === this.dialog) { const b = this.dialog.getBoundingClientRect(); if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom) this.dialog.close(); } });
        }
        blob(value, mime) { const url = URL.createObjectURL(new Blob([value], { type: mime })); this.urls.add(url); return url; }
        cleanup() {
            this.dispose?.(); this.dispose = null;
            this.body.querySelectorAll('audio,video').forEach(n => { n.pause(); n.removeAttribute('src'); n.load(); });
            this.body.replaceChildren(); for (const url of this.urls) URL.revokeObjectURL(url); this.urls.clear(); this.downloadUrl = null;
        }
        release() { this.sequence++; this.controller?.abort(); this.cleanup(); this.data = null; this.raw = null; this.item = null; this.file = null; }
        close() { if (this.dialog.open) this.dialog.close(); else this.release(); }
        // The library copy of this file, when it has one. Source items never gain library actions implicitly.
        target() {
            if (!this.item || !this.file) return null;
            if (this.item.independent) return { item: this.item, file: this.file };
            const saved = this.savedItem?.(this.file.key);
            return saved ? { item: saved, file: saved.files[0] } : null;
        }
        // Reads prefer the independent copy, so a saved file stays readable after its source is revoked.
        readable(file) {
            if (this.item?.independent) return file;
            return this.savedItem?.(file.key)?.files[0] || file;
        }
        async act(action, extra = {}) {
            if (!this.manage || !this.file) return;
            const library = this.target(), file = library && action !== 'save' ? library.file : this.file;
            const item = library && action !== 'save' ? library.item : this.item;
            const origin = document.activeElement;
            this.toolbar.querySelectorAll('button').forEach(b => { b.disabled = true; });
            try { await this.manage(action, { ...file, revision: item.independent ? item.revision : undefined, trashed: Boolean(item.trashedAt), deletionPending: Boolean(item.deletionPending), kind: file.kind || item.types?.[0] }, item, extra); }
            finally {
                if (this.item) this.chrome();
                // Disabling the toolbar drops focus; give it back to the control that started the action.
                const lost = !document.activeElement || document.activeElement === document.body || !this.dialog.contains(document.activeElement);
                if (this.dialog.open && lost && origin?.isConnected && this.dialog.contains(origin) && origin.offsetParent && !document.querySelector('.artifacts-manage-dialog[open]')) origin.focus({ preventScroll: true });
            }
        }
        menuItems() {
            const library = this.target(), trashed = Boolean(this.item?.trashedAt);
            const run = (action, extra) => () => { void this.act(action, extra); };
            if (trashed) return [{ label: tr('文件信息', 'File information'), icon: 'fa-circle-info', run: run('location'), action: 'location' }];
            return [
                { label: tr('加入合集…', 'Add to collection…'), icon: 'fa-folder-plus', run: run('collection-add'), action: 'collection-add' },
                { label: tr('重命名…', 'Rename…'), icon: 'fa-pen', run: run('rename'), hidden: !library, action: 'rename' },
                { label: tr('设置项目标签…', 'Set project label…'), icon: 'fa-tag', run: run('project'), hidden: !library, action: 'project' },
                { separator: true },
                { label: tr('返回来源会话', 'Open source conversation'), icon: 'fa-comments', run: () => { void this.openOrigin(); }, hidden: !this.item?.origin, action: 'origin' },
                { label: tr('文件信息', 'File information'), icon: 'fa-circle-info', run: run('location'), action: 'location' },
                { label: tr('导出到服务器…', 'Export to server…'), icon: 'fa-server', run: run('export'), action: 'export' },
                { separator: true },
                { label: library?.item.hiddenAt ? tr('取消隐藏', 'Unhide') : tr('隐藏', 'Hide'), icon: library?.item.hiddenAt ? 'fa-eye' : 'fa-eye-slash', run: run(library?.item.hiddenAt ? 'unhide' : 'hide'), hidden: !library, action: 'hide' },
                { label: tr('移到回收站', 'Move to trash'), icon: 'fa-trash-arrow-up', run: run('trash'), hidden: !library, action: 'trash' }
            ];
        }
        // Header, banner and chips reflect the latest catalog without reloading the preview.
        chrome() {
            const item = this.item; if (!item) return;
            const file = this.file || item.files[0], library = this.target(), trashed = Boolean(item.trashedAt), kind = file.kind || item.types?.[0] || 'other';
            this.title.textContent = library && item.files.length === 1 ? library.item.title || library.file.name : item.title || file.name;
            this.badge.dataset.kind = kind; this.badge.replaceChildren(icon(ui.kindIcon(kind)));
            const size = this.raw ? this.raw.length : file.size;
            const when = (library?.item.savedAt || item.savedAt) ? tr(`${ui.day(library?.item.savedAt || item.savedAt)}保存`, `Saved ${ui.day(library?.item.savedAt || item.savedAt)}`) : ui.day(item.createdAt);
            this.meta.replaceChildren();
            for (const part of [ui.extension(file.name) || ui.kindLabel(kind), ui.bytes(size), (library?.item || item).project?.name, when].filter(Boolean)) this.meta.append(node('span', part));
            const b = this.buttons, favorite = Boolean(library?.item.favorite);
            b.save.hidden = Boolean(library) || trashed; b.restore.hidden = !trashed || Boolean(item.deletionPending); b.purge.hidden = !trashed;
            b.delete.hidden = trashed || !library; b.download.hidden = trashed; this.moreMenu.hidden = false;
            b.favorite.hidden = trashed;
            ui.relabel(b.favorite, favorite ? tr('取消星标', 'Unstar') : library ? tr('加星标', 'Star') : tr('保存并加星标', 'Save & star'));
            b.favorite.querySelector('i').className = (favorite ? 'fa-solid' : 'fa-regular') + ' fa-star';
            b.favorite.setAttribute('aria-pressed', String(favorite)); b.favorite.classList.toggle('is-on', favorite);
            this.toolbar.querySelectorAll('button').forEach(button => { button.disabled = false; });
            b.download.disabled = !this.raw;
            // Collections are shown where they apply, each removable in place.
            this.chips.replaceChildren();
            if (library && !trashed) {
                const names = new Map((this.collections?.() || []).map(c => [c.id, c.name]));
                for (const id of library.item.collections || []) {
                    if (!names.has(id)) continue;
                    const chip = node('span', null, 'artifacts-chip'); chip.append(icon('fa-folder', 'fa-regular'), node('span', names.get(id)));
                    chip.append(button(tr(`移出「${names.get(id)}」`, `Remove from “${names.get(id)}”`), () => { void this.act('collection-remove', { collectionId: id }); }, 'artifacts-chip-remove', { icon: 'fa-xmark', iconOnly: true }));
                    this.chips.append(chip);
                }
                this.chips.append(button(tr('加入合集', 'Add to collection'), () => { void this.act('collection-add'); }, 'artifacts-chip is-add', { icon: 'fa-plus' }));
            }
            this.chips.hidden = !this.chips.children.length;
            this.files.querySelectorAll('[data-key]').forEach(tab => { tab.classList.toggle('is-saved', Boolean(this.isSaved?.(tab.dataset.key)) && !item.independent); });
            const tone = trashed ? 'danger' : library ? 'quiet' : 'warn';
            this.banner.dataset.tone = tone;
            if (trashed) this.status.textContent = item.deletionPending ? tr('上次删除没有完成。请重新确认永久删除；不会自动重试。', 'The previous deletion did not finish. Confirm permanent deletion again; nothing is retried automatically.') : tr('这个文件在回收站中，仍占用空间。恢复后才能预览和下载。', 'This file is in trash and still uses space. Restore it to preview or download.');
            else if (!library) this.status.textContent = tr('还没有保存到成果库。来源聊天或媒体历史删除后，它将无法找回。', 'Not saved to the library yet. It will be lost if the source conversation or media history is deleted.');
            else this.status.textContent = '';
            this.banner.hidden = !this.status.textContent || this.loadingError;
        }
        open(item) {
            this.release(); this.item = item; ui.closeMenus();
            this.files.replaceChildren(); this.files.hidden = item.files.length < 2;
            for (const file of item.files) {
                const tab = button(file.name, () => { void this.select(file); }, 'artifacts-file-tab', { icon: ui.kindIcon(file.kind || item.types?.[0]) });
                tab.dataset.key = file.key; tab.setAttribute('role', 'tab'); this.files.append(tab);
            }
            if (!this.dialog.open) { this.dialog.showModal(); ui.layer(this.dialog); }
            void this.select(item.files[0]);
        }
        // After a mutation: keep the same preview when the bytes are the same file.
        sync(next) {
            if (!this.dialog.open || !this.item) return;
            if (!next) { this.close(); return; }
            const wasTrashed = Boolean(this.item.trashedAt);
            // The same file stays selected: by key within a group, or a saved copy of the shown source.
            const current = this.file && next.files.find(f => f.key === this.file.key || (next.files.length === 1 && next.sourceKey === this.file.key));
            if (!current || Boolean(next.trashedAt) !== wasTrashed) { this.open(next); return; }
            this.item = next; this.file = current; this.chrome();
        }
        loading(text) {
            const box = node('div', null, 'artifacts-preview-state'); box.append(node('span', null, 'artifacts-spinner is-large'), node('p', text)); this.body.replaceChildren(box);
        }
        failure(message) {
            const box = node('div', null, 'artifacts-preview-state is-error'); box.append(icon('fa-circle-exclamation'), node('p', message));
            box.append(button(tr('重试', 'Retry'), () => { if (this.file) void this.select(this.file); }, 'artifacts-btn')); this.body.replaceChildren(box);
        }
        async select(file) {
            this.controller?.abort(); this.controller = new AbortController(); const seq = ++this.sequence;
            this.cleanup(); this.file = file; this.data = null; this.raw = null; this.source = false; this.loadingError = false;
            this.files.querySelectorAll('[data-key]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.key === file.key)));
            this.modes.hidden = true; this.chrome();
            if (this.item.trashedAt) {
                const box = node('div', null, 'artifacts-preview-state'); box.append(icon('fa-trash-can', 'fa-regular'), node('p', tr('恢复后可以预览和下载。', 'Restore to preview or download.')));
                this.body.append(box); return;
            }
            this.loading(tr('正在读取文件…', 'Reading file…'));
            try {
                const data = await this.api(`/api/pi/artifacts/${this.readable(file).key}/preview`, { signal: this.controller.signal });
                if (seq !== this.sequence || !this.dialog.open) return;
                this.raw = bytes(data); this.data = data;
                this.chrome(); this.render();
            } catch (error) {
                if (seq !== this.sequence || error.name === 'AbortError') return;
                this.loadingError = true; this.chrome(); this.failure(error.message);
            }
        }
        render() {
            this.cleanup(); const data = this.data; if (!data) return;
            const text = TEXT_KINDS.includes(data.kind) && data.kind !== 'text';
            this.modes.hidden = !text;
            this.previewMode.setAttribute('aria-pressed', String(!this.source)); this.toggle.setAttribute('aria-pressed', String(Boolean(this.source)));
            this.body.dataset.kind = this.source ? 'text' : data.kind;
            if (TEXT_KINDS.includes(data.kind) && (this.source || data.kind === 'text')) { const pre = node('pre', data.content, 'artifacts-code'); this.body.append(pre); return; }
            if (data.kind === 'html') {
                const note = node('p', null, 'artifacts-preview-note'); note.append(icon('fa-shield-halved'), node('span', tr('安全静态预览：已禁用脚本、外部资源和表单。下载后可在本地完整运行。', 'Safe static preview: scripts, external resources and forms are disabled. Download to run it locally.')));
                const frame = node('iframe'); frame.title = this.file.name; frame.setAttribute('sandbox', ''); frame.setAttribute('credentialless', ''); frame.referrerPolicy = 'no-referrer';
                frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; clipboard-read 'none'; clipboard-write 'none'");
                const template = document.createElement('template'); template.innerHTML = data.content;
                template.content.querySelectorAll('script,base,meta[http-equiv],iframe,frame,object,embed,form').forEach(n => n.remove());
                // Static links must not navigate an opaque frame to remote pages.
                template.content.querySelectorAll('[href],[xlink\\:href]').forEach(n => { for (const attr of ['href', 'xlink:href']) if (n.hasAttribute(attr) && !n.getAttribute(attr).startsWith('#')) n.removeAttribute(attr); });
                const csp = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
                frame.srcdoc = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + csp + '">' + template.innerHTML;
                this.body.append(note, frame); return;
            }
            if (data.kind === 'markdown') {
                const article = node('article', null, 'pi-markdown artifacts-paper'); article.innerHTML = window.PiFileViewer.markdown(data.content, this.file.name, true);
                article.querySelectorAll('a').forEach(a => { if (/^https?:\/\//i.test(a.getAttribute('href') || '')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; } else a.removeAttribute('href'); });
                // Markdown must not send embedded images to the network.
                article.querySelectorAll('img').forEach(img => { if (!/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(img.getAttribute('src') || '')) img.removeAttribute('src'); });
                this.body.append(article); return;
            }
            if (data.kind === 'video') { const video = node('video'); video.controls = true; video.preload = 'metadata'; video.playsInline = true; video.src = this.blob(this.raw, 'video/mp4'); this.body.append(video); return; }
            if (['image', 'svg', 'audio', 'pdf', 'table'].includes(data.kind)) {
                this.dispose = window.PiFilePreviews.render(this.body, data, { name: this.file.name, bytes: () => this.raw,
                    blob: (value, mime) => this.blob(value, mime), state: {}, isFullscreen: () => true }); return;
            }
            const box = node('div', null, 'artifacts-preview-state'); box.append(icon(ui.kindIcon(this.file.kind || 'other')), node('p', tr('这种格式暂不支持预览。可以下载原文件，用对应的应用打开。', 'This format cannot be previewed. Download the original and open it in its app.')));
            box.append(button(tr('下载到设备', 'Download to device'), () => { void this.downloadFile(); }, 'artifacts-btn', { icon: 'fa-download' })); this.body.append(box);
        }
        async downloadFile() {
            const seq = this.sequence, file = this.readable(this.file); this.buttons.download.disabled = true;
            try {
                // Download is a new read, not a stale preview-blob link. Re-check
                // branch revocation and history deletion at the moment of use.
                const data = await this.api(`/api/pi/artifacts/${file.key}/preview`, { signal: this.controller.signal });
                if (seq !== this.sequence || !this.dialog.open) return;
                if (this.downloadUrl) { URL.revokeObjectURL(this.downloadUrl); this.urls.delete(this.downloadUrl); }
                const url = this.blob(bytes(data), 'application/octet-stream'); this.downloadUrl = url;
                const a = node('a'); a.href = url; a.download = file.name; a.hidden = true; this.dialog.append(a); a.click(); a.remove();
                ui.toast({ tone: 'success', message: tr(`已开始下载「${file.name}」`, `Downloading “${file.name}”`) });
            } catch (error) { if (seq === this.sequence && error.name !== 'AbortError') ui.toast({ tone: 'error', message: error.message }); }
            finally { if (seq === this.sequence) this.buttons.download.disabled = !this.raw; }
        }
        async openOrigin() {
            const seq = this.sequence;
            try {
                const target = await this.api(`/api/pi/artifacts/${this.file.key}/origin`, { signal: this.controller.signal });
                if (seq !== this.sequence || !this.dialog.open) return;
                this.close(); await window.PiChatNavigation.openSession(target);
            } catch (error) { if (seq === this.sequence && error.name !== 'AbortError') ui.toast({ tone: 'error', message: error.message }); }
        }
    }
    window.PiArtifactPreview = ArtifactPreview;
})();
