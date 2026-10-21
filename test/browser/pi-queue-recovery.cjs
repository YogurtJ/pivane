const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.PI_QUEUE_TEST_URL || 'http://127.0.0.1:3106';
async function run(browser, viewport) {
    const context = await browser.newContext({ viewport, locale: 'zh-CN', isMobile: viewport.width < 900, hasTouch: viewport.width < 900 });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.route('**/queue-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html data-theme="daylight"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/workspace.css"><link rel="stylesheet" href="/pi-native-controls.css"><link rel="stylesheet" href="/pi-composer-chips.css"></head><body style="margin:0;padding:16px;max-width:100%"><div id="pi-composer-chips" class="pi-composer-chips">
        <details class="pi-status-chip"><summary><strong>子 Agent</strong> 2</summary><div>Subagent details</div></details>
        <details class="pi-status-chip"><summary><strong>任务结果</strong> 1</summary><div>Task results</div></details>
        <details class="pi-status-chip"><summary><strong>当前进度</strong> 2/4</summary><div>Task progress</div></details>
        <div id="pi-queue" class="pi-queue-chip pi-status-chip" hidden></div>
        <div class="pi-deferred-chip pi-status-chip"><button type="button"><strong>1 条待发送</strong></button></div>
        </div><textarea id="pi-input" aria-label="草稿"></textarea><details id="pi-extension-state"><summary></summary><div id="pi-extension-body"></div></details><script src="/pi-composer-chips.js"></script><script src="/pi-runtime-controls.js"></script></body></html>` }));
    await page.goto(baseUrl + '/queue-fixture');
    await page.evaluate(() => {
        window.PiActionFeedback = { begin: () => () => {} };
        window.calls = []; window.drafts = []; window.rejectAck = true; window.holdRead = false;
        window.payload = { message: 'Recovered <img src=x> with document marker', images: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }] };
        window.makeValue = (runtimeId, id = 'recovery') => ({ runtimeId, revision: 1, durable: true, intentions: [], stopping: false,
            queue: { steering: [], followUp: [] }, recoveries: [{ id, status: 'recovered', state: 'recovered', durable: true, hasPayload: true,
                imageCount: 1, steering: [window.payload.message], followUp: [] }], extension: { title: '', statuses: [], widgets: [] } });
        window.controls = new PiRuntimeControls({ connected: () => true, changed: () => {}, toast: () => {}, copy: async () => {},
            readRecovery: async (id, input) => {
                window.calls.push({ method: 'read', id, input });
                if (window.holdRead) return new Promise(resolve => { window.releaseRead = () => resolve({ payload: window.payload }); });
                return { payload: window.payload };
            },
            appendRecovery: async payload => { window.drafts.push(structuredClone(payload)); },
            ack: async (id, input) => {
                window.calls.push({ method: 'ack', id, input });
                if (window.rejectAck) throw new Error('Controlled disk failure');
                return { ...window.controls.value, revision: window.controls.value.revision + 1, recoveries: [] };
            } });
        window.controls.apply(window.makeValue('runtime-a'));
    });
    await page.locator('#pi-composer-chips details').first().locator('summary').click();
    await page.waitForFunction(() => document.querySelector('#pi-composer-chips details').open);
    await page.locator('#pi-queue-open').click();
    assert.equal(await page.locator('#pi-composer-chips details[open]').count(), 0, 'queue dialog dismisses other chip popovers');
    assert.equal(await page.locator('.pi-queue-help').getAttribute('open'), null, 'explanations are collapsed');
    assert.equal(await page.locator('.pi-queue-help p').first().isVisible(), false);
    await page.locator('.pi-queue-help summary').click();
    assert.match(await page.locator('#pi-queue-dialog').textContent(), /服务重建后保留/);
    assert.match(await page.locator('#pi-queue-dialog').textContent(), /已保留 1 张图片/);
    assert.equal(await page.locator('#pi-queue-dialog img').count(), 0);
    assert.equal((await page.locator('#pi-queue-dialog').textContent()).includes('aGVsbG8='), false);
    await page.locator('[data-recovery-append]').click();
    await page.waitForFunction(() => document.querySelector('[data-recovery-append]').textContent.includes('本页已追加'));
    assert.equal(await page.evaluate(() => window.drafts.length), 1);
    assert.equal(await page.locator('.pi-queue-help').getAttribute('open'), '', 'live rerender retains help disclosure');
    assert.deepEqual(await page.evaluate(() => window.drafts[0].images), [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }]);
    await page.evaluate(() => { window.controls.apply(window.makeValue('runtime-rebuilt')); window.rejectAck = false; });
    await page.locator('[data-recovery-append]').click();
    await page.waitForFunction(() => !document.querySelector('[data-recovery-append]'));
    assert.equal(await page.evaluate(() => window.drafts.length), 1, 'same durable ID across worker reconstruction must not append twice on this page');
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.method === 'read').length), 1, 'ack retry does not read/append again');
    // A payload reply from a previous thread is discarded before host append.
    await page.evaluate(() => { window.controls.apply(window.makeValue('runtime-b', 'late')); window.holdRead = true; });
    await page.locator('[data-recovery-append]').click();
    await page.waitForFunction(() => Boolean(window.releaseRead));
    await page.evaluate(() => { window.controls.reset(); window.controls.apply({ ...window.makeValue('runtime-c'), recoveries: [] }); window.releaseRead(); });
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(() => window.drafts.length), 1);
    assert.equal(await page.evaluate(() => window.calls.some(call => call.method === 'ack' && call.id === 'late')), false);
    // Explicit unknown recovery asks for confirmation and passes the complete payload.
    await page.evaluate(() => {
        window.holdRead = false;
        const value = window.makeValue('runtime-d', 'unknown'); value.recoveries[0].status = 'uncertain'; value.recoveries[0].state = 'unknown';
        value.recoveries[0].originalOnly = true; value.recoveries[0].effectiveComplete = false; value.recoveries[0].transformed = false;
        window.controls.apply(value);
    });
    await page.locator('#pi-queue-open').click();
    assert.equal(await page.locator('.pi-recovery-card .is-warning').first().isVisible(), true, 'uncertain status is never hidden in help');
    assert.equal(await page.locator('#pi-queue').getAttribute('data-tone'), 'attention');
    assert.match(await page.locator('#pi-queue-dialog').textContent(), /仅保留发送前的原始文字和图片/);
    assert.match(await page.locator('#pi-queue-dialog').textContent(), /变换后的内容未完整保存/);
    await page.locator('[data-recovery-append]').click();
    await page.waitForFunction(() => window.drafts.length === 2);
    // Legacy backend remains honestly text-only; image callbacks are optional.
    await page.evaluate(() => {
        delete window.controls.options.readRecovery; delete window.controls.options.appendRecovery;
        window.controls.options.append = text => window.drafts.push({ message: text, images: [] });
        const value = window.makeValue('legacy', 'legacy'); value.durable = false; value.recoveries[0] = { id: 'legacy', status: 'recovered', steering: ['old text'], followUp: [] };
        window.controls.apply(value);
    });
    await page.locator('[data-recovery-append]').click();
    await page.waitForFunction(() => window.drafts.length === 3);
    assert.equal(await page.evaluate(() => window.drafts[2].message), 'old text');
    await page.locator('#pi-queue-dialog .pi-native-heading button').click();
    await page.evaluate(() => {
        window.controls.reset();
        window.controls.renderLegacyQueue(['Steering <img src=x> ' + 'long-message-'.repeat(60)], ['Follow-up 中文']);
    });
    await page.locator('#pi-queue-open').click();
    assert.equal(await page.locator('.pi-queued-message').count(), 2);
    assert.equal(await page.locator('#pi-queue-take').count(), 0, 'legacy queue without runtime controls is read-only');
    assert.equal(await page.locator('#pi-queue-dialog img').count(), 0);
    const overflowing = await page.locator('#pi-queue-dialog, .pi-native-body, .pi-recovery-card, .pi-recovery-actions').evaluateAll(nodes => nodes.filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.className));
    assert.deepEqual(overflowing, [], 'dialog content stays within its own width');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#pi-queue-dialog').open);
    assert.equal(await page.locator('#pi-queue-open').evaluate(node => document.activeElement === node), true);
    const chipBounds = await page.locator('#pi-composer-chips > .pi-status-chip').evaluateAll(nodes => nodes.map(node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, overflow: node.scrollWidth > node.clientWidth + 1 }; }));
    assert.ok(chipBounds.every(rect => rect.left >= 0 && rect.right <= viewport.width && !rect.overflow), 'all five chips remain reachable without horizontal overflow');
    await page.evaluate(() => window.controls.renderLegacyQueue([], []));
    assert.equal(await page.locator('#pi-queue').isVisible(), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.deepEqual(errors, []);
    console.log(`PASS ${viewport.width}: complete payload, safe text, ack failure/rebuild, late payload rejection, explicit unknown and legacy recovery`);
    await context.close();
}
(async () => {
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'], headless: true });
    try { for (const viewport of [{ width: 1440, height: 1000 }, { width: 393, height: 852 }, { width: 320, height: 740 }]) await run(browser, viewport); }
    finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
