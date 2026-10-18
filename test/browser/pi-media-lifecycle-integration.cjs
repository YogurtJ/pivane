const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..'), cwd = '/synthetic/media-lifecycle';
const model = { provider: 'fixture', id: 'fixture', input: ['text'] };
const plan = { id: 'plan-00000000-0000-0000-0000-000000000001', modelId: 'media-fixture', kind: 'image', summary: 'Synthetic media', parameters: { prompt: 'Synthetic' } };
const sessions = ['one', 'two'].map(id => ({ id, cwd, name: id }));
const messages = id => [{ role: 'user', timestamp: 1, content: [{ type: 'text', text: 'Question ' + id }] },
    { role: 'assistant', timestamp: 2, stopReason: 'stop', content: [{ type: 'text', text: 'Answer ' + id }] },
    ...(id === 'one' ? [{ role: 'toolResult', toolName: 'media_generate', toolCallId: 'media-call', timestamp: 3, details: { plan }, content: [{ type: 'text', text: 'Prepared' }] }] : [])];
(async () => {
    const app = express();
    for (const [name, directory] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use('/vendor/' + name, express.static(path.join(root, 'node_modules', directory)));
    app.use(express.static(path.join(root, 'public')));
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    let browser;
    try {
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
        for (const width of [1440, 393]) {
            const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: width < 900 }), errors = [], mutations = [];
            let socket, snapshots = 0, hold = false, release, held;
            const gate = new Promise(resolve => { release = resolve; });
            const requested = new Promise(resolve => { held = resolve; });
            page.on('pageerror', error => errors.push(error.message));
            await page.addInitScript(cwd => {
                localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'one');
                window.fixtureReadAborts = 0;
                const original = window.fetch;
                window.fetch = function(url, options) {
                    if (String(url).includes('/media/chat/requests?')) options?.signal?.addEventListener('abort', () => fixtureReadAborts++);
                    return original.apply(this, arguments);
                };
            }, cwd);
            await page.route('**/api/**', async route => {
                const endpoint = new URL(route.request().url()).pathname;
                if (route.request().method() !== 'GET') mutations.push(endpoint);
                let data = {};
                if (endpoint === '/api/pi/status') data = { ok: true, projectIdentity: true, projectRoots: ['/synthetic'] };
                else if (endpoint === '/api/pi/projects/resolve') data = { cwd };
                else if (endpoint === '/api/pi/projects') data = { projects: [{ cwd, name: 'Fixture' }] };
                else if (endpoint === '/api/pi/sessions') data = { sessions };
                else if (endpoint === '/api/pi/activity') data = { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] };
                else if (endpoint === '/api/pi/media/lab') data = { models: [{ id: 'media-fixture', name: 'Fixture', kind: 'image', executable: true, parameters: { prompt: { type: 'textarea', label: 'Prompt' } } }] };
                else if (endpoint === '/api/pi/media/chat/requests') {
                    if (hold) { held(); await gate; }
                    data = { requests: { [plan.id]: { attempts: [{ id: 'running', status: 'running', startedAt: '2026-01-01T00:00:00Z' }] } } };
                } else if (endpoint.includes('history') || endpoint === '/api/prompts') data = [];
                await route.fulfill({ json: data }).catch(error => { if (!page.isClosed() && !hold) throw error; });
            });
            await page.routeWebSocket('**/api/pi/ws', ws => {
                socket = ws; let selected = 'one';
                ws.onMessage(raw => {
                    const command = JSON.parse(raw), state = { model, isStreaming: false, thinkingLevel: 'off' }; let data = {};
                    if (command.type === 'open_session') {
                        selected = command.sessionId;
                        data = { session: sessions.find(s => s.id === selected), state, messages: { messages: messages(selected) }, models: { models: [model] }, stats: {}, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } };
                    } else if (command.type === 'get_state') data = state;
                    else if (command.type === 'get_messages') { data = { messages: messages(selected) }; snapshots++; }
                    ws.send(JSON.stringify({ type: 'response', command: command.type, id: command.id, success: true, data }));
                });
            });
            try {
                await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
                await page.locator('.pi-media-request[data-state=running]').waitFor();
                await page.evaluate(() => { window.fixtureCard = document.querySelector('.pi-media-request'); });
                socket.send(JSON.stringify({ type: 'agent_settled' }));
                for (let i = 0; i < 100 && !snapshots; i++) await page.waitForTimeout(10);
                assert.ok(snapshots, 'authority snapshot requested');
                await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                assert.equal(await page.evaluate(() => fixtureCard === document.querySelector('.pi-media-request')), true, 'unchanged same-thread snapshot preserves media card');
                hold = true;
                await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
                await requested;
                await page.locator('[data-session-id="two"] .pi-session-main').evaluate(node => node.click());
                await page.waitForFunction(() => document.querySelector('#pi-transcript-content')?.textContent.includes('Answer two'));
                assert.equal(await page.evaluate(() => fixtureReadAborts), 1, 'thread switch synchronously cancels its held status query');
                release(); await page.waitForTimeout(80);
                assert.equal(await page.locator('.pi-media-request').count(), 0, 'late first-thread response cannot add a card to the second thread');
                assert.deepEqual(mutations, []); assert.deepEqual(errors, []);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
                console.log(JSON.stringify({ width, snapshots, readAborts: 1, mutations: 0 }));
            } finally { release(); await page.close(); }
        }
    } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
