(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const $ = id => document.getElementById(id);
    const key = 'pi.web.pageNotifications';
    let prefs = { desktop: false, sound: false };
    try { const saved = JSON.parse(localStorage.getItem(key)); prefs = { desktop: saved?.desktop === true, sound: saved?.sound === true }; } catch {}
    let audio, previous = null, polling = false, epoch = 0, push = false, count = 0;
    let enabledAt = Date.now();
    const seen = new Set();
    const supported = () => window.isSecureContext && 'Notification' in window;
    const ios = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
    const canNotify = () => supported() && (!ios() || navigator.standalone || matchMedia('(display-mode: standalone)').matches);
    function render() {
        $('pi-page-notify').checked = prefs.desktop;
        $('pi-page-notify').disabled = !canNotify();
        $('pi-page-sound').checked = prefs.sound;
        $('pi-page-status').textContent = !supported()
            ? translateUi("当前为局域网 HTTP：可使用站内提醒和提示音。本机使用请打开 localhost 地址。")
            : !canNotify() ? translateUi("iPhone / iPad 的系统通知需从主屏幕应用启用；这里仍可使用提示音。")
            : Notification.permission === 'denied' ? translateUi("系统通知权限已拒绝，请在浏览器网站设置中恢复。")
            : push ? translateUi("后台推送已启用，页面不重复发送系统提醒。")
            : prefs.desktop ? translateUi("页面打开时接收系统提醒；无需连接推送服务。") : translateUi("本机 localhost 可直接开启；站内未读提醒始终保留。");
    }
    function save() { try { localStorage.setItem(key, JSON.stringify(prefs)); } catch {} render(); }
    async function sound(unlock = false) {
        if (!audio && !unlock) throw Error(translateUi("提示音需要解锁，请点击测试提醒。"));
        audio ||= new (window.AudioContext || window.webkitAudioContext)();
        if (audio.state !== 'running' && unlock) {
            await Promise.race([audio.resume(), new Promise((_, reject) => setTimeout(() => reject(Error(translateUi("声音尚未解锁，请再次点击测试提醒。"))), 1500))]);
        }
        if (audio.state !== 'running') throw Error(translateUi("浏览器暂停了声音，请点击测试提醒后重试。"));
        const oscillator = audio.createOscillator(), gain = audio.createGain();
        oscillator.connect(gain); gain.connect(audio.destination);
        oscillator.frequency.value = 740;
        gain.gain.setValueAtTime(0.06, audio.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.22);
        oscillator.start(); oscillator.stop(audio.currentTime + 0.22);
    }
    async function systemNotice(body, tag) {
        if (!canNotify() || Notification.permission !== 'granted') throw Error(translateUi("请先允许浏览器系统通知。"));
        const mobile = /Android|iPad|iPhone|iPod/.test(navigator.userAgent) || ios();
        if (mobile) {
            if (!navigator.serviceWorker) throw Error(translateUi("此浏览器不支持页面系统通知。"));
            let reg = await navigator.serviceWorker.getRegistration('/');
            const expected = new URL('/pi-notification-sw.js', location.href).href;
            if (reg && ![reg.active, reg.waiting, reg.installing].some(worker => worker?.scriptURL === expected)) throw Error(translateUi("当前地址已有其他应用的通知服务。"));
            if (!reg) {
                await navigator.serviceWorker.register('/pi-notification-sw.js', { scope: '/', updateViaCache: 'none' });
                reg = await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(Error(translateUi("通知服务启动超时"))), 15000))]);
            }
            await reg.showNotification('Pivane', { body, tag, icon: '/brand/logo-192.png' });
        } else {
            const notification = new Notification('Pivane', { body, tag, icon: '/brand/logo-192.png' });
            notification.onclick = () => { window.focus(); notification.close(); };
            setTimeout(() => notification.close(), 15000);
        }
    }
    async function notify(body, id, test = false, claimed = false) {
        if (!test && (push || !(prefs.desktop || prefs.sound)
            || window.WorkspaceAccess?.supported && !window.WorkspaceAccess.authenticated)) return;
        if (!test && !claimed) {
            const claim = async () => {
                try {
                    const last = Number(localStorage.getItem('pi.web.pageNotificationAt')) || 0;
                    if (Date.now() - last < 4500) return;
                    localStorage.setItem('pi.web.pageNotificationAt', String(Date.now()));
                } catch {}
                return notify(body, id, false, true);
            };
            if (navigator.locks) return navigator.locks.request('pi-page-notification', claim);
            return claim();
        }
        if (!test && document.hidden) {
            count++; document.title = `(${count}) ` + document.title.replace(/^\(\d+\) /, '');
        }
        const jobs = [];
        if (prefs.desktop) jobs.push(systemNotice(body, 'pi-page-' + id));
        if (prefs.sound) jobs.push(sound(test));
        const results = await Promise.allSettled(jobs);
        const failed = results.find(r => r.status === 'rejected');
        if (failed) $('pi-page-status').textContent = failed.reason.message || translateUi("通知显示失败，请检查浏览器权限。");
        else if (test) $('pi-page-status').textContent = jobs.length ? translateUi("测试提醒已触发，请检查系统通知或声音。") : translateUi("请先开启页面通知或提示音。");
    }
    async function ingest(data, generation) {
        if (generation !== epoch) return;
        const phases = new Map((data.runtimes || []).map(r => [JSON.stringify([r.cwd, r.sessionId]), r.phase]));
        const notices = (data.replyNotices || []).filter(n => !n.manual);
        if (previous === null) {
            previous = phases;
            notices.forEach(n => seen.add(n.completionId));
            return;
        }
        const events = [];
        for (const n of notices) {
            if (seen.has(n.completionId)) continue;
            seen.add(n.completionId);
            if (Date.parse(n.completedAt) >= enabledAt) events.push([translateUi("新的回复已完成，点击查看。"), n.completionId]);
        }
        for (const [id, phase] of phases) {
            if (previous.has(id) && previous.get(id) !== phase && ['waiting', 'error'].includes(phase)) {
                events.push([phase === 'waiting' ? translateUi("任务正在等待你的确认。") : translateUi("任务未成功完成，请打开工作台查看。"), 'state-' + Date.now()]);
            }
        }
        previous = phases;
        while (seen.size > 512) seen.delete(seen.values().next().value);
        // One alert for a polling interval, even when several threads settle together.
        if (events.length) await notify(events.length > 1 ? translateUi("{0} 项任务有新的提醒，请查看工作台。", events.length) : events[0][0], events[0][1]);
    }
    async function poll() {
        if (polling || !(prefs.desktop || prefs.sound) || window.WorkspaceAccess?.supported && !window.WorkspaceAccess.authenticated) return;
        polling = true; const generation = epoch;
        try {
            const response = await (window.WorkspaceAccess?.fetch || fetch)('/api/pi/activity', { signal: AbortSignal.timeout(8000) });
            if (response.ok) await ingest(await response.json(), generation);
        } catch { /* Keep the last successful baseline; never manufacture failures from a disconnect. */ }
        finally { polling = false; }
    }
    function reset() { epoch++; previous = null; seen.clear(); enabledAt = Date.now(); }
    $('pi-page-notify').addEventListener('change', async event => {
        const desired = event.target.checked;
        if (!desired) { prefs.desktop = false; save(); reset(); return; }
        event.target.disabled = true;
        try { prefs.desktop = await Notification.requestPermission() === 'granted'; }
        catch { prefs.desktop = false; }
        save(); reset(); void poll();
    });
    $('pi-page-sound').addEventListener('change', event => {
        prefs.sound = event.target.checked; save(); reset();
        if (prefs.sound) void sound(true).catch(() => { $('pi-page-status').textContent = translateUi("声音尚未解锁，请点击测试提醒。"); });
        void poll();
    });
    $('pi-page-test').addEventListener('click', () => void notify(translateUi("这是一条页面提醒，无需推送服务。"), 'test', true));
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) { count = 0; document.title = document.title.replace(/^\(\d+\) /, ''); render(); void poll(); }
    });
    window.addEventListener('storage', event => {
        if (event.key !== key) return;
        try { const next = JSON.parse(event.newValue); prefs = { desktop: next?.desktop === true, sound: next?.sound === true }; } catch { prefs = { desktop: false, sound: false }; }
        reset(); render(); void poll();
    });
    window.addEventListener('workspace:access-locked', reset);
    window.addEventListener('workspace:access-ready', () => { reset(); void poll(); });
    window.PiPageNotifications = {
        observeCompletion(notice) {
            if (!notice || notice.manual || seen.has(notice.completionId) || !(Date.parse(notice.completedAt) >= enabledAt)
                || !(prefs.desktop || prefs.sound)) return;
            seen.add(notice.completionId);
            while (seen.size > 512) seen.delete(seen.values().next().value);
            void notify(translateUi("新的回复已完成，点击查看。"), notice.completionId);
        },
        setPushEnabled(value) { push = Boolean(value); render(); }
    };
    render(); setInterval(() => void poll(), 5000);
    void (async () => { await window.WorkspaceAccess?.ready; void poll(); })();
})();
