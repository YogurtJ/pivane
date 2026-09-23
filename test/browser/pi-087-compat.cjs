// Real Pivane gateway + Pi worker, isolated identity; no model requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-browser087-')));
Object.assign(process.env, { PI_CODING_AGENT_DIR: path.join(root, 'agent'), PI_PROJECT_ROOTS: root,
    PI_WEB_DEFERRED_FILE: path.join(root, 'deferred.json'), PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_WEB_TOKEN: '' });
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createPiAgentGateway } = require('../../server/pi-agent-routes');
const appRoot = path.resolve(__dirname, '../..');
(async () => {
    fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    fs.writeFileSync(path.join(root, 'agent/models.json'), JSON.stringify({ providers: { fixture: {
        api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'synthetic',
        models: [{ id: 'fixture', name: 'Fixture', input: ['text', 'image'], contextWindow: 32000, maxTokens: 1000 }]
    } } }));
    fs.writeFileSync(path.join(root, 'agent/settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture',
        defaultProjectTrust: 'never', compaction: { enabled: false }, enableInstallTelemetry: false }));
    const gateway = createPiAgentGateway();
    const session = await gateway.store.createSession(root, 'Pi 0.87 transcript');
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const sm = SessionManager.open(session.path);
    const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5V8AAAAASUVORK5CYII=' };
    const q = sm.appendMessage({ role: 'user', content: [{ type: 'text', text: 'ORIGINAL_QUESTION_087' }, image], timestamp: 1 });
    const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const answer = text => ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: 2, stopReason: 'stop',
        api: 'openai-completions', provider: 'fixture', model: 'fixture', usage });
    sm.appendMessage({ ...answer(''), content: [{ type: 'toolCall', id: 'read087', name: 'read', arguments: { path: 'fixture.txt' } }], stopReason: 'toolUse' });
    sm.appendMessage({ role: 'toolResult', toolCallId: 'read087', toolName: 'read', content: [{ type: 'text', text: 'TOOL_EVIDENCE_087' }], isError: false, timestamp: 3 });
    const a = sm.appendMessage(answer('ORIGINAL_ANSWER_087'));
    sm.appendContextEdit(q, { content: 'MODEL_ONLY_REPLACEMENT_087' });
    sm.appendContextEdit(a, null);
    const initialWorker = await gateway.supervisor.getWorker({ cwd: root, sessionPath: session.path, sessionId: session.id });
    await initialWorker.request('get_state'); // Native startup may append model/thinking metadata.
    const original = fs.readFileSync(session.path);
    const app = express(); app.use(express.json());
    app.get('/api/access/status', (_req, res) => res.json({ enabled: false, authenticated: true }));
    for (const endpoint of ['/api/history', '/api/video/history', '/api/tts/history', '/api/prompts']) app.get(endpoint, (_req, res) => res.json([]));
    gateway.mount(app);
    for (const [name, dir] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']])
        app.use('/vendor/' + name, express.static(path.join(appRoot, 'node_modules', dir)));
    app.use(express.static(path.join(appRoot, 'public')));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const wss = gateway.attachWebSocket(server);
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
    try {
        for (const width of [1440, 393, 320]) {
            const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'zh-CN', isMobile: width < 900, hasTouch: width < 900 });
            await context.addInitScript(({ root, id }) => { localStorage.setItem('pi.web.cwd', root); localStorage.setItem('pi.web.session:' + root, id); }, { root, id: session.id });
            const page = await context.newPage(), errors = [];
            page.on('pageerror', e => errors.push(e.message));
            await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'domcontentloaded' });
            for (let attempt = 0; attempt < 2; attempt++) {
                await page.locator('#pi-transcript').getByText('ORIGINAL_ANSWER_087', { exact: true }).waitFor();
                const text = await page.locator('#pi-transcript').innerText();
                assert.match(text, /ORIGINAL_QUESTION_087/); assert.doesNotMatch(text, /MODEL_ONLY_REPLACEMENT_087/);
                assert.ok(await page.locator('#pi-transcript img').count());
                assert.ok(await page.locator('[data-tool-id="read087"]').count());
                if (!attempt) await page.reload({ waitUntil: 'domcontentloaded' });
            }
            await page.locator('#pi-input').fill('UNSENT_COMPAT_DRAFT');
            if (width < 900) {
                await page.locator('#pi-toggle-sessions').click();
                assert.equal(await page.locator('#pi-session-pane').evaluate(node => node.classList.contains('open')), true);
                await page.locator('#pi-toggle-sessions').click();
                await page.waitForFunction(() => document.querySelector('#pi-session-pane').getBoundingClientRect().right <= 0);
            }
            assert.equal(await page.locator('#pi-input').inputValue(), 'UNSENT_COMPAT_DRAFT');
            const overflow = await page.evaluate(() => ['body', '#pi-transcript'].filter(selector => { const node = document.querySelector(selector); return node.scrollWidth > node.clientWidth + 1; }));
            assert.deepEqual(overflow, []); assert.deepEqual(errors, []);
            await page.screenshot({ path: path.join(process.env.PI_BROWSER_ARTIFACT_DIR || os.tmpdir(), `pi-087-transcript-${width}.png`) });
            console.log(JSON.stringify({ width, errors, overflow, originalTranscript: true, imageAndTool: true, refreshed: true }));
            await context.close();
        }
        const worker = gateway.supervisor.getActiveWorker(session.path);
        const context = await worker.captureContext();
        assert.ok(context.messages.some(m => m.content === 'MODEL_ONLY_REPLACEMENT_087'));
        assert.equal(gateway.supervisor.workers.size, 1);
        assert.deepEqual(fs.readFileSync(session.path), original);
    } finally {
        await browser.close(); for (const ws of wss.clients) ws.terminate(); await gateway.dispose();
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true });
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
