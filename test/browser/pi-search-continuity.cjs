// In-memory search lifecycle; no live API, sessions or model requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        for (const width of [1440, 393, 320]) {
            const page = await browser.newPage({ viewport: { width, height: 740 } }), errors = [];
            page.on('pageerror', e => errors.push(e.message));
            await page.setContent(`<style>dialog{width:min(600px,85vw)}.pi-native-body{max-height:400px;overflow:auto}.pi-session-search-results button{display:block;min-height:90px;width:100%}input{font-size:16px}</style><input id="pi-session-search" value="seed"><button id="pi-search-conversations">Search</button>`);
            await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../../public/pi-session-search.js'), 'utf8') });
            await page.evaluate(() => {
                window.calls = []; window.opened = []; window.identity = 'ordinary'; window.cwd = '/one';
                window.searchFixture = new PiSessionSearch({ cwd: () => cwd, contextKey: () => identity, toast: () => {},
                    open: async (row, q) => { opened.push([row.sessionId, q]); cwd = '/two'; },
                    api: async url => {
                        calls.push(url); const p = new URL(url, 'http://fixture').searchParams, offset = Number(p.get('offset'));
                        const data = { offset, searchId: 'snapshot', total: 40, hasMore: offset === 0,
                            results: Array.from({ length: 20 }, (_, i) => ({ sessionId: String(offset + i), cwd: '/one', name: 'Thread ' + (offset + i), matches: 2, snippet: '<script>not executable</script>' })) };
                        if (window.hold) return new Promise(resolve => { window.release = () => resolve(data); });
                        return data;
                    }
                }); searchFixture.setEnabled(true); searchFixture.setArchivesEnabled(true);
            });
            const dialog = page.locator('#pi-session-search-dialog');
            await page.locator('#pi-search-conversations').click();
            await dialog.locator('input[type=search]').fill('history');
            await dialog.locator('select').selectOption('project');
            await dialog.locator('form').evaluate(f => f.requestSubmit());
            await page.waitForFunction(() => searchFixture.results.children.length === 20);
            await page.evaluate(() => searchFixture.next.click());
            await page.waitForFunction(() => searchFixture.offset === 20);
            await page.evaluate(() => { searchFixture.body.scrollTop = 650; });
            await page.waitForTimeout(50);
            const top = await page.evaluate(() => searchFixture.body.scrollTop);
            await page.evaluate(() => searchFixture.results.children[5].click());
            await page.waitForFunction(() => opened.length === 1);
            await page.locator('#pi-search-conversations').click();
            assert.equal(await dialog.locator('input[type=search]').inputValue(), 'history');
            assert.equal(await page.evaluate(() => searchFixture.offset), 20);
            assert.equal(await page.evaluate(() => searchFixture.cwd), '/one', 'project scope stays bound to original search');
            assert.equal(await page.evaluate(() => calls.length), 2, 'reopening does not rescan all sessions');
            assert.ok(Math.abs(await page.evaluate(() => searchFixture.body.scrollTop) - top) <= 2);
            await page.evaluate(() => searchFixture.results.children[6].click());
            await page.waitForFunction(() => opened.length === 2);
            await page.locator('#pi-search-conversations').click();
            await page.evaluate(() => { hold = true; searchFixture.search(0); });
            await page.waitForFunction(() => Boolean(window.release));
            await page.evaluate(() => searchFixture.dialog.close());
            await page.locator('#pi-search-conversations').click();
            await page.evaluate(() => release());
            await page.waitForTimeout(50);
            assert.equal(await page.evaluate(() => searchFixture.results.children.length), 0, 'closed request cannot populate reopened dialog');
            await page.evaluate(() => { searchFixture.dialog.close(); identity = 'assistant-2'; });
            await page.locator('#pi-search-conversations').click();
            assert.equal(await dialog.locator('input[type=search]').inputValue(), 'seed', 'identity switch clears retained results');
            await page.evaluate(() => window.dispatchEvent(new Event('workspace:access-locked')));
            assert.equal(await dialog.isVisible(), false);
            assert.equal(await page.evaluate(() => searchFixture.results.children.length), 0);
            assert.deepEqual(errors, []);
            console.log(`PASS search continuity ${width}: query/page/scroll/scope/reopen, stale request, identity and access reset`);
            await page.close();
        }
    } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
