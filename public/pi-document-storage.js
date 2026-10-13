/* Independent office attachment manager. The host supplies authenticated request
 * and current-page draft IDs; it owns the composer/settings entry point. */
(() => {
    function mount({ host = document.body, request, getContext, getDraftIds = () => [], onDeleted = () => {}, t = text => text } = {}) {
        if (typeof request !== 'function' || typeof getContext !== 'function') throw new Error('Attachment storage host callbacks required');
        const el = (tag, text) => { const node = document.createElement(tag); if (text) node.textContent = t(text); return node; };
        const dialog = el('dialog'); dialog.className = 'pi-document-storage pi-native-dialog';
        Object.assign(dialog.style, { width: 'min(720px, calc(100vw - 24px))', maxWidth: 'calc(100vw - 24px)', boxSizing: 'border-box', maxHeight: '85dvh', padding: '16px', borderRadius: '12px', overflow: 'hidden' });
        dialog.setAttribute('aria-label', t('附件管理'));
        const layout = el('div'); Object.assign(layout.style, { display: 'flex', flexDirection: 'column', gap: '12px', maxHeight: 'calc(85dvh - 40px)', minWidth: '0' });
        const header = el('div'), title = el('strong', '附件管理'), closeButton = el('button', '关闭');
        Object.assign(header.style, { display: 'flex', justifyContent: 'space-between', gap: '8px' }); header.append(title, closeButton);
        const status = el('p'); status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere';
        const description = el('p', '这里只显示当前项目的附件，容量为整个实例的用量。会话、分叉、预约、定时任务和队列中的保存引用会受到保护。清理前请退出所有已打开的运行实例。请先核对其他页面的未发送草稿，以及在其他地方保存的附件链接；需要时先备份原件。');
        const content = el('div'); content.dataset.storageContent = ''; Object.assign(content.style, { overflow: 'auto', minHeight: '0', overflowWrap: 'anywhere' });
        const refresh = el('button', '刷新用量'); layout.append(header, description, status, content, refresh); dialog.append(layout); host.append(dialog);
        for (const node of [closeButton, refresh]) node.style.fontSize = '16px';
        let generation = 0, controller, cwd, loading = false, disposed = false;
        const pending = new Map();
        const size = bytes => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
        const current = token => !disposed && dialog.open && token === generation;
        const button = (text, action) => { const node = el('button', text); node.style.fontSize = '16px'; node.addEventListener('click', action); return node; };
        const showError = error => { status.textContent = error.message || t('操作失败，请稍后再试'); };
        const drafts = () => [...getDraftIds(cwd)];
        async function read(endpoint, body, token) {
            controller?.abort(); controller = new AbortController();
            const result = await request(endpoint, { method: 'POST', body, signal: controller.signal });
            return current(token) ? result : null;
        }
        function resultNotice(token) {
            const receipt = pending.get(cwd); if (!receipt) return;
            const owner = cwd;
            status.textContent = t('清理结果尚未确认，请查询结果。不会重复提交清理。');
            const check = button('查询清理结果', async () => {
                if (loading) return; loading = true; check.disabled = true;
                try {
                    const result = await request('/uploads/storage/status?' + new URLSearchParams({ cwd: owner, requestId: receipt.requestId }), { method: 'GET' });
                    if (!current(token)) return;
                    if (result.state === 'deleted') { pending.delete(owner); onDeleted([result.id]); await load(); }
                    else status.textContent = t('清理结果仍不确定，请保留附件并联系管理员核对。');
                } catch (e) { if (current(token)) showError(e); }
                finally { loading = false; check.disabled = false; }
            }); content.append(check);
        }
        async function preview(item, node, token) {
            if (loading || pending.has(cwd)) return; loading = true; node.disabled = true;
            try {
                const result = await read('/uploads/storage/preview', { cwd, id: item.id, draftIds: drafts() }, token); if (!result) return;
                content.replaceChildren();
                const message = el('p'); message.textContent = t('将永久删除服务器原件，释放') + ' ' + size(item.size) + '。' + t('其他浏览器中尚未发送的草稿可能无法再使用此附件。');
                const name = el('strong'); name.textContent = item.name;
                const label = el('label'), confirmed = el('input'); confirmed.type = 'checkbox'; confirmed.style.fontSize = '16px';
                label.append(confirmed, document.createTextNode(t('我已核对未发送草稿及其他附件链接，停止使用同一数据的外部 Pi 进程，并确认删除原件。')));
                label.style.display = 'block';
                const confirm = button('永久删除原件', () => cleanup(result, confirm, token)); confirm.disabled = true;
                confirmed.addEventListener('change', () => { confirm.disabled = !confirmed.checked; });
                const cancel = button('取消', load); content.append(name, message, label, confirm, cancel);
                status.textContent = t('未发现已保存引用。请确认未发送草稿后再清理。');
            } catch (e) { if (current(token)) showError(e); }
            finally { loading = false; node.disabled = false; }
        }
        async function cleanup(previewResult, node, token) {
            if (loading || node.disabled || pending.has(cwd)) return;
            const owner = cwd;
            let requestId;
            try {
                // getRandomValues remains available on ordinary LAN HTTP.
                requestId = 'cleanup-' + Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
            } catch (error) { showError(error); return; }
            loading = true;
            const body = { cwd: owner, ticket: previewResult.ticket, revision: previewResult.revision, requestId, confirmed: true, externalWritersStopped: true, draftIds: drafts() };
            pending.set(owner, { requestId });
            content.querySelectorAll('button,input').forEach(n => { n.disabled = true; }); refresh.disabled = true;
            status.textContent = t('正在清理，请等待结果。');
            try {
                // A submitted deletion is never aborted or automatically retried.
                const result = await request('/uploads/storage/cleanup', { method: 'POST', body });
                if (result.state === 'deleted') { pending.delete(owner); onDeleted([result.id]); }
                if (!current(token)) return;
                if (result.state === 'deleted') await load();
                else { content.replaceChildren(); resultNotice(token); }
            } catch (e) {
                // These responses are explicit pre-deletion refusals. An I/O or
                // transport failure remains uncertain and keeps the same ID.
                const rejected = (e.status >= 400 && e.status < 500 || e.status === 503) && ['DOCUMENT_STORAGE_CHANGED', 'DOCUMENT_PROTECTED', 'DOCUMENT_INPUT',
                    'DOCUMENT_SCOPE', 'DOCUMENT_BUSY', 'DOCUMENT_SCAN_INCOMPLETE', 'DOCUMENT_STORAGE_BUSY'].includes(e.code);
                if (rejected) pending.delete(owner);
                if (!current(token)) return;
                content.replaceChildren(); showError(e); if (!rejected) resultNotice(token);
            } finally { loading = false; if (current(token)) refresh.disabled = false; }
        }
        async function load() {
            const token = ++generation; loading = true; refresh.disabled = true; content.replaceChildren(); status.textContent = t('正在读取附件用量…');
            try {
                const result = await read('/uploads/storage/usage', { cwd, draftIds: drafts() }, token); if (!result) return;
                status.textContent = t('实例用量：') + size(result.totalBytes) + ' / ' + size(result.limits.bytes) + ` · ${result.count} / ${result.limits.count}`;
                if (result.warning) content.append(el('p', result.warning));
                for (const item of result.items) {
                    const row = el('div'); row.dataset.documentId = item.id;
                    Object.assign(row.style, { padding: '12px 0', borderBottom: '1px solid #8885', minWidth: '0' });
                    const name = el('strong'); name.textContent = item.name;
                    const info = el('p'); info.textContent = size(item.size) + ' · ' + t('来源线程：') + item.sessionId;
                    const reference = el('p', item.savedReference === 'protected' ? '已有保存引用或草稿，保留原件' : item.savedReference === 'not-found' ? '未发现已保存引用' : '引用状态尚未核实');
                    const clean = button('预览清理', () => preview(item, clean, token)); clean.disabled = !result.complete || item.savedReference !== 'not-found' || pending.has(cwd);
                    row.append(name, info, reference, clean); content.append(row);
                }
                if (!result.items.length) content.append(el('p', '当前项目没有办公附件。'));
                resultNotice(token);
            } catch (e) { if (current(token) && e.name !== 'AbortError') showError(e); }
            finally { if (current(token)) { loading = false; refresh.disabled = false; } }
        }
        function close() { generation++; controller?.abort(); loading = false; if (dialog.open) dialog.close(); }
        closeButton.addEventListener('click', close); dialog.addEventListener('cancel', event => { event.preventDefault(); close(); }); refresh.addEventListener('click', () => { if (!loading) load(); });
        return {
            dialog,
            open(context = getContext()) {
                if (disposed) return;
                cwd = typeof context === 'string' ? context : context?.cwd;
                if (!cwd) throw new Error(t('请先选择项目'));
                if (!dialog.open) dialog.showModal(); load();
            }, close,
            dispose() { close(); disposed = true; dialog.remove(); }
        };
    }
    globalThis.PiDocumentStorage = { mount };
})();
