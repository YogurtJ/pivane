const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { fixture, clean } = require('./pi-startup-loading.cjs');
const base = process.env.PI_SETTINGS_LOADING_URL || 'http://127.0.0.1:3001';
const tabs = ['providers', 'media', 'models', 'system-prompts', 'native', 'access', 'usage', 'updates'];
async function screenshot(page, name) {
    if (!process.env.PIVANE_TEST_SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.PIVANE_TEST_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR, name + '.png'), animations: 'disabled' });
}
async function main() {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
    try {
        const cases = [1440, 393].flatMap(width => tabs.map(tab => ({ width, tab })));
        cases.push(...[1920, 768, 320].map(width => ({ width, tab: 'media' })));
        for (const { width, tab } of cases) {
            const direct = width === 1920;
            const f = await fixture(browser, width, direct ? '#/settings?tab=media' : '#/chat', { base }), { page } = f;
            let release;
            if (!direct) {
                await f.go();
                await page.waitForFunction(() => !document.documentElement.classList.contains('pv-booting') && !document.documentElement.classList.contains('pv-boot-leaving'));
                await page.locator('#pi-input').fill('Draft during settings loading');
            }
            // A deferred stylesheet holds the settings group without blocking the eager shell.
            await page.route('**/pi-channels.css', async route => { await new Promise(resolve => { release = resolve; }); await route.continue(); });
            if (direct) await f.go();
            else await page.evaluate(tab => PiWorkspaceRoute.navigate('settings', { tab }), tab);
            const loading = page.locator('.workspace-feature-settings');
            await loading.waitFor({ state: 'visible' });
            assert.equal(await loading.getAttribute('data-loading-tab'), tab);
            assert.equal(await page.locator('.workspace-feature-card').count(), 0, 'settings never uses the floating loading card');
            assert.equal(await page.locator('#workspace-feature-state').getAttribute('aria-busy'), 'true');
            const geometry = await page.evaluate(() => {
                const root = document.querySelector('.workspace-feature-settings'), content = root.querySelector('.workspace-feature-settings-content');
                const selectors = ['.workspace-feature-settings', '.workspace-feature-settings-body', '.workspace-feature-settings-content', '.workspace-feature-settings-panel', '.workspace-settings-placeholder', '.workspace-settings-placeholder-section', '.pv-skel-card'];
                return { width: root.getBoundingClientRect().width, available: document.querySelector('#workspace-feature-state').clientWidth, panelWidth: content.clientWidth,
                    columns: getComputedStyle(root.querySelector('.workspace-feature-settings-body')).gridTemplateColumns.split(' ').length,
                    overflow: selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(n => n.scrollWidth > n.clientWidth + 1).map(() => selector)),
                    controls: [...root.querySelectorAll('button')].map(n => n.getAttribute('aria-label')) };
            });
            assert.ok(Math.abs(geometry.width - geometry.available) < 2, 'settings skeleton uses the available page width');
            assert.equal(geometry.columns, width > 900 ? 2 : 1);
            assert.deepEqual(geometry.overflow, [], `${width} ${tab}: internal overflow`);
            assert.equal(geometry.controls.length, 1, 'only the real return action is interactive; skeletons are decorative');
            await page.emulateMedia({ reducedMotion: 'reduce' });
            assert.equal(await loading.locator('.pi-spinner').evaluate(n => getComputedStyle(n).animationName), 'none');
            if (['media', 'providers', 'models', 'usage'].includes(tab)) {
                await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'mint'));
                await screenshot(page, `${tab}-loading-${width}-mint`);
                await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
                if (tab === 'media') await screenshot(page, `${tab}-loading-${width}-dark`);
            }
            if (tab === 'media' && width === 393) {
                // The return button works while assets remain pending and preserves the draft.
                await loading.getByRole('button').click();
                assert.equal(await page.locator('#pi-input').inputValue(), 'Draft during settings loading');
                assert.equal(await page.locator('#chat-tab').isVisible(), true);
                release(); await page.waitForFunction(() => PiFeatures.ready('settings'));
                assert.equal(await page.locator('#chat-tab').isVisible(), true, 'late settings assets cannot steal the route');
            } else {
                release();
                await page.locator(`[data-settings-panel="${tab}"].active`).waitFor({ state: 'visible' });
                assert.equal(await page.locator('#workspace-feature-state').isVisible(), false);
            }
            await clean(f, `${width} ${tab}`);
        }
        // A failed resource keeps the explicit retry action; retry returns to the settings skeleton.
        const f = await fixture(browser, 393, '#/chat', { base }), { page } = f;
        await f.go(); let attempts = 0, releaseRetry;
        await page.route('**/pi-channels.css', async route => {
            if (++attempts === 1) return route.abort();
            await new Promise(resolve => { releaseRetry = resolve; }); await route.continue();
        });
        await page.evaluate(() => PiWorkspaceRoute.navigate('settings', { tab: 'media' }));
        await page.locator('#workspace-feature-state .workspace-feature-card button').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#workspace-feature-state').getAttribute('aria-busy'), 'false');
        await page.locator('#workspace-feature-state .workspace-feature-card button').click();
        await page.locator('.workspace-feature-settings[data-loading-tab="media"]').waitFor({ state: 'visible' });
        await page.waitForFunction(() => !PiFeatures.ready('settings'));
        // Switching between settings and extensions while the same group is pending updates the placeholder.
        await page.evaluate(() => PiWorkspaceRoute.navigate('extensions'));
        await page.locator('.workspace-feature-page').waitFor({ state: 'visible' });
        await page.evaluate(() => PiWorkspaceRoute.navigate('settings', { tab: 'models' }));
        await page.locator('.workspace-feature-settings[data-loading-tab="models"]').waitFor({ state: 'visible' });
        assert.equal(typeof releaseRetry, 'function'); releaseRetry();
        await page.locator('[data-settings-panel="models"].active').waitFor({ state: 'visible' });
        assert.equal(attempts, 2);
        assert.equal(f.requests.filter(url => url.endsWith('/settings.js')).length, 1);
        await clean(f, 'retry and route changes');
        console.log(`Settings loading: ${cases.length} viewport/tab cases, direct URL, reduced motion, drafts, return, retry and late-route protection passed`);
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
