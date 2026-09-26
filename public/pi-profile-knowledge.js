/* Server-backed profile knowledge; no browser copy of the authoritative data. */
(() => {
    'use strict';
    const t = (s, ...a) => globalThis.PiI18n?.t(s, ...a) || s;
    const node = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
    const button = (text, click, cls = 'settings-secondary-button') => { const e = node('button', text, cls); e.type = 'button'; e.onclick = click; return e; };
    const field = (name, control) => { const e = node('label', name); e.append(control); return e; };
    const option = (value, label) => { const e = node('option', label); e.value = value; return e; };
    const label = { memory: '记忆', skill: '已学习技能', fact: '事实', preference: '偏好', correction: '纠错', failure: '失败经验', procedure: '流程',
        active: '启用', draft: '草稿', disabled: '停用', deleted: '已删除', saved: '已保存', pending: '待同步', failed: '失败', conflict: '版本冲突', skipped: '跳过',
        create: '新建', update: '更新', delete: '删除', restore: '恢复条目', enable: '启用', disable: '停用', undo: '撤销' };
    const statusLabel = { ready: '就绪', pending: '待同步', missing: '缺失', disabled: '未启用', unsupported: '不支持', error: '错误' };
    const healthLabel = { ok: '学习正常', off: '学习已关闭', 'needs-model': '缺少学习模型配置', 'quota-exhausted': '今日学习额度已用完', failing: '最近学习连续失败', unavailable: '学习当前不可用' };
    const healthTone = { ok: 'ok', off: 'off', 'needs-model': 'warn', 'quota-exhausted': 'warn', failing: 'bad', unavailable: 'bad' };
    const purposeLabel = { 'memory-correction': '纠错模型', 'memory-review': '复盘模型', 'memory-extraction': '提炼模型' };
    const uuid = () => globalThis.crypto?.randomUUID?.() || `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const jobLabel = { queued: '排队中', running: '运行中', 'waiting-config': '等待模型配置', cancelling: '取消中', cancelled: '已取消', completed: '已完成',
        failed: '失败', uncertain: '待核对', skipped: '已跳过', manual: '手动复盘', periodic: '周期复盘', correction: '纠错识别',
        review: '复盘', extraction: '候选提取' };
    const operations = new Set(['create', 'update', 'delete', 'restore', 'enable', 'disable', 'undo']);
    const allowed = (snapshot, key, kind, item) => {
        if (snapshot?.status !== 'ready') return false;
        const c = snapshot.capabilities;
        if (!c || typeof c !== 'object') return false;
        if (operations.has(key)) {
            if (c[kind] !== true || item?.readOnly || item?.truncated || item?.scope === 'project' && c.projectWrites !== true) return false;
            if (kind === 'memory' && ['enable', 'disable'].includes(key)) return false;
            const actions = c.operations?.[kind] || c.actions?.[kind] || c.operations || c.actions;
            if (Array.isArray(actions) && !actions.includes(key)) return false;
            return key !== 'update' || !item || item.state === 'active';
        }
        const actions = c.actions || c.operations;
        return Array.isArray(actions) && actions.includes(key) || c[key] === true;
    };
    const readyRevision = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const rejected = error => [400, 403, 404, 413, 422, 429].includes(error?.status);
    function create({ apiFetch, root }) {
        let profile = '', kind = 'skill', query = '', offset = 0, serial = 0, active = false;
        let snapshot = null, learning = null, learningDraft = null, selected = null, detail = null, draft = null, editing = false, reviewed = true;
        let busy = false, learningBusy = false, learningEpoch = 0, uncertain = null, learningUncertain = null, receipt = null, notice = '', conflict = false;
        let memoryFull = false, revealItem = null, modelCatalog = null, legacyModel = null;
        const draftsByProfile = new Map();
        const base = () => `/api/pi/profiles/${encodeURIComponent(profile)}`;
        const current = (profileId, generation) => active && root.isConnected && profile === profileId && serial === generation;
        const original = () => detail?.item || selected;
        const bodyFor = item => item?.kind === 'skill' && item.content?.startsWith(`---\nname: ${item.name}\ndescription: ${item.description || ''}\n---\n`)
            ? item.content.slice(`---\nname: ${item.name}\ndescription: ${item.description || ''}\n---\n`.length) : item?.content || '';
        const dirty = () => draft && ['name', 'description', 'content', 'category', 'scope'].some(key => draft[key] !== (key === 'content' ? bodyFor(original()) : original()?.[key] ?? (key === 'category' ? 'fact' : key === 'scope' ? 'profile' : '')));
        const discard = () => !dirty() || confirm(t('放弃未保存的知识草稿？'));
        function open(id) {
            active = true;
            if (profile === id) { render(); if (!snapshot || uncertain) void load(); if (!learning) void loadLearning(); return; }
            if (profile) draftsByProfile.set(profile, { kind, query, offset, selected, detail, draft, editing, reviewed, uncertain, learningUncertain, receipt, conflict, learningDraft });
            profile = id || ''; serial++; learningEpoch++; memoryFull = false; legacyModel = null;
            ({ kind = 'skill', query = '', offset = 0, selected = null, detail = null, draft = null, editing = false,
                reviewed = true, uncertain = null, learningUncertain = null, receipt = null, conflict = false, learningDraft = null } = draftsByProfile.get(profile) || {});
            snapshot = learning = null; notice = ''; render(); if (profile) { void load(); void loadLearning(); }
        }
        // Open one entry (from a chat hint): switch to its kind, then select it even when it is
        // not on the first listed page.
        function reveal(itemId, itemKind) {
            if (!itemId) return;
            if (['memory', 'skill'].includes(itemKind) && itemKind !== kind) {
                if (!discard()) return;
                kind = itemKind; query = ''; offset = 0; selected = detail = draft = null; editing = false;
                revealItem = itemId; void load(); return;
            }
            revealItem = itemId;
            if (snapshot?.status === 'ready') revealLoaded(snapshot);
        }
        function revealLoaded(data) {
            const itemId = revealItem; revealItem = null;
            const target = data.items.find(row => row.id === itemId);
            if (target) {
                choose(target);
                requestAnimationFrame(() => root.querySelector('.pi-knowledge-row[aria-current="true"]')?.scrollIntoView({ block: 'nearest' }));
                return;
            }
            const profileId = profile, generation = serial;
            apiFetch(`${base()}/knowledge/items/${encodeURIComponent(itemId)}`).then(result => {
                if (current(profileId, generation) && result?.status === 'ready' && result.item?.id === itemId) choose(result.item);
            }).catch(() => {});
        }
        function close() { active = false; serial++; learningEpoch++; snapshot = learning = null; root.replaceChildren(); }
        async function load() {
            if (!profile || !active) return;
            const generation = ++serial, profileId = profile; notice = t('正在读取已保存数据…'); render();
            try {
                const data = await apiFetch(`${base()}/knowledge?${new URLSearchParams({ kind, query, offset: String(offset) })}`);
                if (!current(profileId, generation)) return;
                if (data?.version !== 1 || !Array.isArray(data.items) || !['ready', 'pending', 'missing', 'disabled', 'unsupported', 'error'].includes(data.status)
                    || data.revision !== null && typeof data.revision !== 'string') throw new Error(t('知识接口不兼容'));
                snapshot = data;
                if (selected && data.status === 'ready') {
                    const newer = data.items.find(row => row.id === selected.id);
                    if (newer && newer.revision !== selected.revision) {
                        selected = newer; detail = null; reviewed = false;
                        void apiFetch(`${base()}/knowledge/items/${encodeURIComponent(newer.id)}`).then(result => {
                            if (current(profileId, generation) && selected?.revision === newer.revision && result?.status === 'ready') { detail = result; render(); }
                        }).catch(() => {});
                    }
                }
                const found = data.receipts?.find(r => r.requestId === uncertain?.requestId);
                if (found) {
                    receipt = found;
                    if (['saved', 'pending'].includes(found.status) && ['create', 'update'].includes(uncertain?.operation)
                        && uncertain.draft === JSON.stringify(draft)) { draft = null; editing = false; selected = detail = null; }
                    uncertain = null;
                }
                notice = uncertain ? t('提交结果不确定。草稿和请求 ID 已保留，请核对回执，勿重复新建。')
                    : !reviewed ? t('保存版本已变化；先核对服务器正文与草稿。')
                        : conflict ? t('版本冲突；草稿已保留。刷新并核对服务器版本。')
                            : memoryFull ? t('记忆已满，新记忆会被拒绝。请整理合并后再试。') : '';
                render();
                if (revealItem && data.status === 'ready') revealLoaded(data);
            } catch (error) { if (current(profileId, generation)) { notice = t('读取失败：{0}', error.message); render(); } }
        }
        async function loadLearning() {
            if (!profile || !active) return;
            const profileId = profile, generation = ++learningEpoch;
            try {
                const data = await apiFetch(`${base()}/learning`);
                if (!active || !root.isConnected || profileId !== profile || generation !== learningEpoch) return;
                if (data?.version !== 1 || !Number.isSafeInteger(data.revision) || !data.settings) throw new Error(t('学习接口不兼容'));
                learning = data; if (!learningDraft) learningDraft = { ...data.settings }; render();
            } catch (error) { if (active && profileId === profile && generation === learningEpoch) { learning = { error: error.message }; render(); } }
        }
        function choose(item) {
            if (!discard()) return;
            selected = item; detail = draft = null; editing = false; reviewed = true; render();
            const profileId = profile, generation = serial;
            apiFetch(`${base()}/knowledge/items/${encodeURIComponent(item.id)}`).then(data => {
                if (!current(profileId, generation) || selected?.id !== item.id) return;
                if (data?.version !== 1 || data.status !== 'ready' || data.item?.id !== item.id) throw new Error(t('正文不可用，请刷新核对。'));
                detail = data; render();
            }).catch(error => { if (current(profileId, generation) && selected?.id === item.id) { notice = error.message; render(); } });
        }
        function edit(item) {
            if (!discard()) return;
            selected = item || null; detail = item ? detail : null; editing = true; uncertain = null; conflict = false; reviewed = true;
            draft = { name: item?.name || '', description: item?.description || '', content: bodyFor(item),
                category: item?.category || 'fact', scope: item?.scope || 'profile' }; render();
        }
        function receiptText(r) {
            return [t(label[r.operation] || r.operation), t(label[r.status] || r.status), r.indexStatus === 'pending' ? t('索引待同步') : '',
                r.activation === 'reload-required' ? t('当前会话需重载') : r.activation === 'next-turn' ? t('下次对话可用，模型是否遵守无法保证') : '', r.summary || ''].filter(Boolean).join(' · ');
        }
        function meta(item) {
            const source = item.source && typeof item.source === 'object' ? [item.source.sessionId && t('来源线程：{0}', item.source.sessionId),
                item.source.entryId && t('原生记录：{0}', item.source.entryId)].filter(Boolean).join(' · ') : '';
            return [t(label[item.state] || item.state || '未确认'), item.scope === 'project' ? t('目录范围：{0}', item.projectKey || t('未提供')) : t('助手范围'),
                item.revision && t('版本：{0}', item.revision), item.updatedAt, source].filter(Boolean).join(' · ');
        }
        function renderUsage() {
            const usage = snapshot?.usage;
            if (!usage || typeof usage !== 'object') return;
            const box = node('section', undefined, 'pi-usage-bars');
            box.append(node('h4', t('记忆用量')));
            for (const [key, text] of [['memory', 'MEMORY'], ['user', 'USER']]) {
                const data = usage[key];
                if (!data || !Number.isFinite(data.chars) || !Number.isFinite(data.limit) || data.limit <= 0) continue;
                const ratio = data.chars / data.limit, level = key === 'memory' && memoryFull || ratio >= 1 ? 'full' : ratio >= 0.8 ? 'near' : 'ok';
                const row = node('div', undefined, 'pi-usage-row');
                row.append(node('span', text, 'pi-usage-label'), node('span', `${data.chars} / ${data.limit}`, 'pi-usage-count'));
                const bar = node('div', undefined, `pi-usage-bar pi-usage-${level}`);
                const fill = node('div', undefined, 'pi-usage-fill'); fill.style.width = `${Math.min(100, Math.round(ratio * 100))}%`; bar.append(fill);
                row.append(bar); box.append(row);
                if (level === 'full') box.append(node('p', t('已满，新记忆会被拒绝'), 'pi-usage-note pi-usage-full'));
                else if (level === 'near') box.append(node('p', t('接近上限，下一步可整理合并'), 'pi-usage-note pi-usage-near'));
            }
            root.append(box);
        }
        function render() {
            root.replaceChildren(); if (!active || !profile) return;
            const head = node('div', undefined, 'pi-knowledge-head'); head.append(node('h4', t('助手内的记忆与技能')), button(t('刷新'), () => { void load(); void loadLearning(); })); root.append(head);
            root.append(node('p', t('已学习技能属于此助手；外部安装的成品技能在“扩展 → 已安装技能”管理。保存不代表当前会话已加载或模型一定遵守。'), 'pi-profile-note'));
            renderUsage();
            const tabs = node('div', undefined, 'pi-profile-kinds'); tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', t('知识类别'));
            for (const key of ['memory', 'skill']) { const tab = button(t(label[key]), () => { if (key === kind || !discard()) return; kind = key; offset = 0; selected = detail = draft = null; editing = false; void load(); }); tab.setAttribute('aria-pressed', String(key === kind)); tabs.append(tab); }
            root.append(tabs);
            const tools = node('div', undefined, 'pi-knowledge-tools'), search = node('input'); search.type = 'search'; search.maxLength = 200; search.value = query;
            search.placeholder = t('搜索已保存数据'); search.setAttribute('aria-label', t('搜索已保存数据'));
            search.onchange = () => { if (!discard()) { search.value = query; return; } query = search.value; offset = 0; void load(); };
            const add = button(t('新建{0}', t(label[kind])), () => edit(null), 'settings-primary-button'); add.disabled = busy || !!uncertain || !readyRevision(snapshot?.revision) || !allowed(snapshot, 'create', kind); tools.append(search, add); root.append(tools);
            const message = node('p', notice ? `${notice} · ${t('存储状态：{0}', t(statusLabel[snapshot?.status] || snapshot?.status || '状态未知'))}`
                : snapshot ? t('已保存数据 · {0}', t(statusLabel[snapshot.status] || snapshot.status || '状态未知')) : t('正在读取…'), 'pi-knowledge-status'); message.setAttribute('role', 'status'); root.append(message);
            if (receipt) {
                const r = node('div', receiptText(receipt), 'pi-knowledge-receipt'); r.setAttribute('role', 'status');
                if (receipt.undoable && receipt.id && allowed(snapshot, 'undo', receipt.kind)) r.append(button(t('撤销'), () => void mutate('undo', { receiptId: receipt.id, kind: receipt.kind })));
                root.append(r);
            }
            if (uncertain && !busy) root.append(button(t('刷新回执核对'), () => void load()));
            if (snapshot?.status === 'ready') {
                const list = node('div', undefined, 'pi-knowledge-list');
                for (const item of snapshot.items) {
                    // Memory rows lead with a bounded content preview so entries are recognizable without opening each one.
                    const meta = [item.kind === 'memory' ? t(label[item.category] || item.category || label[kind]) : item.description,
                        t(label[item.state] || item.state || ''), item.scope === 'project' && t('项目'), item.readOnly && t('只读')].filter(Boolean).join(' · ');
                    const title = item.kind === 'memory' ? String(item.content || '').replace(/\s+/g, ' ').trim().slice(0, 160) : item.name;
                    const row = button('', () => choose(item), 'pi-knowledge-row');
                    row.append(node('span', title || t(label[item.category] || item.category || label[kind]), 'pi-knowledge-row-title'), node('small', meta, 'pi-knowledge-row-meta'));
                    row.setAttribute('aria-current', String(selected?.id === item.id)); list.append(row);
                }
                if (!snapshot.items.length) list.append(node('p', t('此页没有已保存数据'), 'pi-profile-note')); root.append(list);
                const pages = node('div', undefined, 'pi-profile-pages'), prev = button(t('上一页'), () => { offset = Math.max(0, offset - Math.max(1, snapshot.items.length)); void load(); }), next = button(t('下一页'), () => { offset += snapshot.items.length; void load(); });
                prev.disabled = !offset; next.disabled = !snapshot.hasMore || !snapshot.items.length; pages.append(prev, next); root.append(pages);
            }
            if (selected) renderDetail(); if (editing) renderEditor(); renderLearning();
        }
        function renderDetail() {
            const item = original(), box = node('section', undefined, 'pi-knowledge-detail');
            box.append(node('h5', item.name || t(label[item.category] || label[kind])), node('small', meta(item)));
            if (item.description) box.append(node('p', item.description)); box.append(node('pre', detail ? item.content || '' : t('正在读取正文…')));
            if (detail) {
                const actions = node('div', undefined, 'pi-knowledge-actions');
                if (item.state === 'active' && allowed(snapshot, 'update', item.kind, item) && !detail?.item?.readOnly) actions.append(button(t('编辑'), () => edit(item)));
                for (const [operation, show] of [['delete', item.state !== 'deleted'], ['restore', item.state === 'deleted'], ['enable', item.state === 'disabled'], ['disable', item.state === 'active']])
                    if (show && allowed(snapshot, operation, item.kind, item) && !detail?.item?.readOnly) actions.append(button(t(label[operation]), () => void mutate(operation)));
                box.append(actions);
                const versions = (snapshot?.receipts || []).filter(row => row.itemId === item.id);
                if (versions.length) {
                    const history = node('details', undefined, 'pi-knowledge-history'); history.append(node('summary', t('近期版本回执')));
                    for (const row of versions) {
                        const entry = node('div', undefined, 'pi-knowledge-version');
                        entry.append(node('small', [row.at, t(label[row.operation] || row.operation), t(label[row.status] || row.status),
                            row.beforeRevision && t('之前：{0}', row.beforeRevision), row.afterRevision && t('之后：{0}', row.afterRevision)].filter(Boolean).join(' · ')));
                        if (row.undoable && row.afterRevision === item.revision && allowed(snapshot, 'undo', row.kind, item))
                            entry.append(button(t('撤销'), () => void mutate('undo', { receiptId: row.id, kind: row.kind })));
                        history.append(entry);
                    }
                    history.append(node('small', t('历史正文未由此接口提供；仅能对照当前正文与未保存草稿。')));
                    box.append(history);
                }
            }
            root.append(box);
        }
        function renderEditor() {
            const form = node('form', undefined, 'pi-knowledge-editor'); form.append(node('h5', t(selected ? '编辑{0}' : '新建{0}', t(label[kind]))));
            if (kind === 'skill') {
                const name = node('input'); name.required = true; name.maxLength = snapshot?.capabilities?.skillNameMaxLength || 64; name.pattern = '[a-z][a-z0-9-]{0,63}'; name.title = t('名称以小写字母开头，最多64位小写字母、数字或连字符'); name.value = draft.name; name.oninput = () => { draft.name = name.value; }; form.append(field(t('名称'), name));
                const description = node('input'); description.maxLength = 1000; description.value = draft.description; description.oninput = () => { draft.description = description.value; }; form.append(field(t('描述'), description));
            } else {
                const category = node('select'); for (const key of ['fact', 'preference', 'correction', 'failure', 'procedure']) category.append(option(key, t(label[key])));
                category.value = draft.category; category.onchange = () => { draft.category = category.value; }; form.append(field(t('类别'), category));
            }
            const scope = node('select'); scope.append(option('profile', t('助手范围')));
            if (draft.scope === 'project') scope.append(option('project', t('当前目录范围（只读）')));
            scope.value = draft.scope; scope.disabled = true;
            scope.onchange = () => { draft.scope = scope.value; render(); }; form.append(field(t('范围'), scope));
            if (draft.scope === 'project') form.append(node('p', t('当前目录范围需要服务端验证；此页不提交未经验证的项目标识。'), 'pi-profile-note'));
            const content = node('textarea'); content.required = true; content.maxLength = snapshot?.capabilities?.maxContentLength || 65536; content.rows = 8; content.value = draft.content;
            content.oninput = () => { draft.content = content.value; }; form.append(field(t('正文'), content));
            if (selected) {
                const diff = node('details'); diff.append(node('summary', t('对照已保存版本')), node('small', t('已保存版本：{0}', original()?.revision || t('未知'))), node('pre', original()?.content || ''));
                const proposed = node('pre', draft.content); proposed.className = 'pi-knowledge-proposed'; diff.append(node('small', t('当前草稿')), proposed);
                content.oninput = () => { draft.content = content.value; proposed.textContent = content.value; }; form.append(diff);
                if (!reviewed) {
                    const check = node('input'); check.type = 'checkbox'; check.onchange = () => { reviewed = check.checked; render(); };
                    const line = node('label', undefined, 'pi-profile-check'); line.append(check, document.createTextNode(t('已核对服务器最新版本与草稿'))); form.append(line);
                }
                if (detail?.item?.revision !== selected.revision) form.append(node('p', t('列表版本已变化；刷新并核对后再保存。'), 'pi-knowledge-status'));
            }
            const actions = node('div', undefined, 'pi-knowledge-actions'), save = node('button', t('保存'), 'settings-primary-button'); save.type = 'submit';
            save.disabled = busy || !!uncertain || !readyRevision(snapshot?.revision) || !allowed(snapshot, selected ? 'update' : 'create', kind, detail?.item || selected)
                || !reviewed || draft.scope !== 'profile' || !!selected && detail?.item?.revision !== selected.revision;
            actions.append(save, button(t('取消'), () => { editing = false; draft = null; render(); })); form.append(actions);
            form.onsubmit = event => { event.preventDefault(); if (form.reportValidity()) void mutate(selected ? 'update' : 'create'); }; root.append(form);
        }
        async function mutate(operation, extra = {}) {
            const targetKind = extra.kind || original()?.kind || kind;
            if (busy || uncertain || !readyRevision(snapshot?.revision) || !allowed(snapshot, operation, targetKind, operation === 'undo' ? null : detail?.item || original())) return;
            if (operation === 'delete' && !confirm(t('删除此条目？可从已删除记录中恢复。'))) return;
            const item = original(), profileId = profile, generation = ++serial;
            const input = { requestId: uuid(), expectedRevision: snapshot.revision, operation, kind: targetKind,
                ...(operation !== 'undo' && item ? { itemId: item.id, itemRevision: item.revision } : {}),
                ...(operation === 'undo' ? { receiptId: extra.receiptId } : {}) };
            if (operation === 'create' || operation === 'update') {
                Object.assign(input, { content: draft.content, scope: draft.scope });
                if (targetKind === 'skill') Object.assign(input, { name: draft.name.trim(), description: draft.description.trim() }); else input.category = draft.category;
                if (draft.scope === 'project') { notice = t('请选择助手范围；项目范围写入须由服务端提供已验证的项目标识。'); render(); return; }
            }
            busy = true; uncertain = { requestId: input.requestId, operation, draft: JSON.stringify(draft) }; notice = t('正在提交，等待服务回执…'); render();
            try {
                const result = await apiFetch(`${base()}/knowledge/mutations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
                if (!current(profileId, generation)) return;
                if (result?.version !== 1 || result.receipt?.requestId !== input.requestId) throw new Error(t('回执未确认'));
                receipt = result.receipt; uncertain = null; conflict = false; if (readyRevision(result.revision)) snapshot.revision = result.revision;
                if (['saved', 'pending'].includes(receipt.status)) { editing = false; draft = null; selected = detail = null; }
                notice = receipt.status === 'conflict' ? t('版本冲突；草稿已保留。刷新并核对最新正文。') : '';
            } catch (error) {
                if (current(profileId, generation)) {
                    if (error.status === 409 && (error.data?.code === 'memory-full' || error.code === 'memory-full')) {
                        uncertain = null; memoryFull = true; notice = t('记忆已满，新记忆会被拒绝。请整理合并后再试。'); void load();
                    } else if (error.status === 409) { uncertain = null; conflict = true; notice = t('版本冲突；草稿已保留。刷新并核对服务器版本。'); void load(); }
                    else if (rejected(error)) { uncertain = null; notice = t('提交被服务端拒绝：{0}，草稿已保留。', error.message); }
                    else { uncertain = { requestId: input.requestId, operation, draft: JSON.stringify(draft) }; notice = t('提交结果未确认：{0}。草稿与请求 ID {1} 已保留，勿重复提交。', error.message, input.requestId); }
                }
            } finally { busy = false; if (current(profileId, generation)) { render(); if (!uncertain && receipt?.requestId === input.requestId) void load(); } }
        }
        const canEnable = data => Boolean(data?.health) || Array.isArray(data?.capabilities?.actions) && data.capabilities.actions.includes('enable');
        async function loadModelCatalog() {
            if (modelCatalog) return;
            try {
                const data = await apiFetch('/api/pi/settings/models');
                if (data && Array.isArray(data.models)) modelCatalog = data;
            } catch { modelCatalog = { models: [], providers: [] }; }
            if (active && root.isConnected) render();
        }
        function renderLegacy(box) {
            const legacy = learning?.legacy;
            if (!legacy || typeof legacy !== 'object') return;
            const banner = node('div', undefined, 'pi-learning-legacy');
            banner.append(node('p', t('此身份开启过旧版自动学习，新版需要确认后才会继续学习。')));
            const purposes = (Array.isArray(legacy.purposes) ? legacy.purposes : []).map(id => t(purposeLabel[id] || id));
            banner.append(node('p', t('将设置的用途：{0}', purposes.join('、') || t('无'))));
            const model = legacy.reviewModel?.provider ? `${legacy.reviewModel.provider}/${legacy.reviewModel.modelId || ''}` : '';
            banner.append(node('p', t('模型：{0}', model || t('未提供'))));
            let chosen = null;
            if (legacy.reviewModelAvailable === false) {
                banner.append(node('p', t('旧模型不可用，请选择新的辅助模型。')));
                const catalog = (modelCatalog?.models || []).filter(m => m.available && Array.isArray(m.input) && m.input.includes('text') && !/:batch$/.test(m.id));
                const providerNames = new Map((modelCatalog?.providers || []).map(p => [p.id, p.name || p.id]));
                const providerIds = [...new Set(catalog.map(m => m.provider))];
                const field = node('label', t('模型')), provider = node('select'), modelSelect = node('select');
                provider.setAttribute('aria-label', t('供应商')); modelSelect.setAttribute('aria-label', t('模型'));
                for (const id of providerIds) provider.append(option(id, providerNames.get(id) || id));
                if (!providerIds.length) provider.append(option('', t('未提供')));
                provider.value = catalog.some(m => m.provider === legacyModel?.provider) ? legacyModel.provider : providerIds[0] || '';
                const fill = () => {
                    modelSelect.replaceChildren();
                    for (const m of catalog.filter(row => row.provider === provider.value)) modelSelect.append(option(m.id, m.name || m.id));
                    modelSelect.value = [...modelSelect.options].some(o => o.value === legacyModel?.modelId) ? legacyModel.modelId : modelSelect.options[0]?.value || '';
                    legacyModel = provider.value && modelSelect.value ? { provider: provider.value, modelId: modelSelect.value } : null;
                    chosen = legacyModel;
                };
                provider.onchange = () => { fill(); render(); };
                modelSelect.onchange = () => { fill(); render(); };
                fill();
                field.append(provider, modelSelect); banner.append(field);
                if (!modelCatalog) void loadModelCatalog();
            }
            const adopt = button(t('迁移并开启'), () => void action('adopt-legacy', undefined, chosen ? { model: chosen } : {}), 'settings-primary-button');
            adopt.disabled = learningBusy || legacy.reviewModelAvailable === false && !chosen;
            banner.append(adopt, button(t('不再提示'), () => void action('dismiss-legacy')));
            box.append(banner);
        }
        function renderLearning() {
            const box = node('section', undefined, 'pi-learning'); box.append(node('h4', t('后台学习')));
            if (!learning || learning.error) { box.append(node('p', learning?.error || t('正在读取…'), 'pi-knowledge-status')); root.append(box); return; }
            const health = learning.health;
            if (health?.state) {
                const line = node('p', undefined, 'pi-learning-health');
                line.append(node('span', undefined, `pi-health-dot pi-health-${healthTone[health.state] || 'off'}`),
                    node('span', t(healthLabel[health.state] || '学习当前不可用')));
                box.append(line);
            }
            const missing = Array.isArray(health?.missingModels) ? health.missingModels : [];
            if (missing.length) {
                box.append(node('p', t('还需要配置：{0}', missing.map(id => t(purposeLabel[id] || id)).join(' / ')), 'pi-knowledge-status'));
                box.append(button(t('前往设置 → 使用偏好 → 辅助模型'), () => globalThis.dispatchEvent?.(new CustomEvent('workspace:open-settings', { detail: { tab: 'models' } }))));
            }
            renderLegacy(box);
            const settings = learning.settings, form = node('form', undefined, 'pi-learning-settings');
            for (const [key, text] of [['enabled', '后台学习'], ['correctionEnabled', '纠错识别'], ['reviewEnabled', '定期复盘'], ['extractionEnabled', '候选提取']]) {
                if (!Object.hasOwn(settings, key)) continue;
                const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = learningDraft?.[key] === true;
                checkbox.disabled = learningBusy || !Number.isSafeInteger(learning.revision) || learning.capabilities?.settingsWrite === false;
                checkbox.onchange = () => { learningDraft[key] = checkbox.checked; };
                const line = node('label', undefined, 'pi-profile-check'); line.append(checkbox, document.createTextNode(t(text))); form.append(line);
            }
            if (Object.hasOwn(settings, 'maxRunsPerDay')) {
                const max = node('input'); max.type = 'number'; max.min = learning.capabilities?.limits?.maxRunsPerDay?.min ?? 1; max.max = learning.capabilities?.limits?.maxRunsPerDay?.max ?? 20; max.step = 1; max.value = learningDraft.maxRunsPerDay;
                max.disabled = learningBusy || !Number.isSafeInteger(learning.revision); max.oninput = () => { learningDraft.maxRunsPerDay = Number(max.value); };
                form.append(field(t('每天最多运行次数'), max));
            }
            for (const [key, text, min, max] of [['maxTokensPerDay', '每天最多预留 tokens', 6000, 200000], ['periodicReviewMinutes', '复盘间隔（分钟，0 为关闭）', 0, 10080]]) {
                if (!Object.hasOwn(settings, key)) continue;
                const limit = learning.capabilities?.limits?.[key];
                const input = node('input'); input.type = 'number'; input.min = limit?.min ?? min; input.max = limit?.max ?? max; input.step = 1; input.value = learningDraft[key];
                input.disabled = learningBusy || !Number.isSafeInteger(learning.revision); input.oninput = () => { learningDraft[key] = Number(input.value); };
                form.append(field(t(text), input));
            }
            form.append(node('small', t('每次运行最多预留 {0} tokens；费用仅按供应商回报显示，未知费用不代表免费。', learning.capabilities?.reservedTokensPerRun || 6000)));
            const changes = () => Object.fromEntries(Object.keys(learningDraft || {}).filter(key => Object.hasOwn(settings, key) && learningDraft[key] !== settings[key]).map(key => [key, learningDraft[key]]));
            const save = node('button', t('保存学习设置'), 'settings-primary-button'); save.type = 'submit';
            save.disabled = learningBusy || !Number.isSafeInteger(learning.revision) || learning.capabilities?.settingsWrite === false; form.append(save);
            form.onsubmit = async event => {
                event.preventDefault(); if (learningBusy || !form.reportValidity() || !Object.keys(changes()).length) return;
                learningBusy = true; save.disabled = true; const profileId = profile, generation = learningEpoch, changeSet = changes();
                try {
                    const data = await apiFetch(`${base()}/learning`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: learning.revision, changes: changeSet }) });
                    if (profileId !== profile || generation !== learningEpoch || !active || data?.version !== 1 || !Number.isSafeInteger(data.revision) || !data.settings) return;
                    learning = data; for (const [key, value] of Object.entries(changeSet)) if (learningDraft[key] === value) learningDraft[key] = data.settings[key];
                    notice = t('学习设置已保存；不会立即运行作业。');
                } catch (error) { if (profileId === profile && generation === learningEpoch && active) notice = error.status === 409 ? t('学习设置版本冲突；草稿已保留，请刷新核对。')
                    : rejected(error) ? t('学习设置被拒绝：{0}，草稿已保留。', error.message) : t('学习设置未确认：{0}。草稿已保留，请刷新核对。', error.message); }
                finally { learningBusy = false; if (profileId === profile && generation === learningEpoch && active) render(); }
            }; box.append(form);
            if (learningUncertain) {
                box.append(node('p', t('作业请求 {0} 结果未确认；请先核对作业列表，勿重复提交。', learningUncertain.requestId), 'pi-knowledge-status'));
                box.append(button(t('已核对作业列表'), () => { learningUncertain = null; render(); }));
            }
            if (!learningUncertain && canEnable(learning) && learning.settings?.enabled !== true) box.append(button(t('一键开启自学习'), () => void action('enable'), 'settings-primary-button'));
            if (!learningUncertain && learning.capabilities?.actions?.includes('review-now')) box.append(button(t('立即复盘'), () => void action('review-now')));
            for (const job of [...(learning.jobs || []), ...(learning.recentRuns || [])].slice(0, 20)) {
                const row = node('div', undefined, 'pi-learning-job'); row.append(node('strong', `${t(jobLabel[job.reason] || job.reason || job.id)} · ${t(jobLabel[job.status] || job.status || '状态未知')}`));
                row.append(node('small', [job.createdAt || job.startedAt || '', job.model?.provider && (job.model?.modelId || job.model?.id) ? `${job.model.provider}/${job.model.modelId || job.model.id}` : '',
                    job.usage?.totalTokens != null ? t('{0} tokens', job.usage.totalTokens) : '',
                    job.costStatus === 'reported' && job.usage?.reportedCostUsd != null ? t('供应商报告费用：${0}', job.usage.reportedCostUsd) : t('费用未知'),
                    job.error === 'memory-full' ? t('记忆已满，未保存') : '',
                    job.receiptIds?.length ? t('关联回执：{0}', job.receiptIds.join(', ')) : ''].filter(Boolean).join(' · ')));
                if (!learningUncertain && job.id && learning.capabilities?.actions?.includes('cancel') && ['queued', 'running', 'pending', 'waiting-config'].includes(job.status)) row.append(button(t('取消作业'), () => void action('cancel', job.id)));
                box.append(row);
            }
            root.append(box);
        }
        async function action(name, jobId, extra = {}) {
            const supported = learning?.capabilities?.actions?.includes(name)
                || name === 'enable' && canEnable(learning)
                || ['adopt-legacy', 'dismiss-legacy'].includes(name) && Boolean(learning?.legacy);
            if (learningBusy || learningUncertain || !supported) return;
            const requestId = uuid(), generation = learningEpoch;
            learningBusy = true; render(); const profileId = profile;
            try {
                const result = await apiFetch(`${base()}/learning/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, action: name, ...(jobId ? { jobId } : {}), ...extra }) });
                if (profileId !== profile || generation !== learningEpoch || !active) return;
                if (result?.version !== 1 || !Number.isSafeInteger(result.revision) || !result.settings) throw new Error(t('作业回执未确认'));
                notice = name === 'enable' ? t('已开启自学习；以学习状态为准。') : name === 'adopt-legacy' ? t('已迁移并开启学习。')
                    : name === 'dismiss-legacy' ? t('已忽略旧自动学习提示。') : t('作业请求已返回；以作业列表状态为准。');
                learning = result;
            } catch (error) {
                if (profileId === profile && generation === learningEpoch && active) {
                    if (error.status !== 409 && !rejected(error)) learningUncertain = { requestId, action: name, jobId };
                    notice = error.status === 409 ? t('作业请求冲突；请刷新核对。')
                        : rejected(error) ? t('作业请求被拒绝：{0}', error.message) : t('作业结果未确认：{0}。刷新核对，不自动重试。', error.message);
                }
            } finally { learningBusy = false; if (profileId === profile && generation === learningEpoch && active) render(); }
        }
        return { open, close, reveal, refresh: () => { if (profile) { void load(); void loadLearning(); } } };
    }
    globalThis.PiProfileKnowledge = Object.freeze({ create });
})();
