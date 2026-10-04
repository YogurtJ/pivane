(() => {
    const t = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, i) => values[i] ?? `{${i}}`));
    const $ = id => document.getElementById(id);
    const el = (tag, text, attrs = {}) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = t(text); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value); return node; };
    const modeLabel = mode => t(({ environment: '使用运行环境', direct: '直连', custom: '自定义代理' })[mode] || '使用运行环境');
    let active = false, epoch = 0, snapshot, busy = false, dirty = false, uncertain = false, section;
    function field(text, control) { const label = el('label', undefined, { class: 'network-field' }); label.append(el('span', text), control); return label; }
    function select(id, options) { const node = el('select', undefined, { id }); for (const [value, label] of options) node.append(el('option', label, { value })); return node; }
    function button(id, text, primary = false) { return el('button', text, { id, type: 'button', class: primary ? 'settings-primary-button' : 'settings-secondary-button' }); }
    function fold(title, content) { const node = el('details', undefined, { class: 'network-details' }); node.append(el('summary', title), content); return node; }
    function paragraph(text) { return el('p', text, { class: 'network-note' }); }
    function card(id, icon, title, description) {
        const node = el('section', undefined, { id, class: 'network-card', 'aria-labelledby': id + '-title' });
        const head = el('header', undefined, { class: 'network-card-head' }), mark = el('i', undefined, { class: 'fa-solid ' + icon, 'aria-hidden': 'true' });
        const titles = el('div'); titles.append(el('h4', title, { id: id + '-title' }), paragraph(description)); head.append(mark, titles); node.append(head); return node;
    }
    async function request(method = 'GET', body, endpoint = 'settings') {
        const response = await window.WorkspaceAccess.fetch('/api/network/' + endpoint, { method, credentials: 'same-origin', cache: 'no-store',
            headers: { 'X-Pi-Access': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        const data = await response.json(); if (!response.ok) throw Error(t(data.error || '网络设置暂不可用')); return data;
    }
    function feedback(text, error = false) { const node = $('network-feedback'); node.textContent = text; node.dataset.error = String(error); node.hidden = !text; }
    function proxyDraft() { const mode = $('network-proxy-mode').value; return { mode, url: mode === 'custom' ? $('network-proxy-url').value.trim() : '', noProxy: $('network-no-proxy').value.trim() }; }
    function controls() {
        const disabled = busy || !snapshot?.authEnabled || uncertain;
        for (const id of ['network-listen-save', 'network-proxy-save', 'network-proxy-test', 'network-discard']) $(id).disabled = disabled;
        $('network-listen-save').disabled ||= !snapshot?.listenEditable;
        $('network-listen-mode').disabled = busy || !snapshot?.listenEditable;
        for (const id of ['network-proxy-mode', 'network-proxy-url', 'network-no-proxy', 'network-test-target']) $(id).disabled = busy;
        $('network-custom-proxy').hidden = $('network-proxy-mode').value !== 'custom';
        $('network-refresh').disabled = busy;
        $('workspace-access-refresh').disabled = busy;
        $('network-listen-save').textContent = t(busy ? '正在处理…' : '保存访问范围');
        $('network-proxy-save').textContent = t(busy ? '正在处理…' : '保存代理');
    }
    function render(data) {
        snapshot = data; dirty = false; uncertain = false;
        $('network-summary').textContent = `${t(data.current.local ? '仅本机访问' : '允许其他设备连接')} · ${t(data.authEnabled ? '登录验证已开启' : '登录验证未开启')} · ${modeLabel(data.current.proxyMode)}`;
        $('network-pending').hidden = !data.restartRequired;
        $('network-current-listen').textContent = t('当前监听：{0}', `${data.current.host}:${data.current.port}`);
        $('network-listen-mode').value = data.saved.listen || (data.current.local ? 'local' : 'devices');
        $('network-listen-source').textContent = t(data.listenSource === 'deployment' ? '由部署配置 HOST 管理。需要在服务器修改后重启。' : data.listenSource === 'legacy' ? '沿用旧安装的监听范围；选择后可交由此页面管理。' : '更改后重启生效，不会自动开放防火墙。');
        $('network-auth-hint').hidden = data.authEnabled;
        $('network-proxy-mode').value = data.saved.proxy.mode;
        $('network-proxy-url').value = data.saved.proxy.url;
        $('network-no-proxy').value = data.saved.proxy.noProxy;
        $('network-proxy-current').textContent = t('当前使用：{0}', modeLabel(data.current.proxyMode)) + (data.current.proxyMode === 'environment' ? ' · ' + t(data.current.usesProxy ? '检测到代理配置' : '更新源未使用代理') : '');
        $('network-environment-note').textContent = t(data.nativeProxy ? '检测到 Pi 原生代理。运行环境模式保留现有配置；直连或自定义仅覆盖 Pivane 受管请求。' : '运行环境模式沿用服务器已有代理；未配置时直连。不会改变浏览器或系统 VPN。');
        $('network-addresses').replaceChildren();
        for (const item of data.addresses) {
            const row = el('div', undefined, { class: 'network-address' });
            row.append(el('span', item.kind === 'local' ? '服务器本机' : '其他设备 · 待验证'), el('code', item.url));
            const copy = button('', '复制地址'); copy.removeAttribute('id');
            copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(item.url); feedback(t('地址已复制')); } catch { feedback(t('无法复制，请手动选择地址'), true); } });
            row.append(copy); $('network-addresses').append(row);
        }
        if (!data.addresses.length) $('network-addresses').append(paragraph('未发现可展示的访问地址，请核对部署配置。'));
        controls();
    }
    async function load() {
        const n = ++epoch; busy = true; controls();
        try { const data = await request(); if (!active || n !== epoch) return; render(data); }
        catch (error) { if (active && n === epoch) feedback(error.message, true); }
        finally { if (n === epoch) { busy = false; controls(); } }
    }
    async function save(part, value) {
        if (busy || uncertain || !snapshot) return;
        if (part === 'listen' && value === 'devices' && !confirm(t('允许其他设备连接可能暴露到公网。请确认已启用登录验证，并自行限制防火墙和网络入口。保存不会重启服务。'))) return;
        if (part === 'listen' && value === 'local' && !snapshot.current.local && !confirm(t('重启后，直接远程连接将不可用。请先保留服务器本机、SSH 或本机隧道的恢复方式。'))) return;
        const n = epoch; busy = true; controls(); feedback('');
        try {
            const data = await request('PUT', { section: part, value, confirmed: true, expectedRevision: snapshot.revision });
            if (!active || n !== epoch) return;
            // Saving one section must not erase unsaved edits in the other.
            const proxy = proxyDraft(), listen = $('network-listen-mode').value;
            render(data);
            if (part === 'listen') { $('network-proxy-mode').value = proxy.mode; $('network-proxy-url').value = proxy.url; $('network-no-proxy').value = proxy.noProxy; }
            if (part === 'proxy') $('network-listen-mode').value = listen;
            dirty = JSON.stringify(proxyDraft()) !== JSON.stringify(data.saved.proxy) || $('network-listen-mode').value !== (data.saved.listen || (data.current.local ? 'local' : 'devices'));
            feedback(t(data.restartRequired ? '已保存，安全重启后生效。当前任务与网络连接未改变。' : '已保存，当前无需重启。'));
        } catch (error) { if (active && n === epoch) { uncertain = true; feedback(error.message + ' ' + t('请刷新核对后再保存；未自动重试。'), true); } }
        finally { if (n === epoch) { busy = false; controls(); } }
    }
    async function test() {
        if (busy || !snapshot) return;
        const n = epoch; busy = true; controls(); feedback(t('正在测试草稿配置…'));
        try {
            const data = await request('POST', { proxy: proxyDraft(), target: $('network-test-target').value }, 'test');
            if (!active || n !== epoch) return;
            feedback(data.reached ? t('已连接到目标（HTTP {0}，{1} ms）。未保存配置，也未调用生成模型。', data.status, data.durationMs) : t('未能连接。请检查服务器上的代理地址、端口与网络。'), !data.ok);
        } catch (error) { if (active && n === epoch) feedback(error.message, true); }
        finally { if (n === epoch) { busy = false; controls(); } }
    }
    function build() {
        const panel = $('workspace-access-panel'); if (!panel) return;
        if ($('network-model-link')) $('network-model-link').textContent = t('网络代理设置');
        $('workspace-access-nav').querySelector('span').textContent = t('网络与访问');
        const heading = panel.querySelector('.settings-panel-header'); heading.querySelector('h3').textContent = t('网络与访问'); heading.querySelector('p').textContent = t('管理工作台的访问方式与服务器网络连接。');
        const summary = paragraph('正在读取网络状态'); summary.id = 'network-summary'; heading.after(summary);
        const pending = el('div', undefined, { id: 'network-pending', class: 'network-pending', hidden: '' });
        pending.append(el('strong', '有配置等待重启生效'), paragraph('保存不会中断任务。请在任务结束、草稿保存后，由部署端安全重启整个服务。'), button('network-discard', '撤销待生效配置')); summary.after(pending);
        const security = card('network-security', 'fa-shield-halved', '访问安全', '用登录验证保护工作台。已登录设备共享此实例的使用权限。');
        const accessForm = $('workspace-access-form'); accessForm.before(security); security.append(accessForm);
        const note = accessForm.querySelector('p.workspace-access-note:not([id])'); if (note) { const help = fold('访问安全说明', note); accessForm.append(help); }
        const listen = card('network-listen', 'fa-laptop', '访问范围', '选择哪些设备可以直接连接这个工作台。');
        listen.append(field('允许连接的设备', select('network-listen-mode', [['local', '仅本机访问'], ['devices', '允许其他设备连接']])), paragraph(''));
        listen.lastChild.id = 'network-current-listen';
        const source = paragraph(''); source.id = 'network-listen-source'; listen.append(source);
        const addresses = el('div', undefined, { id: 'network-addresses', class: 'network-addresses' });
        const accessHelp = el('div'); accessHelp.append(addresses, paragraph('候选地址不代表已连通。防火墙、路由和容器端口映射仍需自行配置。'), paragraph('允许其他设备连接不等于仅限局域网；公网接口也可能接受连接。IPv4 与 IPv6 应分别核对。'));
        listen.append(fold('访问地址与部署说明', accessHelp), button('network-listen-save', '保存访问范围', true));
        const proxy = card('network-proxy', 'fa-route', '出站代理', '用于更新检查与 Pivane 管理的模型请求。');
        const current = paragraph(''); current.id = 'network-proxy-current'; proxy.append(current);
        proxy.append(field('连接方式', select('network-proxy-mode', [['environment', '使用运行环境'], ['direct', '直连'], ['custom', '自定义代理']])));
        const input = el('input', undefined, { id: 'network-proxy-url', type: 'url', placeholder: 'http://127.0.0.1:7890', autocomplete: 'off', spellcheck: 'false', maxlength: '2048' });
        const custom = el('div', undefined, { id: 'network-custom-proxy', hidden: '' }); custom.append(field('代理地址', input), paragraph('这里的 localhost 指运行 Pivane 的服务器，不是打开网页的设备。')); proxy.append(custom);
        const advanced = el('div'); const environment = paragraph(''); environment.id = 'network-environment-note';
        advanced.append(environment, field('额外绕过代理的地址', el('input', undefined, { id: 'network-no-proxy', type: 'text', placeholder: 'localhost,192.168.1.10,.example.com', maxlength: '2048', autocomplete: 'off' })),
            paragraph('本机回环与内部连接默认直连。额外地址用逗号分隔；不支持 CIDR。'),
            paragraph('支持 HTTP/HTTPS 代理，暂不支持 SOCKS、PAC 或带账号密码的自定义地址。'),
            paragraph('保存后重启整个服务生效。不会接管浏览器、独立 CLI、任意 Shell 或第三方扩展；系统 VPN/TUN 不受直连选项控制。'));
        proxy.append(fold('高级与适用范围', advanced));
        const actions = el('div', undefined, { class: 'network-actions' }); actions.append(button('network-proxy-save', '保存代理', true));
        const testFold = el('div', undefined, { class: 'network-test' }); testFold.append(field('测试目标', select('network-test-target', [['github', 'GitHub'], ['npm', 'npm']])), button('network-proxy-test', '测试连接'));
        proxy.append(actions, fold('测试草稿连接', testFold));
        const remote = card('network-remote', 'fa-globe', '远程访问', '推荐私有网络或 HTTPS；无需在这里安装穿透工具。');
        for (const [title, description, url] of [
            ['Tailscale 私有访问', '直接访问 Tailscale 地址需要相应监听；同机 Tailscale Serve 可转发到本机地址，无需开放全部接口。', 'https://tailscale.com/kb/1242/tailscale-serve'],
            ['HTTPS 反向代理', '同机代理可连接本机监听。需要保留 Host、转发 WebSocket、配置 Secure Cookie，并限制后端直接入口。', 'https://github.com/YogurtJ/pivane/blob/main/docs/ACCESS_CONTROL.md'],
            ['本机隧道与端口转发', 'SSH 转发或同机隧道客户端可以访问回环监听。隧道可能扩大访问范围，仍应启用 Token；不自动创建公网入口。', 'https://github.com/YogurtJ/pivane/blob/main/docs/ACCESS_CONTROL.md']]) {
            const content = el('div'); content.append(paragraph(description)); const link = el('a', '查看接入指引', { href: url, target: '_blank', rel: 'noopener noreferrer' }); content.append(link); remote.append(fold(title, content));
        }
        const hint = paragraph('请先在上方开启登录验证，再修改网络设置或测试代理。'); hint.id = 'network-auth-hint';
        const feedbackNode = el('p', undefined, { id: 'network-feedback', role: 'status', 'aria-live': 'polite', hidden: '' });
        const refresh = button('network-refresh', '刷新网络状态'); const footer = el('div', undefined, { class: 'network-footer' }); footer.append(hint, feedbackNode, refresh);
        panel.append(listen, proxy, remote, footer);
        for (const id of ['network-listen-mode', 'network-proxy-mode', 'network-proxy-url', 'network-no-proxy']) $(id).addEventListener('input', () => { dirty = true; controls(); });
        $('network-listen-save').addEventListener('click', () => save('listen', $('network-listen-mode').value));
        $('network-proxy-save').addEventListener('click', () => save('proxy', proxyDraft()));
        $('network-discard').addEventListener('click', () => { if (confirm(t('撤销已保存但尚未生效的网络配置？当前运行连接不会改变。'))) void save('discard', null); });
        $('network-proxy-test').addEventListener('click', test);
        const refreshNetwork = () => { if (!dirty || confirm(t('刷新会替换本页未保存的网络草稿，是否继续？'))) void load(); };
        $('network-refresh').addEventListener('click', refreshNetwork);
        $('workspace-access-refresh').addEventListener('click', refreshNetwork);
        window.addEventListener('workspace:network-access-changed', () => {
            if (!active) return;
            if (snapshot) { snapshot.authEnabled = Boolean(window.WorkspaceAccess.enabled); $('network-auth-hint').hidden = snapshot.authEnabled; controls(); }
            if (!dirty && !busy) void load();
        });
        window.addEventListener('workspace:access-ready', () => { if (active && !dirty) void load(); });
        controls();
    }
    window.WorkspaceNetwork = {
        open(target) { active = true; section = target; void load().then(() => { if (active && section === 'proxy') $('network-proxy')?.scrollIntoView({ block: 'start' }); }); },
        close() { active = false; epoch++; busy = false; }
    };
    document.addEventListener('DOMContentLoaded', build, { once: true });
})();
