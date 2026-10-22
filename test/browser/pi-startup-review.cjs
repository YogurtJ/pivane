// Production index wiring: automatic notifications and settings lifecycle across deferred routes.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { fixture } = require('./pi-startup-loading.cjs');
const base = process.env.PI_STARTUP_REVIEW_URL || 'http://127.0.0.1:5199';
const profileId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
async function finish(f, label) {
    assert.deepEqual(f.errors, [], label + ': pageerrors');
    assert.equal(f.commands.includes('prompt'), false, label + ': no model prompt');
    assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, label + ': actual viewport width');
    await f.context.close();
}
async function notifications(browser, width) {
    const updates = { calls: [], state: { enabled: true, available: false, eligible: false, idle: false, currentVersion: '1.2.0', version: null, nextCheckAt: null } };
    const f = await fixture(browser, width, width === 393 ? '#/assistant' : '#/chat', { base, clock: true, updates }), { page } = f;
    await f.go(); await page.clock.fastForward(5000);
    await page.waitForFunction(() => document.querySelector('#workspace-settings-toggle .pi-update-badge')?.hidden === false);
    assert.equal(await page.locator('#workspace-settings-toggle .pi-update-badge').isVisible(), true, JSON.stringify(await page.locator('#workspace-settings-toggle').evaluate(node => ({ html: node.outerHTML, rect: node.getBoundingClientRect().toJSON(), styles: [...node.children].map(el => ({ html: el.outerHTML, rect: el.getBoundingClientRect().toJSON(), display: getComputedStyle(el).display })) }))));
    assert.equal(updates.calls.filter(c => c.path.endsWith('/automatic')).length, 1, 'index starts automatic checks while still chatting');
    assert.equal(await page.locator('#pi-update-notice').isVisible(), false, 'server busy state defers popup');
    assert.equal(f.requests.some(url => /\/(settings|pi-updates)\.js$/.test(url)), false, 'notification runtime does not load management');
    assert.equal(await page.locator('.pi-update-badge').first().evaluate(node => getComputedStyle(node).width), '7px', 'badge CSS is available before management');
    updates.state.idle = true;
    await page.evaluate(() => dispatchEvent(new Event('focus'))); await page.clock.fastForward(5000);
    await page.locator('#pi-update-notice').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#pi-update-notice').evaluate(node => getComputedStyle(node).position), 'fixed');
    assert.equal(await page.locator('#pi-update-notice').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    await page.evaluate(() => { window.noticeBeforeManagement = document.getElementById('pi-update-notice'); });
    await page.locator('#pi-update-notice-open').click();
    await page.locator('#updates-auto-check').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => noticeBeforeManagement === document.getElementById('pi-update-notice')), true, 'updates page reuses index runtime');
    assert.equal(await page.locator('#pi-update-notice').count(), 1);
    assert.equal(await page.locator('#updates-auto-check').count(), 1);
    await page.locator('#workspace-settings-close').click();
    const reads = () => updates.calls.filter(c => c.path.endsWith('/notifications') && c.method === 'GET').length;
    const before = reads();
    const response = page.waitForResponse(r => r.url().endsWith('/updates/notifications') && r.request().method() === 'GET');
    await page.clock.fastForward(60000); await response; await page.waitForTimeout(50);
    assert.equal(reads(), before + 1, 'opening the updates page did not duplicate runtime timers');
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    const hiddenReads = reads(); await page.clock.fastForward(60000); await page.waitForTimeout(50);
    assert.equal(reads(), hiddenReads, 'hidden page does not check');
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
    const visibleResponse = page.waitForResponse(r => r.url().endsWith('/updates/notifications') && r.request().method() === 'GET');
    await page.clock.fastForward(5000); await visibleResponse;
    await page.evaluate(() => { document.body.classList.add('workspace-access-locked'); dispatchEvent(new Event('workspace:access-locked')); });
    assert.equal(await page.locator('#workspace-settings-toggle .pi-update-badge').evaluate(node => node.hidden), true);
    const lockedReads = reads(); await page.clock.fastForward(60000); await page.waitForTimeout(50); assert.equal(reads(), lockedReads);
    await page.evaluate(() => { document.body.classList.remove('workspace-access-locked'); dispatchEvent(new Event('workspace:access-ready')); });
    const unlockedResponse = page.waitForResponse(r => r.url().endsWith('/updates/notifications') && r.request().method() === 'GET');
    await page.clock.fastForward(5000); await unlockedResponse;
    assert.equal(updates.calls.filter(c => c.path.endsWith('/automatic')).length, 1, 'future server deadline prevents repeat automatic checks');
    assert.ok(updates.calls.filter(c => c.method !== 'GET').every(c => c.path.endsWith('/automatic') || c.path.endsWith('/notifications') && c.body?.action === 'claim'), 'passive runtime cannot install or execute');
    await finish(f, 'notifications ' + width);
}
async function oauthLeave(browser, failure) {
    const f = await fixture(browser, 1440, '#/settings?tab=providers', { base, clock: true, oauth: true }), { page } = f;
    let release, requested;
    const held = new Promise(resolve => { requested = resolve; });
    await page.route('**/media-lab.js', async route => { requested(); await new Promise(resolve => { release = resolve; }); await (failure ? route.abort() : route.continue()); });
    await f.go();
    await page.locator('.settings-model-group summary').click();
    const loginStarted = page.waitForResponse(r => r.url().endsWith('/providers/fixture/login'));
    await page.locator('[data-action="oauth"]').click(); await loginStarted;
    await page.waitForFunction(() => document.getElementById('settings-login-status')?.textContent === PiI18n.t('请完成下面的授权步骤'));
    const firstPoll = page.waitForResponse(r => r.url().endsWith('/settings/login/fixture-login'));
    await page.clock.fastForward(750); await firstPoll;
    await page.evaluate(() => PiWorkspaceRoute.navigate('media')); await held;
    await page.waitForFunction(() => document.getElementById('workspace-settings-editor').classList.contains('hidden') && document.getElementById('workspace-settings-editor-body').childElementCount === 0);
    assert.equal(f.writes.filter(w => w.method === 'DELETE' && w.path.endsWith('/fixture-login')).length, 1, 'OAuth cancelled before target resources finish');
    const polls = f.requests.filter(p => p.endsWith('/settings/login/fixture-login')).length;
    await page.clock.fastForward(5000); await page.waitForTimeout(50);
    assert.equal(f.requests.filter(p => p.endsWith('/settings/login/fixture-login')).length, polls, 'OAuth polling stopped while target is held');
    release();
    if (failure) await page.locator('#workspace-feature-state button').waitFor({ state: 'visible' });
    else await page.locator('#media-tab.active').waitFor();
    assert.equal(f.writes.filter(w => w.method === 'DELETE').length, 1, 'no duplicate cancel on completion or failure');
    assert.ok(f.writes.every(w => w.path.endsWith('/login') && w.method === 'POST' || w.path.endsWith('/fixture-login') && w.method === 'DELETE'));
    await finish(f, 'OAuth leave ' + failure);
}
async function profileLeave(browser) {
    const f = await fixture(browser, 393, `#/profiles?profileId=${profileId}&section=persona`, { base }), { page } = f;
    let release, requested;
    const held = new Promise(resolve => { requested = resolve; });
    await page.route('**/media-lab.js', async route => { requested(); await new Promise(resolve => { release = resolve; }); await route.continue(); });
    await page.route('**/pi-artifacts.css', route => route.abort());
    await f.go(); await page.locator('#pi-profile-form [name="description"]').fill('Dirty profile must survive stale confirmation');
    // Delay the result of a real confirmation, including a real Cancel click.
    await page.evaluate(() => {
        const original = PiProfileDialog; let first = true;
        window.PiProfileDialog = { ...original, confirm(options) {
            const answer = original.confirm(options);
            if (!first) return answer;
            first = false;
            return answer.then(value => new Promise(resolve => { window.releaseOldProfileConfirmation = () => resolve(value); }));
        } };
    });
    await page.evaluate(() => PiWorkspaceRoute.navigate('media')); await held;
    await page.locator('.pi-profile-confirm[open]').waitFor();
    assert.equal(await page.locator('#pi-profile-form [name="description"]').inputValue(), 'Dirty profile must survive stale confirmation');
    await page.keyboard.press('Escape'); await page.waitForFunction(() => typeof releaseOldProfileConfirmation === 'function');
    await page.evaluate(() => PiWorkspaceRoute.navigate('artifacts'));
    await page.locator('.pi-profile-confirm[open]').waitFor();
    await page.locator('.pi-profile-confirm-discard').click();
    await page.locator('#workspace-feature-state button').waitFor({ state: 'visible' });
    await page.evaluate(() => releaseOldProfileConfirmation()); release();
    await page.waitForFunction(() => PiFeatures.ready('media'));
    assert.match(page.url(), /#\/artifacts$/, 'late Cancel cannot take back subsequent navigation');
    assert.equal(await page.locator('#workspace-feature-state button').isVisible(), true, 'failed destination does not revive old route');
    await page.evaluate(() => PiWorkspaceRoute.navigate('chat')); await page.locator('#chat-tab.active').waitFor();
    assert.deepEqual(f.writes, [], 'profile leaving never saves a draft');
    await finish(f, 'profile leave');
}
async function profileCompletion(browser) {
    const f = await fixture(browser, 393, `#/profiles?profileId=${profileId}&section=persona`, { base }), { page } = f;
    let release, requested;
    const held = new Promise(resolve => { requested = resolve; });
    await page.route('**/media-lab.js', async route => { requested(); await new Promise(resolve => { release = resolve; }); await route.continue(); });
    await f.go(); await page.locator('#pi-profile-form [name="description"]').fill('Keep draft when the current leave is cancelled');
    await page.evaluate(() => { PiWorkspaceRoute.navigate('media'); window.leaveRevision = PiWorkspaceRoute.revision(); }); await held;
    await page.locator('.pi-profile-confirm[open]').waitFor(); release();
    await page.waitForFunction(() => PiFeatures.ready('media'));
    assert.equal(await page.evaluate(() => PiWorkspaceRoute.revision() === leaveRevision), true, 'resource completion preserves the navigation revision');
    await page.keyboard.press('Escape'); await page.waitForURL(/#\/profiles/);
    assert.equal(await page.locator('#pi-profile-form [name="description"]').inputValue(), 'Keep draft when the current leave is cancelled');
    await page.evaluate(() => {
        const original = PiProfileDialog; let first = true;
        window.PiProfileDialog = { ...original, confirm(options) {
            const answer = original.confirm(options);
            if (!first) return answer;
            first = false;
            return answer.then(value => new Promise(resolve => { window.releaseOldAcceptedConfirmation = () => resolve(value); }));
        } };
    });
    await page.evaluate(() => PiWorkspaceRoute.navigate('media'));
    await page.locator('.pi-profile-confirm-discard').click(); await page.waitForFunction(() => typeof releaseOldAcceptedConfirmation === 'function');
    await page.evaluate(() => PiWorkspaceRoute.navigate('chat'));
    await page.locator('.pi-profile-confirm[open]').waitFor(); await page.keyboard.press('Escape');
    await page.waitForURL(/#\/profiles/);
    await page.evaluate(async () => { releaseOldAcceptedConfirmation(); await new Promise(requestAnimationFrame); });
    assert.match(page.url(), /#\/profiles/, 'old accepted leave cannot hide the current editor');
    assert.equal(await page.locator('#pi-profile-form [name="description"]').inputValue(), 'Keep draft when the current leave is cancelled', 'old accepted leave cannot discard a retained draft');
    assert.deepEqual(f.writes, []); await finish(f, 'profile completion and late accept');
}
async function messageFocus(browser, width, leave, failure = false) {
    const f = await fixture(browser, width, '#/chat', { base }), { page } = f;
    let release, requested, attempts = 0;
    const held = new Promise(resolve => { requested = resolve; });
    await page.route('**/workspace-network.css', async route => {
        attempts++; requested();
        if (failure) return attempts === 1 ? route.abort() : route.continue();
        await new Promise(resolve => { release = resolve; }); await route.continue();
    });
    await page.addInitScript(() => {
        window.messageScrolls = [];
        const scroll = HTMLElement.prototype.scrollIntoView;
        HTMLElement.prototype.scrollIntoView = function (...args) { if (this.id === 'settings-message-view') messageScrolls.push({ visible: Boolean(this.getClientRects().length), revision: PiWorkspaceRoute.revision() }); return scroll.apply(this, args); };
    });
    await f.go(); await page.waitForFunction(() => document.querySelector('#pi-input')?.disabled === false);
    const open = async () => { await page.locator('#pi-current-thread-menu').click(); await page.getByRole('menuitem', { name: /消息显示…|Message display…/ }).click(); };
    await open(); await held;
    if (failure) {
        const retry = page.locator('#workspace-feature-state[aria-busy="false"]').getByRole('button', { name: /^(?:Retry|重试)$/ });
        await retry.waitFor({ state: 'visible' });
        const revision = await page.evaluate(() => PiWorkspaceRoute.revision());
        if (leave) {
            await retry.evaluate(button => { window.oldSettingsRetry = button; PiWorkspaceRoute.navigate('chat'); });
            const nextRevision = await page.evaluate(() => PiWorkspaceRoute.revision());
            await page.evaluate(() => oldSettingsRetry.click());
            assert.equal(await page.evaluate(() => PiWorkspaceRoute.revision()), nextRevision, 'stale retry cannot change the next navigation revision');
            assert.match(page.url(), /#\/chat$/); assert.equal(attempts, 1, 'stale retry does not load resources');
            await page.evaluate(() => PiWorkspaceRoute.navigate('settings', { tab: 'providers' }));
            await page.locator('[data-settings-panel="providers"]').waitFor({ state: 'visible' });
            assert.deepEqual(await page.evaluate(() => messageScrolls), [], 'failed intent cannot locate on another settings page');
            assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('#pi-transcript-modes'))), false);
            await page.evaluate(() => PiWorkspaceRoute.navigate('chat'));
        } else {
            await retry.click();
            await page.waitForFunction(() => PiFeatures.ready('settings'));
            assert.equal(await page.evaluate(() => PiWorkspaceRoute.revision()), revision, 'explicit retry keeps the same opening intent revision');
        }
        assert.equal(attempts, 2, 'the failed stylesheet is fetched exactly once on recovery');
    } else {
        if (leave) await page.evaluate(() => PiWorkspaceRoute.navigate('chat'));
        release(); await page.waitForFunction(() => PiFeatures.ready('settings'));
    }
    if (leave) {
        assert.match(page.url(), /#\/chat$/);
        assert.deepEqual(await page.evaluate(() => messageScrolls), [], 'abandoned intent cannot scroll a later page');
        assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('#pi-transcript-modes'))), false);
        await open();
    }
    await page.waitForFunction(() => document.activeElement?.matches('#pi-transcript-modes [aria-pressed="true"]'));
    const position = await page.locator('#settings-message-view').evaluate(node => {
        const rect = node.getBoundingClientRect(), panel = node.closest('.workspace-settings-content').getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, panelTop: panel.top, panelBottom: panel.bottom };
    });
    assert.ok(position.top >= position.panelTop - 1 && position.bottom <= position.panelBottom + 1, JSON.stringify(position));
    assert.ok((await page.evaluate(() => messageScrolls)).every(event => event.visible));
    await page.evaluate(() => PiWorkspaceRoute.navigate('chat')); await page.locator('#chat-tab.active').waitFor();
    assert.deepEqual(f.writes, []);
    await finish(f, 'message focus ' + width + '/' + leave + '/failure=' + failure);
}
(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
    try {
        const selected = process.env.PI_STARTUP_REVIEW_CASE;
        if (!selected || selected === 'notifications') for (const width of [1440, 393]) await notifications(browser, width);
        if (!selected || selected === 'oauth') for (const failure of [false, true]) await oauthLeave(browser, failure);
        if (!selected || selected === 'profile') { await profileLeave(browser); await profileCompletion(browser); }
        if (!selected || selected === 'focus') for (const failure of [true, false]) for (const width of [1440, 393]) for (const leave of [false, true]) await messageFocus(browser, width, leave, failure);
        console.log(JSON.stringify({ reviewCases: selected || 'all', realIndex: true, notifications: 'singleton passive runtime', lifecycle: 'pending/failure cleanup and stale confirmation', focus: 'visible intent and revision' }));
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
