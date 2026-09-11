const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.PI_MOBILE_TEST_URL || 'http://127.0.0.1:3001';
const cwd = '/srv/pi-mobile-viewport-fixture';
const session = { id: 'mobile-viewport', cwd, name: 'Mobile viewport fixture', messageCount: 30 };
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture model', input: ['text', 'image'] };
const fields = 'input:not([type="hidden"]):not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="button"]):not([type="submit"]):not([type="reset"]),textarea,select,[contenteditable="true"],[contenteditable=""]';

async function run(browser, size, mobile) {
    const context = await browser.newContext({ viewport: size, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage();
    const errors = []; const writes = []; let socket;
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ cwd, id }) => {
        localStorage.setItem('pi.web.cwd', cwd);
        localStorage.setItem(`pi.web.session:${cwd}`, id);
    }, { cwd, id: session.id });
    await page.route('**/api/**', async route => {
        const req = route.request(); const url = new URL(req.url());
        if (req.method() !== 'GET') { writes.push(url.pathname); return route.fulfill({ json: { ok: true } }); }
        if (url.pathname === '/api/pi/status') return route.fulfill({ json: { ok: true, projectRoots: ['/srv'] } });
        if (url.pathname === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd, name: 'Viewport fixture', sessionCount: 1 }], roots: ['/srv'] } });
        if (url.pathname === '/api/pi/sessions') return route.fulfill({ json: { sessions: [session] } });
        if (url.pathname === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] } });
        if (url.pathname === '/api/pi/settings/models') return route.fulfill({ json: { providers: [], models: [], preferences: {}, customProviders: [] } });
        if (url.pathname === '/api/pi/media/lab') return route.fulfill({ json: { models: ['image', 'video', 'tts'].map(kind => ({ id: kind, name: kind, kind, adapter: 'manual', configured: false, parameters: { [kind === 'tts' ? 'text' : 'prompt']: { type: 'textarea', label: '内容' } } })) } });
        if (url.pathname === '/api/pi/media/lab/history') return route.fulfill({ json: url.searchParams.get('kind') === 'image' ? [{ id: 1, kind: 'image', url: '/images/mobile-viewport-fixture.png', prompt: 'Viewport image fixture', model: 'image', width: 1, height: 1 }] : [] });
        if (url.pathname.startsWith('/api/pi/')) return route.fulfill({ json: {} });
        if (url.pathname === '/api/history') return route.fulfill({ json: [{ id: 1, imageUrl: '/images/mobile-viewport-fixture.png', prompt: 'Viewport image fixture', model: 'fixture', width: 1, height: 1 }] });
        if (url.pathname.includes('history') || url.pathname === '/api/prompts') return route.fulfill({ json: [] });
        if (url.pathname.includes('/health')) return route.fulfill({ json: { ok: false, configured: false } });
        await route.continue();
    });
    await page.route('**/images/mobile-viewport-fixture.png', route => route.fulfill({
        contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64')
    }));
    await page.routeWebSocket('**/api/pi/ws', ws => {
        socket = ws;
        ws.onMessage(raw => {
            const command = JSON.parse(raw);
            assert.equal(command.type, 'open_session');
            ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true,
                data: { session, state: { model, isStreaming: false }, messages: { messages: Array.from({ length: 30 }, (_, i) => ({ role: 'assistant', content: [{ type: 'text', text: `Message ${i}\n\n${'Touch scrolling remains available. '.repeat(15)}` }] })) },
                    stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] }, pendingUi: [] } }));
        });
    });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.getElementById('pi-input').disabled);
    const cdp = await context.newCDPSession(page);
    const scale = () => page.evaluate(() => visualViewport.scale);
    const pinch = async () => {
        const center = size.width / 2;
        const y = size.height / 2;
        const points = distance => [{ x: center - distance, y, id: 1 }, { x: center + distance, y, id: 2 }];
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(35) });
        for (let i = 1; i <= 12; i++) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(35 + i * 7) });
            await page.waitForTimeout(20);
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const overflow = () => page.evaluate(() => Math.max(document.body.scrollWidth - document.body.clientWidth, document.documentElement.scrollWidth - innerWidth));
    if (mobile) {
        await pinch(); await page.waitForTimeout(250);
        assert.ok(Math.abs(await scale() - 1) < 0.02, 'app pinch must not enlarge the page');
        // Positive control: the same physical gesture can zoom when touch-action allows it.
        await page.evaluate(() => document.documentElement.style.touchAction = 'auto');
        await pinch(); await page.waitForTimeout(250);
        assert.ok(await scale() > 1.3, 'pinch test must actually exercise browser page zoom');
        assert.equal(await page.evaluate(() => document.documentElement.classList.contains('workspace-browser-zoomed')), true);
        assert.equal(await page.evaluate(() => document.dispatchEvent(new Event('gesturestart', { cancelable: true }))), true, 'already zoomed pages must be able to zoom back out');
        await page.evaluate(() => document.documentElement.style.removeProperty('touch-action'));
        await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
        await page.waitForTimeout(100);
        assert.equal(await page.evaluate(() => document.dispatchEvent(new Event('gesturestart', { cancelable: true }))), false);
        assert.equal(await page.evaluate(() => document.dispatchEvent(new Event('gesturechange', { cancelable: true }))), false);
        await page.evaluate(() => document.dispatchEvent(new Event('gestureend')));
        await page.touchscreen.tap(size.width / 2, 20); await page.touchscreen.tap(size.width / 2, 20);
        assert.ok(Math.abs(await scale() - 1) < 0.02, 'double tap must not zoom the shell');
        const transcript = page.locator('#pi-transcript');
        const box = await transcript.boundingBox();
        const before = await transcript.evaluate(el => el.scrollTop);
        const point = { x: box.x + box.width / 2, y: box.y + 50 };
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
        for (let i = 1; i <= 8; i++) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y + i * 20 }] });
            await page.waitForTimeout(20);
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(250);
        assert.ok(await transcript.evaluate(el => el.scrollTop) < before - 30, 'single-finger transcript scroll remains usable');
    } else {
        assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).touchAction), 'auto');
        assert.equal(await page.evaluate(() => document.dispatchEvent(new Event('gesturestart', { cancelable: true }))), true);
        assert.ok(!/user-scalable\s*=\s*no|maximum-scale/.test(await page.locator('meta[name="viewport"]').getAttribute('content')));
    }
    const measurements = [];
    for (const tab of ['chat', 'image', 'video', 'tts']) {
        await page.locator(`.nav-btn[data-tab="${tab === 'chat' ? 'chat' : 'media'}"]`).click();
        if (tab !== 'chat') await page.locator(`[data-lab-kind="${tab}"]`).click();
        const input = page.locator(tab === 'chat' ? '#pi-input' : '#lab-parameters textarea');
        await input.focus();
        const fontSize = await input.evaluate(el => parseFloat(getComputedStyle(el).fontSize));
        if (mobile) assert.ok(fontSize >= 16, `${tab} must avoid iOS focus zoom`);
        assert.equal(await overflow(), 0, `${tab} overflow`);
        assert.ok(Math.abs(await scale() - 1) < 0.02);
        await input.blur();
        await page.screenshot({ path: `/tmp/pi-mobile-viewport-${size.width}-${tab}.png` });
        measurements.push({ tab, fontSize });
        if (tab === 'image') {
            await page.locator('#lab-history .lab-asset').first().click();
            const original = page.getByRole('link', { name: '新标签查看原文件' });
            assert.equal(await original.getAttribute('target'), '_blank');
            assert.ok((await original.getAttribute('href')).endsWith('/images/mobile-viewport-fixture.png'));
            await page.waitForFunction(() => document.querySelector('#lab-preview img').naturalWidth > 0);
            await page.getByRole('button', { name: '关闭预览', exact: true }).click();
        }
    }
    await page.locator('#workspace-settings-toggle').click();
    await page.locator('#settings-provider-search').focus();
    await page.locator('#settings-add-provider').click();
    await page.locator('#workspace-settings-editor').waitFor();
    if (mobile) {
        const small = await page.locator(fields).evaluateAll(elements => elements.filter(el => parseFloat(getComputedStyle(el).fontSize) < 16).map(el => el.id || el.name || el.tagName));
        assert.deepEqual(small, [], 'all form controls, including dynamic settings fields, must be at least 16px');
    }
    assert.equal(await overflow(), 0);
    await page.screenshot({ path: `/tmp/pi-mobile-viewport-${size.width}-settings.png` });
    await page.locator('#workspace-settings-editor-close').click();
    await page.locator('#workspace-settings-close').click();
    await page.locator('.nav-btn[data-tab="chat"]').click();
    socket.send(JSON.stringify({ type: 'extension_ui_request', id: 'input-fixture', method: 'input', title: 'Viewport input fixture', placeholder: 'Test value' }));
    await page.locator('#pi-request-dialog[open]').waitFor();
    if (mobile) assert.ok(await page.locator('#pi-request-fields input').evaluate(el => parseFloat(getComputedStyle(el).fontSize)) >= 16);
    await page.locator('#pi-request-later').click();
    if (mobile) {
        await page.setViewportSize({ width: 852, height: 393 });
        assert.equal(await overflow(), 0, 'rotation must not widen the document');
        assert.ok(await page.locator('#pi-input').evaluate(el => parseFloat(getComputedStyle(el).fontSize)) >= 16);
    }
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    console.log(JSON.stringify({ size, mobile, measurements, pageScale: await scale(), errors, writes }));
    await context.close();
}
(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
    try {
        await run(browser, { width: 393, height: 852 }, true);
        await run(browser, { width: 412, height: 915 }, true);
        await run(browser, { width: 1440, height: 1000 }, false);
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
