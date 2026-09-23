/* Optional profile management. The backend owns identity, revision and memory data. */
(() => {
    'use strict';
    const $ = id => document.getElementById(id);
    const t = (text, ...args) => globalThis.PiI18n?.t(text, ...args) || text;
    const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const opt = (value, label, selected) => `<option value="${html(value)}" ${selected ? 'selected' : ''}>${html(label)}</option>`;

    function create({ apiFetch, currentCwd }) {
        const nav = $('pi-profiles-nav'), root = $('pi-profiles-content'), refresh = $('pi-profiles-refresh');
        const choice = $('pi-profile-choice'), choiceSelect = $('pi-profile-choice-select');
        nav.querySelector('span').textContent = t('助手身份');
        $('pi-profiles-panel').querySelector('h3').textContent = t('助手身份');
        $('pi-profiles-panel').querySelector('.settings-panel-header p').textContent = t('身份仅在新建线程时确定。已打开的线程不会因保存设置而重新加载。');
        refresh.title = t('刷新助手身份');
        refresh.setAttribute('aria-label', t('刷新助手身份'));
        $('pi-profile-choice-title').textContent = t('新线程的助手身份');
        choice.querySelector('label').firstChild.textContent = t('助手身份');
        $('pi-profile-choice-close').setAttribute('aria-label', t('关闭'));
        $('pi-profile-choice-cancel').textContent = t('取消');
        $('pi-profile-choice-create').lastChild.textContent = ` ${t('新建线程')}`;
        $('pi-new-profile-session').title = t('选择新线程的助手身份');
        $('pi-new-profile-session').setAttribute('aria-label', t('选择新线程的助手身份'));
        $('pi-meta-profile-row').querySelector('dt').textContent = t('助手身份');
        let enabled = false, autoLearnSupported = false, visible = false, epoch = 0, memoryEpoch = 0, snapshot = null;
        let draft = null, draftOriginal = '', selected = '', kind = 'memories', query = '', offset = 0, pageOffsets = [0];
        let memory = null, choosing = null, choiceEpoch = 0, mutation = null, editorVersion = 0;
        let reconcile = null, pendingRefresh = false, loadedProfile = null, loadedKey = '';
        let displayedSession = null, displayedConnected = false, displayedKey = '';
        const defaultDrafts = new Map();

        root.innerHTML = '<p id="pi-profiles-status" role="status" aria-live="polite"></p><div id="pi-profiles-default"></div><div id="pi-profiles-list"></div><div id="pi-profiles-editor"></div><div id="pi-profiles-memory"></div>';
        const status = $('pi-profiles-status'), defaults = $('pi-profiles-default'), list = $('pi-profiles-list');
        const editor = $('pi-profiles-editor'), memoryRoot = $('pi-profiles-memory');
        const message = text => { status.textContent = text || ''; };
        const profiles = () => snapshot?.profiles || [];
        const cwd = () => currentCwd() || '';
        const active = () => enabled && visible;
        const memoryLabel = value => ({ missing: t('身份不存在'), disabled: t('身份已停用'), ready: t('可读取已保存数据'), unsupported: t('此后端不支持读取'), error: t('读取失败') })[value] || t('读取状态未知');

        function renderDefault() {
            if (!snapshot) { defaults.replaceChildren(); return; }
            const project = snapshot.cwd;
            if (!project) { defaults.innerHTML = `<p class="pi-profile-note">${html(t('选择项目后可设置新线程的默认身份。'))}</p>`; return; }
            const current = defaultDrafts.has(project) ? defaultDrafts.get(project) : snapshot.defaultProfileId;
            const missing = current && !profiles().some(p => p.id === current);
            defaults.innerHTML = `<div class="pi-profile-default"><label><strong>${html(t('此项目的新线程默认身份'))}</strong><small title="${html(project)}">${html(project)}</small><select id="pi-profile-default-select">
                ${opt('', t('无身份'), current == null)}${missing ? `<option value="${html(current)}" selected disabled>${html(t('已保存的默认身份不可用'))}</option>` : ''}${profiles().filter(p => p.enabled || p.id === current).map(p => opt(p.id, p.name + (!p.enabled ? ` (${t('已停用')})` : ''), p.id === current)).join('')}
            </select></label><button id="pi-profile-default-save" class="settings-secondary-button" type="button" ${mutation || reconcile || current === snapshot.defaultProfileId ? 'disabled' : ''}><i class="fa-solid fa-floppy-disk"></i> ${html(t('保存默认身份'))}</button></div><p class="pi-profile-note">${html(t('仅影响以后创建的线程；已有线程身份不变。'))}</p>`;
        }
        function renderList() {
            if (!snapshot) { list.replaceChildren(); return; }
            list.innerHTML = `<div class="pi-profile-toolbar"><h4>${html(t('已保存的身份'))}</h4><button id="pi-profile-add" class="settings-primary-button" type="button"><i class="fa-solid fa-plus" aria-hidden="true"></i> ${html(t('新建身份'))}</button></div>${profiles().length ? profiles().map(p => `<article class="pi-profile-row" data-profile-id="${html(p.id)}"><div><strong>${html(p.name)}</strong> <span>${html(p.enabled ? t('已启用') : t('已停用'))}</span><p>${html(p.description)}</p></div><div class="pi-profile-actions"><button type="button" data-profile-action="edit" title="${html(t('编辑身份'))}" aria-label="${html(t('编辑身份 {0}', p.name))}"><i class="fa-solid fa-pen" aria-hidden="true"></i></button><button type="button" data-profile-action="view" title="${html(t('查看记忆与技能'))}" aria-label="${html(t('查看 {0} 的记忆与技能', p.name))}"><i class="fa-solid fa-book-open" aria-hidden="true"></i></button></div></article>`).join('') : `<p class="pi-profile-note">${html(t('尚无助手身份。新线程默认不使用身份。'))}</p>`}`;
        }
        function render() { renderDefault(); renderList(); }
        async function load() {
            if (!active()) return;
            if (mutation) { pendingRefresh = true; message(t('保存结束后请刷新核对。')); return; }
            const request = ++epoch, project = cwd();
            memoryEpoch++;
            memory = null;
            if (selected && snapshot && profiles().some(p => p.id === selected)) { renderMemory(); $('pi-profile-memory-status').textContent = t('正在读取已保存数据…'); }
            else memoryRoot.replaceChildren();
            message(t('正在读取身份设置…'));
            try {
                const data = await apiFetch('/api/pi/profiles' + (project ? `?cwd=${encodeURIComponent(project)}` : ''));
                if (request !== epoch || !active() || project !== cwd()) return;
                if (data?.version !== 1 || !Array.isArray(data.profiles) || typeof data.revision !== 'string') throw new Error(t('身份接口返回了不支持的数据'));
                snapshot = data;
                if (reconcile) {
                    const input = reconcile.input;
                    const saved = reconcile.kind === 'profile' && data.profiles.find(p => input.id ? p.id === input.id : p.name === input.name);
                    const fields = p => JSON.stringify([p.name, p.description, p.soul, p.enabled, p.memory?.enabled, p.memory?.autoLearn, p.skills?.learnedEnabled]);
                    reconcile = saved && !input.id ? { ...reconcile, duplicate: true }
                        : saved && fields(saved) === fields(input) ? { ...reconcile, applied: true } : null;
                }
                render(); syncEditorSave(); message(reconcile?.duplicate ? t('可能已保存此身份。请查看列表并编辑已保存的身份，勿重复创建。') : reconcile?.applied ? t('这些修改已保存。关闭草稿后可继续编辑身份。') : '');
                invalidateLoaded();
                window.dispatchEvent(new CustomEvent('pi:native-config-saved', { detail: { scope: 'global' } }));
                if (selected && !profiles().some(p => p.id === selected)) { selected = ''; memoryRoot.replaceChildren(); }
                else if (selected) void loadMemory();
            } catch (error) {
                if (request !== epoch || !active() || project !== cwd()) return;
                reconcile ||= { kind: 'read' };
                if (snapshot?.cwd !== project) snapshot = null;
                render(); syncEditorSave(); memoryEpoch++; memory = null; memoryRoot.replaceChildren();
                message(t('身份设置读取失败：{0}', error.message));
            }
        }
        function setEnabled(value, capability = false) {
            enabled = value === true;
            autoLearnSupported = capability === true;
            if (draft && $('pi-profile-form')) {
                const checkbox = $('pi-profile-form').elements.autoLearn;
                const reason = $('pi-profile-form').querySelector('.pi-profile-auto-reason');
                checkbox.disabled = !autoLearnSupported && !draft.memory.autoLearn && !checkbox.checked;
                checkbox.closest('label').title = checkbox.disabled ? t('自动学习在此服务器上不可用') : '';
                reason.hidden = !checkbox.disabled;
            }
            nav.hidden = !enabled;
            $('pi-new-profile-session').hidden = !enabled;
            if (!enabled) { close(); snapshot = null; render(); cancelChoice(); $('pi-session-profile').hidden = true; $('pi-meta-profile-row').hidden = true; }
        }
        function open() { visible = true; if (enabled) void load(); }
        function close() { visible = false; epoch++; memoryEpoch++; }
        function syncEditorSave() {
            const button = editor.querySelector('#pi-profile-form button[type=submit]');
            if (button) button.disabled = Boolean(mutation || reconcile || !snapshot || snapshot.cwd !== cwd());
        }
        function editProfile(profile) {
            if (!snapshot || mutation || (reconcile && !reconcile.duplicate && !reconcile.applied) || snapshot.cwd !== cwd()) return;
            if (draft && JSON.stringify(readDraft()) !== draftOriginal && !confirm(t('放弃未保存的身份修改？'))) return;
            reconcile = null;
            draft = profile ? { id: profile.id, name: profile.name, description: profile.description, soul: profile.soul, enabled: profile.enabled, memory: { ...profile.memory }, skills: { ...profile.skills } } : { name: '', description: '', soul: '', enabled: true, memory: { enabled: false, autoLearn: false }, skills: { learnedEnabled: true } };
            draftOriginal = JSON.stringify(draft);
            editorVersion++;
            editor.innerHTML = `<form id="pi-profile-form" class="pi-profile-form"><div class="pi-profile-form-head"><h4>${html(profile ? t('编辑身份') : t('新建身份'))}</h4><button type="button" id="pi-profile-editor-close" class="icon-btn subtle" title="${html(t('关闭编辑'))}" aria-label="${html(t('关闭编辑'))}"><i class="fa-solid fa-xmark"></i></button></div>
                <label>${html(t('名称'))}<input name="name" maxlength="80" required value="${html(draft.name)}"></label>
                <label>${html(t('描述'))}<textarea name="description" maxlength="500" rows="2">${html(draft.description)}</textarea></label>
                <label>${html(t('行为说明（SOUL）'))}<textarea name="soul" maxlength="32768" rows="7" spellcheck="false">${html(draft.soul)}</textarea></label>
                <label class="pi-profile-check"><input name="enabled" type="checkbox" ${draft.enabled ? 'checked' : ''}>${html(t('启用身份'))}</label>
                <label class="pi-profile-check"><input name="memoryEnabled" type="checkbox" ${draft.memory.enabled ? 'checked' : ''}>${html(t('启用此身份的记忆'))}</label>
                <label class="pi-profile-check" title="${html(autoLearnSupported || draft.memory.autoLearn ? '' : t('自动学习在此服务器上不可用'))}"><input name="autoLearn" type="checkbox" ${draft.memory.autoLearn ? 'checked' : ''} ${!autoLearnSupported && !draft.memory.autoLearn ? 'disabled' : ''}>${html(t('自动学习'))}<small class="pi-profile-auto-reason" ${autoLearnSupported || draft.memory.autoLearn ? 'hidden' : ''}>${html(t('自动学习在此服务器上不可用'))}</small></label>
                <label class="pi-profile-check"><input name="learnedEnabled" type="checkbox" ${draft.skills.learnedEnabled ? 'checked' : ''}>${html(t('使用此身份的已学习技能'))}</label>
                <p class="pi-profile-note">${html(t('保存后运行中的线程不会自动重新加载身份设置。'))}</p><p id="pi-profile-editor-status" role="status" aria-live="polite"></p>
                <div class="pi-profile-form-actions"><button type="submit" class="settings-primary-button"><i class="fa-solid fa-floppy-disk"></i> ${html(t('保存身份'))}</button></div></form>`;
            editor.querySelector('[name=name]').focus({ preventScroll: true });
            syncEditorSave();
        }
        function readDraft() {
            if (!draft) return null;
            const form = $('pi-profile-form');
            if (!form) return draft;
            return { ...(draft.id ? { id: draft.id } : {}), name: form.elements.name.value.trim(), description: form.elements.description.value, soul: form.elements.soul.value,
                enabled: form.elements.enabled.checked, memory: { enabled: form.elements.memoryEnabled.checked, autoLearn: form.elements.autoLearn.checked }, skills: { learnedEnabled: form.elements.learnedEnabled.checked } };
        }
        function closeEditor() {
            if (mutation || !draft) return;
            if (JSON.stringify(readDraft()) !== draftOriginal && !confirm(t('放弃未保存的身份修改？'))) return;
            draft = null; editorVersion++; editor.replaceChildren();
            if (reconcile?.duplicate || reconcile?.applied) { reconcile = null; renderDefault(); }
        }
        async function saveProfile() {
            if (!snapshot || mutation || reconcile || !draft || snapshot.cwd !== cwd()) return;
            const input = readDraft(), revision = snapshot.revision, project = cwd(), version = editorVersion;
            if (new TextEncoder().encode(input.soul).length > 32768) { $('pi-profile-editor-status').textContent = t('行为说明不能超过 32 KiB'); return; }
            const target = $('pi-profile-editor-status');
            if (!autoLearnSupported && !draft.memory.autoLearn && input.memory.autoLearn) { target.textContent = t('自动学习在此服务器上不可用'); return; }
            const controls = [...editor.querySelectorAll('#pi-profile-form input, #pi-profile-form textarea, #pi-profile-form button')].map(node => [node, node.disabled]);
            const request = ++epoch;
            mutation = { kind: 'profile', input }; refresh.disabled = true;
            for (const [node] of controls) node.disabled = true;
            renderDefault(); target.textContent = t('正在保存…');
            try {
                const result = await apiFetch('/api/pi/profiles', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: revision, profile: input }) });
                if (request !== epoch || !active() || project !== cwd() || version !== editorVersion || snapshot?.revision !== revision) { reconcile = { kind: 'profile', input }; return; }
                snapshot = { ...snapshot, revision: result.revision, profiles: [...profiles().filter(p => p.id !== result.profile.id), result.profile] };
                draft = null; editorVersion++; editor.replaceChildren(); render(); message(t('身份已保存。运行中的线程需重新打开才能使用新设置。'));
                invalidateLoaded();
                window.dispatchEvent(new CustomEvent('pi:native-config-saved', { detail: { scope: 'global' } }));
            } catch (error) {
                reconcile = { kind: 'profile', input };
                if (request === epoch && active() && project === cwd() && version === editorVersion) target.textContent = error.status === 409 ? t('保存冲突。草稿已保留；请刷新身份列表，核对更改后再保存。') : t('保存结果未确认：{0}。请刷新核对，勿直接重复提交。', error.message);
            } finally {
                mutation = null; refresh.disabled = false;
                for (const [node, disabled] of controls) if (node.isConnected) node.disabled = disabled;
                syncEditorSave(); renderDefault();
                if (pendingRefresh || request !== epoch || project !== cwd()) { pendingRefresh = false; if (active()) void load(); }
            }
        }
        async function saveDefault() {
            const select = $('pi-profile-default-select'), button = $('pi-profile-default-save');
            if (!snapshot || mutation || reconcile || !select || !button || button.disabled || snapshot.cwd !== cwd()) return;
            const project = snapshot.cwd, id = select.value || null, revision = snapshot.revision;
            const request = ++epoch;
            mutation = { kind: 'default', input: id }; refresh.disabled = true; button.disabled = true; select.disabled = true; syncEditorSave();
            try {
                const result = await apiFetch('/api/pi/profiles/default', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: project, profileId: id, expectedRevision: revision }) });
                if (request !== epoch || !active() || cwd() !== project || snapshot?.revision !== revision) { reconcile = { kind: 'default', input: id }; return; }
                snapshot = { ...snapshot, revision: result.revision, defaultProfileId: result.defaultProfileId, cwd: result.cwd };
                defaultDrafts.delete(project);
                renderDefault(); message(t('项目默认身份已保存；已有线程不变。'));
            } catch (error) {
                reconcile = { kind: 'default', input: id };
                if (request === epoch && active() && cwd() === project) message(error.status === 409 ? t('默认身份保存冲突。选择已保留；刷新后核对再保存。') : t('保存结果未确认：{0}。请刷新核对，勿直接重复提交。', error.message));
            } finally {
                mutation = null; refresh.disabled = false; if (select.isConnected) select.disabled = false;
                syncEditorSave(); renderDefault();
                if (pendingRefresh || request !== epoch || project !== cwd()) { pendingRefresh = false; if (active()) void load(); }
            }
        }
        function renderMemory() {
            if (!selected) { memoryRoot.replaceChildren(); return; }
            const profile = profiles().find(p => p.id === selected);
            if (!profile) { memoryRoot.replaceChildren(); return; }
            memoryRoot.innerHTML = `<div class="pi-profile-memory-head"><h4>${html(profile.name)} · ${html(t('已保存数据'))}</h4><button id="pi-profile-memory-close" type="button" class="icon-btn subtle" title="${html(t('关闭浏览'))}" aria-label="${html(t('关闭浏览'))}"><i class="fa-solid fa-xmark"></i></button></div><div class="pi-profile-kinds" role="group" aria-label="${html(t('数据类别'))}"><button data-kind="memories" type="button" aria-pressed="${kind === 'memories'}">${html(t('记忆'))}</button><button data-kind="skills" type="button" aria-pressed="${kind === 'skills'}">${html(t('已学习技能'))}</button></div>
                <label class="pi-profile-search">${html(t('搜索已保存数据'))}<input id="pi-profile-query" type="search" maxlength="200" value="${html(query)}"></label><p id="pi-profile-memory-status" role="status" aria-live="polite"></p><div id="pi-profile-memory-items"></div><div class="pi-profile-pages"><button id="pi-profile-memory-prev" type="button" class="settings-secondary-button" ${!offset ? 'disabled' : ''}>${html(t('上一页'))}</button><button id="pi-profile-memory-next" type="button" class="settings-secondary-button" disabled>${html(t('下一页'))}</button></div>`;
            if (memory) showMemory();
        }
        function showMemory() {
            if (!memory || !selected || !$('pi-profile-memory-status')) return;
            $('pi-profile-memory-status').textContent = `${memoryLabel(memory.status)}${memory.reason ? ` · ${memory.reason}` : ''}`;
            $('pi-profile-memory-next').disabled = memory.status !== 'ready' || !memory.hasMore || !memory.items?.length;
            $('pi-profile-memory-items').innerHTML = memory.status === 'ready' ? (memory.items?.length ? memory.items.map(item => `<article class="pi-profile-memory-item"><strong>${html(item.kind === 'skill' ? item.name : item.target)}</strong>${item.description || item.content ? `<p>${html(item.description || item.content)}</p>` : ''}${item.source?.sessionId ? `<small>${html(t('来源线程'))}: ${html(item.source.sessionId)}</small>` : ''}</article>`).join('') : `<p class="pi-profile-note">${html(t('此页没有已保存数据'))}</p>`) : '';
        }
        async function loadMemory() {
            if (!active() || !selected) return;
            const request = ++memoryEpoch, id = selected, type = kind, search = query, page = offset;
            memory = null; renderMemory(); $('pi-profile-memory-status').textContent = t('正在读取已保存数据…');
            try {
                const data = await apiFetch(`/api/pi/profiles/${encodeURIComponent(id)}/memory?${new URLSearchParams({ kind: type, query: search, offset: String(page) })}`);
                if (request !== memoryEpoch || !active() || id !== selected || type !== kind || search !== query || page !== offset) return;
                memory = data; showMemory();
            } catch (error) {
                if (request === memoryEpoch && active() && id === selected) { memory = { status: 'error', reason: error.message }; showMemory(); }
            }
        }
        function cancelChoice() {
            choiceEpoch++;
            if (choice.open) choice.close();
            if (choosing) { choosing(null); choosing = null; }
        }
        async function chooseSession(project) {
            if (!enabled || !project) return null;
            cancelChoice();
            choice.showModal();
            $('pi-profile-choice-project').textContent = project;
            $('pi-profile-choice-state').textContent = t('正在读取项目默认身份…');
            $('pi-profile-choice-create').disabled = true;
            const request = ++choiceEpoch;
            const result = new Promise(resolve => { choosing = resolve; });
            try {
                const data = await apiFetch(`/api/pi/profiles?cwd=${encodeURIComponent(project)}`);
                if (request !== choiceEpoch || !choice.open) return result;
                if (data?.version !== 1 || !Array.isArray(data.profiles)) throw new Error(t('身份接口返回了不支持的数据'));
                choiceSelect.innerHTML = opt('default', t('使用项目默认身份'), true) + opt('none', t('无身份'), false)
                    + data.profiles.filter(p => p.enabled).map(p => opt(`profile:${p.id}`, p.name, false)).join('');
                const defaultProfile = data.profiles.find(p => p.id === data.defaultProfileId);
                const unavailable = data.defaultProfileId && (!defaultProfile || !defaultProfile.enabled);
                if (unavailable) { choiceSelect.options[0].disabled = true; choiceSelect.value = 'none'; }
                $('pi-profile-choice-state').textContent = unavailable ? t('项目默认身份不可用；请选择无身份或其他已启用身份。') : t('项目默认：{0}。身份仅在新建线程时确定。', defaultProfile?.name || t('无身份'));
                $('pi-profile-choice-create').disabled = false;
            } catch (error) {
                if (request === choiceEpoch && choice.open) $('pi-profile-choice-state').textContent = t('无法读取身份选项：{0}', error.message);
            }
            return result;
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
        defaults.addEventListener('change', event => { if (event.target.id === 'pi-profile-default-select') { if ((event.target.value || null) === snapshot.defaultProfileId) defaultDrafts.delete(snapshot.cwd); else defaultDrafts.set(snapshot.cwd, event.target.value || null); $('pi-profile-default-save').disabled = Boolean(mutation || reconcile || event.target.value === (snapshot?.defaultProfileId || '')); } });
        defaults.addEventListener('click', event => { if (event.target.closest('#pi-profile-default-save')) void saveDefault(); });
        list.addEventListener('click', event => {
            if (event.target.closest('#pi-profile-add')) return editProfile(null);
            const action = event.target.closest('[data-profile-action]'), id = action?.closest('[data-profile-id]')?.dataset.profileId;
            const profile = profiles().find(p => p.id === id);
            if (!profile) return;
            if (action.dataset.profileAction === 'edit') editProfile(profile);
            else { clearTimeout(searchTimer); selected = id; kind = 'memories'; query = ''; offset = 0; pageOffsets = [0]; memory = null; void loadMemory(); }
        });
        editor.addEventListener('click', event => { if (event.target.closest('#pi-profile-editor-close')) closeEditor(); });
        editor.addEventListener('submit', event => { event.preventDefault(); void saveProfile(); });
        memoryRoot.addEventListener('click', event => {
            if (event.target.closest('#pi-profile-memory-close')) { clearTimeout(searchTimer); selected = ''; memoryEpoch++; renderMemory(); return; }
            const type = event.target.closest('[data-kind]')?.dataset.kind;
            if (type && type !== kind) { kind = type; offset = 0; pageOffsets = [0]; void loadMemory(); }
            if (event.target.closest('#pi-profile-memory-next') && memory?.hasMore && memory.items?.length) { offset += memory.items.length; pageOffsets.push(offset); void loadMemory(); }
            if (event.target.closest('#pi-profile-memory-prev') && pageOffsets.length > 1) { pageOffsets.pop(); offset = pageOffsets.at(-1); void loadMemory(); }
        });
        let searchTimer;
        memoryRoot.addEventListener('input', event => {
            if (event.target.id !== 'pi-profile-query') return;
            const value = event.target.value, profileId = selected, category = kind;
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => { if (!active() || profileId !== selected || category !== kind || value === query) return; query = value; offset = 0; pageOffsets = [0]; void loadMemory(); }, 300);
        });
        choice.addEventListener('cancel', event => { event.preventDefault(); cancelChoice(); });
        choice.addEventListener('close', () => { if (choosing) cancelChoice(); });
        $('pi-profile-choice-close').addEventListener('click', cancelChoice);
        $('pi-profile-choice-cancel').addEventListener('click', cancelChoice);
        choice.querySelector('form').addEventListener('submit', event => {
            event.preventDefault();
            if ($('pi-profile-choice-create').disabled) return;
            const value = choiceSelect.value;
            const resolve = choosing; choosing = null; choiceEpoch++; choice.close();
            resolve?.(value === 'default' ? {} : { profileId: value === 'none' ? null : value.slice('profile:'.length) });
        });
        return { setEnabled, open, close, chooseSession, displaySession, setLoadedProfile, projectChanged() { epoch++; if (active()) void load(); } };
    }
    globalThis.PiAgentProfiles = Object.freeze({ create });
})();
