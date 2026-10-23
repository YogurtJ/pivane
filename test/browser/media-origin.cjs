const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { selectMessageView } = require('./pi-mobile-view-helper.cjs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..'), cwd = '/synthetic/media-lifecycle';
const model = { provider: 'fixture', id: 'fixture', input: ['text'] };
const plan = { id: 'plan-00000000-0000-0000-0000-000000000001', modelId: 'media-fixture', kind: 'image', summary: 'Synthetic media', parameters: { prompt: 'Synthetic' } };
const sessions = ['one', 'two'].map(id => ({ id, cwd, name: id }));
const nativeOrigin = { type: 'custom', customType: 'pivane-media-plan', id: 'native-origin', timestamp: '2026-01-01T00:00:00Z', data: { version: 1, toolCallId: 'media-call', plan } };
let originSaved = false, legacyResult = false;
const messages = id => [{ role: 'user', timestamp: 1, content: [{ type: 'text', text: 'Question ' + id }] },
    { role: 'assistant', timestamp: 2, stopReason: 'stop', content: [{ type: 'text', text: 'Answer ' + id }] },
    ...(id === 'one' && originSaved ? [{ role: 'custom', customType: 'pivane-media-plan', display: false, timestamp: 3, content: [], details: nativeOrigin.data },
        { role: 'toolResult', toolName: 'media_generate', toolCallId: 'media-call', isError: !legacyResult, timestamp: 4, details: legacyResult ? { plan: { ...plan, summary: 'Stale legacy summary' } } : undefined, content: [{ type: 'text', text: legacyResult ? 'Prepared' : 'Synthetic wait cancelled' }] }] : [])];
