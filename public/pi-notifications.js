(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const $ = id => document.getElementById(id);
    const status = $('pi-notification-status');
    const buttons = ['enable', 'disable', 'test', 'refresh'].map(name => $('pi-notification-' + name));
    let busy = false;
    const supported = () => window.isSecureContext && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
    const ios = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
    const standalone = () => navigator.standalone || matchMedia('(display-mode: standalone)').matches;
    async function api(path, method = 'GET', body) {
        const response = await (window.WorkspaceAccess?.fetch || fetch)('/api/pi/notifications' + path, {
            method, headers: { 'Content-Type': 'application/json', 'X-Pi-Access': '1' },
            ...(body ? { body: JSON.stringify(body) } : {})
        });
        const data = await response.json();
        if (!response.ok) throw Error(response.status === 404 ? translateUi("通知后端尚未启用，请等待服务空闲更新后刷新。") : data.error || translateUi("通知请求失败"));
        return data;
    }
    function availability() {
        if (!window.isSecureContext) return translateUi("当前地址是 HTTP，浏览器不允许系统通知。请使用可信 HTTPS 地址（服务器本机 localhost 除外）。");
        if (ios() && !standalone()) return translateUi("iPhone / iPad 需要 iOS 16.4 或更新版本：在 Safari 中将此 HTTPS 网站添加到主屏幕，再从主屏幕打开并启用通知。");
        if (!supported()) return translateUi("此浏览器不支持 Web Push，请使用支持通知的新版浏览器。");
        if (Notification.permission === 'denied') return translateUi("通知权限已被拒绝。请在浏览器／系统的网站通知设置中允许，再刷新状态。");
        return '';
    }
    async function registration(create = false) {
        const existing = await navigator.serviceWorker.getRegistration('/');
        if (existing && ![existing.active, existing.waiting, existing.installing].some(w => w?.scriptURL === new URL('/pi-notification-sw.js', location.href).href)) {
            throw Error(translateUi("此地址已有其他 Service Worker，无法启用通知。"));
        }
        if (existing || !create) return existing;
        await navigator.serviceWorker.register('/pi-notification-sw.js', { scope: '/', updateViaCache: 'none' });
        return Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(Error(translateUi("通知服务启动超时，请刷新状态后核对。"))), 15000))]);
    }
    async function current() { return (await registration())?.pushManager.getSubscription(); }
    async function refresh() {
        const reason = availability();
        buttons[0].disabled = Boolean(reason); buttons[1].disabled = true; buttons[2].disabled = true;
        if (reason && (!supported() || ios() && !standalone())) { status.textContent = reason; return; }
        await api('');
        const sub = await current();
        if (reason) { buttons[1].disabled = !sub; status.textContent = reason; return; }
        const enabled = sub && (await api('/status', 'POST', { subscription: sub.toJSON() })).enabled;
        window.PiPageNotifications?.setPushEnabled(enabled);
        buttons[0].disabled = Boolean(enabled);
        buttons[1].disabled = !sub; buttons[2].disabled = !enabled;
        status.textContent = enabled ? translateUi("本设备已启用：回复完成、任务失败和等待确认时接收通知。") : translateUi("本设备尚未启用。点击启用后，浏览器会请求通知权限。");
    }
    async function run(action) {
        if (busy) return; busy = true; buttons.forEach(button => { button.disabled = true; });
        try { await action(); }
        catch (error) {
            status.textContent = error.message || translateUi("通知操作失败，请刷新状态核对。");
            buttons[0].disabled = Boolean(availability());
        }
        finally { busy = false; buttons[3].disabled = false; }
    }
    buttons[0].addEventListener('click', () => {
        if (busy) return;
        const reason = availability(); if (reason) { status.textContent = reason; return; }
        // Invoke permission directly in the click gesture, before any network await (Safari).
        const permission = Notification.requestPermission();
        void run(async () => {
            if (await permission !== 'granted') { await refresh(); return; }
            status.textContent = translateUi("正在启用通知…");
            const { publicKey } = await api('/key', 'POST');
            const reg = await registration(true);
            let sub = await reg.pushManager.getSubscription();
            const bytes = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
            if (sub && sub.options.applicationServerKey && !Array.from(new Uint8Array(sub.options.applicationServerKey)).every((v, i) => v === bytes[i])) {
                await sub.unsubscribe(); sub = null;
            }
            sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
            await api('/subscription', 'PUT', { subscription: sub.toJSON() });
            await refresh();
        });
    });
    buttons[1].addEventListener('click', () => void run(async () => {
        const sub = await current();
        if (sub) { await api('/subscription', 'DELETE', { subscription: sub.toJSON() }); await sub.unsubscribe(); }
        await refresh();
    }));
    buttons[2].addEventListener('click', () => void run(async () => {
        const sub = await current(); if (!sub) throw Error(translateUi("请先启用本设备通知"));
        await api('/test', 'POST', { subscription: sub.toJSON() });
        await refresh(); status.textContent = translateUi("测试已提交给浏览器推送服务。实际显示还取决于系统通知权限、网络与勿扰模式。");
    }));
    buttons[3].addEventListener('click', () => void run(refresh));
    window.addEventListener('workspace:access-ready', () => void run(refresh));
    window.addEventListener('workspace:access-locked', () => { buttons.forEach(button => { button.disabled = true; }); status.textContent = translateUi("请先登录工作台，再启用通知。"); });
    document.querySelector('.pi-notification-advanced').addEventListener('toggle', event => {
        if (event.target.open) void run(refresh);
    });
    void (async () => {
        await window.WorkspaceAccess?.ready;
        // Check only existing registrations to prevent duplicate local/push notifications.
        if (supported() && await current().catch(() => null)) await run(refresh);
    })();
})();
