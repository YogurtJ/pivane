const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.PI_ATTACHMENTS_TEST_URL;
assert.ok(baseUrl && /^http:\/\//.test(baseUrl), 'PI_ATTACHMENTS_TEST_URL must explicitly select an isolated HTTP test origin');
const cwd = '/srv/attachment-browser-fixture';
let png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5V8AAAAASUVORK5CYII=';
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text', 'image'], contextWindow: 128000 };
const sessions = ['a', 'b'].map(id => ({ id, cwd, name: `Attachment ${id}`, messageCount: 0 }));
async function run(browser, viewport) {
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 900, hasTouch: viewport.width < 900 });
    const page = await context.newPage();
    const errors = [], writes = [], prompts = [];
    let mode = 'accept', held, active = sessions[0];
    const stats = { contextUsage: { tokens: 0, percent: 0, contextWindow: 128000 }, totalMessages: 0 };
    const reply = (ws, command, data) => ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
    const reject = (ws, command, error) => ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: false, error }));
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ cwd }) => {
        localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'a');
        Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
        const original = Blob.prototype.arrayBuffer;
        Blob.prototype.arrayBuffer = async function () {
            if (this.name === 'slow.txt') await new Promise(resolve => { window.releaseAttachmentRead = resolve; });
            if (this.name === 'broken.txt') throw new Error('fixture read failure');
            return original.call(this);
        };
    }, { cwd });
    await page.route('**/api/**', route => {
        const request = route.request(), endpoint = new URL(request.url()).pathname;
        const send = json => route.fulfill({ json });
        if (request.method() !== 'GET') { writes.push(endpoint); return route.fulfill({ status: 400, json: { error: 'Unexpected write' } }); }
        if (endpoint === '/api/pi/status') return send({ ok: true, version: '0.85.0', sessionWorkflows: true, projectRoots: ['/srv'] });
        if (endpoint === '/api/pi/projects') return send({ projects: [{ cwd, name: 'Attachment fixture', sessionCount: 2 }], roots: ['/srv'] });
        if (endpoint === '/api/pi/sessions') return send({ sessions });
        if (endpoint === '/api/pi/activity') return send({ runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] });
        if (endpoint.endsWith('/deferred')) return send({ jobs: [] });
        if (endpoint.endsWith('/workflow')) return send({ leafId: 'leaf', prompts: [], versions: [] });
        if (endpoint.includes('history') || endpoint === '/api/prompts') return send([]);
        return send({ configured: false });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        ws.onMessage(raw => {
            const command = JSON.parse(raw);
            const state = { model, thinkingLevel: 'off', isStreaming: false, isCompacting: false };
            if (command.type === 'open_session') {
                active = sessions.find(session => session.id === command.sessionId);
                return reply(ws, command, { session: active, state, messages: { messages: [] }, stats, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } });
            }
            if (command.type === 'get_state') return reply(ws, command, state);
            if (command.type === 'get_messages') return reply(ws, command, { messages: [] });
            if (command.type === 'get_session_stats') return reply(ws, command, stats);
            if (['prompt', 'steer', 'follow_up'].includes(command.type)) {
                prompts.push({ ...command, sessionId: active.id });
                if (mode === 'hold') { held = () => reply(ws, command, {}); return; }
                if (mode === 'reject') return reject(ws, command, 'fixture: rejected');
                if (mode === 'timeout') return reject(ws, command, 'Pi RPC command timed out: prompt');
                if (mode === 'disconnect') return ws.close({ code: 1011, reason: 'fixture disconnect' });
                return reply(ws, command, {});
            }
            throw new Error(`Unexpected RPC ${command.type}`);
        });
    });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.querySelector('#pi-input').disabled);
    assert.equal(await page.evaluate(() => typeof crypto.randomUUID), 'undefined');
    if (!['localhost', '127.0.0.1'].includes(new URL(baseUrl).hostname)) assert.equal(await page.evaluate(() => isSecureContext), false);
    png = await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#edf4f0'; ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = '#167568'; ctx.fillRect(24, 24, 282, 210);
        ctx.fillStyle = '#447eae'; ctx.fillRect(330, 24, 286, 96);
        ctx.fillStyle = '#e3ab49'; ctx.fillRect(330, 138, 286, 96);
        ctx.fillStyle = '#18332d'; ctx.font = '26px sans-serif'; ctx.fillText('Mac attachment preview', 24, 288);
        ctx.font = '18px sans-serif'; ctx.fillText('640 x 360 / PNG', 24, 325);
        return canvas.toDataURL('image/png').split(',')[1];
    });
    const input = page.locator('#pi-input');
    const chips = page.locator('#pi-attachments .pi-attachment-chip');
    const count = async n => page.waitForFunction(n => document.querySelectorAll('#pi-attachments .pi-attachment-chip').length === n && document.querySelector('#pi-attachments').getAttribute('aria-busy') === 'false', n);
    const select = files => page.locator('#pi-file-input').setInputFiles(files);
    const textFile = (name, text = 'hello') => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
    const imageFile = { name: 'mac-image.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') };
    const clear = async () => { while (await chips.count()) await page.locator('[data-remove-attachment]').first().click(); };
    const transfer = async (kind, target, files) => page.evaluate(({ kind, target, files }) => {
        const data = new DataTransfer();
        for (const file of files) data.items.add(new File([file.image ? Uint8Array.from(atob(file.image), char => char.charCodeAt(0)) : file.text], file.name, { type: file.type }));
        const event = kind === 'paste' ? new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }) : new DragEvent(kind, { dataTransfer: data, bubbles: true, cancelable: true });
        document.querySelector(target).dispatchEvent(event); return event.defaultPrevented;
    }, { kind, target, files });
    const changeSession = async id => {
        if (viewport.width < 900 && !await page.locator('#pi-session-pane').evaluate(node => node.classList.contains('open'))) await page.locator('#pi-toggle-sessions').click();
        await page.locator('[data-filter="all"]').click();
        await page.locator(`[data-session-id="${id}"] .pi-session-main`).click();
        await page.waitForFunction(id => !document.querySelector('#pi-input').disabled && document.querySelector('#pi-meta-id').textContent === id, id);
    };
    await input.fill('Mac draft');
    await select([imageFile, textFile('a"<script>.txt', '<script>window.bad = true</script>')]); await count(2);
    assert.equal(await page.locator('#pi-attachments img').evaluate(image => image.complete && image.naturalWidth > 0), true);
    await page.locator('[data-preview-attachment]').last().click();
    assert.match(await page.locator('#pi-attachment-preview-content').textContent(), /<script>/);
    assert.equal(await page.evaluate(() => window.bad), undefined);
    await page.locator('#pi-attachment-preview-close').click();
    await page.locator('[data-preview-attachment]').first().click();
    await page.waitForFunction(() => document.querySelector('#pi-attachment-preview-content img')?.naturalWidth > 0);
    const popupPromise = page.waitForEvent('popup'); await page.locator('#pi-attachment-original').click();
    const popup = await popupPromise; await popup.waitForLoadState();
    assert.equal(await popup.locator('img').evaluate(image => image.naturalWidth > 0), true); await popup.close();
    assert.equal(await page.locator('#pi-attachment-preview').evaluate(node => node.scrollWidth > node.clientWidth + 1), false);
    await page.screenshot({ path: `/tmp/pi-attachments-${viewport.width}-preview.png` });
    await page.locator('#pi-attachment-preview-close').click();
    await clear();
    assert.equal(await transfer('paste', '#pi-input', [{ name: 'clipboard.png', type: 'image/png', image: png }]), true); await count(1);
    assert.equal(await transfer('drop', '.pi-composer-wrap', [{ name: 'finder.txt', type: '', text: 'from Finder' }]), true); await count(2);
    assert.equal(await input.inputValue(), 'Mac draft');
    assert.equal(await page.evaluate(() => {
        const data = new DataTransfer(); data.setData('text/plain', 'filename-only.txt');
        const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
        document.querySelector('#pi-input').dispatchEvent(event); return event.defaultPrevented;
    }), false, 'ordinary text and filename-only paste keep browser behavior');
    assert.equal(await transfer('drop', '#pi-transcript', [{ name: 'outside.txt', text: 'outside' }]), true);
    await count(2); await clear();
    await select([textFile('bad.pdf'), textFile('bad.heic'), textFile('binary.txt', '\0binary'), textFile('broken.txt'), textFile('good.txt')]); await count(1);
    assert.match(await chips.textContent(), /good.txt/); await clear();
    await select(Array.from({ length: 7 }, (_, i) => ({ ...imageFile, name: `${i}.png` }))); await count(6); await clear();
    await select(Array.from({ length: 9 }, (_, i) => textFile(`${i}.txt`))); await count(8); await clear();
    await input.fill('x'.repeat(399990)); await select([textFile('over.txt')]); await count(0);
    await input.fill('keep draft');
    await select([textFile('slow.txt')]);
    await page.waitForFunction(() => typeof window.releaseAttachmentRead === 'function');
    assert.equal(await page.locator('#pi-send-button').isDisabled(), true);
    assert.equal(await page.locator('#pi-schedule-button').isDisabled(), true);
    await input.press('Enter'); assert.equal(prompts.length, 0);
    await changeSession('b'); await input.fill('other thread');
    await select([textFile('independent.txt')]); await count(1); await clear();
    await page.evaluate(() => window.releaseAttachmentRead()); await count(0);
    await changeSession('a'); assert.equal(await input.inputValue(), 'keep draft'); await count(0);
    // Concurrent entry points retain both files, then explicit rejection retains the draft.
    await Promise.all([select([textFile('one.txt')]), transfer('paste', '#pi-input', [{ name: 'two.txt', text: 'second', type: 'text/plain' }])]); await count(2);
    mode = 'reject'; await input.press('Enter');
    await page.waitForFunction(() => document.querySelector('#pi-toast-region').textContent.includes('fixture: rejected'));
    assert.equal(await input.inputValue(), 'keep draft'); await count(2);
    mode = 'hold'; await input.press('Enter');
    await page.waitForFunction(() => document.querySelector('#pi-attachment-status').textContent.includes('正在提交'));
    const before = prompts.length; await input.press('Enter'); assert.equal(prompts.length, before);
    await input.fill('newer draft'); held();
    await page.waitForFunction(() => !document.querySelector('#pi-send-button').disabled);
    assert.equal(await input.inputValue(), 'newer draft'); await count(2);
    mode = 'timeout'; await input.press('Enter');
    await page.waitForFunction(() => document.querySelector('#pi-attachment-status').textContent.includes('不确定'));
    const previous = prompts.length;
    page.once('dialog', dialog => dialog.dismiss()); await input.press('Enter'); assert.equal(prompts.length, previous);
    page.once('dialog', dialog => dialog.accept()); mode = 'accept'; await input.press('Enter');
    await page.waitForFunction(() => document.querySelector('#pi-input').value === ''); await count(0);
    await input.fill('source pending'); await select([imageFile]); await count(1);
    mode = 'hold'; await input.press('Enter');
    await page.waitForFunction(() => document.querySelector('#pi-attachment-status').textContent.includes('正在提交'));
    await changeSession('b'); assert.equal(await input.inputValue(), 'other thread'); await count(0);
    mode = 'accept'; await input.press('Enter');
    await page.waitForFunction(() => document.querySelector('#pi-input').value === '');
    await changeSession('a'); assert.equal(await input.inputValue(), 'source pending'); await count(1);
    assert.match(await page.locator('#pi-attachment-status').textContent(), /不确定/);
    page.once('dialog', dialog => dialog.accept()); await input.press('Enter');
    await page.waitForFunction(() => document.querySelector('#pi-input').value === ''); await count(0);
    await input.fill('network draft'); await select([imageFile]); await count(1);
    mode = 'disconnect'; await input.press('Enter');
    await page.waitForFunction(() => document.querySelector('#pi-attachment-status').textContent.includes('不确定'));
    await page.waitForFunction(() => !document.querySelector('#pi-send-button').disabled);
    assert.equal(await input.inputValue(), 'network draft'); await count(1);
    page.once('dialog', dialog => dialog.accept()); mode = 'accept'; await input.press('Enter');
    await page.waitForFunction(() => document.querySelector('#pi-input').value === ''); await count(0);
    // Workflows use the same clipboard/drop and binary validation without REST writes.
    await input.fill('scheduled draft'); await page.locator('#pi-composer-add-button').click(); await page.locator('#pi-schedule-button').click();
    await transfer('paste', '#pi-workflow-message', [{ name: 'clipboard.png', type: 'image/png', image: png }]);
    await page.waitForFunction(() => document.querySelectorAll('#pi-workflow-images img').length === 1 && !document.querySelector('#pi-workflow-submit').disabled);
    await transfer('drop', '#pi-workflow-content', [{ name: 'bad.pdf', text: 'bad' }, { name: 'notes.txt', type: 'text/plain', text: 'workflow attachment' }]);
    await page.waitForFunction(() => document.querySelector('#pi-workflow-message').value.includes('workflow attachment') && !document.querySelector('#pi-workflow-submit').disabled);
    assert.ok(!(await page.locator('#pi-workflow-message').inputValue()).includes('bad.pdf'));
    await page.locator('#pi-workflow-files').setInputFiles([textFile('slow.txt')]);
    await page.waitForFunction(() => document.querySelector('#pi-workflow-file-status').textContent.includes('正在读取'));
    await page.locator('#pi-workflow-close').click(); await page.locator('#pi-composer-add-button').click(); await page.locator('#pi-schedule-button').click();
    await page.evaluate(() => window.releaseAttachmentRead());
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#pi-workflow-message').inputValue(), 'scheduled draft');
    await page.locator('#pi-workflow-close').click();
    await select([imageFile, textFile('long-filename-'.repeat(12) + '.txt')]); await count(2);
    await page.waitForFunction(() => document.querySelector('#pi-toast-region').children.length === 0, null, { timeout: 12000 });
    await transfer('dragover', '.pi-composer-wrap', [{ name: 'drag.txt', text: 'drag' }]);
    assert.equal(await page.locator('.pi-composer-wrap').evaluate(node => node.classList.contains('pi-file-dragover')), true);
    await page.screenshot({ path: `/tmp/pi-attachments-${viewport.width}-composer.png` });
    assert.equal(await page.evaluate(() => document.body.scrollWidth > document.body.clientWidth), false);
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    console.log(`attachments ${viewport.width}: HTTP, picker/paste/drop, previews, limits, races, rejection/timeout/disconnect, workflows passed`);
    await context.close();
}
(async () => {
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try { for (const viewport of [{ width: 1440, height: 1000 }, { width: 393, height: 852 }, { width: 412, height: 915 }]) await run(browser, viewport); }
    finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