async function checkBoundedOriginReads(browser, width) {
    const page = await browser.newPage({ viewport: { width, height: 900 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        await page.goto('about:blank');
        await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/pi-media-requests.js'), 'utf8') });
        await page.evaluate(origin => {
            window.reads = 0; window.posts = 0; window.trackingTimers = new Map();
            window.statusAttempts = []; window.activeReads = 0; window.maxReads = 0;
            const interval = window.setInterval, clear = window.clearInterval;
            let nextTimer = 0;
            window.setInterval = (callback, delay, ...args) => {
                if (delay !== 2500) return interval(callback, delay, ...args);
                const id = `tracking-${++nextTimer}`; trackingTimers.set(id, callback); return id;
            };
            window.clearInterval = id => { if (trackingTimers.has(id)) trackingTimers.delete(id); else clear(id); };
            window.manager = PiMediaRequests.create({ fetch: async (url, options) => {
                if (options?.method === 'POST') { posts++; throw new Error('Unexpected generation POST'); }
                if (url.endsWith('/lab')) return { models: [] };
                reads++; activeReads++; maxReads = Math.max(maxReads, activeReads);
                const attempts = structuredClone(statusAttempts);
                if (window.holdStatusRead) {
                    window.holdStatusRead = false;
                    await new Promise(resolve => { window.releaseStatusRead = resolve; });
                }
                activeReads--; return { requests: { [origin.data.plan.id]: { attempts } } };
            } });
            window.originMessage = manager.sourceMessage(origin);
            document.body.append(manager.render(originMessage, { live: true }));
        }, nativeOrigin);
        await page.waitForFunction(() => reads === 1);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.evaluate(() => trackingTimers.size), 1, 'a newly appended origin follows a temporarily empty journal');
        for (let tick = 0; tick < 12 && await page.evaluate(() => trackingTimers.size > 0); tick++) {
            const before = await page.evaluate(() => reads);
            await page.evaluate(() => [...trackingTimers.values()][0]());
            await page.waitForFunction(previous => reads > previous, before);
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        }
        const bounded = await page.evaluate(() => ({ reads, timers: trackingTimers.size, posts, cards: document.querySelectorAll('.pi-media-request').length }));
        assert.ok(bounded.reads > 1 && bounded.reads <= 12, JSON.stringify(bounded));
        assert.equal(bounded.timers, 0, 'unconfirmed cards must stop background status checks after the live-origin budget');
        assert.equal(bounded.posts, 0); assert.equal(bounded.cards, 1);
        await page.evaluate(() => {
            manager.render(originMessage, { live: true }); // Duplicate events must not restart the exhausted budget.
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await page.waitForTimeout(100);
        assert.equal(await page.evaluate(() => reads), bounded.reads);
        assert.equal(await page.evaluate(() => trackingTimers.size), 0);
        await page.evaluate(() => { window.holdStatusRead = true; manager.refresh([originMessage]); });
        await page.waitForFunction(() => typeof releaseStatusRead === 'function');
        const beforeQueuedAuthority = await page.evaluate(() => reads);
        await page.evaluate(() => {
            window.statusAttempts = [{ id: 'authoritative-attempt', status: 'done' }];
            manager.refresh([originMessage]);
        });
        await page.waitForTimeout(100);
        assert.equal(await page.evaluate(() => reads), beforeQueuedAuthority, 'authoritative refresh waits for the existing status read instead of overlapping it');
        await page.evaluate(() => releaseStatusRead());
        await page.locator('.pi-media-request[data-state=done]').waitFor();
        assert.equal(await page.evaluate(() => reads), beforeQueuedAuthority + 1, 'an authoritative refresh queued during an empty read fetches the latest journal after it settles');
        assert.equal(await page.evaluate(() => maxReads), 1);
        assert.equal(await page.locator('.pi-media-request').count(), 1);
        assert.equal(await page.evaluate(() => posts), 0);
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ width, boundedOriginReads: bounded, queuedAuthorityRead: true, maxReads: 1, pageerror: errors }));
    } finally { await page.close(); }
}
(async () => {
    const app = express();
    for (const [name, directory] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use('/vendor/' + name, express.static(path.join(root, 'node_modules', directory)));
    app.use(express.static(path.join(root, 'public')));
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    let browser;
    try {
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
        for (const width of [1440, 393]) {
            originSaved = false; legacyResult = false;
            const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: width < 900 }), errors = [], mutations = [];
            let socket, snapshots = 0, hold = false, release, held, statusReads = 0, attempts = [];
            const runningAttempt = { id: 'origin-attempt', status: 'running', startedAt: '2026-01-01T00:00:00Z' };
            const doneAttempt = { ...runningAttempt, status: 'done', kind: 'image', asset: { kind: 'image', url: '/images/synthetic.png' } };
            const gate = new Promise(resolve => { release = resolve; });
            const requested = new Promise(resolve => { held = resolve; });
            page.on('pageerror', error => errors.push(error.message));
            await page.addInitScript(cwd => {
                localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'one');
                window.fixtureReadAborts = 0; window.fixtureStatusReplies = 0;
                const original = window.fetch;
                window.fetch = function(url, options) {
                    if (String(url).includes('/media/chat/requests?')) options?.signal?.addEventListener('abort', () => fixtureReadAborts++);
                    return original.apply(this, arguments).then(response => {
                        if (String(url).includes('/media/chat/requests?')) fixtureStatusReplies++;
                        return response;
                    });
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
                    statusReads++;
                    const snapshot = structuredClone(attempts);
                    if (hold) { held(); await gate; }
                    data = { requests: { [plan.id]: { attempts: snapshot } } };
                } else if (endpoint.includes('history') || endpoint === '/api/prompts') data = [];
                await route.fulfill({ json: data }).catch(error => { if (!page.isClosed() && !hold) throw error; });
            });
            await page.route('**/images/synthetic.png', route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64') }));
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
                await page.waitForFunction(() => document.querySelector('#pi-transcript-content')?.textContent.includes('Answer one'));
                assert.equal(await page.locator('.pi-media-request').count(), 0);
                originSaved = true;
                socket.send(JSON.stringify({ type: 'entry_appended', entry: nativeOrigin }));
                await page.waitForFunction(() => fixtureStatusReplies === 1);
                await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                assert.equal(await page.locator('.pi-media-request').getAttribute('data-state'), 'pending', 'native append precedes execution and may legitimately read an empty journal');
                attempts = [runningAttempt];
                await page.locator('.pi-media-request[data-state=running]').waitFor();
                assert.ok(statusReads >= 2, 'live origin follows the initial empty read with a read-only status check');
                assert.equal(await page.locator('.pi-media-request').count(), 1, 'live durable origin renders before a successful tool result exists');
                attempts = [doneAttempt];
                await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
                await page.locator('.pi-media-request[data-state=done] img').waitFor();
                assert.equal(await page.locator('.pi-media-request').count(), 1, 'empty to running to done preserves one card');
                socket.send(JSON.stringify({ type: 'entry_appended', entry: nativeOrigin }));
                assert.equal(await page.locator('.pi-media-request').count(), 1, 'duplicate live origin does not duplicate a card');
                socket.send(JSON.stringify({ type: 'agent_settled' }));
                for (let i = 0; i < 100 && !snapshots; i++) await page.waitForTimeout(10);
                assert.ok(snapshots, 'authority snapshot requested');
                await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                assert.equal(await page.locator('.pi-media-request').count(), 1, 'snapshot recovers origin despite cancelled tool result');
                await selectMessageView(page, 'full');
                assert.equal(await page.locator('.pi-media-request:visible').count(), 1);
                await page.locator('.pi-tool-row[data-state=error] > summary').click();
                assert.ok((await page.locator('#pi-transcript-content').textContent()).includes('Synthetic wait cancelled'));
                for (const mode of ['reading', 'compact']) {
                    await selectMessageView(page, mode);
                    assert.equal(await page.locator('.pi-media-request:visible').count(), 1, 'origin stays visible in every transcript mode');
                }
                legacyResult = true; attempts = [];
                await page.reload({ waitUntil: 'networkidle' });
                await page.waitForFunction(() => fixtureStatusReplies === 1);
                await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                assert.equal(await page.locator('.pi-media-request').getAttribute('data-state'), 'pending');
                await page.evaluate(() => { window.fixtureCard = document.querySelector('.pi-media-request'); });
                const readsBeforeAuthority = statusReads;
                attempts = [doneAttempt];
                socket.send(JSON.stringify({ type: 'agent_settled' }));
                await page.locator('.pi-media-request[data-state=done] img').waitFor();
                assert.ok(statusReads > readsBeforeAuthority, 'same-page authoritative reload must refetch an unchanged card with cached empty attempts');
                assert.equal(await page.evaluate(() => fixtureCard === document.querySelector('.pi-media-request')), true, 'authoritative refetch keeps the original card node when transcript messages are unchanged');
                assert.equal(await page.locator('.pi-media-request').count(), 1, 'native and legacy source deduplicate after refresh');
                assert.equal(await page.locator('.pi-media-request-title strong').textContent(), plan.summary, 'native origin wins over a stale legacy duplicate');
                assert.equal(await page.locator('.pi-draft-image, .pi-attachment').count(), 0);
                assert.equal(await page.evaluate(() => [...document.querySelectorAll('.pi-media-request, .pi-media-request-actions button')].every(node => node.getBoundingClientRect().right <= innerWidth)), true);
                attempts = [runningAttempt];
                socket.send(JSON.stringify({ type: 'agent_settled' }));
                await page.locator('.pi-media-request[data-state=running]').waitFor();
                hold = true;
                await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
                await requested;
                await page.locator('#pi-input').fill('Keep origin draft');
                if (width < 900) {
                    await page.locator('#pi-toggle-sessions').click();
                    await page.locator('#pi-session-pane.open').waitFor();
                    assert.equal(await page.locator('#pi-session-pane').evaluate(node => node.getBoundingClientRect().width <= innerWidth), true);
                }
                await page.locator('[data-session-id="two"] .pi-session-main').click();
                await page.waitForFunction(() => document.querySelector('#pi-transcript-content')?.textContent.includes('Answer two'));
                assert.equal(await page.evaluate(() => fixtureReadAborts), 1, 'thread switch synchronously cancels its held status query');
                release(); await page.waitForTimeout(80);
                assert.equal(await page.locator('.pi-media-request').count(), 0, 'late first-thread response cannot add a card to the second thread');
                assert.deepEqual(mutations, []); assert.deepEqual(errors, []);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
                console.log(JSON.stringify({ width, emptyToRunningToDone: true, authorityRefetched: true, statusReads, liveOrigin: true, duplicateCardCount: 1, refreshed: true, branchSwitch: true, pageerror: errors, readAborts: 1, mutations: 0 }));
            } finally { release(); await page.close(); }
            await checkBoundedOriginReads(browser, width);
        }
    } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
