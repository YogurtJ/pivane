/* Notification worker only: no fetch interception, offline cache or conversation storage. */
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
    event.waitUntil((async () => {
        let data = {}; try { data = event.data?.json() || {}; } catch {}
        const title = typeof data.title === 'string' ? data.title.slice(0, 80) : 'Pivane';
        await self.registration.showNotification(title, {
            body: typeof data.body === 'string' ? data.body.slice(0, 200) : '工作台有新的任务提醒。',
            icon: '/brand/logo-192.png', badge: '/brand/logo-64.png',
            tag: 'pi-' + String(data.id || 'notification').slice(0, 100),
            data: { url: self.location.origin + '/' }
        });
    })());
});
self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const existing = windows.find(client => {
            const url = new URL(client.url);
            return url.origin === self.location.origin && ['/', '/index.html'].includes(url.pathname);
        });
        if (existing) return existing.focus();
        return self.clients.openWindow('/');
    })());
});
