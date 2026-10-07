/* A self-contained detail viewer. Never moves or rebinds the chat file inspector. */
(() => {
    const tr = (zh, en) => window.PiI18n?.locale?.startsWith('en') ? en : zh;
    const node = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
    const button = (label, fn, cls = '') => { const n = node('button', label, cls); n.type = 'button'; n.addEventListener('click', fn); return n; };
    function bytes(data) {
        if (data.encoding === 'utf8' && typeof data.content === 'string') {
            const value = new TextEncoder().encode(data.content); if (value.length <= 2 * 1024 * 1024) return value;
        }
        if (data.encoding === 'base64' && typeof data.base64 === 'string' && data.base64.length <= 90 * 1024 * 1024
            && data.base64.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data.base64)) return Uint8Array.from(atob(data.base64), c => c.charCodeAt(0));
        throw new Error(tr('文件响应无效或超过预览预算', 'Invalid file response or preview budget exceeded'));
    }
    class ArtifactPreview {
        constructor(api) {
            this.api = api; this.urls = new Set(); this.sequence = 0;
            this.dialog = node('dialog', null, 'artifacts-detail'); this.dialog.id = 'artifacts-detail'; this.dialog.setAttribute('aria-labelledby', 'artifacts-detail-title');
            const header = node('header'), names = node('div');
            this.eyebrow = node('small'); this.title = node('h2'); this.title.id = 'artifacts-detail-title'; names.append(this.eyebrow, this.title);
            this.closeButton = button('×', () => this.dialog.close(), 'artifacts-close'); this.closeButton.setAttribute('aria-label', tr('关闭预览', 'Close preview'));
            header.append(names, this.closeButton);
            this.files = node('div', null, 'artifacts-detail-files'); this.files.setAttribute('aria-label', tr('成果文件', 'Artifact files'));
            this.actions = node('div', null, 'artifacts-detail-actions');
            this.toggle = button(tr('查看源码', 'View source'), () => { this.source = !this.source; this.render(); });
            this.download = button(tr('下载原文件', 'Download original'), () => { void this.downloadFile(); });
            this.origin = button(tr('返回来源会话', 'Open source conversation'), () => { void this.openOrigin(); });
            this.actions.append(this.toggle, this.download, this.origin);
            this.managementButtons = [];
            this.managementMenu = node('details', null, 'artifacts-detail-management');
            this.managementMenu.append(node('summary', tr('整理与管理', 'Organize and manage')));
            const managementActions = node('div', null, 'artifacts-management-actions'); this.managementMenu.append(managementActions); this.actions.append(this.managementMenu);
            for (const [action, label] of [['save', tr('保存到成果库', 'Save to library')], ['favorite', tr('收藏／取消收藏', 'Toggle favorite')], ['rename', tr('重命名', 'Rename')], ['collection-add', tr('加入收藏夹', 'Add to collection')], ['project', tr('关联项目', 'Link project')], ['location', tr('位置与来源', 'Location and origin')], ['export', tr('保存到文件夹', 'Save to folder')], ['trash', tr('移入回收站', 'Trash')], ['restore', tr('恢复', 'Restore')]]) {
                const b = button(label, async () => { if (!this.manage) return; const file = this.file; this.managementButtons.forEach(button => { button.disabled = true; }); try { await this.manage(action, file); } finally { this.managementButtons.forEach(button => { button.disabled = false; }); } });
                b.dataset.action = action; this.managementButtons.push(b);
                if (['save', 'favorite'].includes(action)) this.actions.insertBefore(b, this.managementMenu); else managementActions.append(b);
            }
            this.meta = node('div', null, 'artifacts-detail-meta');
            this.body = node('div', null, 'artifacts-preview-body'); this.body.id = 'artifacts-preview-body';
            this.status = node('p', '', 'artifacts-detail-status'); this.status.setAttribute('role', 'status');
            this.dialog.append(header, this.files, this.actions, this.meta, this.status, this.body); document.body.append(this.dialog);
            this.dialog.addEventListener('close', () => { if (!this.dialog.open) this.release(); });
            this.dialog.addEventListener('click', e => { if (e.target === this.dialog) { const b = this.dialog.getBoundingClientRect(); if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom) this.dialog.close(); } });
        }
        blob(value, mime) { const url = URL.createObjectURL(new Blob([value], { type: mime })); this.urls.add(url); return url; }
        cleanup() {
            this.dispose?.(); this.dispose = null;
            this.body.querySelectorAll('audio,video').forEach(n => { n.pause(); n.removeAttribute('src'); n.load(); });
            this.body.replaceChildren(); for (const url of this.urls) URL.revokeObjectURL(url); this.urls.clear(); this.downloadUrl = null;
        }
        release() { this.sequence++; this.controller?.abort(); this.cleanup(); this.data = null; this.raw = null; this.item = null; }
        close() { if (this.dialog.open) this.dialog.close(); else this.release(); }
        open(item) {
            this.release(); this.item = item; this.title.textContent = item.title || item.files[0].name;
            this.eyebrow.textContent = item.independent ? tr('独立成果 · 会话删除不影响文件', 'Independent artifact · Preserved beyond conversations') : item.source === 'delivery' ? tr('交付快照 · 多格式成果', 'Delivered snapshot · Artifact') : tr('媒体生成结果', 'Generated media');
            this.origin.hidden = !item.origin; this.files.replaceChildren();
            this.managementMenu.open = false;
            this.managementButtons.forEach(b => {
                b.hidden = item.trashedAt ? b.dataset.action !== 'restore' && b.dataset.action !== 'location' : b.dataset.action === 'restore' || (b.dataset.action === 'save' && item.independent);
                if (b.dataset.action === 'favorite') b.textContent = item.favorite ? tr('取消收藏', 'Unfavorite') : tr('收藏并保存', 'Favorite and save');
            });
            for (const file of item.files) { const b = button(file.name, () => { void this.select(file); }); b.dataset.key = file.key; this.files.append(b); }
            if (!this.dialog.open) this.dialog.showModal();
            void this.select(item.files[0]);
        }
        async select(file) {
            this.controller?.abort(); this.controller = new AbortController(); const seq = ++this.sequence;
            this.cleanup(); this.file = file; this.data = null; this.raw = null; this.source = false;
            this.files.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.key === file.key)));
            this.download.disabled = this.toggle.disabled = true; this.origin.disabled = false;
            this.status.textContent = tr('正在验证来源并读取文件…', 'Verifying source and reading file…'); this.meta.textContent = '';
            try {
                const data = await this.api(`/api/pi/artifacts/${file.key}/preview`, { signal: this.controller.signal });
                if (seq !== this.sequence || !this.dialog.open) return;
                this.raw = bytes(data); this.data = data;
                this.meta.textContent = `${this.item.project?.name || tr('未关联项目', 'Unlinked project')} · ${file.name} · ${Math.ceil(this.raw.length / 1024).toLocaleString()} KB`;
                this.download.disabled = false; this.toggle.disabled = false;
                this.status.textContent = this.item.independent ? tr('已独立保存到成果库。删除来源会话不会删除本文件；原来源仅用于追溯。', 'Saved independently. Deleting the source conversation does not delete this file; provenance is navigation only.') : this.item.saved ? tr('已保存版本；源文件后来改变，不影响此快照。来源分支仍需有效。', 'Saved version: later source-file changes do not affect this snapshot. Its source branch must remain valid.') : tr('来自现有媒体历史；不复制文件，也不推测来源会话。', 'From existing media history. Files are not duplicated and conversation ownership is not inferred.');
                this.render();
            } catch (error) { if (seq === this.sequence && error.name !== 'AbortError') this.status.textContent = error.message; }
        }
        render() {
            this.cleanup(); const data = this.data; if (!data) return;
            const text = ['text', 'markdown', 'html', 'table', 'svg'].includes(data.kind);
            this.toggle.hidden = !text; this.toggle.textContent = this.source ? tr('查看预览', 'View preview') : tr('查看源码', 'View source');
            if (text && (this.source || data.kind === 'text')) { const pre = node('pre', data.content, 'artifacts-code'); this.body.append(pre); return; }
            if (data.kind === 'html') {
                const note = node('p', tr('安全静态预览：禁用脚本、外部资源及表单。下载后可在本地运行。', 'Safe static preview: scripts, external resources and forms are disabled. Download to run locally.'), 'artifacts-preview-note');
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
                const article = node('article', null, 'pi-markdown'); article.innerHTML = window.PiFileViewer.markdown(data.content, this.file.name, true);
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
            this.body.append(node('div', tr('此格式暂不支持预览。可下载原文件，用对应应用打开。', 'Preview is unavailable for this format. Download the original and open it in its app.'), 'artifacts-preview-empty'));
        }
        async downloadFile() {
            const seq = this.sequence, file = this.file; this.download.disabled = true;
            try {
                // Download is a new read, not a stale preview-blob link. Re-check
                // branch revocation and history deletion at the moment of use.
                const data = await this.api(`/api/pi/artifacts/${file.key}/preview`, { signal: this.controller.signal });
                if (seq !== this.sequence || !this.dialog.open) return;
                if (this.downloadUrl) { URL.revokeObjectURL(this.downloadUrl); this.urls.delete(this.downloadUrl); }
                const url = this.blob(bytes(data), 'application/octet-stream'); this.downloadUrl = url;
                const a = node('a'); a.href = url; a.download = file.name; a.hidden = true; this.dialog.append(a); a.click(); a.remove();
            } catch (error) { if (seq === this.sequence && error.name !== 'AbortError') this.status.textContent = error.message; }
            finally { if (seq === this.sequence) this.download.disabled = false; }
        }
        async openOrigin() {
            const seq = this.sequence; this.origin.disabled = true;
            try {
                const target = await this.api(`/api/pi/artifacts/${this.file.key}/origin`, { signal: this.controller.signal });
                if (seq !== this.sequence || !this.dialog.open) return;
                this.close(); await window.PiChatNavigation.openSession(target);
            } catch (error) { if (seq === this.sequence) this.status.textContent = error.message; }
            finally { if (seq === this.sequence) this.origin.disabled = false; }
        }
    }
    window.PiArtifactPreview = ArtifactPreview;
})();
