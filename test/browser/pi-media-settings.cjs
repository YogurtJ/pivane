// Regression: media settings must be styled before the lazy connection dialog is requested.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { fixture, clean } = require('./pi-startup-loading.cjs');
const base = process.env.PI_MEDIA_SETTINGS_URL || 'http://127.0.0.1:5199';
async function geometry(page) {
    return page.locator('.mc-settings-kinds button').evaluateAll(elements => elements.map(el => {
        const r = el.getBoundingClientRect(), style = getComputedStyle(el);
        return { x: r.x, y: r.y, width: r.width, height: r.height, display: style.display, radius: style.borderRadius };
    }));
}
async function overflow(page) {
    const problems = await page.locator('.settings-media-section, .settings-media-section *, .workspace-settings-content, .workspace-settings-panel.active').evaluateAll(elements => elements.filter(el => el.getClientRects().length && el.scrollWidth > el.clientWidth + 1).map(el => el.id || el.className));
    assert.deepEqual(problems, [], 'media settings have no overflowing children');
}
async function run(browser, width, language) {
    const f = await fixture(browser, width, '#/settings?tab=media', { base }), { page } = f;
    await page.addInitScript(language => localStorage.setItem('pi.workspace.language', language), language);
    const initial = { image: true, video: false, tts: true, revision: 7 };
    let saved = { ...initial };
    const writes = [];
    await page.route('**/api/pi/settings/subagents?*', route => route.fulfill({ json: {
        version: 1, cwd: '/synthetic/startup', revision: 'subagents-1', trust: { effective: true },
        plugin: { status: 'ready', managedBy: 'pivane', name: 'pi-subagents', version: '0.78.0', installedVersions: ['0.78.0'] },
        defaults: { global: {}, project: {} },
        roles: ['delegate', 'researcher', 'reviewer'].map(name => ({ name, global: {}, project: {} }))
    } }));
    await page.route('**/api/pi/settings/media-chat-execution', route => {
        const request = route.request();
        if (request.method() === 'PUT') {
            const { expectedRevision, ...patch } = request.postDataJSON();
            assert.equal(expectedRevision, saved.revision);
            writes.push(patch); saved = { ...saved, ...patch, revision: saved.revision + 1 };
        }
        return route.fulfill({ json: saved });
    });
    try {
        await f.go();
        await page.locator('[data-settings-panel="media"].active').waitFor({ state: 'visible' });
        await page.locator('#settings-subagents form').waitFor({ state: 'visible' });
        assert.equal(f.requests.includes('/media-connections.css'), false, 'dialog styles remain lazy');
        assert.equal(f.requests.includes('/media-connections.js'), false, 'dialog scripts remain lazy');
        // Let the shell's sidebar width transition and local fonts settle before comparing exact pixels.
        await page.evaluate(async () => {
            await document.fonts.ready;
            await Promise.all(document.getAnimations().filter(animation => Number.isFinite(animation.effect.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {})));
        });
        const before = await geometry(page);
        assert.equal(before.length, 3);
        for (const item of before) { assert.equal(item.display, 'grid'); assert.ok(parseFloat(item.radius) >= 10); assert.ok(item.height >= 76); }
        if (width > 680) assert.ok(before.every(item => Math.abs(item.y - before[0].y) <= 1), 'desktop cards align');
        else assert.ok(before[1].y >= before[0].y + before[0].height && before[2].y >= before[1].y + before[1].height, 'phone cards stack');
        const region = page.locator('#settings-media-chat-execution');
        assert.equal(await region.getAttribute('aria-describedby'), 'settings-media-chat-execution-description');
        assert.equal(await region.getByRole('switch').count(), 3);
        for (const kind of ['image', 'video', 'tts']) assert.equal(await page.locator('#settings-media-auto-' + kind).isChecked(), initial[kind]);
        if (language === 'en') {
            assert.equal(await page.locator('#settings-multimodal-title').textContent(), 'Media services');
            assert.equal(await page.locator('#settings-media-chat-execution-title').textContent(), 'Auto-generate in chat');
            assert.equal(/[\u4e00-\u9fff]/.test(await page.locator('.settings-media-section').textContent()), false, 'media section is translated');
        }
        for (const theme of ['mint', 'dark']) {
            await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
            await overflow(page);
            if (process.env.PIVANE_TEST_SCREENSHOT_DIR) {
                fs.mkdirSync(process.env.PIVANE_TEST_SCREENSHOT_DIR, { recursive: true });
                await page.screenshot({ path: path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR, `media-settings-${width}-${language}-${theme}.png`) });
            }
        }
        // Keyboard operation persists the setting; loading and navigation never generate media.
        await page.locator('#settings-media-auto-video').focus(); await page.keyboard.press('Space');
        await page.waitForFunction(() => document.getElementById('settings-media-chat-execution-status').textContent.includes('saved') || document.getElementById('settings-media-chat-execution-status').textContent.includes('已保存'));
        assert.deepEqual(writes, [{ video: true }]);
        for (const kind of ['image', 'video', 'tts']) {
            await page.locator(`[data-media-settings-kind="${kind}"]`).click();
            const dialog = page.locator('#lab-connections-dialog');
            await dialog.locator('.mc-provider-list').waitFor({ state: 'attached' });
            assert.equal(await dialog.evaluate(el => el.matches(':modal')), true);
            assert.equal(await page.locator('#mc-speech-tabs').isVisible(), kind === 'tts');
            if (kind === 'tts') {
                await page.locator('#mc-asr-tab').click();
                await page.locator('#settings-transcription-model').waitFor({ state: 'visible' });
            }
            await page.locator('#mc-close').click(); await dialog.waitFor({ state: 'hidden' });
        }
        // Scroll and focus may move the cards; their shape must never depend on opening a dialog.
        assert.deepEqual((await geometry(page)).map(({ y, ...shape }) => shape), before.map(({ y, ...shape }) => shape));
        await overflow(page);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('[data-settings-panel="media"].active').waitFor({ state: 'visible' });
        await page.waitForFunction(() => document.getElementById('settings-media-auto-video').checked);
        assert.deepEqual(writes, [{ video: true }], 'reload reads saved state without writes');
        await clean(f, `${width} ${language}`);
        console.log(`PASS media settings ${width} ${language}: cold styles, dialogs, switches, reload, no overflow or pageerror`);
    } catch (error) { await f.context.close(); throw error; }
}
(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
    try { for (const width of [320, 393, 768, 1440, 1920]) for (const language of ['zh-CN', 'en']) await run(browser, width, language); }
    finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
