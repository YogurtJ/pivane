const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { WebSocket } = require('ws');

const project = path.resolve(__dirname, '..');
const token = 'integration-only-access-token-123456';
const delay = ms => new Promise(r => setTimeout(r, ms));

test('full service protects legacy routes and static media; cookie WS revocation retains persistent workers', { timeout: 90000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-access-http-'));
    const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
    const dataDir = path.join(root, 'media'); fs.mkdirSync(path.join(dataDir, 'public/audio'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'public/audio/fixture.wav'), Buffer.from('RIFF0000WAVEfixture-test-audio'));
    const reserve = net.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening'); const port = reserve.address().port; await new Promise(r => reserve.close(r));
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['server.js'], { cwd: project, env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', PI_MEDIA_PROFILE: 'clean', PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_CODING_AGENT_DIR: path.join(root, 'agent'), PI_MEDIA_DATA_DIR: dataDir, PI_PROJECT_ROOTS: cwd, PI_WEB_DEFERRED_FILE: path.join(root, 'deferred.json'), PI_WORKSPACE_BASE_URL: base }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
    let socket;
    t.after(async () => { socket?.terminate(); child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), delay(5000)]); if (child.exitCode === null) child.kill('SIGKILL'); fs.rmSync(root, { recursive: true, force: true }); });
    let ready = false;
    for (let i = 0; i < 300; i++) { try { if ((await fetch(base + '/api/pi/status')).ok) { ready = true; break; } } catch {} await delay(30); }
    assert.ok(ready, 'isolated service must start');
    const call = (route, method = 'GET', body, cookie = '', extra = {}) => fetch(base + route, { method, headers: { Origin: base, 'X-Pi-Access': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    const initial = await call('/api/access/settings'); assert.equal(initial.status, 200, 'access settings must be mounted in the real service');
    const settings = await initial.json();
    const enabled = await call('/api/access/settings', 'PUT', { enabled: true, token, confirmed: true, expectedRevision: settings.revision }); assert.equal(enabled.status, 200);
    const cookie = enabled.headers.get('set-cookie').split(';')[0];
    for (const [method, route, body] of [
        ['GET','/api/history'],['DELETE','/api/history/fixture'],['GET','/api/prompts'],['POST','/api/prompts',{}],
        ['POST','/api/tts',{}],['DELETE','/api/tts/history/fixture'],['POST','/api/runpod/generate',{}],['POST','/api/video/generate',{}],
        ['GET','/api/pi/status'],['GET','/api/media-agent/capabilities/image'],['GET','/audio/fixture.wav'],['GET','/%61udio/fixture.wav'],
        ['GET','/downloads/native-settings-status.json'],['GET','/legacy-workspace/index.html']
    ]) assert.equal((await call(route, method, body)).status, 401, route);
    for (const route of ['/', '/pi-mermaid-frame.html', '/workspace-access.js', '/workspace-access.css', '/pi-chat.js', '/vendor/dompurify/purify.min.js', '/brand/logo-64.png']) assert.equal((await call(route)).status, 200, route);
    assert.equal((await call('/api/pi/status?token=' + token)).status, 401, 'URL token must not authorize');
    assert.equal((await call('/api/pi/status', 'GET', undefined, '', { Authorization: `Bearer ${token}` })).status, 200);
    const media = await call('/audio/fixture.wav', 'GET', undefined, cookie, { Range: 'bytes=0-3' });
    assert.equal(media.status, 206); assert.equal(await media.text(), 'RIFF'); assert.match(media.headers.get('cache-control'), /no-store/);
    assert.equal((await call('/api/pi/media/lab', 'GET', undefined, cookie)).status, 200);
    assert.equal((await call('/api/media-agent/capabilities/image', 'GET', undefined, cookie)).status, 200);
    const created = await call('/api/pi/sessions', 'POST', { cwd, name: 'Access fixture' }, cookie); assert.equal(created.status, 201); const session = await created.json();
    socket = new WebSocket(base.replace('http:', 'ws:') + '/api/pi/ws', { headers: { Origin: base, Cookie: cookie } }); await once(socket, 'open');
    const opened = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('WS snapshot timed out')), 25000); socket.on('message', raw => { const event = JSON.parse(raw); if (event.id === 'open') { clearTimeout(timer); resolve(event); } }); });
    socket.send(JSON.stringify({ type: 'open_session', id: 'open', cwd, sessionId: session.id })); assert.equal((await opened).success, true, 'cookie authenticates native RPC without a token in browser JS');
    const closed = once(socket, 'close');
    const revoked = await call('/api/access/revoke', 'POST', {}, cookie); assert.equal(revoked.status, 200);
    assert.equal((await Promise.race([closed, delay(3000).then(() => [0])]))[0], 4401);
    assert.equal((await call('/api/pi/status', 'GET', undefined, cookie)).status, 401);
    const activity = await (await call('/api/pi/activity', 'GET', undefined, '', { Authorization: `Bearer ${token}` })).json();
    assert.ok(activity.runtimes.some(r => r.sessionId === session.id), 'revoking a browser must not stop persistent work');
    assert.ok(!output.includes(token), 'logs must not contain access tokens');
});
