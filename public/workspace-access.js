(() => {
    const access = { supported: false, authenticated: false, enabled: false, ready: null };
    window.WorkspaceAccess = access;
    let locked = false, statusEpoch = 0, settingsEpoch = 0, snapshot = null, active = false, busy = false;
    const inertBefore = new Map();
    const $ = id => document.getElementById(id);
    const emit = name => window.dispatchEvent(new Event(name));
    const message = (id, text) => { $(id).textContent = text; $(id).hidden = !text; };
    function hideToken() {
        $('pi-token-input').type = 'password';
        $('workspace-access-token-visibility').textContent = '显示';
        $('workspace-access-token-visibility').setAttribute('aria-label', '显示 Token');
        $('workspace-access-token-visibility').setAttribute('aria-pressed', 'false');
    }

    function unlock(notify = true) {
        const wasLocked = locked; locked = false; access.authenticated = true;
        $('pi-token-dialog').classList.add('hidden'); document.body.classList.remove('workspace-access-locked');
        for (const [node, value] of inertBefore) node.inert = value; inertBefore.clear();
        $('pi-token-input').value = ''; hideToken(); message('workspace-access-login-error', '');
        if (notify || wasLocked) emit('workspace:access-ready');
    }

    access.requireLogin = () => {
        if (!access.supported) return false;
        access.authenticated = false;
        if (!locked) {
            locked = true;
            for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
            for (const media of document.querySelectorAll('audio,video')) media.pause();
            for (const node of document.body.children) {
                if (node.id === 'pi-token-dialog' || ['SCRIPT', 'STYLE'].includes(node.tagName)) continue;
                inertBefore.set(node, node.inert); node.inert = true;
            }
            document.body.classList.add('workspace-access-locked');
            $('pi-token-dialog').classList.remove('hidden');
            $('pi-token-input').value = ''; hideToken();
            requestAnimationFrame(() => $('pi-token-input').focus());
            emit('workspace:access-locked');
        }
        return true;
    };

    async function request(route, method = 'GET', body) {
        const response = await fetch('/api/access' + route, { method, credentials: 'same-origin', cache: 'no-store',
            headers: { 'X-Pi-Access': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: body === undefined ? undefined : JSON.stringify(body) });
        const data = await response.json().catch(() => null);
        if (response.status === 401 && route !== '/login') access.requireLogin();
        if (!response.ok) throw new Error(data?.error || `访问请求失败（${response.status}）`);
        return data;
    }

    async function refreshStatus(initial = false) {
        const epoch = ++statusEpoch;
        try {
            const response = await fetch('/api/access/status', { credentials: 'same-origin', cache: 'no-store' });
            if (response.status === 404) return;
            const data = await response.json();
            if (!response.ok) throw new Error(data?.error || '无法确认访问状态，请稍后重试');
            if (epoch !== statusEpoch) return;
            if (data.accessControl !== true) return false;
            access.supported = true; access.enabled = data.enabled;
            $('workspace-access-nav').hidden = false;
            $('workspace-access-remember').closest('label').hidden = false;
            const oldToken = sessionStorage.getItem('pi.web.token');
            sessionStorage.removeItem('pi.web.token');
            if (initial && !data.authenticated && oldToken) {
                try { await request('/login', 'POST', { token: oldToken }); return refreshStatus(true); } catch {}
            }
            if (!data.authenticated) access.requireLogin();
            else if (initial || locked) unlock(!initial);
            else access.authenticated = true;
            return true;
        } catch (error) {
            if (epoch !== statusEpoch) return;
            if (access.supported && locked) message('workspace-access-login-error', error.message || '无法连接工作台，请稍后重试');
            return false;
        }
    }

    access.refresh = async () => {
        const verified = await refreshStatus();
        if (verified && access.authenticated) emit('workspace:access-ready');
        else if (verified === false) access.requireLogin();
    };

    access.fetch = async (url, options = {}) => {
        await access.ready;
        const headers = new Headers(options.headers || {});
        if (access.supported) headers.delete('Authorization'); // Modern browser requests use HttpOnly cookies.
        const response = await fetch(url, { ...options, headers });
        if (access.supported && response.status === 401) access.requireLogin();
        return response;
    };

    function controls() {
        const editable = snapshot?.editable && !busy;
        const enabled = $('workspace-access-enabled').checked;
        $('workspace-access-enabled').disabled = !editable;
        $('workspace-access-token-fields').hidden = !enabled || !snapshot?.editable;
        $('workspace-access-token').disabled = !editable || !enabled || $('workspace-access-generate').checked;
        $('workspace-access-generate').disabled = !editable || !enabled;
        $('workspace-access-save').disabled = !editable || (enabled === snapshot.enabled && (!enabled || (!$('workspace-access-token').value && !$('workspace-access-generate').checked)));
        $('workspace-access-logout').disabled = busy || !snapshot?.enabled;
        $('workspace-access-revoke').disabled = busy || !snapshot?.enabled;
    }

    async function loadSettings() {
        const epoch = ++settingsEpoch; snapshot = null; controls();
        $('workspace-access-generated').hidden = true; $('workspace-access-generated-token').value = '';
        message('workspace-access-error', '');
        try {
            const data = await request('/settings'); if (!active || epoch !== settingsEpoch) return;
            snapshot = data;
            $('workspace-access-enabled').checked = data.enabled;
            $('workspace-access-token').value = ''; $('workspace-access-generate').checked = false;
            $('workspace-access-source').textContent = data.editable ? '由此工作台管理，可随时修改。' : '由服务器 PI_WEB_TOKEN 强制启用；请在部署配置中修改。';
            controls();
        } catch (error) { if (active && epoch === settingsEpoch) message('workspace-access-error', error.message); }
    }

    access.openSettings = () => {
        active = true;
        message('workspace-access-result', '');
        $('workspace-access-generated').hidden = true; $('workspace-access-generated-token').value = '';
        void loadSettings();
    };
    access.closeSettings = () => { active = false; settingsEpoch++; $('workspace-access-token').value = ''; $('workspace-access-generated-token').value = ''; $('workspace-access-generated').hidden = true; };

    access.ready = new Promise(resolve => document.addEventListener('DOMContentLoaded', async () => {
        $('workspace-access-token-visibility').addEventListener('click', event => {
            const visible = $('pi-token-input').type === 'password';
            $('pi-token-input').type = visible ? 'text' : 'password';
            event.currentTarget.textContent = visible ? '隐藏' : '显示';
            event.currentTarget.setAttribute('aria-label', visible ? '隐藏 Token' : '显示 Token');
            event.currentTarget.setAttribute('aria-pressed', String(visible));
        });
        $('pi-token-form').addEventListener('submit', async event => {
            if (!access.supported) return;
            event.preventDefault(); event.stopImmediatePropagation();
            const button = event.currentTarget.querySelector('button[type="submit"]'); if (button.disabled) return;
            button.disabled = true; button.querySelector('span').textContent = '正在登录…';
            $('pi-token-form').setAttribute('aria-busy', 'true'); message('workspace-access-login-error', '');
            try {
                await request('/login', 'POST', { token: $('pi-token-input').value, remember: $('workspace-access-remember').checked });
                statusEpoch++; unlock(); if (active) void loadSettings();
            } catch (error) { message('workspace-access-login-error', error.message); }
            finally { button.disabled = false; button.querySelector('span').textContent = '登录工作台'; $('pi-token-form').removeAttribute('aria-busy'); }
        });
        $('pi-token-dialog').addEventListener('keydown', event => {
            if (!locked) return;
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
            if (event.key !== 'Tab') return;
            const fields = [...$('pi-token-form').querySelectorAll('input,button,summary')].filter(n => !n.disabled && n.getClientRects().length);
            if (event.shiftKey && document.activeElement === fields[0]) { event.preventDefault(); fields.at(-1).focus(); }
            else if (!event.shiftKey && document.activeElement === fields.at(-1)) { event.preventDefault(); fields[0].focus(); }
        });
        $('workspace-access-enabled').addEventListener('change', controls);
        $('workspace-access-token').addEventListener('input', controls);
        $('workspace-access-generate').addEventListener('change', controls);
        $('workspace-access-form').addEventListener('submit', async event => {
            event.preventDefault(); if (busy || !snapshot?.editable) return;
            const enabled = $('workspace-access-enabled').checked, generate = $('workspace-access-generate').checked;
            if (!enabled && snapshot.enabled && !confirm('关闭访问验证后，能够连接此服务的客户端均可使用工作台。确认关闭？')) return;
            if (enabled && snapshot.enabled && !confirm('更换 Token 将使原 Token 和所有已登录设备失效，并断开原网页连接。持久任务继续运行，临时会话和侧聊将结束。确认更换？')) return;
            const epoch = settingsEpoch;
            const body = { enabled, expectedRevision: snapshot.revision, confirmed: true,
                ...(enabled ? generate ? { generate: true } : { token: $('workspace-access-token').value } : {}) };
            busy = true; statusEpoch++; controls(); message('workspace-access-error', ''); message('workspace-access-result', '');
            try {
                const data = await request('/settings', 'PUT', body);
                statusEpoch++; sessionStorage.removeItem('pi.web.token'); access.enabled = data.enabled; unlock();
                if (active && epoch === settingsEpoch) {
                    const { generatedToken, ...settings } = data;
                    snapshot = settings; $('workspace-access-token').value = ''; $('workspace-access-generate').checked = false;
                    message('workspace-access-result', data.enabled ? '已保存，访问验证已开启。当前设备已登录。' : '已保存，访问验证已关闭。');
                    $('workspace-access-generated').hidden = !data.generatedToken;
                    $('workspace-access-generated-token').value = data.generatedToken || '';
                }
            } catch (error) { if (active && epoch === settingsEpoch) message('workspace-access-error', error.message + '；未自动重试。若连接中断，请先刷新状态核对。'); }
            finally { busy = false; controls(); }
        });
        for (const [id, route] of [['workspace-access-logout', '/logout'], ['workspace-access-revoke', '/revoke']]) {
            $(id).addEventListener('click', async () => {
                if (busy || !confirm(route === '/revoke' ? '撤销所有浏览器登录？持久任务继续运行；临时会话和侧聊将结束。' : '退出当前浏览器？持久任务继续运行；当前临时会话和侧聊将结束。')) return;
                busy = true; statusEpoch++; controls(); message('workspace-access-error', '');
                try { await request(route, 'POST', {}); statusEpoch++; access.requireLogin(); }
                catch (error) { message('workspace-access-error', error.message + '；请核对状态，未自动重试。'); }
                finally { busy = false; controls(); }
            });
        }
        $('workspace-access-refresh').addEventListener('click', () => { if (!busy) { message('workspace-access-result', ''); void loadSettings(); } });
        await refreshStatus(true); resolve();
        setInterval(() => { if (access.supported && !document.hidden && !busy) void refreshStatus(); }, 15000);
        document.addEventListener('visibilitychange', () => { if (!document.hidden && access.supported && !busy) void refreshStatus(); });
    }, { once: true }));
})();
