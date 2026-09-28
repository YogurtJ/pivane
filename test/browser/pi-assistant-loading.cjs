// Assistant loading must not wait for global discovery or unrelated histories.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const profiles = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
    .map((id, i) => ({ id, name: `Assistant ${i}`, enabled: true }));
const cwd = '/fixture/assistant', other = '/fixture/unrelated';
const groups = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']
    .map((id, i) => ({ id, name: `Project ${i}`, cwd, profileIds: [profiles[0].id], archived: false }));
const row = (id, directory, profile, group) => ({ id, cwd: directory, name: id, firstMessage: 'Synthetic',
    agentProfile: profile, assistantProject: group, created: '2026-01-01T00:00:00Z', modified: '2026-01-01T00:00:00Z' });
const sessions = groups.map((group, i) => row(`thread-${i}`, cwd, profiles[0], group));
(async () => {
    const app = express(); app.use(express.static(path.join(__dirname, '../../public')));
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    let browser;
    try {
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
        for (const width of [1440, 393]) {
            const context = await browser.newContext({ viewport: { width, height: 900 } });
            const page = await context.newPage(), errors = [], requests = [];
            let releaseProjects, releaseUnrelated, unrelatedStarted = false;
            const projectsGate = new Promise(resolve => { releaseProjects = resolve; });
            const unrelatedGate = new Promise(resolve => { releaseUnrelated = resolve; });
            page.on('pageerror', error => errors.push(error.message));
            await page.route('**/pi-agent-profiles.js', route => route.fulfill({ contentType: 'text/javascript', body: 'window.PiAgentProfiles={create:()=>({setEnabled(){},open(){},close(){},displaySession(){},setLoadedProfile(){},projectChanged(){}})};' }));
            await page.route('**/api/**', async route => {
                const url = new URL(route.request().url()), pathname = url.pathname;
                requests.push(pathname + url.search);
                if (pathname === '/api/pi/status') return route.fulfill({ json: { ok: true, agentProfiles: true, assistantProjects: true, projectRoots: ['/fixture'], defaultProject: cwd } });
                if (pathname === '/api/pi/profiles') return route.fulfill({ json: { version: 1, revision: 'p1', profiles } });
                if (pathname === '/api/pi/projects') {
                    await projectsGate;
                    return route.fulfill({ json: { projects: [{ cwd, name: 'Assistant' }, { cwd: other, name: 'Unrelated' }], roots: ['/fixture'] } });
                }
                if (pathname === '/api/pi/assistant-projects') return route.fulfill({ json: { version: 1, revision: 'g1', projects: url.searchParams.get('profileId') === profiles[0].id ? groups : [] } });
                if (pathname === '/api/pi/sessions') {
                    if (url.searchParams.get('cwd') === other) {
                        unrelatedStarted = true;
                        await unrelatedGate;
                        return route.fulfill({ json: { sessions: [row('late-private-thread', other, profiles[0], null)] } });
                    }
                    return route.fulfill({ json: { sessions } });
                }
                if (pathname === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] } });
                return route.fulfill({ json: pathname.startsWith('/api/pi/') ? {} : [] });
            });
            try {
                const loadingStarted = Date.now();
                await page.goto(`http://127.0.0.1:${server.address().port}/#/assistant?profileId=${profiles[0].id}`, { waitUntil: 'domcontentloaded' });
                await page.locator('[data-session-id="thread-0"]').waitFor({ state: 'attached', timeout: 5000 });
                const primaryReadyMs = Date.now() - loadingStarted;
                assert.equal(await page.locator('[data-session-id="thread-1"]').count(), 1, 'both logical projects load before global discovery finishes');
                assert.equal(requests.filter(url => url.startsWith('/api/pi/sessions?')).length, 1, 'one read per physical cwd');
                assert.equal(requests.filter(url => /^\/api\/pi\/assistant-projects\/[^/]+\/sessions/.test(url)).length, 0);
                releaseProjects();
                await page.waitForFunction(() => document.querySelector('#pi-assistant-profile')?.options.length === 2);
                // Observe the unrelated request without completing its response.
                await new Promise((resolve, reject) => {
                    const timer = setInterval(() => { if (unrelatedStarted) { clearInterval(timer); clearTimeout(deadline); resolve(); } }, 10);
                    const deadline = setTimeout(() => { clearInterval(timer); reject(new Error('Unclassified discovery did not start')); }, 5000);
                });
                assert.equal(await page.locator('[data-session-id="thread-0"]').count(), 1, 'unrelated scanning must not clear ready threads');
                if (width < 700) await page.locator('#pi-toggle-sessions').click();
                await page.locator('#pi-assistant-profile').selectOption(profiles[1].id);
                await page.waitForFunction(() => !document.querySelector('[data-session-id="thread-0"]'));
                releaseUnrelated();
                await page.waitForTimeout(100);
                assert.equal(await page.locator('[data-session-id="late-private-thread"]').count(), 0, 'late results cannot cross assistant identity');
                await page.locator('#pi-assistant-profile').selectOption(profiles[0].id);
                await page.locator('[data-session-id="late-private-thread"]').waitFor({ state: 'attached' });
                assert.equal(await page.locator('[data-session-id="late-private-thread"]').count(), 1, 'unclassified discovery remains complete without duplicate rows');
                assert.deepEqual(errors, []);
                assert.equal(await page.evaluate(() => document.body.scrollWidth <= innerWidth), true);
                if (process.env.PI_SHELL_EVIDENCE) {
                    fs.mkdirSync(process.env.PI_SHELL_EVIDENCE, { recursive: true });
                    await page.screenshot({ path: path.join(process.env.PI_SHELL_EVIDENCE, `loading-${width}.png`) });
                }
                console.log(JSON.stringify({ width, errors, primaryReadyMs, sharedDirectoryReadsBeforeGlobalDiscovery: 1, globalDiscoveryWasHeld: true, staleUnclassifiedRejected: true }));
            } finally { releaseProjects(); releaseUnrelated(); await context.close(); }
        }
    } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
