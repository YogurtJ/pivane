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
        create: '新建', update: '更新', delete: '删除', restore: '恢复条目', enable: '启用', disable: '停用', undo: '撤销', consolidate: '整理合并' };
    const statusLabel = { ready: '就绪', pending: '待同步', missing: '缺失', disabled: '未启用', unsupported: '不支持', error: '错误' };
    const healthLabel = { ok: '学习正常', off: '学习已关闭', 'needs-model': '缺少学习模型配置', 'quota-exhausted': '今日学习额度已用完', failing: '最近学习连续失败', unavailable: '学习当前不可用', 'memory-full': '记忆已满' };
    const healthTone = { ok: 'ok', off: 'off', 'needs-model': 'warn', 'quota-exhausted': 'warn', failing: 'bad', unavailable: 'bad' };
    const purposeLabel = { 'memory-correction': '纠错模型', 'memory-review': '复盘模型', 'memory-extraction': '提炼模型' };
    const uuid = () => globalThis.crypto?.randomUUID?.() || `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const jobLabel = { queued: '排队中', running: '运行中', 'waiting-config': '等待模型配置', cancelling: '取消中', cancelled: '已取消', completed: '已完成',
        failed: '失败', uncertain: '待核对', skipped: '已跳过', manual: '手动复盘', periodic: '周期复盘', correction: '纠错识别',
        review: '复盘', extraction: '候选提取' };
    const operations = new Set(['create', 'update', 'delete', 'restore', 'enable', 'disable', 'undo', 'consolidate']);
    const readyRevision = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const rejected = error => [400, 403, 404, 413, 422, 429].includes(error?.status);
    function create({ apiFetch, root }) {
        let profile = '', kind = 'skill', query = '', offset = 0, serial = 0, active = false, draftOnly = false, deletedOnly = false;
        // A verified session id (U2.3) unlocks editing the project memory of that session's
        // directory only; without it project entries stay read-only.
        let sessionScope = '';
        // Project writes are limited to these operations and need the session verification.
        const projectOperations = ['create', 'update', 'delete', 'undo'];
        function allowed(snapshot, key, kind, item) {
            if (snapshot?.status !== 'ready') return false;
            const c = snapshot.capabilities;
            if (!c || typeof c !== 'object') return false;
            if (operations.has(key)) {
                if (c[kind] !== true || item?.readOnly || item?.truncated) return false;
                if (item?.scope === 'project' && c.projectWrites !== true
                    && !(sessionScope && item.kind === 'memory' && c.projectWritesBySession === true && projectOperations.includes(key))) return false;
                if (kind === 'memory' && ['enable', 'disable'].includes(key)) return false;
                const actions = c.operations?.[kind] || c.actions?.[kind] || c.operations || c.actions;
                if (Array.isArray(actions) && !actions.includes(key)) return false;
                return key !== 'update' || !item || item.state === 'active';
            }
            const actions = c.actions || c.operations;
            return Array.isArray(actions) && actions.includes(key) || c[key] === true;
        }
        let triggersOpen = false;
        let snapshot = null, learning = null, learningDraft = null, selected = null, detail = null, draft = null, editing = false, reviewed = true;
        let busy = false, learningBusy = false, learningEpoch = 0, uncertain = null, learningUncertain = null, receipt = null, notice = '', conflict = false;
        let memoryFull = false, revealItem = null, modelCatalog = null, legacyModel = null;
        // Consolidation proposals (learning) are applied through the knowledge mutations;
        // group drafts and applied groups live only in this page.
        let proposalDrafts = new Map(), appliedGroups = new Set();
        // itemId -> current revision (null when verified missing) used for proposal staleness.
        let itemRevisions = new Map(), itemChecks = new Set();
        // Next-turn injection preview (K2.2): null when the backend does not provide it yet.
        let injection;
        const draftsByProfile = new Map();
        const base = () => `/api/pi/profiles/${encodeURIComponent(profile)}`;
        const current = (profileId, generation) => active && root.isConnected && profile === profileId && serial === generation;
        const original = () => detail?.item || selected;
        const bodyFor = item => item?.kind === 'skill' && item.content?.startsWith(`---\nname: ${item.name}\ndescription: ${item.description || ''}\n---\n`)
            ? item.content.slice(`---\nname: ${item.name}\ndescription: ${item.description || ''}\n---\n`.length) : item?.content || '';
        const dirty = () => draft && ['name', 'description', 'content', 'category', 'scope'].some(key => draft[key] !== (key === 'content' ? bodyFor(original()) : original()?.[key] ?? (key === 'category' ? 'fact' : key === 'scope' ? 'profile' : '')));
        const discard = async () => {
            if (busy) return false;
            if (!dirty()) return true;
            const profileId = profile, generation = serial;
            const accepted = await globalThis.PiProfileDialog.confirm({ title: t('放弃未保存的知识草稿？'), message: t('切换后，当前条目的未保存修改将丢失。'), accept: t('放弃修改') });
            return accepted && current(profileId, generation) && !busy;
        };
        async function open(id, options = {}) {
            active = true;
            // U2.3: only a caller-verified session id enables project memory writes; without
            // one project entries stay read-only and the old display is kept.
            if (options && typeof options === 'object' && options.sessionId !== undefined) sessionScope = String(options.sessionId || '');
            if (profile === id) {
                await viewOptions(options);
                if (!active || profile !== id) return;
                render(); if (!snapshot || uncertain) void load(); if (!learning) void loadLearning(); return;
            }
            if (profile) draftsByProfile.set(profile, { kind, query, offset, selected, detail, draft, editing, reviewed, uncertain, learningUncertain, receipt, conflict, learningDraft });
            profile = id || ''; serial++; learningEpoch++; memoryFull = false; legacyModel = null; draftOnly = false; deletedOnly = false;
            proposalDrafts = new Map(); appliedGroups = new Set(); itemRevisions = new Map(); itemChecks = new Set(); injection = undefined;
            ({ kind = 'skill', query = '', offset = 0, selected = null, detail = null, draft = null, editing = false,
                reviewed = true, uncertain = null, learningUncertain = null, receipt = null, conflict = false, learningDraft = null } = draftsByProfile.get(profile) || {});
            snapshot = learning = null; notice = '';
            await viewOptions(options);
            if (!active || profile !== id) return;
            render(); if (profile) { void load(); void loadLearning(); }
        }
        // Apply the caller's view request after any saved per-profile state is restored.
        async function viewOptions(options) {
            if (!options || typeof options !== 'object') return;
            if (['memory', 'skill'].includes(options.kind) && options.kind !== kind && await discard()) {
                kind = options.kind; offset = 0; selected = detail = draft = null; editing = false;
            }
            // U2.4: jump to the learned skills filtered to the draft entries awaiting review.
            if (options.drafts === true && (kind !== 'skill' || !draftOnly) && await discard()) {
                kind = 'skill'; draftOnly = true; deletedOnly = false; offset = 0; selected = detail = draft = null; editing = false;
            }
        }
        // Open one entry (from a chat hint): switch to its kind, then select it even when it is
        // not on the first listed page.
        async function reveal(itemId, itemKind, sessionId) {
            if (sessionId) sessionScope = String(sessionId);
            if (!itemId) return;
            if (['memory', 'skill'].includes(itemKind) && itemKind !== kind) {
                if (!await discard()) return;
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
        function close() { active = false; serial++; learningEpoch++; sessionScope = ''; snapshot = learning = null; root.replaceChildren(); }
        async function load() {
            if (!profile || !active || busy) return;
            const generation = ++serial, profileId = profile; notice = t('正在读取已保存数据…'); render();
            try {
                const data = await apiFetch(`${base()}/knowledge?${new URLSearchParams({ kind, query, offset: String(offset), state: deletedOnly ? 'deleted' : draftOnly ? 'draft' : 'present' })}`);
                if (!current(profileId, generation)) return;
                if (data?.version !== 1 || !Array.isArray(data.items) || !['ready', 'pending', 'missing', 'disabled', 'unsupported', 'error'].includes(data.status)
                    || data.revision !== null && typeof data.revision !== 'string') throw new Error(t('知识接口不兼容'));
                if (data.status === 'ready' && !data.items.length && !data.hasMore && offset > 0) {
                    offset = Math.max(0, offset - 50); return load();
                }
                snapshot = data;
                if (data.status === 'ready') for (const row of data.items) if (row?.id) itemRevisions.set(row.id, row.revision ?? null);
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
                if (injection === undefined) void loadInjection();
            } catch (error) { if (active && profileId === profile && generation === learningEpoch) { learning = { error: error.message }; render(); } }
        }
        // Read-only injection preview; a backend without the contract endpoint keeps the old display.
        async function loadInjection() {
            const profileId = profile, generation = learningEpoch;
            try {
                const data = await apiFetch(`${base()}/knowledge/injection`);
                if (profileId !== profile || generation !== learningEpoch || !active) return;
                injection = data?.version === 1 && typeof data.block === 'string' && data.profile && typeof data.profile === 'object' ? data : null;
            } catch { injection = null; }
            if (active && root.isConnected && profileId === profile) render();
        }
        async function choose(item) {
            if (!await discard()) return;
            selected = item; detail = draft = null; editing = false; reviewed = true; render();
            root.querySelector('.pi-knowledge-detail')?.scrollIntoView({ block: 'nearest' });
            const profileId = profile, generation = serial;
            apiFetch(`${base()}/knowledge/items/${encodeURIComponent(item.id)}`).then(data => {
                if (!current(profileId, generation) || selected?.id !== item.id) return;
                if (data?.version !== 1 || data.status !== 'ready' || data.item?.id !== item.id) throw new Error(t('正文不可用，请刷新核对。'));
                detail = data; render();
            }).catch(error => { if (current(profileId, generation) && selected?.id === item.id) { notice = error.message; render(); } });
        }
        async function edit(item) {
            if (!await discard()) return;
            selected = item || null; detail = item ? detail : null; editing = true; uncertain = null; conflict = false; reviewed = true;
            draft = { name: item?.name || '', description: item?.description || '', content: bodyFor(item),
                category: item?.category || 'fact', scope: item?.scope || 'profile' }; render();
            root.querySelector('.pi-knowledge-editor')?.scrollIntoView({ block: 'nearest' });
        }
        function receiptText(r) {
            return [t(label[r.operation] || r.operation), t(label[r.status] || r.status), r.indexStatus === 'pending' ? t('索引待同步') : '',
                r.activation === 'reload-required' ? t('当前会话需重载') : r.activation === 'next-turn' ? t('下次对话可用，模型是否遵守无法保证') : '', r.preview || '', r.summary || ''].filter(Boolean).join(' · ');
        }
        function meta(item) {
            const source = item.source && typeof item.source === 'object' ? [item.source.sessionId && t('来源线程：{0}', item.source.sessionId),
                item.source.entryId && t('原生记录：{0}', item.source.entryId)].filter(Boolean).join(' · ') : '';
            return [t(label[item.state] || item.state || '未确认'), item.scope === 'project' ? t('目录范围：{0}', item.projectKey || t('未提供')) : t('助手范围'),
                item.revision && t('版本：{0}', item.revision), item.updatedAt, source].filter(Boolean).join(' · ');
        }
        function proposalsSupported() {
            // Contract fields arrive with the L2 backend; older snapshots keep the plain display.
            return Array.isArray(learning?.proposals) || learning?.capabilities?.actions?.includes('propose-consolidation') === true;
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
                if (level !== 'ok' && proposalsSupported() && !learningUncertain)
                    box.append(button(t('整理合并'), () => void action('propose-consolidation', undefined, { target: key }), 'settings-primary-button'));
            }
            root.append(box);
        }
        function render() {
            const focused = root.contains(document.activeElement) ? document.activeElement : null;
            const controls = [...root.querySelectorAll('input,textarea,select,button,summary')];
            const focusIndex = focused ? controls.indexOf(focused) : -1;
            const selection = focused && typeof focused.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd] : null;
            const openDetails = [...root.querySelectorAll('details')].map(el => el.open);
            renderContents();
            [...root.querySelectorAll('details')].forEach((el, i) => { if (openDetails[i] !== undefined) el.open = openDetails[i]; });
            if (focusIndex >= 0) {
                const replacement = root.querySelectorAll('input,textarea,select,button,summary')[focusIndex];
                if (replacement?.tagName === focused.tagName && replacement.type === focused.type && replacement.textContent === focused.textContent) {
                    replacement.focus({ preventScroll: true });
                    if (selection && replacement.setSelectionRange) replacement.setSelectionRange(...selection);
                }
            }
        }
        function renderContents() {
            root.replaceChildren(); if (!active || !profile) return;
            const head = node('div', undefined, 'pi-knowledge-head'); head.append(node('h4', t('助手内的记忆与技能')), button(t('刷新'), () => { void load(); void loadLearning(); }));
            const jump = button(t('后台学习设置'), () => root.querySelector('.pi-learning')?.scrollIntoView({ block: 'start', behavior: 'instant' }));
            head.append(jump); root.append(head);
            root.append(node('p', t('已学习技能属于此助手；外部安装的成品技能在“扩展 → 已安装技能”管理。保存不代表当前会话已加载或模型一定遵守。'), 'pi-profile-note'));
            if (sessionScope) root.append(node('p', t('项目记忆按当前会话目录核实。'), 'pi-profile-note'));
            renderUsage();
            const tabs = node('div', undefined, 'pi-profile-kinds'); tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', t('知识类别'));
            for (const key of ['memory', 'skill']) { const tab = button(t(label[key]), async () => { if (key === kind || !await discard()) return; kind = key; draftOnly = false; deletedOnly = false; offset = 0; selected = detail = draft = null; editing = false; void load(); }); tab.setAttribute('aria-pressed', String(key === kind)); tabs.append(tab); }
            root.append(tabs);
            const tools = node('div', undefined, 'pi-knowledge-tools'), search = node('input'); search.type = 'search'; search.maxLength = 200; search.value = query;
            search.placeholder = t('搜索已保存数据'); search.setAttribute('aria-label', t('搜索已保存数据'));
            search.onchange = async () => { if (!await discard()) { search.value = query; return; } query = search.value; offset = 0; void load(); };
            const add = button(t('新建{0}', t(label[kind])), () => edit(null), 'settings-primary-button'); add.disabled = busy || !!uncertain || !readyRevision(snapshot?.revision) || !allowed(snapshot, 'create', kind); tools.append(search, add); root.append(tools);
            const deletedFilter = button(deletedOnly ? t('返回未删除条目') : t('查看已删除条目'), async () => {
                if (!await discard()) return;
                deletedOnly = !deletedOnly; draftOnly = false; offset = 0; selected = detail = draft = null; editing = false; void load();
            });
            deletedFilter.classList.add('pi-knowledge-deleted-filter');
            deletedFilter.setAttribute('aria-pressed', String(deletedOnly)); root.append(deletedFilter);
            if (kind === 'skill' && !deletedOnly) {
                const filterBar = node('div', undefined, 'pi-knowledge-filter');
                const filter = button(draftOnly ? t('显示全部技能') : t('只看草稿技能'), async () => { if (!await discard()) return; draftOnly = !draftOnly; offset = 0; selected = detail = draft = null; editing = false; void load(); });
                filter.setAttribute('aria-pressed', String(draftOnly)); filterBar.append(filter); root.append(filterBar);
            }
            const message = node('p', notice ? `${notice} · ${t('存储状态：{0}', t(statusLabel[snapshot?.status] || snapshot?.status || '状态未知'))}`
                : snapshot ? t('已保存数据 · {0}', t(statusLabel[snapshot.status] || snapshot.status || '状态未知')) : t('正在读取…'), 'pi-knowledge-status'); message.setAttribute('role', 'status'); root.append(message);
            if (receipt) {
                const r = node('div', receiptText(receipt), 'pi-knowledge-receipt'); r.setAttribute('role', 'status');
                if (receipt.undoable && receipt.id && allowed(snapshot, 'undo', receipt.kind, receipt.scope === 'project' ? { kind: receipt.kind, scope: 'project' } : null))
                    r.append(button(t('撤销'), () => void mutate('undo', { receiptId: receipt.id, kind: receipt.kind, scope: receipt.scope })));
                root.append(r);
            }
            if (uncertain && !busy) root.append(button(t('刷新回执核对'), () => void load()));
            let inlineDetail = false;
            if (snapshot?.status === 'ready') {
                const visibleItems = snapshot.items.filter(row => (deletedOnly ? row.state === 'deleted' : row.state !== 'deleted') && (!draftOnly || row.state === 'draft'));
                const list = node('div', undefined, 'pi-knowledge-list');
                for (const item of visibleItems) {
                    // Memory rows lead with a bounded content preview so entries are recognizable without opening each one.
                    const meta = [item.kind === 'memory' ? t(label[item.category] || item.category || label[kind]) : item.description,
                        t(label[item.state] || item.state || ''), item.scope === 'project' && t('项目'), item.readOnly && t('只读')].filter(Boolean).join(' · ');
                    const title = item.kind === 'memory' ? String(item.content || '').replace(/\s+/g, ' ').trim().slice(0, 160) : item.name;
                    const row = button('', () => choose(item), 'pi-knowledge-row');
                    row.append(node('span', title || t(label[item.category] || item.category || label[kind]), 'pi-knowledge-row-title'), node('small', meta, 'pi-knowledge-row-meta'));
                    row.setAttribute('aria-current', String(selected?.id === item.id));
                    row.setAttribute('aria-expanded', String(selected?.id === item.id)); row.dataset.itemId = item.id; list.append(row);
                    if (selected?.id === item.id) {
                        renderDetail(list); if (editing) renderEditor(list); inlineDetail = true;
                    }
                }
                if (!visibleItems.length) list.append(node('p', t('此页没有已保存数据'), 'pi-profile-note')); root.append(list);
                const pages = node('div', undefined, 'pi-profile-pages'), prev = button(t('上一页'), () => { offset = Math.max(0, offset - 50); void load(); }), next = button(t('下一页'), () => { offset += snapshot.items.length; void load(); });
                prev.disabled = !offset; next.disabled = !snapshot.hasMore || !snapshot.items.length; pages.append(prev, next); root.append(pages);
            }
            if (!inlineDetail) { if (selected) renderDetail(); if (editing) renderEditor(); } renderLearning();
            if (busy) root.querySelectorAll('button,input,textarea,select').forEach(control => { control.disabled = true; });
            else if (learningBusy) root.querySelectorAll('button[type=submit]').forEach(control => { control.disabled = true; });
        }
        function renderDetail(parent = root) {
            const item = original(), box = node('section', undefined, 'pi-knowledge-detail');
            const heading = node('div', undefined, 'pi-knowledge-head');
            heading.append(node('h5', item.name || t(label[item.category] || label[kind])), button(t('收起详情'), async () => {
                if (!await discard()) return;
                const id = selected?.id; selected = detail = draft = null; editing = false; render();
                [...root.querySelectorAll('.pi-knowledge-row')].find(row => row.dataset.itemId === id)?.focus({ preventScroll: true });
            }));
            box.append(heading, node('small', meta(item)));
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
                            entry.append(button(t('撤销'), () => void mutate('undo', { receiptId: row.id, kind: row.kind, scope: item.scope })));
                        history.append(entry);
                    }
                    history.append(node('small', t('历史正文未由此接口提供；仅能对照当前正文与未保存草稿。')));
                    box.append(history);
                }
            }
            parent.append(box);
        }
        function renderEditor(parent = root) {
            const form = node('form', undefined, 'pi-knowledge-editor'); form.append(node('h5', t(selected ? '编辑{0}' : '新建{0}', t(label[kind]))));
            if (kind === 'skill') {
                const name = node('input'); name.required = true; name.maxLength = snapshot?.capabilities?.skillNameMaxLength || 64; name.pattern = '[a-z][a-z0-9-]{0,63}'; name.title = t('名称以小写字母开头，最多64位小写字母、数字或连字符'); name.value = draft.name; name.oninput = () => { draft.name = name.value; }; form.append(field(t('名称'), name));
                const description = node('input'); description.maxLength = 1000; description.value = draft.description; description.oninput = () => { draft.description = description.value; }; form.append(field(t('描述'), description));
            } else {
                const category = node('select'); for (const key of ['fact', 'preference', 'correction', 'failure', 'procedure']) category.append(option(key, t(label[key])));
                category.value = draft.category; category.onchange = () => { draft.category = category.value; }; form.append(field(t('类别'), category));
            }
            const scopeSelect = node('select'); scopeSelect.append(option('profile', t('助手范围')));
            // Project scope is writable only with the verified session id and the K2.3 capability.
            const projectWritable = kind === 'memory' && Boolean(sessionScope) && snapshot?.capabilities?.projectWritesBySession === true;
            if (draft.scope === 'project' || projectWritable) scopeSelect.append(option('project', t(projectWritable ? '当前目录范围（按当前会话核实）' : '当前目录范围（只读）')));
            scopeSelect.value = draft.scope; scopeSelect.disabled = !projectWritable;
            scopeSelect.onchange = () => { draft.scope = scopeSelect.value; render(); }; form.append(field(t('范围'), scopeSelect));
            if (draft.scope === 'project') form.append(node('p', projectWritable ? t('项目记忆按当前会话目录核实。') : t('当前目录范围需要服务端验证；此页不提交未经验证的项目标识。'), 'pi-profile-note'));
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
                || !reviewed || !(draft.scope === 'profile' || draft.scope === 'project' && projectWritable) || !!selected && detail?.item?.revision !== selected.revision;
            actions.append(save, button(t('取消'), async () => { if (!await discard()) return; editing = false; draft = null; render(); })); form.append(actions);
            form.onsubmit = event => { event.preventDefault(); if (form.reportValidity()) void mutate(selected ? 'update' : 'create'); }; parent.append(form);
        }
        async function mutate(operation, extra = {}) {
            const targetKind = extra.kind || original()?.kind || kind;
            const guarded = operation === 'undo' ? (extra.scope === 'project' ? { kind: targetKind, scope: 'project' } : null) : detail?.item || original();
            if (busy || uncertain || !readyRevision(snapshot?.revision) || !allowed(snapshot, operation, targetKind, guarded)) return;
            if (operation === 'delete') {
                const profileId = profile, generation = serial, itemId = original()?.id;
                const accepted = await globalThis.PiProfileDialog.confirm({ title: t('删除此条目？'), message: t('删除后可从已删除记录中恢复。'), accept: t('删除条目'), cancelLabel: t('取消') });
                if (!accepted || !current(profileId, generation) || original()?.id !== itemId || busy || uncertain) return;
            }
            const item = original();
            const projectScope = (operation === 'undo' ? extra.scope : item?.scope) === 'project';
            const input = { requestId: uuid(), expectedRevision: snapshot.revision, operation, kind: targetKind,
                ...(operation !== 'undo' && item ? { itemId: item.id, itemRevision: item.revision } : {}),
                ...(operation === 'undo' ? { receiptId: extra.receiptId } : {}),
                ...(projectScope ? { scope: 'project', sessionId: sessionScope } : {}) };
            if (operation === 'create' || operation === 'update') {
                Object.assign(input, { content: draft.content, scope: draft.scope });
                if (targetKind === 'skill') Object.assign(input, { name: draft.name.trim(), description: draft.description.trim() }); else input.category = draft.category;
                if (draft.scope === 'project') {
                    // The server derives the project directory from the verified session;
                    // this page never submits a client-side projectKey.
                    if (targetKind !== 'memory' || !sessionScope || snapshot?.capabilities?.projectWritesBySession !== true) {
                        notice = t('请选择助手范围；项目范围写入须由服务端提供已验证的项目标识。'); render(); return;
                    }
                    input.sessionId = sessionScope;
                }
            }
            await runMutation(input, () => { editing = false; draft = null; selected = detail = null; });
        }
        // One submission path: the receipt, conflicts and uncertain results are handled the
        // same way for single edits and for a consolidation batch.
        async function runMutation(input, saved) {
            const profileId = profile, generation = ++serial;
            busy = true; uncertain = { requestId: input.requestId, operation: input.operation, draft: JSON.stringify(draft) }; notice = t('正在提交，等待服务回执…'); render();
            try {
                const result = await apiFetch(`${base()}/knowledge/mutations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
                if (!current(profileId, generation)) return;
                if (result?.version !== 1 || result.receipt?.requestId !== input.requestId) throw new Error(t('回执未确认'));
                receipt = result.receipt; uncertain = null; conflict = false; if (readyRevision(result.revision)) snapshot.revision = result.revision;
                if (['saved', 'pending'].includes(receipt.status)) saved?.();
                notice = receipt.status === 'conflict' ? t('版本冲突；草稿已保留。刷新并核对最新正文。') : '';
            } catch (error) {
                if (current(profileId, generation)) {
                    if (error.status === 409 && (error.data?.code === 'memory-full' || error.code === 'memory-full')) {
                        uncertain = null; memoryFull = true; notice = t('记忆已满，新记忆会被拒绝。请整理合并后再试。');
                    } else if (error.status === 409) { uncertain = null; conflict = true; notice = t('版本冲突；草稿已保留。刷新并核对服务器版本。'); }
                    else if (error.status === 400 && (error.data?.code || error.code) === 'content-blocked') {
                        uncertain = null; notice = (error.data?.details?.kind || error.details?.kind) === 'secret'
                            ? t('内容疑似密钥或凭据，不能保存到记忆或技能。') : t('内容疑似提示词注入指令，不能保存到记忆或技能。');
                    } else if (rejected(error)) { uncertain = null; notice = t('提交被服务端拒绝：{0}，草稿已保留。', error.message); }
                    else { uncertain = { requestId: input.requestId, operation: input.operation, draft: JSON.stringify(draft) }; notice = t('提交结果未确认：{0}。草稿与请求 ID {1} 已保留，勿重复提交。', error.message, input.requestId); }
                }
            } finally {
                busy = false;
                if (current(profileId, generation)) { render(); if (!uncertain && (receipt?.requestId === input.requestId || conflict || memoryFull)) void load(); }
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
            await runMutation(input, () => appliedGroups.add(groupKey(proposal.id, group)));
        }
        // Keyed by the group's items, not its position: dismissing a group shifts the later indexes.
        const groupKey = (proposalId, group) => `${proposalId}:${(group?.items || []).map(row => row.itemId).join(',')}`;
        function proposalDraft(proposalId, index, group) {
            const key = groupKey(proposalId, group);
            if (!proposalDrafts.has(key)) proposalDrafts.set(key, { content: String(group.content || ''), category: group.category || 'fact' });
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
        function renderProposals(box) {
            const proposals = (Array.isArray(learning?.proposals) ? learning.proposals : []).filter(proposal => proposal && typeof proposal === 'object');
            checkProposalItems(proposals);
            const groups = proposals.flatMap(proposal => (proposal.groups || []).map((group, index) => ({ proposal, group, index })))
                .filter(row => row.group && !appliedGroups.has(groupKey(row.proposal.id, row.group)));
            if (!groups.length) return;
            const section = node('section', undefined, 'pi-proposals');
            section.append(node('h5', t('整理方案')));
            for (const { proposal, group, index } of groups) {
                const merged = proposalDraft(proposal.id, index, group);
                const stale = groupStale(group);
                const card = node('div', undefined, 'pi-proposal-group');
                card.append(node('p', [t('第 {0} 组', index + 1), proposal.target === 'user' ? 'USER' : 'MEMORY',
                    proposal.model && [proposal.model.provider, proposal.model.modelId || proposal.model.id].filter(Boolean).join('/'),
                    proposal.createdAt && t('生成时间：{0}', proposal.createdAt)].filter(Boolean).join(' · '), 'pi-proposal-meta'));
                const items = node('div', undefined, 'pi-proposal-items');
                items.append(node('small', t('原条目')));
                for (const row of group.items || []) {
                    const line = node('p', undefined, 'pi-proposal-item');
                    line.append(node('span', String(row.preview || '').slice(0, 160) || t('（无预览）'), 'pi-proposal-item-text'));
                    if (row.category) line.append(node('em', t(label[row.category] || row.category), 'pi-proposal-tag'));
                    items.append(line);
                }
                card.append(items);
                const body = node('div', undefined, 'pi-proposal-body');
                if (stale) body.append(node('p', t('已过期：条目版本已变化或已不存在，请重新生成方案。'), 'pi-proposal-stale'));
                const content = node('textarea'); content.rows = 4; content.value = merged.content;
                content.maxLength = snapshot?.capabilities?.maxContentLength || 65536; content.disabled = stale;
                content.oninput = () => { merged.content = content.value; };
                body.append(field(t('合并后正文'), content));
                const category = node('select');
                for (const key of ['fact', 'preference', 'correction', 'failure', 'procedure']) category.append(option(key, t(label[key])));
                category.value = merged.category; category.disabled = stale; category.onchange = () => { merged.category = category.value; };
                body.append(field(t('类别'), category));
                const actions = node('div', undefined, 'pi-knowledge-actions');
                const apply = button(t('应用'), () => void consolidate(proposal, index), 'settings-primary-button');
                apply.disabled = stale || busy || !!uncertain || learningBusy || !readyRevision(snapshot?.revision) || !allowed(snapshot, 'consolidate', 'memory');
                const dismiss = button(t('忽略'), () => void action('dismiss-proposal', undefined, { proposalId: proposal.id, groupIndex: index }));
                dismiss.disabled = learningBusy || !!learningUncertain;
                actions.append(apply, dismiss); body.append(actions);
                card.append(body); section.append(card);
            }
            box.append(section);
        }
        // U2.2: next-turn injection preview for the identity-level block.
        function renderInjection(box) {
            if (!injection || typeof injection !== 'object') return;
            const profileStats = injection.profile || {};
            const section = node('section', undefined, 'pi-injection');
            section.append(node('h5', t('下一轮注入预览')));
            section.append(node('p', t('身份记忆：{0} 条 / {1} 字', Number.isFinite(profileStats.entries) ? profileStats.entries : '—',
                Number.isFinite(profileStats.chars) ? profileStats.chars : '—'), 'pi-injection-stats'));
            const details = node('details', undefined, 'pi-injection-body');
            details.append(node('summary', t('查看注入原文')), node('pre', String(injection.block || '')));
            section.append(details);
            if (injection.truncated === true) section.append(node('p', t('已截断，仅显示部分内容'), 'pi-profile-note'));
            section.append(node('p', t('注入不代表模型一定遵守。'), 'pi-profile-note'));
            box.append(section);
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
            // U2.4: draft skills awaiting review; clicking filters the learned-skill list to drafts.
            const pendingDrafts = Number.isSafeInteger(learning.drafts?.pending) ? learning.drafts.pending : 0;
            if (pendingDrafts > 0) {
                const wrap = node('div', undefined, 'pi-learning-drafts');
                wrap.append(button(t('{0} 个草稿技能待审', `${pendingDrafts}${learning.drafts.capped === true ? '+' : ''}`), async () => {
                    if (!await discard()) return;
                    kind = 'skill'; draftOnly = true; offset = 0; selected = detail = draft = null; editing = false; void load();
                }));
                box.append(wrap);
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
            for (const [key, text, min, max] of [['maxTokensPerDay', '每天最多预留 tokens', 6000, 200000], ['periodicReviewMinutes', '复盘间隔（分钟，0 为关闭）', 0, 10080],
                ['consolidationInputChars', '整理合并单次最多读取字数（预留 = 字数 + 6000 tokens）', 4000, 40000]]) {
                if (!Object.hasOwn(settings, key)) continue;
                const limit = learning.capabilities?.limits?.[key];
                const input = node('input'); input.type = 'number'; input.min = limit?.min ?? min; input.max = limit?.max ?? max; input.step = 1; input.value = learningDraft[key];
                input.disabled = learningBusy || !Number.isSafeInteger(learning.revision); input.oninput = () => { learningDraft[key] = Number(input.value); };
                form.append(field(t(text), input));
            }
            form.append(node('small', t('每次运行最多预留 {0} tokens；费用仅按供应商回报显示，未知费用不代表免费。', learning.capabilities?.reservedTokensPerRun || 6000)));
            if (settings.triggerPhrases && typeof settings.triggerPhrases === 'object') {
                const limits = learning.capabilities?.limits?.triggerPhrases || {};
                const phrases = node('details', undefined, 'pi-learning-triggers');
                phrases.open = triggersOpen; phrases.ontoggle = () => { triggersOpen = phrases.open; };
                phrases.append(node('summary', t('自定义触发词')), node('small', t('内置规则已识别常见的中文和英文说法。这里可补充你的习惯用语或其他语言，每行一个短语，不区分大小写。')));
                for (const [list, label] of [['correction', '表示纠正（立即学习）'], ['preference', '表示长期偏好（立即学习）'], ['temporary', '表示临时要求（不学习）'], ['ignore', '排除（即使命中上面也不算纠正或偏好）']]) {
                    const area = node('textarea'); area.rows = 3; area.value = (learningDraft.triggerPhrases?.[list] || []).join('\n');
                    area.disabled = learningBusy || !Number.isSafeInteger(learning.revision);
                    area.oninput = () => {
                        const lines = area.value.split('\n').map(line => line.trim()).filter(Boolean);
                        area.setCustomValidity(lines.length > (limits.maxPhrases || 50) || lines.some(line => line.length > (limits.maxLength || 80))
                            ? t('最多 {0} 个短语，每个不超过 {1} 个字符。', limits.maxPhrases || 50, limits.maxLength || 80) : '');
                        learningDraft.triggerPhrases = { ...(learningDraft.triggerPhrases || {}), [list]: lines };
                    };
                    phrases.append(field(t(label), area));
                }
                form.append(phrases);
            }
            const same = (a, b) => a === b || typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b);
            const changes = () => Object.fromEntries(Object.keys(learningDraft || {}).filter(key => Object.hasOwn(settings, key) && !same(learningDraft[key], settings[key])).map(key => [key, learningDraft[key]]));
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
            renderProposals(box);
            renderInjection(box);
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
                    job.error === 'content-blocked' ? t('内容疑似密钥或注入指令，未保存') : '',
                    job.receiptIds?.length ? t('关联回执：{0}', job.receiptIds.join(', ')) : ''].filter(Boolean).join(' · ')));
                if (!learningUncertain && job.id && learning.capabilities?.actions?.includes('cancel') && ['queued', 'running', 'pending', 'waiting-config'].includes(job.status)) row.append(button(t('取消作业'), () => void action('cancel', job.id)));
                box.append(row);
            }
            root.append(box);
        }
        async function action(name, jobId, extra = {}) {
            const supported = learning?.capabilities?.actions?.includes(name)
                || name === 'enable' && canEnable(learning)
                || ['adopt-legacy', 'dismiss-legacy'].includes(name) && Boolean(learning?.legacy)
                || ['propose-consolidation', 'dismiss-proposal'].includes(name) && proposalsSupported();
            if (learningBusy || learningUncertain || !supported) return;
            const requestId = uuid(), generation = learningEpoch;
            learningBusy = true; render(); const profileId = profile;
            try {
                const result = await apiFetch(`${base()}/learning/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, action: name, ...(jobId ? { jobId } : {}), ...extra }) });
                if (profileId !== profile || generation !== learningEpoch || !active) return;
                if (result?.version !== 1 || !Number.isSafeInteger(result.revision) || !result.settings) throw new Error(t('作业回执未确认'));
                notice = name === 'enable' ? t('已开启自学习；以学习状态为准。') : name === 'adopt-legacy' ? t('已迁移并开启学习。')
                    : name === 'dismiss-legacy' ? t('已忽略旧自动学习提示。') : name === 'propose-consolidation' ? t('整理方案生成中；完成后显示在学习区。')
                        : name === 'dismiss-proposal' ? t('已忽略该整理建议。') : t('作业请求已返回；以作业列表状态为准。');
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
