const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const app = express();
const root = path.resolve(__dirname, '../..');
for (const [url, directory] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use(`/vendor/${url}`, express.static(path.join(root, 'node_modules', directory)));
app.use(express.static(path.join(root, 'public')));
const cwd = '/tmp/profiles-synthetic-project';
const first = { id: 'old-none', cwd, name: 'Existing thread', messageCount: 0, agentProfile: null };
const sample = { id: 'p-sample', name: 'Research', description: 'Study notes', soul: 'Be precise.', enabled: true, memory: { enabled: true, autoLearn: false }, skills: { learnedEnabled: true }, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
const model = { provider: 'fixture', id: 'test', name: 'Test', input: ['text'], contextWindow: 128000 };
const stats = { totalMessages: 0, contextUsage: { tokens: 0, percent: 0, contextWindow: 128000 } };
async function run(browser, base, width, supported = true) {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width, height: 900 }, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(), errors = [], writes = [], sessions = [structuredClone(first)];
    let profiles = [structuredClone(sample)], revision = 'r1', defaultProfileId = null, conflict = false, memoryRelease, slowMemory = false, memoryStatus = null;
    let slowProfiles = false, profilesRelease;
    page.on('pageerror', error => errors.push(error.message));
    await page.route(/https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)\//, route => route.abort());
    await page.addInitScript(({ cwd, id }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, id); }, { cwd, id: first.id });
    const response = (route, json, status = 200) => route.fulfill({ json, status });
    await page.route('**/api/**', async route => {
        const req = route.request(), url = new URL(req.url()), p = url.pathname;
        if (req.method() !== 'GET') {
            const body = req.postDataJSON(); writes.push({ p, body });
            if (p === '/api/pi/profiles' || p === '/api/pi/profiles/default') {
                if (conflict || body.expectedRevision !== revision) return response(route, { error: 'Revision changed', code: 'REVISION_CONFLICT' }, 409);
                revision += 'x';
                if (p.endsWith('/default')) { defaultProfileId = body.profileId; return response(route, { ok: true, cwd, defaultProfileId, revision }); }
                const profile = { ...body.profile, id: body.profile.id || 'p-new', createdAt: '2026-01-01', updatedAt: '2026-01-02' };
                profiles = [...profiles.filter(row => row.id !== profile.id), profile];
                return response(route, { ok: true, profile, revision, requiresReload: true });
            }
            if (p === '/api/pi/sessions') {
                const profileId = Object.hasOwn(body, 'profileId') ? body.profileId : defaultProfileId;
                const profile = profiles.find(row => row.id === profileId);
                const session = { id: `new-${sessions.length}`, cwd, name: `Thread ${sessions.length}`, messageCount: 0,
                    agentProfile: profile ? { id: profile.id, name: profile.name, enabled: profile.enabled, available: profile.enabled } : null };
                sessions.unshift(session); return response(route, session, 201);
            }
            return response(route, { ok: true });
        }
        if (p === '/api/pi/status') return response(route, { ok: true, agentProfiles: supported, projectRoots: ['/tmp'], defaultProject: cwd });
        if (p === '/api/pi/projects') return response(route, { projects: [{ cwd, name: 'Fixture', sessionCount: sessions.length }], roots: ['/tmp'] });
        if (p === '/api/pi/sessions') return response(route, { sessions });
        if (p === '/api/pi/activity') return response(route, { runtimes: [], replyNotices: [] });
        if (p === '/api/pi/profiles') {
            if (!supported) throw new Error('Old backend must not receive profiles request');
            const data = { version: 1, revision, profiles: structuredClone(profiles), cwd: url.searchParams.get('cwd'), defaultProfileId };
            if (slowProfiles) await new Promise(r => { profilesRelease = r; });
            return response(route, data);
        }
        if (p.endsWith('/memory')) {
            if (slowMemory && url.searchParams.get('kind') === 'memories') await new Promise(r => { memoryRelease = r; });
            const status = memoryStatus || (url.searchParams.get('kind') === 'skills' ? 'unsupported' : 'ready');
            return response(route, { version: 1, profileId: 'p-sample', status, reason: status === 'ready' ? undefined : 'Synthetic status', revision: status === 'ready' ? 'm1' : null, items: status !== 'ready' ? [] : [{ id: 'm1', kind: 'memory', target: 'Test', content: '<img src=x onerror=alert(1)>', source: { sessionId: 'synthetic' } }], hasMore: false });
        }
        if (p === '/api/prompts' || p.includes('/history')) return response(route, []);
        return response(route, {});
    });
    const reply = (ws, cmd, data) => ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }));
    await page.routeWebSocket('**/api/pi/ws', ws => {
        socket = ws;
        ws.onMessage(raw => {
            const cmd = JSON.parse(raw), runtime = { model, thinkingLevel: 'off', isStreaming: false, isCompacting: false, autoCompactionEnabled: true };
            if (cmd.type === 'open_session') return reply(ws, cmd, { session: sessions.find(s => s.id === cmd.sessionId), state: runtime, messages: { messages: [] }, stats, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } });
            if (cmd.type === 'get_state') return reply(ws, cmd, runtime);
            if (cmd.type === 'get_messages') return reply(ws, cmd, { messages: [] });
            if (cmd.type === 'get_session_stats') return reply(ws, cmd, stats);
            reply(ws, cmd, {});
        });
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.querySelector('#pi-project-button').disabled);
    await page.waitForFunction(() => document.querySelector('#pi-input').disabled === false);
    if (width < 900) await page.locator('#pi-toggle-sessions').click();
    assert.equal(await page.locator('#pi-new-profile-session').isVisible(), supported);
    if (!supported) {
        await page.locator('#workspace-settings-toggle').click();
        assert.equal(await page.locator('#pi-profiles-nav').isVisible(), false);
        assert.equal(await page.locator('#pi-session-profile').isVisible(), false);
        assert.deepEqual(errors, []); await context.close(); return;
    }
    assert.match(await page.locator('#pi-session-profile').innerText(), /No profile/);
    await page.locator('#pi-input').fill('Original draft');
    await page.locator('#pi-file-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic attachment') });
    await page.locator('.pi-attachment-chip').waitFor();
    const attachment = await page.locator('.pi-attachment-chip').innerText();
    await page.locator('#workspace-settings-toggle').click();
    await page.locator('[data-settings-tab="profiles"]').click();
    await page.locator('#pi-profile-default-select').waitFor();
    assert.equal(await page.locator('#pi-profile-default-select').inputValue(), '');
    await page.locator('#pi-profile-default-select').selectOption(sample.id);
    conflict = true; await page.locator('#pi-profile-default-save').click();
    await page.waitForFunction(() => document.querySelector('#pi-profiles-status').textContent.includes('conflict'));
    assert.equal(await page.locator('#pi-profile-default-select').inputValue(), sample.id);
    conflict = false; await page.locator('#pi-profile-default-save').click();
    await page.waitForFunction(() => document.querySelector('#pi-profiles-status').textContent.includes('saved'));
    assert.equal(writes.at(-1).body.profileId, sample.id);
    await page.locator('[data-profile-action="edit"]').first().click();
    await page.locator('#pi-profile-form [name=name]').fill('Research updated');
    if (width < 900) {
        const sizes = await page.locator('#pi-profile-form input:not([type=checkbox]),#pi-profile-form textarea').evaluateAll(nodes => nodes.map(e => parseFloat(getComputedStyle(e).fontSize)));
        assert.ok(sizes.every(size => size >= 16), `mobile editor font sizes: ${sizes}`);
    }
    conflict = true; await page.locator('#pi-profile-form [type=submit]').click();
    await page.waitForFunction(() => document.querySelector('#pi-profile-editor-status').textContent.includes('conflict'));
    assert.equal(await page.locator('#pi-profile-form [name=name]').inputValue(), 'Research updated');
    conflict = false;
    await page.locator('#pi-profiles-refresh').click();
    await page.waitForFunction(() => document.querySelector('#pi-profiles-status').textContent === '');
    assert.equal(await page.locator('#pi-profile-form [name=name]').inputValue(), 'Research updated');
    await page.locator('#pi-profile-form [type=submit]').click();
    await page.waitForFunction(() => !document.querySelector('#pi-profile-form'));
    assert.equal(profiles.find(p => p.id === sample.id).name, 'Research updated');
    slowProfiles = true;
    await page.locator('#pi-profiles-refresh').click();
    for (let i = 0; !profilesRelease && i < 50; i++) await new Promise(r => setTimeout(r, 20));
    assert.ok(profilesRelease, 'stale profiles request started');
    profiles[0].description = 'New server description';
    await page.locator('[data-settings-tab="models"]').click();
    slowProfiles = false;
    await page.locator('[data-settings-tab="profiles"]').click();
    await page.waitForFunction(() => document.querySelector('#pi-profile-default-select'));
    profilesRelease();
    await page.waitForTimeout(50);
    assert.match(await page.locator('.pi-profile-row').first().innerText(), /New server description/);
    await page.locator('#pi-profile-add').click();
    await page.locator('#pi-profile-form [name=name]').fill('Unsaved');
    await page.locator('[data-settings-tab="models"]').click();
    await page.locator('[data-settings-tab="profiles"]').click();
    await page.locator('#pi-profile-form [name=name]').waitFor();
    assert.equal(await page.locator('#pi-profile-form [name=name]').inputValue(), 'Unsaved');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#pi-profile-editor-close').click();
    await page.locator('#pi-profile-add').click();
    await page.locator('#pi-profile-form [name=name]').fill('Writing');
    await page.locator('#pi-profile-form [type=submit]').click();
    await page.waitForFunction(() => !document.querySelector('#pi-profile-form'));
    assert.deepEqual(profiles.find(p => p.id === 'p-new').memory, { enabled: false, autoLearn: false });
    assert.equal(profiles.find(p => p.id === 'p-new').skills.learnedEnabled, true);
    slowMemory = true; await page.locator('[data-profile-action="view"]').first().click();
    for (let i = 0; !memoryRelease && i < 50; i++) await new Promise(r => setTimeout(r, 20));
    assert.ok(memoryRelease, 'memory request started');
    await page.locator('[data-kind=skills]').click();
    await page.waitForFunction(() => document.querySelector('#pi-profile-memory-status')?.textContent.includes('unsupported'));
    memoryRelease(); slowMemory = false;
    await page.waitForTimeout(50);
    assert.match(await page.locator('#pi-profile-memory-status').innerText(), /unsupported/);
    await page.locator('[data-kind=memories]').click();
    await page.locator('.pi-profile-memory-item').waitFor();
    assert.equal(await page.locator('.pi-profile-memory-item img').count(), 0, 'memory content must be text');
    for (const status of ['missing', 'disabled', 'error']) {
        memoryStatus = status;
        await page.locator('#pi-profiles-refresh').click();
        await page.waitForFunction(label => document.querySelector('#pi-profile-memory-status')?.textContent.includes(label), status === 'missing' ? 'missing' : status === 'disabled' ? 'disabled' : 'failed');
        assert.equal(await page.locator('.pi-profile-memory-item').count(), 0);
    }
    memoryStatus = null;
    await page.locator('#workspace-settings-close').click();
    assert.equal(await page.locator('#pi-input').inputValue(), 'Original draft');
    assert.equal(await page.locator('.pi-attachment-chip').innerText(), attachment);
    if (width < 900 && !await page.locator('#pi-session-pane').evaluate(el => el.classList.contains('open'))) await page.locator('#pi-toggle-sessions').click();
    await page.locator('#pi-new-profile-session').click();
    await page.locator('#pi-profile-choice-select').waitFor();
    await page.waitForFunction(() => !document.querySelector('#pi-profile-choice-create').disabled);
    const choiceWidths = await page.evaluate(() => [...document.querySelectorAll('#pi-profile-choice,#pi-profile-choice form,#pi-profile-choice select')].map(el => [el.clientWidth, el.scrollWidth]));
    assert.ok(choiceWidths.every(([client, scroll]) => scroll <= client + 1), JSON.stringify(choiceWidths));
    if (width < 900) assert.ok(await page.locator('#pi-profile-choice select').evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 16));
    await page.locator('#pi-profile-choice').press('Escape');
    assert.equal(await page.locator('#pi-profile-choice').evaluate(e => e.open), false);
    await page.locator('#pi-new-profile-session').click();
    await page.waitForFunction(() => !document.querySelector('#pi-profile-choice-create').disabled);
    await page.locator('#pi-profile-choice-select').selectOption('none');
    await page.locator('#pi-profile-choice-create').click();
    await page.waitForFunction(() => document.querySelector('#pi-session-profile')?.textContent === 'No profile');
    assert.equal(writes.filter(w => w.p === '/api/pi/sessions').at(-1).body.profileId, null);
    assert.equal(sessions.find(s => s.id === first.id).agentProfile, null);
    if (width < 900 && !await page.locator('#pi-session-pane').evaluate(el => el.classList.contains('open'))) await page.locator('#pi-toggle-sessions').click();
    await page.locator('#pi-new-profile-session').click();
    await page.waitForFunction(() => !document.querySelector('#pi-profile-choice-create').disabled);
    await page.locator('#pi-profile-choice-create').click();
    await page.waitForFunction(() => document.querySelector('#pi-session-profile')?.textContent.includes('Research updated'));
    assert.equal(Object.hasOwn(writes.filter(w => w.p === '/api/pi/sessions').at(-1).body, 'profileId'), false);
    assert.match(await page.locator('#pi-session-profile').getAttribute('title'), /worker-loaded settings are unverified/i);
    assert.match(await page.locator('#pi-meta-profile').textContent(), /Saved thread profile: Research updated.*Worker-loaded settings are unverified/i);
    if (width < 900 && !await page.locator('#pi-session-pane').evaluate(el => el.classList.contains('open'))) await page.locator('#pi-toggle-sessions').click();
    slowProfiles = true; profilesRelease = null;
    await page.locator('#pi-new-profile-session').click();
    for (let i = 0; !profilesRelease && i < 50; i++) await new Promise(r => setTimeout(r, 20));
    assert.ok(profilesRelease, 'late choice request started');
    await page.locator('#pi-profile-choice-close').click();
    slowProfiles = false;
    profiles.find(p => p.id === 'p-new').name = 'Writing updated';
    await page.locator('#pi-new-profile-session').click();
    await page.waitForFunction(() => !document.querySelector('#pi-profile-choice-create').disabled);
    profilesRelease();
    await page.waitForTimeout(50);
    assert.ok((await page.locator('#pi-profile-choice-select').innerText()).includes('Writing updated'), 'late closed chooser cannot replace current options');
    await page.locator('#pi-profile-choice-select').selectOption('profile:p-new');
    await page.locator('#pi-profile-choice-create').click();
    await page.waitForFunction(() => document.querySelector('#pi-session-profile')?.textContent.includes('Writing updated'));
    assert.equal(writes.filter(w => w.p === '/api/pi/sessions').at(-1).body.profileId, 'p-new');
    assert.equal(defaultProfileId, sample.id);
    if (width < 900 && !await page.locator('#pi-session-pane').evaluate(el => el.classList.contains('open'))) await page.locator('#pi-toggle-sessions').click();
    await page.locator(`[data-session-id="${first.id}"] .pi-session-main`).click();
    await page.waitForFunction(() => document.querySelector('#pi-session-profile')?.textContent === 'No profile');
    assert.equal(await page.locator('#pi-input').inputValue(), 'Original draft');
    assert.equal(await page.locator('.pi-attachment-chip').innerText(), attachment);
    await page.locator('#workspace-settings-toggle').click();
    await page.locator('[data-settings-tab="profiles"]').click();
    await page.locator('#pi-profile-default-select').waitFor();
    await page.locator('#pi-profile-default-select').selectOption('');
    await page.locator('#pi-profile-default-save').click();
    await page.waitForFunction(() => document.querySelector('#pi-profiles-status').textContent.includes('saved'));
    assert.equal(defaultProfileId, null);
    assert.equal(sessions.find(s => s.id === first.id).agentProfile, null);
    const widths = await page.evaluate(() => [...document.querySelectorAll('body,.workspace-settings-dialog,.workspace-settings-content,.workspace-settings-panel.active,#pi-profiles-content,.pi-profile-default,.pi-profile-row,#pi-profile-choice')]
        .filter(el => el.getClientRects().length).map(el => ({ name: el.id || el.className, client: el.clientWidth, scroll: el.scrollWidth })));
    assert.ok(widths.every(row => row.scroll <= row.client + 1), JSON.stringify(widths));
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    const themeColors = await page.locator('#pi-profile-default-select').evaluate(el => ({ background: getComputedStyle(el).backgroundColor, text: getComputedStyle(el).color, surface: getComputedStyle(document.documentElement).getPropertyValue('--surface-1').trim(), ink: getComputedStyle(document.documentElement).getPropertyValue('--text-main').trim() }));
    assert.ok(themeColors.background !== 'rgb(255, 255, 255)' && themeColors.text !== 'rgb(37, 48, 57)', JSON.stringify(themeColors));
    await page.evaluate(() => document.documentElement.dataset.theme = 'daylight');
    if (width < 900) {
        const sizes = await page.locator('#pi-profiles-panel input:not([type=checkbox]),#pi-profiles-panel select,#pi-profile-choice select').evaluateAll(nodes => nodes.filter(e => e.getClientRects().length).map(e => parseFloat(getComputedStyle(e).fontSize)));
        assert.ok(sizes.every(size => size >= 16), `mobile form font sizes: ${sizes}`);
        assert.ok(await page.locator('.workspace-settings-panel.active').evaluate(el => el.scrollHeight > el.clientHeight), 'settings panel scrolls internally');
    }
    await page.screenshot({ path: `/tmp/pi-agent-profiles-${width}.png` });
    defaultProfileId = 'p-missing';
    await page.locator('#pi-profiles-refresh').click();
    await page.waitForFunction(() => document.querySelector('#pi-profile-default-select')?.value === 'p-missing');
    assert.match(await page.locator('#pi-profile-default-select option:checked').innerText(), /unavailable/);
    await page.locator('#workspace-settings-close').click();
    if (width < 900 && !await page.locator('#pi-session-pane').evaluate(el => el.classList.contains('open'))) await page.locator('#pi-toggle-sessions').click();
    await page.locator('#pi-new-profile-session').click();
    await page.waitForFunction(() => !document.querySelector('#pi-profile-choice-create').disabled);
    assert.equal(await page.locator('#pi-profile-choice-select').inputValue(), 'none');
    assert.match(await page.locator('#pi-profile-choice-state').innerText(), /default is unavailable/);
    await page.locator('#pi-profile-choice-cancel').click();
    assert.deepEqual(errors, []);
    console.log(`PASS profiles ${width}: writes=${writes.length}, pageerrors=${errors.length}, widths=${JSON.stringify(widths)}`);
    await context.close();
}
(async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
    try { for (const width of [320, 393, 1440]) await run(browser, base, width); await run(browser, base, 393, false); }
    finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
