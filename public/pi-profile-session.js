/* Saved and loaded identity labels belong to the active chat, not the editor. */
(() => {
    const $ = id => document.getElementById(id);
    const t = (text, ...args) => globalThis.PiI18n?.t(text, ...args) || String(text).replace(/\{(\d+)\}/g, (_, i) => args[i] ?? `{${i}}`);
    function create() {
        let enabled = false;
        let loadedProfile = null, loadedKey = '', displayedSession = null, displayedConnected = false, displayedKey = '';
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

        return { displaySession, setLoadedProfile, invalidateLoaded, get enabled() { return enabled; },
            setEnabled(value) {
                enabled = value === true;
                document.querySelectorAll('[data-manage-route="profiles"]').forEach(item => { item.hidden = !enabled; });
                displaySession(displayedSession, displayedConnected, displayedKey);
            } };
    }
    window.PiProfileSession = { create };
})();
