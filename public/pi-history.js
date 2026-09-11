(() => {
    const $ = id => document.getElementById(id);
    const node = (tag, text, className) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (className) n.className = className; return n; };
    function highlight(parent, text, query) {
        if (!query) { parent.textContent = text; return; }
        const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
        let from = 0, count = 0;
        for (const match of text.matchAll(pattern)) {
            if (++count > 200) break;
            parent.append(document.createTextNode(text.slice(from, match.index)), node('mark', match[0])); from = match.index + match[0].length;
        }
        parent.append(document.createTextNode(text.slice(from)));
    }
    class PiHistoryView {
        constructor(host) {
            this.host = host; this.enabled = false; this.key = ''; this.generation = -1; this.sequence = 0; this.detailSequence = 0;
            this.panel = $('pi-history'); this.query = $('pi-history-query'); this.scope = $('pi-history-scope'); this.filter = $('pi-history-filter'); this.onlyBookmarks = $('pi-history-bookmarks');
            this.results = $('pi-history-results'); this.status = $('pi-history-status'); this.preview = $('pi-history-preview'); this.label = $('pi-history-label');
            this.rows = []; this.offset = 0; this.pageSize = 30; this.selected = null;
            this.bodyEnabled = false;
            this.tree = new window.PiSessionTreeView(this, host);
            $('pi-history-tab').addEventListener('click', () => this.open(this.tree.mode));
            this.query.addEventListener('input', () => this.queueSearch());
            for (const input of [this.scope, this.filter, this.onlyBookmarks]) input.addEventListener('change', () => this.queueSearch(0));
            this.query.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); this.queueSearch(0); } });
            $('pi-history-refresh').addEventListener('click', () => this.queueSearch(0));
            $('pi-history-prev').addEventListener('click', () => this.search(Math.max(0, this.offset - this.pageSize)));
            $('pi-history-next').addEventListener('click', () => this.search(this.offset + this.pageSize));
            this.results.addEventListener('click', e => { const b = e.target.closest('[data-history-id]'); if (b) this.openEntry(b.dataset.historyId); });
            $('pi-history-preview-close').addEventListener('click', () => { if (this.leavePreview()) this.closePreview(); });
            $('pi-history-preview-reload').addEventListener('click', () => { if (this.selected) this.openEntry(this.selected.entryId, this.selected.offset); });
            $('pi-history-text-prev').addEventListener('click', () => this.openEntry(this.selected.entryId, this.selected.previousOffset));
            $('pi-history-text-next').addEventListener('click', () => this.openEntry(this.selected.entryId, this.selected.nextOffset));
            $('pi-history-bookmark-form').addEventListener('submit', e => { e.preventDefault(); this.saveBookmark(false); });
            $('pi-history-bookmark-remove').addEventListener('click', () => this.saveBookmark(true));
            $('pi-history-record-toggle').addEventListener('click', () => this.openEntry(this.selected.entryId, 0, this.selected.view === 'record' ? 'body' : 'record'));
            $('pi-history-copy').addEventListener('click', async () => {
                try { if (this.selected?.text) { await host.copy(this.selected.text); host.toast('已复制当前预览正文', 'success'); } } catch (e) { host.toast(e.message, 'error'); }
            });
        }
        context() { return this.host.context(); }
        available() { const c = this.context(); return this.enabled && c.connected && c.session && !c.session.ephemeral; }
        current(key, generation) { const c = this.context(); return c.key === key && c.generation === generation; }
        setEnabled(enabled) { this.enabled = enabled; this.sync(); }
        setCapabilities(status) {
            this.bodyEnabled = status.historyBody === true; this.tree.enabled = status.sessionTree === true;
            this.filter.querySelector('[value="conversation"]').hidden = !this.bodyEnabled;
            this.filter.value = this.bodyEnabled ? 'conversation' : 'all'; this.sync();
        }
        closePreview() {
            this.detailSequence++; this.selected = null; this.preview.hidden = true; $('pi-history-browse').hidden = false;
            this.renderResults(); this.tree.sync();
            (this.tree.mode === 'tree' ? $('pi-tree-current') : this.query).focus({ preventScroll: true });
            if (this.tree.mode === 'tree' && !this.tree.loaded) this.tree.load('current');
        }
        sync() {
            const c = this.context();
            if (this.key !== c.key) {
                this.query.value = ''; this.scope.value = 'branch'; this.filter.value = this.bodyEnabled ? 'conversation' : 'all'; this.onlyBookmarks.checked = false;
                this.rows = []; this.results.replaceChildren(); this.selected = null; this.preview.hidden = true; this.offset = 0; this.revision = null;
                this.key = c.key; this.loadedGeneration = null;
                $('pi-history-browse').hidden = false; this.tree.reset();
            }
            if (this.generation !== c.generation) {
                this.generation = c.generation; this.sequence++; this.detailSequence++; clearTimeout(this.timer);
                this.searching = false; this.saving = false; this.searchAgain = false; this.loadedGeneration = null;
                this.tree.reset();
                this.selected = null; this.preview.hidden = true; $('pi-history-browse').hidden = false;
            }
            $('pi-history-tab').hidden = !this.enabled;
            $('pi-history-tab').disabled = !this.available();
            this.controls();
            if (!this.available()) this.status.textContent = c.session?.ephemeral ? '临时会话不提供持久历史和书签' : '连接当前线程后可查看历史';
            else if (!this.panel.hidden && !this.selected && this.tree.mode === 'search' && $('pi-inspector').classList.contains('open') && this.loadedGeneration !== c.generation && !this.searching) this.search();
        }
        controls() {
            const ready = this.available();
            for (const n of [this.query, this.scope, this.filter, this.onlyBookmarks, $('pi-history-refresh')]) n.disabled = !ready;
            $('pi-history-prev').disabled = !ready || this.searching || !this.offset;
            $('pi-history-next').disabled = !ready || this.searching || !this.hasMore;
            for (const id of ['pi-history-label', 'pi-history-bookmark-save', 'pi-history-bookmark-remove']) $(id).disabled = !ready || !this.selected?.canBookmark || this.saving;
            $('pi-history-bookmark-remove').hidden = !this.selected?.label;
            this.tree.sync();
        }
        open(mode = 'search') {
            if (!this.available()) return this.host.toast('请先连接持久线程再查看历史', 'info');
            this.host.showPane('history'); this.sync(); return this.tree.open(mode);
        }
        queueSearch(delay = 180) {
            clearTimeout(this.timer); this.sequence++;
            this.timer = setTimeout(() => this.search(), delay);
        }
        async search(offset = 0) {
            clearTimeout(this.timer); if (!this.available()) return;
            if (this.searching) { this.searchAgain = true; return; }
            const { key, generation } = this.context(), sequence = ++this.sequence;
            this.searching = true; this.loadedGeneration = generation; this.status.textContent = '正在检索原生历史…'; this.controls();
            try {
                const data = await this.host.request('search_history', { q: this.query.value, scope: this.scope.value, filter: this.filter.value,
                    bookmarked: this.onlyBookmarks.checked, offset, ...(offset ? { revision: this.revision } : {}) });
                if (!this.current(key, generation) || sequence !== this.sequence) return;
                this.rows = data.results; this.offset = data.offset; this.pageSize = data.pageSize; this.revision = data.revision; this.hasMore = data.hasMore;
                this.renderResults();
                if (!this.selected) this.status.textContent = data.total ? `找到 ${data.total} 条 · 显示 ${data.offset + 1}–${data.offset + data.results.length}` : '没有匹配的记录';
                $('pi-history-changed').hidden = true;
            } catch (e) {
                if (this.current(key, generation) && sequence === this.sequence) this.status.textContent = e.message;
            } finally {
                if (this.current(key, generation)) {
                    this.searching = false; this.controls();
                    if (this.searchAgain || sequence !== this.sequence) { this.searchAgain = false; this.search(); }
                }
            }
        }
        renderResults() {
            this.results.replaceChildren();
            for (const row of this.rows) {
                const button = node('button', null, 'pi-history-result'); button.type = 'button'; button.dataset.historyId = row.entryId;
                window.PiHistoryPresentation.decorateCard(button, row);
                const context = [];
                if (row.hasTools && row.kind !== 'tool' && row.view === 'record') context.push('含工具调用');
                if (!row.inCurrentBranch) context.push('其他分支');
                if (context.length) button.append(node('small', context.join(' · ')));
                if (row.label) button.append(node('strong', `★ ${row.label}`));
                const snippet = node('span'); highlight(snippet, row.snippet || (row.images ? `图片附件 ${row.images} 张` : '无可搜索正文'), this.query.value.trim()); button.append(snippet);
                button.setAttribute('aria-current', String(row.entryId === this.selected?.entryId)); this.results.append(button);
            }
        }
        leavePreview() {
            if (!this.selected || this.saving || this.label.value === (this.selected.labelTruncated ? '' : this.selected.label)) return true;
            return window.confirm('放弃尚未保存的书签名称修改？');
        }
        async openEntry(entryId, offset, view) {
            if (!this.available() || !this.leavePreview()) return;
            const { key, generation } = this.context(), sequence = ++this.detailSequence;
            const row = this.rows.find(r => r.entryId === entryId);
            if (offset === undefined) offset = Math.max(0, (row?.matchOffset || 0) - 1000);
            if (!view) view = this.selected?.entryId === entryId ? this.selected.view : row?.view || 'body';
            this.status.textContent = '正在读取历史正文…';
            try {
                const data = await this.host.request('get_history_entry', { entryId, offset, ...(this.bodyEnabled ? { view } : {}) });
                if (!this.current(key, generation) || sequence !== this.detailSequence) return;
                this.selected = data; this.preview.hidden = false; $('pi-history-browse').hidden = true; this.label.value = data.labelTruncated ? '' : data.label;
                window.PiHistoryPresentation.fillHeading($('pi-history-preview-title'), data);
                if (!data.inCurrentBranch) $('pi-history-preview-title').append(node('small', '其他分支'));
                const text = $('pi-history-text'); text.replaceChildren();
                text.classList.toggle('pi-markdown', data.view === 'body' && data.kind !== 'tool');
                if (this.bodyEnabled && data.text && data.view === 'body' && data.kind !== 'tool' && this.host.renderMarkdown) {
                    text.innerHTML = this.host.renderMarkdown(data.text);
                    const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT), nodes = [];
                    while (walker.nextNode()) nodes.push(walker.currentNode);
                    if (this.query.value.trim()) for (const n of nodes) { const fragment = document.createDocumentFragment(); highlight(fragment, n.textContent, this.query.value.trim()); n.replaceWith(fragment); }
                } else highlight(text, data.text || (data.images ? `本条含 ${data.images} 张图片，历史预览仅显示文字。` : '无文字正文'), this.query.value.trim());
                $('pi-history-record-toggle').hidden = !this.bodyEnabled || !data.hasTools || data.kind === 'tool';
                $('pi-history-record-toggle').textContent = data.view === 'record' ? '只看回复正文' : '查看工具参数';
                const paged = Boolean(data.offset || data.hasMore);
                $('pi-history-text-page').textContent = paged ? `${data.offset + (data.totalCharacters ? 1 : 0)}–${data.nextOffset} / ${data.totalCharacters} 字符${data.images ? ` · 图片 ${data.images} 张` : ''}` : data.images ? `含 ${data.images} 张图片` : '';
                $('pi-history-text-prev').hidden = !paged; $('pi-history-text-next').hidden = !paged;
                $('pi-history-text-prev').disabled = !data.offset; $('pi-history-text-next').disabled = !data.hasMore;
                $('pi-history-copy').textContent = data.offset || data.hasMore ? '复制本页' : '复制正文';
                $('pi-history-bookmark-state').textContent = !data.canBookmark ? '首条回复保存后可添加书签' : data.labelTruncated ? '已有标签较长；如需修改，请输入新的书签名' : '书签保存在 Pi 原生会话中';
                this.status.textContent = '';
                this.renderResults(); this.controls(); text.focus({ preventScroll: true }); this.panel.scrollTop = 0;
            } catch (e) { if (this.current(key, generation) && sequence === this.detailSequence) this.status.textContent = e.message; }
        }
        async saveBookmark(remove) {
            if (!this.available() || !this.selected?.canBookmark || this.saving) return;
            const selected = this.selected, label = remove ? '' : this.label.value.trim();
            if (!remove && !label) return this.host.toast('请输入书签名称；清除请使用“移除书签”', 'info');
            if ([...label].length > 80) return this.host.toast('书签名称最多 80 字', 'info');
            const { key, generation } = this.context(); this.saving = true; this.controls();
            $('pi-history-bookmark-state').textContent = '正在保存书签…';
            try {
                const data = await this.host.request('set_history_bookmark', { entryId: selected.entryId, label, expectedBookmarkRevision: selected.bookmarkRevision });
                if (!this.current(key, generation) || this.selected?.entryId !== selected.entryId) return;
                Object.assign(this.selected, data, { labelTruncated: false, stale: true }); this.label.value = data.label;
                $('pi-history-bookmark-state').textContent = remove ? '书签已移除，原记录保留' : '书签已保存'; this.search();
            } catch (e) {
                if (this.current(key, generation) && this.selected?.entryId === selected.entryId) $('pi-history-bookmark-state').textContent = `${e.message}。未自动重试；可重新读取记录核对。`;
            } finally { if (this.current(key, generation)) { this.saving = false; this.controls(); } }
        }
        changed(entryId) {
            this.tree.changed();
            $('pi-history-changed').textContent = '对话或书签有更新，可刷新列表查看。';
            $('pi-history-changed').hidden = false;
            if (this.selected?.entryId === entryId && !this.saving) $('pi-history-bookmark-state').textContent = '其他操作更新了此书签，请重新读取后再修改；当前编辑已保留';
        }
    }
    window.PiHistoryView = PiHistoryView;
})();
