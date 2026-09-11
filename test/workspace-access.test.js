const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const modulePath = path.join(__dirname, '../server/workspace-access-service.js');

async function fixture(t, options = {}) {
    assert.ok(fs.existsSync(modulePath), 'workspace-wide access service must be implemented');
    const { WorkspaceAccessService } = require(modulePath);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-access-test-'));
    const filePath = path.join(root, 'access.json');
    const service = new WorkspaceAccessService({ filePath, envToken: () => '', ...options });
    const app = express(); service.mount(app);
    app.use(express.json());
    let executions = 0;
    app.get('/api/private', (_req, res) => res.json({ private: true }));
    app.post('/api/tts', (_req, res) => { executions++; res.json({ ok: true }); });
    app.get('/audio/test.wav', (_req, res) => res.send('private audio'));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}`;
    const call = (route, method = 'GET', body, headers = {}) => fetch(url + route, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const change = async (body, cookie = '') => {
        const state = await (await call('/api/access/settings', 'GET', undefined, cookie ? { Cookie: cookie } : {})).json();
        return call('/api/access/settings', 'PUT', { expectedRevision: state.revision, confirmed: true, ...body }, { Origin: url, 'X-Pi-Access': '1', ...(cookie ? { Cookie: cookie } : {}) });
    };
    t.after(async () => { service.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(root, { recursive: true, force: true }); });
    return { root, filePath, service, call, change, url, executions: () => executions };
}
const token = 'test-only-access-token-0123456789';
const cookieOf = response => response.headers.get('set-cookie')?.split(';')[0] || '';

test('access configuration follows the native agent directory including tilde expansion', () => {
    const { WorkspaceAccessService } = require(modulePath);
    const before = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = '~/.pi-access-path-fixture';
    const service = new WorkspaceAccessService({ envToken: () => '' });
    try { assert.equal(service.filePath, path.join(os.homedir(), '.pi-access-path-fixture/pi5-access.json')); }
    finally { service.dispose(); if (before === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = before; }
});

test('open mode keeps private-network use available but rejects cross-site requests', async t => {
    const f = await fixture(t);
    assert.equal((await f.call('/api/private')).status, 200);
    assert.equal((await f.call('/audio/test.wav')).status, 200);
    assert.equal((await f.call('/api/tts', 'POST', {}, { Origin: 'https://evil.invalid' })).status, 403);
    assert.equal((await f.call('/api/private', 'GET', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await f.call('/api/tts', 'POST', {}, { Origin: f.url })).status, 200);
    assert.equal(f.executions(), 1);
    assert.equal(fs.existsSync(f.filePath), false, 'open default must not create an access configuration');
});

test('enabling access protects API and media; same Origin alone cannot authenticate', async t => {
    const f = await fixture(t);
    const changed = await f.change({ enabled: true, token }); assert.equal(changed.status, 200);
    const cookie = cookieOf(changed); assert.ok(cookie);
    assert.match(changed.headers.get('set-cookie'), /HttpOnly/); assert.match(changed.headers.get('set-cookie'), /SameSite=Strict/);
    for (const resource of ['/api/private', '/audio/test.wav', '/downloads/private.json', '/legacy-workspace/index.html', '/%61udio/test.wav']) {
        assert.equal((await f.call(resource, 'GET', undefined, { Origin: f.url })).status, 401, resource);
    }
    assert.equal((await f.call('/api/private', 'GET', undefined, { Cookie: cookie })).status, 200);
    assert.equal((await f.call('/api/private', 'GET', undefined, { Authorization: `Bearer ${token}` })).status, 200);
    assert.equal((await f.call('/api/private', 'GET', undefined, { Cookie: cookie, Authorization: 'Bearer incorrect' })).status, 401);
    assert.equal((await f.call('/api/tts', 'POST', {}, { Cookie: cookie, Origin: 'https://evil.invalid' })).status, 403);
    assert.equal((await f.call('/api/tts', 'POST', {}, { Cookie: cookie })).status, 403, 'cookie mutations need CSRF protection');
    assert.equal((await f.call('/api/tts', 'POST', {}, { Cookie: cookie, Origin: f.url })).status, 200);
    const saved = fs.readFileSync(f.filePath, 'utf8'); assert.ok(!saved.includes(token)); assert.ok(!saved.includes(cookie.split('=')[1]));
    require('./private-file-helper.cjs').assertPrivateFile(f.filePath);
});

test('login persistence, logout, rotation and disabling revoke old browser identities', async t => {
    const f = await fixture(t); const first = await f.change({ enabled: true, token }); const a = cookieOf(first);
    const login = await f.call('/api/access/login', 'POST', { token, remember: true }, { Origin: f.url, 'X-Pi-Access': '1' });
    assert.equal(login.status, 200); const b = cookieOf(login); assert.match(login.headers.get('set-cookie'), /Max-Age=/);
    const { WorkspaceAccessService } = require(modulePath);
    const restarted = new WorkspaceAccessService({ filePath: f.filePath, envToken: () => '' });
    assert.equal(restarted.authenticate({ headers: { cookie: b } }).kind, 'cookie'); restarted.dispose();
    const logout = await f.call('/api/access/logout', 'POST', {}, { Origin: f.url, 'X-Pi-Access': '1', Cookie: b }); assert.equal(logout.status, 200);
    assert.equal((await f.call('/api/private', 'GET', undefined, { Cookie: b })).status, 401);
    assert.equal((await f.call('/api/private', 'GET', undefined, { Cookie: a })).status, 200);
    const rotated = await f.change({ enabled: true, generate: true }, a); assert.equal(rotated.status, 200);
    const data = await rotated.json(); assert.ok(data.generatedToken.length >= 32);
    const c = cookieOf(rotated);
    assert.equal((await f.call('/api/private', 'GET', undefined, { Cookie: a })).status, 401);
    assert.equal((await f.call('/api/private', 'GET', undefined, { Authorization: `Bearer ${token}` })).status, 401);
    assert.equal((await f.call('/api/private', 'GET', undefined, { Authorization: `Bearer ${data.generatedToken}` })).status, 200);
    const settings = await (await f.call('/api/access/settings', 'GET', undefined, { Cookie: c })).text(); assert.ok(!settings.includes(data.generatedToken));
    const disabled = await f.change({ enabled: false }, c); assert.equal(disabled.status, 200);
    assert.equal((await f.call('/api/private')).status, 200);
});

test('settings require current authorization and revision; failed or malformed writes preserve configuration', async t => {
    const f = await fixture(t); const state = await (await f.call('/api/access/settings')).json();
    assert.equal((await f.call('/api/access/settings', 'PUT', { enabled: true, token, confirmed: true, expectedRevision: state.revision })).status, 403);
    const initial = await f.change({ enabled: true, token }); const cookie = cookieOf(initial); const before = fs.readFileSync(f.filePath);
    assert.equal((await f.call('/api/access/settings', 'PUT', { enabled: false, expectedRevision: state.revision, confirmed: true }, { Origin: f.url, 'X-Pi-Access': '1' })).status, 401);
    assert.equal((await f.call('/api/access/settings', 'PUT', { enabled: false, expectedRevision: state.revision, confirmed: true }, { Cookie: cookie, Origin: f.url, 'X-Pi-Access': '1' })).status, 409);
    assert.equal((await f.change({ enabled: true, token: 'short' }, cookie)).status, 400);
    assert.equal((await f.change({ enabled: true, token: '中文'.repeat(10) }, cookie)).status, 400, 'HTTP Bearer tokens must use printable ASCII');
    assert.deepEqual(fs.readFileSync(f.filePath), before);
    fs.writeFileSync(f.filePath, '{broken');
    assert.equal((await f.call('/api/private')).status, 503);
    assert.equal((await f.call('/api/access/login', 'POST', { token }, { Origin: f.url, 'X-Pi-Access': '1' })).status, 503);
    assert.equal(fs.readFileSync(f.filePath, 'utf8'), '{broken');
});

test('deployment token overrides local preferences and cannot be changed by the browser', async t => {
    const f = await fixture(t, { envToken: () => token, secureCookie: true });
    assert.equal((await f.call('/api/private')).status, 401);
    const response = await f.call('/api/access/settings', 'GET', undefined, { Authorization: `Bearer ${token}` });
    const data = await response.json(); assert.equal(data.source, 'environment'); assert.equal(data.editable, false);
    assert.equal((await f.call('/api/access/settings', 'PUT', { enabled: false, confirmed: true, expectedRevision: data.revision }, { Authorization: `Bearer ${token}`, 'X-Pi-Access': '1' })).status, 403);
    const login = await f.call('/api/access/login', 'POST', { token }, { 'X-Pi-Access': '1' }); assert.match(login.headers.get('set-cookie'), /; Secure/);
});

test('internal planning credential only permits designated planning routes', async t => {
    const f = await fixture(t); await f.change({ enabled: true, token });
    const headers = { Authorization: `Bearer ${f.service.internalToken}` };
    assert.equal((await f.call('/api/media-agent/capabilities/image', 'GET', undefined, headers)).status, 404, 'authenticated planning route reaches handler');
    for (const p of ['/api/private', '/audio/test.wav', '/api/access/settings', '/api/pi/settings/models']) assert.equal((await f.call(p, 'GET', undefined, headers)).status, 401, p);
    assert.equal((await f.call('/api/tts', 'POST', {}, headers)).status, 401); assert.equal(f.executions(), 0);
});

test('missing configuration differs from a broken symlink and never fails open', async t => {
    const f = await fixture(t);
    // Junctions exercise broken reparse points without requiring Windows symlink privileges.
    fs.symlinkSync(path.join(f.root, 'missing-target'), f.filePath, process.platform === 'win32' ? 'junction' : 'file');
    assert.equal((await f.call('/api/private')).status, 503);
    assert.equal(fs.lstatSync(f.filePath).isSymbolicLink(), true);
});

test('local recovery preserves the old configuration and disables workspace authentication', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-access-reset-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'pi5-access.json'); fs.writeFileSync(file, '{damaged-fixture');
    const script = path.join(__dirname, '../scripts/access-reset.cjs');
    assert.ok(fs.existsSync(script), 'local recovery command must exist');
    const { spawnSync } = require('node:child_process');
    const env = { PATH: process.env.PATH, PI_CODING_AGENT_DIR: root };
    assert.notEqual(spawnSync(process.execPath, [script, '--disable'], { env }).status, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), '{damaged-fixture');
    const result = spawnSync(process.execPath, [script, '--disable', '--confirm'], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(file)).enabled, false);
    const backup = fs.readdirSync(root).find(name => name.startsWith('pi5-access.json.reset-'));
    assert.equal(fs.readFileSync(path.join(root, backup), 'utf8'), '{damaged-fixture');
    require('./private-file-helper.cjs').assertPrivateFile(file);
    require('./private-file-helper.cjs').assertPrivateFile(path.join(root, backup));
});

test('expired cookies are rejected and the access configuration is excluded from file viewing', async t => {
    const f = await fixture(t); const response = await f.change({ enabled: true, token }); const cookie = cookieOf(response);
    const identity = f.service.authenticate({ headers: { cookie } });
    const data = JSON.parse(fs.readFileSync(f.filePath)); data.sessions[0].expiresAt = Date.now() - 1; fs.writeFileSync(f.filePath, JSON.stringify(data));
    assert.equal((await f.call('/api/private', 'GET', undefined, { Cookie: cookie })).status, 401);
    assert.equal(f.service.validIdentity(identity), false);
    const { restricted } = require('../public/pi-file-policy');
    assert.equal(restricted('pi5-access.json'), true);
    assert.equal(restricted('pi5-access.json.reset-fixture'), true);
});

test('access writes require JSON; explicit extra origins never authorize ambient cookies', async t => {
    const f = await fixture(t);
    assert.equal((await fetch(f.url + '/api/access/login', { method: 'POST', headers: { Origin: f.url, 'X-Pi-Access': '1', 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
    const r = await f.change({ enabled: true, token }); const cookie = cookieOf(r);
    const before = process.env.PI_ALLOWED_ORIGINS; process.env.PI_ALLOWED_ORIGINS = 'https://integration.invalid';
    try {
        assert.equal((await f.call('/api/private', 'GET', undefined, { Origin: 'https://integration.invalid', Cookie: cookie })).status, 403);
        const allowed = await f.call('/api/private', 'GET', undefined, { Origin: 'https://integration.invalid', Authorization: `Bearer ${token}` });
        assert.equal(allowed.status, 200); assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://integration.invalid');
    } finally { if (before === undefined) delete process.env.PI_ALLOWED_ORIGINS; else process.env.PI_ALLOWED_ORIGINS = before; }
});

test('login limits reject repeated failures without returning secret input', async t => {
    const f = await fixture(t); await f.change({ enabled: true, token });
    let limited = false;
    for (let i = 0; i < 20; i++) {
        const r = await f.call('/api/access/login', 'POST', { token: 'invalid-but-long-token-1234' }, { Origin: f.url, 'X-Pi-Access': '1' });
        assert.ok(!(await r.text()).includes('invalid-but-long')); if (r.status === 429) { limited = true; break; }
    }
    assert.ok(limited);
});
