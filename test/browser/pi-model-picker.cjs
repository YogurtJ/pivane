const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const express = require('express');
const fs = require('node:fs'), os = require('node:os');
const { WorkspacePreferencesService } = require('../../server/workspace-preferences-service');
const favoritesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'picker-browser-'));
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { BUILTINS } = require('../../server/pi-composer-service');
const cwd = '/synthetic/model-picker';
const sessions = [{ cwd, id: 'one', name: 'Model picker' }, { cwd, id: 'two', name: 'Second session' }];
const models = Array.from({ length: 425 }, (_, index) => ({ provider: index < 200 ? 'provider-a' : 'provider-b', id: `model/${index}`, name: index === 424 ? '<img src=x onerror=alert(1)> Special model' : `Model ${index}`, input: ['text'], contextWindow: 32000 }));
models.push({ ...models[0], provider: 'other-provider' });
async function check(browser, base, width, language, theme) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: language });
    const page = await context.newPage(), errors = [], calls = [];
    const favorites = new WorkspacePreferencesService({ filePath: path.join(favoritesRoot, `${width}-${language}.json`) });
    let chosen = models[0], available = [...models], thinkingLevel = 'off', usagePercent = null, failThinking = false, running = false, socket, fail = false, held, hold = false;
    const stats = () => usagePercent === null ? {} : { contextUsage: { percent: usagePercent, tokens: usagePercent * 320, contextWindow: 32000 } };
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ cwd, language, theme }) => {
        if (!localStorage.getItem('pi.web.cwd')) {
            localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'one');
            localStorage.setItem('pivane.models.favorites', 'broken json');
        }
        localStorage.setItem('pi.workspace.language', language); localStorage.setItem('pi.workspace.theme', theme);
    }, { cwd, language, theme });
    await page.route('**/api/**', route => {
        const url = new URL(route.request().url()), send = json => route.fulfill({ json });
        if (url.pathname === '/api/pi/settings/model-favorites') return send(route.request().method() === 'POST' ? favorites.changeModelFavorites(route.request().postDataJSON()) : favorites.getModelFavorites());
        if (url.pathname === '/api/pi/status') return send({ projectRoots: ['/synthetic'], modelCatalog: true, composerTools: true });
        if (url.pathname === '/api/pi/composer/catalog') return send({ cwd, builtins: BUILTINS, templates: [], warnings: [] });
        if (url.pathname === '/api/pi/projects') return send({ projects: [{ cwd, name: 'Fixture', sessionCount: 2 }], roots: ['/synthetic'] });
        if (url.pathname === '/api/pi/sessions') return send({ sessions });
        if (url.pathname === '/api/pi/activity') return send({ runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] });
        if (url.pathname.includes('history') || url.pathname === '/api/prompts') return send([]);
        return send({ configured: false });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        let closed = false; ws.onClose(() => { closed = true; });
        ws.onMessage(raw => {
            socket = ws;
            const cmd = JSON.parse(raw); calls.push(cmd);
            const reply = (data, success = true) => { if (!closed) ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success, data, error: success ? undefined : 'Fixture selection failed' })); };
            const state = { model: chosen, thinkingLevel, isStreaming: running };
            if (cmd.type === 'open_session') return reply({ session: sessions.find(s => s.id === cmd.sessionId), state, models: { models: available }, messages: { messages: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'tool', name: 'bash', arguments: { command: 'fixture' } }] }, { role: 'toolResult', toolCallId: 'tool', toolName: 'bash', content: [{ type: 'text', text: 'Synthetic output' }] }] }, thinkingLevels: { levels: ['off', 'high'] }, stats: stats(), commands: { commands: [] } });
            if (cmd.type === 'get_state') return reply(state);
            if (cmd.type === 'get_session_stats') return reply(stats());
            if (cmd.type === 'get_available_thinking_levels') return reply({ levels: ['off', 'high'] });
            if (cmd.type === 'set_thinking_level') { if (failThinking) return reply(null, false); thinkingLevel = cmd.level; return reply({}); }
            if (cmd.type === 'refresh_models') return reply({ models: available });
            if (cmd.type === 'get_messages') return reply({ messages: [] });
            if (cmd.type === 'set_model') {
                if (fail) return reply(null, false);
                const next = models.find(m => m.provider === cmd.provider && m.id === cmd.modelId);
                if (hold) { held = () => reply(next); return; }
                chosen = next; return reply(chosen);
            }
            return reply({});
        });
    });
    await page.route(/https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)\//, route => route.abort());
    await page.goto(base);
    const button = page.locator('#pi-model-select'), dialog = page.locator('#pi-model-dialog'), search = page.locator('.pi-model-search');
    const openPicker = async () => {
        if (width <= 680) {
            await page.locator('#pi-mobile-context-trigger').click();
            await page.locator('#pi-mobile-choose-model').click();
        } else await button.click();
    };
    const switchView = async mode => {
        if (width <= 680) await page.locator('#pi-toggle-inspector').click();
        await page.locator(`[data-transcript-mode="${mode}"]`).click();
        if (width <= 680) await page.locator('#pi-close-inspector').click();
    };
    await page.waitForFunction(() => !document.querySelector('#pi-model-select').disabled);
    if (width > 680) {
        assert.equal(await page.locator('#pi-mobile-thread-title').textContent(), 'Model picker');
        assert.equal(await page.locator('#pi-project-button .pi-project-mark i').getAttribute('class'), 'fa-solid fa-folder-open');
        const banner = await page.evaluate(() => {
            const box = selector => document.querySelector(selector).getBoundingClientRect();
            return { title: box('#pi-mobile-thread-title'), status: box('#pi-connection-text'), menu: box('#pi-current-thread-menu'), modes: box('#pi-transcript-modes') };
        });
        assert.ok(banner.title.width > 0 && banner.title.right <= banner.status.left && banner.status.right <= banner.menu.left && banner.menu.right <= banner.modes.left, JSON.stringify(banner));
        await page.locator('#pi-mobile-thread-title').evaluate(node => { node.textContent = 'Long thread title '.repeat(18); });
        const longTitle = await page.locator('#pi-mobile-thread-title').evaluate(node => ({ scroll: node.scrollWidth, width: node.clientWidth, right: node.getBoundingClientRect().right, statusLeft: document.querySelector('#pi-connection-text').getBoundingClientRect().left }));
        assert.ok(longTitle.scroll > longTitle.width && longTitle.right <= longTitle.statusLeft, JSON.stringify(longTitle));
        await page.locator('#pi-mobile-thread-title').evaluate(node => { node.textContent = 'Model picker'; });
    }
    if (width <= 680) {
        await page.screenshot({ path: `/tmp/pivane-composer-idle-${width}.png` });
        await page.locator('#pi-input').focus();
        assert.equal(await page.locator('#pi-mobile-composer-summary').isVisible(), true);
        await page.screenshot({ path: `/tmp/pivane-composer-focused-${width}.png` });
        await page.setViewportSize({ width, height: 500 });
        const compact = await page.evaluate(() => {
            const input = document.querySelector('#pi-input').getBoundingClientRect();
            const ring = document.querySelector('#pi-mobile-context-trigger').getBoundingClientRect();
            const send = document.querySelector('#pi-send-button').getBoundingClientRect();
            const transcript = document.querySelector('#pi-transcript').getBoundingClientRect();
            return { inputWidth: input.width, inputBottom: input.bottom, ringRight: ring.right, sendLeft: send.left, transcriptHeight: transcript.height, scrollWidth: document.body.scrollWidth, viewport: innerWidth };
        });
        assert.ok(compact.inputWidth >= 96 && compact.ringRight <= compact.sendLeft + 1 && compact.transcriptHeight >= 80 && compact.scrollWidth <= compact.viewport, JSON.stringify(compact));
        await page.screenshot({ path: `/tmp/pivane-composer-keyboard-space-${width}.png` });
        await page.setViewportSize({ width, height: 900 });
    }
    await page.locator('#pi-input').fill('/model');
    await page.locator('#pi-input').press('Enter');
    await dialog.waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#pi-input').value === '');
    await page.locator('#pi-input').fill('Keep my draft');
    await page.locator('#pi-file-input').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('Fixture attachment') });
    await switchView('full');
    assert.equal(await page.locator('[data-tool-id="tool"]').getAttribute('data-state'), 'done');
    await switchView('reading');
    await openPicker();
    assert.equal(await dialog.locator('.pi-model-option').count(), 1, 'no full catalog on first open');
    await search.fill('other-provider');
    assert.equal(await dialog.locator('.pi-model-option').count(), 1);
    await dialog.locator('.pi-model-star').click();
    await page.waitForFunction(() => document.querySelector('.pi-model-star')?.getAttribute('aria-pressed') === 'true');
    assert.equal(calls.filter(c => c.type === 'set_model').length, 0, 'starring does not switch');
    await search.fill('model/424');
    await search.dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true });
    assert.equal(calls.filter(c => c.type === 'set_model').length, 0, 'IME confirmation does not switch');
    assert.equal(await dialog.locator('.pi-model-option').count(), 1, 'search covers past initial batch');
    assert.equal(await dialog.locator('img,script').count(), 0, 'model text stays inert');
    await dialog.locator('.pi-model-star').click();
    await page.waitForFunction(() => document.querySelector('.pi-model-star')?.getAttribute('aria-pressed') === 'true');
    await search.fill('');
    assert.equal(await dialog.locator('.pi-model-option').count(), 3, 'favorites and current deduplicated');
    await page.screenshot({ path: `/tmp/pivane-model-picker-${width}-${language}-${theme}.png` });
    await dialog.locator('.pi-model-all').click();
    assert.equal(await dialog.locator('.pi-model-option').count(), 60);
    await dialog.locator('.pi-model-more').click();
    assert.equal(await dialog.locator('.pi-model-option').count(), 120);
    await search.fill('PROVIDER-B model/424');
    await search.press('ArrowDown');
    assert.equal(await page.locator(':focus').getAttribute('class'), 'pi-model-option');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#pi-model-select').textContent.includes('Special') && !document.querySelector('#pi-model-select').disabled).catch(async error => {
        console.error({ width, chosen, calls: calls.slice(-12), errors, ui: await page.evaluate(() => ({ model: document.querySelector('#pi-model-select').textContent, disabled: document.querySelector('#pi-model-select').disabled, dialog: document.querySelector('#pi-model-dialog').open, notices: document.querySelector('#pi-toast-region').textContent, focus: document.activeElement?.className })) });
        throw error;
    });
    assert.equal(chosen.id, 'model/424'); assert.equal(chosen.provider, 'provider-b');
    assert.equal(calls.filter(c => c.type === 'prompt').length, 0);
    assert.equal(await page.locator('#pi-input').inputValue(), 'Keep my draft');
    assert.equal(await page.locator('#pi-attachments').isVisible(), true);
    // A failed switch retains the confirmed selection and recent list.
    fail = true; await openPicker(); await search.fill('provider-a model/15');
    await search.press('Enter');
    await page.locator('.pi-toast').filter({ hasText: 'Fixture selection failed' }).waitFor();
    assert.ok((await button.textContent()).includes('Special'));
    assert.ok(!(await page.evaluate(() => localStorage.getItem('pivane.models.recent'))).includes('model/15'));
    fail = false;
    await openPicker(); await page.keyboard.press('Escape');
    assert.equal(await button.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator(width <= 680 ? '#pi-mobile-context-trigger' : '#pi-model-select').evaluate(node => node === document.activeElement), true);
    await openPicker(); running = true; socket.send(JSON.stringify({ type: 'agent_start' }));
    await page.waitForFunction(() => document.querySelector('#pi-model-select').disabled && !document.querySelector('#pi-model-dialog').open);
    if (width <= 680) {
        const layout = await page.evaluate(() => {
            const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
            return { input: box('#pi-input'), ring: box('#pi-mobile-context-trigger'), send: box('#pi-send-button'), stop: box('#pi-stop-button'), delivery: box('#pi-delivery-mode'), summary: box('#pi-mobile-composer-summary') };
        });
        assert.ok(layout.input.width >= 96 && layout.ring.right <= layout.send.left + 1 && layout.send.right <= layout.stop.left + 1, JSON.stringify(layout));
        assert.ok(layout.delivery.top >= layout.summary.top && layout.delivery.bottom <= layout.summary.bottom + 1, JSON.stringify(layout));
        await page.screenshot({ path: `/tmp/pivane-composer-running-${width}.png` });
    }
    running = false; socket.send(JSON.stringify({ type: 'agent_settled' }));
    await page.waitForFunction(() => !document.querySelector('#pi-model-select').disabled);
    usagePercent = 72;
    await page.reload(); await page.waitForFunction(() => !document.querySelector('#pi-model-select').disabled);
    if (width <= 680) {
        assert.equal(await page.locator('#pi-mobile-context-percent').textContent(), '72');
        assert.equal(await page.locator('#pi-mobile-context-trigger').getAttribute('data-level'), 'warn');
        const ringMetrics = await page.locator('#pi-mobile-context-trigger').evaluate(node => ({
            visualSize: parseFloat(getComputedStyle(node, '::before').width),
            targetWidth: node.getBoundingClientRect().width,
            sendSize: document.querySelector('#pi-send-button').getBoundingClientRect().width
        }));
        assert.ok(ringMetrics.visualSize < ringMetrics.sendSize && ringMetrics.targetWidth >= ringMetrics.sendSize, JSON.stringify(ringMetrics));
        await page.locator('#pi-input').focus();
        assert.equal(await page.locator('#pi-mobile-composer-summary').isVisible(), true);
        assert.ok((await page.locator('#pi-mobile-composer-model').textContent()).includes('Special'));
        await page.locator('#pi-mobile-context-trigger').click();
        const thinkingStyle = await page.locator('#pi-mobile-thinking').evaluate(node => ({ borderWidth: getComputedStyle(node).borderTopWidth, appearance: getComputedStyle(node).appearance, fontSize: getComputedStyle(node).fontSize,
            width: node.getBoundingClientRect().width, sheetWidth: document.querySelector('#pi-mobile-session-dialog').getBoundingClientRect().width }));
        assert.equal(thinkingStyle.borderWidth, '0px');
        assert.equal(thinkingStyle.appearance, 'none');
        assert.ok(parseFloat(thinkingStyle.fontSize) >= 16 && thinkingStyle.width < thinkingStyle.sheetWidth / 2, JSON.stringify(thinkingStyle));
        assert.ok((await page.locator('#pi-mobile-composer-thinking').textContent()).includes('不启用') || (await page.locator('#pi-mobile-composer-thinking').textContent()).includes('Off'));
        assert.equal(await page.locator('#pi-mobile-project').count(), 0);
        assert.equal(await page.locator('#pi-mobile-files').count(), 0);
        assert.equal(await page.locator('#pi-mobile-history').count(), 0);
        await page.locator('#pi-mobile-thinking').selectOption('high');
        await page.waitForFunction(() => document.querySelector('#pi-mobile-composer-thinking').textContent.includes('高') || document.querySelector('#pi-mobile-composer-thinking').textContent.includes('High'));
        assert.equal(calls.filter(c => c.type === 'set_thinking_level').length, 1);
        await page.locator('#pi-mobile-session-dialog .pi-mobile-sheet-head button').click();
        await page.locator('#pi-input').focus();
        const levelBounds = await page.locator('#pi-mobile-composer-thinking').evaluate(node => ({
            left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right,
            parentRight: node.parentElement.getBoundingClientRect().right, width: node.getBoundingClientRect().width
        }));
        assert.ok(levelBounds.width > 0 && levelBounds.left >= 0 && levelBounds.right <= levelBounds.parentRight + 1, JSON.stringify(levelBounds));
        await page.locator('#pi-mobile-context-trigger').click();
        failThinking = true;
        await page.locator('#pi-mobile-thinking').selectOption('off');
        await page.locator('.pi-toast').filter({ hasText: 'Fixture selection failed' }).waitFor();
        assert.equal(await page.locator('#pi-mobile-thinking').inputValue(), 'high', 'failed change restores confirmed level');
        failThinking = false;
        const sheet = page.locator('#pi-mobile-session-dialog');
        const bounds = await sheet.evaluate(node => ({ width: node.scrollWidth, client: node.clientWidth, bottom: node.getBoundingClientRect().bottom }));
        assert.ok(bounds.width <= bounds.client + 1 && bounds.bottom <= 901, JSON.stringify(bounds));
        await page.screenshot({ path: `/tmp/pivane-mobile-session-${width}-${language}.png` });
        await page.locator('#pi-mobile-context').click();
        assert.equal(await page.locator('#pi-inspector.open #pi-inspector-details').isVisible(), true);
        await page.locator('#pi-close-inspector').click();
        await page.locator('#pi-mobile-summary').click();
        assert.equal(await page.locator('#pi-project-dialog-close').isVisible(), true);
        await page.locator('#pi-project-dialog-close').click();
        usagePercent = 93; socket.send(JSON.stringify({ type: 'agent_settled' }));
        await page.waitForFunction(() => document.querySelector('#pi-mobile-context-percent').textContent === '93');
        assert.equal(await page.locator('#pi-mobile-context-trigger').getAttribute('data-level'), 'danger');
        usagePercent = 100; socket.send(JSON.stringify({ type: 'agent_settled' }));
        await page.waitForFunction(() => document.querySelector('#pi-mobile-context-percent').textContent === '100');
        assert.equal(await page.locator('#pi-mobile-context-percent').evaluate(node => node.scrollWidth <= node.parentElement.clientWidth), true);
        usagePercent = null; socket.send(JSON.stringify({ type: 'agent_settled' }));
        await page.waitForFunction(() => document.querySelector('#pi-mobile-context-percent').textContent === '--');
        assert.equal(await page.locator('#pi-mobile-context-trigger').getAttribute('data-level'), 'unknown');
    }
    await openPicker();
    const favoriteGroup = dialog.locator('.pi-model-group').first();
    assert.equal(await favoriteGroup.locator('.pi-model-star[aria-pressed="true"]').count(), 2, 'favorites survive reload');
    assert.ok((await favoriteGroup.innerText()).indexOf('other-provider') < (await favoriteGroup.innerText()).indexOf('Special'), 'favorite order stays stable');
    assert.equal(await dialog.locator('.pi-model-option').count(), 3);
    await favoriteGroup.locator('.pi-model-star').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.pi-model-star[aria-pressed="true"]').length === 1);
    assert.equal(await dialog.locator('.pi-model-star[aria-pressed="true"]').count(), 1);
    await search.fill('no-such-model'); assert.equal(await dialog.locator('.pi-model-option').count(), 0);
    assert.ok((await dialog.locator('[role="status"]').textContent()).length > 0);
    await search.fill(''); await dialog.locator('.pi-model-all').click();
    const overflow = await page.evaluate(() => ['body', '.pi-command-bar', '.pi-runtime-controls', '#pi-model-dialog', '.pi-model-results', '.pi-model-search', '.pi-composer-wrap'].map(selector => {
        const node = document.querySelector(selector), r = node.getBoundingClientRect();
        return { selector, width: node.clientWidth, scroll: node.scrollWidth, left: r.left, right: r.right, bottom: r.bottom };
    }));
    for (const m of overflow) assert.ok(m.scroll <= m.width + 1 && m.left >= -1 && m.right <= width + 1 && (m.selector !== '#pi-model-dialog' || m.bottom <= 901), JSON.stringify(m));
    assert.ok(await dialog.locator('.pi-model-results').evaluate(node => node.scrollHeight > node.clientHeight));
    assert.ok(await search.evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 16));
    await page.keyboard.press('Escape');
    // Removed favorites do not manufacture an available model; current label remains visible.
    available = [models[0]];
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('workspace:models-changed')));
    await page.waitForFunction(() => !document.querySelector('#pi-model-select').disabled);
    await openPicker(); await search.fill('Special');
    assert.equal(await dialog.locator('.pi-model-option').count(), 0);
    assert.ok((await button.textContent()).includes('Special'));
    await page.keyboard.press('Escape');
    available = [...models];
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('workspace:models-changed')));
    await page.waitForFunction(() => !document.querySelector('#pi-model-select').disabled);
    hold = true; await openPicker(); await search.fill('provider-a model/17'); await search.press('Enter');
    assert.ok(held, 'selection request held');
    if (width < 900) { await page.locator('#pi-toggle-sessions').click(); await page.locator('#pi-session-pane.open').waitFor(); }
    await page.locator('[data-session-id="two"] .pi-session-main').click();
    await page.waitForFunction(() => !document.querySelector('#pi-model-select').disabled);
    held();
    assert.ok((await button.textContent()).includes('Special'), 'late switch from prior socket cannot replace selection');
    assert.ok(!(await page.evaluate(() => localStorage.getItem('pivane.models.recent'))).includes('model/17'));
    hold = false;
    await page.locator('#pi-input').fill('/model provider-a/model/1');
    await page.locator('#pi-input').press('Enter');
    await page.waitForFunction(() => document.querySelector('#pi-model-select .pi-model-trigger-label').textContent === 'Model 1');
    assert.equal(chosen.id, 'model/1');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, language, theme, status: 'passed', models: models.length, overflow }));
    await context.close();
}
(async () => {
    const root = path.resolve(__dirname, '../..'), app = express();
    for (const [url, folder] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use(`/vendor/${url}`, express.static(path.join(root, 'node_modules', folder)));
    app.use(express.static(process.env.PI_MODEL_PICKER_PUBLIC || path.join(root, 'public')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
    try {
        for (const [width, language, theme] of [[1440, 'zh-CN', 'daylight'], [768, 'en', 'daylight'], [393, 'zh-CN', 'dark'], [320, 'en', 'mint']].filter(([width]) => !process.env.PI_MODEL_PICKER_WIDTH || width === Number(process.env.PI_MODEL_PICKER_WIDTH))) await check(browser, base, width, language, theme);
        for (const [file, envName] of [['pi-model-onboarding.cjs', 'PI_MODEL_ONBOARDING_TEST_URL']]) {
            if (process.env.PI_MODEL_PICKER_SKIP_RELATED) continue;
            const child = spawn(process.execPath, [path.join(__dirname, file)], { env: { ...process.env, [envName]: base }, stdio: 'inherit' });
            const [code] = await once(child, 'exit'); assert.equal(code, 0, file);
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(favoritesRoot, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
