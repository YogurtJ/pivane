/* Identity workspace. The server owns saved profiles and revisions; page modules own their drafts. */
(() => {
    'use strict';
    const $ = id => document.getElementById(id);
    const t = (text, ...args) => globalThis.PiI18n?.t(text, ...args) || String(text).replace(/\{(\d+)\}/g, (_, i) => args[i] ?? `{${i}}`);
    const healthLabel = { ok: '学习正常', off: '学习已关闭', 'needs-model': '缺少学习模型配置', 'quota-exhausted': '今日学习额度已用完', failing: '最近学习连续失败', unavailable: '学习当前不可用', 'memory-full': '记忆已满' };
    const healthShort = { ok: '正常', off: '已关闭', 'needs-model': '缺少模型', 'quota-exhausted': '额度用完', failing: '连续失败', unavailable: '不可用', 'memory-full': '记忆已满' };
    const healthTone = { ok: 'green', off: 'off', 'needs-model': 'amber', 'quota-exhausted': 'amber', failing: 'danger', unavailable: 'danger', 'memory-full': 'danger' };
    const sections = [['overview', '概览', 'compass'], ['persona', '设定', 'id-card'], ['memory', '记忆', 'brain'], ['skills', '技能', 'toolbox'], ['learning', '学习', 'seedling']];
    const clone = value => JSON.parse(JSON.stringify(value));

    function create({ apiFetch, currentCwd }) {
        const U = globalThis.PiIdentityUI, { el, icon, button, chip, card, stat, empty } = U;
        const root = $('pi-profiles-content');
        $('pi-meta-profile-row')?.querySelector('dt')?.replaceChildren(document.createTextNode(t('助手身份')));
        root.classList.add('pi-id-root');
        const list = el('aside', { id: 'pi-profiles-list', class: 'pi-id-list', 'aria-label': t('身份列表') });
        const detail = el('div', { class: 'pi-profile-detail pi-id-detail' });
        const header = el('header', { class: 'pi-id-header' });
        const tabs = el('nav', { class: 'pi-id-tabs', 'aria-label': t('身份内容') });
        const overviewRoot = el('div', { class: 'pi-id-page', dataset: { page: 'overview' }, hidden: true });
        const personaRoot = el('div', { class: 'pi-id-page', dataset: { page: 'persona' }, hidden: true });
        const knowledgeRoot = el('div', { id: 'pi-profiles-memory', class: 'pi-id-page', dataset: { page: 'memory' }, hidden: true });
        const learningRoot = el('div', { class: 'pi-id-page', dataset: { page: 'learning' }, hidden: true });
        const placeholder = el('div', { class: 'pi-id-page' });
        detail.append(header, tabs, placeholder, overviewRoot, personaRoot, knowledgeRoot, learningRoot);
        root.replaceChildren(el('div', { class: 'pi-profiles-layout' }, [list, detail]));
        const toaster = U.createToaster(root);
        let enabled = false, visible = false, snapshot = null, selected = '', lastViewed = '', draft = null, original = '';
        let section = 'overview', listView = true, listQuery = '', mutation = null, reconcile = null, proposal = null;
        let epoch = 0, openEpoch = 0, editorVersion = 0, overviewEpoch = 0, healthEpoch = 0, proposalEpoch = 0;
        let pendingRefresh = false, knowledgeSession = '', pendingReveal = null, soulPreview = false, openOptions = {}, leaveIntent = false;
        let saveBar = null, personaNotice = '', overviewData = null, receiptLimit = 6;
        const sessionProfile = window.PiProfileSessionState || window.PiProfileSession.create();
        const { displaySession, setLoadedProfile, invalidateLoaded } = sessionProfile;
        const learningHealth = new Map(), badges = new Map(), stagedDocuments = new Map();
        const profiles = () => snapshot?.profiles || [];
        const savedProfile = () => profiles().find(p => p.id === selected) || null;
        const cwd = () => currentCwd() || '';
        const active = () => enabled && visible;
        const call = (module, method, ...args) => typeof module?.[method] === 'function' ? module[method](...args) : undefined;
        const ui = {
            toast: (text, options) => toaster.show(text, options),
            confirm: options => globalThis.PiProfileDialog.confirm(options),
            navigate: (next, options) => openSection(next, options),
            openSettings: detail => window.dispatchEvent(new CustomEvent('workspace:open-settings', { detail })),
            profile: savedProfile,
            setBadge(next, value) { value == null ? badges.delete(next) : badges.set(next, value); renderTabs(); },
            scroller: detail,
        };
        const knowledge = globalThis.PiProfileKnowledge.create({ apiFetch, root: knowledgeRoot, ui });
        const learning = globalThis.PiProfileLearning.create({ apiFetch, root: learningRoot, ui });
        const busy = () => Boolean(mutation || call(knowledge, 'busy') || call(learning, 'busy'));
        const profileDirty = () => Boolean(draft && JSON.stringify(draft) !== original);
        const dirty = () => Boolean(profileDirty() || call(knowledge, 'dirty') || call(learning, 'dirty') || stagedDocuments.size);
        function avatar(profile, className = '') {
            const node = el('span', { class: `pi-id-avatar ${className}`.trim() });
            if (profile.avatar?.kind === 'image' && profile.id) node.append(el('img', { src: `/api/pi/profiles/${encodeURIComponent(profile.id)}/avatar?version=${encodeURIComponent(profile.avatar.version)}`, alt: '' }));
            else node.textContent = profile.avatar?.kind === 'emoji' ? profile.avatar.value : profile.name?.trim().slice(0, 1).toUpperCase() || '✦';
            return node;
        }
        function notice(text, actions = [], tone = 'amber') {
            return el('div', { class: 'pi-id-notice', dataset: { tone } }, [icon('circle-exclamation'), el('div', { class: 'pi-id-notice-body' }, [el('p', { text }), actions.length ? el('div', { class: 'pi-id-notice-actions' }, actions) : null])]);
        }
        function profileInput(profile) {
            return profile ? { id: profile.id, name: profile.name, description: profile.description || '', soul: profile.soul || '', avatar: profile.avatar ?? null,
                enabled: profile.enabled, memory: { memoryCharLimit: 16000, userCharLimit: 8000, ...profile.memory }, skills: { ...profile.skills } }
                : { name: '', description: '', soul: '', avatar: null, enabled: true, memory: { enabled: false, autoLearn: false, memoryCharLimit: 16000, userCharLimit: 8000 }, skills: { learnedEnabled: true } };
        }
        async function guard(current = () => true) {
            if (busy()) { ui.toast(t('正在保存，请等待服务器确认后再离开。'), { tone: 'warning' }); return false; }
            if (!dirty()) return true;
            const version = editorVersion, id = selected;
            const accepted = await ui.confirm({ title: t('放弃未保存的修改？'), message: t('此身份的设置或文档尚未保存。离开编辑后，这些修改将丢失。'), accept: t('放弃修改'), current });
            if (!current() || !accepted || version !== editorVersion || id !== selected || busy()) return false;
            discardChanges(); return true;
        }
        function discardChanges() {
            if (draft) draft = JSON.parse(original);
            stagedDocuments.clear(); call(knowledge, 'discardChanges'); call(learning, 'discardChanges');
            personaNotice = ''; renderPersona();
        }
        function renderList() {
            const focus = document.activeElement?.id === 'pi-profile-list-query';
            root.classList.toggle('has-profile', Boolean(draft) && !listView);
            const refresh = button({ label: t('刷新助手身份'), icon: 'rotate', iconOnly: true, variant: 'ghost', size: 'sm', disabled: busy(), attrs: { id: 'pi-profiles-refresh' }, onClick: () => void load() });
            list.replaceChildren(el('div', { class: 'pi-id-list-head' }, [el('h2', {}, [t('身份'), el('span', { class: 'pi-id-count', text: U.number(profiles().length) })]), refresh,
                button({ label: t('新建'), icon: 'plus', variant: 'primary', size: 'sm', attrs: { id: 'pi-profile-add' }, onClick: () => void editProfile(null) })]),
            el('label', { class: 'pi-id-search' }, [icon('magnifying-glass'), el('input', { id: 'pi-profile-list-query', class: 'pi-id-input', type: 'search', value: listQuery, placeholder: t('搜索身份'), 'aria-label': t('搜索身份'), on: { input: event => { listQuery = event.target.value; filterList(); } } })]));
            if (draft && listView) list.append(button({ label: t('继续编辑'), variant: 'quiet', onClick: () => { listView = false; renderList(); } }));
            const rows = el('div', { class: 'pi-id-list-rows' });
            for (const profile of profiles()) {
                const health = learningHealth.get(profile.id), count = health?.drafts?.pending;
                const stateDot = U.dot(healthTone[health?.health?.state] || (profile.enabled ? 'green' : 'off'), health?.health?.state ? t(healthLabel[health.health.state] || '学习当前不可用') : undefined);
                if (health?.health?.state) stateDot.classList.add('pi-health-dot');
                const meta = el('span', { class: 'pi-id-row-meta' }, [stateDot, t(profile.enabled ? '已启用' : '已停用')]);
                if (health?.health?.state && !['ok', 'off'].includes(health.health.state)) {
                    const healthChip = chip(t(healthShort[health.health.state] || '不可用'), healthTone[health.health.state] || 'amber'); healthChip.title = t(healthLabel[health.health.state] || '学习当前不可用'); meta.append(healthChip);
                }
                if (count > 0) meta.append(chip(t('{0} 待审', `${U.number(count)}${health.drafts.capped ? '+' : ''}`), 'amber', { className: 'pi-profile-drafts' }));
                rows.append(el('button', { type: 'button', class: `pi-id-row pi-profile-row${profile.enabled ? '' : ' is-disabled'}`, dataset: { profileId: profile.id }, 'aria-current': String(selected === profile.id),
                    on: { click: async event => { const drafts = Boolean(event.target.closest('.pi-profile-drafts')); if (await editProfile(profile) && drafts) void openSection('skills', { drafts: true }); } } }, [avatar(profile), el('span', { class: 'pi-id-row-copy' }, [el('span', { class: 'pi-id-row-name', text: profile.name }), el('span', { class: 'pi-id-row-desc', text: profile.description || t('尚未填写描述') }), meta])]));
            }
            list.append(rows, el('p', { class: 'pi-id-help pi-profile-list-empty' }));
            if (Array.isArray(snapshot?.trash) && snapshot.trash.length) list.append(el('details', { class: 'pi-id-list-foot' }, [el('summary', {}, [icon('trash-can'), t('回收站'), el('span', { class: 'pi-id-count', text: U.number(snapshot.trash.length) })]),
                ...snapshot.trash.map(profile => el('div', { class: 'pi-id-trash-row' }, [avatar(profile), el('span', { text: profile.name }), button({ label: t('恢复'), variant: 'ghost', size: 'sm', disabled: busy(), onClick: () => void trashAction(profile, 'restore') })]))]));
            filterList(); if (focus) $('pi-profile-list-query')?.focus({ preventScroll: true });
        }
        function filterList() {
            const query = listQuery.trim().toLocaleLowerCase(); let count = 0;
            for (const row of list.querySelectorAll('[data-profile-id]')) {
                const profile = profiles().find(p => p.id === row.dataset.profileId);
                row.hidden = !`${profile.name} ${profile.description || ''}`.toLocaleLowerCase().includes(query); if (!row.hidden) count++;
            }
            const message = list.querySelector('.pi-profile-list-empty');
            if (message) { message.hidden = count > 0; message.textContent = t(profiles().length ? '没有匹配的身份，请尝试其他关键词。' : '尚无助手身份。'); }
        }
        function renderHeader() {
            header.hidden = tabs.hidden = !draft; placeholder.hidden = Boolean(draft);
            if (!draft) {
                placeholder.replaceChildren(empty({ icon: 'user-gear', title: t('让助手更懂你的工作方式'), text: t('选择一个身份，调整它的行为、偏好和长期记忆。'), actions: [button({ label: t('新建身份'), icon: 'plus', variant: 'primary', onClick: () => void editProfile(null) })] })); return;
            }
            const profile = savedProfile() || draft, health = learningHealth.get(selected)?.health;
            const pending = learningHealth.get(selected)?.drafts?.pending;
            if (pending > 0) badges.set('skills', pending); else badges.delete('skills');
            const meta = el('div', { class: 'pi-id-header-meta' }, [chip(t(profile.enabled ? '已启用' : '已停用'), profile.enabled ? 'green' : 'off', { icon: profile.enabled ? 'circle-check' : 'circle-pause' })]);
            if (health?.state && !['ok', 'off'].includes(health.state)) { const healthChip = chip(t(healthShort[health.state] || '不可用'), healthTone[health.state]); healthChip.title = t(healthLabel[health.state] || '学习当前不可用'); meta.append(healthChip); }
            header.replaceChildren(button({ label: t('返回身份列表'), icon: 'arrow-left', iconOnly: true, variant: 'ghost', className: 'pi-id-back', attrs: { id: 'pi-profile-list-back' }, onClick: () => { listView = true; renderList(); } }), avatar(profile, 'is-lg'),
                el('div', { class: 'pi-id-header-copy' }, [el('h2', { text: profile.id ? profile.name : t('新建身份') }), el('p', { text: profile.description || t('从名称和协作方式开始') }), profile.id && meta]));
            if (profile.id) {
                const menuItems = [{ label: t('与 Agent 起草'), icon: 'wand-magic-sparkles', disabled: !enabled || busy(), onSelect: () => void assist() }];
                if (Array.isArray(snapshot?.trash)) menuItems.push({ label: t('移到回收站'), icon: 'trash-can', tone: 'danger', disabled: !enabled || busy() || Boolean(reconcile), onSelect: () => void trashAction(profile, 'trash') });
                header.append(el('div', { class: 'pi-id-header-actions' }, [button({ label: t('用此身份对话'), icon: 'comments', variant: 'primary', disabled: !enabled || !profile.enabled || busy(), title: !profile.enabled ? t('请先启用并保存此身份') : undefined, attrs: { 'data-profile-chat': '' }, onClick: () => void chat() }),
                    button({ label: t('与 Agent 起草'), icon: 'wand-magic-sparkles', className: 'pi-id-btn-collapsible', disabled: !enabled || busy(), attrs: { 'data-profile-assist': '' }, onClick: () => void assist() }), U.menu({ label: t('更多操作'), items: menuItems })]));
            }
            header.append(button({ label: t('关闭编辑'), icon: 'xmark', iconOnly: true, variant: 'ghost', attrs: { id: 'pi-profile-editor-close' }, onClick: () => void closeEditor() }));
            renderTabs();
        }
        function renderTabs() {
            tabs.replaceChildren(...sections.map(([id, label, name]) => el('button', { type: 'button', class: 'pi-id-tab', dataset: { profileSection: id }, 'aria-current': section === id ? 'page' : 'false', disabled: !draft?.id && id !== 'persona', title: !draft?.id && id !== 'persona' ? t('保存身份后可用') : undefined, on: { click: () => void openSection(id) } }, [icon(name), el('span', { text: t(label) }), badges.has(id) && el('span', { class: 'pi-id-badge', text: String(badges.get(id)) })])));
        }
        function showSection() {
            root.dataset.section = section;
            overviewRoot.hidden = !draft || section !== 'overview'; personaRoot.hidden = !draft || section !== 'persona';
            knowledgeRoot.hidden = !draft || !['memory', 'skills'].includes(section); knowledgeRoot.dataset.page = section === 'skills' ? 'skills' : 'memory';
            learningRoot.hidden = !draft || section !== 'learning'; renderTabs();
        }
        function normalizeSection(next, options = {}) {
            if (next === 'soul') return ['persona', options];
            if (next === 'user') return ['memory', { ...options, target: 'user' }];
            if (next === 'memory') return ['memory', { target: 'memory', ...options }];
            if (next === 'projects') return ['overview', { ...options, projects: true }];
            return [sections.some(([id]) => id === next) ? next : 'overview', options];
        }
        async function openSection(next, options = {}) {
            [next, options] = normalizeSection(next, options);
            if (!draft || !draft.id && next !== 'persona') return;
            // A pending save owns its page's view and draft; switching would detach the response from them.
            if (busy() && (next !== section || ['memory', 'skills'].includes(next))) { ui.toast(t('正在保存，请等待服务器确认后再离开。'), { tone: 'warning' }); return; }
            const previous = section; section = next; detail.scrollTop = 0; showSection();
            if (['memory', 'skills'].includes(previous) && !['memory', 'skills'].includes(next)) call(knowledge, 'close');
            if (previous === 'learning' && next !== 'learning') call(learning, 'close');
            const id = selected, request = openEpoch;
            if (next === 'overview') { await loadOverview(); if (options.projects && id === selected) overviewRoot.querySelector('[data-projects-card]')?.scrollIntoView({ block: 'start' }); }
            if (next === 'persona') renderPersona();
            if (next === 'memory' || next === 'skills') {
                const pending = pendingReveal?.profileId === id ? pendingReveal : null;
                if (pending) pendingReveal = null;
                const opts = { view: next, ...(knowledgeSession ? { sessionId: knowledgeSession } : {}), ...options, ...(pending?.project ? { target: 'project', sessionId: pending.sessionId } : {}) };
                await call(knowledge, 'open', id, opts);
                if (request !== openEpoch || selected !== id || section !== next || !active()) return;
                // Imported documents that the memory page could not accept earlier are handed over now.
                if (stagedDocuments.size && call(knowledge, 'stageDocuments', Object.fromEntries(stagedDocuments)) !== false) stagedDocuments.clear();
                if (pending?.itemId) call(knowledge, 'reveal', pending.itemId, pending.kind, pending.sessionId);
            }
            if (next === 'learning') await call(learning, 'open', id);
        }
        async function editProfile(profile) {
            if (!snapshot || busy() || (snapshot.cwd || '') !== cwd()) return false;
            if (profile?.id && profile.id === draft?.id) { listView = false; renderList(); return true; }
            if (!await guard()) return false;
            ++openEpoch; ++editorVersion; ++overviewEpoch; ++proposalEpoch;
            call(knowledge, 'close'); call(learning, 'close'); badges.clear();
            draft = profileInput(profile); original = JSON.stringify(draft); selected = profile?.id || ''; if (selected) lastViewed = selected;
            reconcile = null; personaNotice = ''; proposal = null; overviewData = null; receiptLimit = 6; soulPreview = false; knowledgeSession = pendingReveal?.sessionId || '';
            listView = false; section = profile ? 'overview' : 'persona'; renderList(); renderHeader(); renderPersona(); showSection();
            detail.scrollTop = 0; if (profile) void loadOverview(); return true;
        }
        async function closeEditor() {
            if (!draft || !await guard()) return;
            draft = null; selected = ''; ++editorVersion; ++overviewEpoch; ++proposalEpoch; ++openEpoch;
            reconcile = null; proposal = null; call(knowledge, 'close'); call(learning, 'close'); renderPersona(); showSection(); renderHeader(); renderList();
        }
        async function chat(projectId) {
            const id = selected;
            if (!savedProfile()?.enabled || !await guard() || id !== selected) return;
            window.PiWorkspaceRoute?.navigate('assistant', { profileId: id, ...(projectId ? { projectId } : {}) });
        }
        function field(label, name, value, attrs = {}, tag = 'input') {
            const id = `pi-profile-${name}`;
            return el('div', { class: 'pi-id-field' }, [el('label', { for: id, text: t(label) }), el(tag, { id, name, class: tag === 'textarea' ? 'pi-id-textarea' : 'pi-id-input', value, ...attrs }), attrs.type === 'number' && el('small', { text: `${U.number(attrs.min)}–${U.number(attrs.max)} ${t('字符')}` })]);
        }
        function renderPersona() {
            if (!draft) { personaRoot.replaceChildren(); return; }
            const basicFields = el('div', { class: 'pi-profile-fields' }, [field('名称', 'name', draft.name, { maxLength: 80, 'aria-required': 'true', placeholder: t('例如：研究伙伴') }),
                el('small', { id: 'pi-profile-name-error', class: 'pi-id-help', hidden: true }), field('描述', 'description', draft.description, { maxLength: 500, rows: 3, placeholder: t('这个助手擅长什么，与你如何协作？') }, 'textarea')]);
            const picker = el('div', { class: 'pi-profile-avatar-panel', hidden: true });
            const avatarButton = button({ label: t('更换头像'), variant: 'ghost', attrs: { id: 'pi-profile-avatar-picker', 'aria-expanded': 'false' }, onClick: () => { picker.hidden = !picker.hidden; avatarButton.setAttribute('aria-expanded', String(!picker.hidden)); } });
            avatarButton.className = 'pi-id-avatar is-xl'; avatarButton.setAttribute('aria-label', t('更换头像')); avatarButton.replaceChildren(...avatar(draft).childNodes);
            const updateAvatar = value => { draft.avatar = value; renderPersona(); syncSave(); };
            const avatarActions = el('div', { class: 'pi-id-toolbar' }, [button({ label: t('移除头像'), variant: 'ghost', attrs: { id: 'pi-profile-avatar-clear' }, onClick: () => updateAvatar(null) })]);
            picker.append(el('div', { class: 'pi-profile-emoji-grid' }, [...'🍀 🌿 🦉 🧠 🔭 📚 ✍️ 🧪 💡 🎯 🛠️ 🐱 🦊 🌙 ⭐ 🤖'.split(' ')].map(emoji => button({ label: emoji, variant: 'ghost', onClick: () => updateAvatar({ kind: 'emoji', value: emoji }) }))),
                field('自定义表情', 'emoji', draft.avatar?.kind === 'emoji' ? draft.avatar.value : '', { maxLength: 16 }),
                avatarActions);
            if (draft.id) {
                const upload = el('input', { id: 'pi-profile-avatar-upload', type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true, 'aria-label': t('上传头像'), on: { change: event => void uploadAvatar(event.target.files?.[0]) } });
                avatarActions.prepend(button({ label: t('上传图片'), icon: 'image', onClick: () => upload.click() }));
                picker.append(upload, el('p', { class: 'pi-id-help', text: t('图片会立即保存') }));
            } else picker.append(el('p', { class: 'pi-id-help', text: t('保存身份后可上传图片头像。') }));
            const switches = el('div', {}, [
                U.switchRow({ name: 'enabled', label: t('启用身份'), description: t('允许新建或重新打开的线程使用此身份'), checked: draft.enabled }).row,
                U.switchRow({ name: 'memoryEnabled', label: t('长期记忆'), description: t('让助手读取并积累 USER / MEMORY 里的内容'), info: t('开启后，助手每轮对话前会读取此身份的 USER.md 与 MEMORY.md，并可以把新的事实写进去。关闭后已有内容保留，USER 仍可手动编辑。'), checked: draft.memory.enabled }).row,
                U.switchRow({ name: 'learnedEnabled', label: t('已学习技能'), description: t('让助手使用此身份积累的技能'), info: t('已学习技能是此身份在协作中沉淀的可复用做法。关闭后仍会保留技能，你可以继续查看和管理。'), checked: draft.skills.learnedEnabled }).row]);
            const textarea = el('textarea', { id: 'pi-profile-soul-text', name: 'soul', class: 'pi-id-editor-text', value: draft.soul, spellcheck: 'false', 'aria-label': t('行为说明'), hidden: soulPreview });
            const preview = el('div', { class: 'pi-id-editor-preview', hidden: !soulPreview }); U.markdown(preview, draft.soul);
            const toggle = () => U.segmented({ label: t('编辑器'), value: soulPreview ? 'preview' : 'edit', items: [{ id: 'edit', label: t('编辑'), icon: 'pen' }, { id: 'preview', label: t('预览'), icon: 'eye' }], onChange: next => { soulPreview = next === 'preview'; textarea.hidden = soulPreview; preview.hidden = !soulPreview; U.markdown(preview, draft.soul); segment.replaceChildren(toggle()); } });
            const segment = el('div', {}, [toggle()]);
            const templates = globalThis.PiIdentityTemplates?.list() || [];
            const editor = el('div', { class: 'pi-id-editor' }, [el('div', { class: 'pi-id-editor-bar' }, [el('div', { class: 'pi-id-editor-tools' }, [segment, U.menu({ label: t('示例模板'), icon: 'shapes', iconOnly: false, variant: 'ghost', align: 'start', items: templates.map(template => ({ label: template.title, description: template.description, onSelect: async () => {
                const version = editorVersion, content = draft.soul;
                if (content.trim() && !await ui.confirm({ title: t('用模板替换当前内容？'), message: t('替换后仍需保存，也可以放弃修改恢复原来的内容。'), accept: t('替换') })) return;
                if (version !== editorVersion || content !== draft.soul || busy()) return;
                draft.soul = template.content; ++editorVersion; textarea.value = draft.soul; U.markdown(preview, draft.soul); syncSave();
            } })) })]), el('span', { id: 'pi-profile-soul-bytes', class: 'pi-id-editor-count' })]), textarea, preview]);
            saveBar = U.createSaveBar({ onSave: () => void saveProfile(), onDiscard: async () => { if (await guard()) renderPersona(); }, saveLabel: t(draft.id ? '保存身份' : '创建身份'), hint: t('保存后，新建或重新打开的线程会使用新设置') });
            const form = el('form', { id: 'pi-profile-form', class: 'pi-profile-form', novalidate: '', on: { submit: event => { event.preventDefault(); void saveProfile(); }, input: event => updateField(event.target), change: event => updateField(event.target) } }, [
                el('div', { class: 'pi-id-grid-2' }, [card({ title: t('基本信息'), icon: 'id-badge' }, [el('div', { class: 'pi-profile-basics' }, [avatarButton, basicFields]), picker]), card({ title: t('能力'), icon: 'sliders' }, [switches])]),
                card({ title: t('个性与行为'), icon: 'feather' }, [editor, el('p', { class: 'pi-id-help pi-profile-soul-help', text: t('描述助手的角色、语气和协作原则，支持 Markdown。') })]),
                el('details', { class: 'pi-id-card pi-profile-advanced' }, [el('summary', { text: t('高级设置') }), el('div', { class: 'pi-id-grid-2' }, [field('长期记忆 · MEMORY', 'memoryCharLimit', draft.memory.memoryCharLimit ?? 16000, { type: 'number', min: 256, max: 65536 }), field('关于你 · USER', 'userCharLimit', draft.memory.userCharLimit ?? 8000, { type: 'number', min: 256, max: 32768 })]), el('p', { class: 'pi-id-help', text: t('缩小上限不会删除已有内容') })])]);
            personaRoot.replaceChildren(el('div', { class: 'pi-id-page-head' }, [el('div', {}, [el('h3', { text: t('设定') }), el('p', { text: t('让助手按你的方式协作。') })])]), el('div', { id: 'pi-profile-persona-notice' }), form, saveBar.element);
            renderPersonaNotice(); renderProposal(); syncSave();
        }
        function updateField(input) {
            if (!draft || busy()) return;
            const name = input.name;
            if (['name', 'description', 'soul'].includes(name)) draft[name] = input.value;
            else if (name === 'emoji') draft.avatar = input.value.trim() ? { kind: 'emoji', value: input.value.trim() } : null;
            else if (name === 'enabled') draft.enabled = input.checked;
            else if (name === 'memoryEnabled') draft.memory.enabled = input.checked;
            else if (name === 'learnedEnabled') draft.skills.learnedEnabled = input.checked;
            else if (['memoryCharLimit', 'userCharLimit'].includes(name)) draft.memory[name] = Number(input.value);
            else return;
            if (name === 'emoji' || name === 'name') $('pi-profile-avatar-picker')?.replaceChildren(...avatar(draft).childNodes);
            ++editorVersion; syncSave();
        }
        function renderPersonaNotice() {
            const host = $('pi-profile-persona-notice'); if (!host) return;
            host.replaceChildren(...(personaNotice ? [notice(personaNotice, [button({ label: t('刷新核对'), icon: 'rotate', size: 'sm', onClick: () => void load() })])] : []));
        }
        function syncSave() {
            const count = $('pi-profile-soul-bytes');
            if (count && draft) { const bytes = U.bytes(draft.soul); count.textContent = `${U.number(Math.round(bytes / 102.4) / 10)} KiB / 32 KiB`; count.classList.toggle('is-over', bytes > 32768); }
            saveBar?.set({ dirty: profileDirty() || Boolean(draft && !draft.id), saving: Boolean(mutation), canSave: enabled && Boolean(snapshot) && !reconcile && U.bytes(draft?.soul || '') <= 32768 });
            for (const node of personaRoot.querySelectorAll('input,textarea,button')) if (!node.closest('.pi-id-savebar')) node.disabled = Boolean(mutation) || !enabled;
            if (saveBar) saveBar.discardButton.disabled = Boolean(mutation);
        }
        async function saveProfile() {
            if (!active() || busy() || !draft || !snapshot || reconcile || (snapshot.cwd || '') !== cwd()) return;
            const input = clone(draft); input.name = input.name.trim();
            const name = $('pi-profile-name'), nameError = $('pi-profile-name-error');
            if (!input.name || input.name.length > 80) {
                const text = t('请填写名称（最多 80 个字符）'); if (name) name.setAttribute('aria-invalid', 'true'); if (nameError) { nameError.hidden = false; nameError.textContent = text; } name?.focus(); return;
            }
            name?.removeAttribute('aria-invalid'); if (nameError) nameError.hidden = true;
            if (U.bytes(input.soul) > 32768) { personaNotice = t('行为说明不能超过 32 KiB'); renderPersonaNotice(); return; }
            if (![ ['memoryCharLimit', 65536], ['userCharLimit', 32768] ].every(([key, max]) => Number.isInteger(input.memory[key]) && input.memory[key] >= 256 && input.memory[key] <= max)) {
                personaNotice = t('请核对高级设置中的字符上限。'); renderPersonaNotice(); return;
            }
            if (draft.id && !profileDirty()) return;
            const revision = snapshot.revision, project = cwd(), version = editorVersion, request = ++epoch;
            mutation = { kind: 'profile', input }; syncSave(); renderHeader();
            let resultProfile = null;
            try {
                const result = await apiFetch('/api/pi/profiles', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: revision, profile: input }) });
                if (request !== epoch || !active() || project !== cwd() || version !== editorVersion || snapshot.revision !== revision) { reconcile = { kind: 'profile', input }; return; }
                snapshot = { ...snapshot, revision: result.revision, profiles: profiles().some(p => p.id === result.profile.id) ? profiles().map(p => p.id === result.profile.id ? result.profile : p) : [...profiles(), result.profile] };
                resultProfile = result.profile; draft = profileInput(resultProfile); selected = resultProfile.id; lastViewed = selected; original = JSON.stringify(draft); ++editorVersion;
                personaNotice = ''; reconcile = null; call(knowledge, 'profileSaved', resultProfile);
                invalidateLoaded(); ui.toast(t('身份已保存'));
                window.dispatchEvent(new CustomEvent('pi:native-config-saved', { detail: { scope: 'global' } }));
                window.dispatchEvent(new CustomEvent('workspace:agent-profiles-changed'));
            } catch (error) {
                reconcile = { kind: 'profile', input };
                personaNotice = error.status === 409 ? t('保存冲突。草稿已保留；请刷新身份列表，核对更改后再保存。') : t('保存结果未确认：{0}。请刷新核对，勿直接重复提交。', error.message);
            } finally {
                mutation = null; renderList(); renderHeader(); renderPersona();
                if (resultProfile && stagedDocuments.size) await stageDocuments(Object.fromEntries(stagedDocuments));
                if (pendingRefresh) { pendingRefresh = false; if (active()) void load(); }
            }
        }
        async function loadOverview() {
            if (!selected || !active()) return;
            const id = selected, request = ++overviewEpoch; overviewData = null; renderOverview();
            const base = `/api/pi/profiles/${encodeURIComponent(id)}`;
            const results = await Promise.allSettled([apiFetch(`${base}/knowledge?kind=memory&state=present`), apiFetch(`${base}/learning`), apiFetch(`/api/pi/assistant-projects?profileId=${encodeURIComponent(id)}`)]);
            if (request !== overviewEpoch || selected !== id || !active()) return;
            overviewData = { knowledge: results[0], learning: results[1], projects: results[2] };
            if (results[1].status === 'fulfilled') { learningHealth.set(id, results[1].value); renderHeader(); renderList(); }
            renderOverview();
        }
        function renderOverview() {
            const profile = savedProfile(); if (!profile) return;
            if (!overviewData) {
                overviewRoot.replaceChildren(el('div', { class: 'pi-id-page-head' }, [el('h3', { text: t('概览') })]));
                if (window.PiSkeleton) { const skeleton = el('div'); skeleton.innerHTML = window.PiSkeleton.html('lines', { rows: 8, label: t('正在读取…') }); overviewRoot.append(skeleton); }
                else overviewRoot.append(el('p', { class: 'pi-id-help', text: t('正在读取…') }));
                return;
            }
            const result = key => overviewData[key].status === 'fulfilled' ? overviewData[key].value : null;
            const knowledgeData = result('knowledge'), learningData = result('learning'), projectsData = result('projects');
            const counts = knowledgeData?.counts, usage = knowledgeData?.usage, health = learningData?.health;
            const projectRows = projectsData?.projects || [], pending = learningData?.drafts?.pending || 0;
            const proposals = (learningData?.proposals || []).filter(p => !p.status || ['pending', 'proposed', 'ready'].includes(p.status));
            const memoryOn = profile.memory?.enabled, skillsOn = profile.skills?.learnedEnabled !== false;
            const stats = el('div', { class: 'pi-id-stats' }, [
                stat({ icon: 'brain', label: t('记忆'), value: memoryOn ? U.number(counts?.memory?.total) : t('未启用'), detail: counts ? t('关于你 {0} · 长期 {1} · 项目 {2}', U.number(counts.memory?.user), U.number(counts.memory?.memory), U.number(counts.memory?.project)) : t('助手跨对话记住的信息'), tone: memoryOn ? 'accent' : 'off', onClick: () => void openSection(memoryOn ? 'memory' : 'persona') }),
                stat({ icon: 'toolbox', label: t('技能'), value: skillsOn ? U.number(counts?.skill?.active) : t('未启用'), badge: pending ? t('{0} 待审', U.number(pending)) : undefined, detail: t('审核后才会启用。'), tone: skillsOn ? 'blue' : 'off', onClick: () => void openSection(skillsOn ? 'skills' : 'persona', { drafts: pending > 0 }) }),
                stat({ icon: 'seedling', label: t('后台学习'), value: health ? t(healthShort[health.state] || '不可用') : '—', detail: health?.today ? t('今日 {0} / {1} 次', U.number(health.today.runs), U.number(health.today.maxRuns)) : t('对话之后整理记忆与技能草稿'), tone: healthTone[health?.state] || 'off', onClick: () => void openSection('learning') }),
                stat({ icon: 'folder', label: t('关联项目'), value: projectsData ? U.number(projectRows.length) : '—', detail: t('共享此身份的协作方式'), tone: 'violet', onClick: () => overviewRoot.querySelector('[data-projects-card]')?.scrollIntoView({ block: 'start' }) })]);
            const attention = el('div', { class: 'pi-id-attention' });
            const addAttention = (title, text, label, onClick, tone = 'amber', name = 'triangle-exclamation') => attention.append(el('div', { class: 'pi-id-attention-row', dataset: { tone } }, [icon(name), el('div', { class: 'pi-id-attention-copy' }, [el('strong', { text: title }), el('small', { text })]), button({ label, size: 'sm', onClick })]));
            if (!profile.enabled) addAttention(t('此身份已停用'), t('启用后可用于新对话。'), t('前往设定'), () => void openSection('persona'), 'neutral', 'circle-pause');
            if (health?.state === 'needs-model') {
                const names = { 'memory-correction': '纠错模型', 'memory-review': '复盘模型', 'memory-extraction': '提炼模型', correction: '纠错模型', review: '复盘模型', extraction: '提炼模型' };
                const purposes = (health.missingModels || []).map(value => t(names[typeof value === 'string' ? value : value.purpose] || '辅助模型')).join('、');
                addAttention(t('学习缺少模型'), purposes || t('请为后台学习配置辅助模型。'), t('配置模型'), () => ui.openSettings({ tab: 'models' }));
            }
            let capacityAttention = false;
            for (const target of ['user', 'memory']) {
                const capacity = usage?.[target], ratio = capacity?.limit ? capacity.chars / capacity.limit : 0;
                if (ratio >= .8) { capacityAttention = true; addAttention(t('{0}已用 {1}%', t(target === 'user' ? '关于你' : '长期记忆'), U.number(Math.round(ratio * 100))), t('整理合并相近的条目，为新内容留出空间。'), t('整理记忆'), () => void openSection('memory', { target }), ratio >= 1 ? 'danger' : 'amber'); }
            }
            if (!capacityAttention && health?.state === 'memory-full') addAttention(t('记忆已满'), t('整理合并相近的条目，为新内容留出空间。'), t('整理记忆'), () => void openSection('memory'), 'danger');
            if (pending) addAttention(t('{0} 个技能草稿等待审核', U.number(pending)), t('审核后才会启用。'), t('去审核'), () => void openSection('skills', { drafts: true }), 'blue', 'pen-ruler');
            if (proposals.length) addAttention(t('有新的记忆整理建议'), t('检查建议后再应用。'), t('查看建议'), () => void openSection('memory', { proposals: true }), 'violet', 'object-group');
            if (health?.state === 'quota-exhausted') addAttention(t('今日后台学习已暂停'), t(health.today?.exhaustedBy === 'tokens' ? '预留 tokens 用完' : '运行次数用完'), t('调整预算'), () => void openSection('learning'), 'amber', 'gauge-high');
            if (health?.state === 'failing') addAttention(t('最近学习连续失败'), t('查看运行记录，核对错误后再继续。'), t('查看记录'), () => void openSection('learning'), 'danger');
            for (const key of ['knowledge', 'learning']) if (overviewData[key].status === 'rejected') attention.append(notice(t('{0}读取失败：{1}', t(key === 'knowledge' ? '记忆' : '学习'), overviewData[key].reason.message), [button({ label: t('重试'), size: 'sm', onClick: () => void loadOverview() })]));
            if (!attention.childElementCount) attention.append(empty({ icon: 'circle-check', title: t('一切就绪'), text: t('没有需要处理的事项。'), compact: true }));
            const receipts = knowledgeData?.receipts || [], timeline = el('ol', { class: 'pi-id-timeline' });
            const operations = { create: ['新增', 'plus', 'green'], update: ['更新', 'pen', 'blue'], delete: ['删除', 'trash-can', 'danger'], restore: ['恢复', 'rotate-left', 'green'], undo: ['撤销', 'arrow-rotate-left', 'neutral'], consolidate: ['整理合并', 'object-group', 'violet'], enable: ['启用', 'toggle-on', 'green'], disable: ['停用', 'toggle-off', 'neutral'] };
            for (const receipt of receipts.slice(0, receiptLimit)) {
                const [label, name, tone] = operations[receipt.operation] || ['更新', 'pen', 'blue'];
                const origin = t(receipt.origin === 'learning' ? '后台学习' : receipt.origin === 'agent' ? '助手' : '手动');
                timeline.append(el('li', {}, [el('span', { class: 'pi-id-timeline-icon', dataset: { tone } }, [icon(name)]), el('div', { class: 'pi-id-timeline-copy' }, [
                    el('button', { type: 'button', class: 'pi-profile-receipt', on: { click: () => revealKnowledge(selected, receipt.itemId, receipt.kind, receipt.source?.sessionId || receipt.sessionId) } }, [el('strong', { text: t(receipt.kind === 'skill' ? ({ create: '新增技能', update: '更新技能', delete: '删除技能', restore: '恢复技能' }[receipt.operation] || label) : ({ create: '新增记忆', update: '更新记忆', delete: '删除记忆', restore: '恢复记忆' }[receipt.operation] || label)) }), receipt.preview ? ` “${receipt.preview}”` : '']),
                    el('small', {}, [origin, ' · ', U.time(receipt.at || receipt.createdAt)])])]));
            }
            const changes = card({ title: t('最近变化'), icon: 'clock-rotate-left', actions: receipts.length > 6 && receiptLimit === 6 ? [button({ label: t('显示更多'), size: 'sm', variant: 'ghost', onClick: () => { receiptLimit = 30; renderOverview(); } })] : [] }, [!knowledgeData ? notice(t('{0}读取失败：{1}', t('记忆'), overviewData.knowledge.reason?.message || ''), [button({ label: t('重试'), size: 'sm', onClick: () => void loadOverview() })]) : receipts.length ? timeline : empty({ icon: 'clock', title: t('还没有变化记录'), compact: true })]);
            const projectsCard = card({ title: t('关联项目'), icon: 'folder-open', subtitle: t('这些项目中的新对话会使用此身份。') }, [
                projectsData ? projectRows.length ? el('div', { class: 'pi-id-entries' }, projectRows.map(project => el('div', { class: 'pi-id-entry pi-profile-project' }, [el('div', { class: 'pi-id-entry-main' }, [el('span', { class: 'pi-id-entry-title' }, [icon('folder'), ' ', project.name]), el('span', { class: 'pi-id-entry-meta pi-profile-project-path', title: project.cwd, text: project.cwd }), el('span', { class: 'pi-id-entry-text', text: project.description || '' })]), button({ label: t('在此项目对话'), icon: 'arrow-right', variant: 'quiet', size: 'sm', onClick: () => void chat(project.id) })]))) : empty({ icon: 'folder-open', title: t('没有关联项目'), text: t('在“助手对话”中新建项目并选择此身份。'), compact: true })
                    : notice(t('关联项目读取失败：{0}', overviewData.projects.reason?.message || ''), [button({ label: t('重试'), size: 'sm', onClick: () => void loadOverview() })])]);
            projectsCard.dataset.projectsCard = '';
            overviewRoot.replaceChildren(stats, el('div', { class: 'pi-id-grid-2' }, [card({ title: t('需要处理'), icon: 'list-check' }, [attention]), changes]), projectsCard,
                card({ title: t('主线程与定时任务'), icon: 'calendar-check', actions: [button({ label: t('管理定时任务'), variant: 'quiet', size: 'sm', onClick: () => window.PiWorkspaceRoute?.navigate('cron', { profileId: selected }) })] }, [el('p', { class: 'pi-id-help', text: t('主线程按需创建，也可以指定已有线程作为定时任务的默认目标。') })]));
        }
        async function loadLearningHealth() {
            const request = ++healthEpoch;
            const rows = await Promise.all(profiles().map(profile => apiFetch(`/api/pi/profiles/${encodeURIComponent(profile.id)}/learning`).then(data => [profile.id, data]).catch(() => [profile.id, null])));
            if (request !== healthEpoch || !active()) return;
            for (const [id, data] of rows) learningHealth.set(id, data);
            renderList(); renderHeader();
        }
        async function load() {
            if (!active()) return false;
            if (busy()) { pendingRefresh = true; ui.toast(t('保存结束后请刷新核对。'), { tone: 'info' }); return false; }
            const request = ++epoch, project = cwd();
            try {
                const data = await apiFetch('/api/pi/profiles' + (project ? `?cwd=${encodeURIComponent(project)}` : ''));
                if (request !== epoch || !active() || project !== cwd()) return false;
                if (data?.version !== 1 || !Array.isArray(data.profiles) || typeof data.revision !== 'string') throw new Error(t('身份接口返回了不支持的数据'));
                snapshot = data;
                if (reconcile?.kind === 'profile') {
                    const input = reconcile.input, saved = data.profiles.find(p => input.id ? p.id === input.id : p.name === input.name);
                    // Canonical projection: the registry merges nested objects in its own key order and fills defaults.
                    const fields = p => JSON.stringify([p.name, p.description || '', p.soul || '', p.avatar ?? null, p.enabled === true,
                        [p.memory?.enabled === true, p.memory?.autoLearn === true, p.memory?.memoryCharLimit ?? 16000, p.memory?.userCharLimit ?? 8000], p.skills?.learnedEnabled !== false]);
                    reconcile = saved && !input.id ? { ...reconcile, duplicate: true } : saved && fields(saved) === fields(input) ? { ...reconcile, applied: true } : null;
                    personaNotice = reconcile?.duplicate ? t('可能已保存此身份。请查看列表并编辑已保存的身份，勿重复创建。') : reconcile?.applied ? t('这些修改已保存。关闭草稿后可继续编辑身份。') : t('草稿已保留，请核对后再保存。');
                } else { reconcile = null; if (personaNotice) personaNotice = ''; }
                if (selected && !savedProfile()) { selected = ''; if (!dirty()) { draft = null; original = ''; } }
                if (savedProfile()) call(knowledge, 'profileSaved', savedProfile());
                renderList(); renderHeader(); renderPersona(); showSection(); invalidateLoaded();
                void loadLearningHealth();
                if (section === 'overview' && selected) void loadOverview();
                return true;
            } catch (error) {
                if (request !== epoch || !active() || project !== cwd()) return false;
                reconcile ||= { kind: 'read' };
                if (snapshot?.cwd !== project) snapshot = null;
                personaNotice = t('身份设置读取失败：{0}', error.message); renderList(); renderPersonaNotice(); syncSave(); ui.toast(personaNotice, { tone: 'error' }); return false;
            }
        }
        async function trashAction(profile, operation) {
            if (!active() || busy() || reconcile || !Array.isArray(snapshot?.trash)) return;
            const id = profile.id, revision = snapshot.revision;
            if (operation === 'trash') {
                if (selected !== id || !await guard()) return;
                const accepted = await ui.confirm({ title: t('将“{0}”移到回收站？', profile.name), message: t('身份会被停用并从列表中隐藏。它的设定、记忆、技能和历史对话都会保留，可以随时从回收站恢复。已经打开的线程不受影响。'), accept: t('移到回收站') });
                if (!accepted || busy() || selected !== id || snapshot.revision !== revision) return;
            }
            mutation = { kind: operation }; renderList(); renderHeader(); syncSave();
            try {
                await apiFetch(`/api/pi/profiles/${encodeURIComponent(id)}/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: revision }) });
                if (operation === 'trash') { draft = null; selected = ''; original = ''; call(knowledge, 'close'); call(learning, 'close'); }
                ui.toast(t(operation === 'trash' ? '身份已移到回收站' : '身份已恢复')); window.dispatchEvent(new CustomEvent('workspace:agent-profiles-changed'));
            } catch (error) {
                if (error.status === 409) ui.toast(t('身份已变化，请刷新核对。'), { tone: 'warning' });
                else { reconcile = { kind: operation }; personaNotice = t('结果未确认，请刷新核对'); ui.toast(personaNotice, { tone: 'warning' }); }
            } finally { mutation = null; if (!reconcile) await load(); renderList(); renderHeader(); showSection(); renderPersonaNotice(); syncSave(); }
        }
        async function uploadAvatar(file) {
            if (!active() || !file || !draft?.id || busy() || reconcile) return;
            if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > 6 * 1024 * 1024) { ui.toast(t('仅支持不超过 6 MiB 的 PNG、JPEG、WebP 或 GIF。'), { tone: 'warning' }); return; }
            const id = selected, revision = snapshot.revision, project = cwd();
            mutation = { kind: 'avatar' }; syncSave(); renderHeader();
            try {
                const bitmap = await createImageBitmap(file); let dataUrl;
                try {
                    for (const size of [1024, 768, 512, 384, 256]) {
                        const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height)), canvas = document.createElement('canvas');
                        canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
                        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height); dataUrl = canvas.toDataURL('image/png');
                        if (dataUrl.length <= 1.4 * 1024 * 1024) break;
                    }
                } finally { bitmap.close(); }
                if (dataUrl.length > 1.4 * 1024 * 1024) throw new Error(t('转换后的 PNG 超过 1 MiB，请选择较小的图片。'));
                if (selected !== id || !active() || cwd() !== project) return;
                const result = await apiFetch(`/api/pi/profiles/${encodeURIComponent(id)}/avatar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: revision, dataUrl }) });
                if (selected !== id || !active() || cwd() !== project) return;
                snapshot = { ...snapshot, revision: result.revision, profiles: profiles().map(p => p.id === id ? result.profile : p) };
                draft.avatar = result.profile.avatar; original = JSON.stringify({ ...JSON.parse(original), avatar: result.profile.avatar }); call(knowledge, 'profileSaved', result.profile);
                ui.toast(t('头像已单独保存；其他修改请点击保存身份。')); window.dispatchEvent(new CustomEvent('workspace:agent-profiles-changed'));
            } catch (error) { ui.toast(`${t('头像未保存；其他草稿仍在')}：${error.message}`, { tone: 'warning' }); }
            finally { mutation = null; renderList(); renderHeader(); renderPersona(); }
        }
        async function assist() {
            if (!active() || busy()) return;
            const input = clone(draft || profileInput(null)), id = selected;
            mutation = { kind: 'authoring' }; renderHeader(); syncSave();
            try {
                const data = await apiFetch('/api/pi/profiles/authoring-sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: cwd() || undefined, profileId: input.id || null, language: globalThis.PiI18n?.locale === 'en' ? 'en' : 'zh-CN', draft: { ...(input.name?.trim() ? { name: input.name } : {}), description: input.description, soul: input.soul } }) });
                if (id !== selected || !active()) return;
                if (typeof window.PiChatNavigation?.openSession !== 'function') throw new Error(t('会话导航不可用'));
                // Authoring is an intentional round trip: drafts stay in memory and the proposal is imported on return.
                mutation = null; leaveIntent = true;
                await window.PiChatNavigation.openSession({ cwd: data.session.cwd, sessionId: data.session.id, draft: data.prompt });
            } catch (error) { ui.toast(`${t('无法创建起草会话')}：${error.message}`, { tone: 'error' }); }
            finally { mutation = null; leaveIntent = false; renderHeader(); syncSave(); }
        }
        async function loadProposal(session) {
            if (!session?.id || !session?.cwd) return;
            const id = selected, request = ++proposalEpoch;
            try {
                const data = await apiFetch(`/api/pi/profiles/authoring-sessions/${encodeURIComponent(session.id)}/draft?cwd=${encodeURIComponent(session.cwd)}`);
                if (request !== proposalEpoch || !active() || selected !== id || data.profileId !== (draft?.id || null)) return;
                if (data.status !== 'ready') { ui.toast(t('尚无起草建议，请先在起草会话中完成讨论。'), { tone: 'info' }); return; }
                proposal = data; await openSection('persona'); renderProposal();
            } catch (error) { if (request === proposalEpoch) ui.toast(`${t('读取 Agent 草稿失败')}：${error.message}`, { tone: 'error' }); }
        }
        function renderProposal() {
            personaRoot.querySelector('.pi-profile-proposal')?.remove(); if (!proposal) return;
            const box = notice(t('Agent 起草了新的设定'), [button({ label: t('导入到草稿'), variant: 'quiet', onClick: () => void applyProposal() }), button({ label: t('忽略'), variant: 'ghost', onClick: () => { proposal = null; renderProposal(); } })], 'blue');
            box.classList.add('pi-profile-proposal'); box.querySelector('.pi-id-notice-body').append(el('details', { class: 'pi-id-details' }, [el('summary', { text: t('预览') }), el('pre', { text: JSON.stringify(proposal.proposal, null, 2) })]));
            personaRoot.prepend(box);
        }
        async function stageDocuments(documents) {
            for (const [target, content] of Object.entries(documents)) stagedDocuments.set(target, content);
            if (!draft?.id) return;
            const id = selected;
            mutation = { kind: 'proposal' }; syncSave();
            try {
                await call(knowledge, 'open', id, { view: 'memory', target: Object.hasOwn(documents, 'user') ? 'user' : 'memory', mode: 'document' });
                if (selected !== id || !active()) return;
                // Keep the shell's copy until the memory page accepts it (it refuses while its own save is pending).
                if (call(knowledge, 'stageDocuments', documents) === false) { ui.toast(t('记忆正在保存，导入的文档已保留；保存完成后打开记忆页核对。'), { tone: 'warning' }); return; }
                stagedDocuments.clear();
                if (!['memory', 'skills'].includes(section)) call(knowledge, 'close');
            } catch (error) { ui.toast(error.message, { tone: 'error' }); }
            finally { mutation = null; syncSave(); }
        }
        async function applyProposal() {
            if (!proposal || !draft || busy() || proposal.profileId !== (draft.id || null)) return;
            const id = selected, selectedProposal = proposal, version = editorVersion;
            if (draft.id && proposal.profileRevision) {
                // Reserve before the await so no navigation or save can start until the import is applied.
                mutation = { kind: 'proposal' }; syncSave();
                try {
                    const current = await apiFetch('/api/pi/profiles');
                    if (id !== selected || selectedProposal !== proposal || version !== editorVersion || !active()) return;
                    if (!current.profileRevisions?.[draft.id] || proposal.profileRevision !== current.profileRevisions[draft.id]) { ui.toast(t('档案版本已变化；请刷新核对提案。'), { tone: 'warning' }); return; }
                } catch (error) { ui.toast(error.message, { tone: 'error' }); return; }
                finally { mutation = null; syncSave(); }
            }
            const input = proposal.proposal, baseline = JSON.parse(original), documents = {};
            for (const key of ['name', 'description', 'soul']) if (typeof input[key] === 'string' && draft[key] === baseline[key]) draft[key] = input[key];
            for (const key of ['user', 'memory']) if (typeof input[key] === 'string') documents[key] = input[key];
            proposal = null; ++editorVersion; renderPersona();
            if (Object.keys(documents).length) await stageDocuments(documents);
            ui.toast(t('已导入草稿，请检查后分别保存'));
        }
        function revealKnowledge(profileId, itemId, kind, sessionId) {
            pendingReveal = profileId && itemId ? { profileId, itemId, kind, sessionId } : null;
            if (sessionId) knowledgeSession = String(sessionId);
            if (pendingReveal && active() && selected === profileId) void openSection(kind === 'skill' ? 'skills' : 'memory');
        }
        function revealProjectMemory(profileId, sessionId) {
            knowledgeSession = sessionId ? String(sessionId) : '';
            pendingReveal = profileId ? { profileId, project: true, sessionId: knowledgeSession } : null;
            if (pendingReveal && active() && selected === profileId) void openSection('memory', { target: 'project', sessionId: knowledgeSession });
        }
        function setEnabled(value) {
            const wasEnabled = enabled; enabled = value === true; sessionProfile.setEnabled(value);
            document.querySelectorAll('[data-manage-route="profiles"]').forEach(item => { item.hidden = !enabled; });
            if (!enabled && wasEnabled) {
                ++epoch; ++openEpoch; ++overviewEpoch; ++proposalEpoch; call(knowledge, 'close'); call(learning, 'close'); snapshot = null; renderHeader();
                ui.toast(t('此服务暂不支持助手身份，未保存草稿仍保留。'), { tone: 'warning' }); syncSave();
                $('pi-session-profile').hidden = true; $('pi-meta-profile-row').hidden = true;
            }
            if (enabled && !wasEnabled && visible) open(openOptions);
        }
        function open(options = {}) {
            visible = true; openOptions = options; const request = ++openEpoch;
            if (!enabled) return;
            void load().then(async loaded => {
                if (!loaded || request !== openEpoch || !active()) return;
                const requested = profiles().find(p => p.id === options.profileId);
                const target = requested || (!draft && !window.matchMedia('(max-width: 680px)').matches ? profiles().find(p => p.id === lastViewed) || profiles()[0] : null);
                if (options.authoringSession && !options.profileId && (!draft || draft.id)) { if (!await editProfile(null)) return; }
                else if (target && !await editProfile(target)) return;
                if (requested && draft?.id === requested.id) { listView = false; renderList(); }
                if (options.section && draft && (!options.profileId || options.profileId === selected)) await openSection(options.section);
                if (pendingReveal?.profileId === selected) await openSection(pendingReveal.kind === 'skill' ? 'skills' : 'memory');
                if (options.authoringSession && draft && (!options.profileId || options.profileId === selected)) await loadProposal(options.authoringSession);
            });
        }
        async function close({ current = () => true } = {}) {
            if (!visible) return true;
            const keepDrafts = leaveIntent && !busy(); leaveIntent = false;
            if ((!keepDrafts && !await guard(current)) || !current()) return false;
            visible = false; ++openEpoch; ++epoch; ++overviewEpoch; ++proposalEpoch; knowledgeSession = '';
            call(knowledge, 'close'); call(learning, 'close'); globalThis.PiProfileDialog.cancel(); return true;
        }

        globalThis.addEventListener('beforeunload', event => { if (busy() || dirty()) { event.preventDefault(); event.returnValue = ''; } });
        personaRoot.addEventListener('keydown', event => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveProfile(); }
        });
        renderList(); renderHeader(); showSection(); setEnabled(sessionProfile.enabled);
        return { setEnabled, open, close, displaySession, setLoadedProfile, revealKnowledge, revealProjectMemory,
            projectChanged() { ++epoch; ++openEpoch; ++overviewEpoch; if (active()) open({ profileId: selected, section }); } };
    }
    globalThis.PiAgentProfiles = Object.freeze({ create });
})();
