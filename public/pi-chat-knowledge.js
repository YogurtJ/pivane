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
    const icon = (className, extra = '') => { const item = el('i', undefined, `${className} ${extra}`.trim()); item.setAttribute('aria-hidden', 'true'); return item; };
    // Compact buttons shared by the card and the transcript hints; the text stays the accessible name.
    const button = (text, fn, className = 'pi-ck-button', iconClass = '') => {
        const item = el('button', undefined, className); item.type = 'button'; item.onclick = fn;
        if (iconClass) item.append(icon(iconClass));
        item.append(el('span', text)); return item;
    };
    const id = () => globalThis.crypto?.randomUUID?.() || `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const rejected = error => [400, 403, 404, 413, 422, 429].includes(error?.status);
    const statusLabel = { ready: '就绪', pending: '待同步', missing: '缺失', disabled: '未启用', unsupported: '不支持', error: '错误', saved: '已保存' };
    const categoryLabel = { fact: '事实', preference: '偏好', correction: '纠错', failure: '失败经验', procedure: '流程' };
    const healthLabel = { ok: '学习正常', off: '学习已关闭', 'needs-model': '缺少学习模型配置', 'quota-exhausted': '今日学习额度已用完', failing: '最近学习连续失败', unavailable: '学习当前不可用', 'memory-full': '记忆已满' };
    const healthTone = { ok: 'ok', off: 'off', 'needs-model': 'warn', 'quota-exhausted': 'warn', failing: 'bad', unavailable: 'bad', 'memory-full': 'warn' };
    // Transcript hint identity: who wrote it decides the label and icon; the preview stays the body text.
    const hintLabel = { skill: '学会技能', agent: 'Agent 记下', learning: '已记住' };
    const hintIcon = { skill: 'fa-solid fa-graduation-cap', agent: 'fa-solid fa-pen-nib', learning: 'fa-solid fa-brain' };
    // Non-ready injection states are valid server answers, not failures.
    const injectionStatus = { disabled: '此身份的记忆未启用，不会注入记忆。', pending: '记忆正在同步，稍后再看。',
        unsupported: '记忆插件未安装，无法预览注入。', missing: '身份不存在或已删除。' };
    function create({ root, fetch, scope, transcript, anchors }) {
        let key = '', identity = '', epoch = 0, busy = false, snapshot = null, draft = '', uncertain = null, notice = '', hintNotice = '', latest = null, conflict = false;
        // Background learning saves after the turn settles; follow queued/running jobs for a bounded time.
        let learning = false, polls = 0, timer = null;
        // Contract fields (origin/preview/health) arrive later; absent fields keep the old card display.
        let learningSnapshot = null, anchorKeys = null, memoryFull = false;
        // U2.2: the session's next-turn injection (read-only preview), loaded on demand.
        let injectionView = null, injectionEpoch = 0, injectionRawOpen = false;
        // Receipt ids whose clamped preview the user expanded; kept across re-renders.
        const expandedHints = new Set();
        // U2.4: the session reload button is disabled while the session is busy.
        let sessionBusy = false;
        const isBusy = () => sessionBusy || Boolean(scope()?.busy);
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
        const hintKind = receipt => receipt.kind === 'skill' ? 'skill' : receipt.origin === 'agent' ? 'agent' : 'learning';
        const transcriptHost = () => (typeof transcript === 'function' ? transcript() : transcript) || document.getElementById('pi-transcript-content');
        // U2.4: reload this chat session so a learned skill becomes active. The button only
        // appears when the current chat is the source session and is disabled while it is busy.
        function reloadButton(receipt, className = 'pi-ck-button') {
            const value = scope();
            if (!value?.sessionId || receipt?.source?.sessionId !== value.sessionId) return null;
            const reload = button(t('重载会话'), () => globalThis.dispatchEvent?.(new CustomEvent('chat:reload-resources', { detail: { sessionId: value.sessionId } })),
                className, 'fa-solid fa-rotate-right');
            reload.disabled = isBusy();
            reload.classList.add('pi-memory-hint-reload');
            return reload;
        }
        function hintBlock(receipt, fallback) {
            const kind = hintKind(receipt), preview = hintPreview(receipt);
            const box = el('div', undefined, fallback ? 'pi-memory-hint pi-memory-hint-fallback' : 'pi-memory-hint');
            box.setAttribute('role', 'note');
            box.dataset.hintKind = kind;
            if (receipt.kind === 'memory' && receipt.category) box.dataset.category = receipt.category;
            box.append(icon(hintIcon[kind], 'pi-memory-hint-icon'));
            const main = el('div', undefined, 'pi-memory-hint-main');
            const meta = el('div', undefined, 'pi-memory-hint-meta');
            meta.append(el('strong', t(hintLabel[kind]), 'pi-memory-hint-label'));
            if (receipt.kind === 'memory' && receipt.category) meta.append(el('span', t(categoryLabel[receipt.category] || receipt.category), 'pi-memory-hint-tag'));
            if (receipt.kind === 'skill') meta.append(el('small', t('需重载会话后生效'), 'pi-memory-hint-note'));
            const text = el('p', preview, 'pi-memory-hint-text');
            // Long previews clamp to two lines; the text itself toggles the full preview.
            const expandKey = receipt.id || receipt.requestId || preview;
            const setExpanded = value => {
                text.classList.toggle('is-expanded', value); text.setAttribute('aria-expanded', String(value));
                if (value) expandedHints.add(expandKey); else expandedHints.delete(expandKey);
            };
            text.tabIndex = 0; text.setAttribute('role', 'button'); text.title = t('点击展开或收起全文');
            setExpanded(expandedHints.has(expandKey));
            text.onclick = () => setExpanded(!text.classList.contains('is-expanded'));
            text.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); text.click(); } };
            main.append(meta, text);
            box.append(main);
            const actions = el('div', undefined, 'pi-memory-hint-actions');
            if (receipt.kind === 'skill') {
                const reload = reloadButton(receipt, 'pi-memory-hint-action');
                if (reload) actions.append(reload);
            }
            // Project scope is edited through the management page with the verified session;
            // chat keeps only the jump-to-edit entry for it.
            if (receipt.undoable !== false) {
                const action = (label, fn) => button(t(label), fn, 'pi-memory-hint-action');
                if (receipt.scope !== 'project') {
                    if (writable('undo', receipt.kind)) actions.append(action('撤销', () => void submit('undo', receipt)));
                    if (receipt.kind === 'memory') {
                        if (receipt.afterRevision && writable('delete', 'memory')) actions.append(action('不对', () => {
                            if (confirm(t('这条记忆不对吗？删除后学习不会再记回来。'))) void submit('delete', receipt);
                        }));
                    } else if (writable('undo', receipt.kind)) actions.append(action('不对', () => void submit('undo', receipt)));
                }
                actions.append(action('编辑', () => reveal(receipt)));
            }
            if (actions.childElementCount) box.append(actions);
            return box;
        }
        function reveal(receipt) {
            const value = scope();
            const profileId = value?.profileId;
            const sessionId = receipt.source?.sessionId || value?.sessionId;
            if (!profileId || !receipt.itemId) return;
            globalThis.PiAgentProfilesUI?.revealKnowledge?.(profileId, receipt.itemId, receipt.kind, sessionId);
            globalThis.dispatchEvent?.(new CustomEvent('workspace:open-settings', { detail: { tab: 'profiles', profileId, section: 'skills' } }));
        }
        function revealProjectMemory() {
            const value = scope();
            if (!value?.profileId || !value?.sessionId) return;
            globalThis.PiAgentProfilesUI?.revealProjectMemory?.(value.profileId, value.sessionId);
            globalThis.dispatchEvent?.(new CustomEvent('workspace:open-settings', { detail: { tab: 'profiles', profileId: value.profileId, section: 'skills' } }));
        }
        function decorate() {
            ensureAnchors();
            for (const node of root.querySelectorAll('.pi-memory-hint-fallback')) node.remove();
            const host = transcriptHost();
            if (host) for (const node of host.querySelectorAll('.pi-memory-hints, .pi-memory-hint')) node.remove();
            const fallback = [], groups = new Map();
            // Oldest first, each placed after any hints already under the same message.
            for (const receipt of [...hintReceipts()].reverse()) {
                const anchorKey = anchorKeys?.get(receipt.source.entryId);
                let target = anchorKey && host ? [...host.querySelectorAll('[data-message-key]')].find(node => node.dataset.messageKey === anchorKey) : null;
                // Hints sit under the turn's user message: process messages (tool calls) fold away in
                // compact views, while the user message of every turn stays visible.
                while (target && target.parentElement && target.parentElement !== host) target = target.parentElement;
                while (target && !target.matches('.pi-message.user') && target.previousElementSibling) target = target.previousElementSibling;
                if (target && !target.matches('.pi-message.user')) target = null;
                if (!target) { fallback.push(receipt); continue; }
                // One group per user message keeps a turn's receipts together as a single card.
                let group = groups.get(target);
                if (!group) {
                    group = el('div', undefined, 'pi-memory-hints');
                    group.setAttribute('role', 'group'); group.setAttribute('aria-label', t('本轮记忆更新'));
                    target.after(group); groups.set(target, group);
                }
                group.append(hintBlock(receipt));
            }
            const list = root.querySelector('.pi-memory-hint-list');
            if (list) {
                list.replaceChildren(...fallback.map(receipt => hintBlock(receipt, true)));
                list.closest('.pi-chat-knowledge-fallback')?.toggleAttribute('hidden', !fallback.length);
            }
        }
        // entryId -> [role, timestamp, toolCallId] matches the transcript's data-message-key. The server
        // sends these anchors with the current context; entries outside it fall back to the card.
        function ensureAnchors() {
            const rows = typeof anchors === 'function' ? anchors() : null;
            anchorKeys = Array.isArray(rows) ? new Map(rows.filter(row => Array.isArray(row) && typeof row[0] === 'string')
                .map(([entryId, role, timestamp, toolCallId]) => [entryId, JSON.stringify([role, timestamp, toolCallId || ''])])) : null;
        }
        async function loadInjection() {
            const value = scope();
            if (!current() || !value) return;
            const request = ++injectionEpoch, captured = key;
            injectionView = { loading: true };
            render();
            try {
                // base() already ends in /knowledge; the route is /profiles/:id/knowledge/injection.
                const data = await fetch(`${base(value)}/injection?${new URLSearchParams({ sessionId: value.sessionId })}`);
                if (request !== injectionEpoch || !current() || key !== captured) return;
                injectionView = data?.version === 1 && typeof data.block === 'string' ? data : { error: t('注入内容不可用。') };
            } catch (error) {
                if (request !== injectionEpoch || !current() || key !== captured) return;
                injectionView = { error: t('注入内容不可用：{0}', error.message) };
            }
            render();
        }
        function injectionBox() {
            const view = injectionView;
            const box = el('section', undefined, 'pi-injection-preview');
            const head = el('header', undefined, 'pi-injection-head');
            head.append(el('strong', t('下一轮注入预览')));
            const close = button(t('收起注入内容'), () => { injectionView = null; injectionEpoch++; render(); }, 'pi-ck-icon-button', 'fa-solid fa-xmark');
            close.title = t('收起注入内容'); close.querySelector('span').className = 'pi-ck-visually-hidden';
            head.append(close); box.append(head);
            if (!view || view.loading) { box.append(el('p', t('正在读取…'), 'pi-knowledge-status')); return box; }
            if (view.error) { box.append(el('p', view.error, 'pi-knowledge-status pi-injection-error')); return box; }
            const count = row => row && typeof row === 'object'
                ? t('{0} 条 · {1} 字', Number.isFinite(row.entries) ? row.entries : '—', Number.isFinite(row.chars) ? row.chars : '—') : '—';
            const stats = el('div', undefined, 'pi-injection-stats');
            const tile = (label, row) => { const item = el('div', undefined, 'pi-injection-stat'); item.append(el('span', t(label)), el('strong', count(row))); stats.append(item); };
            tile('身份记忆', view.profile && typeof view.profile === 'object' ? view.profile : view);
            if (view.project && typeof view.project === 'object') tile('项目记忆', view.project);
            if (view.lastRead && typeof view.lastRead === 'object') tile('上一轮已注入', view.lastRead);
            box.append(stats);
            if (view.status && view.status !== 'ready') box.append(el('p', t(injectionStatus[view.status] || '注入内容不可用。'), 'pi-injection-state'));
            if (view.block) {
                const details = el('details', undefined, 'pi-injection-body');
                details.open = injectionRawOpen;
                details.append(el('summary', t('查看注入原文')), el('pre', String(view.block)));
                box.append(details);
            } else if (!view.status || view.status === 'ready') box.append(el('p', t('当前没有可注入的记忆。'), 'pi-injection-state'));
            if (view.truncated === true) box.append(el('p', t('已截断，仅显示部分内容'), 'pi-profile-note'));
            box.append(el('p', t('注入不代表模型一定遵守。'), 'pi-profile-note'));
            return box;
        }
        function render() {
            const wasOpen = root.querySelector('.pi-chat-knowledge')?.open;
            // Read synchronously: the async toggle event may not have fired before a re-render.
            const rawOpen = root.querySelector('.pi-injection-body')?.open;
            if (rawOpen !== undefined) injectionRawOpen = rawOpen;
            root.replaceChildren(); root.hidden = !key;
            if (!key) return;
            const panel = el('details', undefined, 'pi-chat-knowledge');
            // Collapsed by default; the summary always reports what this session has remembered.
            panel.open = Boolean(wasOpen || uncertain?.operation === 'create');
            const summary = el('summary', undefined, 'pi-chat-knowledge-summary');
            const health = learningSnapshot?.health;
            summary.append(icon('fa-solid fa-brain', 'pi-chat-knowledge-icon'), el('strong', t('纠错与记忆回执'), 'pi-chat-knowledge-title'),
                el('span', t('本会话已记住 {0} 条', hintReceipts().length), 'pi-chat-knowledge-count'));
            if (health?.state) {
                const chip = el('span', undefined, `pi-chat-knowledge-health pi-health-chip-${healthTone[health.state] || 'off'}`);
                const label = t(healthLabel[health.state] || '学习当前不可用');
                const dot = el('span', undefined, `pi-health-dot pi-health-${healthTone[health.state] || 'off'}`); dot.title = label;
                chip.append(dot);
                if (health.state !== 'ok') chip.append(el('span', label));
                summary.append(chip);
            }
            if (learning) {
                const chip = el('span', undefined, 'pi-chat-knowledge-learning');
                chip.append(icon('fa-solid fa-circle-notch fa-spin'), el('span', t('学习处理中')));
                summary.append(chip);
            }
            summary.append(icon('fa-solid fa-chevron-down', 'pi-chat-knowledge-chevron'));
            panel.append(summary);
            const body = el('div', undefined, 'pi-chat-knowledge-body');
            const toolbar = el('div', undefined, 'pi-chat-knowledge-toolbar');
            const problem = Boolean(notice || hintNotice);
            const status = el('p', notice || hintNotice || (snapshot ? t('存储状态：{0}', t(statusLabel[snapshot.status] || snapshot.status)) : t('正在读取…')),
                `pi-knowledge-status pi-chat-knowledge-status${problem ? ' is-notice' : ''}`);
            status.setAttribute('role', 'status');
            const entries = el('div', undefined, 'pi-knowledge-entries');
            const showing = Boolean(injectionView);
            const toggle = button(t(showing ? '收起注入内容' : '查看本会话注入内容'), () => {
                if (injectionView) { injectionView = null; injectionEpoch++; render(); } else void loadInjection();
            }, 'pi-ck-button', 'fa-solid fa-eye');
            toggle.setAttribute('aria-expanded', String(showing));
            entries.append(toggle, button(t('本项目记忆'), () => revealProjectMemory(), 'pi-ck-button', 'fa-solid fa-folder-open'),
                button(t('刷新'), () => void refresh(), 'pi-ck-button', 'fa-solid fa-arrows-rotate'));
            toolbar.append(status, entries);
            body.append(toolbar);
            if (health?.state && health.state !== 'ok') {
                const line = el('p', undefined, 'pi-knowledge-health');
                line.append(el('span', undefined, `pi-health-dot pi-health-${healthTone[health.state] || 'off'}`),
                    el('span', t(healthLabel[health.state] || '学习当前不可用')));
                body.append(line);
            }
            if (injectionView) body.append(injectionBox());
            if (learning) body.append(el('p', t('后台学习正在处理本轮内容…'), 'pi-knowledge-status pi-chat-knowledge-learning-line'));
            if (latest) {
                const row = el('div', undefined, 'pi-knowledge-receipt pi-chat-knowledge-latest');
                row.textContent = `${t(latest.operation === 'undo' ? '撤销' : '手动纠错')} · ${t(latest.status === 'pending' ? '待同步' : latest.status === 'saved' ? '已保存' : statusLabel[latest.status] || latest.status || '状态未知')}`;
                if (latest.indexStatus === 'pending') row.append(el('small', t('索引待同步')));
                if (latest.activation === 'reload-required') row.append(el('small', t('当前会话需重载')));
                else if (latest.activation === 'next-turn') row.append(el('small', t('下次对话可用，模型是否遵守无法保证')));
                if (latest.kind === 'skill') {
                    const reload = reloadButton(latest);
                    if (reload) row.append(reload);
                }
                if (latest.undoable && latest.id && writable('undo', latest.kind) && latest.kind === 'memory')
                    row.append(button(t('撤销'), () => void submit('undo', latest), 'pi-memory-hint-action'));
                body.append(row);
            }
            const hinted = new Set(hintReceipts());
            for (const receipt of sessionReceipts().filter(r => r.kind === 'memory' && !hinted.has(r) && !r.superseded).slice(0, 10)) {
                const row = el('div', undefined, 'pi-chat-knowledge-receipt');
                row.append(el('strong', `${t('已核对线程来源')} · ${t(receipt.status === 'saved' ? '已保存' : receipt.status === 'pending' ? '待同步' : statusLabel[receipt.status] || receipt.status || '状态未知')}`));
                row.append(el('small', [receipt.source.entryId && t('原生记录：{0}', receipt.source.entryId), receipt.summary,
                    receipt.indexStatus === 'pending' && t('索引待同步'), receipt.activation === 'reload-required' && t('当前会话需重载')].filter(Boolean).join(' · ')));
                if (receipt.undoable && receipt.id && writable('undo', receipt.kind))
                    row.append(button(t('撤销'), () => void submit('undo', receipt), 'pi-memory-hint-action'));
                body.append(row);
            }
            // Hints whose source message is not rendered (compacted away or off-branch) fall back to this card.
            const fallback = el('section', undefined, 'pi-chat-knowledge-fallback');
            fallback.hidden = true;
            fallback.append(el('h4', t('未在对话中定位的回执'), 'pi-chat-knowledge-heading'), el('div', undefined, 'pi-memory-hint-list pi-memory-hints'));
            body.append(fallback);
            const form = el('form', undefined, 'pi-chat-knowledge-form');
            const label = el('label'); label.append(el('span', t('手动记录纠错'), 'pi-chat-knowledge-heading'));
            const input = el('textarea'); input.rows = 3; input.required = true; input.placeholder = t('例如：回答数学题时先给结论，再给推导。');
            input.value = draft; input.maxLength = snapshot?.capabilities?.maxContentLength || 65536; input.oninput = () => { draft = input.value; }; label.append(input); form.append(label);
            const foot = el('div', undefined, 'pi-chat-knowledge-form-foot');
            foot.append(el('small', t('手动纠错属于当前助手范围，不会伪造聊天来源；仅经服务端核实的线程回执在此显示。'), 'pi-chat-knowledge-footnote'));
            const save = el('button', t('保存纠错'), 'pi-ck-button pi-ck-primary'); save.type = 'submit';
            save.disabled = busy || !!uncertain || !writable('create');
            if (uncertain && !busy) foot.append(button(t('刷新回执核对'), () => void refresh()));
            foot.append(save);
            form.append(foot); form.onsubmit = event => { event.preventDefault(); if (form.reportValidity()) void submit('create'); }; body.append(form);
            panel.append(body); root.append(panel);
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
                key = next; epoch++; snapshot = null; identity = nextIdentity; learning = false; anchorKeys = null; injectionView = null; injectionEpoch++; injectionRawOpen = false;
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
        return { update, decorate, refresh, settled, setBusy(value) { const next = Boolean(value); if (next !== sessionBusy) { sessionBusy = next; render(); } }, reset() { clearTimeout(settledTimer); keep(); clearTimeout(timer); learning = false; key = identity = ''; epoch++; snapshot = null; latest = null; uncertain = null; conflict = false; draft = ''; notice = ''; hintNotice = ''; memoryFull = false; anchorKeys = null; learningSnapshot = null; injectionView = null; render(); } };
    }
    globalThis.PiChatKnowledge = Object.freeze({ create });
})();
