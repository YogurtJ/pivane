// Real index/gateway/native worker and a loopback-only synthetic streaming model.
// The pressure seam replaces bufferedAmount, not the RPC, snapshot or reconnect paths.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const artifacts = process.env.PI_BROWSER_ARTIFACT_DIR || os.tmpdir();
const keep = new Set(['PIVANE_TEST_HERMES_BUNDLE', 'PIVANE_TEST_PI_JITI']);
for (const key of Object.keys(process.env)) {
    if (/^(?:PI_|PIVANE_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|OPENROUTER_|AZURE_OPENAI_|AWS_|BEDROCK_|MISTRAL_|GROQ_|XAI_|DEEPSEEK_)/.test(key) && !keep.has(key)) delete process.env[key];
}
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-perf-browser-')));
const agent = path.join(root, 'agent'), cwd = path.join(root, 'project');
for (const directory of [agent, cwd]) fs.mkdirSync(directory, { mode: 0o700 });
Object.assign(process.env, { PI_CODING_AGENT_DIR: agent, PI_PROJECT_ROOTS: root, PI_OFFLINE: '1', PI_TELEMETRY: '0',
    PI_WEB_TOKEN: '', PI_WEB_DEFERRED_FILE: path.join(root, 'deferred.json') });
const express = require('express');
const { createPiAgentGateway } = require('../../server/pi-agent-routes');
const { MAX_BUFFERED_BYTES } = require('../../server/pi-websocket-send');
const appRoot = path.resolve(__dirname, '../..');
const prefix = '# Stable integration heading\n\n```js\nconst stable = 42;\n```\n\nA formula: $x^2+y^2$.\n\nTail';
const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==' };
const assistant = content => ({ role: 'assistant', content, timestamp: 2, stopReason: 'stop',
    api: 'openai-completions', provider: 'fixture', model: 'fixture', usage });

