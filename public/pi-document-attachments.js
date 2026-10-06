(() => {
    const t = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, i) => values[i] ?? `{${i}}`));
    const refs = globalThis.PiDocumentReferences;
    class PiDocumentAttachments {
        constructor({ context, api, fetchBytes, toast }) { Object.assign(this, { context, api, fetchBytes, toast }); this.enabled = false; }
        key(context = this.context()) { return JSON.stringify([context.cwd, context.session?.id, context.generation]); }
        target() {
            const context = this.context();
            if (!this.enabled || !context.connected || !context.session || context.session.ephemeral) throw new Error(t('当前入口尚未启用文档上传，请使用支持此功能的持久线程'));
            return { context, key: this.key(context) };
        }
        async upload(file) {
            const target = this.target(), bytes = crypto.getRandomValues(new Uint8Array(16));
            const requestId = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
            const query = new URLSearchParams({ cwd: target.context.cwd, sessionId: target.context.session.id, name: file.name, requestId });
            // One raw upload, no base64 in chat state or automatic retries. The
            // stable requestId is retained for a status check if delivery is lost.
            try {
                const result = await this.api(`/api/pi/uploads?${query}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
                if (target.key !== this.key()) throw Object.assign(new Error(t('会话已切换，上传结果未加入当前草稿')), { status: 409 });
                return result;
            } catch (error) {
                if (!error.status && target.key === this.key()) {
                    // Read-only reconciliation of the same request, never re-upload.
                    try {
                        const statusQuery = new URLSearchParams({ cwd: target.context.cwd, sessionId: target.context.session.id, requestId });
                        const saved = await this.api(`/api/pi/uploads/status?${statusQuery}`);
                        if (target.key === this.key() && refs.valid(saved?.reference)) return saved;
                    } catch {}
                }
                if (!error.status) error.message = t('上传结果未确认，未自动重试（标识 {0}）', requestId) + '：' + error.message;
                throw error;
            }
        }
        async download(reference) {
            const target = this.target(), query = new URLSearchParams({ cwd: target.context.cwd, sessionId: target.context.session.id, id: reference.id });
            const response = await this.fetchBytes(`/api/pi/uploads?${query}`);
            if (!response.ok) {
                let message; try { message = (await response.json()).error; } catch {}
                throw new Error(t(message || `HTTP ${response.status}`));
            }
            const blob = await response.blob();
            if (target.key !== this.key()) return;
            const url = URL.createObjectURL(blob), link = document.createElement('a');
            link.href = url; link.download = reference.name; link.hidden = true; document.body.append(link); link.click(); link.remove();
            // Allow the browser to acquire the object before releasing it.
            setTimeout(() => URL.revokeObjectURL(url), 10000);
        }
        card(reference) {
            const card = document.createElement('div'); card.className = 'pi-document-card';
            const icon = document.createElement('i'); icon.className = 'fa-solid fa-file-lines'; icon.setAttribute('aria-hidden', 'true');
            const caption = document.createElement('span'), name = document.createElement('strong'), info = document.createElement('small');
            name.textContent = reference.name; name.title = reference.name;
            info.textContent = `${reference.format.toUpperCase()} · ${Math.ceil(reference.size / 1024)} KiB`;
            caption.append(name, info);
            const download = document.createElement('button'); download.type = 'button'; download.className = 'icon-btn subtle';
            download.title = t('下载原件'); download.setAttribute('aria-label', t('下载 {0}', reference.name));
            download.innerHTML = '<i class="fa-solid fa-download" aria-hidden="true"></i>';
            download.addEventListener('click', async () => {
                const finish = globalThis.PiActionFeedback?.begin(download, t('正在下载…'), { iconOnly: true }); download.disabled = true;
                try { await this.download(reference); } catch (error) { this.toast(error.message, 'error'); }
                finally { finish?.(); download.disabled = false; }
            });
            card.append(icon, caption, download); return card;
        }
        render(container, text) {
            const parts = refs.split(text || '');
            if (!parts.some(part => part.reference)) { globalThis.PiQuotes.renderUser(container, text); return; }
            for (const part of parts) {
                if (part.reference) container.append(this.card(part.reference));
                else if (part.text.trim()) { const node = document.createElement('div'); globalThis.PiQuotes.renderUser(node, part.text); container.append(node); }
            }
        }
    }
    globalThis.PiDocumentAttachments = PiDocumentAttachments;
})();
