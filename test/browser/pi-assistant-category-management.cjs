// Synthetic loopback JSON parsing and shell UI only; no real identity/model calls.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const cwd = '/fixture/work', profileId = '11111111-1111-4111-8111-111111111111';
const emptyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', busyId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const evidence = process.env.PI_CATEGORY_EVIDENCE || '/tmp/pivane-category-management';
(async () => {
    const app = express(); app.use(express.json());
    let profiles, groups, revision, writes, gate, release;
    const reset = () => {
        profiles = [{ id: profileId, name: 'Study partner', enabled: true }];
        groups = [emptyId, busyId].map((id, index) => ({ id, name: index ? 'Shared category' : 'Accidental empty category / 误建的空分类', cwd,
            description: '', instructions: '', profileIds: [profileId], archived: false }));
        revision = 'r1'; writes = []; gate = false;
    };
    app.delete('/api/pi/assistant-projects/:id', async (req, res) => {
        writes.push({ body: req.body, id: req.params.id, type: req.get('Content-Type') });
        if (!req.body?.expectedRevision) return res.status(400).json({ error: 'Missing parsed JSON' });
        if (gate) await new Promise(resolve => { release = resolve; });
        if (req.params.id === busyId) return res.status(409).json({ error: '此分类仍有其他助手的会话，不能删除' });
        if (req.body.expectedRevision !== revision) return res.status(409).json({ error: '分类已变化' });
        groups = groups.filter(group => group.id !== req.params.id); revision = 'r2';
        res.json({ ok: true, deletedId: req.params.id, revision });
    });
    app.get('/api/pi/status', (req, res) => res.json({ ok: true, agentProfiles: true, assistantProjects: true, projectRoots: ['/fixture'], defaultProject: cwd }));
    app.get('/api/pi/profiles', (req, res) => res.json({ version: 1, revision: 'profiles1', profiles }));
    app.get('/api/pi/assistant-projects', (req, res) => res.json({ version: 1, revision, projects: groups }));
    app.get('/api/pi/projects', (req, res) => res.json({ projects: [{ cwd, name: 'Fixture' }], roots: ['/fixture'] }));
    app.get('/api/pi/sessions', (req, res) => res.json({ sessions: [] }));
    app.get('/api/pi/activity', (req, res) => res.json({ runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] }));
    app.use('/api', (req, res) => res.json({}));
    app.use(express.static(path.join(__dirname, '../../public')));
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
    fs.mkdirSync(evidence, { recursive: true });
    try {
        for (const width of [1440, 393, 320]) for (const language of ['zh-CN', 'en']) {
            reset();
            const context = await browser.newContext({ viewport: { width, height: 900 }, locale: language, isMobile: width < 900, hasTouch: width < 900 });
            const page = await context.newPage(), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.route('**/pi-agent-profiles.js', route => route.fulfill({ contentType: 'text/javascript',
                body: 'globalThis.PiAgentProfiles={create:()=>({setEnabled(){},open(options){window.__identityOptions=options},close(){},displaySession(){},setLoadedProfile(){},projectChanged(){}})};' }));
            const base = `http://127.0.0.1:${server.address().port}`;
            const assistant = async () => {
                await page.goto(`${base}/#/assistant?profileId=${profileId}`);
                await page.locator(`[data-assistant-project-id="${emptyId}"]`).waitFor({ state: 'attached' });
                if (width < 900 && !await page.locator('#pi-session-pane').evaluate(node => node.classList.contains('open'))) await page.locator('#pi-toggle-sessions').click();
            };
            await assistant();
            await page.locator('#pi-assistant-manage-profiles').click();
            await page.waitForFunction(id => location.hash.includes('/profiles') && window.__identityOptions?.profileId === id, profileId);
            assert.equal(await page.locator('#pi-session-pane').evaluate(node => node.classList.contains('open')), false, 'mobile drawer closes for identity navigation');
            await assistant();
            await page.locator(`[data-assistant-project-id="${emptyId}"] [data-assistant-action=menu]`).click();
            const edit = language === 'en' ? 'Edit project' : '编辑项目';
            await page.getByRole('menuitem', { name: edit, exact: true }).click();
            const editor = page.locator('.pi-assistant-project-editor');
            await editor.locator('[data-delete]').click();
            const confirm = page.locator('.pi-profile-confirm');
            assert.match(await confirm.textContent(), /folder and files|目录和文件/);
            await page.keyboard.press('Escape');
            assert.equal(writes.length, 0); assert.equal(await editor.isVisible(), true);
            await editor.locator('[data-delete]').click();
            for (const theme of ['daylight', 'mint', 'dark']) {
                await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
                const bounds = await confirm.boundingBox();
                assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
                assert.equal(await page.evaluate(() => document.body.scrollWidth <= innerWidth), true);
                await page.screenshot({ path: path.join(evidence, `delete-${width}-${language}-${theme}.png`) });
            }
            gate = true;
            await confirm.locator('.pi-profile-confirm-discard').click();
            await page.waitForFunction(() => document.querySelector('.pi-assistant-project-editor [data-status]').textContent.includes('…'));
            assert.equal(await editor.locator('[data-delete]').isDisabled(), true);
            assert.equal(await editor.locator('[data-close]').isDisabled(), true);
            await page.keyboard.press('Escape'); assert.equal(await editor.isVisible(), true);
            assert.equal(writes.length, 1); assert.match(writes[0].type, /application\/json/);
            assert.deepEqual(writes[0].body, { expectedRevision: 'r1' });
            assert.equal(typeof release, 'function'); release(); gate = false;
            await editor.waitFor({ state: 'hidden' });
            await page.locator(`[data-assistant-project-id="${emptyId}"]`).waitFor({ state: 'detached' });
            await page.locator(`[data-assistant-project-id="${busyId}"] [data-assistant-action=menu]`).click();
            await page.getByRole('menuitem', { name: edit, exact: true }).click();
            await editor.locator('[data-delete]').click(); await confirm.locator('.pi-profile-confirm-discard').click();
            await editor.locator('[data-status]').filter({ hasText: '其他助手' }).waitFor();
            assert.equal(await editor.locator('[data-delete]').isDisabled(), true);
            assert.equal(await editor.isVisible(), true); await editor.locator('[data-close]').click();
            await page.locator('#pi-assistant-add-project').click();
            assert.equal(await editor.locator('[data-delete]').isVisible(), false, 'new unsaved category cannot be deleted');
            await editor.locator('[data-close]').click();
            profiles = []; groups = [];
            await page.goto(`${base}/#/assistant`);
            if (width < 900 && !await page.locator('#pi-session-pane').evaluate(node => node.classList.contains('open'))) await page.locator('#pi-toggle-sessions').click();
            await page.waitForFunction(() => document.querySelector('#pi-assistant-profile').disabled);
            assert.match(await page.locator('#pi-assistant-manage-profiles').textContent(), /Add assistant|添加助手/);
            await page.screenshot({ path: path.join(evidence, `empty-${width}-${language}.png`) });
            await page.locator('#pi-assistant-manage-profiles').click();
            await page.waitForFunction(() => location.hash.includes('/profiles'));
            assert.deepEqual(errors, []);
            console.log(JSON.stringify({ width, language, writes: writes.length, parsedJSON: true, pageerrors: errors.length, status: 'passed' }));
            await context.close();
        }
    } finally { release?.(); await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
