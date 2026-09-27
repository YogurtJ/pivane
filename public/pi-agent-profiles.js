/* Optional profile management. The backend owns identity, revision and memory data. */
(() => {
    'use strict';
    const $ = id => document.getElementById(id);
    const t = (text, ...args) => globalThis.PiI18n?.t(text, ...args) || text;
    const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const healthLabel = { ok: '学习正常', off: '学习已关闭', 'needs-model': '缺少学习模型配置', 'quota-exhausted': '今日学习额度已用完', failing: '最近学习连续失败', unavailable: '学习当前不可用', 'memory-full': '记忆已满' };
    const healthTone = { ok: 'ok', off: 'off', 'needs-model': 'warn', 'quota-exhausted': 'warn', failing: 'bad', unavailable: 'bad' };

    function create({ apiFetch, currentCwd }) {
        const root = $('pi-profiles-content'), refresh = $('pi-profiles-refresh');
        $('pi-profiles-panel').querySelector('h3').textContent = t('助手身份');
        $('pi-profiles-panel').querySelector('.settings-panel-header p').textContent = t('为不同的协作方式，设置专属的个性、记忆与技能。');
        refresh.innerHTML = `<i class="fa-solid fa-rotate" aria-hidden="true"></i><span>${html(t('刷新'))}</span>`;
        refresh.title = t('刷新助手身份');
        refresh.setAttribute('aria-label', t('刷新助手身份'));
        $('pi-meta-profile-row')?.querySelector('dt')?.replaceChildren(document.createTextNode(t('助手身份')));
        let enabled = false, autoLearnSupported = false, visible = false, epoch = 0, snapshot = null;
        let draft = null, draftOriginal = '', selected = '', listQuery = '';
        let listView = false;
        let mutation = null, editorVersion = 0;
        let section = 'overview', documents = new Map(), documentEpoch = 0, proposalEpoch = 0, projects = null, proposal = null;
        let openEpoch = 0, openOptions = {};
        let healthEpoch = 0, pendingKnowledge = null;
        // A verified chat session id for the knowledge panel (U2.3); cleared when the page closes.
        let knowledgeSession = '';
        const learningHealth = new Map();
        const proposedDocuments = new Map();
        let reconcile = null, pendingRefresh = false, loadedProfile = null, loadedKey = '';
        let displayedSession = null, displayedConnected = false, displayedKey = '';

        root.innerHTML = `<p id="pi-profiles-status" role="status" aria-live="polite"></p><div class="pi-profiles-layout"><aside id="pi-profiles-list" aria-label="${html(t('身份列表'))}"></aside><div class="pi-profile-detail"><div id="pi-profiles-editor"></div><div id="pi-profile-documents"></div><div id="pi-profiles-memory"></div></div></div>`;
        const status = $('pi-profiles-status'), list = $('pi-profiles-list');
        const editor = $('pi-profiles-editor'), memoryRoot = $('pi-profiles-memory'), documentRoot = $('pi-profile-documents');
        const knowledgePanel = window.PiProfileKnowledge.create({ apiFetch, root: memoryRoot });
        const message = text => { status.textContent = text || ''; };
        const profiles = () => snapshot?.profiles || [];
        const cwd = () => currentCwd() || '';
        const active = () => enabled && visible;

        function renderList() {
            const searchFocused = document.activeElement?.id === 'pi-profile-list-query';
            root.classList.toggle('has-profile', Boolean(draft) && !listView);
            if (!snapshot) { list.replaceChildren(); return; }
            list.innerHTML = `<div class="pi-profile-toolbar"><h4>${html(t('身份列表'))}<span class="pi-profile-count">${profiles().length}</span></h4><button id="pi-profile-add" class="settings-primary-button" type="button"><i class="fa-solid fa-plus" aria-hidden="true"></i> ${html(t('新建'))}</button></div><label class="pi-profile-list-search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input type="search" id="pi-profile-list-query" placeholder="${html(t('搜索身份'))}" aria-label="${html(t('搜索身份'))}" value="${html(listQuery)}"></label><div class="pi-profile-rows">${profiles().map(p => `<button class="pi-profile-row" type="button" data-profile-id="${html(p.id)}" aria-current="${selected === p.id}"><span class="pi-profile-avatar">${avatar(p)}</span><span class="pi-profile-row-copy"><strong>${html(p.name)}</strong><small>${html(p.description || t('尚未填写描述'))}</small><span class="pi-profile-row-state">${healthDot(p.id)}${html(p.enabled ? t('已启用') : t('已停用'))}${html(healthNote(p.id))}</span>${draftNote(p.id)}</span><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>`).join('')}</div><p class="pi-profile-note pi-profile-list-empty" ${profiles().length ? 'hidden' : ''}>${html(t('尚无助手身份。'))}</p>${profiles().length ? '' : `<button type="button" class="settings-secondary-button" data-profile-assist>${html(t('与 Agent 起草'))}</button>`}`;
            filterList();
            if (searchFocused) $('pi-profile-list-query')?.focus({ preventScroll: true });
            if (draft && listView) {
                const resume = document.createElement('button'); resume.type = 'button'; resume.className = 'settings-secondary-button pi-profile-resume'; resume.textContent = t('继续编辑');
                resume.onclick = () => { listView = false; renderList(); }; list.querySelector('.pi-profile-toolbar').after(resume);
            }
        }
        function filterList() {
            const query = listQuery.trim().toLocaleLowerCase();
            let count = 0;
            for (const row of list.querySelectorAll('[data-profile-id]')) {
                const profile = profiles().find(p => p.id === row.dataset.profileId);
                row.hidden = !`${profile.name} ${profile.description || ''}`.toLocaleLowerCase().includes(query);
                if (!row.hidden) count++;
            }
            const empty = list.querySelector('.pi-profile-list-empty');
            if (empty) { empty.hidden = count > 0; empty.textContent = t(profiles().length ? '没有匹配的身份，请尝试其他关键词。' : '尚无助手身份。'); }
        }
        // Draft learned skills awaiting review (U2.4); clicking the badge filters the skill list.
        function draftNote(profileId) {
            const drafts = learningHealth.get(profileId)?.drafts;
            return Number.isSafeInteger(drafts?.pending) && drafts.pending > 0
                ? `<span class="pi-profile-drafts">${html(t('{0} 个草稿技能待审', `${drafts.pending}${drafts.capped === true ? '+' : ''}`))}</span>` : '';
        }
        const attentionStates = new Set(['needs-model', 'quota-exhausted', 'failing', 'unavailable']);
        function healthNote(profileId) {
            const health = learningHealth.get(profileId);
            return health?.state && attentionStates.has(health.state) ? ` · ${t(healthLabel[health.state] || '学习当前不可用')}` : '';
        }
        function healthDot(profileId) {
            const health = learningHealth.get(profileId);
            if (!health?.state) return '';
            const reason = html(t(healthLabel[health.state] || '学习当前不可用'));
            return `<span class="pi-health-dot pi-health-${healthTone[health.state] || 'off'}" title="${reason}" aria-label="${reason}"></span>`;
        }
        // Health and draft counts live in the learning snapshot; absent fields keep the plain list (older backends).
        async function loadLearningHealth() {
            const request = ++healthEpoch, ids = profiles().map(p => p.id);
            const rows = await Promise.all(ids.map(id => apiFetch(`/api/pi/profiles/${encodeURIComponent(id)}/learning`)
                .then(data => [id, data?.health?.state || Number.isSafeInteger(data?.drafts?.pending) ? {
                    state: data?.health?.state ? String(data.health.state) : null,
                    drafts: Number.isSafeInteger(data?.drafts?.pending) ? { pending: data.drafts.pending, capped: data.drafts.capped === true } : null } : null])
                .catch(() => [id, null])));
            if (request !== healthEpoch || !active()) return;
            for (const [id, health] of rows) learningHealth.set(id, health);
            renderList();
        }
        async function openKnowledge() {
            const pending = pendingKnowledge?.profileId === selected ? pendingKnowledge : null;
            if (pending) pendingKnowledge = null;
            const profileId = selected;
            await knowledgePanel.open(selected, { ...(knowledgeSession ? { sessionId: knowledgeSession } : {}),
                ...(pending?.project ? { kind: 'memory' } : {}), ...(pending?.drafts ? { drafts: true } : {}) });
            if (pending?.itemId && active() && selected === profileId && section === 'skills') knowledgePanel.reveal?.(pending.itemId, pending.kind, pending.sessionId);
        }
        function revealKnowledge(profileId, itemId, kind, sessionId) {
            pendingKnowledge = profileId && itemId ? { profileId, itemId, kind, sessionId } : null;
            if (sessionId) knowledgeSession = String(sessionId);
            if (pendingKnowledge && active() && selected === profileId && section === 'skills') openKnowledge();
        }
        function revealProjectMemory(profileId, sessionId) {
            pendingKnowledge = profileId ? { profileId, project: true, sessionId } : null;
            if (sessionId) knowledgeSession = String(sessionId);
            if (pendingKnowledge && active() && selected === profileId && section === 'skills') openKnowledge();
        }
        function renderEmptyDetail() {
            if (!draft && snapshot) editor.innerHTML = `<div class="pi-profile-empty"><span class="pi-profile-empty-icon"><i class="fa-solid fa-user-gear" aria-hidden="true"></i></span><h4>${html(t('让助手更懂你的工作方式'))}</h4><p>${html(t('选择一个身份，调整它的行为、偏好和长期记忆。'))}</p><button type="button" class="settings-primary-button" data-profile-create><i class="fa-solid fa-plus" aria-hidden="true"></i> ${html(t('新建身份'))}</button><div class="pi-profile-empty-guide"><span>${html(t('个性与行为'))}<small>${html(t('设定协作方式'))}</small></span><span>${html(t('偏好与记忆'))}<small>${html(t('积累长期了解'))}</small></span><span>${html(t('学习与技能'))}<small>${html(t('管理可复用经验'))}</small></span></div></div>`;
        }
        function avatar(p) {
            if (p.avatar?.kind === 'emoji') return html(p.avatar.value);
            if (p.avatar?.kind === 'image') return `<img src="/api/pi/profiles/${encodeURIComponent(p.id)}/avatar?version=${encodeURIComponent(p.avatar.version)}" alt="">`;
            return html(p.name?.trim().slice(0, 1).toUpperCase() || '?');
        }
        function render() { renderList(); renderEmptyDetail(); }
        async function load() {
            if (!active()) return;
            if (mutation) { pendingRefresh = true; message(t('保存结束后请刷新核对。')); return; }
            const request = ++epoch, project = cwd();
            if (section === 'skills' && selected && snapshot && profiles().some(p => p.id === selected)) knowledgePanel.close();
            else memoryRoot.replaceChildren();
            message(t('正在读取身份设置…'));
            try {
                const data = await apiFetch('/api/pi/profiles' + (project ? `?cwd=${encodeURIComponent(project)}` : ''));
                if (request !== epoch || !active() || project !== cwd()) return;
                if (data?.version !== 1 || !Array.isArray(data.profiles) || typeof data.revision !== 'string') throw new Error(t('身份接口返回了不支持的数据'));
                snapshot = data;
                if (reconcile?.kind === 'profile') {
                    const input = reconcile.input;
                    const saved = reconcile.kind === 'profile' && data.profiles.find(p => input.id ? p.id === input.id : p.name === input.name);
                    const fields = p => JSON.stringify([p.name, p.description, p.soul, p.avatar, p.enabled, p.memory, p.skills]);
                    reconcile = saved && !input.id ? { ...reconcile, duplicate: true }
                        : saved && fields(saved) === fields(input) ? { ...reconcile, applied: true } : null;
                } else reconcile = null;
                render(); syncEditorSave(); message(reconcile?.duplicate ? t('可能已保存此身份。请查看列表并编辑已保存的身份，勿重复创建。') : reconcile?.applied ? t('这些修改已保存。关闭草稿后可继续编辑身份。') : '');
                invalidateLoaded();
                window.dispatchEvent(new CustomEvent('pi:native-config-saved', { detail: { scope: 'global' } }));
                if (selected && !profiles().some(p => p.id === selected)) { selected = ''; knowledgePanel.close(); memoryRoot.replaceChildren(); }
                else if (selected && section === 'skills') openKnowledge();
                void loadLearningHealth();
                return true;
            } catch (error) {
                if (request !== epoch || !active() || project !== cwd()) return;
                reconcile ||= { kind: 'read' };
                if (snapshot?.cwd !== project) snapshot = null;
                render(); syncEditorSave(); knowledgePanel.close(); memoryRoot.replaceChildren();
                message(t('身份设置读取失败：{0}', error.message));
            }
        }
        function setEnabled(value, capability = false) {
            const wasEnabled = enabled;
            enabled = value === true;
            autoLearnSupported = capability === true;
            document.querySelectorAll('[data-manage-route="profiles"]').forEach(item => { item.hidden = !enabled; });
            if (!enabled && wasEnabled) {
                epoch++; documentEpoch++; proposalEpoch++; knowledgePanel.close();
                snapshot = null; render(); syncEditorSave();
                message(t('此服务暂不支持助手身份，未保存草稿仍保留。'));
                root.querySelectorAll('[data-profile-assist], #pi-profile-avatar-upload, #pi-profile-document-save, #pi-profile-document-sync').forEach(control => { control.disabled = true; });
                $('pi-session-profile').hidden = true; $('pi-meta-profile-row').hidden = true;
            }
            if (enabled && !wasEnabled && visible) {
                const request = openEpoch;
                void load().then(loaded => {
                    if (!loaded || request !== openEpoch || !active()) return;
                    applyOpen(request);
                    root.querySelectorAll('[data-profile-assist], #pi-profile-avatar-upload').forEach(control => { control.disabled = Boolean(mutation); });
                    if (section === 'user' || section === 'memory') renderSection();
                });
            }
        }
        function open(options = {}) {
            visible = true;
            openOptions = options;
            const request = ++openEpoch;
            if (enabled) void load().then(loaded => { if (loaded) applyOpen(request); });
        }
        async function applyOpen(request) {
            if (request !== openEpoch || !active()) return;
            const options = openOptions, requested = options.profileId;
            const target = profiles().find(p => p.id === requested);
            if (target && (!draft || draft.id !== requested) && !await editProfile(target)) return;
            if (request !== openEpoch || !active()) return;
            if (target && draft?.id === requested) { listView = false; renderList(); }
            if (options.authoringSession && !requested && (!draft || draft.id) && !await editProfile(null)) return;
            if (options.section && draft && (!requested || draft.id === requested)) void openSection(options.section);
            if (options.authoringSession && draft && (!requested || draft.id === requested)) void loadProposal(options.authoringSession);
        }
        function close() { visible = false; openEpoch++; epoch++; documentEpoch++; proposalEpoch++; knowledgeSession = ''; knowledgePanel.close(); globalThis.PiProfileDialog.cancel(); }
        const profileDirty = () => Boolean(draft && JSON.stringify(readDraft()) !== draftOriginal);
        const dirty = () => profileDirty() || [...documents.values()].some(doc => doc.dirty) || proposedDocuments.size;
        async function discard() {
            if (!dirty()) return true;
            const version = editorVersion;
            const accepted = await globalThis.PiProfileDialog.confirm({ title: t('放弃未保存的修改？'), message: t('此身份的设置或文档尚未保存。离开编辑后，这些修改将丢失。'), accept: t('放弃修改') });
            return accepted && active() && version === editorVersion && !mutation;
        }
        function syncEditorSave() {
            const button = editor.querySelector('#pi-profile-form button[type=submit]');
            if (button) button.disabled = Boolean(mutation || reconcile || !snapshot || (snapshot.cwd || '') !== cwd() || draft?.id && !profileDirty());
            for (const control of editor.querySelectorAll('#pi-profile-avatar-upload, #pi-profile-avatar-clear, [name=emoji]')) control.disabled = Boolean(mutation);
            const state = $('pi-profile-save-state');
            if (state) { state.textContent = t(profileDirty() || !draft?.id ? '有未保存的修改' : '所有身份设置已保存'); state.classList.toggle('is-dirty', profileDirty() || !draft?.id); }
        }
        async function editProfile(profile) {
            if (!snapshot || mutation || (reconcile && !reconcile.duplicate && !reconcile.applied) || (snapshot.cwd || '') !== cwd()) return false;
            if (profile?.id && profile.id === draft?.id && $('pi-profile-form')) { listView = false; renderList(); return true; }
            if (dirty() && !await discard()) return false;
            listView = false;
            reconcile = null;
            draft = profile ? { id: profile.id, name: profile.name, description: profile.description, soul: profile.soul, avatar: profile.avatar ?? null, enabled: profile.enabled, memory: { ...profile.memory }, skills: { ...profile.skills } } : { name: '', description: '', soul: '', avatar: null, enabled: true, memory: { enabled: false, autoLearn: false, memoryCharLimit: 16000, userCharLimit: 8000 }, skills: { learnedEnabled: true } };
            draftOriginal = JSON.stringify(draft);
            editorVersion++;
            selected = profile?.id || '';
            section = 'overview'; knowledgePanel.close(); documents = new Map(); proposedDocuments.clear(); documentEpoch++; proposalEpoch++; projects = null; proposal = null; renderList();
            editor.innerHTML = `<form id="pi-profile-form" class="pi-profile-form"><div class="pi-profile-form-head"><button type="button" id="pi-profile-list-back" class="icon-btn subtle" aria-label="${html(t('返回身份列表'))}" title="${html(t('返回身份列表'))}"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i></button><span class="pi-profile-avatar pi-profile-avatar-large">${avatar(draft)}</span><div class="pi-profile-heading"><h4>${html(profile ? profile.name : t('新建身份'))}</h4><p>${html(t(profile ? '管理此身份的个性、记忆与技能' : '从名称和协作方式开始'))}</p></div><button type="button" id="pi-profile-editor-close" class="icon-btn subtle" title="${html(t('关闭编辑'))}" aria-label="${html(t('关闭编辑'))}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></div>
                <nav class="pi-profile-tabs" aria-label="${html(t('档案内容'))}">${[['overview', t('概览')], ['soul', t('个性与行为')], ['user', t('用户偏好')], ['memory', t('长期记忆')], ['skills', t('学习与技能')], ['projects', t('关联项目')]].map(([id, label]) => `<button type="button" data-profile-section="${id}" aria-current="${section === id ? 'page' : 'false'}">${html(label)}</button>`).join('')}</nav>
                <div class="pi-profile-overview">
                <section class="pi-profile-card"><h5>${html(t('基本信息'))}</h5><div class="pi-profile-fields">
                <label>${html(t('名称'))}<input name="name" maxlength="80" required placeholder="${html(t('例如：研究伙伴'))}" value="${html(draft.name)}"></label>
                <label>${html(t('描述'))}<textarea name="description" maxlength="500" rows="2" placeholder="${html(t('这个助手擅长什么，与你如何协作？'))}">${html(draft.description)}</textarea></label>
                </div><div class="pi-profile-avatar-fields"><label>${html(t('头像表情'))}<input name="emoji" maxlength="16" placeholder="✦" value="${html(draft.avatar?.kind === 'emoji' ? draft.avatar.value : '')}"></label>
                <div class="pi-profile-avatar-actions">${draft.id ? `<label class="pi-profile-upload"><i class="fa-regular fa-image" aria-hidden="true"></i><span>${html(t('上传图片'))}</span><input id="pi-profile-avatar-upload" type="file" aria-label="${html(t('上传头像'))}" accept="image/png,image/jpeg,image/webp,image/gif"></label>` : ''}<button id="pi-profile-avatar-clear" type="button" class="settings-secondary-button" ${draft.avatar ? '' : 'hidden'}>${html(t('移除头像'))}</button></div></div>
                <p class="pi-profile-note">${html(t(draft.id ? '支持 PNG、JPEG、WebP、GIF，最大 6 MiB；上传后立即保存头像。' : '保存身份后可上传图片头像。'))}</p><p id="pi-profile-avatar-status" class="pi-profile-note" role="status" aria-live="polite"></p></section>
                <section class="pi-profile-card"><h5>${html(t('能力与使用'))}</h5>
                ${[['enabled', draft.enabled, '启用身份', '允许新建或重新打开的线程使用此身份。'], ['memoryEnabled', draft.memory.enabled, '长期记忆', '使用此身份保存的记忆；自动学习在“学习与技能”中设置。'], ['learnedEnabled', draft.skills.learnedEnabled, '已学习技能', '让此身份使用积累的可复用方法。']].map(([name, checked, label, note]) => `<label class="pi-profile-toggle"><span><strong>${html(t(label))}</strong><small>${html(t(note))}</small></span><input name="${name}" type="checkbox" role="switch" ${checked ? 'checked' : ''}></label>`).join('')}
                <input name="autoLearn" type="checkbox" hidden ${draft.memory.autoLearn ? 'checked' : ''}></section>
                <section class="pi-profile-card pi-profile-limits"><h5>${html(t('文档容量'))}</h5><p class="pi-profile-note">${html(t('控制长期记忆与用户偏好的字符上限。缩小上限不会删除已有内容。'))}</p><div class="pi-profile-fields">
                <label>${html(t('长期记忆 · MEMORY'))}<input type="number" name="memoryCharLimit" min="256" max="65536" required value="${draft.memory.memoryCharLimit ?? 16000}"><small>256–65,536 ${html(t('字符'))}</small></label>
                <label>${html(t('用户偏好 · USER'))}<input type="number" name="userCharLimit" min="256" max="32768" required value="${draft.memory.userCharLimit ?? 8000}"><small>256–32,768 ${html(t('字符'))}</small></label></div></section></div>
                <section class="pi-profile-soul"><div class="pi-profile-section-heading"><h5>${html(t('个性与行为'))}<span class="pi-profile-file-tag">SOUL.md</span></div><p class="pi-profile-note">${html(t('描述助手的角色、语气和协作原则。支持 Markdown。'))}</p><label for="pi-profile-soul-text" class="pi-profile-editor-label">${html(t('行为说明'))}</label><textarea id="pi-profile-soul-text" name="soul" rows="14" spellcheck="false" placeholder="${html(t('例如：用简洁的语言解释问题，在行动前澄清关键假设。'))}">${html(draft.soul)}</textarea><small class="pi-profile-note">${html(t('最多 32 KiB；与概览设置一起保存。'))}</small></section>
                <div class="pi-profile-form-actions"><div class="pi-profile-save-copy"><span id="pi-profile-save-state" role="status"></span><small>${html(t('运行中的线程需重新打开后使用新设置。'))}</small></div><button type="button" data-profile-assist class="settings-secondary-button"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> ${html(t('与 Agent 起草'))}</button><button type="submit" class="settings-primary-button"><i class="fa-solid fa-floppy-disk" aria-hidden="true"></i> ${html(t('保存身份'))}</button></div><p id="pi-profile-editor-status" role="status" aria-live="polite"></p></form>`;
            $('pi-profile-form').noValidate = true;
            renderSection();
            syncEditorSave();
            root.querySelector('.pi-profile-detail').scrollTop = 0;
            return true;
        }
        function readDraft() {
            if (!draft) return null;
            const form = $('pi-profile-form');
            if (!form) return draft;
            const emoji = form.elements.emoji.value.trim();
            return { ...(draft.id ? { id: draft.id } : {}), name: form.elements.name.value.trim(), description: form.elements.description.value, soul: form.elements.soul.value,
                avatar: emoji ? { kind: 'emoji', value: emoji } : draft.avatar?.kind === 'image' ? draft.avatar : null,
                enabled: form.elements.enabled.checked, memory: { ...draft.memory, enabled: form.elements.memoryEnabled.checked, autoLearn: form.elements.autoLearn.checked,
                    memoryCharLimit: Number(form.elements.memoryCharLimit.value), userCharLimit: Number(form.elements.userCharLimit.value) }, skills: { ...draft.skills, learnedEnabled: form.elements.learnedEnabled.checked } };
        }
        async function closeEditor() {
            if (mutation || !draft) return;
            if (dirty() && !await discard()) return;
            draft = null; selected = ''; editorVersion++; documentEpoch++; proposalEpoch++; proposedDocuments.clear(); editor.replaceChildren(); documentRoot.replaceChildren(); knowledgePanel.close(); memoryRoot.replaceChildren(); renderList(); renderEmptyDetail();
            if (reconcile?.duplicate || reconcile?.applied) reconcile = null;
            documents.clear();
            $('pi-profile-add')?.focus({ preventScroll: true });
        }
        async function saveProfile() {
            if (mutation?.kind === 'avatar') { const target = $('pi-profile-avatar-status'); if (target) target.textContent = t('请等待头像上传完成。'); return; }
            if (!snapshot || mutation || reconcile || !draft || (snapshot.cwd || '') !== cwd()) return;
            const input = readDraft(), revision = snapshot.revision, project = cwd(), version = editorVersion, savedSection = section;
            let savedProfile = null;
            const unsavedDocuments = new Map([...documents].filter(([, data]) => data.dirty));
            const stagedDocuments = new Map(proposedDocuments);
            if (new TextEncoder().encode(input.soul).length > 32768) { $('pi-profile-editor-status').textContent = t('行为说明不能超过 32 KiB'); return; }
            const target = $('pi-profile-editor-status');
            if (!autoLearnSupported && !draft.memory.autoLearn && input.memory.autoLearn) { target.textContent = t('自动学习在此服务器上不可用'); return; }
            const controls = [...editor.querySelectorAll('#pi-profile-form input, #pi-profile-form textarea, #pi-profile-form button')].map(node => [node, node.disabled]);
            const request = ++epoch;
            mutation = { kind: 'profile', input }; refresh.disabled = true;
            for (const [node] of controls) node.disabled = true;
            target.textContent = t('正在保存…');
            try {
                const result = await apiFetch('/api/pi/profiles', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: revision, profile: input }) });
                if (request !== epoch || !active() || project !== cwd() || version !== editorVersion || snapshot?.revision !== revision) { reconcile = { kind: 'profile', input }; return; }
                snapshot = { ...snapshot, revision: result.revision, profiles: profiles().some(p => p.id === result.profile.id)
                    ? profiles().map(p => p.id === result.profile.id ? result.profile : p) : [...profiles(), result.profile] };
                savedProfile = result.profile;
                draft = { id: result.profile.id, name: result.profile.name, description: result.profile.description, soul: result.profile.soul, avatar: result.profile.avatar ?? null, enabled: result.profile.enabled, memory: { ...result.profile.memory }, skills: { ...result.profile.skills } };
                selected = result.profile.id; draftOriginal = JSON.stringify(draft); editorVersion++; editor.replaceChildren(); render(); message(t('身份已保存。运行中的线程需重新打开才能使用新设置。'));
                invalidateLoaded();
                window.dispatchEvent(new CustomEvent('pi:native-config-saved', { detail: { scope: 'global' } }));
                window.dispatchEvent(new CustomEvent('workspace:agent-profiles-changed'));
            } catch (error) {
                reconcile = { kind: 'profile', input };
                if (request === epoch && active() && project === cwd() && version === editorVersion) target.textContent = error.status === 409 ? t('保存冲突。草稿已保留；请刷新身份列表，核对更改后再保存。') : t('保存结果未确认：{0}。请刷新核对，勿直接重复提交。', error.message);
            } finally {
                mutation = null; refresh.disabled = false;
                for (const [node, disabled] of controls) if (node.isConnected) node.disabled = disabled;
                if (savedProfile && active()) {
                    documents = new Map(); proposedDocuments.clear();
                    await editProfile(savedProfile);
                    if (savedSection !== 'overview') void openSection(savedSection);
                    for (const [target, data] of unsavedDocuments) documents.set(target, { ...data, status: 'conflict', message: t('档案设置已保存。请刷新文档，核对草稿后单独保存。') });
                    for (const [target, content] of stagedDocuments) proposedDocuments.set(target, content);
                }
                syncEditorSave();
                if (pendingRefresh || request !== epoch || project !== cwd()) { pendingRefresh = false; if (active()) void load(); }
            }
        }
        function documentMessage(data, fallback = '') {
            if (data?.indexSynced !== false) return fallback;
            const status = data.indexStatus === 'disabled' || data.indexStatus === 'unsupported'
                ? t('记忆检索尚未启用。') : t('检索索引需要同步。');
            return fallback ? `${fallback} · ${status}` : status;
        }
        function renderSection() {
            const form = $('pi-profile-form');
            if (!form) return;
            form.querySelector('.pi-profile-proposal')?.remove();
            form.querySelector('.pi-profile-overview').hidden = section !== 'overview';
            form.querySelector('.pi-profile-soul').hidden = section !== 'soul';
            form.querySelector('.pi-profile-form-actions').hidden = !['overview', 'soul'].includes(section);
            form.querySelectorAll('[data-profile-section]').forEach(button => button.setAttribute('aria-current', String(button.dataset.profileSection === section ? 'page' : 'false')));
            root.dataset.section = section;
            documentRoot.replaceChildren(); knowledgePanel.close(); memoryRoot.replaceChildren();
            if (!draft?.id) {
                if (!['overview', 'soul'].includes(section)) documentRoot.innerHTML = `<div class="pi-profile-placeholder"><i class="fa-regular fa-bookmark" aria-hidden="true"></i><h5>${html(t('先保存这个身份'))}</h5><p>${html(t('保存后即可编辑用户偏好、长期记忆和学习设置。'))}</p><button type="button" class="settings-secondary-button" data-profile-overview>${html(t('返回概览'))}</button></div>`;
                return;
            }
            if (section === 'user' || section === 'memory') {
                const state = documents.get(section);
                const limit = state?.usage?.limit ?? (section === 'user' ? draft.memory.userCharLimit ?? 8000 : draft.memory.memoryCharLimit ?? 16000);
                const title = t(section === 'user' ? '用户偏好' : '长期记忆');
                const unavailable = state && state.status !== 'ready' && state.status !== 'conflict';
                const statusText = state?.message || (state?.status === 'ready' ? t('已读取保存内容') : t('正在读取…'));
                const labels = { disabled: t(profiles().find(p => p.id === selected)?.enabled === false ? '请先在概览中启用此身份并保存。' : '请先在概览中启用长期记忆并保存身份。'), unsupported: t('此服务尚未安装记忆组件。'), missing: t('文档尚不可用，请刷新核对。') };
                documentRoot.innerHTML = `<div class="pi-profile-document"><div class="pi-profile-section-heading"><h4>${html(title)}</h4><span class="pi-profile-file-tag">${section.toUpperCase()}.md</span></div><p class="pi-profile-note">${html(t(section === 'user' ? '记录你的背景、偏好和习惯，让助手更了解你。支持 Markdown。' : '保存跨对话使用的长期事实与经验。支持 Markdown。'))}</p><p id="pi-profile-document-status" role="status" aria-live="polite">${html(labels[state?.status] || statusText)}</p>${state?.status === 'disabled' ? `<button type="button" data-profile-overview class="settings-secondary-button">${html(t('前往概览设置'))}</button>` : ''}<textarea id="pi-profile-document-text" aria-label="${html(title)}" spellcheck="false" ${unavailable ? 'hidden' : ''} ${state?.status !== 'ready' || mutation ? 'disabled' : ''}>${html(state?.content ?? '')}</textarea>${state?.serverContent !== undefined ? `<details class="pi-profile-server-version"><summary>${html(t('服务器最新内容'))}</summary><pre>${html(state.serverContent)}</pre></details><label class="pi-profile-check"><input id="pi-profile-document-reviewed" type="checkbox" ${state.reviewed ? 'checked' : ''}>${html(t('已核对服务器最新内容'))}</label>` : ''}<div class="pi-profile-document-footer"><div class="pi-profile-document-meta"><span id="pi-profile-document-usage">${state ? `${state.content.length} / ${limit} ${html(t('字符'))}` : ''}</span><small id="pi-profile-document-dirty">${state?.dirty ? html(t('有未保存的修改')) : ''}</small></div><div class="pi-profile-document-actions"><button id="pi-profile-document-refresh" type="button" class="settings-secondary-button" ${mutation ? 'disabled' : ''}><i class="fa-solid fa-rotate" aria-hidden="true"></i> ${html(t('刷新核对'))}</button><button id="pi-profile-document-sync" type="button" class="settings-secondary-button" ${state?.status !== 'ready' || state.indexStatus !== 'pending' ? 'hidden' : ''} ${!enabled || mutation ? 'disabled' : ''}>${html(t('同步检索索引'))}</button><button id="pi-profile-document-save" type="button" class="settings-primary-button" ${!enabled || state?.status !== 'ready' || !state.dirty || mutation || state.content.length > limit || state.serverContent !== undefined && !state.reviewed ? 'disabled' : ''}><i class="fa-solid ${mutation?.kind === 'document' ? 'fa-spinner fa-spin' : 'fa-floppy-disk'}" aria-hidden="true"></i> ${html(t(mutation?.kind === 'document' ? '正在保存…' : '保存文档'))}</button></div></div></div>`;
            } else if (section === 'projects') {
                documentRoot.innerHTML = `<div class="pi-profile-projects"><div class="pi-profile-section-heading"><h4>${html(t('关联项目'))}</h4>${projects ? `<span class="pi-profile-count">${projects.length}</span>` : ''}</div><p class="pi-profile-note">${html(t('这些项目可使用此身份，共享它的个性、偏好与经验。'))}</p>${projects?.map(p => `<article><span class="pi-profile-project-icon"><i class="fa-regular fa-folder" aria-hidden="true"></i></span><div><strong>${html(p.name)}</strong><small>${html(p.cwd)}</small>${p.description ? `<p>${html(p.description)}</p>` : ''}</div></article>`).join('') || `<div class="pi-profile-placeholder"><i class="fa-regular fa-folder-open" aria-hidden="true"></i><h5>${html(projects === null ? t('正在读取…') : t('没有关联项目'))}</h5><p>${html(t('在“助手对话”中创建项目，并选择此身份。'))}</p></div>`}</div>`;
            } else if (section === 'skills') { openKnowledge(); }
            if (proposal) showProposal();
        }
        function showProposal() {
            const form = $('pi-profile-form');
            if (!form || !proposal || !['overview', 'soul'].includes(section)) return;
            form.querySelector('.pi-profile-proposal')?.remove();
            const box = document.createElement('div'); box.className = 'pi-profile-proposal';
            box.innerHTML = `<h4>${html(t('Agent 草稿'))}</h4><pre></pre><button type="button" id="pi-profile-proposal-apply" class="settings-secondary-button">${html(t('导入到未保存草稿'))}</button>`;
            box.querySelector('pre').textContent = JSON.stringify(proposal.proposal, null, 2);
            form.querySelector('.pi-profile-form-actions').before(box);
        }
        async function openSection(next) {
            if (section === next || mutation) return;
            section = next; const request = ++documentEpoch, id = selected;
            root.querySelector('.pi-profile-detail').scrollTop = 0;
            if (next === 'skills') knowledgePanel.close();
            if (draft) { draft = readDraft(); renderSection(); }
            if (!active() || !id) return;
            if ((next === 'user' || next === 'memory') && !documents.has(next)) {
                try {
                    const data = await apiFetch(`/api/pi/profiles/${encodeURIComponent(id)}/documents?target=${next}`);
                    if (request !== documentEpoch || id !== selected || next !== section || !active()) return;
                    const proposed = proposedDocuments.get(next);
                    documents.set(next, { ...data, savedContent: data.content ?? '', content: proposed ?? data.content ?? '', dirty: proposed !== undefined, message: data.status === 'ready' ? documentMessage(data) : data.status });
                    proposedDocuments.delete(next); renderSection();
                } catch (error) { if (request === documentEpoch && id === selected) { documents.set(next, { status: 'error', content: '', message: error.message }); renderSection(); } }
            } else if (next === 'projects') {
                try {
                    const data = await apiFetch(`/api/pi/assistant-projects?profileId=${encodeURIComponent(id)}`);
                    if (request !== documentEpoch || id !== selected || next !== section || !active()) return;
                    projects = data.projects || []; renderSection();
                } catch (error) { if (request === documentEpoch && id === selected) { projects = []; message(error.message); renderSection(); } }
            }
        }
        async function saveDocument() {
            const target = section, state = documents.get(target), id = selected;
            if (!active() || !state?.dirty || state.status !== 'ready' || mutation || state.serverContent !== undefined && !state.reviewed) return;
            if (state.content.length > state.usage?.limit) { state.message = t('文档超出字符上限。'); renderSection(); return; }
            mutation = { kind: 'document' }; renderSection();
            try {
                const result = await apiFetch(`/api/pi/profiles/${encodeURIComponent(id)}/documents`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target, content: state.content, expectedRevision: state.revision, expectedProfileRevision: state.profileRevision }) });
                if (id !== selected) return;
                documents.set(target, { ...result, savedContent: result.content, dirty: false, message: documentMessage(result, t('已保存')) });
            } catch (error) {
                if (error.data?.documentSaved === true && error.data.document) {
                    documents.set(target, { ...error.data.document, savedContent: error.data.document.content, indexStatus: 'pending', dirty: false,
                        message: t('文档已保存；检索索引需要同步。') });
                } else {
                    state.status = error.status === 400 ? 'ready' : 'conflict';
                    state.message = error.status === 409 ? t('文档已变化。草稿已保留；刷新档案后核对。') : error.status === 400 ? `${t('文档未保存')}：${error.message}` : t('结果未确认；草稿已保留。请刷新核对。');
                }
            }
            finally { mutation = null; if (id === selected && section === target) renderSection(); }
        }
        async function syncDocumentIndex() {
            const target = section, id = selected, previous = documents.get(target);
            if (!active() || mutation || previous?.status !== 'ready' || previous.indexStatus !== 'pending') return;
            mutation = { kind: 'index' }; renderSection();
            try {
                const current = await apiFetch(`/api/pi/profiles/${encodeURIComponent(id)}/documents?target=${target}`);
                const result = await apiFetch(`/api/pi/profiles/${encodeURIComponent(id)}/documents`, { method: 'PUT',
                    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target, content: current.content,
                        expectedRevision: current.revision, expectedProfileRevision: current.profileRevision }) });
                if (id !== selected) return;
                const keepDraft = previous.dirty && previous.content !== result.content;
                documents.set(target, { ...result, savedContent: result.content, content: keepDraft ? previous.content : result.content, dirty: Boolean(keepDraft),
                    ...(keepDraft ? { serverContent: result.content, reviewed: false } : {}),
                    message: documentMessage(result, keepDraft ? t('草稿已保留。请对照最新文档核对后再保存。') : t('检索索引已同步。')) });
            } catch (error) {
                previous.message = error.message;
            } finally { mutation = null; if (id === selected && target === section) renderSection(); }
        }
        async function refreshDocument() {
            if (mutation) return;
            const target = section, id = selected, previous = documents.get(target), request = ++documentEpoch;
            const initialContent = previous?.content;
            const button = $('pi-profile-document-refresh');
            if (button) button.disabled = true;
            try {
                const data = await apiFetch(`/api/pi/profiles/${encodeURIComponent(id)}/documents?target=${target}`);
                if (request !== documentEpoch || id !== selected || target !== section || !active()) return;
                const pending = previous?.dirty && previous.content !== data.content && data.status === 'ready';
                if (previous?.content !== initialContent || documents.get(target) !== previous) return;
                documents.set(target, { ...data, savedContent: data.content ?? '', content: pending ? previous.content : data.content ?? '', dirty: Boolean(pending),
                    ...(pending ? { serverContent: data.content ?? '', reviewed: false } : {}),
                    message: pending ? t('草稿已保留。请对照最新文档核对后再保存。') : data.status === 'ready' ? documentMessage(data, previous?.dirty ? t('这些修改已保存。') : '') : data.status });
                renderSection();
            } catch (error) { if (request === documentEpoch && id === selected && target === section && active()) $('pi-profile-document-status').textContent = error.message; }
            finally { if (button?.isConnected) button.disabled = false; }
        }
        async function uploadAvatar(file) {
            if (!active() || !file || !draft?.id || mutation) return;
            const target = $('pi-profile-avatar-status');
            if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > 6 * 1024 * 1024) {
                if (target) target.textContent = t('仅支持不超过 6 MiB 的 PNG、JPEG、WebP 或 GIF。');
                return;
            }
            const id = selected, revision = snapshot.revision;
            mutation = { kind: 'avatar' }; syncEditorSave();
            if (target) target.textContent = t('正在处理并上传头像…');
            try {
                const bitmap = await createImageBitmap(file);
                let dataUrl;
                try {
                    for (const size of [1024, 768, 512, 384, 256]) {
                        const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
                        const canvas = document.createElement('canvas');
                        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
                        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
                        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                        dataUrl = canvas.toDataURL('image/png');
                        if (dataUrl.length <= 1.4 * 1024 * 1024) break;
                    }
                } finally { bitmap.close(); }
                if (dataUrl.length > 1.4 * 1024 * 1024) throw new Error(t('转换后的 PNG 超过 1 MiB，请选择较小的图片。'));
                if (id !== selected || !active()) return;
                const result = await apiFetch(`/api/pi/profiles/${encodeURIComponent(id)}/avatar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: revision, dataUrl }) });
                if (id !== selected || !active()) return;
                snapshot = { ...snapshot, revision: result.revision, profiles: profiles().map(p => p.id === id ? result.profile : p) };
                draft.avatar = result.profile.avatar; draftOriginal = JSON.stringify({ ...JSON.parse(draftOriginal), avatar: result.profile.avatar });
                const emoji = $('pi-profile-form')?.elements.emoji; if (emoji) emoji.value = '';
                const preview = $('pi-profile-form')?.querySelector('.pi-profile-avatar-large'); if (preview) preview.innerHTML = avatar(draft);
                $('pi-profile-avatar-clear').hidden = false;
                renderList();
                if (target?.isConnected) target.textContent = t('头像已单独保存；其他修改请点击保存身份。');
                window.dispatchEvent(new CustomEvent('workspace:agent-profiles-changed'));
            } catch (error) {
                if (target?.isConnected) target.textContent = `${t('头像未保存；其他草稿仍在')}：${error.message}`;
            } finally { mutation = null; syncEditorSave(); }
        }
        async function assist() {
            if (!active() || mutation) return;
            const input = readDraft() || { name: '', description: '', soul: '' }, id = selected;
            mutation = { kind: 'authoring' };
            document.querySelectorAll('#pi-profiles-content [data-profile-assist]').forEach(button => { button.disabled = true; });
            try {
                const data = await apiFetch('/api/pi/profiles/authoring-sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: cwd() || undefined, profileId: input.id || null, language: globalThis.PiI18n?.locale === 'en' ? 'en' : 'zh-CN', draft: { ...(input.name?.trim() ? { name: input.name } : {}), description: input.description, soul: input.soul, user: documents.get('user')?.content, memory: documents.get('memory')?.content } }) });
                if (id !== selected || !active()) return;
                if (typeof window.PiChatNavigation?.openSession !== 'function') throw new Error(t('会话导航不可用'));
                await window.PiChatNavigation.openSession({ cwd: data.session.cwd, sessionId: data.session.id, draft: data.prompt });
            } catch (error) { if (id === selected && active()) message(`${t('无法创建起草会话')}：${error.message}`); }
            finally { mutation = null; document.querySelectorAll('#pi-profiles-content [data-profile-assist]').forEach(button => { button.disabled = false; }); }
        }
        async function loadProposal(session) {
            if (!session?.id || !session?.cwd) return;
            const id = selected, request = ++proposalEpoch;
            try {
                const data = await apiFetch(`/api/pi/profiles/authoring-sessions/${encodeURIComponent(session.id)}/draft?cwd=${encodeURIComponent(session.cwd)}`);
                if (request !== proposalEpoch || !active() || selected !== id || data.profileId !== (draft?.id || null)) return;
                if (data.status !== 'ready') { message(t('尚无起草建议，请先在起草会话中完成讨论。')); return; }
                proposal = data; showProposal();
            } catch (error) { if (request === proposalEpoch) message(`${t('读取 Agent 草稿失败')}：${error.message}`); }
        }
        async function applyProposal() {
            if (!proposal || !draft || proposal.profileId !== (draft.id || null)) return;
            const id = selected, selectedProposal = proposal;
            if (draft.id && proposal.profileRevision) {
                let revision;
                try {
                    const current = await apiFetch('/api/pi/profiles');
                    revision = current.profileRevisions?.[draft.id];
                } catch (error) { message(error.message); return; }
                if (id !== selected || selectedProposal !== proposal) return;
                if (!revision || proposal.profileRevision !== revision) { message(t('档案版本已变化；请刷新核对提案。')); return; }
            }
            const input = proposal.proposal;
            const form = $('pi-profile-form'), original = JSON.parse(draftOriginal);
            for (const key of ['name', 'description', 'soul']) if (typeof input[key] === 'string' && form.elements[key].value === original[key]) form.elements[key].value = input[key];
            for (const key of ['user', 'memory']) if (typeof input[key] === 'string') {
                const doc = documents.get(key);
                if (doc?.status === 'ready' && !doc.dirty) documents.set(key, { ...doc, content: input[key], dirty: true });
                else if (!doc) proposedDocuments.set(key, input[key]);
            }
            proposal = null; renderSection(); syncEditorSave(); message(t('已导入草稿；请检查并逐项保存。'));
        }
        function displaySession(session, connected = false, key = '') {
            displayedSession = session; displayedConnected = connected; displayedKey = key;
            if (!connected || key !== loadedKey) { loadedKey = key; loadedProfile = null; }
            const badge = $('pi-session-profile');
            const row = $('pi-meta-profile-row');
            badge.hidden = !enabled || !session;
            row.hidden = badge.hidden;
            if (badge.hidden) return;
            const profile = session.ephemeral ? null : loadedProfile && Object.hasOwn(loadedProfile, 'saved') ? loadedProfile.saved : session.agentProfile;
            const name = profile ? (profile.name || t('未知身份')) : t('无身份');
            badge.textContent = profile ? `${t('身份')}: ${name}${profile.available === false || profile.enabled === false ? ` · ${t('不可用')}` : ''}` : t('无身份');
            const loaded = connected && loadedProfile?.loadedConfirmed === true;
            const comparable = loaded && (!profile || typeof loadedProfile.savedProfileRevision === 'string' && typeof loadedProfile.loadedProfileRevision === 'string');
            const matches = comparable && loadedProfile.matchesSavedProfile === true && (profile
                ? loadedProfile.loadedProfileId === profile.id && loadedProfile.savedProfileRevision === loadedProfile.loadedProfileRevision
                : loadedProfile.loadedProfileId === null);
            const loadedName = loadedProfile?.loadedProfileId ? loadedProfile.loadedProfileId === profile?.id ? t('此身份的旧设置') : loadedProfile.loadedProfileId : t('无身份');
            const detail = !comparable ? t('运行中的身份尚未核对') : matches ? t('运行中设置与已保存设置一致') : t('运行中使用：{0}；已保存设置需重新打开线程后生效', loadedName);
            badge.title = profile ? `${t('会话保存的身份')}: ${name} · ${profile.available === false || profile.enabled === false ? `${t('当前身份不可用；不会自动改用其他身份')} · ` : ''}${detail}` : t('此线程没有身份绑定；不会使用身份记忆');
            $('pi-meta-profile').textContent = `${profile ? `${t('会话保存的身份')}: ${name}${profile.available === false || profile.enabled === false ? ` · ${t('不可用')}` : ''}` : t('无身份（不使用身份记忆）')} · ${detail}`;
        }
        function invalidateLoaded() {
            loadedProfile = null;
            displaySession(displayedSession, displayedConnected, displayedKey);
        }
        function setLoadedProfile(value, key, session, connected) {
            if (!connected || !key) return;
            loadedKey = key;
            loadedProfile = value && typeof value === 'object' ? value : null;
            displaySession(session, connected, key);
        }

        refresh.addEventListener('click', () => { void load(); });
        list.addEventListener('input', event => { if (event.target.id === 'pi-profile-list-query') { listQuery = event.target.value; filterList(); } });
        list.addEventListener('click', async event => {
            if (event.target.closest('#pi-profile-add')) return editProfile(null);
            if (event.target.closest('[data-profile-assist]')) return void assist();
            const id = event.target.closest('[data-profile-id]')?.dataset.profileId;
            const profile = profiles().find(p => p.id === id);
            if (!profile) return;
            const drafts = Boolean(event.target.closest('.pi-profile-drafts'));
            if (!await editProfile(profile)) return;
            if (drafts && draft?.id === id) {
                pendingKnowledge = { profileId: id, drafts: true };
                if (section === 'skills') openKnowledge(); else void openSection('skills');
            }
        });
        editor.addEventListener('click', event => {
            if (event.target.closest('[data-profile-create]')) void editProfile(null);
            if (event.target.closest('#pi-profile-list-back')) { listView = true; renderList(); $('pi-profile-add')?.focus({ preventScroll: true }); }
            if (event.target.closest('#pi-profile-editor-close')) void closeEditor();
            if (event.target.closest('[data-profile-assist]')) void assist();
            if (event.target.closest('#pi-profile-proposal-apply')) applyProposal();
            if (event.target.closest('#pi-profile-avatar-clear')) {
                draft.avatar = null; $('pi-profile-form').elements.emoji.value = '';
                $('pi-profile-form').querySelector('.pi-profile-avatar-large').innerHTML = avatar(readDraft());
                event.target.closest('button').hidden = true;
                syncEditorSave();
            }
            const next = event.target.closest('[data-profile-section]')?.dataset.profileSection;
            if (next) void openSection(next);
        });
        editor.addEventListener('submit', event => {
            event.preventDefault();
            const form = $('pi-profile-form');
            if (!form.checkValidity()) { void openSection('overview'); form.reportValidity(); return; }
            if (draft?.id && !profileDirty()) return;
            void saveProfile();
        });
        editor.addEventListener('input', event => {
            syncEditorSave();
            if (event.target.name !== 'emoji' && event.target.name !== 'name') return;
            const preview = $('pi-profile-form')?.querySelector('.pi-profile-avatar-large'); if (preview) preview.innerHTML = avatar(readDraft());
            $('pi-profile-avatar-clear').hidden = !readDraft().avatar;
        });
        editor.addEventListener('keydown', event => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (['overview', 'soul'].includes(section)) $('pi-profile-form')?.requestSubmit(); }
        });
        editor.addEventListener('change', event => { if (event.target.id === 'pi-profile-avatar-upload') void uploadAvatar(event.target.files?.[0]); });
        documentRoot.addEventListener('input', event => {
            if (event.target.id !== 'pi-profile-document-text') return;
            const state = documents.get(section); if (!state) return;
            state.content = event.target.value; state.dirty = state.content !== state.savedContent;
            state.reviewed = false;
            const review = $('pi-profile-document-reviewed'); if (review) review.checked = false;
            const limit = state.usage?.limit ?? Infinity;
            $('pi-profile-document-usage').textContent = `${state.content.length} / ${state.usage?.limit ?? '?'} ${t('字符')}`;
            $('pi-profile-document-usage').classList.toggle('is-over-limit', state.content.length > limit);
            $('pi-profile-document-dirty').textContent = state.content.length > limit ? t('文档超出字符上限。') : state.dirty ? t('有未保存的修改') : '';
            $('pi-profile-document-save').disabled = !enabled || Boolean(mutation) || !state.dirty || state.status !== 'ready' || state.content.length > limit || state.serverContent !== undefined && !state.reviewed;
        });
        documentRoot.addEventListener('change', event => {
            if (event.target.id !== 'pi-profile-document-reviewed') return;
            const state = documents.get(section); if (!state) return;
            state.reviewed = event.target.checked;
            $('pi-profile-document-save').disabled = !enabled || Boolean(mutation) || !state.reviewed || !state.dirty || state.status !== 'ready' || state.content.length > state.usage?.limit;
        });
        documentRoot.addEventListener('click', event => {
            if (event.target.closest('[data-profile-overview]')) void openSection('overview');
            if (event.target.closest('#pi-profile-document-save')) void saveDocument();
            if (event.target.closest('#pi-profile-document-refresh')) void refreshDocument();
            if (event.target.closest('#pi-profile-document-sync')) void syncDocumentIndex();
        });
        documentRoot.addEventListener('keydown', event => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); $('pi-profile-document-save')?.click(); }
        });
        return { setEnabled, open, close, displaySession, setLoadedProfile, revealKnowledge, revealProjectMemory, projectChanged() { epoch++; if (active()) void load(); } };
    }
    globalThis.PiAgentProfiles = Object.freeze({ create });
})();
