const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { schema } = require('../../server/pi-native-service');
const fields = { ...schema, defaultTools: { ...schema.defaultTools, choices: ['read', 'bash', 'edit', 'write', 'codemode', 'tool_search'], defaults: ['read', 'bash', 'edit', 'write'] } };
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/pi-native-settings.css"><style>body{margin:8px}*{box-sizing:border-box}label{display:flex;flex-direction:column}input,select,textarea{max-width:100%;font-size:16px}small,p,button{overflow-wrap:anywhere}button{max-width:100%;white-space:normal}.native-save-row{flex-wrap:wrap}</style><div id="workspace-settings-dialog"><div id="native-settings-panel"></div><div id="native-installed"></div><div id="native-settings-nav"></div><div id="system-prompts-nav"></div></div><script src="/pi-native-settings.js"></script>`;
const server = http.createServer((req, res) => {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
    const allowed = { '/pi-native-settings.js': 'application/javascript', '/pi-native-settings.css': 'text/css' };
    if (!allowed[req.url]) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', allowed[req.url]); res.end(fs.readFileSync(path.join(__dirname, '../../public', req.url.slice(1))));
});
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        for (const width of [1440, 393, 320]) {
            const page = await browser.newPage({ viewport: { width, height: 900 } });
            const errors = []; page.on('pageerror', error => errors.push(error.message));
            await page.goto(`http://127.0.0.1:${server.address().port}`);
            await page.evaluate(({ fields }) => {
                const custom = 'fixture_' + 'long'.repeat(100);
                window.writes = []; window.conflict = false; window.trusted = true;
                const values = { global: { defaultTools: [custom, '+codemode', '-bash', '+tool_search', '-codemode', '+codemode'] }, project: { defaultTools: ['-bash', '+codemode'] } };
                const snapshot = () => ({ cwd: '/fixture', revision: 'r1', trust: { effective: window.trusted, override: null }, schema: fields, environment: {}, settings: Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, { global: values.global[k] ?? null, project: values.project[k] ?? null, source: 'global', value: k === 'defaultTools' ? [custom, 'codemode', 'tool_search'] : f.type === 'select' ? f.choices[0] : f.type === 'number' ? 3000 : f.type === 'boolean' ? true : [] }])) });
                window.ui = PiNativeSettings.create({ currentCwd: () => '/fixture', apiFetch: async (url, options) => {
                    if (url === '/api/pi/status') return { nativeSettings: true };
                    if (options) { const data = JSON.parse(options.body); window.writes.push(data); if (window.conflict) throw Error('Controlled conflict'); Object.assign(values[data.scope], data.values); return { ok: true }; }
                    return snapshot();
                } });
                return window.ui.open('native');
            }, { fields });
            await page.locator('[data-group="tools"] summary').click();
            assert.equal(await page.locator('#native-tools-mode').inputValue(), 'entries');
            const original = await page.locator('#native-tools-entries').inputValue();
            // Saving an unrelated Codemode field must not materialize or strip the selection.
            await page.locator('[name="codemode.mode"]').selectOption('only');
            await page.locator('#native-settings-save').click();
            await page.waitForFunction(() => window.writes.length === 1);
            assert.deepEqual(await page.evaluate(() => window.writes[0].values), { 'codemode.mode': 'only' });
            await page.locator('#native-tools-entries').fill(original + '\n-fixture_other\n+fixture_other');
            await page.locator('#native-settings-save').click();
            await page.waitForFunction(() => window.writes.length === 2);
            const sent = await page.evaluate(() => window.writes[1].values.defaultTools);
            assert.deepEqual(sent, (original + '\n-fixture_other\n+fixture_other').split('\n'));
            await page.locator('#native-tools-mode').selectOption('custom');
            assert.ok(await page.locator('.native-tool-options input[value="codemode"]').isChecked());
            while (await page.locator('.native-tool-options input:checked').count()) await page.locator('.native-tool-options input:checked').first().uncheck();
            await page.locator('#native-settings-save').click();
            await page.waitForFunction(() => window.writes.length === 3);
            assert.deepEqual(await page.evaluate(() => window.writes[2].values.defaultTools), []);
            await page.locator('#native-settings-scope').selectOption('project');
            await page.locator('#native-tools-mode').selectOption('inherit');
            await page.locator('#native-settings-save').click();
            await page.waitForFunction(() => window.writes.length === 4);
            assert.equal(await page.evaluate(() => window.writes[3].values.defaultTools), null);
            await page.locator('#native-tools-mode').selectOption('entries');
            await page.locator('#native-tools-entries').fill('+tool_search\n-bash');
            await page.evaluate(() => { window.conflict = true; });
            await page.locator('#native-settings-save').click();
            await page.locator('#native-status').filter({ hasText: 'Controlled conflict' }).waitFor();
            assert.equal(await page.locator('#native-tools-entries').inputValue(), '+tool_search\n-bash');
            await page.evaluate(async () => { window.trusted = false; await window.ui.open('native'); });
            await page.locator('#native-settings-scope').selectOption('project');
            assert.ok(await page.locator('#native-settings-save').isDisabled());
            assert.ok(await page.locator('#native-tools-entries').isDisabled());
            assert.ok(await page.locator('[name="codemode.mode"]').isDisabled());
            const sizes = await page.evaluate(() => [...document.querySelectorAll('body,.native-grid,.native-tool-field,.native-tool-options,#native-tools-entries')].filter(e => e.getClientRects().length).map(e => ({ name: e.className || e.id || e.tagName, width: e.clientWidth, scroll: e.scrollWidth })));
            assert.ok(sizes.every(s => s.scroll <= s.width + 1), JSON.stringify(sizes));
            assert.deepEqual(errors, []); await page.close();
            console.log(`native tool settings ${width}px passed`);
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
