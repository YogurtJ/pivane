(() => {
    const t = (zh, en) => window.PiI18n?.locale === 'en' ? en : zh;
    const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
    const button = (label, action) => { const b = el('button', label, 'settings-secondary-button'); b.type = 'button'; b.addEventListener('click', action); return b; };
    const label = (name, control) => { const l = el('label', null, 'channel-field'); l.append(el('span', name), control); control.setAttribute('aria-label', name); return l; };
    const labels = () => ({ queued: t('等待线程空闲', 'Waiting for thread'), dispatching: t('正在投递', 'Submitting'), running: t('运行中', 'Running'), ready: t('回复待发送', 'Reply pending'), sending: t('正在发送回复', 'Sending reply'), delivered: t('已送达', 'Delivered'), uncertain: t('需要核对', 'Needs review'), reviewed: t('已核对', 'Reviewed'), ignored: t('未进入线程', 'Not submitted'), failed: t('失败', 'Failed'), cancelled: t('已取消', 'Cancelled') });
    const reasons = () => ({ unbound: t('尚未绑定线程', 'No thread binding'), 'reply-context-missing': t('缺少微信回复上下文，请在微信再发一条消息', 'Reply context is missing; send another WeChat message'), 'unsupported-message': t('当前支持文字私聊，请用文字重发', 'Text DMs are supported; resend as text'), 'queue-full': t('待处理消息已满', 'Pending queue is full'), restart: t('服务重启，未自动重试', 'Service restarted; no automatic retry'), 'execution-or-delivery-uncertain': t('执行或发送结果不确定，请查看线程', 'Execution or delivery is uncertain; inspect the thread'), 'binding-changed': t('绑定已变化', 'Binding changed') });
    function create(host) {
        const root = el('section', null, 'workspace-settings-panel channel-panel'); root.dataset.settingsPanel = 'channels';
        const status = el('p', '', 'channel-feedback'); status.setAttribute('role', 'status');
        const toolbar = el('div', null, 'channel-actions');
        const refreshButton = button(t('刷新状态', 'Refresh status'), () => refresh(true)); toolbar.append(refreshButton);
        const intro = el('div', null, 'channel-intro');
        intro.append(el('h3', t('消息渠道', 'Messaging channels')), el('p', t('把微信私聊连接到 Pivane 线程，手机和网页共用对话上下文。', 'Connect a WeChat DM to a Pivane thread and continue the conversation from your phone.')));
        const component = el('section', null, 'channel-card'), accounts = el('div', null, 'channel-accounts');
        const binding = el('section', null, 'channel-card');
        const accountSelect = el('select'), peer = el('input'), project = el('select'), session = el('select'); peer.type = 'text'; peer.autocomplete = 'off';
        const peerList = el('datalist'); peerList.id = 'channel-known-peers'; peer.setAttribute('list', peerList.id);
        const bindButton = button(t('绑定线程', 'Bind thread'), () => write('bind', { accountId: accountSelect.value, peerId: peer.value.trim(), cwd: project.value,
            ...(session.value === '__new__' ? { newSession: true } : { sessionId: session.value }) }));
        const bindingList = el('div', null, 'channel-bindings'), jobs = el('section', null, 'channel-card');
        binding.append(el('h4', t('线程绑定', 'Thread bindings')), el('p', t('选择允许使用的微信用户和目标线程。绑定从之后的消息开始生效。', 'Choose an allowed WeChat user and a target thread. The binding applies to future messages.')),
            label(t('微信账号', 'WeChat account'), accountSelect), label(t('微信用户 ID', 'WeChat user ID'), peer), peerList,
            label(t('项目', 'Project'), project), label(t('线程', 'Thread'), session), bindButton, bindingList);
        root.append(intro, toolbar, status, component, accounts, binding, jobs);
        let active = false, epoch = 0, readEpoch = 0, fetching = false, writing = false, blocked = false, snapshot = null, timer = null, target = null, sessionEpoch = 0, signature = '', accountDrafts = new Map();
        const valid = n => active && n === epoch;
        function controls() { root.querySelectorAll('button,input,textarea,select').forEach(n => { n.disabled = writing || (blocked && n !== refreshButton) || n.dataset.unavailable === 'true'; }); }
        function updateSelect(select, rows, chosen) {
            const value = chosen ?? select.value;
            if (rows.length === select.options.length && rows.every((row, i) => select.options[i].value === row[0] && select.options[i].textContent === row[1])) { if (rows.some(r => r[0] === value)) select.value = value; return; }
            select.replaceChildren();
            for (const [id, name] of rows) { const option = el('option', name); option.value = id; select.append(option); }
            if (rows.some(r => r[0] === value)) select.value = value;
        }
        async function loadSessions(chosen) {
            const n = epoch, ticket = ++sessionEpoch, cwd = project.value;
            if (!cwd) { session.replaceChildren(); return; }
            try {
                const result = await host.apiFetch('/api/pi/sessions?cwd=' + encodeURIComponent(cwd));
                if (!valid(n) || ticket !== sessionEpoch || cwd !== project.value) return;
                updateSelect(session, [...result.sessions.map(s => [s.id, s.name || s.firstMessage?.slice(0, 50) || s.id]), ['__new__', t('新建微信对话线程', 'Create a WeChat thread')]], chosen);
            } catch { if (valid(n)) status.textContent = t('无法读取线程，请刷新。', 'Unable to read threads. Refresh to check.'); }
        }
        project.addEventListener('change', () => { target = null; void loadSessions(); });
        accountSelect.addEventListener('change', () => { const a = snapshot?.accounts.find(a => a.id === accountSelect.value); peer.value = a?.userId || ''; });
        async function refresh(explicit = false) {
            if (!active || fetching || writing) return;
            const n = epoch, ticket = ++readEpoch; fetching = true;
            const current = () => valid(n) && ticket === readEpoch;
            try {
                const result = await host.apiFetch('/api/pi/channels');
                if (!current()) return;
                if (!Array.isArray(result.accounts) || !Array.isArray(result.bindings) || !Array.isArray(result.jobs)) throw Error('Invalid channels snapshot');
                const changedDraft = snapshot && snapshot.revision !== result.revision && accountDrafts.size > 0;
                snapshot = result;
                if (changedDraft && !explicit) { blocked = true; status.textContent = t('服务器配置已变化，草稿已保留。请刷新核对已保存的允许用户后再保存。', 'Server configuration changed. Drafts are kept. Refresh and review the saved allowed users before saving.'); }
                if (explicit) blocked = false;
                render();
                if (explicit || status.textContent === t('正在读取…', 'Loading…')) status.textContent = result.error || t('已更新连接与投递状态。', 'Connection and delivery status updated.');
            } catch { if (current()) { blocked = true; status.textContent = t('无法读取消息渠道，请刷新核对。', 'Unable to read messaging channels. Refresh to check.'); } }
            finally { if (ticket === readEpoch) fetching = false; if (current()) { controls(); clearTimeout(timer); timer = setTimeout(() => refresh(), snapshot?.login ? 1200 : 4000); } }
        }
        async function write(action, values = {}) {
            if (!snapshot || writing || blocked) return;
            if (action === 'install' && !window.confirm(t('下载并安装微信连接组件到 Pivane 服务器？安装后仍需扫码和绑定线程。', 'Download and install the WeChat connector on the Pivane server? QR login and a thread binding are still required.'))) return;
            if (action === 'acknowledge' && !window.confirm(t('已在网页核对这条消息？标记后不会重跑任务或补发回复。', 'Have you reviewed this message in the web thread? Marking it reviewed will not rerun the task or resend its reply.'))) return;
            const n = epoch, revision = snapshot.revision; readEpoch++; fetching = false; writing = true; controls(); status.textContent = t('正在处理…', 'Working…');
            try {
                const result = await host.apiFetch('/api/pi/channels/weixin/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...values, confirmed: true, expectedRevision: revision }) });
                if (!valid(n)) return;
                snapshot = result; signature = ''; if (action === 'account') accountDrafts.delete(values.accountId);
                render(); status.textContent = t('操作已完成。', 'Action completed.');
                if (action === 'bind') void loadSessions(result.bindings.find(b => b.accountId === values.accountId && b.peerId === values.peerId)?.sessionId);
            } catch (error) {
                if (valid(n)) { blocked = true; status.textContent = t('操作失败或结果待核对。请先刷新，不会自动重试。', 'The action failed or its outcome needs review. Refresh first; it will not be retried automatically.') + (error?.message ? ' ' + error.message : ''); }
            } finally { writing = false; if (valid(n)) { controls(); clearTimeout(timer); timer = setTimeout(() => refresh(), 1200); } }
        }
        function render() {
            if (!snapshot) return;
            const nextSignature = JSON.stringify([snapshot.revision, snapshot.component, snapshot.login, snapshot.accounts]);
            if (signature !== nextSignature) {
                signature = nextSignature; component.replaceChildren(el('h4', t('微信 ClawBot', 'WeChat ClawBot')));
                component.append(el('p', snapshot.component.broken ? t('组件需要修复', 'Connector needs repair') : snapshot.component.installed ? t('组件已安装 · ', 'Installed · ') + snapshot.component.version : t('按需安装；未安装时不会下载微信依赖或启动连接。', 'Optional installation. WeChat dependencies and connections are loaded only when installed.')));
                if (snapshot.component.error) component.append(el('p', snapshot.component.error, 'channel-feedback'));
                component.append(el('p', t('当前支持文字私聊。图片、文件、语音、普通微信群及主动通知暂未开放。', 'Text DMs are supported. Images, files, voice, ordinary groups and proactive notifications are not available yet.'), 'channel-note'));
                const actions = el('div', null, 'channel-actions');
                if (!snapshot.component.installed) actions.append(button(t('安装微信组件', 'Install WeChat connector'), () => write('install')));
                else {
                    actions.append(button(t('扫码连接微信', 'Connect with QR code'), () => write('login')),
                        button(t('卸载组件', 'Uninstall connector'), () => write('uninstall')));
                }
                component.append(actions);
                if (snapshot.login) {
                    const login = snapshot.login;
                    if (Array.isArray(login.matrix) && login.matrix.length <= 200 && login.matrix.every(r => Array.isArray(r) && r.length === login.matrix.length)) {
                        const canvas = el('canvas', null, 'channel-qr'), size = login.matrix.length; canvas.width = canvas.height = (size + 8) * 4;
                        canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', t('用手机微信扫码连接', 'Scan with WeChat to connect'));
                        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = '#000';
                        login.matrix.forEach((row, y) => row.forEach((cell, x) => { if (cell) ctx.fillRect((x + 4) * 4, (y + 4) * 4, 4, 4); })); component.append(canvas);
                    }
                    const loginNames = { wait: t('请用手机微信扫码', 'Scan with WeChat'), scaned: t('请在手机上确认', 'Confirm on your phone'), need_verifycode: t('请输入手机显示的数字', 'Enter the code shown on your phone'), expired: t('二维码已过期，请取消后重新连接', 'QR code expired. Cancel and reconnect.'), error: t('连接失败，请取消后核对网络', 'Connection failed. Cancel and check the network.') };
                    component.append(el('p', loginNames[login.status] || login.status));
                    if (login.status === 'need_verifycode') {
                        const code = el('input'); code.inputMode = 'numeric'; code.autocomplete = 'one-time-code'; code.maxLength = 12;
                        component.append(label(t('验证码', 'Verification code'), code), button(t('提交验证码', 'Submit verification code'), () => write('verify-login', { loginId: login.id, code: code.value })));
                    }
                    component.append(button(t('取消登录', 'Cancel login'), () => write('cancel-login', { loginId: login.id })));
                }
                accounts.replaceChildren();
                for (const account of snapshot.accounts) {
                    const card = el('section', null, 'channel-card'); card.dataset.accountId = account.id;
                    const names = { connected: t('已连接', 'Connected'), disabled: t('已停用', 'Disabled'), starting: t('连接中', 'Connecting'), error: t('连接异常', 'Connection error') };
                    card.append(el('h4', account.id), el('p', names[account.connection] || account.connection));
                    if (accountDrafts.has(account.id)) {
                        const saved = el('details'); saved.append(el('summary', t('查看服务器已保存的允许用户', 'View saved allowed users')), el('p', account.allowedUsers.join('\n'))); card.append(saved);
                    }
                    const users = el('textarea'); users.rows = 3; users.value = accountDrafts.get(account.id) ?? account.allowedUsers.join('\n');
                    users.addEventListener('input', () => accountDrafts.set(account.id, users.value));
                    card.append(label(t('允许使用的微信用户（每行一个 ID）', 'Allowed WeChat users (one ID per line)'), users));
                    const controls = el('div', null, 'channel-actions');
                    controls.append(button(t('保存允许用户', 'Save allowed users'), () => write('account', { accountId: account.id, enabled: account.enabled, allowedUsers: users.value.split(/\s+/).filter(Boolean) })),
                        button(account.enabled ? t('停用连接', 'Disable connection') : t('启用连接', 'Enable connection'), () => write('account', { accountId: account.id, enabled: !account.enabled, allowedUsers: users.value.split(/\s+/).filter(Boolean) })));
                    card.append(controls); accounts.append(card);
                }
            }
            binding.hidden = snapshot.accounts.length === 0;
            jobs.hidden = snapshot.accounts.length === 0 && snapshot.jobs.length === 0;
            updateSelect(accountSelect, snapshot.accounts.map(a => [a.id, a.id]));
            if (!peer.value) peer.value = snapshot.accounts.find(a => a.id === accountSelect.value)?.userId || '';
            peerList.replaceChildren(...snapshot.peers.map(p => { const o = el('option'); o.value = p.peerId; return o; }));
            bindingList.replaceChildren();
            for (const b of snapshot.bindings) {
                const row = el('div', null, 'channel-binding'); row.append(el('p', `${b.peerId} → ${b.name || b.sessionId}`), el('small', b.cwd));
                row.append(button(t('解除绑定', 'Unbind'), () => write('unbind', { accountId: b.accountId, peerId: b.peerId }))); bindingList.append(row);
            }
            jobs.replaceChildren(el('h4', t('最近消息与投递', 'Recent messages and delivery')));
            if (!snapshot.jobs.length) jobs.append(el('p', t('绑定后，在微信发送第一条文字消息。', 'After binding, send your first text message in WeChat.')));
            for (const job of snapshot.jobs.slice(0, 20)) {
                const row = el('div', null, 'channel-job'); row.append(el('strong', labels()[job.status] || job.status), el('small', `${job.peerId} · ${new Date(job.at).toLocaleString()}`));
                if (job.sentChunks) row.append(el('small', t(`已确认发送 ${job.sentChunks} 段`, `${job.sentChunks} chunks confirmed sent`)));
                if (job.waiting) row.append(el('p', t('正在等待交互确认，请打开 Pivane 线程处理。', 'Waiting for confirmation. Open the Pivane thread to respond.')));
                if (job.reason && reasons()[job.reason]) row.append(el('p', reasons()[job.reason]));
                const actions = el('div', null, 'channel-actions');
                if (['running', 'dispatching'].includes(job.status)) actions.append(button(t('停止任务', 'Stop task'), () => write('stop', { jobId: job.id })));
                if (job.canRecover) actions.append(button(t('核对并发送原生回复', 'Check and send native reply'), () => write('recover', { jobId: job.id })));
                if (['uncertain', 'failed', 'ready'].includes(job.status)) actions.append(button(t('标记已核对', 'Mark reviewed'), () => write('acknowledge', { jobId: job.id })));
                row.append(actions); jobs.append(row);
            }
            bindButton.dataset.unavailable = String(!snapshot.accounts.length || Boolean(snapshot.error));
            if (snapshot.error) { status.textContent = snapshot.error; blocked = true; }
            controls();
        }
        function setTarget(value) {
            if (!value?.cwd || !value?.sessionId) return;
            target = { ...value };
            if (active) { if (![...project.options].some(o => o.value === value.cwd)) { const option = el('option', value.cwd); option.value = value.cwd; project.append(option); } project.value = value.cwd; void loadSessions(value.sessionId); }
        }
        async function open() {
            active = true; fetching = false; readEpoch++; root.classList.add('active'); const n = ++epoch; blocked = false; status.textContent = t('正在读取…', 'Loading…');
            void refresh();
            try {
                const data = await host.apiFetch('/api/pi/projects'); if (!valid(n)) return;
                const rows = data.projects.map(p => [p.cwd, p.name || p.cwd]); const chosen = target?.cwd || host.currentCwd();
                if (chosen && !rows.some(r => r[0] === chosen)) rows.unshift([chosen, chosen]); updateSelect(project, rows, chosen);
                await loadSessions(target?.sessionId);
            } catch { if (valid(n)) status.textContent = t('无法读取项目，请刷新。', 'Unable to read projects. Refresh to check.'); }
        }
        function close() { active = false; epoch++; readEpoch++; fetching = false; sessionEpoch++; clearTimeout(timer); root.classList.remove('active'); target = null; snapshot = null; signature = ''; component.replaceChildren(); }
        return { root, open, close, setTarget };
    }
    window.PiChannels = { create };
})();
