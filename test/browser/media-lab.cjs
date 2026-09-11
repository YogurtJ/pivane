const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.PI_LAB_TEST_URL || 'http://127.0.0.1:3101';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
const imageModel = { id: 'fixture-image', name: 'Illustration Fixture ' + 'Long model name / '.repeat(8), kind: 'image', adapter: 'http-json', configured: true, executable: true,
    presets: [{ id: 'fixture-preset', name: '预设 / ' + 'long-preset-name-'.repeat(12), parameters: { quality: 'draft' } }],
    instructions: 'Use a model-specific structured palette. <img src=x onerror="window.labXss=true">', parameters: {
        prompt: { type: 'textarea', label: '提示词', required: true, maxLength: 3000 },
        steps: { type: 'number', label: '迭代次数', default: 12, integer: true },
        optional_detail: { type: 'text', label: '可选专属设置' },
        quality: { type: 'select', label: '质量', choices: ['draft', { value: 'high', label: '高质量 / ' + 'long-option-'.repeat(16) }], default: 'draft' },
        seed: { type: 'number', label: 'Seed', integer: true, min: -1, max: 100, default: -1 },
        transparent: { type: 'boolean', label: '透明背景', default: false },
        options: { type: 'json', label: '调色参数', default: { colors: ['mint', 'navy'] } }
    } };
// Synthetic catalog exercises source-image UI; it does not declare a real HTTP upload adapter.
const videoModel = { id: 'fixture-video', name: 'Video Fixture', kind: 'video', adapter: 'http-provider', configured: true, executable: true, sourceImage: true,
    parameters: { prompt: { type: 'textarea', label: '提示词', required: true }, duration: { type: 'number', label: '时长', min: 4, max: 15, default: 5 }, ratio: { type: 'select', label: '画幅', choices: ['16:9', 'adaptive'], default: '16:9' } } };
const ttsModel = { id: 'fixture-tts', name: 'Speech Fixture', kind: 'tts', adapter: 'tts', configured: true, executable: true,
    parameters: { text: { type: 'textarea', label: '合成文本', required: true }, voice: { type: 'select', label: '音色', choices: ['a', 'b'], default: 'a' }, option_seed: { type: 'number', label: 'Seed', default: 17 } }, voiceDefaults: { a: { seed: 17 }, b: { seed: 42 } } };
const asset = (id, prompt) => ({ id, kind: 'image', model: 'fixture-image', labModelId: 'fixture-image', filename: `${id}.png`, url: `/images/${id}.png`, prompt, parameters: { prompt, quality: 'high', options: { colors: ['blue'] }, transparent: true, seed: 12 }, createdAt: '2026-09-01T10:00:00Z' });

