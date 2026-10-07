/* Dialogs use explicit scopes and fresh mutation ids; never replay lost writes. */
(() => {
    const tr = (zh, en) => window.PiI18n?.locale?.startsWith('en') ? en : zh;
    const node = (tag, text) => { const n = document.createElement(tag); if (text != null) n.textContent = text; return n; };
    async function form(title, fields, note = '') {
        const dialog = node('dialog'); dialog.className = 'artifacts-manage-dialog';
        const heading = node('h2', title), description = node('p', note), body = node('form'); body.method = 'dialog';
        dialog.append(heading, description, body);
        for (const field of fields) {
            const label = node('label', field.label), input = node(field.options ? 'select' : 'input'); input.name = field.key;
            if (field.options) for (const o of field.options) { const option = node('option', o.name); option.value = o.value; input.append(option); }
            else { input.type = 'text'; input.maxLength = field.maxLength || 240; input.required = field.required !== false; }
            input.value = field.value ?? (field.options ? field.options[0]?.value || '' : ''); label.append(input); body.append(label);
        }
        const actions = node('div'); actions.className = 'artifacts-dialog-actions';
        const cancel = node('button', tr('取消', 'Cancel')); cancel.type = 'button'; cancel.addEventListener('click', () => dialog.close());
        const submit = node('button', tr('确认', 'Confirm')); submit.type = 'submit'; actions.append(cancel, submit); body.append(actions);
        document.body.append(dialog); dialog.showModal();
        return new Promise(resolve => {
            let result = null;
            body.addEventListener('submit', e => { e.preventDefault(); result = Object.fromEntries(new FormData(body)); dialog.close(); });
            dialog.addEventListener('close', () => { dialog.remove(); resolve(result); }, { once: true });
        });
    }
    class ArtifactManager {
        constructor(api, state, changed, message) { Object.assign(this, { api, state, changed, message }); this.busy = false; }
        async run(action, files = [], extra = {}) {
            if (this.busy) return null;
            const list = files.map(file => ({ key: file.key, ...(file.revision ? { revision: file.revision } : {}) }));
            if (list.length > 50) { this.message(tr('一次最多操作 50 个文件，请分批选择。', 'Select at most 50 files per operation.')); return null; }
            if (['rename', 'collection-create', 'collection-rename'].includes(action)) {
                const result = await form(tr(action === 'rename' ? '重命名成果' : '收藏夹名称', action === 'rename' ? 'Rename artifact' : 'Collection name'), [{ key: 'name', label: tr('名称', 'Name'), value: extra.name || files[0]?.name || '', maxLength: action === 'rename' ? 240 : 160 }],
                    tr('只修改成果库显示和导出名称，不改原文件或旧交付链接。', 'Changes the library and export name, not originals or existing delivery links.'));
                if (!result) return null; extra = { ...extra, ...result };
            }
            if (action === 'collection-add' || action === 'collection-remove') {
                if (!this.state.collections.length) { this.message(tr('请先创建一个收藏夹。', 'Create a collection first.')); return null; }
                const result = await form(tr('选择收藏夹', 'Choose collection'), [{ key: 'collectionId', label: tr('收藏夹', 'Collection'), options: this.state.collections.map(c => ({ value: c.id, name: c.name })) }]);
                if (!result) return null; extra = { ...extra, ...result };
            }
            if (action === 'project') {
                const result = await form(tr('关联到项目', 'Link to project'), [{ key: 'cwd', label: tr('项目', 'Project'), options: [{ value: '', name: tr('未关联项目', 'Unlinked') }, ...[...new Map([...this.state.projects, ...this.state.availableProjects].map(p => [p.cwd, p])).values()].map(p => ({ value: p.cwd, name: `${p.name} · ${p.cwd}` }))] }],
                    tr('只修改整理分类，不改变原来源、会话工作目录或磁盘位置。', 'Changes organization only—not provenance, conversation cwd or disk location.'));
                if (!result) return null; extra.cwd = result.cwd || null;
            }
            if (action === 'export') {
                const result = await form(tr('保存副本到文件夹', 'Save copies to folder'), [
                    { key: 'cwd', label: tr('允许访问的项目绝对路径', 'Allowed project absolute path'), value: this.state.projects[0]?.cwd || '', maxLength: 4096 },
                    { key: 'directory', label: tr('现有目标目录（绝对或项目内相对路径）', 'Existing target folder (absolute or project-relative)'), value: '.', maxLength: 4096 }
                ], tr('在服务器上保存原字节副本，不移动原件、不覆盖同名文件。成果库仍保留独立版本。', 'Saves original-byte copies on the server. Originals stay put; existing names are never overwritten. The library keeps its independent version.'));
                if (!result) return null; extra = { ...extra, ...result, confirmed: true };
            }
            if (action === 'trash' || action === 'collection-delete') {
                const result = await form(tr(action === 'trash' ? '移入成果回收站' : '删除收藏夹', action === 'trash' ? 'Move to artifact trash' : 'Delete collection'), [],
                    action === 'trash' ? tr(`将 ${list.length} 个文件移入成果回收站，可恢复。不删除来源会话、原文件或媒体历史。尚未入库的结果会先保存副本。`, `Move ${list.length} files to recoverable artifact trash. Conversations, originals and media history are untouched. Unsaved results are copied first.`) : tr('只移除收藏夹分类，里面的文件仍保留。', 'Removes the collection only; its files remain.'));
                if (!result) return null; extra.confirmed = true;
            }
            const requestId = crypto.randomUUID(), epoch = this.state.epoch;
            if (this.busy) return null;
            this.busy = true; this.state.mutating = true; document.dispatchEvent(new CustomEvent('artifacts:mutation-state'));
            let result;
            try {
                result = await this.api('/api/pi/artifacts/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, action, ...(list.length ? { files: list } : {}), ...extra }) });
            } catch (error) {
                // A lost response is not permission to resubmit the POST.
                try { result = await this.api('/api/pi/artifacts/operations/' + requestId); }
                catch { this.message(tr(`操作结果未确认（${requestId}），请刷新核对。没有自动重试。`, `Outcome unconfirmed (${requestId}). Refresh to reconcile. No automatic retry.`)); }
                if (result?.pending) this.message(tr(`操作仍需核对（${requestId}），没有重放。`, `Operation needs reconciliation (${requestId}); not replayed.`));
            } finally { this.busy = false; this.state.mutating = false; document.dispatchEvent(new CustomEvent('artifacts:mutation-state', { detail: { stale: epoch !== this.state.epoch } })); }
            if (result && !result.pending && epoch === this.state.epoch && this.state.active) {
                const succeeded = (result.results || []).filter(r => r.ok).length, failed = (result.results || []).filter(r => !r.ok);
                this.message(result.error || (failed.length ? `${succeeded} ${tr('成功', 'succeeded')} · ${failed.length} ${tr('失败', 'failed')}\n` + failed.map(r => r.error).join('\n') : tr('整理完成，原文件和会话未改变。', 'Done. Originals and conversations are unchanged.')));
                await this.changed(result);
            }
            return result;
        }
        async location(file) {
            try {
                const epoch = this.state.epoch, result = await this.api('/api/pi/artifacts/' + file.key + '/location');
                if (epoch !== this.state.epoch || !this.state.active) return;
                const note = [result.independent ? tr('已独立保存，删除会话不影响成果。', 'Independently saved; deleting the conversation does not delete this artifact.') : tr('尚未入库，请先保存或收藏再清理来源。', 'Not yet in the library. Save or favorite before cleaning up the source.'),
                    result.storagePath ? `${tr('成果库位置', 'Library path')}: ${result.storagePath}` : '', result.sourcePath ? `${tr('原文件位置（历史记录）', 'Original path (historical)')}: ${result.sourcePath}` : '',
                    result.origin?.sessionId ? `${tr('来源会话', 'Source conversation')}: ${result.origin.sessionId}` : ''].filter(Boolean).join('\n');
                await form(tr('位置与来源', 'Location and origin'), [], note);
            } catch (error) { this.message(error.message); }
        }
    }
    window.PiArtifactManager = ArtifactManager;
})();
