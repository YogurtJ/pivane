const assert = require('node:assert/strict');
const { selectMessageView } = require('./pi-mobile-view-helper.cjs');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const express = require('express');
const root = path.resolve(__dirname, '../..');
const cwd = '/fixture/中文项目';
const session = { id: 'language-fixture', cwd, name: '保存', messageCount: 2, modified: '2026-09-11T00:00:00Z' };
const model = { provider: 'fixture', id: 'fixture-model', name: '模型', input: ['text', 'image'], contextWindow: 32000, available: true, thinkingLevels: ['off'] };
const messages = [
    { role: 'user', timestamp: 1000, content: [{ type: 'text', text: '保存' }] },
    { role: 'assistant', timestamp: 1100, content: [{ type: 'thinking', thinking: '保存：原始思考' }, { type: 'toolCall', id: 'raw-tool', name: 'read', arguments: { path: '/fixture/中文文件.txt' } }] },
    { role: 'toolResult', timestamp: 1200, toolCallId: 'raw-tool', toolName: 'read', isError: true, content: [{ type: 'text', text: '保存：原始工具输出' }] },
    { role: 'assistant', timestamp: 2000, content: [{ type: 'text', text: '设置\n\n`原始代码：保存`\n\n<img src=x onerror="window.i18nXss=true">' }], stopReason: 'stop', provider: 'fixture', model: 'fixture-model' }
];
const mediaModel = { id: 'image-fixture', name: '模型', kind: 'image', adapter: 'http-provider', configured: true, executable: true,
    parameters: { prompt: { type: 'textarea', label: '提示词', required: true, maxLength: 3000 }, width: { type: 'number', label: '宽度', default: 1024 }, settings: { type: 'json', label: '模型专属参数', default: { userText: '保存' } } } };
const total = { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, total: 60, cost: 0.01, records: 1, missingUsage: 0, missingCost: 0, zeroCost: 0 };
function usage(query) { return { from: query.get('from'), to: query.get('to'), timeZone: query.get('timeZone'), generatedAt: new Date().toISOString(), total,
    coverage: { scannedFiles: 1, skippedFiles: 0, duplicates: 0, invalidDates: 0 }, partial: false, daily: [{ ...total, date: '2026-09-11' }],
    providers: [{ ...total, provider: 'fixture' }], models: [{ ...total, provider: 'fixture', model: '模型' }], projects: [{ ...total, cwd }], sessions: [{ ...total, ...session }] }; }