async function run(browser, size, theme) {
    const context = await browser.newContext({ viewport: size, isMobile: size.width <= 900, hasTouch: size.width <= 900 });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [], requests = [];
    let planHold, planStarted, executeCount = 0;
    let models = [imageModel, { ...imageModel, id: 'manual-only', name: 'Manual Fixture', adapter: 'manual', configured: false, executable: false }, videoModel, ttsModel,
        ...['zimage','flux2','minimax-video'].flatMap(adapter => [true, false].map(configured => ({ ...imageModel, id: `legacy-${adapter}-${configured}`, kind: adapter === 'minimax-video' ? 'video' : 'image', adapter, configured })))];
    models.push({ ...imageModel, id: 'needs-required', name: 'Required specialist fixture', parameters: { ...imageModel.parameters, sampler: { type: 'text', label: '采样器', required: true } } });
    let images = [asset('old', '山谷晨光 · 历史作品')];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    // Use the system fallback font so fixture screenshots do not wait on Google Fonts.
    await page.route('https://fonts.googleapis.com/**', route => route.abort());
    await page.addInitScript(theme => { localStorage.setItem('pi.workspace.theme', theme); sessionStorage.setItem('pi.web.token', 'browser-fixture'); }, theme);
    await page.route('**/api/**', async route => {
        const req = route.request(), url = new URL(req.url()), body = req.postDataJSON();
        if (url.pathname.startsWith('/api/pi/media/lab')) {
            assert.equal(req.headers().authorization, 'Bearer browser-fixture');
            if (req.method() !== 'GET') requests.push({ path: url.pathname, body });
            if (url.pathname.endsWith('/history')) return route.fulfill({ json: url.searchParams.get('kind') === 'image' ? images : [] });
            if (url.pathname.endsWith('/docs')) return route.fulfill({ contentType: 'text/markdown', body: '# HTTP JSON protocol\nFixture documentation.' });
            if (url.pathname.endsWith('/plan')) {
                planStarted?.(); if (planHold) await planHold;
                return route.fulfill({ json: { plan: { modelId: body.selectedModelId, summary: '模型专属参数已规划', parameters: { ...body.parameters, ...(body.selectedModelId === 'needs-required' ? { sampler: 'euler' } : {}), prompt: 'Agent planned a landscape', steps: 10, options: { colors: ['teal'] } } }, plannerModel: { name: 'Planner Fixture' }, fallbackUsed: false } });
            }
            if (url.pathname.endsWith('/review')) {
                const model = models.find(model => model.id === body.modelId);
                const parameters = { ...body.parameters };
                if (typeof parameters.text === 'string') parameters.text = parameters.text.trim();
                const selected = Boolean(body.source?.imageData || body.source?.imageUrl);
                if (selected) parameters.ratio = 'adaptive';
                return route.fulfill({ json: { ticket: `ticket-${requests.length}`, expiresAt: Date.now() + 600000, model, parameters, source: selected ? { selected: true } : null,
                    warnings: selected ? ['首帧已选择，画幅调整为 adaptive。'] : [], execution: { mode: 'manual', count: 1 }, cost: '费用以服务方账单为准。' } });
            }
            if (url.pathname.endsWith('/execute')) {
                assert.deepEqual(Object.keys(body).sort(), ['confirmed', 'ticket']); assert.equal(body.confirmed, true); executeCount++;
                const result = asset('completed', '本次生成结果');
                images = [asset('another', '同时完成的其他作品'), result, ...images];
                return route.fulfill({ json: { ok: true, kind: 'image', result: { asset: result } } });
            }
            if (url.pathname.endsWith('/models')) return route.fulfill({ json: { ok: true } });
            return route.fulfill({ json: { version: 1, models } });
        }
        if (req.method() !== 'GET') throw new Error('Unexpected Pi write: ' + url.pathname);
        if (url.pathname === '/api/pi/status') return route.fulfill({ json: { ok: true, version: '0.85.0', authRequired: true, mediaLab: true, projectRoots: ['/tmp'] } });
        if (url.pathname === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd: '/tmp/lab-browser', name: 'Browser fixture', sessionCount: 0 }], roots: ['/tmp'] } });
        if (url.pathname === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], replyNotices: [], hiddenProjects: [], pinnedProjects: [] } });
        if (url.pathname === '/api/pi/sessions') return route.fulfill({ json: { sessions: [] } });
        return route.fulfill({ json: {} });
    });
    await page.route('**/images/*.png', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="4096" height="2048"><rect width="4096" height="2048" fill="#8bb5ab"/></svg>' }));
    await page.routeWebSocket('**/api/pi/ws', () => { throw new Error('Lab UI must not open an Agent session'); });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-tab="media"]').click();
    await page.locator('#lab-model option[value="fixture-image"]').waitFor({ state: 'attached' });
    assert.equal(await page.locator('#lab-model option[value^="legacy-"]').count(), 0);
    const main = key => page.locator(`#lab-parameters [data-param="${key}"]`);
    const edited = key => page.locator(`#lab-review-fields [data-param="${key}"]`);
    const overflow = async () => {
        const metrics = await page.evaluate(() => {
            const selectors = ['#media-tab', '.lab-header', '.lab-workspace', '.lab-editor', '.lab-editor-scroll', '.lab-results', '.lab-fields', '.lab-preview', '.lab-preview-media', '.lab-preview-actions', '.lab-history', '.lab-dialog[open]', '.lab-dialog[open] .lab-dialog-scroll'];
            return selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(el => el.clientWidth).map(el => {
                const before = el.scrollLeft; el.scrollLeft = 100;
                const metric = { selector, width: el.clientWidth, scroll: el.scrollWidth, left: el.scrollLeft };
                el.scrollLeft = before; return metric;
            }));
        });
        for (const m of metrics) assert.ok(m.scroll <= m.width + 1 && m.left <= 1, `${size.width}: ${JSON.stringify(m)}`);
        const fields = await page.locator('#lab-model, #lab-preset, #lab-parameters :is(input,select,textarea), #lab-review-fields :is(input,select,textarea)').evaluateAll(elements => elements.filter(el => el.clientWidth).map(el => {
            const r = el.getBoundingClientRect(), parent = el.parentElement.getBoundingClientRect();
            return { name: el.getAttribute('aria-label'), fits: r.left >= parent.left - 1 && r.right <= parent.right + 1, width: r.width };
        }));
        for (const field of fields) assert.ok(field.fits && field.width > 0, JSON.stringify(field));
        assert.equal(await page.evaluate(() => Math.max(document.documentElement.scrollWidth - innerWidth, document.body.scrollWidth - document.body.clientWidth)), 0);
    };
    await overflow();
    assert.equal(await page.locator('.nav-btn[data-tab]').count(), 2);
    const shown = key => page.locator(`#lab-parameters [data-parameter="${key}"] dd`);
    assert.equal(await main('steps').count(), 0);
    assert.equal(await main('options').count(), 0);
    assert.equal(await shown('steps').textContent(), '12');
    assert.match(await shown('optional_detail').textContent(), /未指定/);
    assert.equal(await page.locator('#lab-parameters .lab-parameter-summary :is(input,select,textarea)').count(), 0);
    await main('prompt').fill('A mountain landscape');
    assert.equal(await shown('prompt').textContent(), 'A mountain landscape');
    await page.locator('[data-lab-kind="video"]').click();
    await page.locator('[data-lab-kind="image"]').click();
    assert.equal(await shown('steps').textContent(), '12', 'specialist defaults survive tab switches');
    await page.locator('#lab-instruction').fill('做一张山谷海报，迭代用10次');
    assert.match(await page.locator('#lab-plan-state').textContent(), /点击生成方案/);
    assert.equal(await shown('steps').textContent(), '12', 'natural language is not yet a parameter change');
    await page.locator('#lab-plan').click();
    await page.waitForFunction(() => document.querySelector('#lab-parameters [data-param="prompt"]').value === 'Agent planned a landscape');
    assert.equal(await shown('steps').textContent(), '10');
    assert.match(await shown('options').textContent(), /teal/);
    assert.equal(requests.find(r => r.path.endsWith('/plan')).body.parameters.steps, 12);
    assert.equal(Object.hasOwn(requests.find(r => r.path.endsWith('/plan')).body.parameters, 'optional_detail'), false);
    assert.equal(executeCount, 0);
    planHold = new Promise(resolve => { planStarted = resolve; });
    let release;
    const started = planHold; planHold = new Promise(resolve => { release = resolve; });
    await page.locator('#lab-plan').click(); await started;
    await main('prompt').fill('My newer draft'); release();
    await page.waitForFunction(() => document.getElementById('lab-plan-state').textContent.includes('未覆盖'));
    planHold = null;
    assert.equal(await main('prompt').inputValue(), 'My newer draft');
    await page.locator('#lab-review').click();
    await page.locator('#lab-review-dialog[open]').waitFor();
    assert.equal(executeCount, 0);
    assert.equal(await page.locator('#lab-review-fields [data-parameter="steps"] dd').textContent(), '10');
    assert.equal(requests.filter(r => r.path.endsWith('/review')).at(-1).body.parameters.steps, 10);
    await edited('prompt').fill('Reviewed landscape');
    assert.equal(await page.locator('#lab-confirm').isDisabled(), true);
    await page.locator('#lab-review-recheck').click();
    await page.waitForFunction(() => !document.getElementById('lab-confirm').disabled);
    assert.equal(await edited('prompt').inputValue(), 'Reviewed landscape');
    if (size.width < 900) assert.ok(await edited('prompt').evaluate(el => parseFloat(getComputedStyle(el).fontSize)) >= 16);
    await overflow(); await page.screenshot({ path: `/tmp/media-lab-${size.width}-${theme}-review.png` });
    await page.locator('#lab-confirm').click();
    await page.waitForFunction(() => document.querySelector('#lab-preview img')?.getAttribute('src') === '/images/completed.png');
    await page.waitForFunction(() => document.querySelector('#lab-preview img')?.naturalWidth === 4096);
    await overflow();
    assert.equal(executeCount, 1, 'only explicit confirmation generates');
    await page.getByRole('button', { name: '关闭预览', exact: true }).click();
    await page.locator('#lab-search').fill('山谷');
    assert.equal(await page.locator('#lab-history .lab-asset').count(), 1);
    await page.locator('#lab-history .lab-asset').click();
    assert.equal(await page.getByRole('link', { name: '新标签查看原文件' }).getAttribute('target'), '_blank');
    await page.getByRole('button', { name: '复用参数', exact: true }).click();
    assert.equal(await shown('quality').textContent(), 'high');
    assert.equal(await shown('transparent').textContent(), '是（true）');
    await page.locator('#lab-model-docs').click();
    await page.locator('#lab-info-dialog[open]').waitFor();
    assert.equal(await page.evaluate(() => Boolean(window.labXss)), false);
    assert.equal(await page.locator('#lab-info-content img').count(), 0);
    await page.locator('#lab-info-close').click();
    await page.locator('#lab-search').fill('');
    if (size.width > 1100) {
        const splitter = page.locator('[data-split-key="media-editor"]');
        await splitter.focus(); const before = Number(await splitter.getAttribute('aria-valuenow'));
        await splitter.press('ArrowRight'); assert.equal(Number(await splitter.getAttribute('aria-valuenow')), before + 16);
    }
    await overflow(); await page.screenshot({ path: `/tmp/media-lab-${size.width}-${theme}.png` });
    await page.locator('[data-lab-kind="video"]').click();
    await main('prompt').fill('Slow camera movement');
    await page.locator('#lab-source-file').setInputFiles({ name: 'frame.png', mimeType: 'image/png', buffer: png });
    await page.waitForFunction(() => document.getElementById('lab-source-image').src.startsWith('data:'));
    await page.locator('#lab-review').click(); await page.locator('#lab-review-dialog[open]').waitFor();
    assert.equal(await edited('ratio').inputValue(), 'adaptive');
    assert.equal(await page.locator('#lab-review-source img').count(), 1);
    await page.locator('#lab-review-close').click();
    await page.evaluate(() => {
        window.readers = []; const Original = window.FileReader;
        window.FileReader = class { readAsDataURL() { window.readers.push(this); } };
        window.restoreReader = () => { window.FileReader = Original; };
    });
    await page.locator('#lab-source-file').setInputFiles({ name: 'slow.png', mimeType: 'image/png', buffer: png });
    assert.equal(await page.locator('#lab-review').isDisabled(), true);
    await page.locator('[data-lab-kind="image"]').click(); await page.locator('[data-lab-kind="video"]').click();
    await page.locator('#lab-source-clear').click();
    await page.evaluate(() => { window.readers[0].result = 'data:image/png;base64,c3RhbGU='; window.readers[0].onload(); window.restoreReader(); });
    assert.equal(await page.locator('#lab-source-image').isHidden(), true, 'switch away/back rejects stale source reads');
    await page.locator('[data-lab-kind="tts"]').click();
    await main('text').fill('  你好，这是语音测试。  '); await main('voice').selectOption('b');
    assert.equal(await shown('option_seed').textContent(), '42');
    await page.locator('#lab-review').click(); await page.locator('#lab-review-dialog[open]').waitFor();
    assert.equal(await page.locator('#lab-review-fields [data-parameter="text"] dd').textContent(), '你好，这是语音测试。');
    assert.equal(await page.locator('#lab-review-fields [data-parameter="option_seed"] dd').textContent(), '42');
    assert.equal(await page.locator('#lab-review-fields [data-param="option_seed"]').count(), 0);
    await page.locator('#lab-review-close').click();
    await page.locator('[data-lab-kind="image"]').click();
    await page.locator('#lab-model').selectOption('needs-required');
    await main('prompt').fill('Required specialist draft');
    const previousReviews = requests.filter(r => r.path.endsWith('/review')).length;
    await page.locator('#lab-review').click();
    await page.locator('#lab-error:visible').waitFor();
    assert.match(await page.locator('#lab-error').textContent(), /采样器.*创作要求/);
    assert.equal(requests.filter(r => r.path.endsWith('/review')).length, previousReviews);
    await page.locator('#lab-instruction').fill('采样器用euler'); await page.locator('#lab-plan').click();
    await page.waitForFunction(() => document.querySelector('#lab-parameters [data-parameter="sampler"] dd')?.textContent === 'euler');
    await page.locator('#lab-review').click(); await page.locator('#lab-review-dialog[open]').waitFor();
    assert.equal(requests.filter(r => r.path.endsWith('/review')).at(-1).body.parameters.sampler, 'euler');
    await page.locator('#lab-review-close').click();
    await page.locator('#lab-model').selectOption('manual-only');
    await main('prompt').fill('Manual draft'); await page.locator('#lab-review').click(); await page.locator('#lab-review-dialog[open]').waitFor();
    assert.equal(await page.locator('#lab-confirm').isDisabled(), true);
    await page.locator('#lab-review-close').click();
    await page.locator('#lab-connect').click();
    await page.getByLabel('接入模板').selectOption('http-json');
    assert.ok((await page.getByLabel('模型接入定义 JSON').inputValue()).includes('tokenEnv'));
    await page.locator('#lab-info-content summary').click();
    await page.waitForFunction(() => document.querySelector('#lab-info-content pre').textContent.includes('Fixture documentation'));
    await overflow(); await page.locator('#lab-info-close').click();
    models = models.filter(model => model.kind !== 'tts'); await page.locator('#lab-refresh').click();
    await page.waitForFunction(() => !document.getElementById('lab-refresh').disabled);
    await page.locator('[data-lab-kind="tts"]').click();
    assert.equal(await page.locator('#lab-review').isDisabled(), true);
    await overflow(); assert.deepEqual(errors, []);
    assert.equal(executeCount, 1);
    await context.close();
    console.log(`PASS media ${size.width}x${size.height} ${theme}: readonly specialist parameters, common edits, plan/review synchronization, explicit execution, history, structured values, source races, voice options, auth docs, empty catalog; no pageerrors/overflow`);
}
(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
    try {
        for (const size of [{ width: 1440, height: 1000 }, { width: 768, height: 900 }, { width: 412, height: 852 }, { width: 393, height: 852 }, { width: 320, height: 740 }]) {
            if (process.env.PI_LAB_TEST_WIDTH && size.width !== Number(process.env.PI_LAB_TEST_WIDTH)) continue;
            for (const theme of ['daylight', 'dark', 'mint']) {
                if (process.env.PI_LAB_TEST_THEME && theme !== process.env.PI_LAB_TEST_THEME) continue;
                try { await run(browser, size, theme); }
                catch (error) {
                    const page = browser.contexts().at(-1)?.pages().at(-1);
                    if (page) {
                        await page.screenshot({ path: '/tmp/media-lab-failure.png', timeout: 5000 }).catch(() => {});
                        console.error(await page.evaluate(async () => {
                            const button = document.getElementById('lab-connect'), frames = [];
                            for (let i = 0; i < 12; i++) { await new Promise(requestAnimationFrame); frames.push({ ...button.getBoundingClientRect().toJSON(), transform: getComputedStyle(button).transform }); }
                            return { scroll: [scrollX, scrollY], viewport: { width: innerWidth, height: innerHeight }, dialogs: [...document.querySelectorAll('dialog')].filter(el => el.open).map(el => el.id), frames, animations: document.getAnimations().map(animation => ({ target: animation.effect?.target?.id, state: animation.playState, keyframes: animation.effect?.getKeyframes() })) };
                        }).catch(() => ({})));
                    }
                    throw error;
                }
            }
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
