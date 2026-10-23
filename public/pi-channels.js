(() => {
    const t = (zh, en) => window.PiI18n?.locale === 'en' ? en : zh;
    const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
    const icon = name => { const i = el('i', null, /^fa-(brands|regular|solid)\b/.test(name) ? name : `fa-solid ${name}`); i.setAttribute('aria-hidden', 'true'); return i; };
    const button = (label, action, variant = 'secondary') => {
        const b = el('button', label, variant === 'primary' ? 'settings-primary-button channel-btn-primary' : variant === 'danger' ? 'settings-secondary-button channel-btn-danger' : 'settings-secondary-button');
        b.type = 'button'; b.addEventListener('click', action); return b;
    };
    const iconButton = (glyph, label, action) => {
        const b = el('button', null, 'channel-icon-button'); b.type = 'button';
        b.setAttribute('aria-label', label); b.title = label; b.append(icon(glyph)); b.addEventListener('click', action); return b;
    };
    const badge = (text, kind = 'neutral') => { const b = el('span', text, 'channel-badge'); b.dataset.kind = kind; return b; };
    // Overflow menus hold destructive or rarely used actions; each item still runs its own confirmation.
    const menu = (name, items) => {
        const wrap = el('details', null, 'channel-menu');
        const summary = el('summary'); summary.append(icon('fa-ellipsis'));
        summary.setAttribute('aria-label', `${t('更多操作', 'More actions')} · ${name}`); summary.title = t('更多操作', 'More actions');
        const list = el('div', null, 'channel-menu-list');
        for (const item of items) {
            const b = button(item.label, () => { wrap.open = false; item.action(); }, item.variant);
            b.prepend(icon(item.icon)); list.append(b);
        }
        wrap.append(summary, list); return wrap;
    };
    document.addEventListener('click', event => {
        for (const open of document.querySelectorAll('.channel-menu[open]')) if (!open.contains(event.target)) open.open = false;
    }, true);
    document.addEventListener('keydown', event => {
        const open = event.key === 'Escape' && document.querySelector('.channel-menu[open]');
        if (!open) return;
        event.preventDefault(); event.stopPropagation(); open.open = false; open.querySelector('summary')?.focus();
    }, true);
    const cardHead = (glyph, title, subtitle, status, actions) => {
        const head = el('div', null, 'channel-card-head');
        const mark = el('span', null, 'channel-card-icon'); mark.append(icon(glyph));
        const copy = el('div', null, 'channel-card-copy');
        copy.append(el('h4', title));
        if (subtitle) copy.append(el('p', subtitle));
        head.append(mark, copy);
        if (status) { const side = el('div', null, 'channel-card-status'); side.append(status); head.append(side); }
        if (actions) { actions.classList.add('channel-card-menu'); head.append(actions); }
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
    const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const validUser = id => id.length > 0 && id.length <= 256 && !/[\x00-\x1f]/.test(id);
    const labels = () => ({ queued: t('等待线程空闲', 'Waiting for thread'), dispatching: t('正在投递', 'Submitting'), running: t('运行中', 'Running'), ready: t('回复待发送', 'Reply pending'), sending: t('正在发送回复', 'Sending reply'), delivered: t('已送达', 'Delivered'), partial: t('部分送达', 'Partially delivered'), uncertain: t('需要核对', 'Needs review'), reviewed: t('已核对', 'Reviewed'), ignored: t('未进入线程', 'Not submitted'), failed: t('失败', 'Failed'), cancelled: t('已取消', 'Cancelled') });
    const jobKind = status => status === 'delivered' || status === 'reviewed' ? 'on' : ['running', 'dispatching', 'sending', 'queued', 'ready'].includes(status) ? 'info' : ['uncertain', 'failed', 'partial'].includes(status) ? 'error' : 'off';
    const needsAttention = job => ['uncertain', 'failed'].includes(job.status) || Boolean(job.waiting);
    const inProgress = job => ['queued', 'dispatching', 'running', 'ready', 'sending'].includes(job.status);
    const reasons = () => ({ unbound: t('尚未绑定线程', 'No thread binding'), 'reply-context-missing': t('缺少微信回复上下文，请在微信再发一条消息', 'Reply context is missing; send another WeChat message'), 'unsupported-message': t('当前支持文字私聊，请用文字重发', 'Text DMs are supported; resend as text'), 'queue-full': t('待处理消息已满', 'Pending queue is full'), restart: t('服务重启，未自动重试', 'Service restarted; no automatic retry'), 'execution-or-delivery-uncertain': t('执行或发送结果不确定，请查看线程', 'Execution or delivery is uncertain; inspect the thread'), 'binding-changed': t('绑定已变化', 'Binding changed'), 'attachments-incomplete': t('部分附件尚未发送，请查看下方说明或打开线程。', 'Some attachments were not sent. See details below or open the thread.'), 'admission-changed': t('执行前权限或绑定已变化', 'Permission or binding changed before execution'), 'delivery-revoked': t('回复权限已撤销', 'Reply permission was revoked'), 'notification-revoked': t('定时通知已关闭', 'Scheduled notification was disabled') });
    const commandList = () => [
        ['/help', t('查看全部指令', 'List commands')], ['/status', t('线程、模型与用量', 'Thread, model and usage')], ['/stop', t('停止当前任务', 'Stop the current task')],
        ['/confirm', t('确认待生成的媒体卡片', 'Confirm a pending media card')], ['/new', t('新建线程并切换', 'Start and switch to a new thread')], ['/resume', t('列出或切换线程', 'List or switch threads')],
        ['/name', t('重命名当前线程', 'Rename this thread')], ['/model', t('查看或切换模型', 'Show or switch models')], ['/thinking', t('查看或切换思考等级', 'Show or switch thinking level')],
        ['/compact', t('压缩上下文', 'Compact the context')], ['/reload', t('重新加载技能与扩展', 'Reload skills and extensions')]
    ];
    let editorId = 0;
    function create(host) {
        const root = el('section', null, 'workspace-settings-panel channel-panel'); root.dataset.settingsPanel = 'channels';
        const header = el('header', null, 'channel-header');
        const headerIcon = el('span', null, 'channel-header-icon'); headerIcon.append(icon('fa-comments'));
        const intro = el('div', null, 'channel-intro');
        intro.append(el('h3', t('消息渠道', 'Messaging channels')), el('p', t('把微信私聊连接到 Pivane 线程，手机和网页共用对话上下文。', 'Connect a WeChat DM to a Pivane thread and continue the conversation from your phone.')));
        const synced = el('span', '', 'channel-synced');
        const refreshButton = iconButton('fa-rotate', t('刷新状态', 'Refresh status'), () => refresh(true));
        const headerActions = el('div', null, 'channel-header-actions'); headerActions.append(synced, refreshButton);
        header.append(headerIcon, intro, headerActions);

        const status = el('p', '', 'channel-feedback'); status.setAttribute('role', 'status');
        const skeletonWrap = el('div', null, 'channel-skeleton-wrap'); skeletonWrap.hidden = true;
        const overview = el('div', null, 'channel-overview'); overview.hidden = true;
        const component = el('section', null, 'channel-card channel-connector-card');
        const accounts = el('div', null, 'channel-accounts');
        const lowerGrid = el('div', null, 'channel-lower-grid');
        const binding = el('section', null, 'channel-card channel-binding-card');
        const accountSelect = el('select'), peer = el('select'), project = el('select'), session = el('select'), replyMode = el('select');
        for (const [value, caption] of [['all', t('接收该线程的全部最终结果', 'All final results from this thread')], ['wechat', t('仅回复微信发起的消息', 'Only replies to WeChat messages')]]) {
            const option = el('option', caption); option.value = value; replyMode.append(option);
        }
        const bindButton = button(t('绑定线程', 'Bind thread'), () => write('bind', { accountId: accountSelect.value, peerId: peer.value, cwd: project.value, replyMode: replyMode.value,
            ...(session.value === '__new__' ? { newSession: true } : { sessionId: session.value }) }), 'primary');
        bindButton.prepend(icon('fa-link'));
        const bindForm = el('div', null, 'channel-bind-grid');
        bindForm.append(
            label(t('微信账号', 'WeChat account'), accountSelect),
            label(t('微信用户', 'WeChat user'), peer),
            label(t('项目', 'Project'), project),
            label(t('线程', 'Thread'), session),
            label(t('接收方式', 'Receive'), replyMode)
        );
        const bindHint = el('span', '', 'channel-bind-hint');
        const bindFooter = el('div', null, 'channel-bind-footer');
        bindFooter.append(bindHint, bindButton);
        const bindingList = el('div', null, 'channel-bindings');
        binding.append(
            cardHead('fa-link', t('线程绑定', 'Thread bindings'), t('默认接收网页、微信与定时任务的最终结果，包括绑定时尚未完成的任务。已完成的历史不补发。', 'Receive final results from web, WeChat and scheduled tasks, including work still running when bound. Completed history is not sent.')),
            bindForm, bindFooter, bindingList
        );
        const jobs = el('section', null, 'channel-card channel-jobs-card');
        const jobFilters = el('div', null, 'channel-job-filters'); jobFilters.setAttribute('role', 'group'); jobFilters.setAttribute('aria-label', t('筛选消息', 'Filter messages'));
        const jobList = el('div', null, 'channel-job-list'); jobList.setAttribute('role', 'list');
        const jobEmpty = el('p', t('绑定后，网页或微信发起任务即可在这里查看结果投递。', 'After binding, run a task from the web or WeChat to see result delivery here.'), 'channel-empty-note');
        const jobPager = el('div', null, 'channel-job-pager');
        const jobRange = el('span', '', 'channel-job-range');
        const jobPrevious = button(t('上一页', 'Previous'), () => changeJobPage(-1));
        const jobNext = button(t('下一页', 'Next'), () => changeJobPage(1));
        const jobPageButtons = el('div', null, 'channel-job-page-buttons'); jobPageButtons.append(jobPrevious, jobNext);
        jobPager.append(jobRange, jobPageButtons);
        jobs.append(cardHead('fa-paper-plane', t('最近消息与投递', 'Recent messages and delivery'), t('最新记录在前，每页显示 5 条。', 'Newest first, 5 records per page.')), jobFilters, jobEmpty, jobList, jobPager);
        let jobPage = 0, jobSignature = '', jobFilter = 'all';
        const jobPageSize = 5;
        const filterButtons = new Map();
        for (const [value, caption] of [['all', t('全部', 'All')], ['attention', t('需处理', 'Needs attention')], ['active', t('进行中', 'In progress')]]) {
            const b = button(caption, () => { jobFilter = value; jobPage = 0; renderJobs(); controls(); });
            b.classList.add('channel-filter'); b.dataset.jobFilter = value; b.append(el('span', '0', 'channel-filter-count'));
            filterButtons.set(value, b); jobFilters.append(b);
        }
        for (const b of [jobPrevious, jobNext, ...filterButtons.values()]) b.dataset.channelReadOnly = 'true';
        lowerGrid.append(binding, jobs);
        root.append(header, status, skeletonWrap, overview, component, accounts, lowerGrid);

        let active = false, epoch = 0, readEpoch = 0, fetching = false, writing = false, blocked = false, snapshot = null, timer = null, target = null, sessionEpoch = 0, signature = '', overviewSignature = '', statusTimer = null;
        const accountDrafts = new Map(), pendingInputs = new Map();
        const valid = n => active && n === epoch;
        function setStatus(message, tone = 'info', transient = false) {
            clearTimeout(statusTimer);
            status.textContent = message || '';
            status.dataset.tone = tone;
            if (transient && message) statusTimer = setTimeout(() => { if (status.textContent === message) status.textContent = ''; }, 3200);
        }
        function markSynced() {
            const now = new Date();
            synced.textContent = t('已同步 ', 'Synced ') + now.toLocaleTimeString(window.PiI18n?.locale === 'en' ? 'en-US' : 'zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
            synced.title = now.toLocaleString();
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
        accountSelect.addEventListener('change', () => { updatePeers(); controls(); });
        peer.addEventListener('change', () => { updatePeers(); controls(); });
        // Only saved allowed users can be bound; the server rejects anyone else.
        function updatePeers() {
            const account = snapshot?.accounts.find(a => a.id === accountSelect.value);
            const users = account?.allowedUsers || [];
            const chosen = users.includes(peer.value) ? peer.value : account?.userId && users.includes(account.userId) ? account.userId : users[0];
            updateSelect(peer, users.map(id => [id, id === account?.userId ? `${id} · ${t('扫码用户', 'scanner')}` : id]), chosen);
            const bound = snapshot?.bindings.find(b => b.accountId === accountSelect.value && b.peerId === peer.value);
            bindHint.textContent = !snapshot?.accounts.length ? t('先扫码连接微信账号。', 'Connect a WeChat account first.')
                : !users.length ? t('先在账号卡片里添加允许的微信用户并保存。', 'Add and save an allowed WeChat user on the account card first.')
                : bound ? t(`此用户当前绑定到“${bound.name || bound.sessionId}”，绑定新线程会替换它。`, `This user is bound to “${bound.name || bound.sessionId}”. Binding again replaces it.`)
                : t('绑定后可从微信继续提问，也能接收线程的最终结果。首次接收前，请先在微信发一条消息。', 'Continue in WeChat and receive final results after binding. Send a WeChat message first to enable delivery.');
            bindButton.dataset.unavailable = String(!snapshot?.accounts.length || !users.length || Boolean(snapshot?.error));
        }
        function focusBinding() {
            binding.scrollIntoView({ block: 'start', behavior: 'smooth' });
            (peer.options.length ? peer : accountSelect).focus({ preventScroll: true });
        }
        async function refresh(explicit = false) {
            if (!active || fetching || writing) return;
            const n = epoch, ticket = ++readEpoch; fetching = true;
            const current = () => valid(n) && ticket === readEpoch;
            try {
                const result = await host.apiFetch('/api/pi/channels');
                if (!current()) return;
                if (!Array.isArray(result.accounts) || !Array.isArray(result.bindings) || !Array.isArray(result.jobs)) throw Error('Invalid channels snapshot');
                const changedDraft = snapshot && snapshot.revision !== result.revision && accountDrafts.size > 0;
                snapshot = { ...result, peers: Array.isArray(result.peers) ? result.peers : [] };
                skeletonWrap.hidden = true; skeletonWrap.replaceChildren();
                markSynced();
                if (changedDraft && !explicit) {
                    blocked = true;
                    setStatus(t('服务器配置已变化，草稿已保留。请刷新核对已保存的允许用户后再保存。', 'Server configuration changed. Drafts are kept. Refresh and review the saved allowed users before saving.'), 'warning');
                }
                if (explicit) blocked = false;
                render();
                if (result.error) setStatus(result.error, 'error');
                else if (explicit) setStatus(t('已更新连接与投递状态。', 'Connection and delivery status updated.'), 'success', true);
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
            if (action === 'uninstall' && !window.confirm(t('卸载微信连接组件？账号、允许用户与线程绑定会保留，重新安装后可继续使用。', 'Uninstall the WeChat connector? Accounts, allowed users and thread bindings are kept for a later reinstall.'))) return;
            if (action === 'unbind' && !window.confirm(t(`解除 ${values.peerId} 的线程绑定？之后该用户的消息不会进入此线程，线程与历史保留。`, `Unbind ${values.peerId}? Their messages will no longer enter this thread. The thread and its history are kept.`))) return;
            if (action === 'account' && values.confirmDisable && !window.confirm(t('停用这个微信连接？尚未进入线程的排队消息会取消，已在运行的任务继续完成。', 'Disable this WeChat connection? Queued messages that have not entered a thread are cancelled; running tasks finish.'))) return;
            if (action === 'acknowledge' && !window.confirm(t('已在网页核对这条消息？标记后不会重跑任务或补发回复。', 'Have you reviewed this message in the web thread? Marking it reviewed will not rerun the task or resend its reply.'))) return;
            delete values.confirmDisable;
            const n = epoch, revision = snapshot.revision; readEpoch++; fetching = false; writing = true; controls(); setStatus(t('正在处理…', 'Working…'), 'info');
            try {
                const result = await host.apiFetch('/api/pi/channels/weixin/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...values, confirmed: true, expectedRevision: revision }) });
                if (!valid(n)) return;
                snapshot = { ...result, peers: Array.isArray(result.peers) ? result.peers : [] }; signature = ''; if (action === 'account') accountDrafts.delete(values.accountId);
                markSynced(); render(); setStatus(t('操作已完成。', 'Action completed.'), 'success', true);
                if (action === 'bind') void loadSessions(result.bindings.find(b => b.accountId === values.accountId && b.peerId === values.peerId)?.sessionId);
            } catch (error) {
                if (valid(n)) {
                    blocked = true;
                    setStatus(t('操作失败或结果待核对。请先刷新，不会自动重试。', 'The action failed or its outcome needs review. Refresh first; it will not be retried automatically.') + (error?.message ? ' ' + error.message : ''), 'error');
                }
            } finally { writing = false; if (valid(n)) { controls(); clearTimeout(timer); timer = setTimeout(() => refresh(), 1200); } }
        }
        function renderOverview() {
            const c = snapshot.component, installed = c.installed && !c.broken;
            const connected = snapshot.accounts.filter(a => a.connection === 'connected').length;
            const attention = snapshot.jobs.filter(needsAttention).length;
            const next = JSON.stringify([c.installed, c.broken, c.version, snapshot.accounts.length, connected, snapshot.bindings.length, attention, window.PiI18n?.locale]);
            overview.hidden = !c.installed;
            if (next === overviewSignature) return;
            overviewSignature = next;
            const tiles = [
                ['fa-puzzle-piece', t('连接组件', 'Connector'), c.broken ? t('需要修复', 'Needs repair') : installed ? `v${c.version}` : t('未安装', 'Not installed'), c.broken ? 'error' : installed ? 'on' : 'off'],
                ['fa-user-check', t('微信账号', 'WeChat accounts'), snapshot.accounts.length ? t(`${connected}/${snapshot.accounts.length} 已连接`, `${connected}/${snapshot.accounts.length} connected`) : t('未连接', 'None yet'), connected ? 'on' : snapshot.accounts.length ? 'warn' : 'off'],
                ['fa-link', t('线程绑定', 'Thread bindings'), snapshot.bindings.length ? t(`${snapshot.bindings.length} 个聊天`, `${snapshot.bindings.length} chat${snapshot.bindings.length === 1 ? '' : 's'}`) : t('未绑定', 'None yet'), snapshot.bindings.length ? 'on' : 'off'],
                ['fa-bell', t('需处理', 'Needs attention'), attention ? t(`${attention} 条消息`, `${attention} message${attention === 1 ? '' : 's'}`) : t('没有', 'Nothing'), attention ? 'warn' : 'on']
            ];
            overview.replaceChildren(...tiles.map(([glyph, caption, value, kind], index) => {
                const tile = el(index === 3 && attention ? 'button' : 'div', null, 'channel-tile');
                tile.dataset.kind = kind;
                const mark = el('span', null, 'channel-tile-icon'); mark.append(icon(glyph));
                const copy = el('span', null, 'channel-tile-copy'); copy.append(el('small', caption), el('strong', value));
                tile.append(mark, copy);
                if (tile.tagName === 'BUTTON') {
                    tile.type = 'button'; tile.dataset.channelReadOnly = 'true';
                    tile.setAttribute('aria-label', `${caption}: ${value}`);
                    tile.addEventListener('click', () => { jobFilter = 'attention'; jobPage = 0; renderJobs(); controls(); jobs.scrollIntoView({ block: 'start', behavior: 'smooth' }); filterButtons.get('attention').focus({ preventScroll: true }); });
                }
                return tile;
            }));
        }
        function capabilityBlock() {
            const caps = snapshot.capabilities || { text: true, images: true, files: true, slashCommands: true, typing: true, proactive: true };
            const wrap = el('div', null, 'channel-capabilities');
            const chips = el('ul', null, 'channel-capability-list'); chips.setAttribute('aria-label', t('已支持', 'Supported'));
            for (const [key, glyph, caption] of [['text', 'fa-message', t('文字私聊', 'Text DMs')], ['images', 'fa-image', t('图片收发', 'Images')], ['files', 'fa-file-arrow-down', t('文件交付', 'File delivery')],
                ['typing', 'fa-ellipsis', t('正在输入', 'Typing indicator')], ['proactive', 'fa-clock', t('定时通知', 'Scheduled notifications')], ['slashCommands', 'fa-terminal', t('斜杠指令', 'Slash commands')]]) {
                if (!caps[key]) continue;
                const chip = el('li', null, 'channel-capability'); chip.append(icon(glyph), document.createTextNode(caption)); chips.append(chip);
            }
            const commands = el('details', null, 'channel-commands');
            commands.append(el('summary', t('查看斜杠指令', 'View slash commands')));
            const table = el('dl', null, 'channel-command-list');
            for (const [name, meaning] of commandList()) table.append(el('dt', name), el('dd', meaning));
            commands.append(table);
            wrap.append(chips, el('p', t('暂不支持：语音、视频与普通微信群。', 'Not yet available: voice, video and ordinary WeChat groups.'), 'channel-note'), commands);
            return wrap;
        }
        function setupSteps(installed) {
            const hasAccount = snapshot.accounts.length > 0, hasBinding = snapshot.bindings.length > 0;
            const steps = el('ol', null, 'channel-steps');
            const items = [
                [t('安装组件', 'Install connector'), t('确认后下载到运行 Pivane 的机器。', 'Downloads to the machine running Pivane after you confirm.'), installed,
                    () => button(t('安装微信组件', 'Install WeChat connector'), () => write('install'), 'primary')],
                [t('扫码授权微信', 'Scan QR code'), t('用手机微信扫码登录 ClawBot。', 'Scan with WeChat on your phone to sign in to ClawBot.'), hasAccount,
                    () => snapshot.login ? null : button(t('扫码连接微信', 'Connect with QR code'), () => write('login'), 'primary')],
                [t('绑定对话线程', 'Bind thread'), t('选择允许的微信用户和目标线程。', 'Choose an allowed WeChat user and a target thread.'), hasBinding,
                    () => { const b = button(t('去绑定线程', 'Go to binding'), focusBinding, 'primary'); b.dataset.channelReadOnly = 'true'; return b; }]
            ];
            let current = items.findIndex(item => !item[2]);
            items.forEach(([title, hint, done, action], index) => {
                const step = el('li', null, 'channel-step');
                step.dataset.state = done ? 'done' : index === current ? 'current' : 'todo';
                const num = el('span', null, 'channel-step-num');
                if (done) num.append(icon('fa-check')); else num.textContent = String(index + 1);
                const copy = el('div', null, 'channel-step-copy'); copy.append(el('strong', title, 'channel-step-label'), el('small', hint));
                step.append(num, copy);
                if (index === current) { const control = action(); if (control) step.append(control); }
                steps.append(step);
            });
            return steps;
        }
        function allowEditor(account) {
            const saved = account.allowedUsers;
            const current = () => accountDrafts.get(account.id) ?? saved;
            const wrap = el('div', null, 'channel-allow');
            const caption = el('span', t('允许使用的微信用户', 'Allowed WeChat users'), 'channel-field-label'); caption.id = `channel-allow-${++editorId}`;
            const chips = el('ul', null, 'channel-chips'); chips.setAttribute('aria-labelledby', caption.id);
            const input = el('input'); input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false; input.setAttribute('autocapitalize', 'none');
            input.placeholder = t('输入微信用户 ID，回车添加', 'Type a WeChat user ID and press Enter');
            input.setAttribute('aria-label', t('添加允许的微信用户 ID', 'Add allowed WeChat user ID'));
            input.dataset.focusKey = `allow:${account.id}`; input.value = pendingInputs.get(account.id) || '';
            input.addEventListener('input', () => { if (input.value) pendingInputs.set(account.id, input.value); else pendingInputs.delete(account.id); });
            const add = button(t('添加', 'Add'), () => addFrom(input.value)); add.prepend(icon('fa-plus'));
            const addRow = el('div', null, 'channel-allow-add'); addRow.append(input, add);
            const suggest = el('div', null, 'channel-allow-suggest');
            const hint = el('small', t('只有列表中的用户能在绑定线程里对话并使用该线程已有的工具，请只添加你信任的人。', "Only listed users can talk in bound threads and use those threads' tools. Add only people you trust."), 'channel-field-hint');
            const savedList = el('details', null, 'channel-saved-users');
            savedList.append(el('summary', t('查看服务器已保存的允许用户', 'View saved allowed users')), el('p', saved.join('\n') || t('（空）', '(empty)')));
            const bar = el('div', null, 'channel-save-bar');
            const barText = el('span', '', 'channel-save-text');
            const revert = button(t('撤销修改', 'Discard changes'), () => { accountDrafts.delete(account.id); paint(); });
            const save = button(t('保存允许用户', 'Save allowed users'), () => write('account', { accountId: account.id, enabled: account.enabled, allowedUsers: current() }), 'primary');
            const barActions = el('div', null, 'channel-actions'); barActions.append(revert, save);
            bar.append(barText, barActions);
            wrap.append(caption, chips, addRow, suggest, hint, savedList, bar);
            const setDraft = list => {
                const next = [...new Set(list)];
                if (sameList(next, saved)) accountDrafts.delete(account.id); else accountDrafts.set(account.id, next);
                paint();
            };
            function addFrom(value) {
                const ids = value.split(/[\s,，;；]+/).filter(Boolean);
                if (!ids.length) return;
                const invalid = ids.filter(id => !validUser(id));
                if (invalid.length) { setStatus(t('微信用户 ID 不能超过 256 个字符或包含控制字符。', 'WeChat user IDs must be at most 256 characters without control characters.'), 'error'); return; }
                if (new Set([...current(), ...ids]).size > 100) { setStatus(t('每个账号最多允许 100 个微信用户。', 'Each account allows at most 100 WeChat users.'), 'error'); return; }
                setDraft([...current(), ...ids]); input.value = ''; pendingInputs.delete(account.id); input.focus();
            }
            input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); addFrom(input.value); } });
            function paint() {
                const users = current(), dirty = accountDrafts.has(account.id);
                chips.replaceChildren(...users.map(id => {
                    const chip = el('li', null, 'channel-chip'); chip.dataset.added = String(!saved.includes(id));
                    const name = el('span', id, 'channel-chip-name'); name.title = id; chip.append(name);
                    if (id === account.userId) chip.append(el('small', t('扫码用户', 'Scanner'), 'channel-chip-tag'));
                    const remove = iconButton('fa-xmark', `${t('移除', 'Remove')} ${id}`, () => setDraft(users.filter(x => x !== id)));
                    chip.append(remove); return chip;
                }));
                if (!users.length) chips.append(el('li', t('还没有允许的用户', 'No allowed users yet'), 'channel-chips-empty'));
                const known = [...new Set([account.userId, ...snapshot.peers.filter(p => p.accountId === account.id).map(p => p.peerId)])].filter(id => id && !users.includes(id)).slice(0, 6);
                suggest.hidden = !known.length;
                suggest.replaceChildren(el('span', t('快速添加：', 'Quick add:')), ...known.map(id => {
                    const b = button(id, () => setDraft([...current(), id])); b.prepend(icon('fa-plus')); b.classList.add('channel-chip-suggest');
                    b.setAttribute('aria-label', `${t('允许', 'Allow')} ${id}`); b.title = id; return b;
                }));
                savedList.hidden = !dirty;
                bar.hidden = !dirty;
                const removed = saved.filter(id => !users.includes(id)).length, added = users.filter(id => !saved.includes(id)).length;
                barText.textContent = t(`未保存：新增 ${added} 个，移除 ${removed} 个`, `Unsaved: ${added} added, ${removed} removed`);
                save.dataset.unavailable = String(account.enabled && !users.length);
                save.title = account.enabled && !users.length ? t('已启用的连接至少需要一个允许用户', 'An enabled connection needs at least one allowed user') : '';
                controls();
            }
            paint();
            return wrap;
        }
        function render() {
            if (!snapshot) return;
            component.hidden = false;
            renderOverview();
            const nextSignature = JSON.stringify([snapshot.revision, snapshot.component, snapshot.login, snapshot.accounts, snapshot.bindings.length > 0, snapshot.peers.map(p => [p.accountId, p.peerId]), snapshot.capabilities, snapshot.typing?.filter(row => ['degraded', 'unavailable'].includes(row.status)), window.PiI18n?.locale]);
            if (signature !== nextSignature) {
                signature = nextSignature;
                // Rebuilding cards keeps drafts in maps; restore keyboard focus to the same control.
                const focusKey = root.contains(document.activeElement) ? document.activeElement.dataset?.focusKey : null;
                const c = snapshot.component, installed = c.installed && !c.broken;
                const compBadge = badge(
                    c.broken ? t('组件需要修复', 'Connector needs repair') : installed ? t('已安装', 'Installed') : t('未安装 · 按需下载', 'Not installed · On-demand'),
                    c.broken ? 'error' : installed ? 'on' : 'off');
                const compSubtitle = c.broken
                    ? t('组件校验未通过，请先停用连接后卸载重装。', 'Connector verification failed. Disable connections, then uninstall and reinstall.')
                    : installed ? t(`腾讯官方组件 v${c.version}，版本随 Pivane 锁定并校验。`, `Official Tencent connector v${c.version}, pinned and verified by Pivane.`)
                    : t('按需安装；未安装时不会下载微信依赖或启动后台连接。', 'Optional installation. WeChat dependencies and connections are loaded only when installed.');
                const compMenu = c.installed ? menu(t('微信组件', 'WeChat connector'), [{ label: t('卸载组件', 'Uninstall connector'), icon: 'fa-trash', variant: 'danger', action: () => write('uninstall') }]) : null;
                component.replaceChildren(cardHead('fa-brands fa-weixin', t('微信 ClawBot', 'WeChat ClawBot'), compSubtitle, compBadge, compMenu));
                const done = installed && snapshot.accounts.length > 0 && snapshot.bindings.length > 0;
                if (done) {
                    const ready = el('div', null, 'channel-ready');
                    const mark = el('span', null, 'channel-ready-icon'); mark.append(icon('fa-circle-check'));
                    const copy = el('div', null, 'channel-ready-copy');
                    copy.append(el('strong', t('已就绪', 'Ready')), el('small', t('在微信给 ClawBot 发消息，就会进入绑定的线程。', 'Message ClawBot in WeChat to continue in the bound thread.')));
                    ready.append(mark, copy);
                    if (!snapshot.login) { const again = button(t('扫码连接微信', 'Connect with QR code'), () => write('login')); again.prepend(icon('fa-qrcode')); ready.append(again); }
                    component.append(ready);
                } else {
                    component.append(setupSteps(installed));
                    if (installed && snapshot.accounts.length && !snapshot.login) {
                        const extra = el('div', null, 'channel-actions');
                        const again = button(t('扫码添加账号', 'Add another account'), () => write('login')); again.prepend(icon('fa-qrcode'));
                        extra.append(again); component.append(extra);
                    }
                }
                if (c.error) component.append(el('p', c.error, 'channel-inline-alert'));

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
                component.append(capabilityBlock());

                accounts.replaceChildren();
                for (const account of snapshot.accounts) {
                    const card = el('section', null, 'channel-card channel-account-card'); card.dataset.accountId = account.id;
                    const names = { connected: t('已连接', 'Connected'), disabled: t('已停用', 'Disabled'), starting: t('连接中', 'Connecting'), error: t('连接异常', 'Connection error') };
                    const connKind = account.connection === 'connected' ? 'on' : account.connection === 'error' ? 'error' : account.connection === 'starting' ? 'info' : 'off';
                    const allowed = () => accountDrafts.get(account.id) ?? account.allowedUsers;
                    const accountMenu = account.enabled ? menu(account.id, [{ label: t('停用连接', 'Disable connection'), icon: 'fa-circle-pause', variant: 'danger',
                        action: () => write('account', { accountId: account.id, enabled: false, allowedUsers: allowed(), confirmDisable: true }) }]) : null;
                    card.append(cardHead('fa-user-check', account.id, account.userId ? t('扫码用户：', 'Scanner ID: ') + account.userId : '', badge(names[account.connection] || account.connection, connKind), accountMenu));
                    if (!account.enabled) {
                        const resume = el('div', null, 'channel-paused');
                        resume.append(el('span', t('连接已停用，不会接收此账号的新消息。', 'This connection is disabled and will not receive new messages.')));
                        const enable = button(t('启用连接', 'Enable connection'), () => write('account', { accountId: account.id, enabled: true, allowedUsers: allowed() }), 'primary');
                        enable.prepend(icon('fa-circle-play')); resume.append(enable); card.append(resume);
                    }
                    const typingIssues = (snapshot.typing || []).filter(row => row.accountId === account.id && ['degraded', 'unavailable'].includes(row.status));
                    if (typingIssues.length) card.append(el('p', t('正在输入状态暂不可用；消息处理仍会继续，下次任务会重新获取状态票据。', 'Typing feedback is unavailable. Message processing continues; the next task will request a fresh ticket.'), 'channel-inline-alert'));
                    card.append(allowEditor(account));
                    accounts.append(card);
                }
                if (focusKey) [...root.querySelectorAll('[data-focus-key]')].find(n => n.dataset.focusKey === focusKey)?.focus({ preventScroll: true });
            }
            binding.hidden = snapshot.accounts.length === 0;
            jobs.hidden = snapshot.accounts.length === 0 && snapshot.jobs.length === 0;
            lowerGrid.hidden = binding.hidden && jobs.hidden;
            updateSelect(accountSelect, snapshot.accounts.map(a => [a.id, a.id]));
            updatePeers();
            const bindingSignature = JSON.stringify([snapshot.bindings, typeof window.PiChatNavigation?.openSession === 'function', window.PiI18n?.locale]);
            if (bindingList.dataset.signature !== bindingSignature) {
                bindingList.dataset.signature = bindingSignature;
                bindingList.replaceChildren();
                if (snapshot.bindings.length) {
                    for (const b of snapshot.bindings) {
                        const row = el('div', null, 'channel-binding');
                        const info = el('div', null, 'channel-binding-info');
                        const route = el('p', null, 'channel-binding-route');
                        route.append(el('span', b.peerId, 'channel-binding-peer'), icon('fa-arrow-right-long'), el('strong', b.name || b.sessionId));
                        info.append(route, el('small', b.cwd), el('small', b.replyMode === 'wechat'
                            ? t('仅微信问答', 'WeChat replies only') : t('接收全部最终结果 · 定时任务默认跟随', 'All final results · scheduled tasks follow by default')));
                        const actions = el('div', null, 'channel-binding-actions');
                        if (typeof window.PiChatNavigation?.openSession === 'function') {
                            const open = button(t('打开线程', 'Open thread'), () => window.PiChatNavigation.openSession({ cwd: b.cwd, sessionId: b.sessionId }).catch(error => setStatus(error.message, 'error')));
                            open.dataset.channelReadOnly = 'true'; open.prepend(icon('fa-arrow-up-right-from-square')); actions.append(open);
                        }
                        actions.append(button(t('接收设置', 'Receive settings'), () => {
                            accountSelect.value = b.accountId; updatePeers(); peer.value = b.peerId; updatePeers();
                            project.value = b.cwd; replyMode.value = b.replyMode || 'all'; void loadSessions(b.sessionId); focusBinding();
                        }));
                        actions.append(button(t('解除绑定', 'Unbind'), () => write('unbind', { accountId: b.accountId, peerId: b.peerId }), 'danger'));
                        row.append(info, actions);
                        bindingList.append(row);
                    }
                } else {
                    bindingList.append(el('p', t('尚未绑定任何微信聊天。在上方选择微信用户与线程后点击“绑定线程”。', 'No WeChat chats bound yet. Select a user and thread above, then click Bind thread.'), 'channel-empty-note'));
                }
            }
            renderJobs();
            if (snapshot.error) { setStatus(snapshot.error, 'error'); blocked = true; }
            controls();
        }
        function changeJobPage(delta) {
            if (!snapshot) return;
            jobPage += delta;
            renderJobs(); controls();
        }
        function renderJobs() {
            const counts = { all: snapshot.jobs.length, attention: snapshot.jobs.filter(needsAttention).length, active: snapshot.jobs.filter(inProgress).length };
            for (const [value, b] of filterButtons) {
                b.lastChild.textContent = String(counts[value]);
                b.classList.toggle('active', value === jobFilter); b.setAttribute('aria-pressed', String(value === jobFilter));
                b.dataset.alert = String(value === 'attention' && counts.attention > 0);
            }
            jobFilters.hidden = snapshot.jobs.length === 0;
            const filtered = jobFilter === 'attention' ? snapshot.jobs.filter(needsAttention) : jobFilter === 'active' ? snapshot.jobs.filter(inProgress) : snapshot.jobs;
            const total = filtered.length;
            jobPage = Math.max(0, Math.min(jobPage, Math.ceil(total / jobPageSize) - 1));
            const start = jobPage * jobPageSize, visible = filtered.slice(start, start + jobPageSize);
            jobEmpty.hidden = total > 0; jobList.hidden = total === 0; jobPager.hidden = total === 0;
            jobEmpty.textContent = snapshot.jobs.length === 0 ? t('绑定后，网页或微信发起任务即可在这里查看结果投递。', 'After binding, run a task from the web or WeChat to see result delivery here.')
                : jobFilter === 'attention' ? t('没有需要处理的消息。', 'Nothing needs attention.') : t('没有进行中的消息。', 'No messages in progress.');
            jobRange.textContent = t(`共 ${total} 条 · ${start + 1}–${start + visible.length}`, `${total} total · ${start + 1}–${start + visible.length}`);
            jobPageButtons.hidden = total <= jobPageSize;
            jobPrevious.dataset.unavailable = String(jobPage === 0);
            jobNext.dataset.unavailable = String(start + jobPageSize >= total);
            const next = JSON.stringify([visible, window.PiI18n?.locale]);
            if (jobSignature === next) return;
            jobSignature = next;
            jobList.replaceChildren();
            for (const job of visible) {
                const row = el('div', null, 'channel-job'); row.setAttribute('role', 'listitem'); row.dataset.jobId = job.id;
                if (needsAttention(job)) row.dataset.attention = 'true';
                const top = el('div', null, 'channel-job-top');
                const kind = el('strong', null, 'channel-job-kind');
                const kinds = { thread: ['fa-check', t('线程最终结果', 'Thread final result')], cron: ['fa-clock', t('定时通知', 'Scheduled notification')], slash: ['fa-terminal', t('斜杠指令', 'Slash command')], notice: ['fa-circle-info', t('系统提示', 'Notice')] };
                const [kindIcon, kindName] = kinds[job.kind] || ['fa-message', t('微信消息', 'WeChat message')];
                kind.append(icon(kindIcon), document.createTextNode(kindName));
                top.append(kind, badge(labels()[job.status] || job.status, jobKind(job.status)));
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
                component.hidden = true; lowerGrid.hidden = true; overview.hidden = true;
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
                const hidden = new Set(data.hiddenProjects || []);
                const rows = (data.projects || []).filter(p => p?.cwd && !hidden.has(p.cwd)).map(p => [p.cwd, p.name || p.cwd]); const chosen = target?.cwd || (hidden.has(host.currentCwd()) ? '' : host.currentCwd());
                if (chosen && !rows.some(r => r[0] === chosen)) rows.unshift([chosen, chosen]); updateSelect(project, rows, chosen);
                await loadSessions(target?.sessionId);
            } catch { if (valid(n)) setStatus(t('无法读取项目，请刷新。', 'Unable to read projects. Refresh to check.'), 'error'); }
        }
        function close() {
            active = false; epoch++; readEpoch++; fetching = false; sessionEpoch++; clearTimeout(timer); clearTimeout(statusTimer); root.classList.remove('active'); target = null; snapshot = null; signature = ''; overviewSignature = '';
            jobPage = 0; jobSignature = ''; jobFilter = 'all'; jobList.replaceChildren(); component.replaceChildren(); overview.replaceChildren(); bindingList.dataset.signature = ''; synced.textContent = '';
            skeletonWrap.hidden = true; skeletonWrap.replaceChildren();
        }
        return { root, open, close, setTarget };
    }
    window.PiChannels = { create };
})();
