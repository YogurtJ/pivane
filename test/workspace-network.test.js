const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const express = require('express');
const { once } = require('node:events');
const { WorkspaceNetworkService, validateProxy } = require('../server/workspace-network-service');
const { environmentFor, proxyUrl, networkFetch } = require('../server/workspace-network-transport');
const { WorkspaceAccessService } = require('../server/workspace-access-service');
const { assertPrivateFile } = require('./private-file-helper.cjs');
function fixture(t, extra = {}) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-network-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const env = { PI_CODING_AGENT_DIR: path.join(root, 'agent'), ...extra };
    const service = new WorkspaceNetworkService({ root, env });
    service.attach({ address: service.host || '::', port: 11408 }, { configuration: () => ({ enabled: true }) });
    return { root, env, service };
}
const save = (service, section, value) => service.save({ expectedRevision: service.snapshot().revision, confirmed: true, section, value });

test('new instance is loopback; saves are private, revision checked and never change running routes', t => {
    const { service, root, env } = fixture(t);
    assert.equal(service.host, '127.0.0.1');
    const old = service.snapshot();
    const saved = save(service, 'listen', 'devices');
    assert.equal(saved.current.local, true); assert.equal(saved.pendingListen, true); assert.equal(service.host, '127.0.0.1');
    assertPrivateFile(service.filePath);
    assert.throws(() => service.save({ expectedRevision: old.revision, confirmed: true, section: 'listen', value: 'local' }), /已变化/);
    assert.throws(() => service.assertAccessChange(false), /先改为仅本机/);
    const reopened = new WorkspaceNetworkService({ root, env }); assert.equal(reopened.host, '0.0.0.0');
    assert.throws(() => reopened.assertStartup({ configuration: () => ({ enabled: false }) }), /登录验证/);
    save(service, 'discard', null); assert.equal(service.snapshot().restartRequired, false);
});

test('deployment overrides stay read-only; legacy managed unspecified bind is preserved', t => {
    const { service, env, root } = fixture(t, { HOST: '::1' });
    assert.equal(service.snapshot().listenEditable, false);
    assert.throws(() => save(service, 'listen', 'devices'), /HOST/);
    fs.mkdirSync(path.join(root, '.pivane-runtime')); fs.writeFileSync(path.join(root, '.pivane-runtime/state.json'), JSON.stringify({ active: 'prior-release' }));
    const legacy = new WorkspaceNetworkService({ root, env: { ...env, HOST: '' } });
    assert.equal(legacy.host, undefined); assert.equal(legacy.snapshot().listenSource, 'legacy');
});

test('first-start default survives future releases; private network files cannot enter previews or packages', t => {
    const { service, root, env } = fixture(t);
    service.initialize();
    assertPrivateFile(service.filePath);
    fs.mkdirSync(path.join(root, '.pivane-runtime')); fs.writeFileSync(path.join(root, '.pivane-runtime/state.json'), JSON.stringify({ active: 'newer-release' }));
    assert.equal(new WorkspaceNetworkService({ root, env }).host, '127.0.0.1');
    assert.equal(require('../public/pi-file-policy').restricted(service.filePath), true);
    assert.throws(() => require('../scripts/check-docs.cjs').assertPublicPath('pivane-network.json'), /Private/);
});

test('mode-only changes remain pending even if both routes currently connect directly', t => {
    const { service } = fixture(t);
    assert.equal(save(service, 'proxy', { mode: 'direct' }).pendingProxy, true);
    assert.equal(service.snapshot().current.proxyMode, 'environment');
    save(service, 'discard', null); assert.equal(service.snapshot().restartRequired, false);
});