(async () => {
    let provider, gateway, server, wss, browser, completion;
    const calls = [], providerErrors = [], report = [];
    function chunk(content, finish = false) {
        assert.ok(completion && !completion.destroyed, 'the native provider request must remain alive');
        completion.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture',
            choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: finish ? 'stop' : null }],
            ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 40, total_tokens: 50 } } : {}) }) + '\n\n');
        if (finish) completion.end('data: [DONE]\n\n');
    }
    try {
        provider = http.createServer(async (req, res) => {
            try {
                assert.equal(req.url, '/v1/chat/completions');
                assert.equal(req.headers.authorization, 'Bearer synthetic');
                let body = ''; for await (const data of req) body += data;
                const request = JSON.parse(body); assert.equal(request.model, 'fixture'); assert.equal(request.stream, true);
                calls.push(request); completion = res;
                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
                chunk(prefix);
            } catch (error) { providerErrors.push(error.message); res.destroy(error); }
        });
        provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
        fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: {
            api: 'openai-completions', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'synthetic',
            models: [{ id: 'fixture', name: 'Synthetic integration model', input: ['text', 'image'], contextWindow: 32000, maxTokens: 1000,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]
        } } }), { mode: 0o600 });
        fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture',
            defaultProjectTrust: 'never', enableInstallTelemetry: false, compaction: { enabled: false } }), { mode: 0o600 });
        gateway = createPiAgentGateway();
        const app = express(); app.use(express.json());
        // Auxiliary media APIs are outside this gateway; these read-only fixtures
        // avoid loading any real media configuration or history.
        app.get('/api/access/status', (_req, res) => res.json({ enabled: false, authenticated: true }));
        for (const endpoint of ['/api/history', '/api/video/history', '/api/tts/history', '/api/prompts']) app.get(endpoint, (_req, res) => res.json([]));
        gateway.mount(app);
        for (const [name, directory] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']])
            app.use('/vendor/' + name, express.static(path.join(appRoot, 'node_modules', directory)));
        app.use(express.static(path.join(appRoot, 'public')));
        server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
        const base = `http://127.0.0.1:${server.address().port}`;
        process.env.PI_WORKSPACE_BASE_URL = base;
        wss = gateway.attachWebSocket(server);
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
        for (const width of [1440, 393]) {
            const session = await gateway.store.createSession(cwd, `Integration ${width}`, { agentProfileId: null,
                initializeSession(manager) {
                    manager.appendCustomEntry('synthetic-large-record', { text: 'x'.repeat(2 * 1024 * 1024) });
                    manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'SEEDED_QUESTION' }, image], timestamp: 1 });
                    manager.appendMessage({ ...assistant([{ type: 'toolCall', id: 'fixture-read', name: 'read', arguments: { path: 'fixture.txt' } }]), stopReason: 'toolUse' });
                    manager.appendMessage({ role: 'toolResult', toolCallId: 'fixture-read', toolName: 'read', content: [{ type: 'text', text: 'SYNTHETIC_TOOL_RESULT' }], isError: false, timestamp: 3 });
                    manager.appendMessage(assistant([{ type: 'text', text: 'SEEDED_ANSWER' }]));
                } });
            const context = await browser.newContext({ locale: 'zh-CN', viewport: { width, height: 950 }, isMobile: width < 900, hasTouch: width < 900 });
            await context.addInitScript(({ cwd, id }) => {
                if (!/^https?:$/.test(location.protocol)) return;
                localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, id);
                window.__domReadyCount = 0; document.addEventListener('DOMContentLoaded', () => window.__domReadyCount++);
            }, { cwd, id: session.id });
            const page = await context.newPage(), errors = [], snapshots = [], cronAssets = [];
            page.on('request', request => { const name = new URL(request.url()).pathname; if (/\/pi-cron\.(js|css)$/.test(name)) cronAssets.push(name); });
            page.on('pageerror', error => errors.push(error.message));
            page.on('websocket', socket => socket.on('framereceived', frame => {
                const value = JSON.parse(frame.payload.toString());
                if (value.command === 'open_session' && value.success) snapshots.push(value.data.session.id);
            }));
            await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
            await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
            await page.locator('#pi-transcript').getByText('SEEDED_ANSWER', { exact: true }).waitFor();
            await page.waitForFunction(() => !document.querySelector('#pi-input').disabled);
            assert.deepEqual(cronAssets, [], 'chat starts before the cron assets are requested');
            const priorCalls = calls.length;
            await page.locator('#pi-input').fill('Reply using the synthetic streaming fixture.');
            await page.locator('#pi-send-button').click();
            await page.locator('.streaming .pi-code-copy').waitFor();
            const worker = gateway.supervisor.getActiveWorker(session.path);
            assert.ok(worker, 'real native worker is managed by the gateway');
            await page.evaluate(() => { window.__stableNodes = [...document.querySelectorAll('.streaming h1, .streaming pre, .streaming .katex')]; });
            await page.locator('#pi-input').fill('UNSENT_INTEGRATION_DRAFT');
            chunk(' grows');
            await page.waitForFunction(() => document.querySelector('.streaming .pi-markdown')?.textContent.includes('Tail grows'));
            assert.equal(await page.evaluate(() => __stableNodes.length >= 3 && __stableNodes.every(node => node.isConnected)), true);
            await page.evaluate(() => PiWorkspaceRoute.navigate('cron'));
            await page.locator('#cron-tab .cron-search').waitFor({ state: 'visible' });
            await page.locator('#cron-tab .cron-empty-small').waitFor({ state: 'visible' });
            assert.equal(await page.locator('#cron-tab .cron-notice.error').count(), 0);
            assert.deepEqual([...cronAssets].sort(), ['/pi-cron.css', '/pi-cron.js']);
            assert.equal(await page.locator('#cron-tab .cron-header').count(), 1);
            assert.equal(await page.locator('#cron-tab').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
            await page.evaluate(() => PiWorkspaceRoute.navigate('chat'));
            await page.locator('#pi-input').waitFor({ state: 'visible' });
            assert.equal(await page.locator('#pi-input').inputValue(), 'UNSENT_INTEGRATION_DRAFT');
            const beforeSnapshots = snapshots.length;
            assert.equal(wss.clients.size, 1);
            const slow = [...wss.clients][0], closed = once(slow, 'close');
            Object.defineProperty(slow, 'bufferedAmount', { configurable: true, get: () => MAX_BUFFERED_BYTES + 1 });
            chunk(' RECONNECT_DELTA');
            const [code] = await closed; assert.equal(code, 1013);
            await page.waitForFunction(() => document.querySelector('.streaming .pi-markdown')?.textContent.includes('RECONNECT_DELTA'));
            assert.ok(snapshots.length > beforeSnapshots, 'recovery came through another real open_session snapshot');
            assert.equal(gateway.supervisor.getActiveWorker(session.path), worker);
            assert.equal(calls.length, priorCalls + 1, 'reconnect must not replay the prompt');
            chunk('\n\nFINAL_INTEGRATION_MARKER', true);
            await page.waitForFunction(() => !document.querySelector('.streaming') && document.querySelector('#pi-transcript-content').textContent.includes('FINAL_INTEGRATION_MARKER'));
            assert.equal(await page.locator('#pi-input').inputValue(), 'UNSENT_INTEGRATION_DRAFT');
            assert.equal((await page.locator('#pi-transcript-content').textContent()).split('FINAL_INTEGRATION_MARKER').length - 1, 1);
            assert.ok(await page.locator('#pi-transcript img').count());
            assert.equal(await page.locator('[data-tool-id="fixture-read"]').count(), 1);
            if (width < 900) {
                await page.locator('#pi-toggle-sessions').click();
                assert.equal(await page.locator('#pi-session-pane').evaluate(node => node.classList.contains('open')), true);
                await page.locator('#pi-toggle-sessions').click();
                await page.waitForFunction(() => document.querySelector('#pi-session-pane').getBoundingClientRect().right <= 0);
                assert.ok(await page.locator('#pi-input').evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 16));
            }
            const overflow = await page.evaluate(() => ['body', '#pi-transcript'].filter(selector => { const node = document.querySelector(selector); return node.scrollWidth > node.clientWidth + 1; }));
            assert.deepEqual(overflow, []); assert.deepEqual(errors, []); assert.deepEqual(providerErrors, []);
            assert.equal(await page.evaluate(() => window.__domReadyCount), 1, 'lazy initialization never replays DOMContentLoaded');
            assert.equal(calls.length, priorCalls + 1);
            await page.screenshot({ path: path.join(artifacts, `pi-performance-integration-${width}.png`) });
            report.push({ width, realWorker: true, nativeLargeRecord: true, stableStreamNodes: true,
                cronRoundTrip: true, snapshots: snapshots.length, noPromptReplay: true, finalCorrection: true, errors, overflow });
            console.log(JSON.stringify(report.at(-1)));
            await context.close();
        }
        fs.writeFileSync(path.join(artifacts, 'pi-performance-integration.json'), JSON.stringify(report, null, 2));
    } finally {
        completion?.destroy(); await browser?.close();
        if (wss) for (const socket of wss.clients) socket.terminate();
        await gateway?.dispose();
        if (wss) await new Promise(resolve => wss.close(resolve));
        for (const listener of [server, provider]) if (listener) { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); }
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
