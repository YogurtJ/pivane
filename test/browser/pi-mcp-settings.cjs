const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const server = http.createServer((req, res) => {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/public/pi-mcp-settings.css"><style>body{margin:0;font:16px sans-serif}.workspace-settings-content{max-width:100%}</style><div class="workspace-settings-content"></div><script src="/public/pi-mcp-settings.js"></script>'); }
    if (['/public/pi-mcp-settings.js', '/public/pi-mcp-settings.css'].includes(req.url)) { res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8'); return res.end(fs.readFileSync(path.join(root, req.url))); }
    res.writeHead(404); res.end();
});
(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        for (const width of [1440, 393, 320]) {
            const page = await browser.newPage({ viewport: { width, height: 900 } }), errors = [];
            let cancelDiscard = false;
            page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => cancelDiscard && d.message().startsWith('Refresh clears') ? d.dismiss() : d.accept());
            await page.goto(`http://127.0.0.1:${server.address().port}`);
            await page.evaluate(() => {
                window.PiI18n = { locale: 'en' }; window.writes = []; window.reads = []; window.conflict = false; window.trusted = true; window.selected = null;
                const host = { currentCwd: () => '/mock/project', currentSession: () => window.selected, apiFetch: async (url, options) => {
                    if (options) { const body = JSON.parse(options.body); window.writes.push({ url, body }); if (window.conflict) throw Error('secret-error-must-not-render'); if (url.includes('/sessions/')) return { runtimeId: body.runtimeId, servers: [{ name: 'fixture', state: 'unknown', toolCount: 1, exposure: 'codemode' }], tools: [{ name: '<script>' + 'x'.repeat(350), active: true }] }; return { ok: true, requiresRuntimeRestart: true }; }
                    window.reads.push(url); const scope = new URL(url, location.origin).searchParams.get('scope');
                    return { cwd: '/mock/project', scope, revision: 'r1', trust: { effective: window.trusted }, autoEnableCodemode: { global: null, project: null, value: true }, servers: [{ name: 'fixture', scope, valid: true, enabled: true, exposure: 'codemode', timeout: 60, transport: 'http', config: { url: null, headers: { Authorization: null }, toolExposure: { ['long_' + 'x'.repeat(400)]: 'hidden' } }, secretFields: { url: { present: true }, 'headers.Authorization': { present: true } } }] };
                } };
                window.panel = PiMcpSettings.create(host); document.querySelector('.workspace-settings-content').append(panel.root); panel.open();
            });
            await page.getByRole('button', { name: 'Edit', exact: true }).waitFor();
            assert.equal(await page.evaluate(() => writes.length), 0);
            assert.equal(await page.getByRole('button', { name: 'Read runtime snapshot' }).isDisabled(), true);
            await page.getByRole('button', { name: 'Edit', exact: true }).click();
            await page.getByRole('button', { name: 'Save server', exact: true }).click();
            await page.getByRole('status').filter({ hasText: 'Configuration saved' }).waitFor();
            let body = await page.evaluate(() => writes[0].body);
            assert.equal(body.expectedRevision, 'r1'); assert.equal(body.config.url, undefined); assert.equal(body.config.headers, undefined); assert.equal(body.config.args, undefined); assert.equal(body.config.type, 'http');
            assert.equal(await page.getByRole('button', { name: 'Edit', exact: true }).isDisabled(), true);
            await page.getByRole('button', { name: 'Refresh saved configuration' }).click();
            await page.getByRole('button', { name: 'Edit', exact: true }).click();
            await page.locator('label').filter({ hasText: /^headers.Authorization/ }).locator('select').selectOption('replace');
            await page.getByRole('textbox', { name: 'headers.Authorization replacement', exact: true }).fill('Bearer ${MOCK_SECRET}');
            await page.locator('label').filter({ hasText: /^url ·/ }).locator('select').selectOption('remove');
            await page.evaluate(() => { window.conflict = true; });
            await page.getByRole('button', { name: 'Save server', exact: true }).click();
            await page.getByRole('status').filter({ hasText: 'Save conflicted' }).waitFor();
            body = await page.evaluate(() => writes[1].body);
            assert.deepEqual(body.config.headers.Authorization, { op: 'replace', value: 'Bearer ${MOCK_SECRET}' }); assert.deepEqual(body.config.url, { op: 'remove' });
            assert.equal(await page.getByRole('button', { name: 'Save server', exact: true }).isDisabled(), true);
            assert.equal(await page.getByRole('textbox', { name: 'headers.Authorization replacement', exact: true }).inputValue(), 'Bearer ${MOCK_SECRET}');
            assert.equal(await page.getByRole('status').textContent().then(s => s.includes('secret-error')), false);
            await page.evaluate(() => { conflict = false; trusted = false; });
            await page.getByRole('button', { name: 'Refresh saved configuration' }).click();
            await page.getByRole('combobox', { name: 'Configuration scope', exact: true }).selectOption('project');
            await page.getByText('untrusted (project read-only)', { exact: false }).waitFor();
            assert.equal(await page.getByRole('button', { name: 'Add server' }).isDisabled(), true);
            await page.evaluate(() => { selected = { id: 'mock-session', runtimeId: 'runtime-1', cwd: '/mock/project' }; panel.open(); });
            await page.getByRole('button', { name: 'Read runtime snapshot' }).click();
            await page.getByRole('button', { name: 'Reconnect', exact: true }).waitFor();
            await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
            await page.getByRole('button', { name: 'Sign in with OAuth', exact: true }).click();
            await page.getByRole('button', { name: 'Sign out of OAuth', exact: true }).click();
            assert.deepEqual(await page.evaluate(() => writes.filter(w => w.url.includes('/sessions/')).map(w => w.body.action)), ['snapshot', 'reconnect', 'login', 'logout']);
            await page.evaluate(() => { trusted = true; });
            await page.getByRole('combobox', { name: 'Configuration scope', exact: true }).selectOption('global');
            await page.getByRole('button', { name: 'Save preference', exact: true }).click();
            await page.getByRole('status').filter({ hasText: 'Configuration saved' }).waitFor();
            assert.equal(await page.evaluate(() => writes.at(-1).body.autoEnableCodemode), null);
            await page.getByRole('button', { name: 'Refresh saved configuration' }).click();
            await page.getByRole('button', { name: 'Add server', exact: true }).click();
            await page.getByRole('textbox', { name: 'Server name', exact: true }).fill('new-fixture');
            await page.locator('label').filter({ hasText: /^command ·/ }).locator('select').selectOption('replace');
            await page.getByRole('textbox', { name: 'command replacement', exact: true }).fill('mock-command');
            await page.getByRole('button', { name: 'Save server', exact: true }).click();
            await page.getByRole('status').filter({ hasText: 'Configuration saved' }).waitFor();
            assert.deepEqual(await page.evaluate(() => writes.at(-1).body.config.command), { op: 'replace', value: 'mock-command' });
            await page.getByRole('button', { name: 'Refresh saved configuration' }).click();
            await page.getByRole('button', { name: 'Remove', exact: true }).click();
            await page.getByRole('status').filter({ hasText: 'Configuration saved' }).waitFor();
            assert.equal(await page.evaluate(() => writes.at(-1).body.action), 'remove');
            await page.getByRole('button', { name: 'Refresh saved configuration' }).click();
            for (const [from, to] of [['global', 'project'], ['project', 'global']]) {
                await page.getByRole('combobox', { name: 'Configuration scope', exact: true }).selectOption(from);
                await page.getByRole('button', { name: 'Edit', exact: true }).click();
                await page.locator('label').filter({ hasText: /^headers.Authorization/ }).locator('select').selectOption('replace');
                await page.getByRole('textbox', { name: 'headers.Authorization replacement', exact: true }).fill('retained-scope-draft');
                cancelDiscard = true;
                await page.getByRole('combobox', { name: 'Configuration scope', exact: true }).selectOption(to);
                assert.equal(await page.getByRole('combobox', { name: 'Configuration scope', exact: true }).inputValue(), from);
                assert.equal(await page.getByRole('textbox', { name: 'headers.Authorization replacement', exact: true }).inputValue(), 'retained-scope-draft');
                cancelDiscard = false;
                await page.getByRole('button', { name: 'Save server', exact: true }).click();
                await page.getByRole('status').filter({ hasText: 'Configuration saved' }).waitFor();
                assert.equal(await page.evaluate(() => writes.at(-1).body.scope), from);
                await page.getByRole('button', { name: 'Refresh saved configuration' }).click();
            }
            assert.ok(await page.evaluate(() => [...document.querySelectorAll('.mcp-settings input,.mcp-settings select,.mcp-settings textarea')].every(n => parseFloat(getComputedStyle(n).fontSize) >= 16)));
            const sizes = await page.evaluate(() => [...document.querySelectorAll('body,.mcp-settings,.mcp-settings section,.mcp-settings article,input,textarea,select')].filter(n => n.getClientRects().length).map(n => ({ w: n.clientWidth, s: n.scrollWidth })));
            assert.ok(sizes.every(n => n.s <= n.w + 1), JSON.stringify(sizes));
            assert.deepEqual(errors, []); await page.close(); console.log(`MCP mock browser ${width}: passed`);
        }
    } finally { await browser.close(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); server.close(); process.exitCode = 1; });
