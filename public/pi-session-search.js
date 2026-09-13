(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const node = (tag, text) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; return e; };
    class PiSessionSearch {
        constructor(host) {
            this.host = host; this.epoch = 0; this.enabled = false;
            this.button = document.getElementById('pi-search-conversations');
            this.dialog = node('dialog'); this.dialog.id = 'pi-session-search-dialog'; this.dialog.className = 'pi-native-dialog'; this.dialog.setAttribute('aria-label', translateUi("跨线程搜索对话"));
            const heading = node('div'); heading.className = 'pi-native-heading'; heading.append(node('strong', translateUi("查找对话")));
            const close = node('button', translateUi("关闭")); close.type = 'button'; close.onclick = () => this.dialog.close(); heading.append(close);
            const body = node('div'); body.className = 'pi-native-body';
            this.form = node('form'); this.form.className = 'pi-session-search-form';
            this.input = node('input'); this.input.type = 'search'; this.input.placeholder = translateUi("搜索曾经讨论过的内容"); this.input.setAttribute('aria-label', translateUi("对话正文关键词")); this.input.maxLength = 200;
            this.scope = node('select'); this.scope.setAttribute('aria-label', translateUi("搜索项目范围"));
            for (const [v, label] of [['all', translateUi("所有可见项目")], ['project', translateUi("当前项目")]]) { const option = node('option', label); option.value = v; this.scope.append(option); }
            const submit = node('button', translateUi("搜索")); submit.type = 'submit'; this.form.append(this.input, this.scope, submit);
            this.status = node('p'); this.status.setAttribute('role', 'status'); this.results = node('div'); this.results.className = 'pi-session-search-results';
            const nav = node('div'); nav.className = 'pi-search-pages'; nav.hidden = true; this.nav = nav; this.prev = node('button', translateUi("上一页")); this.next = node('button', translateUi("下一页")); nav.append(this.prev, this.next);
            const help = node('p', translateUi("查找用户问题和 AI 回复，打开结果可查看完整内容。")); help.className = 'pi-search-help'; this.status.className = 'pi-search-status';
            this.archiveLabel = node('label'); this.archiveLabel.className = 'pi-archive-search'; this.archiveLabel.hidden = true;
            this.archiveInput = node('input'); this.archiveInput.type = 'checkbox';
            this.archiveLabel.append(this.archiveInput, document.createTextNode(translateUi('包含已归档')));
            body.append(this.form, this.archiveLabel, help, this.status, this.results, nav);
            this.dialog.append(heading, body); document.body.append(this.dialog);
            this.button.onclick = () => { this.returnFocus = document.activeElement; this.cwd = host.cwd(); this.input.value = document.getElementById('pi-session-search').value; this.nav.hidden = true; this.dialog.showModal(); this.input.focus(); };
            this.dialog.addEventListener('close', () => { this.epoch++; this.abort?.abort(); this.results.replaceChildren(); this.status.textContent = ''; this.returnFocus?.focus({preventScroll:true}); });
            this.form.onsubmit = e => { e.preventDefault(); void this.search(0); };
            this.input.oninput = this.scope.onchange = this.archiveInput.onchange = () => { this.epoch++; this.abort?.abort(); this.results.replaceChildren(); this.status.textContent = ''; this.nav.hidden = true; this.prev.disabled = this.next.disabled = true; };
            this.prev.onclick = () => this.search(this.offset - 20); this.next.onclick = () => this.search(this.offset + 20);
            this.prev.disabled = this.next.disabled = true;
        }
        setArchivesEnabled(value) { this.archivesEnabled = value; this.archiveLabel.hidden = !value; }
        setEnabled(value) { this.enabled = value; this.button.hidden = !value; }
        async search(offset) {
            if (!this.enabled || !this.dialog.open) return;
            const q = this.input.value.trim(); if (q.length < 2) { this.status.textContent = translateUi("请输入至少 2 个字符"); return; }
            this.abort?.abort(); this.abort = new AbortController(); const n = ++this.epoch;
            this.status.textContent = translateUi("正在搜索原生会话…"); this.prev.disabled = this.next.disabled = true;
            const query = new URLSearchParams({q, offset: String(Math.max(0, offset))});
            if (this.scope.value === 'project') query.set('cwd', this.cwd);
            if (this.archivesEnabled && this.archiveInput.checked) query.set('includeArchived', 'true');
            if (offset) query.set('searchId', this.searchId);
            try {
                const data = await this.host.api('/api/pi/sessions/search?' + query, {signal:this.abort.signal});
                if (n !== this.epoch || !this.dialog.open) return;
                this.offset = data.offset; this.searchId = data.searchId;
                this.status.textContent = `${data.total ? translateUi("找到 ") + data.total + translateUi(" 个线程") : translateUi("没有匹配的对话")}${data.partial ? translateUi(" · 部分文件变化或达到扫描限额，可缩小项目范围重试") : ''}`;
                this.results.replaceChildren();
                for (const row of data.results) {
                    const button = node('button'); button.type = 'button'; button.append(node('strong', row.name), node('small', translateUi("{0} · {1} 条匹配", row.cwd, row.matches)), node('span', row.snippet));
                    if (row.archived) button.append(node('small', translateUi('已归档')));
                    button.onclick = async () => {
                        if (n !== this.epoch || !this.dialog.open) return;
                        button.disabled = true;
                        try { this.dialog.close(); await this.host.open(row, q); }
                        catch (e) { this.host.toast(e.message, 'error'); }
                    }; this.results.append(button);
                }
                this.nav.hidden = !data.offset && !data.hasMore;
                this.prev.disabled = !data.offset; this.next.disabled = !data.hasMore;
            } catch (e) { if (n === this.epoch && this.dialog.open && e.name !== 'AbortError') this.status.textContent = e.message; }
        }
    }
    window.PiSessionSearch = PiSessionSearch;
})();
