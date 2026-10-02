const assert = require('node:assert/strict'), http = require('node:http'), path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..'), cwd = '/synthetic/speed';
const models = ['ordinary', 'fast-only', 'accelerated'].map(id => ({ provider: 'fixture', id, name: id, input: ['text'], contextWindow: 128000, maxTokens: 16384, thinkingLevels: ['off', 'high'], speedSupported: true }));
const modes = { fast: { serviceTier: 'priority', costMultiplier: 2.5 }, ultrafast: { serviceTier: 'ultrafast', costMultiplier: 6 } };
async function run(browser, base, width, language, theme) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: language, isMobile: width <= 680, hasTouch: width <= 680 });
    const page = await context.newPage(), errors = [], calls = [], writes = [];
    let chosen = models[0], level = 'auto', revision = 0, socket, held, hold = false, fail = false, running = false;
    const capability = model => ({ levels: model.id === 'ordinary' ? [] : model.id === 'fast-only' ? ['auto', 'standard', 'fast'] : ['auto', 'standard', 'fast', 'ultrafast'],
        modes: model.id === 'ordinary' ? {} : model.id === 'fast-only' ? { fast: modes.fast } : modes, defaultLevel: 'auto' });
    const state = () => ({ model: chosen, thinkingLevel: 'high', isStreaming: running,
        webSpeed: { ...capability(chosen), runtimeId: 'fixture-runtime', revision, provider: chosen.provider, modelId: chosen.id, level } });
    const catalog = { revision: 'configuration-1', modelSpeed: true, modelThinking: true, preferences: { modelThinkingLevels: {} },
        providers: [{ id: 'fixture', name: 'Fixture', configured: true, authMethods: {} }],
        models: models.map(model => ({ ...model, available: true, speed: capability(model), thinkingLevelMap: {} })), customProviders: [] };
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ cwd, language, theme }) => {
        localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'one');
        localStorage.setItem('pi.workspace.language', language); localStorage.setItem('pi.workspace.theme', theme);
    }, { cwd, language, theme });
    await page.route('**/api/**', route => {
        const pathname = new URL(route.request().url()).pathname, send = json => route.fulfill({ json });
        if (pathname === '/api/pi/settings/models') return send(catalog);
        if (pathname === '/api/pi/settings/models/speed') {
            const body = route.request().postDataJSON(); writes.push(body);
            if (body.expectedRevision !== catalog.revision) return route.fulfill({ status: 409, json: { error: 'Fixture configuration changed' } });
            catalog.revision += '-next'; const model = catalog.models.find(m => m.id === body.modelId);
            model.speed = body.speed ? { ...body.speed, levels: ['auto', 'standard', ...Object.keys(body.speed.modes)] } : capability(model);
            return send({ ok: true });
        }
        if (pathname === '/api/pi/settings/model-favorites') return send({ models: [], revision: 'favorites', migrationReceipts: [] });
        if (pathname === '/api/pi/status') return send({ projectRoots: ['/synthetic'], modelCatalog: true });
        if (pathname === '/api/pi/projects') return send({ projects: [{ cwd, name: 'Fixture', sessionCount: 1 }], roots: ['/synthetic'] });
        if (pathname === '/api/pi/sessions') return send({ sessions: [{ cwd, id: 'one', name: 'Speed fixture' }] });
        if (pathname === '/api/pi/activity') return send({ runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] });
        if (pathname.includes('history') || pathname === '/api/prompts') return send([]);
        return send({ configured: false });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        let closed = false; ws.onClose(() => { closed = true; }); socket = ws;
        ws.onMessage(raw => {
            const command = JSON.parse(raw); calls.push(command);
            const reply = (data, success = true) => { if (!closed) ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success, data, error: success ? undefined : 'Fixture speed rejected' })); };
            if (command.type === 'open_session') return reply({ session: { cwd, id: 'one', name: 'Speed fixture' }, state: state(),
                models: { models }, messages: { messages: [{ role: 'assistant', model: 'accelerated', content: [{ type: 'text', text: 'Synthetic reply' }],
                    pivaneSpeed: { requested: 'ultrafast', serviceTier: 'default', costMultiplier: 1 } },
                    { role: 'assistant', content: [{ type: 'toolCall', id: 'tool', name: 'bash', arguments: { command: 'fixture' } }] },
                    { role: 'toolResult', toolCallId: 'tool', toolName: 'bash', content: [{ type: 'text', text: 'Fixture output' }] }] },
                thinkingLevels: { levels: ['off', 'high'] }, commands: { commands: [] }, stats: {} });
            if (['refresh_models', 'get_available_models'].includes(command.type)) return reply({ models });
            if (command.type === 'get_state') return reply(state());
            if (command.type === 'get_session_stats') return reply({});
            if (command.type === 'get_available_thinking_levels') return reply({ levels: ['off', 'high'] });
            if (command.type === 'set_model') { chosen = models.find(m => m.id === command.modelId); level = 'auto'; revision++; return reply(chosen); }
            if (command.type === 'set_model_speed') {
                const finish = () => { if (fail) return reply(null, false); level = command.level; revision++;
                    if (!closed) ws.send(JSON.stringify({ type: 'gateway_model_speed', speed: state().webSpeed })); reply(state().webSpeed); };
                if (hold) { held = finish; return; } return finish();
            }
            return reply({});
        });
    });
    await page.route(/https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)\//, route => route.abort());
    await page.goto(base);
    await page.waitForFunction(() => !document.querySelector('#pi-model-select').disabled, null, { timeout: 10000 }).catch(async error => {
        console.error({ errors, calls: calls.map(c => c.type), text: (await page.locator('body').innerText()).slice(-2000) }); throw error;
    });
    const initialRefreshes = calls.filter(c => c.type === 'refresh_models').length;
    assert.equal(await page.locator('.pi-speed-field').isVisible(), false);
    assert.equal(await page.locator('.pi-message-speed').first().textContent(), language === 'en' ? 'Standard' : '标准 Standard');
    const openSheet = async () => { if (width <= 680 && !await page.locator('#pi-mobile-session-dialog').isVisible()) await page.locator('#pi-mobile-context-trigger').click(); };
    const choose = async id => {
        if (width <= 680) { await openSheet(); await page.locator('#pi-mobile-choose-model').click(); } else await page.locator('#pi-model-select').click();
        await page.locator('.pi-model-search').fill(id);
        await page.locator('.pi-model-option').first().click();
        await page.waitForFunction(id => document.querySelector('#pi-model-select').textContent.includes(id), id);
        await page.waitForFunction(() => !document.querySelector('#pi-model-select').disabled);
    };
    await choose('fast-only'); await openSheet();
    const selector = page.locator(width <= 680 ? '#pi-mobile-speed' : '#pi-speed-select');
    await selector.waitFor(); assert.deepEqual(await selector.locator('option').evaluateAll(nodes => nodes.map(n => n.value)), ['auto', 'standard', 'fast']);
    await selector.selectOption('fast'); await page.waitForFunction(() => document.querySelector('#pi-speed-select').value === 'fast' && !document.querySelector('#pi-speed-select').disabled);
    assert.equal(calls.filter(c => c.type === 'set_model_speed').length, 1);
    assert.ok((await (width <= 680 ? page.locator('.pi-mobile-speed-cost') : selector).innerText()).includes('2.5'));
    if (width <= 680) await page.locator('#pi-mobile-session-dialog .pi-mobile-sheet-head button').click();
    await choose('accelerated'); await openSheet();
    assert.equal(await selector.locator('option[value="ultrafast"]').count(), 1);
    hold = true; await selector.selectOption('ultrafast');
    await page.waitForFunction(() => document.querySelector('#pi-speed-select').disabled);
    assert.equal(await page.locator('#pi-thinking-select').isDisabled(), true);
    assert.equal(calls.filter(c => c.type === 'set_model_speed').length, 2);
    held(); hold = false;
    await page.waitForFunction(() => document.querySelector('#pi-speed-select').value === 'ultrafast' && !document.querySelector('#pi-speed-select').disabled);
    if (width <= 680) {
        const mobile = await selector.evaluate(node => ({ font: parseFloat(getComputedStyle(node).fontSize), width: node.getBoundingClientRect().width,
            sheetWidth: document.querySelector('#pi-mobile-session-dialog').clientWidth }));
        assert.ok(mobile.font >= 16 && mobile.width < mobile.sheetWidth, JSON.stringify(mobile));
        await page.locator('#pi-mobile-session-dialog .pi-mobile-sheet-head button').click(); await page.locator('#pi-input').focus();
        assert.ok((await page.locator('#pi-mobile-composer-speed').textContent()).includes('Ultrafast'));
        await openSheet();
    }
    fail = true; await selector.selectOption('standard'); await page.locator('.pi-toast').filter({ hasText: 'Fixture speed rejected' }).waitFor();
    assert.equal(await selector.inputValue(), 'ultrafast'); fail = false;
    running = true; socket.send(JSON.stringify({ type: 'agent_start' })); await page.waitForFunction(() => document.querySelector('#pi-speed-select').disabled);
    running = false; socket.send(JSON.stringify({ type: 'agent_settled' })); await page.waitForFunction(() => !document.querySelector('#pi-speed-select').disabled);
    assert.equal(calls.filter(c => c.type === 'prompt').length, 0);
    assert.equal(calls.filter(c => c.type === 'refresh_models').length, initialRefreshes, 'speed adds no discovery requests');
    const metrics = await page.evaluate(() => ['body', '.pi-composer-wrap', '.pi-composer-models', '#pi-mobile-session-dialog'].map(selector => {
        const node = document.querySelector(selector), bounds = node.getBoundingClientRect(); return { selector, width: node.clientWidth, scroll: node.scrollWidth, right: bounds.right }; }));
    for (const metric of metrics.filter(m => m.width)) assert.ok(metric.scroll <= metric.width + 1 && metric.right <= width + 1, JSON.stringify(metric));
    await page.screenshot({ path: `/tmp/pivane-speed-${width}-${language}.png` });
    await page.reload(); await page.waitForFunction(() => document.querySelector('#pi-speed-select').value === 'ultrafast');
    await choose('ordinary'); assert.equal(await page.locator('.pi-speed-field').isVisible(), false); await openSheet(); assert.equal(await page.locator('.pi-mobile-speed').isVisible(), false);
    if (width <= 680) await page.locator('#pi-mobile-session-dialog .pi-mobile-sheet-head button').click();
    await page.locator('#workspace-settings-toggle').click();
    await page.locator('.settings-model-group summary').first().click();
    await page.locator('.model-row[data-model-id="accelerated"] [data-action="speed"]').click();
    const form = page.locator('#settings-speed-form'); await form.waitFor();
    assert.equal(writes.length, 0);
    await form.locator('select[name="level"]').selectOption('ultrafast');
    await form.locator('details').evaluate(node => { node.open = true; });
    await form.locator('input[name="fastMultiplier"]').fill('3');
    await form.locator('[type="submit"]').click();
    await form.waitFor({ state: 'hidden' }); assert.equal(writes.length, 1); assert.equal(writes[0].speed.defaultLevel, 'ultrafast'); assert.equal(writes[0].speed.modes.fast.costMultiplier, 3);
    assert.deepEqual(errors, []); console.log(JSON.stringify({ width, language, theme, status: 'passed', speedRequests: calls.filter(c => c.type === 'set_model_speed').length }));
    await context.close();
}
(async () => {
    const app = express(); for (const [name, folder] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use('/vendor/' + name, express.static(path.join(root, 'node_modules', folder)));
    app.use(express.static(path.join(root, 'public'))); const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try { for (const [width, language, theme] of [[1440, 'zh-CN', 'daylight'], [768, 'en', 'daylight'], [393, 'zh-CN', 'dark'], [320, 'en', 'mint']]) await run(browser, `http://127.0.0.1:${server.address().port}`, width, language, theme); }
    finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
