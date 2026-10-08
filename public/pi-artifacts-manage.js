/* Explicit scopes, named confirmations and durable request IDs; never replay writes. */
(() => {
    const tr = (zh, en) => window.PiI18n?.locale?.startsWith('en') ? en : zh;
    const node = (tag, text) => { const n = document.createElement(tag); if (text != null) n.textContent = text; return n; };
    async function form(title, fields, note = '', options = {}) {
        const dialog = node('dialog'); dialog.className = 'artifacts-manage-dialog';
        const heading = node('h2', title), description = node('p', note), body = node('form'); body.method = 'dialog';
        heading.id = 'artifacts-form-title'; dialog.setAttribute('aria-labelledby', heading.id); dialog.append(heading, description, body);
        for (const field of fields) {
            const label = node('label', field.label), input = node(field.options ? 'select' : 'input'); input.name = field.key;
            if (field.options) for (const o of field.options) { const option = node('option', o.name); option.value = o.value; input.append(option); }
            else { input.type = 'text'; input.maxLength = field.maxLength || 240; input.required = field.required !== false; }
            input.value = field.value ?? (field.options ? field.options[0]?.value || '' : ''); label.append(input); body.append(label);
        }
        const actions = node('div'); actions.className = 'artifacts-dialog-actions';
        const cancel = node('button', tr('取消', 'Cancel')); cancel.type = 'button'; cancel.addEventListener('click', () => dialog.close());
        const submit = node('button', options.submit || tr('确认', 'Confirm')); submit.type = 'submit'; if (options.danger) submit.className = 'artifacts-danger';
        actions.append(cancel, submit); body.append(actions);
        const update = () => { submit.disabled = Boolean(options.match && body.elements.confirmation.value !== options.match); }; body.addEventListener('input', update); update();
        const focus = document.activeElement; document.body.append(dialog); dialog.showModal();
        if (options.danger) cancel.focus();
        return new Promise(resolve => {
            let result = null;
            body.addEventListener('submit', e => { e.preventDefault(); if (submit.disabled) return; result = Object.fromEntries(new FormData(body)); dialog.close(); });
            dialog.addEventListener('close', () => { dialog.remove(); if (focus?.isConnected) focus.focus(); resolve(result); }, { once: true });
        });
    }
    class ArtifactManager {
        constructor(api, state, changed, message) { Object.assign(this, { api, state, changed, message }); this.busy = false; this.dialogBusy = false; }
        async run(action, files = [], extra = {}) {
            if (this.busy || this.dialogBusy) return null;
            this.dialogBusy = true;
            try { return await this.perform(action, files, extra); } catch (error) { this.message(error.message); return null; }
            finally { this.dialogBusy = false; }
        }
        async perform(action, files, extra) {
            const epoch = this.state.epoch;
            const list = files.map(file => ({ key: file.key, ...(file.revision ? { revision: file.revision } : {}) }));
            if (list.length > 50) { this.message(tr('一次最多操作 50 个文件，请分批选择。', 'Select at most 50 files per operation.')); return null; }
            const names = files.slice(0, 5).map(f => '• ' + f.name).join('\n') + (files.length > 5 ? tr(`\n…另 ${files.length - 5} 个文件`, `\n…and ${files.length - 5} more files`) : '');
            const unsaved = files.some(f => !f.revision);
            const saveNote = unsaved ? tr('待保存文件会先保留独立副本，删除聊天后仍可使用。', 'Unsaved files will first be saved independently, so they survive conversation deletion.') : '';
            if (['rename', 'collection-create', 'collection-rename'].includes(action)) {
                const result = await form(tr(action === 'rename' ? '重命名' : '合集名称', action === 'rename' ? 'Rename' : 'Collection name'), [{ key: 'name', label: tr('名称', 'Name'), value: extra.name || files[0]?.name || '', maxLength: action === 'rename' ? 240 : 160 }],
                    action === 'rename' ? tr('只修改成果库中的名称，不改原文件。', 'Changes the library name, not the original file.') : tr('合集是成果分组，不是磁盘文件夹。同一成果可以放进多个合集。', 'A collection groups artifacts; it is not a disk folder. An artifact can belong to several collections.'), { submit: action === 'collection-create' ? tr('创建合集', 'Create collection') : tr('保存名称', 'Save name') });
                if (!result) return null; extra = { ...extra, ...result };
            }
            if (action === 'collection-add' || action === 'collection-remove') {
                if (action === 'collection-remove' && extra.collectionId) { /* current collection, no ambiguous second picker */ }
                else {
                    const options = this.state.collections.map(c => ({ value: c.id, name: c.name }));
                    if (action === 'collection-add') options.push({ value: '__new__', name: tr('＋ 新建合集…', '+ New collection…') });
                    if (!options.length) return null;
                    const result = await form(tr('选择合集', 'Choose collection'), [{ key: 'collectionId', label: tr('合集', 'Collection'), options }], tr('按用途分组，不移动文件，也不改变星标。', 'Group by purpose without moving files or changing stars.') + '\n' + saveNote, { submit: tr('继续', 'Continue') });
                    if (!result) return null; extra = { ...extra, ...result };
                    if (extra.collectionId === '__new__') {
                        const name = await form(tr('新建合集并加入', 'Create collection and add'), [{ key: 'name', label: tr('合集名称', 'Collection name'), maxLength: 160 }], saveNote, { submit: tr('创建并加入', 'Create and add') });
                        if (!name || epoch !== this.state.epoch || !this.state.active) return null;
                        const created = await this.submit('collection-create', [], name, epoch);
                        const collection = created?.collections?.find(c => !this.state.collections.some(old => old.id === c.id));
                        if (!collection) return null; extra.collectionId = collection.id;
                    }
                }
            }
            if (action === 'project') {
                const result = await form(tr('设置项目标签', 'Set project label'), [{ key: 'cwd', label: tr('用于成果筛选的项目', 'Project used to filter artifacts'), options: [{ value: '', name: tr('无项目标签', 'No project label') }, ...[...new Map([...this.state.projects, ...this.state.availableProjects].map(p => [p.cwd, p])).values()].map(p => ({ value: p.cwd, name: `${p.name} · ${p.cwd}` }))] }],
                    tr('仅修改成果库里的项目标签。不会把文件保存进项目目录，也不改变来源聊天。', 'Only changes the library project label. It does not save files into the project directory or change the source conversation.'), { submit: tr('应用标签', 'Apply label') });
                if (!result) return null; extra.cwd = result.cwd || null;
            }
            if (action === 'export') {
                const result = await form(tr('导出到服务器文件夹', 'Export to server folder'), [
                    { key: 'cwd', label: tr('有权访问的项目路径', 'Allowed project path'), value: this.state.projects[0]?.cwd || this.state.availableProjects[0]?.cwd || '', maxLength: 4096 },
                    { key: 'directory', label: tr('服务器上的现有目录', 'Existing directory on the server'), value: '.', maxLength: 4096 }
                ], tr('这是运行 Pivane 的服务器，不是当前手机或电脑。复制文件，不移动原件、不覆盖同名文件。要保存到当前设备，请在预览中选择「下载到设备」。', 'This is the server running Pivane, not the device you are browsing on. Copies files without moving originals or overwriting names. For this device, choose “Download to device” in the preview.') + '\n' + saveNote, { submit: tr('导出副本', 'Export copies') });
                if (!result) return null; extra = { ...extra, ...result, confirmed: true };
            }
            if (['trash', 'purge', 'collection-delete'].includes(action)) {
                const purge = action === 'purge', match = tr('删除', 'DELETE');
                const title = purge ? tr(`永久删除 ${list.length} 个文件？`, `Permanently delete ${list.length} files?`) : action === 'trash' ? tr(`将 ${list.length} 个文件移入回收站？`, `Move ${list.length} files to trash?`) : tr('删除合集？', 'Delete collection?');
                const note = purge ? tr('将删除成果库中的文件副本并释放空间，无法恢复。来源聊天、交付原件、媒体历史及已导出的副本不会删除；已有备份也不会被清除。\n\n', 'Deletes the library copies and frees space. This cannot be undone. Source conversations, original deliveries, media history, exported copies and existing backups are not deleted.\n\n') + names
                    : action === 'trash' ? tr('可从回收站恢复；不会删除聊天或原文件。\n\n', 'You can restore these from trash. Conversations and original files stay intact.\n\n') + names
                        : tr('仅删除这个分组，里面的成果和星标都会保留。', 'Only removes this group. Artifacts and stars remain.');
                const result = await form(title, purge ? [{ key: 'confirmation', label: tr('输入「删除」确认', 'Type DELETE to confirm') }] : [], note,
                    { submit: purge ? tr('永久删除', 'Delete permanently') : action === 'trash' ? tr('移入回收站', 'Move to trash') : tr('删除合集', 'Delete collection'), danger: true, ...(purge ? { match } : {}) });
                if (!result) return null; extra.confirmed = true;
            }
            if (epoch !== this.state.epoch || !this.state.active) return null;
            const result = await this.submit(action, list, extra, epoch);
            if (result && !result.pending && epoch === this.state.epoch && this.state.active) {
                const succeeded = (result.results || []).filter(r => r.ok).length, failed = (result.results || []).filter(r => !r.ok);
                const successes = { save: tr('已保存，删除聊天不会丢失。', 'Saved independently of the conversation.'), favorite: extra.favorite ? tr('已加星标，可在「星标」中快速找到。', 'Starred. Find it in Starred.') : tr('已取消星标，文件仍保留。', 'Star removed. Files are kept.'), 'collection-add': tr('已加入合集，文件位置不变。', 'Added to collection. Files stay in place.'), 'collection-remove': tr('已移出合集，文件仍保留。', 'Removed from collection. Files are kept.'), trash: tr('已移入回收站，可恢复或永久删除。', 'Moved to trash. Restore or delete permanently there.'), purge: tr('已永久删除所选成果库副本。', 'Selected library copies permanently deleted.'), restore: tr('已恢复到已保存成果。', 'Restored to Saved.'), export: tr('副本已导出到服务器目录。', 'Copies exported to the server folder.') };
                this.message(result.error || (failed.length ? `${succeeded} ${tr('成功', 'succeeded')} · ${failed.length} ${tr('失败', 'failed')}\n` + failed.map(r => `${files.find(f => f.key === r.key)?.name || ''}：${r.error}`).join('\n') : successes[action] || tr('已更新。', 'Updated.')));
                await this.changed(result);
            }
            return result;
        }
        async submit(action, list, extra, epoch) {
            const requestId = crypto.randomUUID(); this.busy = true; this.state.mutating = true; document.dispatchEvent(new CustomEvent('artifacts:mutation-state'));
            let result;
            try { result = await this.api('/api/pi/artifacts/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, action, ...(list.length ? { files: list } : {}), ...extra }) }); }
            catch {
                try { result = await this.api('/api/pi/artifacts/operations/' + requestId); }
                catch { this.message(tr(`操作结果未确认（${requestId}），请刷新核对。没有自动重试。`, `Outcome unconfirmed (${requestId}). Refresh to reconcile. No automatic retry.`)); }
                if (result?.pending) this.message(tr(`操作仍需核对（${requestId}），没有重放。`, `Operation needs reconciliation (${requestId}); not replayed.`));
            } finally { this.busy = false; this.state.mutating = false; document.dispatchEvent(new CustomEvent('artifacts:mutation-state', { detail: { stale: epoch !== this.state.epoch } })); }
            return result;
        }
        async location(file) {
            try {
                const epoch = this.state.epoch, result = await this.api('/api/pi/artifacts/' + file.key + '/location');
                if (epoch !== this.state.epoch || !this.state.active) return;
                const note = [result.independent ? tr('已独立保存，删除聊天不影响成果。', 'Saved independently of the conversation.') : tr('尚未保存，请先保存后再清理来源聊天。', 'Not saved. Save before deleting the source conversation.'),
                    result.storagePath ? `${tr('服务器上的成果库副本', 'Library copy on server')}: ${result.storagePath}` : '', result.sourcePath ? `${tr('原文件位置（历史记录）', 'Original path (historical)')}: ${result.sourcePath}` : '',
                    result.origin?.sessionId ? `${tr('来源会话', 'Source conversation')}: ${result.origin.sessionId}` : ''].filter(Boolean).join('\n');
                await form(tr('文件信息', 'File information'), [], note, { submit: tr('知道了', 'Close') });
            } catch (error) { this.message(error.message); }
        }
    }
    window.PiArtifactManager = ArtifactManager;
})();
