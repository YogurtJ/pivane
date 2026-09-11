const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createECDH, randomBytes } = require('node:crypto');
const { PiNotificationService, subscription } = require('../server/pi-notification-service');
function sub(host = 'fcm.googleapis.com') {
    const key = createECDH('prime256v1'); key.generateKeys();
    return { endpoint: `https://${host}/push/test`, keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}
function fixture(t, send) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-notify-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    let valid = true;
    const identity = { kind: 'open', tag: 'test' };
    const service = new PiNotificationService({ filePath: path.join(dir, 'notifications.json'),
        access: { validIdentity: i => valid && i?.tag === 'test' }, store: { resolveProject: p => { if (p !== '/project') throw Error(); return p; } }, send });
    return { service, identity, revoke: () => { valid = false; } };
}
test('push endpoint validation rejects arbitrary hosts, credentials and malformed keys', () => {
    for (const host of ['localhost', '127.0.0.1', 'fcm.googleapis.com.evil.test', 'evil.test']) assert.throws(() => subscription(sub(host)));
    for (const host of ['fcm.googleapis.com', 'web.push.apple.com', 'updates.push.services.mozilla.com', 'a.notify.windows.com']) assert.ok(subscription(sub(host)));
    assert.throws(() => subscription({ ...sub(), endpoint: 'https://secret@fcm.googleapis.com/x' }));
    assert.throws(() => subscription({ ...sub(), keys: { p256dh: 'bad', auth: 'bad' } }));
});
test('subscriptions persist privately, completion deduplicates, revocation stops delivery', async t => {
    const sent = []; const { service, identity, revoke } = fixture(t, async (s, body) => sent.push(JSON.parse(body)));
    assert.equal(service.read(), null);
    const s = sub(); service.save({ subscription: s }, identity); service.save({ subscription: s }, identity);
    assert.equal(service.read().devices.length, 1);
    require('./private-file-helper.cjs').assertPrivateFile(service.filePath);
    const event = { cwd: '/project', sessionId: 'id', completionId: 'one', text: 'PRIVATE CHAT' };
    await service.notify(event); await service.notify(event);
    assert.equal(sent.length, 1); assert.ok(!JSON.stringify(sent).includes('PRIVATE CHAT'));
    await service.notify({ ...event, cwd: '/outside', completionId: 'outside' }); assert.equal(sent.length, 1);
    revoke(); await service.notify({ ...event, completionId: 'two' }); assert.equal(sent.length, 1);
    assert.equal(service.status({ subscription: s }, identity).enabled, false);
});
test('expired endpoints removed, uncertain failures never retry, disabled subscriptions stop', async t => {
    let calls = 0; let code = 500;
    const { service, identity } = fixture(t, async () => { calls++; throw { statusCode: code }; });
    const s = sub(); service.save({ subscription: s }, identity);
    await service.notify({ cwd: '/project', completionId: 'one' }); assert.equal(calls, 1); assert.equal(service.read().devices.length, 1);
    code = 410; await service.notify({ cwd: '/project', completionId: 'two' }); assert.equal(service.read().devices.length, 0);
    service.save({ subscription: s }, identity); service.remove({ subscription: s });
    await service.notify({ cwd: '/project', completionId: 'three' }); assert.equal(calls, 2);
});
test('notification routes require actual workspace identity and never expose private keys', async t => {
    const express = require('express');
    const { WorkspaceAccessService } = require('../server/workspace-access-service');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-notify-http-'));
    const access = new WorkspaceAccessService({ filePath: path.join(dir, 'access.json'), envToken: () => 'test-notification-token-only' });
    const service = new PiNotificationService({ access, store: {}, send: async () => {} });
    const app = express(); app.use(express.json()); app.use(access.middleware()); service.mount(app);
    const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
    t.after(async () => { access.dispose(); await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(url + '/notifications')).status, 401);
    const headers = { Authorization: 'Bearer test-notification-token-only', 'Content-Type': 'application/json' };
    assert.equal((await fetch(url + '/notifications/key', { method: 'POST', headers: { ...headers, Origin: 'https://evil.invalid' } })).status, 403);
    const key = await (await fetch(url + '/notifications/key', { method: 'POST', headers })).json();
    assert.deepEqual(Object.keys(key), ['publicKey']);
    const s = sub(); const body = JSON.stringify({ subscription: s });
    assert.equal((await fetch(url + '/notifications/subscription', { method: 'PUT', headers, body })).status, 200);
    assert.equal((await fetch(url + '/notifications/test', { method: 'POST', headers, body })).status, 200);
    assert.equal((await fetch(url + '/notifications/test', { method: 'POST', headers, body })).status, 400);
});
test('service worker shows mobile notifications and focuses existing window without navigation', async () => {
    const vm = require('node:vm'); const handlers = {}; const shown = []; let focused = 0; let opened = 0;
    const self = { location: { origin: 'https://workspace.test' }, addEventListener: (name, fn) => { handlers[name] = fn; },
        registration: { showNotification: async (...args) => shown.push(args) },
        clients: { matchAll: async () => [{ url: 'https://workspace.test/', focus: async () => focused++ }], openWindow: async () => opened++ } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/pi-notification-sw.js'), 'utf8'), { self, URL });
    let task; handlers.push({ data: { json: () => ({ title: 'Pi', body: '完成', id: 'event', url: 'https://evil.test' }) }, waitUntil: promise => { task = promise; } }); await task;
    assert.equal(shown.length, 1); assert.equal(shown[0][1].data.url, 'https://workspace.test/');
    handlers.notificationclick({ notification: { close() {}, data: { url: 'https://evil.test' } }, waitUntil: promise => { task = promise; } }); await task;
    assert.equal(focused, 1); assert.equal(opened, 0); assert.equal(handlers.fetch, undefined);
});
