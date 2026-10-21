// Real gateway + managed native worker + synthetic model; no production identity.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const source = path.resolve(__dirname, '../..');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-issue-browser-')));
const cwd = path.join(root, 'project'), agent = path.join(root, 'agent');
fs.mkdirSync(cwd); fs.mkdirSync(agent);
Object.assign(process.env, { PI_CODING_AGENT_DIR: agent, PI_PROJECT_ROOTS: root, PI_OFFLINE: '1', PI_TELEMETRY: '0',
    PI_WEB_DEFERRED_FILE: path.join(root, 'deferred.json'), PI_WEB_TOKEN: 'synthetic-browser-token', PIVANE_FILE_DOWNLOAD_MAX_MIB: '32' });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const smallVideo = fs.readFileSync(path.join(source, 'test/fixtures/release-video.mp4'));
const largeVideo = Buffer.alloc(22300079); smallVideo.copy(largeVideo);
largeVideo.writeUInt32BE(largeVideo.length - smallVideo.length, smallVideo.length);
largeVideo.write('free', smallVideo.length + 4, 'ascii');
fs.writeFileSync(path.join(cwd, 'large-video.mp4'), largeVideo);
fs.writeFileSync(path.join(cwd, 'small-video.mp4'), smallVideo);
fs.writeFileSync(path.join(cwd, 'report.md'), '# Delivery without a model-authored link');
const oversized = fs.openSync(path.join(cwd, 'over-download-limit.bin'), 'wx'); fs.ftruncateSync(oversized, 33 * 1024 * 1024); fs.closeSync(oversized);
let browser, provider, server, gateway, access, wss;
const modelCalls = [];
async function main() {
    provider = http.createServer(async (req, res) => {
        let text = ''; for await (const chunk of req) text += chunk;
        const body = JSON.parse(text), last = body.messages.at(-1); modelCalls.push(body);
        let tool, answer = 'Synthetic response';
        const user = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
        if (last.role === 'user' && user.includes('ISSUE_FLOW')) {
            const timeout = user.includes('TIMEOUT');
            tool = { name: 'ask_user_question', arguments: { timeoutMs: timeout ? 1200 : 60000, questions: [
                { question: 'Choose an output', header: 'Output', options: [{ label: 'Video', description: 'Rendered walkthrough' }, { label: 'Report' }] },
                { question: 'Anything to add?', placeholder: 'Optional note' }] } };
        } else if (last.role === 'tool') {
            let result; try { result = JSON.parse(last.content); } catch {}
            const first = result?.answers?.[0]?.answer;
            if (result?.status === 'answered' && ['Video', 'Report'].includes(first) && result.answers[1]?.answer !== 'NO_DELIVERY') tool = { name: 'deliver_files', arguments: { requestId: 'browser-output', title: 'Generated files', files: first === 'Report' ? ['missing.mp4'] : ['large-video.mp4', 'small-video.mp4', 'report.md'] } };
            else if (result?.status) answer = `Question result: ${result.status}${result.answers.length ? ': ' + result.answers.map(item => item.skipped ? '(skipped)' : item.answer).join(' | ') : ''}`;
            else if (result?.reference) answer = `Generated files are ready.\n\n[Walkthrough](#pi-delivery=${result.reference.id}/0)\n\n[Current note](current-note.txt)\n\n[Over download limit](over-download-limit.bin)`;
            else answer = 'No delivery was created.';
        }
        const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call-' + modelCalls.length, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }
            : { role: 'assistant', content: answer };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', defaultProjectTrust: 'never', enableInstallTelemetry: false, compaction: { enabled: false } }));
    fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'synthetic', models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    const express = require('express');
    const { WorkspaceAccessService } = require('../../server/workspace-access-service');
    const { createPiAgentGateway } = require('../../server/pi-agent-routes');
    access = new WorkspaceAccessService(); gateway = createPiAgentGateway({ accessService: access, deferredFilePath: process.env.PI_WEB_DEFERRED_FILE });
    const app = express(); access.mount(app); app.use(express.json({ limit: '32mb' })); gateway.mount(app);
    for (const [url, dir] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use('/vendor/' + url, express.static(path.join(source, 'node_modules', dir)));
    app.use(express.static(path.join(source, 'public')));
    server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`; process.env.PI_WORKSPACE_BASE_URL = base;
    wss = gateway.attachWebSocket(server);
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    for (const width of [1440, 393, 320]) {
        fs.writeFileSync(path.join(cwd, 'current-note.txt'), 'Original preview snapshot');
        const session = await gateway.store.createSession(cwd, 'Issue workflow ' + width);
        const context = await browser.newContext({ viewport: { width, height: 900 }, acceptDownloads: true, locale: 'en-US' });
        const login = await context.request.post(base + '/api/access/login', { headers: { Origin: base, 'X-Pi-Access': '1' }, data: { token: 'synthetic-browser-token' } }); assert.equal(login.status(), 200);
        await context.addInitScript(({ cwd, sessionId }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, sessionId); localStorage.setItem('pi.web.locale', 'en'); }, { cwd, sessionId: session.id });
        const page = await context.newPage(), errors = [];
        page.setDefaultTimeout(30000); page.on('pageerror', error => { errors.push(error.message); console.error('pageerror:', error.message); });
        await page.goto(base, { waitUntil: 'domcontentloaded' });
        await page.locator('#pi-input').fill('ISSUE_FLOW CHOOSE');
        await page.waitForFunction(() => !document.querySelector('#pi-send-button').disabled);
        await page.locator('#pi-send-button').click();
        const panel = page.locator('#pi-question-panel:not([hidden])');
        await panel.waitFor();
        if (width === 1440) {
            const pendingId = gateway.supervisor.getActiveWorker(session.path).getPendingUi()[0].id;
            await page.reload({ waitUntil: 'domcontentloaded' });
            await panel.waitFor();
            assert.equal(gateway.supervisor.getActiveWorker(session.path).getPendingUi()[0].id, pendingId, 'refresh restores the same pending request');
        }
        assert.equal(await page.locator('#pi-request-dialog[open]').count(), 0, 'a recognised question does not open the generic dialog');
        assert.equal(await page.locator('#pi-pending-ui-banner').evaluate(node => node.classList.contains('hidden')), true, 'the panel is not repeated in the banner');
        assert.equal(await panel.locator('.pi-question-position').textContent(), '1 / 2');
        assert.equal(await panel.locator('.pi-question-option').count(), 2);
        await page.screenshot({ path: `/tmp/pivane-issues-question-${width}.png` });
        await panel.locator('.pi-question-option').first().click();
        await panel.locator('.pi-question-text', { hasText: 'Anything to add?' }).waitFor();
        assert.equal(gateway.supervisor.getActiveWorker(session.path).getPendingUi()[0].title, 'Choose an output', 'answers stay local until the last question');
        await panel.locator('textarea').fill('Keep it short'); await panel.locator('textarea').press('Enter');
        const receipt = page.locator('.pi-question-receipt'); await receipt.waitFor();
        assert.deepEqual(await receipt.locator('dd').allTextContents(), ['Video', 'Keep it short']);
        await page.locator('#pi-question-panel').waitFor({ state: 'hidden' });
        const card = page.locator('.pi-delivery-receipt'); await card.waitFor();
        assert.equal(await card.locator('.pi-delivery-receipt-file').count(), 3);
        await page.getByText('Generated files are ready.', { exact: true }).waitFor();
        assert.equal(await page.getByRole('link', { name: 'Walkthrough', exact: true }).locator('.pi-file-link-icon.fa-file-video').count(), 1, 'delivery links show the delivered file type');
        assert.equal(await card.isVisible(), true, 'card remains outside folded tool/process records');
        await page.locator('#pi-input').fill('retained draft');
        const download = page.waitForEvent('download'); await card.locator('.pi-delivery-receipt-download').first().click();
        const file = await download; assert.equal(file.suggestedFilename(), 'large-video.mp4'); assert.equal(digest(fs.readFileSync(await file.path())), digest(largeVideo));
        await card.locator('.pi-delivery-receipt-open').first().click();
        await page.waitForFunction(() => !document.querySelector('#pi-file-download').disabled && /preview|预览/.test(document.querySelector('#pi-file-status').textContent));
        const secondDownload = page.waitForEvent('download'); await page.locator('#pi-file-download').click();
        assert.equal(digest(fs.readFileSync(await (await secondDownload).path())), digest(largeVideo));
        assert.equal(await page.locator('#pi-input').inputValue(), 'retained draft');
        await page.locator('#pi-close-inspector').click();
        await page.getByRole('link', { name: 'Current note', exact: true }).click();
        await page.getByText('Original preview snapshot', { exact: true }).waitFor();
        fs.writeFileSync(path.join(cwd, 'current-note.txt'), 'Changed after preview');
        const snapshotDownload = page.waitForEvent('download'); await page.locator('#pi-file-download').click();
        assert.equal(fs.readFileSync(await (await snapshotDownload).path(), 'utf8'), 'Original preview snapshot', 'a loaded preview keeps its original download bytes until refreshed');
        await page.locator('#pi-close-inspector').click();
        await page.getByRole('link', { name: 'Over download limit', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('#pi-file-download').disabled && /preview|预览/.test(document.querySelector('#pi-file-status').textContent));
        await page.locator('#pi-file-download').click();
        await page.getByText('This file exceeds the download limit (32 MiB)', { exact: true }).waitFor();
        await page.locator('#pi-close-inspector').click();
        await card.locator('.pi-delivery-receipt-open').nth(1).click();
        await page.waitForFunction(() => { const player = document.querySelector('#pi-file-body video'); return player?.readyState >= 1 && player.videoWidth > 0; });
        await page.locator('#pi-file-body video').evaluate(async player => { await player.play(); });
        await page.waitForFunction(() => document.querySelector('#pi-file-body video')?.currentTime > 0);
        await page.locator('#pi-close-inspector').click();
        await page.reload({ waitUntil: 'domcontentloaded' }); await page.locator('.pi-delivery-receipt').waitFor();
        assert.equal(await page.locator('.pi-delivery-receipt').count(), 1, 'native history restores exactly one card');
        assert.equal(await page.locator('.pi-delivery-receipt').isVisible(), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        const geometry = await page.locator('.pi-delivery-receipt-file').evaluateAll(nodes => nodes.map(node => ({ width: node.getBoundingClientRect().width, scroll: node.scrollWidth })));
        assert.ok(geometry.every(item => item.scroll <= item.width + 1));
        await page.screenshot({ path: `/tmp/pivane-issues-workflow-${width}.png`, fullPage: true });
        assert.deepEqual(errors, []);
        await context.close(); await gateway.supervisor.stopSession(session.path);
        console.log(JSON.stringify({ width, largeBytes: largeVideo.length, downloads: 3, restoredCards: 1, videoPlayed: true, errors }));
    }
    // Exercise cancellation, custom input, timeout and stopping through real form responses.
    for (const scenario of ['CUSTOM', 'CANCEL', 'TIMEOUT', 'STOP', 'FAIL']) {
        const session = await gateway.store.createSession(cwd, 'Question ' + scenario), context = await browser.newContext({ viewport: { width: 393, height: 852 } });
        await context.request.post(base + '/api/access/login', { headers: { Origin: base, 'X-Pi-Access': '1' }, data: { token: 'synthetic-browser-token' } });
        await context.addInitScript(({ cwd, id }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, id); }, { cwd, id: session.id });
        const page = await context.newPage(); page.setDefaultTimeout(30000);
        await page.goto(base, { waitUntil: 'domcontentloaded' });
        await page.locator('#pi-input').fill('ISSUE_FLOW ' + scenario); await page.waitForFunction(() => !document.querySelector('#pi-send-button').disabled);
        await page.locator('#pi-send-button').click();
        const panel = page.locator('#pi-question-panel:not([hidden])'); await panel.waitFor();
        if (scenario === 'CUSTOM') {
            // Choose, go back, replace the choice with typed text, then skip the free-text question.
            await panel.locator('.pi-question-option').first().click();
            await panel.locator('.pi-question-position', { hasText: '2 / 2' }).waitFor();
            await panel.getByRole('button', { name: 'Previous question' }).click();
            assert.equal(await panel.locator('.pi-question-option[aria-pressed="true"]').count(), 1, 'going back keeps the earlier choice');
            await panel.locator('textarea').fill('My custom answer');
            assert.equal(await panel.locator('.pi-question-option[aria-pressed="true"]').count(), 0, 'typing replaces the choice');
            await panel.locator('.pi-question-submit').click();
            await panel.locator('.pi-question-text', { hasText: 'Anything to add?' }).waitFor();
            assert.equal(await panel.locator('.pi-question-submit').textContent(), 'Submit');
            await panel.locator('.pi-question-skip').click();
            await page.getByText('Question result: answered: My custom answer | (skipped)', { exact: true }).waitFor();
            await page.screenshot({ path: '/tmp/pivane-issues-question-receipt-393.png' });
        } else if (scenario === 'FAIL') {
            await panel.locator('.pi-question-option').first().focus(); await page.keyboard.press('2');
            await panel.locator('textarea').fill('Deliver it'); await panel.locator('.pi-question-submit').click();
            await page.getByText('No delivery was created.', { exact: true }).waitFor();
        } else if (scenario === 'CANCEL') {
            await panel.getByRole('button', { name: 'Close without answering' }).click();
            await page.getByText('Question result: cancelled', { exact: true }).waitFor();
            assert.equal(await page.locator('.pi-question-receipt.is-cancelled').count(), 1);
        } else if (scenario === 'TIMEOUT') {
            await page.getByText('Question result: timed_out', { exact: true }).waitFor();
            await page.locator('#pi-question-panel').waitFor({ state: 'hidden' });
        } else {
            await panel.getByRole('button', { name: 'Collapse question' }).click();
            assert.equal(await panel.locator('.pi-question-body').isVisible(), false);
            await page.locator('#pi-stop-button').click();
            await page.locator('#pi-question-panel').waitFor({ state: 'hidden' });
        }
        assert.equal(await page.locator('#pi-request-dialog[open]').count(), 0);
        assert.equal(await page.locator('.pi-delivery-receipt').count(), 0);
        await context.close(); await gateway.supervisor.stopSession(session.path);
        console.log(JSON.stringify({ scenario, deliveryCards: 0 }));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await browser?.close(); await gateway?.dispose(); access?.dispose();
    if (wss) await new Promise(resolve => wss.close(resolve));
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
    fs.rmSync(root, { recursive: true, force: true });
});