test('proxy precedence handles lowercase, native fallback, explicit direct and loopback bypass', () => {
    const inherited = { https_proxy: 'http://lower.invalid:7890', HTTPS_PROXY: 'http://upper.invalid:7890', ALL_PROXY: 'http://all.invalid:7890', NO_PROXY: '.example.org' };
    const proxy = { mode: 'environment', url: '', noProxy: 'local.service:80' };
    const env = environmentFor(proxy, inherited, 'http://native.invalid:7890');
    assert.equal(proxyUrl('https://outside.invalid', env).hostname, 'lower.invalid');
    for (const url of ['https://localhost', 'http://127.1.2.3', 'https://[::1]', 'http://local.service', 'https://child.example.org']) assert.equal(proxyUrl(url, env), undefined);
    assert.ok(proxyUrl('https://notexample.org', env));
    assert.ok(proxyUrl('https://local.service', env));
    assert.equal(proxyUrl('https://outside.invalid', environmentFor({ mode: 'direct' }, inherited, 'http://native.invalid')), undefined);
    assert.equal(proxyUrl('https://outside.invalid', environmentFor({ mode: 'custom', url: 'http://chosen.invalid:1234' }, inherited)).hostname, 'chosen.invalid');
    assert.equal(proxyUrl('https://outside.invalid', environmentFor(proxy, {}, 'http://native.invalid:1234')).hostname, 'native.invalid');
});

test('malformed configuration and symlinks fail closed without leaking secrets', t => {
    const { service, env, root } = fixture(t);
    fs.mkdirSync(path.dirname(service.filePath));
    fs.writeFileSync(service.filePath, '{"url":"secret-fixture"');
    assert.throws(() => new WorkspaceNetworkService({ root, env }), error => error.status === 503 && !error.message.includes('secret-fixture'));
    fs.unlinkSync(service.filePath);
    if (process.platform !== 'win32') {
        const target = path.join(root, 'target'); fs.writeFileSync(target, '{}'); fs.symlinkSync(target, service.filePath);
        assert.throws(() => new WorkspaceNetworkService({ root, env }), /未回退/);
    }
    for (const url of ['socks5://localhost:7890', 'http://user:secret@localhost:7890', 'http://localhost:7890/path', 'http://localhost?q=secret']) assert.throws(() => validateProxy({ mode: 'custom', url }), /代理/);
    assert.throws(() => validateProxy({ mode: 'custom', url: 'http://localhost', noProxy: '10.0.0.0/8' }), /CIDR/);
});

test('proxy save stays pending until restart; native settings are never rewritten', t => {
    const { root, env, service } = fixture(t);
    const settings = path.join(env.PI_CODING_AGENT_DIR, 'settings.json'); fs.mkdirSync(path.dirname(settings)); fs.writeFileSync(settings, '{"httpProxy":"http://native.invalid:7890","unknown":true}');
    const network = new WorkspaceNetworkService({ root, env }); network.attach({ address: '127.0.0.1', port: 9000 }, { configuration: () => ({ enabled: true }) });
    const saved = save(network, 'proxy', { mode: 'direct', url: '', noProxy: '' });
    assert.equal(saved.current.proxyMode, 'environment'); assert.equal(saved.pendingProxy, true);
    const childEnv = { ...env }; network.applyEnvironment(childEnv); assert.equal(childEnv.HTTPS_PROXY, 'http://native.invalid:7890');
    const next = new WorkspaceNetworkService({ root, env }); next.applyEnvironment(childEnv); assert.equal(childEnv.HTTPS_PROXY, ''); assert.equal(childEnv.PIVANE_NETWORK_MODE, 'direct');
    assert.equal(JSON.parse(fs.readFileSync(settings)).unknown, true); assert.equal(JSON.parse(fs.readFileSync(settings)).httpProxy, 'http://native.invalid:7890');
    assert.equal(fs.existsSync(service.filePath), true);
});

