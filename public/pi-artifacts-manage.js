/* Explicit scopes, clear confirmations and durable request IDs; never replay writes.
   Undo is offered as a new, user-initiated request with fresh revisions. */
(() => {
    const ui = window.PiArtifactsUI, { tr, node, icon, button } = ui;
    // randomUUID requires a secure context; getRandomValues also works over LAN HTTP.
    function randomId() {
        if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
        const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    // Resolves { action, values } for the chosen action, or null when dismissed.
    function dialog(options) {
        const d = node('dialog', null, 'artifacts-manage-dialog' + (options.tone === 'danger' ? ' is-danger' : ''));
        const form = node('form'); form.method = 'dialog'; form.noValidate = false;
        const head = node('div', null, 'artifacts-dialog-head');
        if (options.icon) { const badge = node('span', null, 'artifacts-dialog-icon'); badge.append(icon(options.icon)); head.append(badge); }
        const heading = node('h2', options.title); heading.id = 'artifacts-dialog-title-' + Math.random().toString(36).slice(2, 8);
        d.setAttribute('aria-labelledby', heading.id); head.append(heading); form.append(head);
        if (options.description) { const p = node('p', options.description, 'artifacts-dialog-text'); p.id = heading.id + '-text'; d.setAttribute('aria-describedby', p.id); form.append(p); }
        if (options.files?.length) {
            const list = node('ul', null, 'artifacts-dialog-files');
            for (const file of options.files.slice(0, 5)) { const li = node('li'); li.append(icon(ui.kindIcon(file.kind)), node('span', file.name)); list.append(li); }
            if (options.files.length > 5) list.append(node('li', tr(`以及另外 ${options.files.length - 5} 个文件`, `and ${options.files.length - 5} more files`), 'is-more'));
            form.append(list);
        }
        if (options.details) form.append(options.details);
        for (const field of options.fields || []) {
            const label = node('label', null, 'artifacts-field'), caption = node('span', field.label), input = node(field.options ? 'select' : 'input');
            input.name = field.key;
            if (field.options) for (const o of field.options) { const option = node('option', o.name); option.value = o.value; input.append(option); }
            else { input.type = 'text'; input.maxLength = field.maxLength || 240; input.required = field.required !== false; input.autocomplete = 'off'; input.spellcheck = false; if (field.placeholder) input.placeholder = field.placeholder; }
            input.value = field.value ?? (field.options ? field.options[0]?.value || '' : '');
            label.append(caption, input);
            if (field.hint) label.append(node('small', field.hint));
            form.append(label);
        }
        if (options.note) form.append(node('p', options.note, 'artifacts-dialog-note'));
        const actions = node('div', null, 'artifacts-dialog-actions'); let chosen = null;
        if (options.cancel !== false) actions.append(button(options.cancelLabel || tr('取消', 'Cancel'), () => d.close(), 'artifacts-btn', {}));
        const submitters = [];
        for (const action of options.actions) {
            const b = button(action.label, null, 'artifacts-btn' + (action.tone ? ' is-' + action.tone : ''), { icon: action.icon });
            b.type = 'submit'; b.value = action.id; b.dataset.dialogAction = action.id; submitters.push(b); actions.append(b);
        }
        form.append(actions); d.append(form);
        const update = () => { for (const b of submitters) b.disabled = [...form.elements].some(e => e.required && !String(e.value).trim()); };
        form.addEventListener('input', update); update();
        form.addEventListener('submit', e => {
            e.preventDefault(); const submitter = e.submitter || submitters.at(-1);
            if (!submitter || submitter.disabled) return;
            chosen = { action: submitter.value, values: Object.fromEntries(new FormData(form)) }; d.close();
        });
        const focus = document.activeElement; document.body.append(d); d.showModal(); ui.layer(d);
        const first = form.querySelector('input, select');
        if (first) { first.focus(); if (first.select) first.select(); }
        else (options.tone === 'danger' ? actions.firstElementChild : submitters.at(-1))?.focus();
        return new Promise(resolve => d.addEventListener('close', () => { d.remove(); if (focus?.isConnected) focus.focus({ preventScroll: true }); resolve(chosen); }, { once: true }));
    }
    const count = (n, zh, en) => tr(zh.replace('{n}', n), en.replace('{n}', n).replace(/\b1 files\b/, '1 file'));
    class ArtifactManager {
        // hooks: changed(result, context), busy(keys|null), navigate(view), refresh()
        constructor(api, state, hooks) { Object.assign(this, { api, state, hooks }); this.busy = false; this.dialogBusy = false; }
        collectionName(id) { return this.state.collections.find(c => c.id === id)?.name || tr('合集', 'collection'); }
        async run(action, files = [], extra = {}) {
            if (this.busy || this.dialogBusy) return null;
            this.dialogBusy = true;
            try { return await this.perform(action, files, extra); }
            catch (error) { ui.toast({ tone: 'error', message: error.message }); return null; }
            finally { this.dialogBusy = false; }
        }
        async perform(action, files, extra) {
            const epoch = this.state.epoch, alive = () => epoch === this.state.epoch && this.state.active;
            if (files.length > 50) { ui.toast({ tone: 'error', message: tr('一次最多处理 50 个文件，请分批选择。', 'Select at most 50 files per operation.') }); return null; }
            const unsaved = files.some(f => !f.revision);
            const saveNote = unsaved ? tr('尚未保存的文件会先保存到成果库。', 'Unsaved files are saved to the library first.') : '';
            // Permanent deletion always passes through the explicit confirmation.
            if (action === 'purge' && extra.confirmed !== true) action = 'delete';
            if (action === 'delete') {
                const trashed = files.length > 0 && files.every(f => f.trashed), pending = files.some(f => f.deletionPending);
                const answer = await dialog({
                    tone: 'danger', icon: 'fa-trash-can', files,
                    title: files.length === 1 ? tr(`删除「${files[0].name}」？`, `Delete “${files[0].name}”?`) : count(files.length, '删除 {n} 个文件？', 'Delete {n} files?'),
                    description: pending ? tr('上次删除没有完成。确认后会重新核对并删除成果库副本，无法恢复。', 'A previous deletion did not finish. Confirming re-checks and deletes the library copy. This cannot be undone.')
                        : trashed ? tr('将从成果库中永久删除，无法恢复。', 'These files will be permanently deleted from the library. This cannot be undone.')
                            : tr('永久删除后无法恢复。如果以后可能还需要，可以先移到回收站。', 'Permanent deletion cannot be undone. Move to trash instead if you might need them later.'),
                    note: tr('只删除成果库中的副本；来源聊天、原文件和已导出的副本不受影响。', 'Only library copies are removed. Source conversations, original files and exported copies are untouched.'),
                    actions: [...(trashed || pending ? [] : [{ id: 'trash', label: tr('移到回收站', 'Move to trash') }]), { id: 'purge', label: tr('永久删除', 'Delete permanently'), tone: 'danger' }]
                });
                if (!answer || !alive()) return null;
                action = answer.action; extra = { ...extra, confirmed: true };
            }
            if (['rename', 'collection-create', 'collection-rename'].includes(action)) {
                const rename = action === 'rename';
                const answer = await dialog({
                    title: rename ? tr('重命名', 'Rename') : action === 'collection-create' ? tr('新建合集', 'New collection') : tr('重命名合集', 'Rename collection'),
                    fields: [{ key: 'name', label: rename ? tr('文件名称', 'File name') : tr('合集名称', 'Collection name'), value: extra.name ?? (rename ? files[0]?.name : ''), maxLength: rename ? 240 : 160,
                        placeholder: rename ? '' : tr('例如：周报、灵感素材', 'e.g. Weekly reports, Inspiration') }],
                    note: rename ? tr('只修改成果库中的名称，原文件不变。', 'Only the library name changes; the original file stays the same.') : tr('合集按主题分组，不是磁盘文件夹；同一成果可以放进多个合集。', 'Collections group work by topic, not by disk folder. One artifact can be in several collections.'),
                    actions: [{ id: 'ok', label: action === 'collection-create' ? tr('创建', 'Create') : tr('保存', 'Save'), tone: 'primary' }]
                });
                if (!answer || !alive()) return null; extra = { ...extra, name: answer.values.name.trim() };
            }
            if (action === 'collection-add' && !extra.collectionId) {
                let collectionId = '__new__';
                if (this.state.collections.length) {
                    const answer = await dialog({
                        title: files.length === 1 ? tr('加入合集', 'Add to collection') : count(files.length, '将 {n} 个文件加入合集', 'Add {n} files to a collection'),
                        fields: [{ key: 'collectionId', label: tr('合集', 'Collection'), options: [...this.state.collections.map(c => ({ value: c.id, name: c.name })), { value: '__new__', name: tr('＋ 新建合集…', '+ New collection…') }] }],
                        note: [tr('文件不会被移动，星标也不受影响。', 'Files are not moved and stars are unchanged.'), saveNote].filter(Boolean).join(' '),
                        actions: [{ id: 'ok', label: tr('加入', 'Add'), tone: 'primary' }]
                    });
                    if (!answer || !alive()) return null; collectionId = answer.values.collectionId;
                }
                if (collectionId === '__new__') {
                    const answer = await dialog({ title: tr('新建合集并加入', 'Create collection and add'), fields: [{ key: 'name', label: tr('合集名称', 'Collection name'), maxLength: 160, placeholder: tr('例如：周报、灵感素材', 'e.g. Weekly reports, Inspiration') }],
                        note: saveNote, actions: [{ id: 'ok', label: tr('创建并加入', 'Create and add'), tone: 'primary' }] });
                    if (!answer || !alive()) return null;
                    const created = await this.submit('collection-create', [], { name: answer.values.name.trim() }, epoch);
                    const collection = created?.collections?.find(c => !this.state.collections.some(old => old.id === c.id));
                    if (!collection) { this.report('collection-create', [], { name: answer.values.name }, created); return null; }
                    this.state.collections = created.collections; collectionId = collection.id;
                }
                extra = { ...extra, collectionId };
            }
            if (action === 'project') {
                const projects = [...new Map([...this.state.projects, ...this.state.availableProjects].filter(p => p.cwd).map(p => [p.cwd, p])).values()];
                const answer = await dialog({
                    title: tr('设置项目标签', 'Set project label'),
                    fields: [{ key: 'cwd', label: tr('项目', 'Project'), options: [{ value: '', name: tr('无项目标签', 'No project label') }, ...projects.map(p => ({ value: p.cwd, name: `${p.name} · ${p.cwd}` }))] }],
                    note: tr('只用于在成果中心筛选，不会把文件放进项目目录，也不改变来源聊天。', 'Only used for filtering here. Files are not placed in the project folder and the source conversation is unchanged.'),
                    actions: [{ id: 'ok', label: tr('应用', 'Apply'), tone: 'primary' }]
                });
                if (!answer || !alive()) return null; extra = { ...extra, cwd: answer.values.cwd || null };
            }
            if (action === 'export') {
                const answer = await dialog({
                    title: tr('导出到服务器文件夹', 'Export to server folder'),
                    description: tr('复制到运行 Pivane 的服务器上，不是当前手机或电脑。要保存到本机，请在预览中选择「下载到设备」。', 'Copies to the server running Pivane, not the device you are browsing on. To save to this device, use “Download to device” in the preview.'),
                    fields: [
                        { key: 'cwd', label: tr('项目路径', 'Project path'), value: this.state.projects[0]?.cwd || this.state.availableProjects[0]?.cwd || '', maxLength: 4096 },
                        { key: 'directory', label: tr('项目内的现有目录', 'Existing folder in the project'), value: '.', maxLength: 4096, hint: tr('不会覆盖同名文件，也不会创建新目录。', 'Existing files are never overwritten and no folders are created.') }
                    ],
                    note: saveNote, actions: [{ id: 'ok', label: tr('导出副本', 'Export copies'), tone: 'primary' }]
                });
                if (!answer || !alive()) return null; extra = { ...extra, ...answer.values, confirmed: true };
            }
            if (action === 'collection-delete') {
                const answer = await dialog({ tone: 'danger', icon: 'fa-folder-minus', title: tr(`删除合集「${this.collectionName(extra.collectionId)}」？`, `Delete “${this.collectionName(extra.collectionId)}”?`),
                    description: tr('只删除这个分组，里面的文件和星标都会保留。', 'Only the group is removed. Its files and stars are kept.'), actions: [{ id: 'ok', label: tr('删除合集', 'Delete collection'), tone: 'danger' }] });
                if (!answer || !alive()) return null; extra = { ...extra, confirmed: true };
            }
            if (action === 'trash') extra = { ...extra, confirmed: true };
            if (!alive()) return null;
            const list = files.map(file => ({ key: file.key, ...(file.revision ? { revision: file.revision } : {}) }));
            // Remember each library file's state so Undo only reverses what this request changed.
            const before = new Map(files.map(f => [f.key, this.state.savedItems.get(f.key)]).filter(([, item]) => item));
            const result = await this.submit(action, list, extra, epoch, files);
            // Report after the page reflects the change, so an immediate Undo is never rejected as busy.
            if (result && !result.pending && alive()) { await this.hooks.changed(result, { action, files, extra }); if (alive()) this.report(action, files, extra, result, before); }
            return result;
        }
        report(action, files, extra, result, before = new Map()) {
            if (!result || result.pending) return;
            const results = result.results || [], ok = results.filter(r => r.ok), failed = results.filter(r => !r.ok);
            if (result.error) { ui.toast({ tone: 'error', message: result.error }); return; }
            if (failed.length) {
                const name = key => files.find(f => f.key === key)?.name || key.slice(0, 8);
                ui.toast({ tone: 'error', message: ok.length ? tr(`${ok.length} 个成功，${failed.length} 个未完成`, `${ok.length} done, ${failed.length} not completed`) : tr('操作未完成', 'The operation did not complete'),
                    details: failed.map(r => `${name(r.key)}：${r.error || r.code}`) });
                return;
            }
            const unsaved = files.some(f => !f.revision), n = ok.length;
            const changedByThis = r => {
                const prior = before.get(r.key); if (!prior) return false;
                if (action === 'favorite') return Boolean(prior.favorite) !== extra.favorite;
                if (action === 'collection-add') return !prior.collections?.includes(extra.collectionId);
                if (action === 'collection-remove') return Boolean(prior.collections?.includes(extra.collectionId));
                if (action === 'hide') return !prior.hiddenAt;
                if (action === 'trash') return !prior.trashedAt;
                return false;
            };
            const items = ok.filter(r => r.item && changedByThis(r)).map(r => ({ key: r.item.key, revision: r.item.revision, name: r.item.title, kind: r.item.types?.[0] }));
            // Restore also clears hiddenAt, so it cannot faithfully undo trashing a hidden file.
            const exact = action !== 'trash' || ok.every(r => !before.get(r.key)?.hiddenAt);
            // Undo is a new user-initiated request with the fresh revisions returned above.
            const undo = (label, next, nextExtra) => (unsaved || !exact || !items.length) ? null : { label: label || tr('撤销', 'Undo'), run: () => { void this.run(next, items, nextExtra); } };
            const view = target => ({ label: tr('查看', 'View'), run: () => this.hooks.navigate(target) });
            const messages = {
                save: [count(n, '已保存 {n} 个文件到成果库', 'Saved {n} files to the library'), view('saved')],
                favorite: extra.favorite
                    ? [unsaved ? count(n, '已保存并加星标（{n} 个）', 'Saved and starred {n} files') : n === 1 ? tr('已加星标', 'Starred') : count(n, '已为 {n} 个文件加星标', 'Starred {n} files'), unsaved ? view('favorite') : undo(null, 'favorite', { favorite: false })]
                    : [n === 1 ? tr('已取消星标', 'Star removed') : count(n, '已取消 {n} 个星标', 'Removed {n} stars'), undo(null, 'favorite', { favorite: true })],
                'collection-add': [tr(`已加入「${this.collectionName(extra.collectionId)}」`, `Added to “${this.collectionName(extra.collectionId)}”`), undo(null, 'collection-remove', { collectionId: extra.collectionId })],
                'collection-remove': [tr(`已移出「${this.collectionName(extra.collectionId)}」`, `Removed from “${this.collectionName(extra.collectionId)}”`), undo(null, 'collection-add', { collectionId: extra.collectionId })],
                project: [tr('项目标签已更新', 'Project label updated')],
                rename: [tr('已重命名', 'Renamed')],
                hide: [count(n, '已隐藏 {n} 个文件', 'Hid {n} files'), undo(null, 'unhide')],
                unhide: [count(n, '已取消隐藏 {n} 个文件', 'Unhid {n} files'), view('saved')],
                trash: [count(n, '已将 {n} 个文件移到回收站', 'Moved {n} files to trash'), undo(null, 'restore')],
                restore: [count(n, '已恢复 {n} 个文件', 'Restored {n} files'), view('saved')],
                purge: [count(n, '已永久删除 {n} 个文件', 'Permanently deleted {n} files')],
                export: [count(n, '已导出 {n} 个副本到服务器', 'Exported {n} copies to the server')],
                'collection-create': [tr(`已创建合集「${extra.name}」`, `Created “${extra.name}”`)],
                'collection-rename': [tr('合集已重命名', 'Collection renamed')],
                'collection-delete': [tr('合集已删除，文件仍然保留', 'Collection deleted; files are kept')]
            };
            const [message, action2] = messages[action] || [tr('已更新', 'Updated')];
            ui.toast({ tone: 'success', message, action: action2 || undefined, details: action === 'export' ? ok.map(r => r.exported?.path).filter(Boolean) : undefined });
        }
        async submit(action, list, extra, epoch, files = []) {
            const requestId = randomId(); this.busy = true; this.state.mutating = true;
            this.hooks.busy?.(list.map(f => f.key), action);
            const progress = ['save', 'export', 'purge'].includes(action) && list.length > 1 ? ui.toast({ tone: 'pending', message: action === 'save' ? count(list.length, '正在保存 {n} 个文件…', 'Saving {n} files…') : action === 'export' ? count(list.length, '正在导出 {n} 个文件…', 'Exporting {n} files…') : count(list.length, '正在删除 {n} 个文件…', 'Deleting {n} files…') }) : null;
            document.dispatchEvent(new CustomEvent('artifacts:mutation-state'));
            let result;
            try { result = await this.api('/api/pi/artifacts/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, action, ...(list.length ? { files: list } : {}), ...extra }) }); }
            catch {
                // The write may have happened. Ask for its recorded outcome once; never resend it.
                try { result = await this.api('/api/pi/artifacts/operations/' + requestId); }
                catch { ui.toast({ tone: 'error', message: tr('无法确认操作结果，没有自动重试。请刷新后核对。', 'The outcome could not be confirmed and was not retried. Refresh to check.'), details: [requestId], action: { label: tr('刷新', 'Refresh'), run: () => this.hooks.refresh() } }); }
                if (result?.pending) ui.toast({ tone: 'error', message: tr('操作仍在核对中，没有重放。请稍后刷新。', 'The operation is still being reconciled and was not replayed. Refresh later.'), details: [requestId], action: { label: tr('刷新', 'Refresh'), run: () => this.hooks.refresh() } });
            } finally {
                progress?.close(); this.busy = false; this.state.mutating = false; this.hooks.busy?.(null);
                document.dispatchEvent(new CustomEvent('artifacts:mutation-state', { detail: { stale: epoch !== this.state.epoch } }));
            }
            void files; return result;
        }
        async location(file) {
            try {
                const epoch = this.state.epoch, result = await this.api('/api/pi/artifacts/' + file.key + '/location');
                if (epoch !== this.state.epoch || !this.state.active) return;
                const list = node('dl', null, 'artifacts-info-list');
                const row = (label, value, copy) => {
                    if (!value) return;
                    const dd = node('dd'), text = node('span', value); dd.append(text);
                    if (copy && navigator.clipboard?.writeText) {
                        const b = button(tr('复制', 'Copy'), async () => { try { await navigator.clipboard.writeText(value); ui.relabel(b, tr('已复制', 'Copied'), 'fa-check'); } catch { /* clipboard is optional */ } }, 'artifacts-copy', { icon: 'fa-copy', iconStyle: 'fa-regular', iconOnly: true });
                        dd.append(b);
                    }
                    list.append(node('dt', label), dd);
                };
                row(tr('状态', 'Status'), result.independent ? tr('已保存到成果库，删除聊天不影响它', 'Saved in the library; deleting the conversation does not affect it') : tr('尚未保存，删除来源后将无法找回', 'Not saved; it will be lost if the source is deleted'));
                row(tr('成果库副本（服务器）', 'Library copy (server)'), result.storagePath, true);
                row(tr('原文件名', 'Original name'), result.originalName);
                row(tr('原文件位置（历史记录）', 'Original location (historical)'), result.sourcePath, true);
                row(tr('来源会话', 'Source conversation'), result.origin?.sessionId, true);
                row(tr('保存时间', 'Saved'), ui.stamp(result.savedAt));
                await dialog({ icon: 'fa-circle-info', title: tr('文件信息', 'File information'), details: list, cancel: false, actions: [{ id: 'ok', label: tr('完成', 'Done'), tone: 'primary' }] });
            } catch (error) { ui.toast({ tone: 'error', message: error.message }); }
        }
    }
    window.PiArtifactManager = ArtifactManager;
    window.PiArtifactDialog = dialog;
})();
