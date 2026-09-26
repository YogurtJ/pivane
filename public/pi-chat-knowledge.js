/* Chat correction is an explicit user write. Native provenance is only displayed from server receipts. */
(() => {
    'use strict';
    const t = (value, ...args) => globalThis.PiI18n?.t(value, ...args) || value;
    const el = (tag, text, className) => {
        const item = document.createElement(tag);
        if (text !== undefined) item.textContent = text;
        if (className) item.className = className;
        return item;
    };
    const button = (text, fn) => { const item = el('button', text, 'settings-secondary-button'); item.type = 'button'; item.onclick = fn; return item; };
    const id = () => globalThis.crypto?.randomUUID?.() || `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const rejected = error => [400, 403, 404, 413, 422, 429].includes(error?.status);
    const statusLabel = { ready: '就绪', pending: '待同步', missing: '缺失', disabled: '未启用', unsupported: '不支持', error: '错误', saved: '已保存' };
    const categoryLabel = { fact: '事实', preference: '偏好', correction: '纠错', failure: '失败经验', procedure: '流程' };
    const healthLabel = { ok: '学习正常', off: '学习已关闭', 'needs-model': '缺少学习模型配置', 'quota-exhausted': '今日学习额度已用完', failing: '最近学习连续失败', unavailable: '学习当前不可用' };
    const healthTone = { ok: 'ok', off: 'off', 'needs-model': 'warn', 'quota-exhausted': 'warn', failing: 'bad', unavailable: 'bad' };
    function create({ root, fetch, scope, transcript, anchors }) {
        let key = '', identity = '', epoch = 0, busy = false, snapshot = null, draft = '', uncertain = null, notice = '', hintNotice = '', latest = null, conflict = false;
        // Background learning saves after the turn settles; follow queued/running jobs for a bounded time.
        let learning = false, polls = 0, timer = null;
        // Contract fields (origin/preview/health) arrive later; absent fields keep the old card display.
        let learningSnapshot = null, anchorKeys = null, memoryFull = false;
        const draftsByThread = new Map();
        const keep = () => { if (identity) draftsByThread.set(identity, { draft, uncertain, latest, notice, conflict, memoryFull, hintNotice }); };
        const scopeKey = value => value ? JSON.stringify([value.cwd, value.sessionId, value.profileId, value.generation]) : '';
        const current = () => scopeKey(scope()) === key && Boolean(key);
        const base = value => `/api/pi/profiles/${encodeURIComponent(value.profileId)}/knowledge`;
        const writable = (operation, kind = 'memory') => snapshot?.status === 'ready' && snapshot.capabilities?.[kind] === true
            && (!Array.isArray(snapshot.capabilities.operations) || snapshot.capabilities.operations.includes(operation))
            && /^[a-f0-9]{64}$/.test(snapshot.revision || '');
        const sessionReceipts = () => (snapshot?.receipts || []).filter(r => r.source?.sessionId === scope()?.sessionId);
        // Only server-verified learning/agent receipts with a native source entry become "remembered" hints.
        const hintReceipts = () => sessionReceipts().filter(r => r.status === 'saved' && !r.superseded && ['learning', 'agent'].includes(r.origin) && r.source?.entryId);
        const hintPreview = receipt => receipt.preview || receipt.summary || '';
        const hintText = receipt => receipt.kind === 'skill' ? t('已学习技能：{0}', hintPreview(receipt))
            : receipt.origin === 'agent' ? t('Agent 记下：{0}', hintPreview(receipt)) : t('已记住：{0}', hintPreview(receipt));
        const transcriptHost = () => (typeof transcript === 'function' ? transcript() : transcript) || document.getElementById('pi-transcript-content');
        function hintBlock(receipt, fallback) {
            const box = el('div', undefined, fallback ? 'pi-memory-hint pi-memory-hint-fallback' : 'pi-memory-hint');
            box.setAttribute('role', 'note');
            if (receipt.kind === 'memory' && receipt.category) box.append(el('span', t(categoryLabel[receipt.category] || receipt.category), 'pi-memory-hint-tag'));
            box.append(el('span', hintText(receipt), 'pi-memory-hint-text'));
            if (receipt.kind === 'skill') box.append(el('small', t('需重载会话后生效')));
            if (receipt.scope === 'project' || receipt.undoable === false) return box;
            const actions = el('div', undefined, 'pi-memory-hint-actions');
            if (writable('undo', receipt.kind)) actions.append(button(t('撤销'), () => void submit('undo', receipt)));
            if (receipt.kind === 'memory') {
                if (receipt.afterRevision && writable('delete', 'memory')) actions.append(button(t('不对'), () => {
                    if (confirm(t('这条记忆不对吗？删除后学习不会再记回来。'))) void submit('delete', receipt);
                }));
            } else if (writable('undo', receipt.kind)) actions.append(button(t('不对'), () => void submit('undo', receipt)));
            actions.append(button(t('编辑'), () => reveal(receipt)));
            box.append(actions);
            return box;
        }
        function reveal(receipt) {
            const profileId = scope()?.profileId;
            if (!profileId || !receipt.itemId) return;
            globalThis.PiAgentProfilesUI?.revealKnowledge?.(profileId, receipt.itemId, receipt.kind);
            globalThis.dispatchEvent?.(new CustomEvent('workspace:open-settings', { detail: { tab: 'profiles', profileId, section: 'skills' } }));
        }
        function decorate() {
            ensureAnchors();
            for (const node of root.querySelectorAll('.pi-memory-hint-fallback')) node.remove();
            const host = transcriptHost();
            if (host) for (const node of host.querySelectorAll('.pi-memory-hint')) node.remove();
            const fallback = [];
            for (const receipt of hintReceipts()) {
                const anchorKey = anchorKeys?.get(receipt.source.entryId);
                const target = anchorKey && host ? [...host.querySelectorAll('[data-message-key]')].find(node => node.dataset.messageKey === anchorKey) : null;
                if (target) target.after(hintBlock(receipt));
                else fallback.push(receipt);
            }
            const list = root.querySelector('.pi-memory-hint-list');
            if (list) list.replaceChildren(...fallback.map(receipt => hintBlock(receipt, true)));
        }
        // entryId -> [role, timestamp, toolCallId] matches the transcript's data-message-key. The server
        // sends these anchors with the current context; entries outside it fall back to the card.
        function ensureAnchors() {
            const rows = typeof anchors === 'function' ? anchors() : null;
            anchorKeys = Array.isArray(rows) ? new Map(rows.filter(row => Array.isArray(row) && typeof row[0] === 'string')
                .map(([entryId, role, timestamp, toolCallId]) => [entryId, JSON.stringify([role, timestamp, toolCallId || ''])])) : null;
        }
        function render() {
            const wasOpen = root.querySelector('details')?.open;
            root.replaceChildren(); root.hidden = !key;
            if (!key) return;
            const panel = el('details', undefined, 'pi-chat-knowledge');
            // Collapsed by default; the summary always reports what this session has remembered.
            panel.open = Boolean(wasOpen || uncertain);
            const summary = el('summary');
            const health = learningSnapshot?.health;
            if (health?.state) summary.append(el('span', undefined, `pi-health-dot pi-health-${healthTone[health.state] || 'off'}`));
            summary.append(el('span', `${t('纠错与记忆回执')} · ${t('本会话已记住 {0} 条', hintReceipts().length)}${learning ? ` · ${t('学习处理中')}` : ''}`));
            panel.append(summary);
            const body = el('div', undefined, 'pi-chat-knowledge-body');
            const info = el('p', t('手动纠错属于当前助手范围，不会伪造聊天来源；仅经服务端核实的线程回执在此显示。'), 'pi-profile-note');
            body.append(info);
            if (health?.state && health.state !== 'ok') {
                const line = el('p', undefined, 'pi-knowledge-health');
                line.append(el('span', undefined, `pi-health-dot pi-health-${healthTone[health.state] || 'off'}`),
                    el('span', t(healthLabel[health.state] || '学习当前不可用')));
                body.append(line);
            }
            const status = el('p', notice || hintNotice || (snapshot ? t('存储状态：{0}', t(statusLabel[snapshot.status] || snapshot.status)) : t('正在读取…')), 'pi-knowledge-status');
            status.setAttribute('role', 'status'); body.append(status);
            if (learning) body.append(el('p', t('后台学习正在处理本轮内容…'), 'pi-knowledge-status'));
            if (latest) {
                const row = el('div', undefined, 'pi-knowledge-receipt');
                row.textContent = `${t(latest.operation === 'undo' ? '撤销' : '手动纠错')} · ${t(latest.status === 'pending' ? '待同步' : latest.status === 'saved' ? '已保存' : statusLabel[latest.status] || latest.status || '状态未知')}`;
                if (latest.indexStatus === 'pending') row.append(el('small', t('索引待同步')));
                if (latest.activation === 'reload-required') row.append(el('small', t('当前会话需重载')));
                else if (latest.activation === 'next-turn') row.append(el('small', t('下次对话可用，模型是否遵守无法保证')));
                if (latest.undoable && latest.id && writable('undo', latest.kind) && latest.kind === 'memory')
                    row.append(button(t('撤销'), () => void submit('undo', latest)));
                body.append(row);
            }
            const hinted = new Set(hintReceipts());
            for (const receipt of sessionReceipts().filter(r => r.kind === 'memory' && !hinted.has(r)).slice(0, 10)) {
                const row = el('div', undefined, 'pi-chat-knowledge-receipt');
                row.append(el('strong', `${t('已核对线程来源')} · ${t(receipt.status === 'saved' ? '已保存' : receipt.status === 'pending' ? '待同步' : statusLabel[receipt.status] || receipt.status || '状态未知')}`));
                row.append(el('small', [receipt.source.entryId && t('原生记录：{0}', receipt.source.entryId), receipt.summary,
                    receipt.indexStatus === 'pending' && t('索引待同步'), receipt.activation === 'reload-required' && t('当前会话需重载')].filter(Boolean).join(' · ')));
                if (receipt.undoable && receipt.id && writable('undo', receipt.kind))
                    row.append(button(t('撤销'), () => void submit('undo', receipt)));
                body.append(row);
            }
            // Hints whose source message is not rendered (compacted away or off-branch) fall back to this card.
            body.append(el('div', undefined, 'pi-memory-hint-list'));
            const form = el('form', undefined, 'pi-chat-knowledge-form');
            const label = el('label', t('手动记录纠错')); const input = el('textarea'); input.rows = 3; input.required = true;
            input.value = draft; input.maxLength = snapshot?.capabilities?.maxContentLength || 65536; input.oninput = () => { draft = input.value; }; label.append(input); form.append(label);
            const save = el('button', t('保存纠错'), 'settings-primary-button'); save.type = 'submit';
            save.disabled = busy || !!uncertain || !writable('create');
            form.append(save); form.onsubmit = event => { event.preventDefault(); if (form.reportValidity()) void submit('create'); }; body.append(form);
            if (uncertain && !busy) body.append(button(t('刷新回执核对'), () => void refresh()));
            body.append(button(t('刷新'), () => void refresh())); panel.append(body); root.append(panel);
            decorate();
        }
        async function refresh() {
            const value = scope(); if (!value || !current()) return;
            const request = ++epoch, captured = key;
            try {
                const [data, jobs] = await Promise.all([fetch(`${base(value)}?${new URLSearchParams({ kind: 'memory', sessionId: value.sessionId })}`),
                    fetch(`/api/pi/profiles/${encodeURIComponent(value.profileId)}/learning`).catch(() => null)]);
                if (request !== epoch || !current() || key !== captured) return;
                learningSnapshot = jobs && typeof jobs === 'object' ? jobs : null;
                learning = Array.isArray(jobs?.jobs) && jobs.jobs.some(job => ['queued', 'running'].includes(job.status));
                clearTimeout(timer);
                if (learning && polls < 48) { polls++; timer = setTimeout(() => { if (current() && key === captured) void refresh(); }, 2500); }
                if (data?.version !== 1 || !Array.isArray(data.receipts) || !Array.isArray(data.items)) throw new Error(t('知识接口不兼容'));
                snapshot = data;
                const found = data.receipts.find(row => row.requestId === uncertain?.requestId && row.kind === 'memory');
                if (found) {
                    latest = found;
                    if (['saved', 'pending'].includes(found.status) && uncertain?.operation === 'create' && uncertain.content === draft) draft = '';
                    uncertain = null;
                }
                notice = uncertain ? t('提交结果未确认；请求 ID {0} 已保留，请勿重复提交。', uncertain.requestId)
                    : conflict ? t('版本冲突；草稿已保留。刷新并核对服务器版本。') : memoryFull ? t('记忆已满，新记忆会被拒绝。请整理合并后再试。') : '';
                render();
            } catch (error) { if (request === epoch && current()) { notice = t('读取失败：{0}', error.message); render(); } }
        }
        async function submit(operation, receipt) {
            const value = scope();
            const kind = operation === 'create' ? 'memory' : receipt.kind;
            if (!current() || !value || busy || uncertain || !writable(operation, kind)) return;
            const input = { requestId: id(), expectedRevision: snapshot.revision, operation, kind,
                ...(operation === 'undo' ? { receiptId: receipt.id } : {}),
                ...(operation === 'delete' ? { itemId: receipt.itemId, itemRevision: receipt.afterRevision } : {}),
                ...(operation === 'create' ? { category: 'correction', scope: 'profile', content: draft.trim() } : {}) };
            if (operation === 'create' && !input.content) return;
            busy = true; uncertain = { requestId: input.requestId, operation, content: draft }; notice = t('正在提交，等待服务回执…'); render();
            const captured = key;
            try {
                const data = await fetch(`${base(value)}/mutations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
                if (!current() || captured !== key) return;
                if (data?.version !== 1 || data.receipt?.requestId !== input.requestId) throw new Error(t('回执未确认'));
                latest = data.receipt; uncertain = null; conflict = false; memoryFull = false; hintNotice = '';
                if (['saved', 'pending'].includes(latest.status) && operation === 'create') draft = '';
                notice = latest.status === 'conflict' ? t('版本冲突；草稿已保留。刷新并核对服务器版本。') : '';
                snapshot = null; void refresh();
            } catch (error) {
                if (!current() || captured !== key) return;
                if (error.status === 409 && (error.data?.code === 'memory-full' || error.code === 'memory-full')) {
                    uncertain = null; memoryFull = true;
                    hintNotice = t('记忆已满，新记忆会被拒绝。请整理合并后再试。'); void refresh();
                } else if (error.status === 409) {
                    uncertain = null;
                    if (operation === 'create') { conflict = true; notice = t('版本冲突；草稿已保留。刷新并核对服务器版本。'); }
                    else hintNotice = t('版本冲突；已刷新数据，请核对后再试。');
                    void refresh();
                }
                else if (rejected(error)) { uncertain = null; notice = t('提交被服务端拒绝：{0}，草稿已保留。', error.message); }
                else { uncertain = { requestId: input.requestId, operation, content: draft }; notice = t('提交结果未确认：{0}。请求 ID {1} 已保留，勿重复提交。', error.message, input.requestId); }
            } finally { busy = false; if (current() && captured === key) render(); }
        }
        function update() {
            const value = scope(), next = scopeKey(value), nextIdentity = value ? JSON.stringify([value.cwd, value.sessionId, value.profileId]) : '';
            if (next !== key) {
                if (nextIdentity !== identity) {
                    keep();
                    ({ draft = '', uncertain = null, latest = null, notice = '', conflict = false, memoryFull = false, hintNotice = '' } = draftsByThread.get(nextIdentity) || {});
                }
                key = next; epoch++; snapshot = null; identity = nextIdentity; learning = false; anchorKeys = null;
            }
            polls = 0; clearTimeout(timer);
            render(); if (key) void refresh();
        }
        // A settled turn registers learning on the server concurrently with this refresh; look
        // once more shortly after so a just-queued job starts the bounded follow-up.
        let settledTimer = null;
        function settled() {
            polls = 0; clearTimeout(settledTimer);
            void refresh();
            const captured = key;
            settledTimer = setTimeout(() => { if (current() && key === captured) void refresh(); }, 1500);
        }
        return { update, decorate, refresh, settled, reset() { clearTimeout(settledTimer); keep(); clearTimeout(timer); learning = false; key = identity = ''; epoch++; snapshot = null; latest = null; uncertain = null; conflict = false; draft = ''; notice = ''; hintNotice = ''; memoryFull = false; anchorKeys = null; learningSnapshot = null; render(); } };
    }
    globalThis.PiChatKnowledge = Object.freeze({ create });
})();
