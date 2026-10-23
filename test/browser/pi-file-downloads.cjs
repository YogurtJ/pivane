// Real HTTP origins and browser downloads; isolated synthetic cookies and bytes.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events'), { createHash } = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const source = path.resolve(__dirname, '../..'), large = Buffer.alloc(16 * 1024 * 1024 + 17, 0xa5);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const name = '交付 大文件.bin', requests = [];
let held, server, browser;
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Download fixture</title>
<button id="delivery">交付下载</button><button id="project">项目下载</button><output id="status"></output>
<script src="/pi-file-downloads.js"></script><script>
const state = { key: 'thread', cwd: '/fixture/project', sessionId: 'fixture', generation: 1 };
const api = async (url, options) => { const response = await fetch(url, { ...options, credentials: 'same-origin' }); if (!response.ok) { const error = new Error('HTTP ' + response.status); error.status = response.status; throw error; } };
const host = { context: () => ({ ...state }), api };
const downloads = [new PiFileDownloads(host), new PiFileDownloads(host)];
for (const download of downloads) { download.enabled = true; download.maxBytes = 32 * 1024 * 1024; }
let mode = 'ok';
for (const [index, id] of ['delivery', 'project'].entries()) document.getElementById(id).onclick = () => {
 const output = document.getElementById('status'); output.textContent = ''; delete output.dataset.error;
 const target = index ? { root: '/fixture/linked', path: mode === 'ok' ? '${name}' : mode } : { deliveryId: mode, index: 0, name: '${name}' };
 downloads[index].download(target).then(() => { output.textContent = 'ready'; }).catch(error => { output.textContent = error.message; output.dataset.error = 'true'; });
};
</script>`;
function finish(res, status = 200) { res.writeHead(status, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="large.bin"; filename*=UTF-8''${encodeURIComponent(name)}`, 'Content-Length': status === 200 ? large.length : 0, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(status === 200 && res.req.method === 'GET' ? large : undefined); }
async function run(base, width, secure) {
    const context = await browser.newContext({ viewport: { width, height: 852 }, acceptDownloads: true });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        await page.goto(base);
        assert.deepEqual(await page.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID })), { secure, uuid: secure ? 'function' : 'undefined' }, 'use actual browser capabilities, without stubbing Web Crypto');
        await page.evaluate(() => { const frame = document.createElement('iframe'); frame.hidden = true; frame.name = 'pivane-download-1'; document.body.append(frame); });
        const start = requests.length;
        async function download(button) {
            const result = page.waitForEvent('download');
            const failed = page.waitForFunction(() => document.querySelector('#status').dataset.error === 'true').then(async () => { throw new Error(await page.locator('#status').textContent()); });
            await page.locator(button).click();
            const file = await Promise.race([result, failed]);
            assert.equal(file.suggestedFilename(), name); assert.equal(await file.failure(), null);
            const local = await file.path(); assert.equal(fs.statSync(local).size, large.length); assert.equal(digest(fs.readFileSync(local)), digest(large));
        }
        await download('#delivery'); await download('#project');
        assert.deepEqual(requests.slice(start).map(r => [r.kind, r.method]), [['deliverables', 'HEAD'], ['deliverables', 'GET'], ['files', 'HEAD'], ['files', 'GET']]);
        assert.ok(requests.slice(start).every(r => r.authenticated), 'HEAD and browser GET both carry the HttpOnly cookie');
        const frames = await page.locator('iframe').evaluateAll(nodes => nodes.map(n => n.name));
        assert.equal(frames.length, 3); assert.equal(new Set(frames).size, frames.length, 'two component instances have distinct frame targets');
        for (const [mode, expected] of [['denied', 'HTTP 401'], ['missing', 'HTTP 404'], ['oversize', /32 MiB/]]) {
            await page.evaluate(value => { mode = value; }, mode);
            const before = requests.length; await page.locator('#project').click();
            await page.waitForFunction(() => document.querySelector('#status').dataset.error === 'true');
            const message = await page.locator('#status').textContent();
            if (expected instanceof RegExp) assert.match(message, expected); else assert.equal(message, expected);
            assert.deepEqual(requests.slice(before).map(r => r.method), ['HEAD'], 'a rejected preflight must never initiate a GET');
        }
        for (const action of ['generation', 'reset']) {
            await page.evaluate(() => { mode = 'hold'; });
            const before = requests.length; await page.locator('#delivery').click();
            await until(() => held);
            if (action === 'generation') await page.evaluate(() => { state.generation++; });
            else await page.evaluate(() => { downloads[0].reset(); });
            const response = held; held = null; finish(response);
            await page.waitForFunction(() => document.querySelector('#status').textContent !== '');
            assert.deepEqual(requests.slice(before).map(r => r.method), ['HEAD'], 'stale or cancelled work must not initiate a GET');
            assert.equal(await page.evaluate(() => downloads[0].pending.size), 0);
        }
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        console.log(`PASS file downloads ${secure ? 'loopback HTTP' : 'insecure HTTP'} ${width}: >16 MiB exact bytes, cookie HEAD/GET, unique targets, 401/404/413, generation and abort`);
    } finally { await context.close(); }
}
async function until(test) { const end = Date.now() + 5000; while (!test()) { if (Date.now() > end) throw new Error('Held HEAD was not reached'); await new Promise(resolve => setTimeout(resolve, 10)); } }
(async () => {
    server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://fixture');
        if (url.pathname === '/pi-file-downloads.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(fs.readFileSync(path.join(source, 'public/pi-file-downloads.js'))); }
        const match = /^\/api\/pi\/(files|deliverables)\/download$/.exec(url.pathname);
        if (!match) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'fixture=download-only; Path=/; HttpOnly; SameSite=Lax' }); return res.end(html); }
        const authenticated = req.headers.cookie?.includes('fixture=download-only'), mode = url.searchParams.get('id') || url.searchParams.get('path');
        requests.push({ kind: match[1], method: req.method, authenticated });
        assert.equal(url.searchParams.get('cwd'), match[1] === 'files' ? '/fixture/linked' : '/fixture/project');
        if (match[1] === 'deliverables') assert.equal(url.searchParams.get('sessionId'), 'fixture');
        if (!authenticated || mode === 'denied') return finish(res, 401);
        if (mode === 'missing') return finish(res, 404);
        if (mode === 'oversize') return finish(res, 413);
        if (mode === 'hold' && req.method === 'HEAD') { held = res; return; }
        finish(res);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--no-proxy-server', '--host-resolver-rules=MAP pivane-downloads.test 127.0.0.1'] });
    for (const [host, secure] of [['pivane-downloads.test', false], ['127.0.0.1', true]]) for (const width of [1440, 393]) await run(`http://${host}:${server.address().port}`, width, secure);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (held) held.destroy(); if (browser) await browser.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
