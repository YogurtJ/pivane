(() => {
    const t = (zh, en) => window.PiI18n?.locale === 'en' ? en : zh;
    const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
    const icon = name => { const i = el('i', null, /^fa-(brands|regular|solid)\b/.test(name) ? name : `fa-solid ${name}`); i.setAttribute('aria-hidden', 'true'); return i; };
    const button = (label, action, variant = 'secondary') => {
        const b = el('button', label, variant === 'primary' ? 'settings-primary-button channel-btn-primary' : variant === 'danger' ? 'settings-secondary-button channel-btn-danger' : 'settings-secondary-button');
        b.type = 'button'; b.addEventListener('click', action); return b;
    };
    const badge = (text, kind = 'neutral') => { const b = el('span', text, 'channel-badge'); b.dataset.kind = kind; return b; };
    const cardHead = (glyph, title, subtitle, extra) => {
        const head = el('div', null, 'channel-card-head');
        const mark = el('span', null, 'channel-card-icon'); mark.append(icon(glyph));
        const copy = el('div', null, 'channel-card-copy');
        copy.append(el('h4', title));
        if (subtitle) copy.append(el('p', subtitle));
        head.append(mark, copy);
        if (extra) head.append(extra);
        return head;
    };
    const label = (name, control, hint) => {
        const l = el('label', null, 'channel-field');
        const cap = el('span', name, 'channel-field-label');
        l.append(cap, control);
        if (hint) l.append(el('small', hint, 'channel-field-hint'));
        control.setAttribute('aria-label', name);
        return l;
    };
    const labels = () => ({ queued: t('等待线程空闲', 'Waiting for thread'), dispatching: t('正在投递', 'Submitting'), running: t('运行中', 'Running'), ready: t('回复待发送', 'Reply pending'), sending: t('正在发送回复', 'Sending reply'), delivered: t('已送达', 'Delivered'), partial: t('部分送达', 'Partially delivered'), uncertain: t('需要核对', 'Needs review'), reviewed: t('已核对', 'Reviewed'), ignored: t('未进入线程', 'Not submitted'), failed: t('失败', 'Failed'), cancelled: t('已取消', 'Cancelled') });
    const jobKind = status => status === 'delivered' || status === 'reviewed' ? 'on' : ['running', 'dispatching', 'sending', 'queued', 'ready'].includes(status) ? 'info' : ['uncertain', 'failed', 'partial'].includes(status) ? 'error' : 'off';
    const reasons = () => ({ unbound: t('尚未绑定线程', 'No thread binding'), 'reply-context-missing': t('缺少微信回复上下文，请在微信再发一条消息', 'Reply context is missing; send another WeChat message'), 'unsupported-message': t('当前支持文字私聊，请用文字重发', 'Text DMs are supported; resend as text'), 'queue-full': t('待处理消息已满', 'Pending queue is full'), restart: t('服务重启，未自动重试', 'Service restarted; no automatic retry'), 'execution-or-delivery-uncertain': t('执行或发送结果不确定，请查看线程', 'Execution or delivery is uncertain; inspect the thread'), 'binding-changed': t('绑定已变化', 'Binding changed'), 'attachments-incomplete': t('部分附件尚未发送，请查看下方说明或打开线程。', 'Some attachments were not sent. See details below or open the thread.'), 'admission-changed': t('执行前权限或绑定已变化', 'Permission or binding changed before execution'), 'delivery-revoked': t('回复权限已撤销', 'Reply permission was revoked'), 'notification-revoked': t('定时通知已关闭', 'Scheduled notification was disabled') });
    function create(host) {
        const root = el('section', null, 'workspace-settings-panel channel-panel'); root.dataset.settingsPanel = 'channels';
        const header = el('header', null, 'settings-panel-header channel-header');
        const intro = el('div', null, 'channel-intro');
        intro.append(el('h3', t('消息渠道', 'Messaging channels')), el('p', t('把微信私聊连接到 Pivane 线程，手机和网页共用对话上下文。', 'Connect a WeChat DM to a Pivane thread and continue the conversation from your phone.')));
        const refreshButton = button(t('刷新状态', 'Refresh status'), () => refresh(true));
        refreshButton.classList.add('settings-header-refresh');
        header.append(icon('fa-comments'), intro, refreshButton);

        const status = el('p', '', 'channel-feedback'); status.setAttribute('role', 'status');
        const skeletonWrap = el('div', null, 'channel-skeleton-wrap'); skeletonWrap.hidden = true;
        const component = el('section', null, 'channel-card channel-connector-card');
        const accounts = el('div', null, 'channel-accounts');
        const lowerGrid = el('div', null, 'channel-lower-grid');
        const binding = el('section', null, 'channel-card channel-binding-card');
        const accountSelect = el('select'), peer = el('input'), project = el('select'), session = el('select');
        peer.type = 'text'; peer.autocomplete = 'off'; peer.placeholder = t('例如 wxid_xxx 或扫码账号 ID', 'e.g. wxid_xxx or scanner ID');
        const peerList = el('datalist'); peerList.id = 'channel-known-peers'; peer.setAttribute('list', peerList.id);
        const bindButton = button(t('绑定线程', 'Bind thread'), () => write('bind', { accountId: accountSelect.value, peerId: peer.value.trim(), cwd: project.value,
            ...(session.value === '__new__' ? { newSession: true } : { sessionId: session.value }) }), 'primary');
        const bindForm = el('div', null, 'channel-bind-grid');
        bindForm.append(
            label(t('微信账号', 'WeChat account'), accountSelect),
            label(t('微信用户 ID', 'WeChat user ID'), peer),
            label(t('项目', 'Project'), project),
            label(t('线程', 'Thread'), session)
        );
        const bindFooter = el('div', null, 'channel-bind-footer');
        bindFooter.append(el('span', t('绑定后，该微信用户发来的新文字消息会进入所选线程。', 'New text messages from this WeChat user will route to the chosen thread.'), 'channel-bind-hint'), bindButton);
        const bindingList = el('div', null, 'channel-bindings');
        binding.append(
            cardHead('fa-link', t('线程绑定', 'Thread bindings'), t('选择允许使用的微信用户和目标线程。绑定从之后的消息开始生效。', 'Choose an allowed WeChat user and a target thread. The binding applies to future messages.')),
            bindForm, peerList, bindFooter, bindingList
        );
        const jobs = el('section', null, 'channel-card channel-jobs-card');
        const jobList = el('div', null, 'channel-job-list'); jobList.setAttribute('role', 'list');
        const jobEmpty = el('p', t('绑定后，在微信发送第一条消息。', 'After binding, send your first message in WeChat.'), 'channel-empty-note');
        const jobPager = el('div', null, 'channel-job-pager');
        const jobRange = el('span', '', 'channel-job-range');
        const jobPrevious = button(t('上一页', 'Previous'), () => changeJobPage(-1));
        const jobNext = button(t('下一页', 'Next'), () => changeJobPage(1));
        for (const b of [jobPrevious, jobNext]) b.dataset.channelReadOnly = 'true';
        const jobPageButtons = el('div', null, 'channel-job-page-buttons'); jobPageButtons.append(jobPrevious, jobNext);
        jobPager.append(jobRange, jobPageButtons);
        jobs.append(cardHead('fa-paper-plane', t('最近消息与投递', 'Recent messages and delivery'), t('最新记录在前，每页显示 5 条。', 'Newest first, 5 records per page.')), jobEmpty, jobList, jobPager);
        let jobPage = 0, jobSignature = '';
        const jobPageSize = 5;
        lowerGrid.append(binding, jobs);
        root.append(header, status, skeletonWrap, component, accounts, lowerGrid);

        let active = false, epoch = 0, readEpoch = 0, fetching = false, writing = false, blocked = false, snapshot = null, timer = null, target = null, sessionEpoch = 0, signature = '', accountDrafts = new Map();
        const valid = n => active && n === epoch;
        function setStatus(message, tone = 'info') {
            status.textContent = message || '';
            status.dataset.tone = tone;
        }
        function controls() {
            root.querySelectorAll('button,input,textarea,select').forEach(n => {
                n.disabled = writing || (blocked && n !== refreshButton && n.dataset.channelReadOnly !== 'true') || n.dataset.unavailable === 'true';
            });
        }
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
            } catch { if (valid(n)) setStatus(t('无法读取线程，请刷新。', 'Unable to read threads. Refresh to check.'), 'error'); }
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
                const firstLoad = !snapshot;
                snapshot = result;
                skeletonWrap.hidden = true; skeletonWrap.replaceChildren();
                if (changedDraft && !explicit) {
                    blocked = true;
                    setStatus(t('服务器配置已变化，草稿已保留。请刷新核对已保存的允许用户后再保存。', 'Server configuration changed. Drafts are kept. Refresh and review the saved allowed users before saving.'), 'warning');
                }
                if (explicit) blocked = false;
                render();
                if (explicit || firstLoad) setStatus(result.error || t('已更新连接与投递状态。', 'Connection and delivery status updated.'), result.error ? 'error' : 'info');
            } catch {
                if (current()) {
                    skeletonWrap.hidden = true; skeletonWrap.replaceChildren();
                    blocked = true;
                    setStatus(t('无法读取消息渠道，请刷新核对。', 'Unable to read messaging channels. Refresh to check.'), 'error');
                }
            } finally {
                if (ticket === readEpoch) fetching = false;
                if (current()) { controls(); clearTimeout(timer); timer = setTimeout(() => refresh(), snapshot?.login ? 1200 : 4000); }
            }
        }
        async function write(action, values = {}) {
            if (!snapshot || writing || blocked) return;
            if (action === 'install' && !window.confirm(t('下载并安装微信连接组件到 Pivane 服务器？安装后仍需扫码和绑定线程。', 'Download and install the WeChat connector on the Pivane server? QR login and a thread binding are still required.'))) return;
            if (action === 'acknowledge' && !window.confirm(t('已在网页核对这条消息？标记后不会重跑任务或补发回复。', 'Have you reviewed this message in the web thread? Marking it reviewed will not rerun the task or resend its reply.'))) return;
            const n = epoch, revision = snapshot.revision; readEpoch++; fetching = false; writing = true; controls(); setStatus(t('正在处理…', 'Working…'), 'info');
            try {
                const result = await host.apiFetch('/api/pi/channels/weixin/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...values, confirmed: true, expectedRevision: revision }) });
                if (!valid(n)) return;
                snapshot = result; signature = ''; if (action === 'account') accountDrafts.delete(values.accountId);
                render(); setStatus(t('操作已完成。', 'Action completed.'), 'success');
                if (action === 'bind') void loadSessions(result.bindings.find(b => b.accountId === values.accountId && b.peerId === values.peerId)?.sessionId);
            } catch (error) {
                if (valid(n)) {
                    blocked = true;
                    setStatus(t('操作失败或结果待核对。请先刷新，不会自动重试。', 'The action failed or its outcome needs review. Refresh first; it will not be retried automatically.') + (error?.message ? ' ' + error.message : ''), 'error');
                }
            } finally { writing = false; if (valid(n)) { controls(); clearTimeout(timer); timer = setTimeout(() => refresh(), 1200); } }
        }
        function render() {
            if (!snapshot) return;
            component.hidden = false;
            const nextSignature = JSON.stringify([snapshot.revision, snapshot.component, snapshot.login, snapshot.accounts, snapshot.typing?.filter(row => ['degraded', 'unavailable'].includes(row.status))]);
            if (signature !== nextSignature) {
                signature = nextSignature;
                const installed = snapshot.component.installed && !snapshot.component.broken;
                const compBadge = badge(
                    snapshot.component.broken ? t('组件需要修复', 'Connector needs repair')
                        : installed ? t('已安装 · ', 'Installed · ') + snapshot.component.version
                        : t('未安装 · 按需下载', 'Not installed · On-demand'),
                    snapshot.component.broken ? 'error' : installed ? 'on' : 'off'
                );
                const compSubtitle = snapshot.component.broken
                    ? t('组件校验未通过，请先停用连接后卸载重装。', 'Connector verification failed. Disable connections, then uninstall and reinstall.')
                    : installed
                    ? t('组件已就绪。扫码连接微信账号后即可绑定线程收发消息。', 'Connector is ready. Connect a WeChat account via QR code and bind a thread.')
                    : t('按需安装；未安装时不会下载微信依赖或启动后台连接。', 'Optional installation. WeChat dependencies and connections are loaded only when installed.');
                component.replaceChildren(cardHead('fa-brands fa-weixin', t('微信 ClawBot', 'WeChat ClawBot'), compSubtitle, compBadge));

                const steps = el('div', null, 'channel-steps');
                const hasAccount = snapshot.accounts.length > 0;
                const hasBinding = snapshot.bindings.length > 0;
                for (const [num, title, done] of [
                    ['1', t('安装组件', 'Install connector'), installed],
                    ['2', t('扫码授权微信', 'Scan QR code'), hasAccount],
                    ['3', t('绑定对话线程', 'Bind thread'), hasBinding]
                ]) {
                    const step = el('div', null, 'channel-step');
                    step.dataset.done = String(Boolean(done));
                    step.append(el('span', done ? '✓' : num, 'channel-step-num'), el('span', title, 'channel-step-label'));
                    steps.append(step);
                }
                component.append(steps);

                if (snapshot.component.error) component.append(el('p', snapshot.component.error, 'channel-inline-alert'));
                component.append(el('p', t('支持文字、图片收发、deliver_files 文件交付、正在输入状态、斜杠指令（/help /status /stop /new /resume /name /model /thinking /compact /reload）及定时任务通知推送。语音与普通微信群暂未开放。', 'Supports text, image send/receive, deliver_files attachments, typing indicator, slash commands (/help /status /stop /new /resume /name /model /thinking /compact /reload) and scheduled task notifications. Voice and ordinary WeChat groups are not available yet.'), 'channel-note'));
                const actions = el('div', null, 'channel-actions');
                if (!snapshot.component.installed) actions.append(button(t('安装微信组件', 'Install WeChat connector'), () => write('install'), 'primary'));
                else {
                    actions.append(
                        button(t('扫码连接微信', 'Connect with QR code'), () => write('login'), 'primary'),
                        button(t('卸载组件', 'Uninstall connector'), () => write('uninstall'), 'danger')
                    );
                }
                component.append(actions);

                if (snapshot.login) {
                    const login = snapshot.login;
                    const qrBox = el('div', null, 'channel-qr-box');
                    if (Array.isArray(login.matrix) && login.matrix.length <= 200 && login.matrix.every(r => Array.isArray(r) && r.length === login.matrix.length)) {
                        const canvas = el('canvas', null, 'channel-qr'), size = login.matrix.length; canvas.width = canvas.height = (size + 8) * 4;
                        canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', t('用手机微信扫码连接', 'Scan with WeChat to connect'));
                        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = '#000';
                        login.matrix.forEach((row, y) => row.forEach((cell, x) => { if (cell) ctx.fillRect((x + 4) * 4, (y + 4) * 4, 4, 4); }));
                        qrBox.append(canvas);
                    }
                    const loginCopy = el('div', null, 'channel-qr-copy');
                    const loginNames = { wait: t('请用手机微信扫码', 'Scan with WeChat'), scaned: t('请在手机上确认', 'Confirm on your phone'), need_verifycode: t('请输入手机显示的数字', 'Enter the code shown on your phone'), expired: t('二维码已过期，请取消后重新连接', 'QR code expired. Cancel and reconnect.'), error: t('连接失败，请取消后核对网络', 'Connection failed. Cancel and check the network.') };
                    loginCopy.append(el('strong', loginNames[login.status] || login.status), el('p', t('打开手机微信扫一扫，确认登录 ClawBot 账号。二维码五分钟内有效。', 'Open WeChat on your phone, scan the QR code, and confirm login. Valid for 5 minutes.')));
                    if (login.status === 'need_verifycode') {
                        const code = el('input'); code.inputMode = 'numeric'; code.autocomplete = 'one-time-code'; code.maxLength = 12;
                        loginCopy.append(label(t('验证码', 'Verification code'), code), button(t('提交验证码', 'Submit verification code'), () => write('verify-login', { loginId: login.id, code: code.value }), 'primary'));
                    }
                    loginCopy.append(button(t('取消登录', 'Cancel login'), () => write('cancel-login', { loginId: login.id })));
                    qrBox.append(loginCopy);
                    component.append(qrBox);
                }

                accounts.replaceChildren();
                for (const account of snapshot.accounts) {
                    const card = el('section', null, 'channel-card channel-account-card'); card.dataset.accountId = account.id;
                    const names = { connected: t('已连接', 'Connected'), disabled: t('已停用', 'Disabled'), starting: t('连接中', 'Connecting'), error: t('连接异常', 'Connection error') };
                    const connKind = account.connection === 'connected' ? 'on' : account.connection === 'error' ? 'error' : account.connection === 'starting' ? 'info' : 'off';
                    card.append(cardHead('fa-user-check', account.id, account.userId ? t('扫码用户：', 'Scanner ID: ') + account.userId : '', badge(names[account.connection] || account.connection, connKind)));
                    const typingIssues = (snapshot.typing || []).filter(row => row.accountId === account.id && ['degraded', 'unavailable'].includes(row.status));
                    if (typingIssues.length) card.append(el('p', t('正在输入状态暂不可用；消息处理仍会继续，下次任务会重新获取状态票据。', 'Typing feedback is unavailable. Message processing continues; the next task will request a fresh ticket.'), 'channel-inline-alert'));
                    if (accountDrafts.has(account.id)) {
                        const saved = el('details', null, 'channel-saved-users'); saved.append(el('summary', t('查看服务器已保存的允许用户', 'View saved allowed users')), el('p', account.allowedUsers.join('\n'))); card.append(saved);
                    }
                    const users = el('textarea'); users.rows = 3; users.value = accountDrafts.get(account.id) ?? account.allowedUsers.join('\n');
                    users.addEventListener('input', () => accountDrafts.set(account.id, users.value));
                    card.append(label(t('允许使用的微信用户（每行一个 ID）', 'Allowed WeChat users (one ID per line)'), users, t('仅允许列表中的微信用户可以触发绑定线程。', 'Only listed WeChat user IDs can trigger bound threads.')));
                    const controls = el('div', null, 'channel-actions');
                    controls.append(
                        button(t('保存允许用户', 'Save allowed users'), () => write('account', { accountId: account.id, enabled: account.enabled, allowedUsers: users.value.split(/\s+/).filter(Boolean) }), 'primary'),
                        button(account.enabled ? t('停用连接', 'Disable connection') : t('启用连接', 'Enable connection'), () => write('account', { accountId: account.id, enabled: !account.enabled, allowedUsers: users.value.split(/\s+/).filter(Boolean) }))
                    );
                    card.append(controls); accounts.append(card);
                }
            }
            binding.hidden = snapshot.accounts.length === 0;
            jobs.hidden = snapshot.accounts.length === 0 && snapshot.jobs.length === 0;
            lowerGrid.hidden = binding.hidden && jobs.hidden;
            updateSelect(accountSelect, snapshot.accounts.map(a => [a.id, a.id]));
            if (!peer.value) peer.value = snapshot.accounts.find(a => a.id === accountSelect.value)?.userId || '';
            peerList.replaceChildren(...snapshot.peers.map(p => { const o = el('option'); o.value = p.peerId; return o; }));
            bindingList.replaceChildren();
            if (snapshot.bindings.length) {
                for (const b of snapshot.bindings) {
                    const row = el('div', null, 'channel-binding');
                    const info = el('div', null, 'channel-binding-info');
                    info.append(el('p', `${b.peerId} → ${b.name || b.sessionId}`), el('small', b.cwd));
                    row.append(info, button(t('解除绑定', 'Unbind'), () => write('unbind', { accountId: b.accountId, peerId: b.peerId }), 'danger'));
                    bindingList.append(row);
                }
            } else {
                bindingList.append(el('p', t('尚未绑定任何微信聊天。在上方选择微信用户与线程后点击“绑定线程”。', 'No WeChat chats bound yet. Select a user and thread above, then click Bind thread.'), 'channel-empty-note'));
            }
            renderJobs();
            bindButton.dataset.unavailable = String(!snapshot.accounts.length || Boolean(snapshot.error));
            if (snapshot.error) { setStatus(snapshot.error, 'error'); blocked = true; }
            controls();
        }
        function changeJobPage(delta) {
            if (!snapshot) return;
            jobPage += delta;
            renderJobs(); controls();
        }
        function renderJobs() {
            const total = snapshot.jobs.length;
            jobPage = Math.max(0, Math.min(jobPage, Math.ceil(total / jobPageSize) - 1));
            const start = jobPage * jobPageSize, visible = snapshot.jobs.slice(start, start + jobPageSize);
            jobEmpty.hidden = total > 0; jobList.hidden = total === 0; jobPager.hidden = total === 0;
            jobRange.textContent = t(`最近 ${total} 条 · ${start + 1}–${start + visible.length}`, `Recent ${total} · ${start + 1}–${start + visible.length}`);
            jobPageButtons.hidden = total <= jobPageSize;
            jobPrevious.dataset.unavailable = String(jobPage === 0);
            jobNext.dataset.unavailable = String(start + jobPageSize >= total);
            const next = JSON.stringify([visible, window.PiI18n?.locale]);
            if (jobSignature === next) return;
            jobSignature = next;
            jobList.replaceChildren();
            for (const job of visible) {
                const row = el('div', null, 'channel-job'); row.setAttribute('role', 'listitem'); row.dataset.jobId = job.id;
                const top = el('div', null, 'channel-job-top');
                top.append(el('strong', job.kind === 'cron' ? t('定时通知', 'Scheduled notification') : t('微信消息', 'WeChat message')), badge(labels()[job.status] || job.status, jobKind(job.status)));
                const recipient = el('span', job.peerId, 'channel-job-peer'); recipient.title = job.peerId;
                const meta = el('div', null, 'channel-job-meta'), date = new Date(job.at), time = el('time');
                if (Number.isFinite(date.getTime())) {
                    time.dateTime = date.toISOString(); time.title = date.toLocaleString();
                    time.textContent = date.toLocaleString(window.PiI18n?.locale === 'en' ? 'en-US' : 'zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
                }
                meta.append(recipient, time); row.append(top, meta);
                const sent = [];
                if (job.sentChunks) sent.push(t(`文字 ${job.sentChunks} 段`, `${job.sentChunks} text chunks`));
                if (job.sentMedia) sent.push(t(`图片/文件 ${job.sentMedia} 个`, `${job.sentMedia} images/files`));
                if (sent.length) row.append(el('small', t('已发送：', 'Sent: ') + sent.join(' · '), 'channel-job-sent'));
                if (job.waiting) row.append(el('p', t('正在等待交互确认，请打开 Pivane 线程处理。', 'Waiting for confirmation. Open the Pivane thread to respond.'), 'channel-job-alert'));
                if (job.reason && reasons()[job.reason]) row.append(el('p', reasons()[job.reason], 'channel-job-reason'));
                const issueLabels = { size: t('超过 16 MiB', 'Exceeds 16 MiB'), limit: t('超过附件数量限制', 'Attachment limit exceeded'), unreadable: t('读取或校验失败', 'Read or verification failed'), unavailable: t('发送组件不可用', 'Delivery unavailable'), pending: t('尚在生成', 'Still generating'), failed: t('生成未完成', 'Generation incomplete') };
                for (const issue of (job.deliveryIssues || []).slice(0, 20)) row.append(el('p', `${issue.name}：${issueLabels[issue.reason] || issueLabels.unreadable}`, 'channel-job-reason'));
                const actions = el('div', null, 'channel-actions');
                if (['running', 'dispatching'].includes(job.status)) actions.append(button(t('停止任务', 'Stop task'), () => write('stop', { jobId: job.id }), 'danger'));
                if (job.canRecover) actions.append(button(t('核对并发送原生回复', 'Check and send native reply'), () => write('recover', { jobId: job.id }), 'primary'));
                if (['uncertain', 'failed', 'ready'].includes(job.status)) actions.append(button(t('标记已核对', 'Mark reviewed'), () => write('acknowledge', { jobId: job.id })));
                if (actions.childElementCount) row.append(actions);
                jobList.append(row);
            }
        }
        function setTarget(value) {
            if (!value?.cwd || !value?.sessionId) return;
            target = { ...value };
            if (active) { if (![...project.options].some(o => o.value === value.cwd)) { const option = el('option', value.cwd); option.value = value.cwd; project.append(option); } project.value = value.cwd; void loadSessions(value.sessionId); }
        }
        async function open() {
            active = true; fetching = false; readEpoch++; root.classList.add('active'); const n = ++epoch; blocked = false;
            if (!snapshot) {
                component.hidden = true; lowerGrid.hidden = true;
                if (window.PiSkeleton) {
                    setStatus('', 'info');
                    skeletonWrap.hidden = false;
                    skeletonWrap.innerHTML = window.PiSkeleton.html('cards', { rows: 2, label: t('正在读取消息渠道…', 'Loading messaging channels…') });
                } else {
                    setStatus(t('正在读取…', 'Loading…'), 'info');
                }
            }
            void refresh();
            try {
                const data = await host.apiFetch('/api/pi/projects'); if (!valid(n)) return;
                const rows = data.projects.map(p => [p.cwd, p.name || p.cwd]); const chosen = target?.cwd || host.currentCwd();
                if (chosen && !rows.some(r => r[0] === chosen)) rows.unshift([chosen, chosen]); updateSelect(project, rows, chosen);
                await loadSessions(target?.sessionId);
            } catch { if (valid(n)) setStatus(t('无法读取项目，请刷新。', 'Unable to read projects. Refresh to check.'), 'error'); }
        }
        function close() { active = false; epoch++; readEpoch++; fetching = false; sessionEpoch++; clearTimeout(timer); root.classList.remove('active'); target = null; snapshot = null; signature = ''; jobPage = 0; jobSignature = ''; jobList.replaceChildren(); component.replaceChildren(); skeletonWrap.hidden = true; skeletonWrap.replaceChildren(); }
        return { root, open, close, setTarget };
    }
    window.PiChannels = { create };
})();
