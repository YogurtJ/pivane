const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
(async () => {
    const server = http.createServer((req, res) => {
        if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(`<meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/public/pi-nested-tools.css"><style>body{margin:8px}#content{min-width:0}.pi-tool-row{max-width:100%}[hidden]{display:none!important}</style><div id="controls"><button data-transcript-mode="compact">compact</button><button data-transcript-mode="full">full</button></div><div id="content"></div><script src="/public/pi-nested-tools.js"></script><script src="/public/pi-transcript-view.js"></script>`); return; }
        const allowed = ['/public/pi-nested-tools.css', '/public/pi-nested-tools.js', '/public/pi-transcript-view.js'];
        if (!allowed.includes(req.url)) { res.writeHead(404); res.end(); return; }
        res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(fs.readFileSync(path.join(root, req.url)));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
        for (const width of [1440, 393, 320]) {
            const page = await browser.newPage({ viewport: { width, height: 900 } }); const errors = [];
            page.on('pageerror', e => errors.push(e.message));
            await page.goto(`http://127.0.0.1:${server.address().port}`);
            await page.evaluate(() => {
                const content = document.getElementById('content');
                content.innerHTML = '<article class="pi-message user">fixture</article><details class="pi-tool-row" data-tool-id="p"><summary>codemode</summary></details><article class="pi-message assistant"><div class="pi-message-body"><p>final</p></div></article>';
                const row = content.querySelector('.pi-tool-row'); row.dataset.readingKey = 'p';
                const rows = new Map([['p', row]]);
                const event = (type, id, parent, name = 'write', extra = {}) => ({ type, toolCallId: id, parentToolCallId: parent, toolName: name, ...extra });
                window.testLive = () => {
                    if (PiNestedTools.live(rows, event('tool_execution_start', 'missing/1', 'missing'))) throw Error('orphan');
                    PiNestedTools.live(rows, event('tool_execution_start', 'p/1', 'p', 'write', { args: { path: 'safe.txt', content: '<img src=x onerror=alert(1)>' } }));
                    PiNestedTools.live(rows, event('tool_execution_start', 'p/1/1', 'p/1', 'read'));
                    PiNestedTools.live(rows, event('tool_execution_end', 'p/1/1', 'p/1', 'read', { durationMs: 0, result: { content: [{ type: 'text', text: 'LIVE-OUTPUT' }] } }));
                    PiNestedTools.live(rows, event('tool_execution_end', 'p/1', 'p', 'write', { durationMs: 17, result: { content: [{ type: 'text', text: 'SUCCESS' }] } }));
                };
                testLive();
                window.reloadNative = () => PiNestedTools.persisted(row, { complete: false, calls: [
                    { id: 'p/1', name: 'write', status: 'ok', durationMs: 23, arguments: { path: 'safe.txt', content: '<script>bad()</script>' } },
                    { id: 'p/1/1', name: 'read', status: 'ok', argumentsBytes: 9000 },
                    { id: 'p/2', name: 'edit', status: 'unfinished', arguments: { path: 'long'.repeat(1000) } },
                    { id: 'p/3', name: 'evil'.repeat(60), status: 'error', error: '<img onerror=bad()>' }
                ] });
                content.lastElementChild._piAssistantMessage = { role: 'assistant', stopReason: 'stop', timestamp: 1000 };
                window.view = new PiTranscriptView({ content, controls: document.getElementById('controls'), scroll: { capture: () => ({}), restore() {}, update() {} } });
                view.setMode('full', false); row.open = true;
            });
            assert.equal(await page.locator('.pi-tool-row').count(), 1);
            await page.waitForFunction(() => document.querySelectorAll('.pi-nested-call').length === 2);
            assert.equal(await page.locator('.pi-nested-call').count(), 2);
            assert.match(await page.locator('.pi-nested-call > summary').first().innerText(), /17ms/);
            await page.locator('.pi-nested-call > summary').first().click();
            assert.match(await page.locator('.pi-nested-call > summary').nth(1).innerText(), /0ms/);
            assert.match(await page.locator('.pi-nested-detail').first().innerText(), /SUCCESS/);
            await page.evaluate(() => reloadNative());
            assert.equal(await page.locator('.pi-nested-call').count(), 4);
            assert.match(await page.locator('.pi-nested-call > summary').first().innerText(), /23ms/);
            assert.match(await page.locator('.pi-nested-detail').first().innerText(), /未保存/);
            assert.doesNotMatch(await page.locator('#content').innerText(), /SUCCESS|LIVE-OUTPUT/);
            await page.locator('.pi-nested-call > summary').nth(1).click();
            assert.match(await page.locator('.pi-nested-detail').nth(1).innerText(), /9000 bytes/);
            assert.equal(await page.locator('#content img, #content script').count(), 0);
            await page.evaluate(() => view.setMode('compact', false));
            assert.equal(await page.locator('.pi-tool-row').isVisible(), false);
            await page.locator('.pi-turn-group > summary').click();
            await page.locator('.pi-process-group > summary').click();
            await page.locator('.pi-tool-row').waitFor({ state: 'visible' });
            await page.evaluate(() => view.setMode('full', false));
            const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
            assert.ok(dimensions.scroll <= width, JSON.stringify(dimensions));
            assert.deepEqual(errors, []);
            const batching = await page.evaluate(async () => {
                const row = document.createElement('details'); row.dataset.toolId = 'burst'; document.getElementById('content').append(row);
                const rows = new Map([['burst', row]]), frame = window.requestAnimationFrame;
                const nextFrame = () => new Promise(resolve => frame(resolve));
                const event = (type, id, extra = {}) => ({ type, parentToolCallId: 'burst', toolCallId: `burst/${id}`, toolName: 'read', ...extra });
                for (let i = 1; i <= 256; i++) PiNestedTools.live(rows, event('tool_execution_start', i));
                if (row.querySelector('.pi-nested-call')) throw Error('nested start burst painted synchronously');
                await nextFrame();
                if (row.querySelectorAll('.pi-nested-call').length !== 256) throw Error('nested starts were lost');
                let scheduled = 0;
                window.requestAnimationFrame = callback => { scheduled++; return frame(callback); };
                try {
                    for (let i = 0; i < 100; i++) PiNestedTools.live(rows, event('tool_execution_update', 1,
                        { partialResult: { content: [{ type: 'text', text: `part ${i}` }] } }));
                } finally { window.requestAnimationFrame = frame; }
                if (row._piNested.calls.get('burst/1').output !== 'part 99') throw Error('state update was deferred or lost');
                await nextFrame();
                PiNestedTools.live(rows, event('tool_execution_update', 1, { partialResult: { content: [{ type: 'text', text: 'late live' }] } }));
                PiNestedTools.persisted(row, { complete: true, calls: [{ id: 'burst/1', name: 'read', status: 'ok' }] });
                await nextFrame();
                if (row.querySelectorAll('.pi-nested-call').length !== 1 || !row._piNested.persisted) throw Error('pending live paint replaced native truth');
                if (PiNestedTools.live(rows, event('tool_execution_update', 1))) throw Error('late event accepted after native result');
                const removed = document.createElement('details'); removed.dataset.toolId = 'gone'; document.body.append(removed);
                PiNestedTools.live(new Map([['gone', removed]]), { type: 'tool_execution_start', parentToolCallId: 'gone', toolCallId: 'gone/1', toolName: 'read' });
                removed.remove(); await nextFrame();
                if (removed.childElementCount) throw Error('detached parent was painted');
                row.remove(); return { scheduled, updates: 100 };
            });
            assert.equal(batching.scheduled, 1, 'one paint for a burst; state and authority remain immediate');
            console.log(`nested native/live/folding/no-output/XSS/width/batching ${width}: passed`);
            await page.close();
        }
    } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
