/* Logical project UI only. Session/worker state belongs to pi-chat.js. */
(() => {
    const t = (zh, en) => globalThis.PiI18n?.locale === 'en' ? en : zh;
    const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

    function avatar(profile) {
        const span = document.createElement('span');
        span.className = 'pi-identity-avatar';
        if (profile?.avatar?.kind === 'emoji') span.textContent = profile.avatar.value;
        else if (profile?.avatar?.kind === 'image' && uuid(profile.id) && /^[a-f0-9]{64}$/i.test(profile.avatar.version)) {
            const img = document.createElement('img');
            img.src = `/api/pi/profiles/${encodeURIComponent(profile.id)}/avatar?version=${encodeURIComponent(profile.avatar.version)}`;
            img.alt = ''; span.append(img);
        } else span.textContent = (profile?.name || '?').trim().slice(0, 1).toLocaleUpperCase();
        span.setAttribute('aria-hidden', 'true');
        return span;
    }

    function renderGroups(groups, sessions, selectedId, renderSession) {
        return groups.map(group => {
            const list = sessions.get(group.id) || [];
            return `<section class="pi-project-group pi-assistant-group ${group.archived ? 'archived' : ''} ${group.id === selectedId ? 'current' : ''}" data-assistant-project-id="${escape(group.id)}">
                <div class="pi-project-group-heading"><span class="pi-project-group-icon"><i class="fa-regular fa-folder-open"></i></span>
                    <button class="pi-project-group-main" type="button" data-assistant-action="select" title="${escape(group.cwd)}"><span class="pi-project-group-copy"><strong>${escape(group.name)}</strong><small>${escape(group.cwd)}</small></span></button>
                    <span class="pi-project-session-count">${list.length}</span>
                    <button class="pi-project-new" type="button" data-assistant-action="menu" aria-haspopup="menu" aria-label="${escape(t('项目操作', 'Project actions'))}" title="${escape(t('项目操作', 'Project actions'))}"><i class="fa-solid fa-ellipsis"></i></button></div>
                <div class="pi-project-threads">${group.archived ? `<div class="pi-project-empty">${escape(t('编辑项目以恢复', 'Edit project to restore'))}</div>` : list.length ? list.map(session => renderSession(session, group.cwd)).join('') : `<div class="pi-project-empty">${escape(t('暂无线程', 'No conversations yet'))}</div>`}</div>
            </section>`;
        }).join('');
    }

    function createEditor({ apiFetch, onSaved, profileId }) {
        const dialog = document.createElement('dialog');
        dialog.className = 'pi-assistant-project-editor';
        dialog.setAttribute('aria-labelledby', 'pi-assistant-project-editor-title');
        dialog.innerHTML = `<form method="dialog" class="pi-assistant-project-form">
            <header><h2 id="pi-assistant-project-editor-title"></h2><button type="button" data-close class="icon-btn subtle" aria-label="${t('关闭', 'Close')}"><i class="fa-solid fa-xmark"></i></button></header>
            <label>${t('名称', 'Name')}<input name="name" maxlength="80" required></label>
            <label>${t('项目目录', 'Project directory')}<input name="cwd" required spellcheck="false"></label>
            <label>${t('描述', 'Description')}<textarea name="description" maxlength="500" rows="2"></textarea></label>
            <label>${t('项目附加指令', 'Additional project instructions')}<textarea name="instructions" rows="6" spellcheck="false"></textarea></label>
            <label class="pi-assistant-archive"><input name="archived" type="checkbox">${t('归档项目', 'Archive project')}</label>
            <p data-status role="status"></p><footer><button type="submit" class="settings-primary-button">${t('保存项目', 'Save project')}</button></footer>
        </form>`;
        document.body.append(dialog);
        const form = dialog.querySelector('form'), status = dialog.querySelector('[data-status]');
        let project = null, revision = null, saving = false;
        dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
        dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (saving) return;
            const name = form.elements.name.value.trim(), cwd = form.elements.cwd.value.trim();
            const description = form.elements.description.value, instructions = form.elements.instructions.value;
            if (!name || !cwd || new TextEncoder().encode(instructions).length > 8192) { status.textContent = t('请填写名称、目录；附加指令不能超过 8192 字节。', 'Enter a name and directory; instructions must not exceed 8192 bytes.'); return; }
            saving = true; status.textContent = t('正在保存项目…', 'Saving project…');
            form.querySelector('[type=submit]').disabled = true;
            try {
                const result = await apiFetch('/api/pi/assistant-projects', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ expectedRevision: revision, project: {
                        ...(project ? { id: project.id } : {}), name, cwd, description, instructions,
                        profileIds: project ? project.profileIds : [profileId()], archived: form.elements.archived.checked
                    } }) });
                dialog.close(); onSaved(result.project);
            } catch (error) {
                status.textContent = error.status === 409 ? t('保存冲突。草稿已保留；请核对最新项目后再提交。', 'Save conflict. Draft retained; review current projects before retrying.') : error.message;
            } finally { saving = false; form.querySelector('[type=submit]').disabled = false; }
        });
        return { open(value, currentRevision, cwd = '') {
            project = value || null; revision = currentRevision;
            dialog.querySelector('h2').textContent = project ? t('编辑项目', 'Edit project') : t('新建项目', 'New project');
            form.elements.name.value = project?.name || '';
            form.elements.cwd.value = project?.cwd || cwd;
            form.elements.cwd.readOnly = Boolean(project);
            form.elements.description.value = project?.description || '';
            form.elements.instructions.value = project?.instructions || '';
            form.elements.archived.checked = Boolean(project?.archived);
            status.textContent = ''; dialog.showModal(); form.elements.name.focus();
        } };
    }

    globalThis.PiAssistantProjects = Object.freeze({ avatar, renderGroups, createEditor });
})();
