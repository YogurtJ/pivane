// Synthetic held global discovery: validate saved project before opening; do not wait for unrelated lists.
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const saved = '/fixture/saved', other = '/fixture/other';
const row = (cwd, id) => ({ cwd, id, name: id, firstMessage: 'Synthetic', created: '2026-01-01T00:00:00Z', modified: '2026-01-01T00:00:00Z' });
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text'] };
const waitFor = async predicate => {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > 5000) throw new Error('Timed out waiting for fixture request');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
};

async function run(browser, base, width, scenario) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage();
    const errors = [], requests = [], rpc = [];
    let releaseGlobal, releaseOther, releaseResolve, releaseSaved, releaseActivity;
    const activityGate = new Promise(resolve => { releaseActivity = resolve; });
    const globalGate = new Promise(resolve => { releaseGlobal = resolve; });
    const savedGate = new Promise(resolve => { releaseSaved = resolve; });
    const otherGate = new Promise(resolve => { releaseOther = resolve; });
    const resolveGate = new Promise(resolve => { releaseResolve = resolve; });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(cwd => {
        localStorage.setItem('pi.web.cwd', cwd);
        localStorage.setItem(`pi.web.session:${cwd}`, 'saved-thread');
        localStorage.setItem('pi.web.expandedProjects', JSON.stringify([cwd, '/fixture/other']));
    }, saved);
    await page.route('**/api/**', async route => {
        const url = new URL(route.request().url()), endpoint = url.pathname;
        requests.push(`${route.request().method()} ${endpoint}${url.search}`);
        if (endpoint === '/api/pi/status') return route.fulfill({ json: { ok: true, projectIdentity: true, projectRoots: ['/fixture'], defaultProject: saved } });
        if (endpoint === '/api/pi/projects/resolve') {
            if (scenario === 'switch' && url.searchParams.get('cwd') === saved) await resolveGate;
            if (scenario === 'failed-resolve' && url.searchParams.get('cwd') === saved)
                return route.fulfill({ status: 400, json: { error: 'Invalid synthetic cwd' } });
            return route.fulfill({ json: { cwd: url.searchParams.get('cwd') } });
        }
        if (endpoint === '/api/pi/activity') {
            if (scenario === 'visibility-race') await activityGate;
            return route.fulfill({ json: { runtimes: [], pinnedProjects: [], hiddenProjects: scenario === 'hidden' ? [saved] : [], replyNotices: [] } });
        }
        if (endpoint === '/api/pi/projects') {
            await globalGate;
            return route.fulfill({ json: { projects: scenario === 'failed-resolve' ? [{ cwd: other, name: 'Other' }] : [{ cwd: saved, name: 'Saved' }, { cwd: other, name: 'Other' }], roots: ['/fixture'], hiddenProjects: ['hidden', 'visibility-race'].includes(scenario) ? [saved] : [], pinnedProjects: [],
                projectAliases: scenario === 'failed-resolve' ? [{ input: saved, cwd: null }] : [] } });
        }
        if (endpoint === '/api/pi/sessions') {
            const cwd = url.searchParams.get('cwd');
            if (cwd === saved && (scenario === 'ready' || scenario === 'stale-list')) await savedGate;
            if (cwd === other && !['switch', 'stale-list'].includes(scenario)) await otherGate;
            return route.fulfill({ json: { sessions: [row(cwd, cwd === saved ? 'saved-thread' : 'other-thread')] } });
        }
        if (route.request().method() !== 'GET') throw new Error(`Unexpected mutation: ${endpoint}`);
        return route.fulfill({ json: endpoint.startsWith('/api/pi/') ? {} : [] });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        ws.onMessage(raw => {
            const command = JSON.parse(raw);
            rpc.push(command);
            const session = row(command.cwd, command.sessionId);
            ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true,
                data: command.type === 'open_session' ? { session, state: { model, isStreaming: false, thinkingLevel: 'off' },
                    messages: { messages: [] }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } } : {} }));
        });
    });
    try {
        const start = Date.now();
        await page.goto(base, { waitUntil: 'domcontentloaded' });
        if (scenario === 'visibility-race') {
            await waitFor(() => requests.some(request => request.includes('/api/pi/activity')));
            releaseGlobal();
            await page.locator('.pi-project-group[data-project-cwd="/fixture/other"]').waitFor();
            releaseActivity(); releaseOther();
            await page.waitForFunction(cwd => document.querySelector('#pi-project-path')?.textContent === cwd, other);
            assert.equal(requests.some(request => request.startsWith('PATCH ')), false, 'older activity cannot unhide a globally hidden project');
            assert.equal(rpc.some(command => command.sessionId === 'saved-thread'), false);
        } else if (scenario === 'switch') {
            await waitFor(() => requests.some(request => request.includes(`/projects/resolve?cwd=${encodeURIComponent(saved)}`)));
            // An explicit user navigation overtakes the saved-cwd validation response.
            await page.locator('#pi-project-form').evaluate((node, cwd) => {
                node.querySelector('input').value = cwd;
                node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            }, other);
            await waitFor(() => requests.some(request => request.includes(`/projects/resolve?cwd=${encodeURIComponent(other)}`)));
            await page.waitForFunction(cwd => document.querySelector('#pi-project-path')?.textContent === cwd, other);
            releaseResolve();
            releaseGlobal();
            await page.waitForTimeout(100);
            assert.equal(await page.locator('#pi-project-path').textContent(), other, 'older bootstrap validation cannot navigate after manual switch');
            assert.equal(rpc.some(command => command.sessionId === 'saved-thread'), false);
        } else if (scenario === 'stale-list') {
            await waitFor(() => requests.some(request => request.includes(`/api/pi/sessions?cwd=${encodeURIComponent(saved)}`)));
            await page.locator('#pi-project-form').evaluate((node, cwd) => {
                node.querySelector('input').value = cwd;
                node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            }, other);
            await page.waitForFunction(cwd => document.querySelector('#pi-project-path')?.textContent === cwd, other);
            releaseSaved();
            releaseGlobal();
            await page.waitForTimeout(100);
            assert.equal(await page.locator('#pi-project-path').textContent(), other);
            assert.equal(await page.locator('.pi-session-item.active[data-session-id="saved-thread"]').count(), 0, 'late list cannot replace selected thread');
            assert.equal(rpc.some(command => command.sessionId === 'saved-thread'), false, 'late list cannot open old saved thread');
        } else if (scenario === 'hidden' || scenario === 'failed-resolve') {
            await waitFor(() => requests.some(request => request.includes('/projects/resolve')));
            await page.waitForTimeout(100);
            assert.equal(requests.filter(request => request.includes('/api/pi/sessions?cwd=')).length, 0, 'unsafe saved path is not opened ahead of global discovery');
            releaseGlobal(); releaseOther();
            await page.waitForFunction(cwd => document.querySelector('#pi-project-path')?.textContent === cwd,
                other);
            assert.equal(requests.some(request => request.startsWith('PATCH ')), false, 'passive restore never unhides');
        } else {
            await waitFor(() => requests.some(request => request.includes(`/api/pi/sessions?cwd=${encodeURIComponent(saved)}`)));
            await page.locator('#pi-refresh-sessions').evaluate(node => node.click());
            await page.waitForTimeout(50);
            assert.equal(requests.filter(request => request.includes(`/api/pi/sessions?cwd=${encodeURIComponent(saved)}`)).length, 1, 'concurrent refresh reuses in-flight saved list');
            releaseSaved();
            await page.waitForFunction(() => !document.querySelector('#pi-input').disabled);
            const readyMs = Date.now() - start;
            assert.equal(rpc.some(command => command.sessionId === 'saved-thread'), true);
            assert.equal(requests.some(request => request.includes('/api/pi/projects/resolve')), true, 'server resolved saved cwd');
            assert.equal(requests.filter(request => request.includes(`/api/pi/sessions?cwd=${encodeURIComponent(saved)}`)).length, 1, 'initial expanded and restore list coalesced');
            releaseGlobal();
            await waitFor(() => requests.some(request => request.includes(`/api/pi/sessions?cwd=${encodeURIComponent(other)}`)));
            assert.equal(requests.filter(request => request.includes(`/api/pi/sessions?cwd=${encodeURIComponent(saved)}`)).length, 1, 'no immediate duplicate after discovery');
            assert.equal(await page.locator('.pi-session-item[data-session-id="saved-thread"]').count(), 1, 'current rows survive held unrelated list');
            console.log(JSON.stringify({ width, scenario, readyMs, fixtureOnly: true }));
            releaseOther();
        }
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `document fits ${width}px`);
        assert.equal(rpc.some(command => command.type === 'prompt'), false);
    } catch (error) { error.message = `${width}/${scenario}: ${error.message}`; throw error; }
    finally { releaseActivity(); releaseResolve(); releaseSaved(); releaseGlobal(); releaseOther(); await context.close(); }
}
(async () => {
    const app = express();
    for (const [name, directory] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets'], ['katex', 'katex/dist']]) {
        app.use('/vendor/' + name, express.static(path.join(__dirname, '../../node_modules', directory)));
    }
    app.use(express.static(path.join(__dirname, '../../public')));
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    let browser;
    try {
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
        for (const width of [1440, 393]) for (const scenario of ['ready', 'hidden', 'visibility-race', 'failed-resolve', 'switch', 'stale-list'])
            await run(browser, `http://127.0.0.1:${server.address().port}/`, width, scenario);
    } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
