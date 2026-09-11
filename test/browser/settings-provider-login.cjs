const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.PI_SETTINGS_TEST_URL || 'http://127.0.0.1:3110';
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
async function run(browser, viewport, theme) {
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 900, hasTouch: viewport.width < 900 });
    const page = await context.newPage(); const errors = [], writes = [];
    const catalog = { providerLogin: true, modelThinking: true, revision: 'fixture-revision', thinkingMapKeys: levels,
        preferences: { defaultProvider: 'openai', defaultModel: 'org/model:free', defaultThinkingLevel: 'medium', modelThinkingLevels: {}, mediaAgent: {} },
        providers: [
            { id: 'openai', name: 'OpenAI', configured: true, storedCredential: 'api_key', authSource: 'stored', modelCount: 1, authMethods: { apiKey: true, apiKeyLogin: true } },
            { id: 'openai-codex', name: 'ChatGPT Codex', configured: false, modelCount: 1, authMethods: { oauth: true, oauthLabel: 'OAuth 登录' } },
            { id: 'empty-native', name: 'Empty native provider', configured: false, modelCount: 0, authMethods: { apiKey: true, apiKeyLogin: true } }
        ], models: [
            { provider: 'openai', id: 'org/model:free', name: 'Fixture model', reasoning: true, available: true, input: ['text'], contextWindow: 128000, thinkingLevels: ['off', 'high', 'max'], thinkingLevelMap: { minimal: null, low: null, medium: null, max: 'maximum' } },
            { provider: 'openai-codex', id: 'fixture-codex', name: 'Codex model', reasoning: true, available: false, input: ['text', 'image'], contextWindow: 200000, thinkingLevels: ['high'], thinkingLevelMap: { off: null } }
        ], customProviders: [] };
    let flow, sequence = 0, lateStart = false, releaseStart, rejectAnswer = false, conflict = false;
    const prompt = (type, id = 'step1') => ({ id, type, message: type === 'secret' ? '<script>secret field</script>' : type === 'manual_code' ? '粘贴回调 URL' : type === 'text' ? '账户 ID' : '选择登录方式', options: type === 'select' ? [{ id: 'browser', label: '浏览器授权' }, { id: 'device', label: '设备码' }] : undefined });
    const snapshot = () => structuredClone(flow);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(theme => localStorage.setItem('pi.workspace.theme', theme), theme);
    await page.route('**/api/**', async route => {
        const request = route.request(), pathname = new URL(request.url()).pathname;
        const body = request.postData() ? request.postDataJSON() : {};
        if (request.method() !== 'GET') writes.push({ pathname, method: request.method(), body });
        if (pathname === '/api/pi/settings/models') return route.fulfill({ json: catalog });
        if (/\/providers\/[^/]+\/login$/.test(pathname)) {
            flow = { id: `login-${++sequence}`, revision: 1, providerId: pathname.split('/').at(-2), method: body.method, status: 'waiting', finished: false, events: [], prompts: [prompt(body.method === 'oauth' ? 'select' : 'secret')] };
            const initial = snapshot();
            if (lateStart) await new Promise(resolve => { releaseStart = resolve; });
            return route.fulfill({ json: initial });
        }
        if (pathname.includes('/settings/login/')) {
            if (pathname.endsWith('/answer')) {
                if (rejectAnswer) return route.fulfill({ status: 409, json: { error: '步骤失效' } });
                if (body.promptId === 'step1') {
                    flow.revision++;
                    flow.prompts = [prompt(flow.method === 'oauth' ? 'manual_code' : 'text', 'step2')];
                    flow.events = flow.method === 'oauth' ? [
                        { type: 'auth_url', url: 'https://example.com/oauth?state=fixture', instructions: '<img src=x onerror=alert(1)>' },
                        { type: 'device_code', userCode: 'ABCD-1234', verificationUri: 'https://example.com/device' },
                        { type: 'auth_url', url: 'javascript:alert(1)' }
                    ] : [];
                } else { flow.status = 'success'; flow.finished = true; flow.prompts = []; flow.events = []; flow.revision++; }
            } else if (request.method() === 'DELETE') {
                flow.status = 'cancelled'; flow.finished = true; flow.prompts = []; flow.events = []; flow.revision++;
            }
            return route.fulfill({ json: snapshot() });
        }
        if (pathname === '/api/pi/settings/models/thinking') {
            if (conflict) return route.fulfill({ status: 409, json: { error: '配置已变化，请刷新后再保存' } });
            catalog.revision += '-next';
            if (Object.hasOwn(body, 'defaultThinkingLevel')) catalog.preferences.modelThinkingLevels[`${body.provider}/${body.modelId}`] = body.defaultThinkingLevel;
            return route.fulfill({ json: { ok: true } });
        }
        if (pathname === '/api/pi/status') return route.fulfill({ json: { ok: true, projectRoots: ['/tmp'] } });
        if (pathname === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd: '/tmp/settings-fixture', name: 'Settings fixture', sessionCount: 0 }], roots: ['/tmp'] } });
        if (pathname === '/api/pi/sessions') return route.fulfill({ json: { sessions: [] } });
        if (pathname === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] } });
        if (pathname === '/api/pi/settings/resources') return route.fulfill({ json: { packages: [], resources: { extensions: [], skills: [], prompts: [], themes: [] }, skills: [], diagnostics: [], settings: {} } });
        if (pathname.includes('history') || pathname === '/api/prompts') return route.fulfill({ json: [] });
        return route.fulfill({ json: {} });
    });
    await page.routeWebSocket('**/api/pi/ws', () => { throw new Error('Settings must not open a session'); });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('#workspace-settings-toggle').click();
    await page.locator('.settings-model-group').first().waitFor();
    assert.equal(await page.locator('.settings-model-group').count(), 3);
    assert.equal(await page.locator('#settings-provider-configured').isChecked(), false);
    assert.equal(await page.locator('#settings-model-available').isChecked(), false);
    const group = provider => page.locator('.settings-model-group').filter({ has: page.locator(`summary[data-provider="${provider}"]`) });
    const width = async () => {
        const metrics = await page.evaluate(() => ['body', '.workspace-settings-dialog', '.workspace-settings-content', '[data-settings-panel="providers"]', '#settings-model-list', '.settings-editor-dialog', '.settings-editor-body'].map(selector => {
            const element = document.querySelector(selector); return { selector, width: element.clientWidth, scroll: element.scrollWidth };
        }));
        for (const metric of metrics) assert.ok(metric.scroll <= metric.width + 1, `${viewport.width}: ${JSON.stringify(metric)}`);
    };
    await width();
    await page.locator('#settings-provider-configured').check();
    assert.equal(await page.locator('.settings-model-group').count(), 1);
    await page.locator('#settings-provider-configured').uncheck();
    await page.locator('#settings-model-search').fill('empty-native');
    assert.equal(await page.locator('.settings-model-group').count(), 1);
    assert.ok(await group('empty-native').locator('[data-action="key"]').isVisible());
    await page.locator('#settings-model-search').fill('');
    await group('openai').locator('summary').click();
    await group('openai').locator('[data-action="key"]').click();
    const fields = page.locator('#settings-login-prompts');
    await fields.locator('input').waitFor();
    assert.equal(await fields.locator('input').getAttribute('type'), 'password');
    assert.equal(await fields.locator('script').count(), 0);
    assert.equal(await fields.locator('input').inputValue(), '');
    await page.locator('.settings-login > [data-editor-cancel]').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('#workspace-settings-editor-close').evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator('.settings-login > [data-editor-cancel]').evaluate(element => element === document.activeElement), true);
    await fields.locator('input').fill('browser-test-key');
    flow.revision++; flow.events.push({ type: 'progress', message: '更新进度' });
    await page.waitForFunction(() => document.getElementById('settings-login-events').textContent.includes('更新进度'));
    assert.equal(await fields.locator('input').inputValue(), 'browser-test-key', 'poll does not erase typed secrets');
    await fields.locator('button').click();
    await fields.locator('[data-prompt-id="step2"]').waitFor();
    await fields.locator('input').fill('fixture-account');
    await fields.locator('button').click();
    await page.waitForFunction(() => document.getElementById('settings-login-status').textContent.includes('连接成功'));
    await page.locator('#workspace-settings-editor-close').click();
    await group('openai-codex').locator('summary').click();
    await group('openai-codex').locator('[data-action="oauth"]').click();
    await fields.locator('select').waitFor();
    await fields.locator('select').selectOption('device');
    await fields.locator('button').click();
    await fields.locator('input').waitFor();
    assert.equal(await fields.locator('input').getAttribute('type'), 'password');
    assert.equal(await page.locator('#settings-login-events a').count(), 2);
    assert.equal(await page.locator('#settings-login-events img').count(), 0);
    assert.ok((await page.locator('#settings-login-events').textContent()).includes('ABCD-1234'));
    await width();
    await page.screenshot({ path: `/tmp/pi-settings-login-${viewport.width}-${theme}.png` });
    const oldId = flow.id;
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('workspace-settings-editor').classList.contains('hidden'));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(writes.some(item => item.method === 'DELETE' && item.pathname.endsWith(oldId)));
    assert.equal(await page.locator('#workspace-settings-editor-body').textContent(), '');
    // Start response arriving after close is cancelled, never repopulates another editor.
    lateStart = true;
    await group('openai-codex').locator('[data-action="oauth"]').click();
    await page.waitForFunction(() => document.getElementById('settings-login-status'));
    for (let n = 0; !releaseStart && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 10));
    await page.locator('#workspace-settings-editor-close').click();
    releaseStart(); lateStart = false;
    for (let n = 0; !flow.finished && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(flow.status, 'cancelled');
    assert.equal(await page.locator('#workspace-settings-editor-body').textContent(), '');
    // A rejected answer stays visible and is not retried by polling.
    await group('openai-codex').locator('[data-action="oauth"]').click();
    await fields.locator('select').waitFor(); rejectAnswer = true;
    const answersBefore = writes.filter(item => item.pathname.endsWith('/answer')).length;
    await fields.locator('button').click();
    await page.waitForFunction(() => document.getElementById('settings-login-error').textContent.includes('步骤失效'));
    flow.revision++; flow.events.push({ type: 'progress', message: '仍在等待' });
    await page.waitForFunction(() => document.getElementById('settings-login-events').textContent.includes('仍在等待'));
    assert.equal(writes.filter(item => item.pathname.endsWith('/answer')).length, answersBefore + 1);
    await page.locator('#workspace-settings-editor-close').click(); rejectAnswer = false;
    // Per-model default and capability map use the exact provider/model and revision.
    const model = group('openai').locator('[data-model-id="org/model:free"]');
    if (!await group('openai').evaluate(element => element.open)) await group('openai').locator('summary').click();
    await model.locator('[data-action="thinking"]').click();
    assert.deepEqual(await page.locator('#settings-thinking-default-form option').evaluateAll(options => options.map(option => option.value)), ['', 'off', 'high', 'max']);
    await page.locator('#settings-thinking-default-form select').selectOption('max');
    await page.locator('#settings-thinking-default-form button').click();
    await page.waitForFunction(() => document.getElementById('workspace-settings-editor').classList.contains('hidden'));
    const saveDefault = writes.find(item => item.pathname.endsWith('/models/thinking'));
    assert.deepEqual(saveDefault.body, { provider: 'openai', modelId: 'org/model:free', expectedRevision: 'fixture-revision', defaultThinkingLevel: 'max' });
    await model.locator('[data-action="thinking"]').click();
    await page.locator('.settings-thinking-advanced summary').click();
    await page.locator('[data-level="high"] select').selectOption('mapped');
    await page.locator('[data-level="high"] input').fill('provider-high');
    conflict = true;
    await page.locator('#settings-thinking-map-form [type="submit"]').click();
    await page.waitForFunction(() => document.getElementById('settings-thinking-error').textContent.includes('配置已变化'));
    assert.equal(await page.locator('[data-level="high"] input').inputValue(), 'provider-high');
    assert.equal(writes.at(-1).body.thinkingLevelMap.high, 'provider-high');
    await width();
    await page.screenshot({ path: `/tmp/pi-settings-thinking-${viewport.width}-${theme}.png` });
    await page.locator('#workspace-settings-editor-close').click();
    await page.locator('[data-settings-tab="models"]').click();
    assert.ok(await page.locator('#settings-media-agent-form').isVisible());
    assert.ok(await page.locator('#settings-reply-tts').isVisible());
    for (const tab of ['packages', 'skills']) await page.locator(`[data-settings-tab="${tab}"]`).click();
    catalog.providerLogin = false; catalog.modelThinking = false;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#workspace-settings-toggle').click();
    await group('openai').locator('summary').click();
    assert.equal(await page.locator('[data-action="thinking"], [data-action="oauth"]').count(), 0, 'old backends do not advertise unsupported actions');
    await group('openai').locator('[data-action="key"]').click();
    await page.locator('#settings-api-key-input').waitFor();
    assert.equal(await page.locator('#settings-api-key-input').inputValue(), '');
    await page.locator('#workspace-settings-editor-close').click();
    await width();
    assert.deepEqual(errors, []);
    assert.ok(writes.every(item => /\/settings\/(providers\/[^/]+\/login|login\/[^/]+(?:\/answer)?|models\/thinking)$/.test(item.pathname)), 'no model, session, or media requests');
    console.log(JSON.stringify({ viewport, theme, pageerrors: errors.length, writes: writes.length }));
    await context.close();
}
(async () => {
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
    try {
        for (const [viewport, theme] of [[{ width: 1440, height: 1000 }, 'light'], [{ width: 393, height: 852 }, 'mint'], [{ width: 320, height: 740 }, 'dark']]) await run(browser, viewport, theme);
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
