const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PI_REPLY_TTS_TEST_URL || 'http://127.0.0.1:3001';
const cwd = '/tmp/direct-speech-fixture';
const speech = { id: 'custom-speech', name: 'Speech Fixture', kind: 'tts', adapter: 'http-provider', preferred: true, configured: true, executable: true,
    textFields: ['input', 'instruction'], parameters: {
        input: { type: 'textarea', label: '正文', required: true, maxLength: 1000 },
        instruction: { type: 'text', label: '风格', default: '自然' },
        voice: { type: 'select', label: '音色', choices: ['a', 'b'], default: 'a' },
        speed: { type: 'number', label: '语速', min: .5, max: 2, default: 1 },
        options: { type: 'json', label: '参数', default: { seed: 17 } }
    } };
const markdown = '## 你好\n\n**世界**，查看[说明](https://example.invalid)。\n\n```js\nsecretCode();\n```\n\n- 第一项\n- 第二项';
const wav = Buffer.alloc(44 + 48000 * 10);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
async function run(browser, viewport, theme) {
    const context = await browser.newContext({ locale: 'zh-CN', viewport, isMobile: viewport.width <= 900, hasTouch: viewport.width <= 900 });
    const page = await context.newPage(), errors = [], writes = [], commands = [];
    let defaults = { modelId: speech.id, textParameter: 'input', parameters: { voice: 'b', speed: 1.2, instruction: '自然', options: { seed: 42 } } };
    let revision = 1, holdExecute, holdReview, failExecute = false, empty = false, saved = true, legacy = false, executeCount = 0, reviewCount = 0;
    const sessions = ['one', 'two'].map(id => ({ id, cwd, name: id, messageCount: 4 }));
    let messages = [{ role: 'user', content: '请说明。', timestamp: 1000 }, { role: 'assistant', content: '过程说明', timestamp: 1200, stopReason: 'stop' },
        { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'read', arguments: {} }], timestamp: 1300 },
        { role: 'toolResult', toolCallId: 'call', toolName: 'read', content: 'Tool result', timestamp: 1400 },
        { role: 'assistant', content: markdown, timestamp: 2000, stopReason: 'stop' }];
    const model = { id: 'chat', provider: 'fixture', name: 'Chat', input: ['text','image'], contextWindow: 128000 };
    page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
    await page.addInitScript(({ cwd, theme }) => {
        localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.web.session:' + cwd, 'one'); localStorage.setItem('pi.workspace.theme', theme);
        sessionStorage.setItem('pi.web.token', 'fixture-token');
        window.playCalls = 0; window.blockPlay = false;
        const play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () { window.playCalls++; return window.blockPlay ? Promise.reject(new DOMException('blocked', 'NotAllowedError')) : play.call(this); };
    }, { cwd, theme });
    await page.route('**/api/**', async route => {
        const req = route.request(), endpoint = new URL(req.url()).pathname, body = req.postDataJSON();
        const send = (json, status = 200) => route.fulfill({ json, status });
        if (req.method() !== 'GET') writes.push({ endpoint, body });
        if (endpoint === '/api/pi/settings/reply-tts') {
            assert.equal(req.headers().authorization, 'Bearer fixture-token');
            if (req.method() === 'GET') return send({ models: empty ? [] : [speech], defaults: saved && !empty ? defaults : null, hasSavedDefaults: saved, revision: String(revision), warning: empty ? '默认配置已失效' : '' });
            assert.equal(req.method(), 'PUT'); assert.equal(body.parameters[body.textParameter], undefined);
            if (body.expectedRevision !== String(revision)) return send({ error: '配置已变化' }, 409);
            defaults = { modelId: body.modelId, textParameter: body.textParameter, parameters: body.parameters }; saved = true;
            return send({ defaults, revision: String(++revision) });
        }
        if (endpoint.endsWith('/media/lab/review')) {
            reviewCount++; if (holdReview) await holdReview;
            assert.ok(body.parameters[defaults.textParameter || 'input']);
            return send({ ticket: 'ticket-' + reviewCount, expiresAt: Date.now() + 600000, model: speech, parameters: body.parameters, warnings: [] });
        }
        if (endpoint.endsWith('/media/lab/execute')) {
            executeCount++; assert.deepEqual(Object.keys(body).sort(), ['confirmed','ticket']); assert.equal(body.confirmed, true);
            if (holdExecute) await holdExecute;
            return failExecute ? send({ error: 'fixture timeout' }, 504) : send({ kind: 'tts', modelId: speech.id, result: { asset: { url: '/audio/fixture.wav' } } });
        }
        assert.equal(req.method(), 'GET', 'no unexpected business writes');
        if (endpoint.endsWith('/status')) return send({ ok: true, replyTts: !legacy, projectRoots: ['/tmp'] });
        if (endpoint.endsWith('/projects')) return send({ projects: [{ cwd, name: 'Speech', sessionCount: 2 }], roots: ['/tmp'] });
        if (endpoint.endsWith('/sessions')) return send({ sessions });
        if (endpoint.endsWith('/activity')) return send({ runtimes: [], replyNotices: [], hiddenProjects: [], pinnedProjects: [] });
        return send({});
    });
    await page.route('**/audio/fixture.wav', route => route.fulfill({ contentType: 'audio/wav', body: wav }));
    await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => {
        const command = JSON.parse(raw); commands.push(command.type);
        const reply = data => ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
        if (command.type === 'open_session') return reply({ session: sessions.find(s => s.id === command.sessionId), state: { model, isStreaming: false }, messages: { messages }, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] }, stats: {} });
        if (command.type === 'get_messages') return reply({ messages });
        if (command.type === 'get_state') return reply({ model, isStreaming: false });
        if (command.type === 'get_session_stats' || command.type === 'prompt') return reply({});
        throw Error('Unexpected RPC ' + command.type);
    }));
    page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(60000);
    const speaker = () => page.locator('.pi-message-tts').first().click();
    const waitExecutions = async count => {
        const deadline = Date.now() + 5000;
        while (executeCount < count && Date.now() < deadline) await page.waitForTimeout(20);
        assert.equal(executeCount, count);
    };
    const waitText = text => page.waitForFunction(text => document.getElementById('pi-reply-tts-bar-state').textContent.includes(text), text);
    const openSettings = async () => { await page.evaluate(() => document.getElementById('settings-reply-tts').click()); await page.waitForFunction(() => !document.getElementById('pi-reply-tts-save').disabled); };
    const field = key => page.locator(`#pi-reply-tts-fields [data-param="${key}"]`);
    const layout = async () => {
        const bad = await page.evaluate(() => [document.body, document.getElementById('pi-transcript'), document.getElementById('pi-reply-tts-bar')]
            .filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.id || 'body'));
        assert.deepEqual(bad, []);
        assert.equal(await page.locator('#pi-input').isEnabled(), true);
    };
    await page.goto(base, { waitUntil: 'domcontentloaded' }); await page.locator('.pi-message-tts').waitFor();
    assert.equal(await page.locator('.pi-message-tts').count(), 1, 'only the final reply');
    let release; holdExecute = new Promise(resolve => { release = resolve; });
    await speaker(); await waitText('正在生成'); await waitExecutions(1);
    assert.equal(await page.locator('#pi-reply-tts-dialog').evaluate(el => el.open), false);
    const submitted = writes.find(w => w.endpoint.endsWith('/review')).body.parameters.input;
    assert.ok(submitted.includes('第一项') && !/secretCode|Tool result|https:|\*\*/.test(submitted));
    await speaker(); assert.equal(executeCount, 1);
    await page.locator('#pi-input').fill('继续下一条指令'); await page.locator('#pi-send-button').click();
    assert.ok(commands.includes('prompt'), 'the user can send while TTS is pending');
    await page.locator('#pi-input').fill('未发送的新草稿'); await layout();
    release(); holdExecute = null;
    await page.waitForFunction(() => window.playCalls > 0 && !document.getElementById('pi-reply-tts-audio').paused);
    assert.equal(await page.locator('#pi-input').inputValue(), '未发送的新草稿');
    await speaker(); assert.equal(await page.locator('#pi-reply-tts-audio').evaluate(el => el.paused), true);
    await speaker(); assert.equal(executeCount, 1, 'cached playback does not synthesize again');
    await page.screenshot({ path: `/tmp/pi-reply-tts-direct-${viewport.width}-${theme}.png` });
    await openSettings(); assert.equal(await field('input').count(), 0); await field('speed').fill('1.5'); await page.locator('#pi-reply-tts-save').click();
    await page.waitForFunction(() => document.getElementById('pi-reply-tts-state').textContent.includes('已保存')); assert.equal(defaults.parameters.speed, 1.5);
    revision++; await page.locator('#pi-reply-tts-save').click(); await page.locator('#pi-reply-tts-error:visible').waitFor();
    await page.locator('#pi-reply-tts-close').click();
    // A fresh reply exercises blocked autoplay without a second generate request.
    await page.evaluate(() => { window.blockPlay = true; window.PiReplyTts.speak({ key: 'blocked', text: '自动播放测试。' }); });
    await waitText('浏览器限制'); assert.equal(executeCount, 2);
    await page.evaluate(() => { window.blockPlay = false; document.getElementById('pi-reply-tts-audio').play(); });
    assert.equal(executeCount, 2);
    failExecute = true;
    await page.evaluate(() => window.PiReplyTts.speak({ key: 'failed', text: '失败测试。' })); await waitText('不确定');
    assert.equal(executeCount, 3); await page.waitForTimeout(100); assert.equal(executeCount, 3);
    failExecute = false;
    holdExecute = new Promise(resolve => { release = resolve; });
    await page.locator('#pi-reply-tts-retry').click(); await waitText('正在生成');
    if (viewport.width <= 900) await page.locator('#pi-toggle-sessions').click();
    await page.locator('[data-session-id="two"] .pi-session-main').click();
    await page.waitForFunction(() => document.querySelector('[data-session-id="two"]')?.classList.contains('active'));
    const plays = await page.evaluate(() => window.playCalls); release(); holdExecute = null;
    await page.waitForTimeout(150); assert.equal(await page.evaluate(() => window.playCalls), plays, 'late old-thread result must not autoplay');
    assert.equal(await page.locator('#pi-reply-tts-bar').isHidden(), true);
    // A slow review can be abandoned before any execution.
    holdReview = new Promise(resolve => { release = resolve; });
    await page.evaluate(() => { window.PiReplyTts.speak({ key: 'slow-review', text: '慢校验。' }); });
    await page.waitForTimeout(100); await page.locator('#pi-reply-tts-bar-close').click();
    const count = executeCount; release(); holdReview = null; await page.waitForTimeout(100); assert.equal(executeCount, count);
    // Existing registry defaults work without requiring a separately saved preset.
    saved = false;
    await page.evaluate(() => window.PiReplyTts.speak({ key: 'registry', text: '现有默认模型。' }));
    await waitText('正在播放'); assert.equal(executeCount, count + 1);
    const reviews = reviewCount;
    await page.evaluate(() => window.PiReplyTts.speak({ key: 'long', text: '长'.repeat(1001) }));
    await waitText('超过'); assert.equal(reviewCount, reviews); assert.equal(executeCount, count + 1);
    empty = true; saved = true;
    await page.evaluate(() => window.PiReplyTts.speak({ key: 'empty', text: '没有模型。' }));
    await page.locator('#pi-reply-tts-dialog[open]').waitFor(); await page.locator('#pi-reply-tts-error:visible').waitFor(); assert.equal(await page.locator('#pi-reply-tts-save').isDisabled(), true);
    await page.locator('#pi-reply-tts-close').click(); await layout();
    legacy = true; await page.reload({ waitUntil: 'domcontentloaded' }); await page.locator('.pi-message-actions').waitFor(); assert.equal(await page.locator('.pi-message-tts').count(), 0);
    assert.deepEqual(errors, []); await context.close();
    console.log(`PASS direct TTS ${viewport.width} ${theme}: one click, input/send preserved, autoplay/fallback, replay, defaults, failure, thread/close races, limits; no real synthesis`);
}
(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    try { for (const [viewport, theme] of [[{ width: 1440, height: 1000 }, 'daylight'], [{ width: 393, height: 852 }, 'dark'], [{ width: 320, height: 740 }, 'mint']]) await run(browser, viewport, theme); }
    finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
