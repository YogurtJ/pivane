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
    function create({ root, fetch, scope }) {
        let key = '', identity = '', epoch = 0, busy = false, snapshot = null, draft = '', uncertain = null, notice = '', latest = null, conflict = false;
        // Background learning saves after the turn settles; follow queued/running jobs for a bounded time.
        let learning = false, polls = 0, timer = null;
        const draftsByThread = new Map();
        const keep = () => { if (identity) draftsByThread.set(identity, { draft, uncertain, latest, notice, conflict }); };
        const scopeKey = value => value ? JSON.stringify([value.cwd, value.sessionId, value.profileId, value.generation]) : '';
        const current = () => scopeKey(scope()) === key && Boolean(key);
        const base = value => `/api/pi/profiles/${encodeURIComponent(value.profileId)}/knowledge`;
        const writable = operation => snapshot?.status === 'ready' && snapshot.capabilities?.memory === true
            && (!Array.isArray(snapshot.capabilities.operations) || snapshot.capabilities.operations.includes(operation))
            && /^[a-f0-9]{64}$/.test(snapshot.revision || '');
        function render() {
            const wasOpen = root.querySelector('details')?.open;
            root.replaceChildren(); root.hidden = !key;
            if (!key) return;
            const panel = el('details', undefined, 'pi-chat-knowledge');
            panel.open = Boolean(wasOpen || draft || uncertain || notice);
            panel.append(el('summary', t('纠错与记忆回执')));
            const body = el('div', undefined, 'pi-chat-knowledge-body');
            const info = el('p', t('手动纠错属于当前助手范围，不会伪造聊天来源；仅经服务端核实的线程回执在此显示。'), 'pi-profile-note');
            body.append(info);
            const status = el('p', notice || (snapshot ? t('存储状态：{0}', snapshot.status) : t('正在读取…')), 'pi-knowledge-status');
            status.setAttribute('role', 'status'); body.append(status);
            if (learning) body.append(el('p', t('后台学习正在处理本轮内容…'), 'pi-knowledge-status'));
            if (latest) {
                const row = el('div', undefined, 'pi-knowledge-receipt');
                row.textContent = `${t(latest.operation === 'undo' ? '撤销' : '手动纠错')} · ${t(latest.status === 'pending' ? '待同步' : latest.status === 'saved' ? '已保存' : latest.status || '状态未知')}`;
                if (latest.indexStatus === 'pending') row.append(el('small', t('索引待同步')));
                if (latest.activation === 'reload-required') row.append(el('small', t('当前会话需重载')));
                else if (latest.activation === 'next-turn') row.append(el('small', t('下次对话可用，模型是否遵守无法保证')));
                if (latest.undoable && latest.id && writable('undo') && latest.kind === 'memory')
                    row.append(button(t('撤销'), () => void submit('undo', latest)));
                body.append(row);
            }
            for (const receipt of (snapshot?.receipts || []).filter(r => r.source?.sessionId === scope()?.sessionId && r.kind === 'memory').slice(0, 10)) {
                const row = el('div', undefined, 'pi-chat-knowledge-receipt');
                row.append(el('strong', `${t('已核对线程来源')} · ${t(receipt.status === 'saved' ? '已保存' : receipt.status === 'pending' ? '待同步' : receipt.status || '状态未知')}`));
                row.append(el('small', [receipt.source.entryId && t('原生记录：{0}', receipt.source.entryId), receipt.summary,
                    receipt.indexStatus === 'pending' && t('索引待同步'), receipt.activation === 'reload-required' && t('当前会话需重载')].filter(Boolean).join(' · ')));
                if (receipt.undoable && receipt.id && writable('undo'))
                    row.append(button(t('撤销'), () => void submit('undo', receipt)));
                body.append(row);
            }
            const form = el('form', undefined, 'pi-chat-knowledge-form');
            const label = el('label', t('手动记录纠错')); const input = el('textarea'); input.rows = 3; input.required = true;
            input.value = draft; input.maxLength = snapshot?.capabilities?.maxContentLength || 65536; input.oninput = () => { draft = input.value; }; label.append(input); form.append(label);
            const save = el('button', t('保存纠错'), 'settings-primary-button'); save.type = 'submit';
            save.disabled = busy || !!uncertain || !writable('create');
            form.append(save); form.onsubmit = event => { event.preventDefault(); if (form.reportValidity()) void submit('create'); }; body.append(form);
            if (uncertain && !busy) body.append(button(t('刷新回执核对'), () => void refresh()));
            body.append(button(t('刷新'), () => void refresh())); panel.append(body); root.append(panel);
        }
        async function refresh() {
            const value = scope(); if (!value || !current()) return;
            const request = ++epoch, captured = key;
            try {
                const [data, jobs] = await Promise.all([fetch(`${base(value)}?${new URLSearchParams({ kind: 'memory', sessionId: value.sessionId })}`),
                    fetch(`/api/pi/profiles/${encodeURIComponent(value.profileId)}/learning`).catch(() => null)]);
                if (request !== epoch || !current() || key !== captured) return;
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
                    : conflict ? t('版本冲突；草稿已保留。刷新并核对服务器版本。') : '';
                render();
            } catch (error) { if (request === epoch && current()) { notice = t('读取失败：{0}', error.message); render(); } }
        }
        async function submit(operation, receipt) {
            const value = scope();
            if (!current() || !value || busy || uncertain || !writable(operation)) return;
            const input = { requestId: id(), expectedRevision: snapshot.revision, operation, kind: operation === 'undo' ? receipt.kind : 'memory',
                ...(operation === 'undo' ? { receiptId: receipt.id } : { category: 'correction', scope: 'profile', content: draft.trim() }) };
            if (operation === 'create' && !input.content) return;
            busy = true; uncertain = { requestId: input.requestId, operation, content: draft }; notice = t('正在提交，等待服务回执…'); render();
            const captured = key;
            try {
                const data = await fetch(`${base(value)}/mutations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
                if (!current() || captured !== key) return;
                if (data?.version !== 1 || data.receipt?.requestId !== input.requestId) throw new Error(t('回执未确认'));
                latest = data.receipt; uncertain = null; conflict = false;
                if (['saved', 'pending'].includes(latest.status) && operation === 'create') draft = '';
                notice = latest.status === 'conflict' ? t('版本冲突；草稿已保留。刷新并核对服务器版本。') : '';
                snapshot = null; void refresh();
            } catch (error) {
                if (!current() || captured !== key) return;
                if (error.status === 409) { uncertain = null; conflict = true; notice = t('版本冲突；草稿已保留。刷新并核对服务器版本。'); void refresh(); }
                else if (rejected(error)) { uncertain = null; notice = t('提交被服务端拒绝：{0}，草稿已保留。', error.message); }
                else { uncertain = { requestId: input.requestId, operation, content: draft }; notice = t('提交结果未确认：{0}。请求 ID {1} 已保留，勿重复提交。', error.message, input.requestId); }
            } finally { busy = false; if (current() && captured === key) render(); }
        }
        function update() {
            const value = scope(), next = scopeKey(value), nextIdentity = value ? JSON.stringify([value.cwd, value.sessionId, value.profileId]) : '';
            if (next !== key) {
                if (nextIdentity !== identity) {
                    keep();
                    ({ draft = '', uncertain = null, latest = null, notice = '', conflict = false } = draftsByThread.get(nextIdentity) || {});
                }
                key = next; epoch++; snapshot = null; identity = nextIdentity; learning = false;
            }
            polls = 0; clearTimeout(timer);
            render(); if (key) void refresh();
        }
        return { update, refresh, reset() { keep(); clearTimeout(timer); learning = false; key = identity = ''; epoch++; snapshot = null; latest = null; uncertain = null; conflict = false; draft = ''; notice = ''; render(); } };
    }
    globalThis.PiChatKnowledge = Object.freeze({ create });
})();
