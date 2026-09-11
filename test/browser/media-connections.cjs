const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { connectionSchema } = require('../../server/media-connection-planner');
const { renderTemplate } = require('../../server/media-http-protocol');
const baseUrl = process.env.PI_CONNECTIONS_TEST_URL || 'http://127.0.0.1:3104';
const schema = connectionSchema(), copy = value => JSON.parse(JSON.stringify(value));
async function run(browser, viewport, theme) {
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 900, hasTouch: viewport.width < 900 });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    const errors = [], writes = [], stored = new Map(); let providers = [], revision = 0, counter = 0, holdPlan, resolveStarted, rejectWrite = false, unsupported = false;
    const snapshot = () => ({ ...copy(schema), revision: String(revision), providers: providers.map(provider => ({ ...copy(provider), keyConfigured: stored.has(provider.id) && stored.get(provider.id).origin === new URL(provider.baseUrl).origin, keyNeedsRebind: stored.has(provider.id) && stored.get(provider.id).origin !== new URL(provider.baseUrl).origin })) });
    const builtin = { id: 'builtin-fixture', name: 'Built-in Fixture', kind: 'image', adapter: 'manual', configured: false, executable: false, parameters: { prompt: { type: 'textarea', label: '提示词', required: true } } };
    const catalog = () => [builtin, ...snapshot().providers.flatMap(provider => provider.models.map(model => ({ ...copy(model), id: `media:${provider.id}:${model.id}`, name: `${provider.name} / ${model.name}`, adapter: 'http-provider', managed: true, configured: provider.keyConfigured, executable: provider.keyConfigured })))];
    page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
    await page.addInitScript(theme => { localStorage.setItem('pi.workspace.theme', theme); sessionStorage.setItem('pi.web.token', 'browser-fixture-token'); }, theme);
    await page.route('**/api/**', async route => {
        const request = route.request(), pathname = new URL(request.url()).pathname, body = request.postDataJSON();
        const send = (json, status = 200) => route.fulfill({ json, status });
        if (pathname.startsWith('/api/pi/media/lab')) {
            assert.equal(request.headers().authorization, 'Bearer browser-fixture-token');
            const suffix = pathname.slice('/api/pi/media/lab'.length);
            if (request.method() !== 'GET') writes.push({ suffix, body });
            if (!suffix) return send({ version: 1, mediaConnections: true, models: catalog() });
            if (suffix === '/connections') return send(snapshot());
            if (suffix === '/history') return send([]);
            if (suffix === '/connection-plan') {
                resolveStarted?.(); if (holdPlan) await holdPlan;
                if (unsupported) return send({ draft: { summary: '该文档需要其他适配器', model: null, unsupported: ['Signed request protocol is unsupported'] }, plannerModel: { name: 'Fixture Planner' } });
                const model = { ...copy(schema.templates[0].model), remoteModel: body.remoteModel || 'from-docs', name: 'Agent Draft', instructions: '文档规定的参数要求', http: { ...copy(schema.templates[0].model.http), path: '/custom-images' } };
                return send({ draft: { summary: '已根据文档生成草稿', model, warnings: ['请核对接口参数'], unsupported: [] }, plannerModel: { name: 'Fixture Planner' }, fallbackUsed: false });
            }
            if (suffix === '/review') {
                const model = catalog().find(model => model.id === body.modelId);
                return send({ model, parameters: body.parameters, ticket: 'review-fixture', warnings: [], execution: { mode: 'manual', count: 1 }, cost: 'Fixture only', request: { body: renderTemplate(model.http.body, body.parameters, model.remoteModel) } });
            }
            if (suffix === '/execute') throw new Error('Connection setup must not generate media');
            const match = suffix.match(/^\/providers\/([^/]+)(?:\/(key|probe|models)(?:\/([^/]+))?)?$/);
            if (match?.[2] === 'probe') return send({ ok: true, message: 'GET 连接已验证；未生成媒体。', models: [{ id: 'remote-image', name: 'Remote Image' }] });
            if (body?.expectedRevision !== String(revision) || rejectWrite) { rejectWrite = false; revision++; return send({ error: 'Connection settings changed; reload before saving' }, 409); }
            revision++;
            if (suffix === '/providers') {
                const old = providers.find(provider => provider.id === body.provider.id);
                assert.equal(Object.hasOwn(body.provider, 'apiKey'), false);
                const provider = { ...body.provider, models: old?.models || [] };
                providers = providers.filter(item => item.id !== provider.id).concat(provider); return send(snapshot());
            }
            assert.ok(match, 'known mutation'); const provider = providers.find(provider => provider.id === match[1]);
            if (match[2] === 'key') {
                if (request.method() === 'DELETE') stored.delete(provider.id); else stored.set(provider.id, { key: body.apiKey, origin: new URL(provider.baseUrl).origin });
            } else if (match[2] === 'models') {
                if (request.method() === 'DELETE') provider.models = provider.models.filter(model => model.id !== match[3]);
                else { const model = { ...body.model, id: body.model.id || 'model-' + (++counter) }; provider.models = provider.models.filter(item => item.id !== model.id).concat(model); return send({ ...snapshot(), modelId: `media:${provider.id}:${model.id}` }); }
            } else { providers = providers.filter(item => item.id !== provider.id); stored.delete(provider.id); }
            return send(snapshot());
        }
        if (request.method() !== 'GET') throw new Error('Unexpected Pi write');
        if (pathname === '/api/pi/status') return send({ ok: true, version: '0.85.0', mediaLab: true, mediaConnections: true, projectRoots: ['/tmp'] });
        if (pathname === '/api/pi/projects') return send({ projects: [{ cwd: '/tmp/connection-ui', name: 'UI fixture', sessionCount: 0 }], roots: ['/tmp'] });
        if (pathname === '/api/pi/sessions') return send({ sessions: [] });
        if (pathname === '/api/pi/activity') return send({ runtimes: [], replyNotices: [] });
        return send({});
    });
    await page.routeWebSocket('**/api/pi/ws', () => { throw new Error('Connections must not open a Pi session'); });
    const click = name => page.getByRole('button', { name, exact: true }).click();
    const field = name => page.getByLabel(name, { exact: true });
    const manager = page.locator('#lab-connections-dialog');
    async function open() { await page.locator('#lab-connect').click(); await manager.locator('.mc-provider-list').waitFor({ state: 'attached' }); }
    async function manage() { await click(`管理模型（${providers[0].models.length}）`); }
    async function overflow() {
        const sizes = await page.evaluate(() => [document.documentElement.scrollWidth - innerWidth, document.body.scrollWidth - document.body.clientWidth, ...['lab-connections-dialog','mc-content'].map(id => { const el = document.getElementById(id); return el.open === false ? 0 : el.scrollWidth - el.clientWidth; })]);
        assert.ok(sizes.every(size => size <= 1), JSON.stringify(sizes));
        if (viewport.width < 900) assert.deepEqual(await manager.locator('input:not([type="checkbox"]),select,textarea').evaluateAll(items => items.filter(el => el.getClientRects().length && parseFloat(getComputedStyle(el).fontSize) < 16).map(el => el.getAttribute('aria-label'))), []);
    }
    try {
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded' }); await page.locator('[data-tab="media"]').click();
        await page.locator('#lab-parameters textarea').fill('Unrelated old draft');
        await open(); await click('新增服务');
        await field('服务名称').fill('My Media Service'); await manager.getByText('高级连接设置', { exact: true }).click(); await field('服务 ID').fill('my-api'); await field('Base URL').fill('https://media.example.invalid/v1');
        await field('API Key').fill('ui-private-key-fixture'); await click('保存服务');
        await page.getByText('https://media.example.invalid/v1 · Key 已保存', { exact: true }).waitFor();
        assert.equal(stored.get('my-api').key, 'ui-private-key-fixture');
        await click('编辑服务 / Key'); assert.equal(await field('API Key').inputValue(), '');
        await overflow(); await page.screenshot({ path: `/tmp/media-connections-${viewport.width}-${theme}-provider.png` });
        await page.locator('#mc-back').click(); await click('连接测试'); await page.getByText('GET 连接已验证；未生成媒体。', { exact: true }).waitFor();
        await click('读取模型列表'); await click('Remote Image · remote-image');
        assert.equal(await field('模型 ID（服务端）').inputValue(), 'remote-image');
        await field('显示名称').fill('My Image');
        assert.equal(await field('生成接口路径（POST）').isVisible(), false);
        assert.equal(await field('参数定义 JSON').isVisible(), false);
        assert.equal(await manager.locator('input:visible,select:visible,textarea:visible').count(), 4);
        await overflow(); await page.screenshot({ path: `/tmp/media-connections-${viewport.width}-${theme}-model.png` });
        await click('保存并使用模型'); await manager.waitFor({ state: 'hidden' });
        await page.waitForFunction(() => document.getElementById('lab-model').value.includes('media:my-api:'));
        assert.equal(await page.locator('#lab-parameters [data-param="prompt"]').inputValue(), '', 'new model must not inherit the old model draft');
        await page.locator('#lab-parameters [data-param="prompt"]').fill('A landscape'); await page.locator('#lab-review').click();
        await page.locator('#lab-review-dialog[open]').waitFor();
        const request = await page.locator('#lab-review-json').textContent(); assert.ok(request.includes('remote-image')); assert.equal(request.includes('ui-private-key-fixture'), false);
        await page.locator('#lab-review-close').click();
        await open(); await manage(); await click('添加模型');
        await field('协议模板').selectOption('openai-speech'); await field('模型 ID（服务端）').fill('my-speech-model'); await field('显示名称').fill('My Speech');
        assert.equal(await field('结果形式').inputValue(), 'binary');
        await click('保存并使用模型'); await manager.waitFor({ state: 'hidden' });
        await page.locator('#lab-parameters [data-param="voice"]').waitFor(); assert.equal(await page.locator('[data-lab-kind="tts"]').getAttribute('aria-selected'), 'true');
        await open(); await manage(); await click('添加模型');
        await field('模型 ID（服务端）').fill('qwen-tts'); await field('协议模板').selectOption('qwen-speech');
        assert.equal(await field('模型 ID（服务端）').inputValue(), 'qwen-tts');
        assert.equal(await field('结果形式').inputValue(), 'url');
        assert.equal(await field('生成接口路径（POST）').inputValue(), '/api/v1/services/aigc/multimodal-generation/generation');
        assert.ok((await manager.textContent()).includes('不带 /compatible-mode/v1'));
        await overflow();
        await click('保存并使用模型'); await manager.waitFor({ state: 'hidden' });
        assert.deepEqual(await page.locator('#lab-parameters [data-param="voice"] option').evaluateAll(options => options.map(option => option.value)), ['Cherry','Serena','Ethan','Chelsie']);
        assert.equal(await page.locator('#lab-parameters [data-param="voice"]').inputValue(), 'Cherry');
        await open(); await manage(); await click('添加模型'); await field('协议模板').selectOption('async-video');
        await field('模型 ID（服务端）').fill('my-video-model');
        assert.equal(await field('异步任务：提交后查询状态').isChecked(), true);
        await manager.getByText('高级：接口、输出与轮询', { exact: true }).click();
        await field('处理中状态').fill('[false,null]'); await field('成功状态').fill('[true]');
        await overflow(); await page.screenshot({ path: `/tmp/media-connections-${viewport.width}-${theme}-polling.png` });
        await click('保存并使用模型'); await manager.waitFor({ state: 'hidden' });
        assert.deepEqual(providers[0].models.at(-1).http.poll.pending, [false,null]);
        await open(); await manage(); await click('添加模型'); await field('协议模板').selectOption('openai-image');
        await field('模型 ID（服务端）').fill('doc-model');
        await manager.locator('summary').filter({ hasText: '让 Agent' }).click();
        await field('API 文档或请求/响应示例').fill('POST /custom-images returns data[0].b64_json. No real endpoint is called.');
        let release; holdPlan = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { resolveStarted = resolve; });
        await click('生成接入草稿'); await started; await field('显示名称').fill('My newer edit'); release();
        await page.getByText('编辑内容已变化，未覆盖当前草稿。', { exact: true }).waitFor();
        assert.equal(await field('显示名称').inputValue(), 'My newer edit'); holdPlan = null;
        await click('生成接入草稿'); await page.waitForFunction(() => document.querySelector('[aria-label="生成接口路径（POST）"]').value === '/custom-images');
        assert.equal(await field('模型 ID（服务端）').inputValue(), 'doc-model');
        await manager.locator('summary').filter({ hasText: '让 Agent' }).click(); unsupported = true; await click('生成接入草稿');
        await page.getByText(/Signed request protocol is unsupported/).waitFor();
        await overflow();
        await page.locator('#mc-close').click(); await open(); await manage(); await click('编辑服务 / Key');
        await field('Base URL').fill('https://changed.example.invalid/v1'); await click('保存服务');
        await page.getByText(/地址已更换 · 需要重新保存 Key/).waitFor();
        await click('编辑服务 / Key'); assert.equal(await field('API Key').inputValue(), '');
        rejectWrite = true; await field('服务名称').fill('Unsaved change'); await click('保存服务');
        await page.getByText('Connection settings changed; reload before saving', { exact: true }).waitFor();
        assert.equal(await field('服务名称').inputValue(), 'Unsaved change');
        await page.locator('#mc-close').click(); await open(); await manage(); await click('编辑服务 / Key');
        await click('删除服务'); await page.getByText('还没有媒体服务。从常用服务开始，或接入自己的兼容 API。', { exact: true }).waitFor();
        assert.equal(providers.length, 0); assert.equal(stored.size, 0);
        await page.locator('#mc-close').click();
        await page.locator('#workspace-settings-toggle').click();
        await page.locator('[data-settings-tab="media"]').click();
        await page.locator('[data-media-settings-kind="image"]').click();
        await manager.locator('.mc-provider-list').waitFor({ state: 'attached' });
        await click('新增服务'); await field('常用服务').selectOption('google');
        assert.equal(await field('Base URL').inputValue(), 'https://generativelanguage.googleapis.com/v1beta');
        assert.equal(await field('服务 ID').isVisible(), false);
        assert.equal(await field('认证方式').inputValue(), 'header');
        await field('API Key').fill('ui-private-key-fixture');
        await overflow(); await click('保存服务'); await click('添加模型');
        assert.equal(await field('协议模板').inputValue(), 'gemini-image');
        await field('模型 ID（服务端）').fill('my-image-model'); await click('保存并使用模型');
        await manager.waitFor({ state: 'hidden' });
        assert.equal(providers[0].models.length, 1); assert.equal(providers[0].models[0].name, 'my-image-model');
        await page.locator('#workspace-settings-close').click();
        await open(); await manage(); await click('编辑模型');
        await field('协议模板').selectOption('gpt-image');
        assert.equal(await field('模型 ID（服务端）').inputValue(), 'my-image-model');
        await click('保存并使用模型'); await manager.waitFor({ state: 'hidden' });
        assert.equal(providers[0].models.length, 1, 'changing protocol edits the same model');
        await page.locator('#lab-parameters [data-param="prompt"]').fill('Optional field check');
        await page.locator('#lab-review').click(); await page.locator('#lab-review-dialog[open]').waitFor();
        assert.deepEqual(writes.filter(item => item.suffix === '/review').at(-1).body.parameters, { prompt: 'Optional field check' });
        await page.locator('#lab-review-close').click(); await open();
        assert.equal(writes.filter(item => item.suffix === '/execute').length, 0);
        assert.equal(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }).includes('ui-private-key-fixture')), false);
        await overflow(); assert.deepEqual(errors, []);
        console.log(`PASS connections ${viewport.width} ${theme}: provider/key CRUD, discovery, model templates, mapped review, async fields, Agent drafts/races, origin rebind, stale writes, no generation/errors/overflow`);
    } catch (error) { await page.screenshot({ path: '/tmp/media-connections-failure.png', timeout: 5000 }).catch(() => {}); console.error(await manager.textContent().catch(() => '')); throw error; }
    finally { await context.close(); }
}
(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
    try {
        for (const viewport of [{ width: 1440, height: 1000 }, { width: 393, height: 852 }, { width: 320, height: 740 }]) {
            if (process.env.PI_CONNECTIONS_TEST_WIDTH && viewport.width !== Number(process.env.PI_CONNECTIONS_TEST_WIDTH)) continue;
            for (const theme of ['daylight','dark','mint']) await run(browser, viewport, theme);
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