async function run(browser, base, width, language) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: language, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    const errors = [], calls = [], writes = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(({ cwd }) => {
        localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, 'language-fixture');
    }, { cwd });
    await page.route(/https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)\//, r => r.abort());
    await page.route('**/api/**', async route => {
        const req = route.request(), url = new URL(req.url());
        if (req.method() !== 'GET') writes.push(url.pathname);
        let data = {};
        if (url.pathname === '/api/pi/status') data = { ok: true, projectRoots: ['/fixture'], defaultProject: cwd, usageStats: true, mediaLab: true, nativeSettings: true, sideChat: true };
        else if (url.pathname === '/api/pi/projects') data = { roots: ['/fixture'], projects: [{ cwd, name: '项目', sessionCount: 1 }] };
        else if (url.pathname === '/api/pi/sessions') data = { sessions: [session] };
        else if (url.pathname === '/api/pi/activity') data = { runtimes: [], replyNotices: [], pinnedProjects: [], hiddenProjects: [] };
        else if (url.pathname === '/api/pi/settings/models') data = { models: [model], providers: [{ id: 'fixture', name: '供应商', configured: true, authMethods: {} }], customProviders: [], preferences: { mediaAgent: { provider: 'fixture', modelId: model.id } } };
        else if (url.pathname === '/api/pi/settings/usage') data = usage(url.searchParams);
        else if (url.pathname === '/api/pi/settings/native') data = { cwd, revision: 'fixture', trust: { effective: true }, schema: { 'compaction.enabled': { label: '自动压缩', type: 'boolean' }, 'compaction.reserveTokens': { label: '压缩预留 Token', type: 'number', min: 1024, max: 10000 } }, settings: { 'compaction.enabled': { value: true, global: true }, 'compaction.reserveTokens': { value: 2048, global: 2048 } }, environment: {} };
        else if (url.pathname.endsWith('/history')) data = [];
        else if (url.pathname === '/api/pi/media/lab/review') {
            const body = req.postDataJSON(); data = { ticket: 'fixture-ticket', expiresAt: Date.now() + 600000, model: mediaModel, parameters: body.parameters,
                warnings: ['外部服务仍可能有额外约束；费用以服务方账单为准。'], execution: { mode: 'manual', count: 1 }, cost: '外部服务仍可能有额外约束；费用以服务方账单为准。' };
        } else if (url.pathname.startsWith('/api/pi/media/lab')) data = { version: 1, models: [mediaModel] };
        return route.fulfill({ json: data });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => {
        const command = JSON.parse(raw); calls.push(command.type);
        const state = { model, isStreaming: false, thinkingLevel: 'off' };
        let data = {};
        if (command.type === 'open_session') data = { session, state, messages: { messages }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } };
        else if (command.type === 'get_state') data = state;
        else if (command.type === 'get_messages') data = { messages };
        else if (command.type === 'get_available_models') data = { models: [model] };
        else if (command.type === 'get_available_thinking_levels') data = { levels: ['off'] };
        ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
    }));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.getElementById('pi-input').disabled);
    const english = language.startsWith('en');
    assert.equal(await page.locator('html').getAttribute('lang'), english ? 'en' : 'zh-CN');
    assert.equal(await page.locator('#workspace-settings-toggle').getAttribute('title'), english ? 'Workspace settings' : '工作台设置');
    const transcript = await page.locator('#pi-transcript-content').innerText();
    assert.ok(transcript.includes('保存') && transcript.includes('设置') && transcript.includes('原始代码：保存'));
    assert.equal(await page.evaluate(() => Boolean(window.i18nXss)), false);
    assert.equal(await page.locator('#pi-model-select .pi-model-trigger-label').textContent(), '模型');
    assert.equal(await page.locator('#pi-thinking-select option:checked').textContent(), english ? 'Off' : '不启用');
    await selectMessageView(page, 'full');
    assert.equal(await page.locator('.pi-tool-status').textContent(), english ? 'Failed' : '失败');
    assert.equal(await page.locator('.pi-tool-output').textContent(), '保存：原始工具输出');
    assert.ok((await page.locator('.pi-tool-args').textContent()).includes('/fixture/中文文件.txt'));
    await selectMessageView(page, 'reading');
    await page.locator('#pi-input').fill('保存 {0} <原始草稿>');
    await page.locator('#pi-file-input').setInputFiles({ name: '中文附件.txt', mimeType: 'text/plain', buffer: Buffer.from('保存\n用户数据') });
    await page.locator('#pi-attachments .pi-attachment-chip').first().waitFor();
    const overflow = async selectors => {
        const metrics = await page.evaluate(selectors => selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(e => e.clientWidth).map(e => {
            const r = e.getBoundingClientRect(); return { selector, width: e.clientWidth, scroll: e.scrollWidth, right: r.right, left: r.left };
        })), selectors);
        for (const m of metrics) assert.ok(m.scroll <= m.width + 1, `${language}/${width}: ${JSON.stringify(m)}`);
    };
    await overflow(['body', '.pi-command-bar', '.pi-runtime-controls', '.pi-composer-wrap', '#pi-attachments']);
    if (width < 900) { await page.locator('#pi-toggle-sessions').click(); await overflow(['#pi-session-pane', '#pi-session-filters']); await page.locator('#pi-toggle-sessions').click(); }
    await page.locator('#pi-toggle-inspector').click();
    await overflow(['#pi-inspector', '#pi-inspector-details']);
    if (width < 900) await page.locator('#pi-close-inspector').click();
    await page.locator('#workspace-settings-toggle').click();
    await page.locator('[data-settings-tab="models"]').click();
    await page.waitForFunction(() => document.getElementById('settings-media-agent-model').options.length > 0);
    await overflow(['.workspace-settings-dialog', '.workspace-settings-body', '.workspace-settings-content', '.workspace-settings-nav', '.workspace-settings-panel.active', '.workspace-language-card', '#workspace-language', '#settings-media-agent-form']);
    assert.equal(await page.locator('#workspace-language').inputValue(), 'system');
    if (width < 900) assert.ok(await page.locator('#workspace-language').evaluate(e => parseFloat(getComputedStyle(e).fontSize)) >= 16);
    for (const theme of ['daylight', 'mint', 'dark']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        await overflow(['.workspace-language-card', '.workspace-settings-nav']);
    }
    await page.screenshot({ path: `/tmp/pivane-i18n-${language}-${width}-preferences.png` });
    await page.locator('[data-settings-tab="usage"]').click();
    await page.locator('.pi-usage-table-scroll').first().waitFor();
    assert.ok((await page.locator('#settings-usage-result').innerText()).includes(english ? 'Daily usage' : '每日用量'));
    await overflow(['.workspace-settings-panel.active', '#settings-usage-filters', '.pi-usage-cards', '.pi-usage-cards > div']);
    await page.locator('[data-settings-tab="providers"]').click();
    await page.locator('#settings-add-provider').click();
    assert.equal(await page.locator('#workspace-settings-editor-title').textContent(), english ? 'Add custom Provider' : '新增自定义 Provider');
    await overflow(['.settings-editor-dialog', '#workspace-settings-editor-body', '#settings-provider-form']);
    await page.locator('#workspace-settings-editor-close').click();
    await page.locator('[data-settings-tab="native"]').click();
    await page.locator('#native-settings-form').waitFor();
    assert.ok((await page.locator('#native-settings-form').textContent()).includes(english ? 'Tokens reserved for compaction' : '压缩预留 Token'));
    await page.locator('[data-settings-tab="models"]').click();
    const beforeCalls = calls.length, beforeWrites = writes.length;
    await page.locator('#workspace-language').selectOption(english ? 'zh-CN' : 'en');
    assert.equal(await page.locator('html').getAttribute('lang'), english ? 'en' : 'zh-CN');
    assert.ok((await page.locator('#workspace-language-status').innerText()).includes(english ? 'Language saved' : '语言已保存'));
    assert.equal(calls.length, beforeCalls); assert.equal(writes.length, beforeWrites);
    await page.locator('#workspace-settings-close').click();
    assert.equal(await page.locator('#pi-input').inputValue(), '保存 {0} <原始草稿>');
    assert.ok((await page.locator('#pi-attachments').innerText()).includes('中文附件.txt'));
    await page.locator('[data-tab="media"]').click();
    await page.locator('#lab-model option[value="image-fixture"]').waitFor({ state: 'attached' });
    assert.equal(await page.locator('#lab-parameters [data-param="prompt"]').getAttribute('aria-label'), english ? 'Prompt' : '提示词');
    await page.locator('#lab-parameters [data-param="prompt"]').fill('保存 <原始媒体提示词>');
    await page.locator('#lab-review').click();
    await page.locator('#lab-review-dialog[open]').waitFor();
    assert.equal(await page.locator('#lab-review-fields [data-param="prompt"]').inputValue(), '保存 <原始媒体提示词>');
    assert.ok((await page.locator('#lab-review-warnings').textContent()).includes(english ? 'External services' : '外部服务'));
    await overflow(['.lab-header', '.lab-workspace', '.lab-editor', '.lab-results', '.lab-dialog[open]', '.lab-dialog[open] .lab-dialog-scroll', '#lab-review-fields']);
    await page.screenshot({ path: `/tmp/pivane-i18n-${language}-${width}-review.png` });
    assert.deepEqual(writes, ['/api/pi/media/lab/review']);
    assert.ok(!calls.includes('prompt') && !calls.includes('set_model'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('html').getAttribute('lang'), english ? 'zh-CN' : 'en');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ language, width, translatedStaticAndDynamic: true, rawContentPreserved: true, noGeneration: true, errors }));
    await context.close();
}
(async () => {
    const app = express();
    for (const [name, dir] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use('/vendor/' + name, express.static(path.join(root, 'node_modules', dir)));
    app.use(express.static(path.join(root, 'public')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
    try { for (const language of ['en-US', 'zh-CN']) for (const width of [320, 393, 768, 1440]) await run(browser, `http://127.0.0.1:${server.address().port}`, width, language); }
    finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
