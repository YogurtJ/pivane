/* Memory and learned skills share the server knowledge journal; drafts stay local until saved. */
(() => {
    'use strict';
    const t = (s, ...a) => globalThis.PiIdentityUI.t(s, ...a);
    const label = { memory: '记忆', skill: '技能', fact: '事实', preference: '偏好', correction: '纠错', failure: '失败经验', procedure: '流程',
        active: '启用', draft: '草稿', disabled: '停用', deleted: '已删除', saved: '已保存', pending: '待同步', failed: '失败', conflict: '版本冲突', skipped: '跳过',
        create: '新建', update: '更新', delete: '删除', restore: '恢复', enable: '启用', disable: '停用', undo: '撤销', consolidate: '整理合并' };
    const statusLabel = { ready: '就绪', pending: '待同步', missing: '缺失', disabled: '未启用', unsupported: '不支持', error: '错误' };
    const categories = ['fact', 'preference', 'correction', 'failure', 'procedure'];
    const operations = new Set(['create', 'update', 'delete', 'restore', 'enable', 'disable', 'undo', 'consolidate']);
    const readyRevision = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const rejected = error => [400, 403, 404, 413, 422, 429].includes(error?.status);
    const uuid = () => globalThis.crypto?.randomUUID?.() || `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    function create({ apiFetch, root, ui = {} }) {
        const U = globalThis.PiIdentityUI, { el, icon, chip, categoryChip, time, number, segmented, card } = U;
        root.classList.add('pi-knowledge-page');
        const node = (tag, text, cls) => el(tag, { text, class: cls });
        const button = (text, click, variant = 'secondary', options = {}) => U.button({ label: text, onClick: click, variant, ...options });
        const field = (name, control) => el('label', { class: 'pi-id-field' }, [el('span', { class: 'pi-id-field-label', text: name }), control]);
        const option = (value, text) => el('option', { value, text });
        const confirm = options => (ui.confirm || globalThis.PiProfileDialog?.confirm)?.(options) || Promise.resolve(false);
        const toast = text => ui.toast?.(text);
        let profile = '', kind = 'memory', target = 'memory', mode = 'entries', category = 'all', skillState = 'all';
        let query = '', offset = 0, serial = 0, active = false, deletedOnly = false, sessionScope = '', searchTimer;
        let snapshot = null, learning = null, selected = null, detail = null, draft = null, editing = false, reviewed = true;
        let busy = false, learningBusy = false, learningEpoch = 0, uncertain = null, learningUncertain = null, receipt = null, notice = '', conflict = false;
        let memoryFull = false, revealItem = null, revealEpoch = 0, detailReadError = null, injection;
        let proposalDrafts = new Map(), appliedGroups = new Set(), itemRevisions = new Map(), itemChecks = new Set();
        let documents = new Map(), stagedDocuments = new Map(), documentBusy = false, documentPreview = false;
        const documentReads = new Map();
        let viewStates = new Map(), savedProfile = null;
        const draftsByProfile = new Map();
        const base = () => `/api/pi/profiles/${encodeURIComponent(profile)}`;
        const current = (id, generation) => active && root.isConnected && profile === id && serial === generation;
        const original = () => detail?.item || selected;
        const bodyFor = item => item?.kind === 'skill' && item.content?.startsWith(`---\nname: ${item.name}\ndescription: ${item.description || ''}\n---\n`)
            ? item.content.slice(`---\nname: ${item.name}\ndescription: ${item.description || ''}\n---\n`.length) : item?.content || '';
        const viewKey = () => kind === 'skill' ? 'skill' : `memory:${target}`;
        const entryState = () => ({ selected, detail, draft, editing, reviewed, detailReadError });
        function rememberView() { viewStates.set(viewKey(), entryState()); }
        function restoreView() {
            ({ selected = null, detail = null, draft = null, editing = false, reviewed = true, detailReadError = null } = viewStates.get(viewKey()) || {});
        }
        function keep() {
            if (!profile) return;
            rememberView();
            draftsByProfile.set(profile, { kind, target, mode, category, skillState, query, offset, deletedOnly, sessionScope, viewStates,
                documents, stagedDocuments, proposalDrafts, appliedGroups, uncertain, learningUncertain, receipt, conflict, notice });
        }
        function entryDirty(state = entryState()) {
            const item = state.detail?.item || state.selected;
            return Boolean(state.draft && ['name', 'description', 'content', 'category', 'scope'].some(key =>
                state.draft[key] !== (key === 'content' ? bodyFor(item) : item?.[key] ?? (key === 'category' ? 'fact' : key === 'scope' ? 'profile' : ''))));
        }
        function dirty() {
            return entryDirty() || [...viewStates].some(([key, state]) => key !== viewKey() && entryDirty(state))
                || [...documents.values()].some(doc => doc.dirty) || stagedDocuments.size > 0
                || [...proposalDrafts.values()].some(value => value.content !== value.savedContent || value.category !== value.savedCategory);
        }
        function discardChanges() {
            viewStates.clear(); selected = detail = draft = null; editing = false; reviewed = true;
            for (const [key, doc] of documents) documents.set(key, { ...doc, content: doc.savedContent || '', dirty: false, reviewed: false });
            stagedDocuments.clear(); proposalDrafts.clear(); keep(); render();
        }
        const isBusy = () => busy || learningBusy || documentBusy;
        async function discard() {
            if (isBusy()) return false;
            if (!entryDirty()) return true;
            const id = profile, generation = serial;
            const accepted = await confirm({ title: t('放弃未保存的知识草稿？'), message: t('切换后，当前条目的未保存修改将丢失。'), accept: t('放弃修改'), cancelLabel: t('继续编辑') });
            return accepted && current(id, generation) && !isBusy();
        }
        function allowed(data, key, itemKind, item) {
            if (data?.status !== 'ready') return false;
            const c = data.capabilities;
            if (!c || typeof c !== 'object' || !operations.has(key) || c[itemKind] !== true || item?.readOnly || item?.truncated) return false;
            if (item?.scope === 'project') {
                if (!sessionScope) return false;
                const bySession = itemKind === 'memory' ? c.projectWritesBySession === true && ['create', 'update', 'delete', 'undo'].includes(key)
                    : c.projectSkillDeletesBySession === true && ['delete', 'undo'].includes(key);
                if (c.projectWrites !== true && !bySession) return false;
            }
            if (itemKind === 'memory' && ['enable', 'disable'].includes(key)) return false;
            const actions = c.operations?.[itemKind] || c.actions?.[itemKind] || c.operations || c.actions;
            return (!Array.isArray(actions) || actions.includes(key)) && (key !== 'update' || !item || item.state === 'active');
        }
        async function open(id, options = {}) {
            // A pending submission owns the current view, draft and snapshot: keep them until it settles.
            if (isBusy() && profile) { if (id === profile && !active) { active = true; render(); } return; }
            const changed = profile !== id;
            if (changed) {
                keep(); profile = id || ''; serial++; learningEpoch++; documentReads.clear();
                ({ kind = 'memory', target = 'memory', mode = 'entries', category = 'all', skillState = 'all', query = '', offset = 0,
                    deletedOnly = false, sessionScope = '', viewStates = new Map(), documents = new Map(), stagedDocuments = new Map(),
                    proposalDrafts = new Map(), appliedGroups = new Set(), uncertain = null, learningUncertain = null, receipt = null,
                    conflict = false, notice = '' } = draftsByProfile.get(profile) || {});
                snapshot = learning = null; injection = undefined; itemRevisions = new Map(); itemChecks = new Set(); memoryFull = false;
                restoreView();
            }
            active = true; savedProfile = ui.profile?.() || savedProfile;
            const nextKind = options.view === 'skills' || options.kind === 'skill' || options.drafts ? 'skill'
                : options.view === 'memory' || options.kind === 'memory' ? 'memory' : kind;
            const nextTarget = ['user', 'memory', 'project'].includes(options.target) ? options.target : target;
            if (nextKind !== kind || nextTarget !== target) { revealEpoch++; rememberView(); kind = nextKind; target = nextTarget; restoreView(); snapshot = null; offset = 0; }
            if (options.sessionId !== undefined) sessionScope = String(options.sessionId || '');
            if (options.mode) mode = options.mode === 'document' ? 'document' : 'entries';
            if (target === 'project') mode = 'entries';
            if (options.drafts) { skillState = 'draft'; deletedOnly = false; snapshot = null; offset = 0; }
            render();
            await Promise.all([load(), loadLearning(), kind === 'memory' && mode === 'document' ? ensureDocument(target) : Promise.resolve()]);
            if (options.proposals) root.querySelector('.pi-knowledge-proposals')?.scrollIntoView({ block: 'start' });
        }
        function close() { keep(); active = false; serial++; revealEpoch++; learningEpoch++; documentReads.clear(); clearTimeout(searchTimer); root.replaceChildren(); }
        async function refresh() {
            await Promise.all([load(), loadLearning(), kind === 'memory' && mode === 'document' ? refreshDocument(target) : Promise.resolve()]);
        }
        async function switchView(changes) {
            if (isBusy()) return;
            revealEpoch++; rememberView();
            if (changes.target) target = changes.target;
            if (changes.mode) mode = changes.mode;
            if (target === 'project') mode = 'entries';
            restoreView(); offset = 0; snapshot = null; render();
            await load(); if (kind === 'memory' && mode === 'document') await ensureDocument(target);
        }
        async function filter(changes) {
            if (isBusy()) return;
            Object.entries(changes).forEach(([key, value]) => { if (key === 'category') category = value; if (key === 'skillState') skillState = value; if (key === 'deletedOnly') deletedOnly = value; });
            offset = 0; await load();
        }
        async function load() {
            if (!profile || !active || busy) return;
            const generation = ++serial, id = profile;
            try {
                const params = new URLSearchParams({ kind, query, offset: String(offset), state: deletedOnly ? 'deleted' : kind === 'skill' && skillState === 'draft' ? 'draft' : 'present' });
                if (sessionScope) params.set('sessionId', sessionScope);
                if (kind === 'memory') { params.set('target', target); if (category !== 'all') params.set('category', category); }
                const data = await apiFetch(`${base()}/knowledge?${params}`);
                if (!current(id, generation)) return;
                if (data?.version !== 1 || !Array.isArray(data.items) || !Array.isArray(data.receipts)
                    || !Object.hasOwn(statusLabel, data.status) || data.revision !== null && typeof data.revision !== 'string') throw new Error(t('知识接口不兼容'));
                if (data.status === 'ready' && !data.items.length && !data.hasMore && offset > 0) { offset = Math.max(0, offset - 50); return load(); }
                snapshot = data;
                if (data.status === 'ready') for (const row of data.items) if (row?.id) itemRevisions.set(row.id, row.revision ?? null);
                if (selected && data.status === 'ready') {
                    const newer = data.items.find(row => row.id === selected.id);
                    if (newer && newer.revision !== selected.revision) {
                        selected = newer; detail = null; reviewed = false; detailReadError = null;
                        void fetchDetail(newer, generation);
                    } else if (newer) {
                        // The advisory recall count is outside the revision: refresh it in place
                        // without refetching the body or touching an open draft.
                        for (const held of [selected, detail?.item]) if (held && held.id === newer.id) {
                            if (newer.recall) held.recall = newer.recall; else delete held.recall;
                        }
                    }
                }
                const found = data.receipts.find(row => row.requestId === uncertain?.requestId);
                if (found) {
                    receipt = found;
                    if (['saved', 'pending'].includes(found.status)) {
                        if (['create', 'update'].includes(uncertain.operation)) {
                            const state = uncertain.viewKey === viewKey() ? entryState() : viewStates.get(uncertain.viewKey);
                            if (state && uncertain.draft === JSON.stringify(state.draft)) {
                                if (uncertain.viewKey === viewKey()) { draft = null; editing = false; selected = detail = null; rememberView(); }
                                else viewStates.delete(uncertain.viewKey);
                            }
                        }
                        if (uncertain.proposalGroup) { appliedGroups.add(uncertain.proposalGroup); proposalDrafts.delete(uncertain.proposalGroup); }
                    }
                    uncertain = null;
                }
                notice = uncertain ? t('提交结果未确认；请求 ID {0} 已保留，请勿重复提交。', uncertain.requestId)
                    : !reviewed ? t('保存版本已变化；先核对服务器正文与草稿。')
                        : conflict ? t('版本冲突；草稿已保留。刷新并核对服务器版本。')
                            : memoryFull ? t('记忆已满，新记忆会被拒绝。请整理合并后再试。') : '';
                render(); if (revealItem && data.status === 'ready') await revealLoaded();
            } catch (error) { if (current(id, generation)) { notice = t('读取失败：{0}', error.message); render(); } }
        }
        async function loadLearning() {
            if (!profile || !active) return;
            const id = profile, generation = ++learningEpoch;
            try {
                const data = await apiFetch(`${base()}/learning`);
                if (!active || id !== profile || generation !== learningEpoch) return;
                if (data?.version !== 1) throw new Error(t('学习接口不兼容'));
                learning = data; ui.setBadge?.('skills', data.drafts?.pending || null); render();
            } catch { if (active && id === profile && generation === learningEpoch) learning = null; }
            if (injection === undefined) await loadInjection();
        }
        async function loadInjection() {
            const id = profile, generation = learningEpoch;
            try {
                const data = await apiFetch(`${base()}/knowledge/injection${sessionScope ? `?${new URLSearchParams({ sessionId: sessionScope })}` : ''}`);
                if (id !== profile || generation !== learningEpoch || !active) return;
                injection = data?.version === 1 && typeof data.block === 'string' ? data : null;
            } catch { if (id === profile && generation === learningEpoch) injection = null; }
            if (active && id === profile) render();
        }
        async function fetchDetail(item, generation = serial) {
            const id = profile;
            try {
                const data = await apiFetch(`${base()}/knowledge/items/${encodeURIComponent(item.id)}`);
                if (!current(id, generation) || selected?.id !== item.id) return;
                if (data?.version !== 1 || data.status !== 'ready' || data.item?.id !== item.id) throw new Error(t('正文不可用，请刷新核对。'));
                detail = data;
                if (selected.revision !== data.item.revision) { selected = data.item; reviewed = false; }
                render();
            } catch (error) { if (current(id, generation) && selected?.id === item.id) { detailReadError = error.message; render(); } }
        }
        async function choose(item) {
            if (selected?.id === item.id && !editing) { selected = detail = null; render(); return; }
            if (!await discard()) return;
            selected = item; detail = draft = null; editing = false; reviewed = true; detailReadError = null; render();
            await fetchDetail(item);
        }
        async function edit(item) {
            if (item && (!detail || detail.item?.id !== item.id)) {
                const itemId = item.id;
                await choose(item);
                if (selected?.id !== itemId || detail?.item?.id !== itemId) return;
                item = original();
            }
            if (!await discard()) return;
            selected = item || null; if (!item) detail = null;
            editing = true; conflict = false; reviewed = true;
            draft = { name: item?.name || '', description: item?.description || '', content: bodyFor(item), category: item?.category || 'fact', scope: item?.scope || (target === 'project' && kind === 'memory' ? 'project' : 'profile') };
            render(); root.querySelector('.pi-knowledge-editor textarea')?.focus({ preventScroll: true });
        }
        async function reveal(itemId, itemKind, sessionId) {
            if (!itemId || isBusy()) return;
            rememberView(); kind = itemKind === 'skill' ? 'skill' : 'memory'; restoreView(); mode = 'entries';
            if (sessionId) sessionScope = String(sessionId);
            revealItem = { itemId, request: ++revealEpoch, kind }; query = ''; category = 'all'; skillState = 'all'; offset = 0;
            await revealLoaded();
        }
        async function revealLoaded() {
            if (!revealItem) return;
            const { itemId, request, kind: intended } = revealItem, id = profile;
            revealItem = null;
            try {
                const data = await apiFetch(`${base()}/knowledge/items/${encodeURIComponent(itemId)}`);
                // A later reveal, view change or close supersedes this response.
                if (!active || id !== profile || request !== revealEpoch || kind !== intended || data?.status !== 'ready' || data.item?.id !== itemId || (data.item.kind || intended) !== intended) return;
                const item = data.item;
                const nextTarget = item.scope === 'project' ? 'project' : item.target === 'user' ? 'user' : 'memory';
                if (kind === 'memory' && target !== nextTarget) { rememberView(); target = nextTarget; restoreView(); }
                if (!await discard()) return;
                selected = item; detail = data; draft = null; editing = false; reviewed = true; deletedOnly = item.state === 'deleted';
                await load(); render();
                root.querySelector('.pi-id-entry.is-open')?.scrollIntoView({ block: 'nearest' });
            } catch (error) { if (active && id === profile) { notice = error.message; render(); } }
        }
        async function mutate(operation, extra = {}) {
            const targetKind = extra.kind || original()?.kind || kind;
            const guarded = operation === 'undo' ? (extra.scope === 'project' ? { kind: targetKind, scope: 'project' } : null) : detail?.item || original();
            if (isBusy() || uncertain || !readyRevision(snapshot?.revision) || !allowed(snapshot, operation, targetKind, guarded)) return;
            if (operation === 'delete') {
                const profileId = profile, generation = serial, itemId = original()?.id;
                const accepted = await confirm({ title: t('删除此条目？'), message: t('删除后可从已删除记录中恢复。'), accept: t('删除条目'), cancelLabel: t('取消') });
                if (!accepted || !current(profileId, generation) || original()?.id !== itemId || busy || uncertain) return;
            }
            const item = original();
            const projectScope = (operation === 'undo' ? extra.scope : item?.scope || draft?.scope) === 'project';
            const input = { requestId: uuid(), expectedRevision: snapshot.revision, operation, kind: targetKind,
                ...(operation !== 'undo' && item ? { itemId: item.id, itemRevision: item.revision } : {}),
                ...(operation === 'undo' ? { receiptId: extra.receiptId } : {}),
                ...(projectScope ? { scope: 'project', sessionId: sessionScope } : {}) };
            if (operation === 'create' || operation === 'update') {
                Object.assign(input, { content: draft.content, scope: draft.scope });
                if (targetKind === 'skill') Object.assign(input, { name: draft.name.trim(), description: draft.description.trim() }); else { input.category = draft.category; if (draft.scope === 'profile') input.target = item?.target === 'user' ? 'user' : item?.target === 'memory' ? 'memory' : target === 'user' ? 'user' : 'memory'; }
                if (draft.scope === 'project') {
                    // The server derives the project directory from the verified session;
                    // this page never submits a client-side projectKey.
                    if (targetKind !== 'memory' || !sessionScope || snapshot?.capabilities?.projectWritesBySession !== true) {
                        notice = t('请选择助手范围；项目范围写入须由服务端提供已验证的项目标识。'); render(); return;
                    }
                    input.sessionId = sessionScope;
                }
            }
            await runMutation(input, () => { editing = false; draft = null; selected = detail = null; rememberView(); });
        }
        // One submission path: the receipt, conflicts and uncertain results are handled the
        // same way for single edits and for a consolidation batch.
        async function runMutation(input, saved, confirmation = {}) {
            const profileId = profile, generation = ++serial;
            let full = false; // Reload only for this submission's own rejection, so its notice is not replaced.
            const record = { requestId: input.requestId, operation: input.operation, draft: JSON.stringify(draft), viewKey: viewKey(), ...confirmation };
            busy = true; uncertain = record; notice = ''; render();
            try {
                const result = await apiFetch(`${base()}/knowledge/mutations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
                if (!current(profileId, generation)) return;
                if (result?.version !== 1 || result.receipt?.requestId !== input.requestId) throw new Error(t('回执未确认'));
                receipt = result.receipt; uncertain = null; conflict = false; if (snapshot && readyRevision(result.revision)) snapshot.revision = result.revision;
                if (['saved', 'pending'].includes(receipt.status)) { saved?.(); toast(t('已保存')); }
                notice = receipt.status === 'conflict' ? t('版本冲突；草稿已保留。刷新并核对最新正文。') : '';
            } catch (error) {
                if (current(profileId, generation)) {
                    if (error.status === 409 && (error.data?.code === 'memory-full' || error.code === 'memory-full')) {
                        uncertain = null; memoryFull = full = true; notice = t('记忆已满，新记忆会被拒绝。请整理合并后再试。');
                    } else if (error.status === 409) { uncertain = null; conflict = true; notice = t('版本冲突；草稿已保留。刷新并核对服务器版本。'); }
                    else if (error.status === 400 && (error.data?.code || error.code) === 'content-blocked') {
                        uncertain = null; notice = (error.data?.details?.kind || error.details?.kind) === 'secret'
                            ? t('内容疑似密钥或凭据，不能保存到记忆或技能。') : t('内容疑似提示词注入指令，不能保存到记忆或技能。');
                    } else if (rejected(error)) { uncertain = null; notice = t('提交被服务端拒绝：{0}，草稿已保留。', error.message); }
                    else { uncertain = record; notice = t('提交结果未确认：{0}。草稿与请求 ID {1} 已保留，勿重复提交。', error.message, input.requestId); }
                }
            } finally {
                busy = false;
                if (current(profileId, generation)) { render(); if (!uncertain && (receipt?.requestId === input.requestId || conflict || full)) void load(); }
                else if (active && root.isConnected) { render(); void load(); }
            }
        }
        // U2.1: apply one proposal group through the batched consolidate mutation. The
        // recorded item revisions and the current snapshot revision are both confirmed.
        async function consolidate(proposal, index) {
            const group = proposal?.groups?.[index];
            if (!group || !Array.isArray(group.items) || group.items.length < 2 || groupStale(group)
                || busy || uncertain || !readyRevision(snapshot?.revision) || !allowed(snapshot, 'consolidate', 'memory')) return;
            const merged = proposalDraft(proposal.id, index, group);
            const input = { requestId: uuid(), expectedRevision: snapshot.revision, operation: 'consolidate', kind: 'memory',
                target: proposal.target === 'user' ? 'user' : 'memory',
                items: group.items.map(row => ({ itemId: row.itemId, itemRevision: row.itemRevision })),
                content: merged.content, category: merged.category };
            await runMutation(input, () => { appliedGroups.add(groupKey(proposal.id, group)); proposalDrafts.delete(groupKey(proposal.id, group)); }, { proposalGroup: groupKey(proposal.id, group) });
        }
        // Keyed by the group's items, not its position: dismissing a group shifts the later indexes.
        const groupKey = (proposalId, group) => `${proposalId}:${(group?.items || []).map(row => row.itemId).join(',')}`;
        function proposalDraft(proposalId, index, group) {
            const key = groupKey(proposalId, group);
            if (!proposalDrafts.has(key)) proposalDrafts.set(key, { content: String(group.content || ''), category: group.category || 'fact', savedContent: String(group.content || ''), savedCategory: group.category || 'fact' });
            return proposalDrafts.get(key);
        }
        // A group goes stale when any recorded item revision no longer matches the current
        // snapshot, or the entry disappeared. Items on other pages are checked once by id.
        function groupStale(group) {
            return (group.items || []).some(row => itemRevisions.has(row.itemId) && itemRevisions.get(row.itemId) !== row.itemRevision);
        }
        function checkProposalItems(proposals) {
            const missing = [...new Set((proposals || []).flatMap(proposal => proposal.groups || [])
                .flatMap(group => group.items || []).map(row => row.itemId)
                .filter(itemId => typeof itemId === 'string' && !itemRevisions.has(itemId) && !itemChecks.has(itemId)))];
            if (!missing.length) return;
            for (const itemId of missing) itemChecks.add(itemId);
            const profileId = profile, generation = serial;
            void Promise.all(missing.map(itemId => apiFetch(`${base()}/knowledge/items/${encodeURIComponent(itemId)}`)
                .then(data => [itemId, data?.status === 'ready' && data.item ? data.item.revision ?? null : null])
                .catch(() => [itemId, undefined]))).then(rows => {
                if (!active || !root.isConnected || profileId !== profile) return;
                for (const [itemId, revision] of rows) {
                    if (revision === undefined) itemChecks.delete(itemId);
                    else itemRevisions.set(itemId, revision);
                }
                if (current(profileId, generation)) render();
            });
        }
        function proposalsSupported() { return Array.isArray(learning?.proposals) || learning?.capabilities?.actions?.includes('propose-consolidation'); }
        async function action(name, _jobId, extra = {}) {
            if (!['propose-consolidation', 'dismiss-proposal'].includes(name) || isBusy() || learningUncertain || !proposalsSupported()) return;
            const requestId = uuid(), id = profile, generation = learningEpoch;
            learningBusy = true; render();
            try {
                const result = await apiFetch(`${base()}/learning/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, action: name, ...extra }) });
                if (id !== profile) return;
                if (result?.version !== 1 || !Number.isSafeInteger(result.revision)) throw new Error(t('作业回执未确认'));
                if (generation === learningEpoch) learning = result; else void loadLearning();
                if (name === 'dismiss-proposal') {
                    const group = proposalDrafts;
                    for (const key of group.keys()) if (key.startsWith(`${extra.proposalId}:`)) group.delete(key);
                }
                toast(t(name === 'propose-consolidation' ? '整理建议生成中，请稍后刷新。' : '已忽略该整理建议。'));
            } catch (error) {
                if (id === profile) {
                    if (error.status !== 409 && !rejected(error)) learningUncertain = { requestId };
                    notice = error.status === 409 ? t('作业请求冲突；请刷新核对。') : rejected(error) ? t('作业请求被拒绝：{0}', error.message)
                        : t('作业结果未确认：{0}。刷新核对，不自动重试。', error.message);
                }
            } finally { learningBusy = false; if (active && id === profile) render(); }
        }
        const limitFor = (key, doc) => doc?.usage?.limit ?? (key === 'user' ? savedProfile?.memory?.userCharLimit ?? 8000 : savedProfile?.memory?.memoryCharLimit ?? 16000);
        const documentMessage = doc => doc.indexSynced === false ? t(doc.indexStatus === 'disabled' || doc.indexStatus === 'unsupported' ? '记忆检索尚未启用。' : '检索索引需要同步。') : '';
        function validDocument(data) { return data && typeof data.status === 'string' && (data.status !== 'ready' || typeof data.content === 'string' && typeof data.revision === 'string' && typeof data.profileRevision === 'string'); }
        async function ensureDocument(key) {
            const doc = documents.get(key);
            if (!doc?.dirty || doc.status === 'conflict') await refreshDocument(key);
        }
        async function refreshDocument(key = target) {
            if (isBusy() || key === 'project' || !active || !profile) return;
            const id = profile, previous = documents.get(key), initial = previous?.content, request = Symbol(key);
            documentReads.set(key, request);
            try {
                const data = await apiFetch(`${base()}/documents?target=${key}`, { cache: 'no-store' });
                if (!active || id !== profile || request !== documentReads.get(key) || previous?.content !== initial || documents.get(key) !== previous) return;
                if (!validDocument(data)) throw new Error(t('文档接口不兼容'));
                const proposed = stagedDocuments.get(key), content = proposed ?? (previous?.dirty ? previous.content : data.content ?? '');
                const pending = data.status === 'ready' && content !== data.content;
                documents.set(key, { ...data, savedContent: data.content ?? '', content, dirty: Boolean(pending || proposed !== undefined || previous?.dirty && data.status !== 'ready'),
                    ...(pending ? { serverContent: data.content ?? '', reviewed: false } : {}),
                    message: pending ? t('草稿已保留。请对照最新文档核对后再保存。') : documentMessage(data) });
                if (data.status === 'ready') stagedDocuments.delete(key);
            } catch (error) {
                if (active && id === profile && request === documentReads.get(key)) {
                    if (previous) previous.message = error.message;
                    else documents.set(key, { status: 'error', content: '', savedContent: '', dirty: false, message: error.message });
                }
            }
            if (active && id === profile) render();
        }
        async function saveDocument() {
            const key = target, state = documents.get(key), id = profile;
            if (!active || isBusy() || state?.status !== 'ready' || !state.dirty || state.uncertain || state.content.length > limitFor(key, state)
                || state.serverContent !== undefined && !state.reviewed) return;
            documentReads.delete(key); documentBusy = true; state.message = ''; render();
            try {
                const result = await apiFetch(`${base()}/documents`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ target: key, content: state.content, expectedRevision: state.revision, expectedProfileRevision: state.profileRevision }) });
                if (id !== profile) return;
                if (!validDocument(result) || typeof result.content !== 'string') throw new Error(t('文档回执未确认'));
                documents.set(key, { ...result, savedContent: result.content, content: result.content, dirty: false, message: documentMessage(result) });
                toast(t('文档已保存到服务器。')); snapshot = null;
            } catch (error) {
                if (id !== profile) return;
                if (error.data?.documentSaved === true && error.data.document) {
                    const doc = error.data.document;
                    documents.set(key, { ...doc, content: doc.content ?? state.content, savedContent: doc.content ?? state.content, indexStatus: 'pending', indexSynced: false,
                        dirty: false, message: t('文档已保存；检索索引需要同步。') });
                } else {
                    state.status = error.status === 409 ? 'conflict' : rejected(error) ? 'ready' : 'conflict';
                    state.uncertain = !rejected(error) && error.status !== 409;
                    state.message = error.status === 409 ? t('文档已变化。草稿已保留；请重新读取并核对。')
                        : rejected(error) ? t('文档未保存：{0}', error.message) : t('结果未确认；草稿已保留。请刷新核对。');
                }
            } finally { documentBusy = false; if (active && id === profile) render(); }
        }
        async function syncDocumentIndex() {
            const key = target, id = profile, previous = documents.get(key);
            if (!active || isBusy() || previous?.status !== 'ready' || previous.indexStatus !== 'pending' || previous.uncertain) return;
            documentReads.delete(key); documentBusy = true; render();
            try {
                const fresh = await apiFetch(`${base()}/documents?target=${key}`, { cache: 'no-store' });
                if (!validDocument(fresh) || fresh.status !== 'ready') throw new Error(t('文档尚不可用，请刷新核对。'));
                const result = await apiFetch(`${base()}/documents`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ target: key, content: fresh.content, expectedRevision: fresh.revision, expectedProfileRevision: fresh.profileRevision }) });
                if (id !== profile) return;
                if (!validDocument(result) || typeof result.content !== 'string') throw new Error(t('文档回执未确认'));
                const keepDraft = previous.dirty && previous.content !== result.content;
                documents.set(key, { ...result, savedContent: result.content, content: keepDraft ? previous.content : result.content, dirty: Boolean(keepDraft),
                    ...(keepDraft ? { serverContent: result.content, reviewed: false } : {}), message: documentMessage(result) });
                toast(t('检索索引已同步。'));
            } catch (error) {
                if (id === profile) {
                    previous.message = error.status === 409 ? t('文档已变化。草稿已保留；请重新读取并核对。') : error.message;
                    if (!rejected(error) && error.status !== 409) { previous.uncertain = true; previous.status = 'conflict'; }
                }
            } finally { documentBusy = false; if (active && id === profile) render(); }
        }
        function stageDocuments(input = {}) {
            if (isBusy()) return false;
            for (const key of ['user', 'memory']) if (typeof input[key] === 'string') {
                const doc = documents.get(key);
                if (doc) documents.set(key, { ...doc, content: input[key], dirty: input[key] !== doc.savedContent, reviewed: false });
                else stagedDocuments.set(key, input[key]);
            }
            keep(); if (active) render();
            return true;
        }
        function profileSaved(value) {
            savedProfile = value;
            // A fresh document read supplies the new profile revision without discarding local text.
            for (const [key, doc] of documents) {
                doc.status = 'conflict'; doc.reviewed = false;
                doc.message = t('身份设置已保存，请重新读取文档并核对草稿。');
                if (active) void refreshDocument(key);
            }
            if (active) { void load(); void loadLearning(); render(); }
        }
        function noticeBox(text, actions = [], tone = 'amber') {
            return el('div', { class: 'pi-id-notice', role: 'status', dataset: { tone } }, [icon('circle-info'),
                el('div', { class: 'pi-id-notice-body' }, [node('p', text), actions.length ? el('div', { class: 'pi-id-notice-actions' }, actions) : null])]);
        }
        function render() {
            if (!active || !profile) return;
            const focused = root.contains(document.activeElement) ? document.activeElement : null;
            const focusKey = focused?.dataset.focus, selection = focused && typeof focused.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd] : null;
            const openDetails = new Set([...root.querySelectorAll('details[open][data-detail]')].map(item => item.dataset.detail));
            root.replaceChildren();
            renderHead();
            if (kind === 'memory') renderMemory(); else renderSkills();
            for (const item of root.querySelectorAll('details[data-detail]')) if (openDetails.has(item.dataset.detail)) item.open = true;
            if (isBusy()) root.querySelectorAll('button,input,textarea,select').forEach(control => { control.disabled = true; });
            if (focusKey) {
                const replacement = [...root.querySelectorAll('[data-focus]')].find(item => item.dataset.focus === focusKey);
                if (replacement && !replacement.disabled) { replacement.focus({ preventScroll: true }); if (selection && replacement.setSelectionRange) replacement.setSelectionRange(...selection); }
            }
        }
        function renderHead() {
            root.dataset.view = kind === 'skill' ? 'skills' : 'memory';
            const actions = kind === 'memory' ? segmented({ label: t('显示方式'), value: mode, onChange: value => void switchView({ mode: value }),
                items: [{ id: 'entries', label: t('条目'), icon: 'list' }, { id: 'document', label: t('全文'), icon: 'file-lines', disabled: target === 'project' }] })
                : addButton();
            root.append(el('div', { class: 'pi-id-page-head' }, [el('div', {}, [node('h3', t(kind === 'memory' ? '记忆' : '技能')),
                node('p', t(kind === 'memory' ? '助手跨对话记住的信息。关于你的内容保存在 USER.md，其他长期信息保存在 MEMORY.md。'
                    : '此身份在协作中积累的可复用做法。新技能先作为草稿，审核后才会启用。'))]), actions]));
            const settingsAction = button(t('前往设定'), () => ui.navigate?.('persona'), 'quiet');
            if (savedProfile?.enabled === false) root.append(noticeBox(t('此身份已停用，启用后才能使用记忆与技能。'), [settingsAction]));
            else if (kind === 'memory' && savedProfile?.memory?.enabled === false) root.append(noticeBox(t('长期记忆未启用：助手不会读取或写入这些内容。'), [settingsAction]));
            else if (kind === 'skill' && savedProfile?.skills?.learnedEnabled === false) root.append(noticeBox(t('已学习技能未启用：助手暂时不会使用这些技能。'), [settingsAction]));
        }
        const projectWritable = () => Boolean(sessionScope) && snapshot?.capabilities?.projectWritesBySession === true;
        function addButton() {
            const item = button(t(kind === 'skill' ? '新建技能' : '新建'), () => void edit(null), 'primary', { icon: 'plus', className: 'pi-knowledge-add' });
            item.disabled = isBusy() || !!uncertain || !readyRevision(snapshot?.revision) || !allowed(snapshot, 'create', kind)
                || kind === 'memory' && target === 'project' && !projectWritable();
            return item;
        }
        function renderProblems() {
            if (notice) root.append(noticeBox(notice, [button(t('刷新核对'), () => void load(), 'ghost')]));
            if (snapshot && snapshot.status !== 'ready') root.append(noticeBox(t('存储状态：{0}', t(statusLabel[snapshot.status] || snapshot.status)),
                [button(t('刷新'), () => void refresh(), 'ghost'), ...(['disabled', 'unsupported'].includes(snapshot.status) ? [button(t('前往设定'), () => ui.navigate?.('persona'), 'quiet')] : [])]));
            if (uncertain) root.append(noticeBox(t('提交结果未确认；请求 ID {0} 已保留，请勿重复提交。', uncertain.requestId),
                [button(t('刷新回执核对'), () => void load(), 'quiet')]));
            if (learningUncertain) root.append(noticeBox(t('作业请求 {0} 结果未确认；请先核对作业列表，勿重复提交。', learningUncertain.requestId),
                [button(t('前往学习'), () => ui.navigate?.('learning'), 'quiet'), button(t('已核对作业列表'), () => { learningUncertain = null; render(); }, 'ghost')]));
            if (receipt?.kind === kind) {
                const actions = receipt.undoable && receipt.id && allowed(snapshot, 'undo', receipt.kind, receipt.scope === 'project' ? { kind: receipt.kind, scope: 'project' } : null)
                    ? [button(t('撤销'), () => void mutate('undo', { receiptId: receipt.id, kind: receipt.kind, scope: receipt.scope }), 'ghost')] : [];
                const text = [t(label[receipt.operation] || receipt.operation), t(label[receipt.status] || receipt.status),
                    receipt.indexStatus === 'pending' && t('索引待同步'), receipt.activation === 'reload-required' && t('运行中的线程需重新打开'),
                    receipt.activation === 'next-turn' && t('下次对话可用，模型是否遵守无法保证')].filter(Boolean).join(' · ');
                root.append(el('div', { class: 'pi-knowledge-receipt' }, [chip(text, receipt.status === 'saved' ? 'green' : 'amber'), ...actions]));
            }
        }
        function renderMemory() {
            const counts = snapshot?.counts?.memory;
            const targets = segmented({ label: t('记忆范围'), className: 'is-fill', value: target, onChange: value => void switchView({ target: value }),
                items: [{ id: 'user', label: t('关于你'), hint: 'USER', icon: 'user', count: counts?.user }, { id: 'memory', label: t('长期记忆'), hint: 'MEMORY', icon: 'brain', count: counts?.memory },
                    { id: 'project', label: t('项目记忆'), icon: 'folder', count: counts?.project }] });
            const add = mode === 'entries' ? addButton() : null;
            if (add) { add.classList.add('pi-id-btn-collapsible'); add.setAttribute('aria-label', add.textContent); add.title = add.textContent; }
            root.append(el('div', { class: 'pi-knowledge-target-row' }, [targets, add]));
            if (target !== 'project') {
                const usage = snapshot?.usage?.[target];
                if (usage && Number.isFinite(usage.chars) && Number.isFinite(usage.limit)) {
                    const merge = usage.chars >= usage.limit * .8 && proposalsSupported() ? button(t('整理合并'), () => void action('propose-consolidation', undefined, { target }), 'quiet', { icon: 'object-group', disabled: !!learningUncertain }) : null;
                    root.append(el('div', { class: 'pi-knowledge-usage' }, [U.meter({ value: usage.chars, max: usage.limit, label: `${target.toUpperCase()}.md`, valueText: t('{0} / {1} 字符', number(usage.chars), number(usage.limit)) }), merge]));
                    if (usage.chars >= usage.limit) root.append(noticeBox(t('已满，新内容会被拒绝'), [], 'danger'));
                }
            } else if (!projectWritable()) root.append(noticeBox(t('项目记忆需要已验证的线程。请从对应对话的“本项目记忆”进入。')));
            if (mode === 'document') { renderDocument(); return; }
            renderProposals(); renderToolbar(); renderProblems();
            if (editing && !selected) root.append(renderEditor());
            renderEntries(); renderInjection();
        }
        function renderToolbar() {
            const search = el('input', { class: 'pi-id-input', type: 'search', value: query, maxLength: 200, placeholder: t(kind === 'memory' ? '搜索记忆' : '搜索技能'),
                'aria-label': t(kind === 'memory' ? '搜索记忆' : '搜索技能'), dataset: { focus: 'search' } });
            search.oninput = () => { query = search.value; clearTimeout(searchTimer); searchTimer = setTimeout(() => { offset = 0; void load(); }, 300); };
            const filters = kind === 'memory' ? segmented({ label: t('类别'), className: 'pi-knowledge-category-filter', value: category, onChange: value => void filter({ category: value }),
                items: [{ id: 'all', label: t('全部') }, ...categories.map(id => ({ id, label: U.categoryLabel(id) }))] })
                : segmented({ label: t('技能状态'), value: skillState, onChange: value => void filter({ skillState: value, deletedOnly: false }),
                    items: [{ id: 'all', label: t('全部') }, { id: 'active', label: t('启用') }, { id: 'draft', label: t('草稿'), count: learning?.drafts?.pending ?? snapshot?.counts?.skill?.draft }, { id: 'disabled', label: t('停用') }] });
            root.append(el('div', { class: 'pi-id-toolbar' }, [el('label', { class: 'pi-id-search' }, [icon('magnifying-glass'), search]), filters,
                button(t('回收站'), () => void filter({ deletedOnly: !deletedOnly }), 'ghost', { icon: 'trash-can', attrs: { 'aria-pressed': String(deletedOnly) }, className: 'pi-knowledge-trash' })]));
        }
        // Same grouping as the server: project scope first, then USER; everything else (including legacy failures) is MEMORY.
        const memoryGroup = item => item.scope === 'project' ? 'project' : item.target === 'user' ? 'user' : 'memory';
        function visibleItems() {
            const rows = (snapshot?.items || []).filter(item => item.kind === kind && (deletedOnly ? item.state === 'deleted' : item.state !== 'deleted'));
            if (selected && selected.kind === kind && !rows.some(item => item.id === selected.id) && (deletedOnly ? selected.state === 'deleted' : selected.state !== 'deleted')) rows.unshift(selected);
            return rows.filter(item => kind === 'skill' ? skillState === 'all' || item.state === skillState
                : memoryGroup(item) === target && (category === 'all' || item.category === category));
        }
        function renderEntries() {
            if (!snapshot) { root.append(U.empty({ icon: kind === 'memory' ? 'brain' : 'toolbox', title: t('正在读取…'), compact: true })); return; }
            if (snapshot.status !== 'ready') return;
            const items = visibleItems(), list = el('div', { class: kind === 'skill' ? 'pi-knowledge-skills' : 'pi-id-entries' });
            for (const item of items) list.append(renderEntry(item));
            if (!items.length) list.append(U.empty({ icon: deletedOnly ? 'trash-can' : kind === 'skill' ? 'toolbox' : 'brain', title: t(deletedOnly ? '回收站是空的' : kind === 'skill' ? '还没有技能' : '这里还没有记忆'),
                text: t(query || category !== 'all' || skillState !== 'all' ? '试试其他筛选条件。' : deletedOnly ? '删除的条目会保留在这里，方便恢复。' : '从一条值得记住的内容开始。'), compact: true }));
            root.append(list);
            if (offset > 0 || snapshot.hasMore) root.append(el('div', { class: 'pi-knowledge-pages' }, [
                button(t('上一页'), () => { offset = Math.max(0, offset - 50); void load(); }, 'ghost', { size: 'sm', disabled: offset === 0 }),
                node('span', t('第 {0} 页', Math.floor(offset / 50) + 1), 'pi-id-help'),
                button(t('下一页'), () => { offset += snapshot.items.length || 50; void load(); }, 'ghost', { size: 'sm', disabled: !snapshot.hasMore })]));
        }
        function entryActions(item, compact = false) {
            const actions = [];
            for (const [operation, show, actionIcon] of [['update', item.state === 'active', 'pen'], ['enable', item.state === 'disabled' || item.state === 'draft', 'check'],
                ['disable', item.state === 'active', 'pause'], ['delete', item.state !== 'deleted', 'trash-can'], ['restore', item.state === 'deleted', 'rotate-left']]) {
                if (!show || !allowed(snapshot, operation, item.kind, item)) continue;
                if (compact && !['update', 'delete', 'restore'].includes(operation)) continue;
                actions.push(button(t(operation === 'update' ? '编辑' : label[operation]), async () => {
                    if (operation === 'update') return edit(item);
                    if (selected?.id !== item.id || detail?.item?.id !== item.id) { await choose(item); if (!detail || selected?.id !== item.id) return; }
                    void mutate(operation);
                }, operation === 'delete' && !compact ? 'danger' : compact ? 'ghost' : 'secondary', { icon: actionIcon, iconOnly: compact, size: 'sm' }));
            }
            return actions;
        }
        // Advisory counter from verified memory_search results; absent until a search finds the entry.
        const recalled = item => item?.kind === 'memory' && item.state !== 'deleted' && Number.isSafeInteger(item.recall?.hits) && item.recall.hits > 0;
        const recallNote = item => t('记忆搜索找到这条 {0} 次，最近一次 {1}。USER／MEMORY 全文每轮都会提供给助手，这里只统计助手主动搜索找到它的次数；内容修改后重新计数。',
            item.recall.hits, item.recall.lastHitAt || '—');
        function renderEntry(row) {
            const open = selected?.id === row.id, item = open ? original() : row;
            const meta = el('span', { class: 'pi-id-entry-meta' }, [item.kind === 'memory' ? categoryChip(item.category) : chip(t(label[item.state] || item.state), item.state === 'active' ? 'green' : item.state === 'draft' ? 'amber' : 'neutral'),
                item.scope === 'project' && chip(t('项目')), (item.readOnly || item.truncated) && chip(t('只读')),
                recalled(item) && chip(t('检索命中 {0} 次', item.recall.hits), 'accent', { icon: 'magnifying-glass', className: 'pi-knowledge-recall', title: recallNote(item) }),
                time(item.updatedAt)]);
            const main = el('button', { class: 'pi-id-entry-main', type: 'button', 'aria-expanded': String(open), dataset: { itemId: item.id }, on: { click: () => void choose(row) } },
                item.kind === 'skill' ? [el('span', { class: 'pi-knowledge-skill-head' }, [el('span', { class: 'pi-knowledge-skill-icon', dataset: { tone: item.state === 'active' ? 'accent' : item.state === 'draft' ? 'amber' : 'neutral' } }, [icon('wand-magic-sparkles')]), node('span', item.name, 'pi-id-entry-title pi-knowledge-skill-name')]), node('span', item.description || '', 'pi-id-entry-text'), meta]
                    : [node('span', open && detail ? item.content : row.content || '', 'pi-id-entry-text'), meta]);
            const entry = el('article', { class: `pi-id-entry${open ? ' is-open' : ''}${item.state === 'deleted' ? ' is-deleted' : ''}`, dataset: { itemId: item.id } },
                [main, !open && el('div', { class: 'pi-id-entry-actions' }, entryActions(item, true))]);
            if (open) {
                const body = el('div', { class: 'pi-id-entry-body' });
                if (!detail) body.append(noticeBox(detailReadError || t('正在读取正文…'), detailReadError ? [button(t('刷新'), () => void fetchDetail(row), 'ghost')] : []));
                else {
                    // Display only: a hand-edited front matter that bodyFor cannot strip would otherwise render as a rule and heading.
                    if (item.kind === 'skill' && !editing) body.append(U.markdown(el('div'), bodyFor(item).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')));
                    if (editing) body.append(renderEditor());
                    else body.append(el('div', { class: 'pi-id-toolbar' }, [...entryActions(item), button(t('收起详情'), () => void choose(row), 'ghost', { size: 'sm' })]));
                    if (!editing && recalled(item)) body.append(node('small', recallNote(item), 'pi-id-help pi-knowledge-recall-note'));
                    const receipts = (snapshot?.receipts || []).filter(receipt => receipt.itemId === item.id);
                    if (receipts.length) body.append(renderReceipts(receipts, item));
                    body.append(renderTechnical(item));
                }
                entry.append(body);
            }
            return entry;
        }
        function renderTechnical(item) {
            const values = [[t('版本'), item.revision], [t('来源线程'), item.source?.sessionId], [t('原生记录'), item.source?.entryId],
                [t('目录范围'), item.projectKey], [t('条目 ID'), item.id]];
            return el('details', { class: 'pi-id-details', dataset: { detail: `tech:${item.id}` } }, [node('summary', t('技术详情')),
                el('dl', {}, values.filter(([, value]) => value).flatMap(([key, value]) => [node('dt', key), node('dd', value)]))]);
        }
        function renderReceipts(receipts, item) {
            return el('details', { class: 'pi-id-details', dataset: { detail: `receipts:${item.id}` } }, [node('summary', t('近期变更')),
                el('ol', { class: 'pi-id-timeline' }, receipts.map(receipt => el('li', {}, [el('span', { class: 'pi-id-timeline-icon', dataset: { tone: 'blue' } }, [icon('clock-rotate-left')]),
                    el('div', { class: 'pi-id-timeline-copy' }, [node('span', [t(label[receipt.operation] || receipt.operation), t(label[receipt.status] || receipt.status)].join(' · ')), el('small', {}, [time(receipt.at)])]),
                    receipt.undoable && receipt.afterRevision === item.revision && allowed(snapshot, 'undo', receipt.kind, item)
                        && button(t('撤销'), () => void mutate('undo', { receiptId: receipt.id, kind: receipt.kind, scope: item.scope }), 'ghost', { size: 'sm' })]))) ]);
        }
        function categorySelect(value, onChange, focus) {
            const select = el('select', { class: 'pi-id-select', 'aria-label': t('类别'), dataset: { focus } }, categories.map(id => option(id, U.categoryLabel(id))));
            select.value = value; select.onchange = () => onChange(select.value); return select;
        }
        function renderEditor() {
            const form = el('form', { class: 'pi-knowledge-editor' });
            if (!selected) form.classList.add('pi-id-card');
            form.append(node('h4', t(selected ? '编辑{0}' : '新建{0}', t(label[kind]))));
            if (kind === 'skill') {
                const name = el('input', { class: 'pi-id-input', value: draft.name, required: true, maxLength: snapshot?.capabilities?.skillNameMaxLength || 64, pattern: '[a-z][a-z0-9-]{0,63}', dataset: { focus: 'entry-name' } });
                name.oninput = () => { draft.name = name.value; };
                const description = el('input', { class: 'pi-id-input', value: draft.description, maxLength: snapshot?.capabilities?.skillDescriptionMaxLength || 1024, dataset: { focus: 'entry-description' } });
                description.oninput = () => { draft.description = description.value; };
                form.append(field(t('名称'), name), node('small', t('名称以小写字母开头，最多64位小写字母、数字或连字符'), 'pi-id-help'), field(t('描述'), description), node('small', t('Pi 只按描述决定何时使用技能：写清用途，以及会触发它的说法、报错或场景'), 'pi-id-help'));
            }
            const content = el('textarea', { class: 'pi-id-textarea', required: true, rows: kind === 'skill' ? 10 : 4, maxLength: snapshot?.capabilities?.maxContentLength || 65536,
                value: draft.content, 'aria-label': t('正文'), dataset: { focus: 'entry-content' } });
            content.oninput = () => { draft.content = content.value; };
            form.append(field(t('正文'), content));
            if (kind === 'memory') {
                form.append(field(t('类别'), categorySelect(draft.category, value => { draft.category = value; }, 'entry-category')),
                    node('small', t('将保存到：{0}', target === 'project' ? t('项目记忆') : target === 'user' ? t('关于你（USER.md）') : t('长期记忆（MEMORY.md）')), 'pi-id-help'));
            }
            if (selected) {
                form.append(el('details', { class: 'pi-id-details', dataset: { detail: 'compare' } }, [node('summary', t('对照已保存版本')), node('pre', original()?.content || '', 'pi-knowledge-raw')]));
                if (!reviewed) {
                    const check = el('input', { type: 'checkbox', checked: false, on: { change: event => {
                        reviewed = event.target.checked;
                        form.querySelector('button[type=submit]').disabled = !reviewed || isBusy() || !!uncertain || !readyRevision(snapshot?.revision)
                            || !allowed(snapshot, 'update', kind, original()) || detail?.item?.revision !== selected.revision;
                    } } });
                    form.append(el('label', { class: 'pi-knowledge-check' }, [check, t('已核对服务器最新版本与草稿')]));
                }
            }
            const save = button(t('保存'), undefined, 'primary', { type: 'submit', icon: 'check' });
            save.disabled = isBusy() || !!uncertain || !readyRevision(snapshot?.revision) || !allowed(snapshot, selected ? 'update' : 'create', kind, original())
                || !reviewed || draft.scope === 'project' && !projectWritable() || !!selected && detail?.item?.revision !== selected.revision;
            form.append(el('div', { class: 'pi-id-toolbar' }, [save, button(t('取消'), async () => { if (!await discard()) return; editing = false; draft = null; rememberView(); render(); }, 'ghost')]));
            form.onsubmit = event => { event.preventDefault(); if (!save.disabled && form.reportValidity()) void mutate(selected ? 'update' : 'create'); };
            return form;
        }
        function renderProposals() {
            if (target === 'project') return;
            const proposals = (Array.isArray(learning?.proposals) ? learning.proposals : []).filter(proposal => (proposal.target === 'user' ? 'user' : 'memory') === target);
            checkProposalItems(proposals);
            const groups = proposals.flatMap(proposal => (proposal.groups || []).map((group, index) => ({ proposal, group, index })))
                .filter(row => row.group && !appliedGroups.has(groupKey(row.proposal.id, row.group)));
            if (!groups.length) return;
            const children = groups.map(({ proposal, group, index }) => {
                const merged = proposalDraft(proposal.id, index, group), stale = groupStale(group);
                const content = el('textarea', { class: 'pi-id-textarea', rows: 3, value: merged.content, disabled: stale,
                    maxLength: snapshot?.capabilities?.maxContentLength || 65536, 'aria-label': t('合并后正文'), dataset: { focus: `proposal:${proposal.id}:${index}` } });
                content.oninput = () => { merged.content = content.value; };
                const apply = button(t('应用'), () => void consolidate(proposal, index), 'primary', { size: 'sm', disabled: stale || isBusy() || !!uncertain || !readyRevision(snapshot?.revision) || !allowed(snapshot, 'consolidate', 'memory') });
                return el('div', { class: 'pi-knowledge-proposal' }, [
                    el('div', { class: 'pi-knowledge-proposal-sources' }, [node('strong', t('原条目')),
                        ...(group.items || []).map(item => el('p', {}, [node('span', String(item.preview || '').slice(0, 160) || t('（无预览）')), item.category && categoryChip(item.category)]))]),
                    el('div', { class: 'pi-knowledge-proposal-draft' }, [stale && noticeBox(t('已过期：条目版本已变化或已不存在，请重新生成方案。'), [], 'danger'),
                        field(t('合并后正文'), content), field(t('类别'), categorySelect(merged.category, value => { merged.category = value; }, `proposal-category:${proposal.id}:${index}`)),
                        el('div', { class: 'pi-id-toolbar' }, [apply, button(t('忽略'), () => void action('dismiss-proposal', undefined, { proposalId: proposal.id, groupIndex: index }), 'ghost', { size: 'sm', disabled: !!learningUncertain })])])]);
            });
            root.append(card({ title: t('整理建议'), icon: 'object-group', className: 'pi-knowledge-proposals' }, children));
        }
        function renderInjection() {
            if (!injection) return;
            const stats = injection.profile || {};
            root.append(el('details', { class: 'pi-id-card pi-knowledge-injection', dataset: { detail: 'injection' } }, [node('summary', t('助手下一轮会读到什么')),
                node('p', t('身份记忆：{0} 条 / {1} 字', number(stats.entries), number(stats.chars)), 'pi-id-help'),
                node('pre', injection.block || '', 'pi-knowledge-raw'), injection.truncated && node('p', t('已截断，仅显示部分内容'), 'pi-id-help'),
                node('p', t('注入不代表模型一定遵守。'), 'pi-id-help')]));
        }
        function renderSkills() {
            renderToolbar(); renderProblems();
            const count = learning?.drafts?.pending ?? snapshot?.counts?.skill?.draft;
            if (count > 0 && skillState === 'all' && !deletedOnly) {
                const rows = (snapshot?.items || []).filter(item => item.kind === 'skill' && item.state === 'draft');
                root.append(card({ title: t('待审核草稿 · {0}', number(count)), icon: 'pen-ruler', actions: [button(t('查看全部草稿'), () => void filter({ skillState: 'draft' }), 'quiet', { size: 'sm' })], className: 'pi-knowledge-drafts' },
                    rows.length ? rows.map(item => el('div', { class: 'pi-knowledge-draft-row' }, [el('div', { class: 'pi-knowledge-draft-copy' }, [node('strong', item.name, 'pi-knowledge-skill-name'), item.description && node('span', item.description, 'pi-id-help')]), el('div', { class: 'pi-id-toolbar' }, [
                        button(t('预览'), () => void choose(item), 'ghost', { size: 'sm' }), ...entryActions(item).filter(action => !action.textContent.includes(t('编辑')))])]))
                        : [node('p', t('新技能需要审核后才会启用。'), 'pi-id-help')]));
            }
            if (editing && !selected) root.append(renderEditor());
            renderEntries();
            root.append(card({ icon: 'puzzle-piece' }, [el('div', { class: 'pi-knowledge-installed' }, [node('p', t('Pi 原生安装的技能在「扩展 → 已安装」中管理。'), 'pi-id-help'),
                button(t('前往扩展'), () => {
                    if (globalThis.PiWorkspaceRoute?.navigate) globalThis.PiWorkspaceRoute.navigate('extensions', { tab: 'installed', resourceType: 'skills' });
                    else ui.openSettings?.({ tab: 'installed' });
                }, 'ghost', { icon: 'arrow-up-right-from-square' })])]));
        }
        function renderDocument() {
            const state = documents.get(target);
            if (!state) { root.append(U.empty({ icon: 'file-lines', title: t('正在读取…'), compact: true })); return; }
            const key = target, limit = limitFor(key, state), editable = state.status === 'ready' || state.status === 'conflict';
            const savebar = U.createSaveBar({ saveLabel: t('保存文档'), onSave: () => void saveDocument(), onDiscard: async () => {
                if (isBusy()) return;
                if (!await confirm({ title: t('放弃未保存的修改？'), message: t('当前文档的未保存修改将丢失。'), accept: t('放弃修改'), cancelLabel: t('继续编辑') })) return;
                state.content = state.savedContent || ''; state.dirty = false; state.reviewed = false; render();
            }, hint: t('保存后，新建或重新打开的线程会使用新设置') });
            const update = () => {
                savebar.set({ dirty: state.dirty, saving: documentBusy, canSave: state.status === 'ready' && !state.uncertain && state.content.length <= limit
                    && (state.serverContent === undefined || state.reviewed), visible: state.dirty || documentBusy });
            };
            if (state.message) root.append(noticeBox(state.message, state.status === 'conflict' ? [button(t('从服务器重新读取'), () => void refreshDocument(key), 'quiet')] : []));
            if (!editable) {
                root.append(noticeBox(t(state.status === 'disabled' ? '长期记忆未启用：助手不会读取或写入这些内容。'
                    : state.status === 'unsupported' ? '此服务尚未安装记忆组件。' : '文档尚不可用，请刷新核对。'),
                [button(t('从服务器重新读取'), () => void refreshDocument(key), 'ghost'), button(t('前往设定'), () => ui.navigate?.('persona'), 'quiet')]));
                return;
            }
            savebar.element.classList.add('pi-knowledge-document-savebar');
            const count = node('span', t('{0} / {1} 字符', number(state.content.length), number(limit)), 'pi-id-editor-count');
            count.classList.toggle('is-over', state.content.length > limit);
            const textarea = el('textarea', { class: 'pi-id-editor-text', value: state.content, 'aria-label': `${key.toUpperCase()}.md`, spellcheck: 'false', disabled: state.status !== 'ready', dataset: { focus: `document:${key}` } });
            textarea.oninput = () => {
                state.content = textarea.value; state.dirty = state.content !== state.savedContent; state.reviewed = false;
                const check = root.querySelector('.pi-knowledge-document-reviewed'); if (check) check.checked = false;
                count.textContent = t('{0} / {1} 字符', number(state.content.length), number(limit)); count.classList.toggle('is-over', state.content.length > limit); update();
            };
            const preview = U.markdown(el('div', { class: 'pi-id-editor-preview' }), state.content);
            root.append(el('div', { class: 'pi-id-editor' }, [el('div', { class: 'pi-id-editor-bar' }, [el('div', { class: 'pi-id-editor-tools' }, [
                segmented({ label: t('编辑器'), value: documentPreview ? 'preview' : 'edit', items: [{ id: 'edit', label: t('编辑'), icon: 'pen' }, { id: 'preview', label: t('预览'), icon: 'eye' }],
                    onChange: value => { documentPreview = value === 'preview'; render(); } }),
                button(t('从服务器重新读取'), () => void refreshDocument(key), 'ghost', { icon: 'rotate', iconOnly: true })]), count]), documentPreview ? preview : textarea]));
            root.append(node('p', t('全文模式直接编辑 USER.md / MEMORY.md；条目之间用单独一行的 § 分隔。'), 'pi-id-help'));
            if (state.serverContent !== undefined) {
                const check = el('input', { type: 'checkbox', class: 'pi-knowledge-document-reviewed', checked: state.reviewed, on: { change: event => { state.reviewed = event.target.checked; update(); } } });
                root.append(noticeBox(t('请先核对服务器最新内容，再保存草稿。'), [
                    el('details', { class: 'pi-id-details', dataset: { detail: `server:${key}` } }, [node('summary', t('查看服务器最新内容')), node('pre', state.serverContent, 'pi-knowledge-raw')])]),
                el('label', { class: 'pi-knowledge-check' }, [check, t('已核对服务器最新内容')]));
            }
            if (state.indexStatus === 'pending') root.append(noticeBox(t('文档已保存；检索索引需要同步。'), [button(t('同步检索索引'), () => void syncDocumentIndex(), 'quiet', { className: 'pi-knowledge-document-sync' })]));
            root.append(savebar.element); update();
        }
        root.addEventListener('keydown', event => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && kind === 'memory' && mode === 'document') {
                event.preventDefault(); void saveDocument();
            }
        });
        return { open, close, refresh, reveal, dirty, discardChanges, busy: isBusy, stageDocuments, profileSaved };
    }
    globalThis.PiProfileKnowledge = Object.freeze({ create });
})();
