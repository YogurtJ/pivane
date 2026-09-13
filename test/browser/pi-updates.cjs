const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const cwd = '/fixture/updates';
const session = { id: 'updates-fixture', cwd, name: 'Fixture conversation', messageCount: 2 };
const model = { provider: 'fixture', id: 'fixture-model', name: 'Fixture', input: ['text', 'image'], contextWindow: 32000, available: true, thinkingLevels: ['off'] };
const empty = channel => ({ appVersion: '1.0.0-rc.2', piVersion: '0.85.0', bundledPiVersion: '0.85.0', dependencyMatches: true,
    channel, platform: 'linux', installMode: 'manual', checkedAt: null,
    pivane: { status: 'unchecked', releasesUrl: 'https://github.com/YogurtJ/pivane/releases' },
    pi: { status: 'unchecked', releasesUrl: 'https://www.npmjs.com/package/@earendil-works/pi-coding-agent' } });
async function run(browser, base, width, language) {
    const english = language === 'en-US';
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: language, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors = [], writes = [], rpc = [];
    let mode = 'success', hold = null, releaseResponse, arrivals = 0;
    let maintenanceState = { supported: true, updateSupported: true, busy: false, generation: 'fixture-before', storage: '/fixture/private-maintenance', job: null };
    let ticketCounter = 0, lastTicket, maintenanceHold, releaseMaintenance, uncertainExecution = false;
    const executed = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(({ cwd }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, 'updates-fixture'); }, { cwd });
    await page.route(/https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)\//, r => r.abort());
    await page.route('**/api/**', async route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() !== 'GET') writes.push(url.pathname);
        let data = {};
        if (url.pathname === '/api/pi/settings/updates/maintenance') return route.fulfill({ json: maintenanceState });
        if (url.pathname === '/api/pi/settings/updates/review') {
            if (maintenanceHold) await maintenanceHold;
            lastTicket = { id: '00000000-0000-4000-8000-' + String(++ticketCounter).padStart(12, '0'), action: request.postDataJSON().action, currentVersion: '0.85.0', version: '0.85.1', storage: maintenanceState.storage };
            return route.fulfill({ json: lastTicket });
        }
        if (url.pathname === '/api/pi/settings/updates/execute') {
            const body = request.postDataJSON(); executed.push(body);
            maintenanceState = { ...maintenanceState, busy: true, job: { id: body.ticket, phase: 'installing', action: lastTicket.action,
                output: '$ npm install --ignore-scripts\nInstalling <script>window.consoleXss=true</script>\n', fromVersion: '0.85.0', exitCode: null } };
            if (uncertainExecution) return route.abort();
            return route.fulfill({ status: 202, json: { accepted: true, id: body.ticket } });
        }
        if (url.pathname.startsWith('/api/pi/settings/updates')) {
            if (mode === 'old') return route.fulfill({ status: 404, json: { error: 'Not found' } });
            if (request.method() === 'GET') return route.fulfill({ json: empty(url.searchParams.get('channel') || 'preview') });
            arrivals++;
            const savedMode = mode;
            if (hold) await hold;
            data = empty(request.postDataJSON().channel);
            data.checkedAt = '2026-09-12T00:00:00Z';
            data.pi = { ...data.pi, version: '0.86.0', status: 'available' };
            data.pivane = savedMode === 'error' ? { ...data.pivane, status: 'error' } : savedMode === 'empty' ? { ...data.pivane, status: 'no-release' } : {
                status: 'available', version: '1.0.0-rc.10', prerelease: true,
                releasesUrl: 'https://github.com/YogurtJ/pivane/releases/tag/v1.0.0-rc.10',
                downloadUrl: 'https://github.com/YogurtJ/pivane/releases/download/v1.0.0-rc.10/pivane-1.0.0-rc.10.tar.gz',
                checksumUrl: 'https://github.com/YogurtJ/pivane/releases/download/v1.0.0-rc.10/pivane-1.0.0-rc.10.tar.gz.sha256' };
        } else if (url.pathname === '/api/pi/status') data = { ok: true, updateChecks: true, projectRoots: ['/fixture'], defaultProject: cwd };
        else if (url.pathname === '/api/pi/projects') data = { roots: ['/fixture'], projects: [{ cwd, name: 'Fixture', sessionCount: 1 }] };
        else if (url.pathname === '/api/pi/sessions') data = { sessions: [session] };
        else if (url.pathname === '/api/pi/activity') data = { runtimes: [], replyNotices: [], pinnedProjects: [], hiddenProjects: [] };
        else if (url.pathname === '/api/pi/settings/models') data = { models: [model], providers: [{ id: 'fixture', name: 'Fixture', configured: true, authMethods: {} }], customProviders: [], preferences: {} };
        else if (url.pathname === '/api/pi/settings/session-titles') data = { enabled: false };
        else if (url.pathname.endsWith('/history')) data = [];
        return route.fulfill({ json: data });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => {
        const command = JSON.parse(raw); rpc.push(command.type);
        const state = { model, isStreaming: false, thinkingLevel: 'off' };
        let data = {};
        const messages = [{ role: 'user', content: [{ type: 'text', text: 'Fixture question' }] },
            { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: { path: '/fixture/example.txt' } }] },
            { role: 'toolResult', toolCallId: 't1', toolName: 'read', isError: false, content: [{ type: 'text', text: 'Fixture tool output' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'Fixture reply' }], stopReason: 'stop' }];
        if (command.type === 'open_session') data = { session, state, messages: { messages }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } };
        else if (command.type === 'get_state') data = state;
        else if (command.type === 'get_messages') data = { messages };
        else if (command.type === 'get_available_models') data = { models: [model] };
        else if (command.type === 'get_available_thinking_levels') data = { levels: ['off'] };
        ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
    }));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.getElementById('pi-input').disabled);
    await page.locator('#pi-input').fill('Unsent update discussion');
    await page.locator('#pi-file-input').setInputFiles({ name: 'update-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic data') });
    await page.locator('#pi-attachments .pi-attachment-chip').first().waitFor();
    await page.locator('[data-transcript-mode="full"]').click();
    assert.equal(await page.locator('.pi-tool-output').textContent(), 'Fixture tool output');
    if (width < 900) { await page.locator('#pi-toggle-sessions').click(); await page.locator('#pi-toggle-sessions').click(); }
    await page.locator('#workspace-settings-toggle').click();
    await page.locator('[data-settings-tab="updates"]').click();
    await page.locator('#updates-check').waitFor();
    assert.equal(await page.locator('#updates-channel').inputValue(), 'preview');
    assert.equal(await page.locator('#settings-updates-panel h3').textContent(), english ? 'Versions and updates' : '版本与更新');
    assert.equal(writes.length, 0);
    await page.locator('#updates-check').click();
    await page.locator('#updates-pivane [data-state="available"]').waitFor();
    assert.equal(await page.locator('#updates-pivane a[href$=".tar.gz"]').count(), 1);
    assert.ok((await page.locator('#updates-pi').innerText()).includes(english ? 'managed updates' : '受管更新'));
    await page.locator('#updates-pivane button').click();
    assert.equal(await page.locator('#updates-guide').evaluate(e => e.open), true);
    const overflow = async () => {
        const metrics = await page.evaluate(() => [...document.querySelectorAll('.workspace-settings-dialog, .workspace-settings-body, .workspace-settings-content, .workspace-settings-nav, #settings-updates-panel, #settings-updates-panel *')].filter(e => e.clientWidth).map(e => ({
            id: e.id || e.className || e.tagName, client: e.clientWidth, scroll: e.scrollWidth
        })));
        for (const m of metrics) assert.ok(m.scroll <= m.client + 1, `${language}/${width}: ${JSON.stringify(m)}`);
    };
    for (const theme of ['daylight', 'mint', 'dark']) { await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme); await overflow(); }
    if (width < 600) assert.ok(await page.locator('#updates-channel').evaluate(e => parseFloat(getComputedStyle(e).fontSize)) >= 16);
    await page.screenshot({ path: path.join(os.tmpdir(), `pivane-updates-${language}-${width}.png`) });
    await page.locator('#maintenance-update').click();
    await page.locator('#maintenance-dialog[open]').waitFor();
    const confirmationBox = await page.locator('#maintenance-dialog').boundingBox();
    assert.ok(Math.abs(confirmationBox.x + confirmationBox.width / 2 - width / 2) < 2, 'maintenance dialog is centered');
    assert.equal(await page.locator('#maintenance-confirm').isDisabled(), true);
    await page.locator('#maintenance-drafts').check();
    assert.equal(await page.locator('#maintenance-confirm').isDisabled(), true);
    await page.locator('#maintenance-external').check();
    await overflow();
    await page.screenshot({ path: path.join(os.tmpdir(), `pivane-maintenance-${language}-${width}.png`) });
    const executedResponse = page.waitForResponse(r => r.url().endsWith('/updates/execute'));
    await page.locator('#maintenance-confirm').click(); await executedResponse;
    await page.waitForFunction(() => document.getElementById('maintenance-dialog').open === false);
    assert.equal(await page.locator('#maintenance-update').isDisabled(), true);
    await page.locator('#workspace-settings-close').click(); await page.locator('#workspace-settings-toggle').click();
    await page.locator('#maintenance-refresh').waitFor();
    assert.equal(await page.locator('#maintenance-update').isDisabled(), true);
    await page.locator('#maintenance-refresh').click();
    await page.waitForFunction(() => document.getElementById('maintenance-output').textContent.includes('$ npm install'));
    assert.equal(await page.evaluate(() => Boolean(window.consoleXss)), false);
    assert.equal(await page.locator('#maintenance-output script').count(), 0);
    maintenanceState = { ...maintenanceState, busy: false, generation: 'fixture-after', job: { ...maintenanceState.job, phase: 'succeeded', installedVersion: '0.85.1', exitCode: 0,
        output: '$ npm install --ignore-scripts\nadded 100 packages\nCompleted. Running Pi 0.85.1.\n', backup: { directory: '/fixture/private-maintenance/backups/example' } } };
    await page.locator('#maintenance-refresh').click();
    await page.waitForFunction(() => !document.getElementById('maintenance-update').disabled);
    assert.ok((await page.locator('#maintenance-result').textContent()).includes('0.85.0 → 0.85.1'));
    assert.ok((await page.locator('#maintenance-output').textContent()).includes('added 100 packages'));
    await overflow();
    await page.screenshot({ path: path.join(os.tmpdir(), `pivane-update-console-${language}-${width}.png`) });
    assert.deepEqual(executed[0], { ticket: lastTicket.id, confirmed: true, draftsSaved: true, externalWritersStopped: true });
    // Closing a confirmation never executes it; losing an execute response never retries it.
    await page.locator('#maintenance-backup').click(); await page.locator('#maintenance-dialog[open]').waitFor();
    await page.locator('#maintenance-dialog .updates-links button').first().click(); assert.equal(executed.length, 1);
    uncertainExecution = true;
    await page.locator('#maintenance-backup').click(); await page.locator('#maintenance-dialog[open]').waitFor();
    await page.locator('#maintenance-drafts').check(); await page.locator('#maintenance-external').check();
    const unknownRequest = page.waitForEvent('requestfailed', { predicate: r => r.url().endsWith('/updates/execute') });
    await page.locator('#maintenance-confirm').click(); await unknownRequest;
    await page.locator('#maintenance-refresh').click(); assert.equal(await page.locator('#maintenance-update').isDisabled(), true);
    maintenanceState = { ...maintenanceState, busy: false, job: { ...maintenanceState.job, phase: 'failed', error: 'installing', exitCode: 7, output: '[stderr] npm error fixture failure\nCommand finished: exit=7\n' } };
    await page.locator('#maintenance-refresh').click(); await page.waitForFunction(() => !document.getElementById('maintenance-update').disabled);
    assert.ok((await page.locator('#maintenance-result').textContent()).includes('7'));
    assert.ok((await page.locator('#maintenance-output').textContent()).includes('npm error fixture failure'));
    assert.equal(executed.length, 2);
    maintenanceHold = new Promise(resolve => { releaseMaintenance = resolve; });
    const reviewingRequest = page.waitForRequest(r => r.url().endsWith('/updates/review'));
    await page.locator('#maintenance-restart').click(); await reviewingRequest;
    await page.locator('#workspace-settings-close').click(); await page.locator('#workspace-settings-toggle').click();
    const lateReview = page.waitForResponse(r => r.url().endsWith('/updates/review'));
    releaseMaintenance(); maintenanceHold = null; await lateReview;
    assert.equal(await page.locator('#maintenance-dialog').evaluate(e => e.open), false);
    assert.equal(executed.length, 2);
    // A delayed check must not overwrite a newly opened panel or a different channel.
    hold = new Promise(resolve => { releaseResponse = resolve; });
    const checkingRequest = page.waitForRequest(r => r.url().endsWith('/settings/updates/check'));
    await page.locator('#updates-check').click();
    await checkingRequest;
    await page.waitForFunction(() => document.getElementById('updates-check').disabled);
    assert.equal(await page.locator('#updates-channel').isDisabled(), true);
    await page.locator('#workspace-settings-close').click();
    await page.locator('#workspace-settings-toggle').click();
    await page.waitForFunction(() => !document.getElementById('updates-check').disabled);
    await page.locator('#updates-channel').selectOption('stable');
    await page.waitForFunction(() => !document.getElementById('updates-channel').disabled);
    const lateResponse = page.waitForResponse(r => r.url().endsWith('/settings/updates/check'));
    releaseResponse(); hold = null;
    await lateResponse;
    assert.equal(await page.locator('#updates-channel').inputValue(), 'stable');
    assert.equal(await page.locator('#updates-pivane [data-state="unchecked"]').count(), 1);
    mode = 'error'; await page.locator('#updates-check').click();
    await page.locator('#updates-pivane [data-state="error"]').waitFor();
    assert.equal(await page.locator('#updates-pi [data-state="available"]').count(), 1);
    assert.equal(await page.locator('#updates-pivane a[href$=".tar.gz"]').count(), 0);
    mode = 'empty'; await page.locator('#updates-check').click();
    await page.locator('#updates-pivane [data-state="no-release"]').waitFor();
    mode = 'old'; await page.locator('#updates-channel').selectOption('preview');
    await page.waitForFunction(() => !document.getElementById('updates-channel').disabled);
    assert.equal(await page.locator('#updates-channel').inputValue(), 'stable', 'failed channel read restores the displayed channel');
    mode = 'success';
    const retried = page.waitForRequest(r => r.url().endsWith('/settings/updates/check'));
    await page.locator('#updates-check').click();
    assert.equal((await retried).postDataJSON().channel, 'stable');
    await page.locator('#updates-pivane [data-state="available"]').waitFor();
    mode = 'old'; await page.locator('[data-settings-tab="providers"]').click(); await page.locator('[data-settings-tab="updates"]').click();
    await page.waitForFunction(() => document.getElementById('updates-feedback')?.textContent.includes('维护') || document.getElementById('updates-feedback')?.textContent.includes('maintenance'));
    await page.locator('#workspace-settings-close').click();
    assert.equal(await page.locator('#pi-input').inputValue(), 'Unsent update discussion');
    assert.ok((await page.locator('#pi-attachments').innerText()).includes('update-notes.txt'));
    assert.ok(writes.every(p => ['/api/pi/settings/updates/check', '/api/pi/settings/updates/review', '/api/pi/settings/updates/execute'].includes(p)));
    assert.ok(!rpc.includes('prompt') && !rpc.includes('abort') && !rpc.includes('restart_runtime'));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ language, width, checks: arrivals, errors, draftsPreserved: true }));
    await context.close();
}
(async () => {
    const app = express();
    for (const [name, dir] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use('/vendor/' + name, express.static(path.join(root, 'node_modules', dir)));
    app.use(express.static(path.join(root, 'public')));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
    try { for (const language of ['zh-CN', 'en-US']) for (const width of [320, 393, 1024, 1440]) await run(browser, `http://127.0.0.1:${server.address().port}`, width, language); }
    finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
