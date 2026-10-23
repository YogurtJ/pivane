const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), { once } = require('node:events');
const { createHash } = require('node:crypto');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { zip, docxFiles, xlsxFiles, pptxFiles, pdfBytes } = require('../document-fixtures.cjs');
const { marker } = require('../../public/pi-document-references');
const root = path.resolve(__dirname, '../..'), cwd = '/projects/office-browser-fixture';
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text', 'image'], contextWindow: 32000 };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5V8AAAAASUVORK5CYII=', 'base64');
const sessions = ['a', 'b'].map(id => ({ id, cwd, name: id, messageCount: 0 }));
const samples = ['docx', 'xlsx', 'pptx', 'pdf'].map((format, i) => ({ name: ['合同 & "样本".docx', '销售.xlsx', '演示.pptx', '报告.pdf'][i], format,
    buffer: format === 'pdf' ? pdfBytes() : zip(({ docx: docxFiles, xlsx: xlsxFiles, pptx: pptxFiles })[format]()), mimeType: 'application/octet-stream' }));
async function run(browser, base, width, locale) {
    const context = await browser.newContext({ locale, viewport: { width, height: width < 900 ? 852 : 1000 }, isMobile: width < 900, hasTouch: width < 900, acceptDownloads: true });
    const page = await context.newPage(), errors = [], uploads = [], prompts = [], saved = new Map(), threads = sessions.map(session => ({ ...session }));
    let active = 'a', reject = false, held, hold = false, loseResponse = false, statusUnavailable = false; const messages = { a: [], b: [] };
    const textOf = message => typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join('');
    page.on('pageerror', e => errors.push(e.message));
    await page.route(/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//, r => r.abort());
    await page.addInitScript(({ cwd }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, 'a'); }, { cwd });
    const replyUpload = (route, result) => route.fulfill({ json: result });
    await page.route('**/api/**', async route => {
        const req = route.request(), url = new URL(req.url()), endpoint = url.pathname;
        const json = data => route.fulfill({ json: data });
        if (endpoint === '/api/pi/uploads' && req.method() === 'POST') {
            const bytes = req.postDataBuffer(), name = url.searchParams.get('name'), owner = url.searchParams.get('sessionId'), requestId = url.searchParams.get('requestId');
            assert.equal(req.headers()['content-type'], 'application/octet-stream'); assert.equal(url.searchParams.get('cwd'), cwd);
            const extension = name.split('.').at(-1);
            const reference = { id: createHash('sha256').update(owner + requestId).digest('hex'), revision: createHash('sha256').update(bytes).digest('hex'), name,
                format: url.searchParams.get('purpose') === 'image' ? 'image' : ['docx', 'xlsx', 'pptx', 'pdf'].includes(extension) ? extension : 'file', size: bytes.length };
            const result = { reference, marker: marker(reference) }; uploads.push({ reference, bytes, owner }); saved.set(owner + requestId, result);
            if (hold) { held = () => replyUpload(route, result); return; }
            if (loseResponse) { loseResponse = false; return route.abort(); }
            return json(result);
        }
        if (endpoint === '/api/pi/uploads/status') return statusUnavailable ? route.fulfill({ status: 503, json: { error: 'Status temporarily unavailable' } }) : json(saved.get(url.searchParams.get('sessionId') + url.searchParams.get('requestId')));
        if (endpoint === '/api/pi/uploads') {
            const found = uploads.find(item => item.reference.id === url.searchParams.get('id')); assert.ok(found); assert.equal(url.searchParams.get('sessionId'), active);
            return route.fulfill({ body: found.bytes, contentType: 'application/octet-stream' });
        }
        if (endpoint === '/api/pi/status') return json({ ok: true, documentUploads: true, attachmentUploads: true, sessionWorkflows: true, projectRoots: ['/projects'] });
        if (endpoint === '/api/pi/projects') return json({ projects: [{ cwd, name: 'Office fixture', sessionCount: threads.length }], roots: ['/projects'] });
        if (endpoint === '/api/pi/sessions') return json({ sessions: threads });
        if (endpoint === '/api/pi/activity') return json({ runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] });
        if (endpoint.endsWith('/deferred')) return json({ jobs: [] });
        if (endpoint.endsWith('/workflow')) return json({ leafId: 'leaf', prompts: messages[active].map((message, index) => ({ entryId: `user-${index}`, timestamp: message.timestamp, text: textOf(message).slice(0, 180) })), versions: [] });
        if (endpoint.includes('/prompt/')) return json({ leafId: 'leaf', message: textOf(messages[active][Number(endpoint.split('user-').at(-1))]), images: [] });
        if (endpoint.endsWith('/fork') && req.method() === 'POST') {
            const body = req.postDataJSON(), index = Number(body.entryId.split('user-').at(-1));
            assert.equal(body.expectedLeafId, 'leaf');
            const session = { id: `fork-${threads.length}`, cwd, name: 'Forked office draft', messageCount: index };
            threads.push(session); messages[session.id] = messages[active].slice(0, index);
            return json({ session, draft: { message: textOf(messages[active][index]), images: [] } });
        }
        if (req.method() !== 'GET') throw new Error('Unexpected write: ' + endpoint);
        return json(endpoint.includes('history') ? [] : {});
    });
    await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => {
        const cmd = JSON.parse(raw), state = { model, thinkingLevel: 'off', isStreaming: false, isCompacting: false };
        const send = (data = {}, error) => ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: !error, data, error }));
        if (cmd.type === 'open_session') { active = cmd.sessionId; return send({ session: threads.find(s => s.id === active), state, messages: { messages: messages[active] }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } }); }
        if (cmd.type === 'get_messages') return send({ messages: messages[active] });
        if (cmd.type === 'get_state') return send(state);
        if (cmd.type === 'get_session_stats') return send({});
        if (['prompt', 'steer', 'follow_up'].includes(cmd.type)) {
            prompts.push(cmd); if (reject) return send({}, 'Controlled document rejection');
            const message = { role: 'user', timestamp: Date.now() + prompts.length, content: [{ type: 'text', text: cmd.message }] };
            messages[active].push(message); ws.send(JSON.stringify({ type: 'message_end', message })); return send();
        }
        throw new Error('Unexpected RPC: ' + cmd.type);
    }));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    const input = page.locator('#pi-input'), chips = page.locator('#pi-attachments .pi-attachment-chip');
    await page.waitForFunction(() => !document.querySelector('#pi-input').disabled);
    const count = n => page.waitForFunction(n => document.querySelectorAll('#pi-attachments .pi-attachment-chip').length === n && document.querySelector('#pi-attachments').getAttribute('aria-busy') === 'false', n);
    const select = files => page.locator('#pi-file-input').setInputFiles(files.map(({ format, ...file }) => file));
    const clear = async () => { while (await chips.count()) await page.locator('[data-remove-attachment]').first().click(); };
    const switchTo = async id => {
        if (width < 900 && !await page.locator('#pi-session-pane').evaluate(n => n.classList.contains('open'))) await page.locator('#pi-toggle-sessions').click();
        await page.locator('[data-filter="all"]').click(); await page.locator(`[data-session-id="${id}"] .pi-session-main`).click();
        await page.waitForFunction(id => !document.querySelector('#pi-input').disabled && document.querySelector('#pi-meta-id').textContent === id, id);
        if (width < 900) assert.equal(await page.locator('#pi-session-pane').evaluate(node => node.classList.contains('open')), false, 'selecting a thread closes the phone drawer');
    };
    const openSchedule = async () => {
        await page.locator('#pi-composer-add-button').click(); await page.locator('#pi-schedule-button').click();
        await page.waitForFunction(() => document.querySelector('#pi-workflow-dialog').open);
    };
    const holdImageRead = async (name, selector = '#pi-file-input') => {
        await page.evaluate(name => {
            const arrayBuffer = File.prototype.arrayBuffer, read = window.PiAttachments.read;
            const gate = window.__attachmentRead = { started: false, settled: false };
            File.prototype.arrayBuffer = function (...args) {
                if (this.name !== name) return arrayBuffer.apply(this, args);
                gate.started = true;
                return new Promise(resolve => { gate.release = () => resolve(arrayBuffer.apply(this, args)); });
            };
            window.PiAttachments.read = async function (file, ...args) {
                try { return await read(file, ...args); }
                finally {
                    if (file.name === name) {
                        gate.settled = true; File.prototype.arrayBuffer = arrayBuffer; window.PiAttachments.read = read;
                    }
                }
            };
        }, name);
        await page.locator(selector).setInputFiles({ name, mimeType: 'image/png', buffer: png });
        await page.waitForFunction(() => window.__attachmentRead.started);
    };
    const releaseImageRead = async () => {
        await page.evaluate(() => window.__attachmentRead.release());
        await page.waitForFunction(() => window.__attachmentRead.settled);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    // Selection owns the upload before local image reading begins, including A -> B -> A.
    for (const returnToSource of [false, true]) {
        const beforeRead = uploads.length;
        await input.fill('image source draft'); await holdImageRead(`slow-${returnToSource}.png`);
        await switchTo('b'); await input.fill('image destination draft');
        if (returnToSource) await switchTo('a');
        await releaseImageRead();
        assert.equal(uploads.length, beforeRead, 'invalidated image reads must not POST to either thread');
        assert.equal(await input.inputValue(), returnToSource ? 'image source draft' : 'image destination draft'); await count(0);
        await switchTo(returnToSource ? 'b' : 'a');
        assert.equal(await input.inputValue(), returnToSource ? 'image destination draft' : 'image source draft'); await count(0);
        if (returnToSource) await switchTo('a');
    }
    await input.fill('Summarize these documents'); await select(samples); await count(4); assert.equal(uploads.length, 4);
    const downloadEvent = page.waitForEvent('download'); await page.locator('[data-preview-attachment]').last().click();
    const downloaded = await downloadEvent; assert.equal(downloaded.suggestedFilename(), samples[3].name); assert.deepEqual(fs.readFileSync(await downloaded.path()), samples[3].buffer);
    assert.equal(await input.inputValue(), 'Summarize these documents');
    await select([{ ...samples[0], name: 'fifth.docx' }, { ...samples[0], name: 'sixth.docx' }]); await count(5); assert.equal(uploads.length, 5);
    reject = true; await input.press('Enter'); await page.waitForFunction(() => document.querySelector('#pi-toast-region').textContent.includes('Controlled document rejection')); await count(5);
    reject = false; await input.press('Enter'); await page.waitForFunction(() => document.querySelector('#pi-input').value === ''); await count(0);
    assert.equal(prompts.at(-1).images.length, 0); assert.ok(!prompts.at(-1).message.includes('合同 & 分析'));
    assert.equal(await page.locator('.user .pi-document-card').count(), 5); assert.equal(await page.evaluate(() => document.querySelector('.user').textContent.includes('<pivane_document')), false);
    const original = page.waitForEvent('download'); await page.locator('.user .pi-document-card button').first().click(); const originalDownload = await original;
    assert.equal(originalDownload.suggestedFilename(), samples[0].name.replaceAll('"', '_')); assert.deepEqual(fs.readFileSync(await originalDownload.path()), samples[0].buffer);
    // An unconfirmed POST is reconciled only by GET of its original requestId.
    const before = uploads.length; loseResponse = true; await select([{ ...samples[0], name: 'reconciled.docx' }]); await count(1); assert.equal(uploads.length, before + 1); await clear();
    // Late upload responses never enter a newly selected thread's draft.
    await input.fill('retain old draft'); hold = true; await select([{ ...samples[0], name: 'slow.docx' }]);
    await page.waitForFunction(() => document.querySelector('#pi-attachments').getAttribute('aria-busy') === 'true');
    while (!held) await page.waitForTimeout(20);
    assert.equal(await page.locator('#pi-send-button').isDisabled(), true);
    await switchTo('b'); await input.fill('new thread draft'); hold = false; await select([{ ...samples[1], name: 'new.xlsx' }]); await count(1); await held();
    await page.waitForTimeout(80); assert.match(await chips.textContent(), /new.xlsx/); assert.ok(!(await chips.textContent()).includes('slow.docx')); assert.equal(await input.inputValue(), 'new thread draft'); await clear();
    await switchTo('a'); assert.equal(await input.inputValue(), 'retain old draft'); await count(0);
    // Images already POSTed retain their source owner; late responses cannot enter B's draft.
    const beforeLateImage = uploads.length;
    hold = true; held = null; await select([{ name: 'late-original.png', mimeType: 'image/png', buffer: png }]);
    while (!held) await page.waitForTimeout(20);
    assert.equal(uploads.length, beforeLateImage + 1); assert.equal(uploads.at(-1).owner, 'a');
    await switchTo('b'); const otherDraft = await input.inputValue(); hold = false; await held();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await count(0); assert.equal(await input.inputValue(), otherDraft);
    await switchTo('a'); await count(0); assert.equal(await input.inputValue(), 'retain old draft');
    assert.equal(uploads.length, beforeLateImage + 1, 'a late response never resubmits the original');
    // Closing/reopening the scheduled-message editor invalidates a slow image read on the same thread.
    const beforeEditorRead = uploads.length;
    await openSchedule(); await holdImageRead('closed-editor.png', '#pi-workflow-files');
    await page.locator('#pi-workflow-close').click(); await openSchedule();
    await page.locator('#pi-workflow-message').fill('new editor draft'); await releaseImageRead();
    assert.equal(uploads.length, beforeEditorRead, 'a replaced editor cannot upload an original');
    assert.equal(await page.locator('#pi-workflow-message').inputValue(), 'new editor draft');
    assert.equal(await page.locator('#pi-workflow-images img, #pi-workflow-documents .pi-document-card').count(), 0);
    assert.equal(await page.locator('#pi-workflow-submit').isDisabled(), false);
    await page.locator('#pi-workflow-close').click();
    // A closed editor followed by a different thread also invalidates its pending image upload.
    await openSchedule(); await holdImageRead('old-editor-thread.png', '#pi-workflow-files');
    await page.locator('#pi-workflow-close').click(); await switchTo('b'); await releaseImageRead();
    assert.equal(uploads.length, beforeEditorRead, 'the original cannot move to the new thread'); await count(0);
    await switchTo('a');
    // Scheduled-message editor keeps normal image originals and office references.
    await openSchedule();
    await page.locator('#pi-workflow-files').setInputFiles([
        { name: 'scheduled.pptx', mimeType: 'application/octet-stream', buffer: samples[2].buffer },
        { name: 'scheduled.png', mimeType: 'image/png', buffer: png }
    ]);
    await page.waitForFunction(() => document.querySelector('#pi-workflow-documents .pi-document-card') && document.querySelector('#pi-workflow-images img') && !document.querySelector('#pi-workflow-submit').disabled);
    assert.equal(uploads.at(-1).owner, 'a'); assert.equal(uploads.at(-1).reference.format, 'image');
    await page.locator('#pi-workflow-close').click();
    await select([{ ...samples[0], name: 'long-name-'.repeat(16) + '.docx' }]); await count(1);
    const beforeForkUploads = uploads.length, beforeForkPrompts = prompts.length;
    await page.locator('#pi-current-thread-menu').click();
    await page.locator('.pi-thread-menu [role="menuitem"]').filter({ has: page.locator('i.fa-clock-rotate-left') }).click();
    await page.locator('.pi-thread-menu [role="menuitem"]').filter({ has: page.locator('i.fa-code-branch') }).click();
    await page.locator('[data-workflow-action="fork"]').first().click();
    await page.locator('#pi-workflow-submit').click();
    await page.waitForFunction(() => document.querySelector('#pi-meta-id').textContent === 'fork-2' && !document.querySelector('#pi-workflow-dialog').open);
    await count(5);
    assert.equal(await input.inputValue(), 'Summarize these documents\n' + (locale === 'en' ? '[Filename (not uploaded): sixth.docx]' : '[文件名（未上传）：sixth.docx]'));
    assert.equal(uploads.length, beforeForkUploads, 'fork reuses original references without uploading');
    assert.equal(prompts.length, beforeForkPrompts, 'opening a fork never sends its draft');
    const forkDownloadEvent = page.waitForEvent('download'); await page.locator('[data-preview-attachment]').first().click();
    const forkDownload = await forkDownloadEvent; assert.deepEqual(fs.readFileSync(await forkDownload.path()), samples[0].buffer);
    await page.locator('[data-remove-attachment]').last().click(); await count(4);
    await input.press('Enter'); await count(0);
    assert.equal((prompts.at(-1).message.match(/<pivane_document /g) || []).length, 4, 'removal changes the next message');
    assert.equal(await page.locator('.user .pi-document-card').count(), 4);
    await switchTo('a'); await count(1);
    assert.equal(await input.inputValue(), 'retain old draft', 'source draft and its existing attachment survive');
    await clear();
    const audio = { name: 'recording.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from([0, 255, 1, 2]) };
    const archive = { name: 'archive.zip', mimeType: 'application/zip', buffer: Buffer.from([80, 75, 0, 1]) };
    await select([audio, archive, { name: 'original.png', mimeType: 'image/png', buffer: png }]); await count(3);
    assert.match((await chips.allTextContents()).join(''), /已上传.*待发送|Uploaded.*not sent/);
    assert.equal(uploads.at(-1).reference.format, 'image'); assert.deepEqual(uploads.at(-1).bytes, png);
    const genericDownloadEvent = page.waitForEvent('download'); await page.locator('[data-preview-attachment]').first().click();
    assert.deepEqual(fs.readFileSync(await (await genericDownloadEvent).path()), audio.buffer);
    await input.press('Enter'); await count(0);
    assert.equal((prompts.at(-1).message.match(/<pivane_attachment /g) || []).length, 3);
    assert.equal(prompts.at(-1).images.length, 1);
    const beforeUnknown = uploads.length; loseResponse = true; statusUnavailable = true;
    await input.fill('keep unknown upload'); await select([audio]); await count(1);
    assert.match(await chips.textContent(), /上传结果待确认|Upload unconfirmed/); assert.equal(await page.locator('#pi-send-button').isDisabled(), true);
    assert.equal(await input.inputValue(), 'keep unknown upload');
    statusUnavailable = false; await page.locator('[data-preview-attachment]').click();
    await page.waitForFunction(() => /已上传|Uploaded/.test(document.querySelector('#pi-attachments').textContent) && !/待确认|unconfirmed/.test(document.querySelector('#pi-attachments').textContent));
    assert.equal(uploads.length, beforeUnknown + 1, 'status queries never submit another upload');
    assert.equal(await page.locator('#pi-send-button').isDisabled(), false);
    await page.waitForFunction(() => document.querySelector('#pi-toast-region').children.length === 0, null, { timeout: 12000 });
    await page.screenshot({ path: `/tmp/pi-document-uploads-${width}-${locale}.png` });
    assert.equal(await page.evaluate(() => window.innerWidth), width, 'the actual viewport matches the desktop/phone fixture');
    assert.equal(await page.evaluate(() => document.body.scrollWidth > document.body.clientWidth), false);
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.pi-document-card, .pi-attachment-chip')].filter(n => n.clientWidth && n.scrollWidth > n.clientWidth + 1).map(n => n.className)), []);
    assert.deepEqual(errors, []); console.log(`office attachments ${width} ${locale}: slow image selection ownership, A-B-A epochs, late originals, replaced scheduled editors, raw upload, status-only reconciliation, drafts, drawers and widths passed`);
    await context.close();
}
(async () => {
    const app = express();
    for (const [name, directory] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use('/vendor/' + name, express.static(path.join(root, 'node_modules', directory)));
    app.use(express.static(path.join(root, 'public')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try { for (const locale of ['zh-CN', 'en']) for (const width of [1440, 393]) await run(browser, `http://127.0.0.1:${server.address().port}`, width, locale); }
    finally { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
