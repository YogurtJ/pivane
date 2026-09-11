(() => {
    const $ = id => document.getElementById(id);
    const el = (tag, text) => { const n = document.createElement(tag); if (text != null) n.textContent = text; return n; };
    const icon = name => { const n = el('i'); n.className = `fa-solid fa-${name}`; n.setAttribute('aria-hidden', 'true'); return n; };
    const stages = { progress: '过程回复', final: '最终回复', pending: '回复中', stopped: '已停止', error: '回复失败' };
    function timestamp(value) {
        if (value === null || value === undefined || value === '') return null;
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) return null;
        const pad = n => String(n).padStart(2, '0');
        const year = date.getFullYear() === new Date().getFullYear() ? '' : `${date.getFullYear()}-`;
        const time = el('time', `${year}${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`);
        time.dateTime = date.toISOString(); time.title = date.toLocaleString(); time.setAttribute('aria-label', time.title);
        time.className = 'pi-tree-time'; return time;
    }
    // Shared by tree cards, search results and the selected-record heading.
    function fillHeading(heading, row) {
        heading.replaceChildren(); heading.classList.add('pi-tree-heading');
        heading.dataset.replyStage = row.kind === 'assistant' && stages[row.replyStage] ? row.replyStage : 'unknown';
        heading.style.setProperty('--tree-accent', row.kind === 'user' ? 'var(--blue)' : row.kind === 'assistant' ? 'var(--green)' : 'var(--text-muted)');
        const role = el('span'); role.className = 'pi-tree-role';
        const label = row.kind === 'user' ? '用户问题' : row.kind === 'tool' ? '工具记录'
            : row.kind === 'summary' ? row.summaryType === 'compaction' ? '上下文压缩' : row.summaryType === 'branch_summary' ? '分支摘要' : '摘要' : 'AI';
        role.append(icon(row.kind === 'user' ? 'user' : row.kind === 'tool' ? 'wrench' : row.kind === 'summary' ? 'file-lines' : 'robot'), document.createTextNode(label));
        heading.append(role);
        if (row.kind === 'assistant') { const badge = el('span', stages[row.replyStage] || '回复'); badge.className = 'pi-tree-stage'; heading.append(badge); }
        const time = timestamp(row.timestamp); if (time) heading.append(time);
        return heading;
    }
    function decorateCard(button, row) {
        button.dataset.kind = row.kind;
        button.dataset.replyStage = row.kind === 'assistant' && stages[row.replyStage] ? row.replyStage : 'unknown';
        button.append(fillHeading(el('div'), row));
    }
    window.PiHistoryPresentation = { fillHeading, decorateCard };
    class PiSessionTreeView {
        constructor(history, host) {
            this.history = history; this.host = host; this.enabled = false; this.mode = 'search'; this.sequence = 0; this.collapsed = []; this.value = null;
            $('pi-history-search-mode').onclick = () => this.open('search');
            $('pi-history-tree-mode').onclick = () => this.open('tree');
            $('pi-tree-current').onclick = () => this.load('current');
            $('pi-tree-refresh').onclick = () => this.load('current');
            $('pi-tree-prev').onclick = () => this.load(null, Math.max(0, this.data.offset - this.data.pageSize));
            $('pi-tree-next').onclick = () => this.load(null, this.data.offset + this.data.pageSize);
            $('pi-tree-summarize').onchange = () => { $('pi-tree-focus-label').hidden = !$('pi-tree-summarize').checked; };
            $('pi-tree-continue').onclick = () => this.navigate();
            $('pi-tree-cancel').onclick = () => this.cancel();
            $('pi-tree-use-draft').onclick = () => {
                try { if (this.draft && host.useDraft(this.draft, false)) { this.draft = null; this.sync(); } } catch (e) { host.toast(e.message, 'error'); }
            };
            $('pi-tree-rows').addEventListener('keydown', e => {
                if (e.isComposing || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
                const buttons = [...$('pi-tree-rows').querySelectorAll('[data-tree-entry]')], index = buttons.indexOf(document.activeElement);
                if (index < 0) return;
                e.preventDefault(); buttons[e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)))].focus();
            });
        }
        reset() {
            this.sequence++; this.data = null; this.loading = false; this.pending = false; this.value = null; this.draft = null; this.collapsed = []; this.loaded = false;
            $('pi-tree-rows').replaceChildren(); $('pi-tree-progress-text').textContent = '';
            $('pi-tree-summarize').checked = false; $('pi-tree-focus').value = ''; $('pi-tree-focus-label').hidden = true;
        }
        available() { return this.enabled && this.history.available(); }
        sync() {
            $('pi-history-modes').hidden = !this.enabled;
            if (!this.enabled) this.mode = 'search';
            this.history.status.hidden = this.mode === 'tree' && !this.history.selected;
            $('pi-history-search-pane').hidden = this.mode !== 'search'; $('pi-history-tree-pane').hidden = this.mode !== 'tree';
            $('pi-history-search-mode').setAttribute('aria-pressed', String(this.mode === 'search')); $('pi-history-tree-mode').setAttribute('aria-pressed', String(this.mode === 'tree'));
            const ready = this.available(), busy = this.value?.busy || this.pending, c = this.host.context(), selected = this.history.selected;
            for (const id of ['pi-tree-current', 'pi-tree-refresh']) $(id).disabled = !ready || this.loading || busy;
            $('pi-tree-prev').disabled = !ready || this.loading || busy || !this.data?.offset;
            $('pi-tree-next').disabled = !ready || this.loading || busy || !this.data?.hasMore;
            $('pi-tree-navigation').hidden = !this.enabled || !selected?.navigation;
            const atCurrent = selected?.atCurrentPosition && selected.navigation === 'after' && !selected.stale;
            $('pi-tree-continue').textContent = selected?.stale ? '重新核对继续位置' : atCurrent ? '当前已在这里继续' : selected?.navigation === 'before' ? '回到此问题前，修改后继续' : '从这里继续';
            $('pi-tree-continue').disabled = !ready || c.busy || busy || !selected?.revision || atCurrent;
            $('pi-tree-continue').title = c.busy || busy ? '等待当前任务结束后可继续' : '切换对话位置，不自动发送消息';
            for (const id of ['pi-tree-summarize', 'pi-tree-focus']) $(id).disabled = busy;
            $('pi-tree-progress').hidden = !this.enabled || (!this.value?.job && !this.pending && !this.draft);
            $('pi-tree-cancel').hidden = !this.value?.busy;
            $('pi-tree-cancel').disabled = !ready || this.value?.job?.status === 'stopping';
            $('pi-tree-use-draft').hidden = !this.draft; $('pi-tree-use-draft').disabled = !ready || c.busy || busy;
        }
        open(mode = 'tree') {
            if (mode === 'tree' && !this.available()) { this.host.toast('当前实例尚未启用会话树，请连接持久线程', 'info'); return false; }
            if (!this.history.leavePreview()) return false;
            this.history.closePreview(); this.mode = mode; this.sync();
            if (mode === 'tree') { if (!this.loaded) this.load('current'); else $('pi-tree-current').focus(); }
            else { this.history.search(); this.history.query.focus(); }
            return true;
        }
        async load(focus, offset = 0) {
            if (!this.available() || this.value?.busy) return;
            const { key, generation } = this.host.context(), seq = ++this.sequence;
            this.loading = true; this.sync(); $('pi-tree-status').textContent = '正在读取会话树…';
            try {
                const data = await this.host.request('get_session_tree', { collapsed: this.collapsed, offset, ...(focus ? { focus } : {}), ...(offset ? { revision: this.data?.revision } : {}) });
                if (!this.history.current(key, generation) || seq !== this.sequence) return;
                this.data = data; this.loaded = true; this.collapsed = data.collapsed; this.render();
                $('pi-tree-status').textContent = data.total ? `${data.currentId ? '' : '当前在第一条问题之前 · '}${data.offset + 1}–${data.offset + data.rows.length} / ${data.total} 个对话节点` : '还没有可查看的对话记录';
                if (focus) requestAnimationFrame(() => { if (seq === this.sequence && this.history.current(key, generation)) $('pi-tree-rows').querySelector('[data-current="true"]')?.scrollIntoView({ block: 'nearest' }); });
            } catch (e) { if (seq === this.sequence && this.history.current(key, generation)) $('pi-tree-status').textContent = e.message; }
            finally { if (seq === this.sequence && this.history.current(key, generation)) { this.loading = false; this.sync(); } }
        }
        render() {
            $('pi-tree-rows').replaceChildren();
            for (const row of this.data.rows) {
                const line = el('div'); line.className = 'pi-tree-row'; line.style.setProperty('--tree-depth', Math.min(row.depth, 6));
                const toggle = el('button', row.collapsed ? '▸' : '▾'); toggle.type = 'button'; toggle.className = 'pi-tree-fold'; toggle.disabled = !row.childCount;
                toggle.setAttribute('aria-label', row.collapsed ? '展开后续对话' : '收起后续对话'); toggle.setAttribute('aria-expanded', String(!row.collapsed));
                toggle.onclick = async () => {
                    this.collapsed = row.collapsed ? this.collapsed.filter(id => id !== row.entryId) : [...this.collapsed, row.entryId].slice(-256);
                    await this.load(null, this.data.offset);
                    $('pi-tree-rows').querySelector(`[data-tree-entry="${CSS.escape(row.entryId)}"]`)?.focus();
                };
                const button = el('button'); button.type = 'button'; button.className = 'pi-history-result'; button.dataset.treeEntry = row.entryId; button.dataset.current = String(row.current);
                decorateCard(button, row);
                button.setAttribute('aria-current', row.current ? 'location' : 'false');
                if (row.label) button.append(el('strong', `★ ${row.label}`));
                const snippet = el('span', row.snippet); snippet.className = 'pi-tree-snippet'; button.append(snippet);
                const context = el('div'); context.className = 'pi-tree-context';
                if (row.current) { const badge = el('span', '当前位置'); badge.className = 'pi-tree-current-badge'; context.append(badge); }
                if (!row.inCurrentBranch) context.append(el('span', '其他分支'));
                if (row.childCount > 1) context.append(el('span', `${row.childCount} 条后续路线`));
                if (row.collapsed) context.append(el('span', '后续已收起'));
                if (context.childNodes.length) button.append(context);
                button.title = row.parentPreview ? `接在：${row.parentPreview}` : '对话起点';
                button.onclick = () => this.history.openEntry(row.entryId, 0, 'body');
                line.append(toggle, button); $('pi-tree-rows').append(line);
            }
        }
        apply(value) {
            if (!value || this.value?.runtimeId === value.runtimeId && this.value.revision > value.revision) return;
            this.value = value;
            const names = { preparing: '正在核对导航位置…', navigating: '正在切换对话位置…', summarizing: '正在生成离开分支的摘要…', retrying: '摘要服务正在重试…', stopping: '正在取消，请等待结果…', done: '已切换对话位置，可在主输入框继续。', cancelled: '导航已取消。', error: '导航未完成，请重新预览目标并核对当前位置。', uncertain: '导航结果不确定，请重新连接并核对当前位置；未自动重试。' };
            $('pi-tree-progress-text').textContent = names[value.job?.status] || '';
            this.host.navigationBusy(Boolean(value.busy)); this.sync();
        }
        changed() {
            this.loaded = false; this.sequence++; this.loading = false;
            if (this.history.selected) this.history.selected.stale = true;
            this.sync();
        }
        async navigate() {
            const selected = this.history.selected;
            if (!this.available() || this.pending || this.value?.busy || this.host.context().busy || !selected?.navigation) return;
            if (selected.stale) return this.history.openEntry(selected.entryId, selected.offset, selected.view);
            if (!window.confirm(`${selected.navigation === 'before' ? '回到这个问题之前，准备修改后继续？' : '从这条记录之后继续对话？'}\n原分支会保留，项目文件保持当前版本。${$('pi-tree-summarize').checked ? '\n将调用模型生成离开分支的摘要。' : ''}`)) return;
            const { key, generation } = this.host.context(); this.pending = true; this.host.navigationBusy(true); this.sync();
            try {
                const data = await this.host.request('navigate_history', { entryId: selected.entryId, expectedLeafId: selected.leafId, revision: selected.revision,
                    summarize: $('pi-tree-summarize').checked, ...($('pi-tree-summarize').checked ? { customInstructions: $('pi-tree-focus').value } : {}) }, 660000);
                if (!this.history.current(key, generation)) return;
                if (!data.cancelled && data.draft) {
                    this.draft = data.draft;
                    if (this.host.useDraft(this.draft, true)) this.draft = null;
                }
                selected.stale = true;
                this.host.toast(data.cancelled ? '导航已取消' : this.draft ? '已切换；原草稿保留，可按需追加原问题' : '已切换，请核对后继续', 'info');
            } catch (e) { if (this.history.current(key, generation)) this.host.toast(`${e.message}；请核对当前位置，未自动重试`, 'error'); }
            finally { if (this.history.current(key, generation)) { this.pending = false; this.host.navigationBusy(Boolean(this.value?.busy)); this.sync(); } }
        }
        async cancel() {
            if (!this.available() || !this.value?.busy) return;
            const { key, generation } = this.host.context();
            try { const data = await this.host.request('cancel_history_navigation', { navigationId: this.value.job.id }, 150000); if (this.history.current(key, generation)) this.apply(data); }
            catch (e) { if (this.history.current(key, generation)) this.host.toast(`${e.message}；请等待导航最终状态`, 'error'); }
        }
    }
    window.PiSessionTreeView = PiSessionTreeView;
})();
