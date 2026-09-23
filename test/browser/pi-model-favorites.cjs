const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const express = require('express');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { WorkspacePreferencesService } = require('../../server/workspace-preferences-service');
const { mountSettingsRoutes } = require('../../server/routes/settings');
const root = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'favorites-devices-'));
const preferences = new WorkspacePreferencesService({ filePath: path.join(temp, 'prefs.json') });
const models = [{ provider: 'fixture', id: 'alpha', name: 'Alpha' }, { provider: 'fixture', id: 'beta', name: 'Beta' }, { provider: 'other', id: 'alpha', name: 'Alpha' }];
const key = model => JSON.stringify([model.provider, model.id]);
(async () => {
    const app = express(); app.use(express.json());
    const router = express.Router(); mountSettingsRoutes(router, { preferences }); app.use('/api/pi', router);
    app.get('/', (req, res) => res.type('html').send(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/workspace.css"><link rel="stylesheet" href="/pi-model-picker.css"><button id="picker">Choose</button><script src="/pi-i18n-catalog.js"></script><script src="/pi-i18n.js"></script><script src="/pi-model-picker.js"></script><script>
        window.picker = new PiModelPicker({ button: document.querySelector('#picker'), onSelect: () => {}, ...(!location.search.includes('old-coordinator') ? { api: async (url, options) => { const r = await fetch(url, options); if (!r.ok) throw Error('HTTP '+r.status); return r.json(); } } : {}) });
        picker.update(${JSON.stringify(models)}, ${JSON.stringify(models[0])}, false);
        </script></html>`));
    app.use(express.static(path.join(root, 'public')));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
    const errors = [];
    try {
        const mac = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en' });
        const phone = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, locale: 'en' });
        await mac.addInitScript(key => {
            Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
            if (!localStorage.getItem('fixture-seeded')) { localStorage.setItem('fixture-seeded', '1'); localStorage.setItem('pivane.models.favorites', JSON.stringify([key])); }
        }, key(models[1]));
        const desktop = await mac.newPage(), mobile = await phone.newPage();
        for (const page of [desktop, mobile]) page.on('pageerror', error => errors.push(error.message));
        await desktop.goto(base); await desktop.waitForFunction(() => picker.favoriteReady);
        assert.equal(await desktop.evaluate(() => typeof crypto.randomUUID), 'undefined', 'simulate a non-secure LAN HTTP origin');
        assert.match(await desktop.evaluate(() => localStorage.getItem('pivane.models.favoritesMigration')), /^[0-9a-f]{32}$/);
        assert.equal(await desktop.evaluate(() => localStorage.getItem('pivane.models.favoritesMigrated')), '1');
        assert.deepEqual(preferences.getModelFavorites().favorites, [{ provider: 'fixture', modelId: 'beta' }]);
        await mobile.goto(base); await mobile.waitForFunction(() => picker.favoriteReady);
        assert.equal(await mobile.evaluate(() => localStorage.getItem('pivane.models.favorites')), null, 'independent browser storage');
        await desktop.locator('#picker').click();
        assert.equal(await desktop.locator('.pi-model-search').evaluate(node => node === document.activeElement), true);
        await mobile.locator('#picker').tap();
        assert.equal(await mobile.locator('.pi-model-close').evaluate(node => node === document.activeElement), true, 'touch open does not focus an input');
        assert.equal(await mobile.locator('.pi-model-group').first().locator('.pi-model-copy strong').textContent(), 'Beta');
        await mobile.locator('.pi-model-search').tap();
        assert.equal(await mobile.locator('.pi-model-search').evaluate(node => node === document.activeElement), true, 'explicit search still focuses');
        await mobile.locator('.pi-model-search').fill('beta');
        await mobile.locator('.pi-model-star').tap();
        await mobile.waitForFunction(() => !picker.favoriteBusy && picker.favorites.length === 0).catch(async error => {
            console.error('favorites diagnostic', preferences.getModelFavorites(), await mobile.evaluate(() => ({ ready: picker.favoriteReady, busy: picker.favoriteBusy, favorites: picker.favorites, message: picker.syncMessage, focus: document.activeElement?.className })));
            throw error;
        });
        await desktop.evaluate(() => picker.refreshFavorites());
        assert.equal(await desktop.evaluate(() => picker.favorites.length), 0);
        await desktop.reload(); await desktop.waitForFunction(() => picker.favoriteReady);
        assert.equal(preferences.getModelFavorites().favorites.length, 0, 'original browser cannot resurrect its migrated copy');
        // Another late legacy device must not re-add a favorite removed elsewhere.
        const legacy = await browser.newContext();
        await legacy.addInitScript(key => localStorage.setItem('pivane.models.favorites', JSON.stringify([key])), key(models[1]));
        const late = await legacy.newPage(); await late.goto(base); await late.waitForFunction(() => picker.favoriteReady);
        assert.equal(preferences.getModelFavorites().favorites.length, 0);
        await legacy.close();
        // An older coordinator did not pass an API callback; a browser's saved
        // migration marker is insufficient proof that this instance has its copy.
        const mixed = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        await mixed.addInitScript(key => {
            localStorage.setItem('pivane.models.favorites', JSON.stringify([key]));
            localStorage.setItem('pivane.models.favoritesMigrated', '1');
        }, key(models[0]));
        const mixedPage = await mixed.newPage();
        mixedPage.on('pageerror', error => errors.push(error.message));
        await mixedPage.goto(base + '/?old-coordinator');
        await mixedPage.waitForFunction(() => picker.favoriteReady);
        assert.deepEqual(preferences.getModelFavorites().favorites, [{ provider: 'fixture', modelId: 'alpha' }]);
        assert.equal(preferences.readDocument().modelFavorites.imports.length, 3);
        const importedRevision = preferences.getModelFavorites().revision;
        await mixedPage.evaluate(() => picker.refreshFavorites());
        assert.equal(preferences.getModelFavorites().revision, importedRevision, 'reconfirm only once per page');
        await mixedPage.locator('#picker').click();
        const star = mixedPage.locator('.pi-model-star').first();
        assert.equal(await star.isDisabled(), false);
        await star.click(); await mixedPage.waitForFunction(() => picker.favorites.length === 0 && !picker.favoriteBusy);
        await star.click(); await mixedPage.waitForFunction(() => picker.favorites.length === 1 && !picker.favoriteBusy);
        await star.click(); await mixedPage.waitForFunction(() => picker.favorites.length === 0 && !picker.favoriteBusy);
        await mixed.close();
        // Independent edits preserve both providers, even when names match.
        await desktop.locator('#picker').click(); await desktop.locator('.pi-model-search').fill('other');
        await mobile.locator('.pi-model-search').fill('fixture alpha');
        await Promise.all([desktop.locator('.pi-model-star').click(), mobile.locator('.pi-model-star').tap()]);
        await Promise.all([desktop.waitForFunction(() => !picker.favoriteBusy), mobile.waitForFunction(() => !picker.favoriteBusy)]);
        assert.equal(preferences.getModelFavorites().favorites.length, 2);
        await mobile.evaluate(() => picker.refreshFavorites()); assert.equal(await mobile.evaluate(() => picker.favorites.length), 2);
        let releaseRead;
        await mobile.route('**/api/pi/settings/model-favorites', route => {
            if (route.request().method() !== 'GET') return route.continue();
            const snapshot = preferences.getModelFavorites();
            releaseRead = () => route.fulfill({ json: snapshot });
        });
        const staleRead = mobile.evaluate(() => picker.refreshFavorites());
        const deadline = Date.now() + 10000;
        while (!releaseRead && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        assert.ok(releaseRead);
        await desktop.locator('.pi-model-star').click();
        await desktop.waitForFunction(() => !picker.favoriteBusy);
        await mobile.evaluate(() => picker.setFavorite({ provider: 'fixture', id: 'beta' }, true));
        const confirmedRevision = await mobile.evaluate(() => picker.revision);
        await releaseRead(); await staleRead;
        assert.equal(await mobile.evaluate(() => picker.revision), confirmedRevision, 'late GET cannot replace a newer write response');
        await mobile.unroute('**/api/pi/settings/model-favorites');
        // A rejected write keeps confirmed data and never silently retries.
        let rejected = 0;
        await mobile.route('**/api/pi/settings/model-favorites', route => {
            if (route.request().method() === 'POST') { rejected++; return route.fulfill({ status: 503, json: { error: 'Fixture unavailable' } }); }
            return route.continue();
        });
        await mobile.locator('.pi-model-star').tap();
        await mobile.waitForFunction(() => !picker.favoriteBusy);
        assert.ok((await mobile.locator('.pi-model-status').textContent()).includes('not confirmed'));
        await mobile.evaluate(() => picker.refreshFavorites());
        assert.equal(rejected, 1); assert.equal(preferences.getModelFavorites().favorites.length, 2);
        await mobile.unroute('**/api/pi/settings/model-favorites');
        // Old backend: retain local copy and show a sync failure, without deleting it.
        const offline = await browser.newContext({ viewport: { width: 320, height: 740 }, isMobile: true, hasTouch: true });
        await offline.addInitScript(key => localStorage.setItem('pivane.models.favorites', JSON.stringify([key])), key(models[1]));
        const old = await offline.newPage();
        await old.route('**/api/pi/settings/model-favorites', route => route.fulfill({ status: 404, body: 'missing' }));
        await old.goto(base); await old.locator('#picker').tap();
        await old.waitForFunction(() => picker.syncMessage.length > 0);
        assert.equal(await old.locator('.pi-model-star').first().isDisabled(), true);
        assert.equal(await old.evaluate(() => localStorage.getItem('pivane.models.favoritesMigrated')), null);
        assert.equal(await old.locator('.pi-model-close').evaluate(node => node === document.activeElement), true);
        assert.ok(await old.locator('#pi-model-dialog').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
        await offline.close();
        assert.deepEqual(errors, []);
        console.log('PASS: non-secure HTTP UUID fallback, independent Mac/phone contexts, legacy marker reconciliation, old coordinator fallback, removal protection, concurrent edits, rejected writes, old backend, desktop/touch focus and 320px width');
        await mac.close(); await phone.close();
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