test('network API requires current access identity, CSRF header and authentication for changes', async t => {
    const { service, root } = fixture(t);
    const access = new WorkspaceAccessService({ filePath: path.join(root, 'access.json'), envToken: () => '' });
    t.after(() => access.dispose());
    const app = express(); access.mount(app); app.use(express.json({ limit: '16kb' })); service.mount(app, access);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(r => server.close(r)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (route, method = 'GET', body, cookie, extra = {}) => fetch(base + route, { method, headers: { Origin: base, 'X-Pi-Access': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal((await call('/api/network/settings')).status, 200);
    assert.equal((await call('/api/network/settings', 'PUT', {})).status, 403);
    const settings = await (await call('/api/access/settings')).json();
    const response = await call('/api/access/settings', 'PUT', { enabled: true, token: 'synthetic-network-token-123456', confirmed: true, expectedRevision: settings.revision });
    const cookie = response.headers.get('set-cookie').split(';')[0];
    assert.equal((await call('/api/network/settings')).status, 401);
    assert.equal((await call('/api/network/settings', 'PUT', {}, cookie, { Origin: 'https://evil.invalid' })).status, 403);
    assert.equal((await call('/api/network/settings', 'PUT', {}, cookie, { 'X-Pi-Access': '' })).status, 403);
    const state = await (await call('/api/network/settings', 'GET', null, cookie)).json();
    assert.equal((await call('/api/network/settings', 'PUT', { expectedRevision: state.revision, confirmed: true, section: 'proxy', value: { mode: 'direct' } }, cookie)).status, 200);
    assert.equal((await call('/api/network/test', 'POST', { target: 'http://arbitrary.internal', proxy: { mode: 'direct' } }, cookie)).status, 400);
});

test('network diagnostic is bounded, fixed-target, redacts errors and does not persist', async t => {
    const { service } = fixture(t);
    let release; service.fetch = () => new Promise(resolve => { release = resolve; });
    const args = { target: 'github', proxy: { mode: 'direct' } };
    const pending = service.test(args);
    await assert.rejects(service.test(args), error => error.status === 429);
    release({ ok: false, status: 403, body: { destroy() {} } });
    assert.deepEqual((({ reached, ok, status }) => ({ reached, ok, status }))(await pending), { reached: true, ok: false, status: 403 });
    service.fetch = async () => { throw Error('secret-proxy-password'); };
    assert.equal(JSON.stringify(await service.test(args)).includes('secret'), false);
    assert.equal(fs.existsSync(service.filePath), false);
});

test('node-fetch transport tunnels remote HTTP through proxy and bypasses loopback', async t => {
    const origin = http.createServer((_req, res) => res.end('fixture-response')); origin.listen(0, '127.0.0.1'); await once(origin, 'listening');
    const proxy = http.createServer(); let connects = 0;
    const sockets = new Set();
    proxy.on('connect', (_req, socket, head) => {
        connects++; sockets.add(socket); socket.once('close', () => sockets.delete(socket));
        const upstream = net.connect(origin.address().port, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
        sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream)); upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    });
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
    const keys = ['http_proxy', 'HTTP_PROXY', 'no_proxy', 'NO_PROXY']; const prior = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    const proxyAddress = `http://127.0.0.1:${proxy.address().port}`;
    // Windows environment keys are case-insensitive; assigning an empty lowercase
    // alias would also clear HTTP_PROXY and accidentally test a direct request.
    Object.assign(process.env, { HTTP_PROXY: proxyAddress, http_proxy: proxyAddress, no_proxy: '', NO_PROXY: '' });
    t.after(async () => { for (const k of keys) if (prior[k] === undefined) delete process.env[k]; else process.env[k] = prior[k]; for (const socket of sockets) socket.destroy(); await Promise.all([new Promise(r => proxy.close(r)), new Promise(r => origin.close(r))]); });
    assert.equal(await (await networkFetch('http://remote.fixture.invalid/')).text(), 'fixture-response'); assert.equal(connects, 1);
    assert.equal(await (await networkFetch(`http://127.0.0.1:${origin.address().port}/`)).text(), 'fixture-response'); assert.equal(connects, 1);
    const { spawn } = require('node:child_process');
    const env = { PATH: process.env.PATH, ...environmentFor({ mode: 'custom', url: `http://127.0.0.1:${proxy.address().port}` }, {}) };
    const script = "require('./server/workspace-network-transport').initializeSdkNetwork().then(async()=>{const r=await fetch('http://remote.fixture.invalid');console.log(await r.text());await require('undici').getGlobalDispatcher().close()}).catch(()=>process.exitCode=1)";
    const child = spawn(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', bytes => output += bytes); child.stderr.resume();
    assert.equal((await once(child, 'exit'))[0], 0); assert.equal(output.trim(), 'fixture-response'); assert.equal(connects, 2, 'SDK dispatcher must use the same proxy');
});
