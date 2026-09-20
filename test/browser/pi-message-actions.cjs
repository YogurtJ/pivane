const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PI_MESSAGE_ACTIONS_TEST_URL || 'http://127.0.0.1:3101';
const cwd = '/srv/message-actions-fixture';
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text', 'image'], contextWindow: 128000 };
const time = Date.parse('2026-09-07T08:20:00Z');
const firstQuestion = '请比较方案 A 和方案 B。\n保留原来的文件。';
const firstReply = '## 两个方案\n\n**方案 A** 保持现有结构，方案 B 拆分模块。\n\n```js\nconst choice = "A";\n```';
const latestQuestion = '先验证方案 A。\n<img src=x onerror=alert(1)> 只作为问题文本。';
const finalReply = `${'验证结果保留了原来的上下文，项目文件未发生变化。\n\n'.repeat(18)}最后一段回复。`;
const png = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5V8AAAAASUVORK5CYII=' };
const text = message => typeof message.content === 'string' ? message.content : (message.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');

async function run(browser, viewport, theme) {
    const context = await browser.newContext({ locale: 'zh-CN', viewport, isMobile: viewport.width <= 900, hasTouch: viewport.width <= 900, timezoneId: 'Asia/Shanghai' });
    const page = await context.newPage(), errors = [], writes = [], commands = [];
    const pendingRequests = new Set();
    page.setDefaultNavigationTimeout(60000);
    page.on('request', request => pendingRequests.add(request.url()));
    page.on('requestfinished', request => pendingRequests.delete(request.url()));
    page.on('requestfailed', request => pendingRequests.delete(request.url()));
    let socket, streaming = false, stale = false, legacy = false;
    const original = { id: 'original', cwd, name: '方案对比', messageCount: 6 };
    const forked = { ...original, id: 'reply-fork', name: '方案对比 · 分叉' };
    let active = original, sessions = [original];
    let messages = [
        { id: 'u1', role: 'user', content: firstQuestion, timestamp: time },
        { id: 'a1', role: 'assistant', content: firstReply, stopReason: 'stop', timestamp: time + 1000 },
        { id: 'u2', role: 'user', content: [{ type: 'text', text: latestQuestion }, png], timestamp: time + 60000 },
        { id: 'progress', role: 'assistant', content: '正在核对方案和现有配置，随后继续验证。', stopReason: 'stop', timestamp: time + 60500 },
        { id: 'tools', role: 'assistant', content: [{ type: 'text', text: '检查当前状态。' }, { type: 'thinking', thinking: '检查上下文和文件状态。' }, { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'fixture.txt' } }], stopReason: 'toolUse', timestamp: time + 61000 },
        { role: 'toolResult', toolCallId: 'tool-1', toolName: 'read', isError: true, content: [{ type: 'text', text: '受控工具错误，未修改文件。' }], timestamp: time + 62000 },
        { id: 'a2', role: 'assistant', content: finalReply, stopReason: 'stop', timestamp: time + 65000 }
    ];
    const snapshot = () => ({ leafId: messages.at(-1).id || 'end', lastUserId: messages.filter(message => message.role === 'user').at(-1)?.id,
        prompts: messages.filter(message => message.role === 'user').map(message => ({ entryId: message.id, timestamp: message.timestamp, text: text(message).slice(0, 180) })),
        ...(!legacy ? { replies: messages.filter(message => message.role === 'assistant' && message.stopReason === 'stop').map(message => ({ entryId: message.id, timestamp: message.timestamp, text: text(message).trim().slice(0, 180) })) } : {}), versions: [] });
    const emit = event => socket.send(JSON.stringify(event));
    const reply = (ws, command, data) => ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ cwd, theme }) => {
        localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'original');
        localStorage.setItem('pi.workspace.theme', theme);
        window.__copies = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => window.__copies.push(value) } });
        document.execCommand = action => { if (action === 'copy') { window.__copies.push(document.activeElement.value); return true; } return false; };
    }, { cwd, theme });
    await page.route('**/api/**', async route => {
        const req = route.request(), endpoint = new URL(req.url()).pathname;
        const send = (json, status = 200) => route.fulfill({ json, status });
        if (req.method() !== 'GET') {
            const body = req.postDataJSON(); writes.push({ endpoint, body });
            assert.ok(endpoint.endsWith('/fork'), `Unexpected write ${endpoint}`);
            if (stale) return send({ error: '会话已变化，请重新打开操作面板' }, 400);
            assert.equal(body.position, 'at'); assert.equal(body.entryId, 'a1');
            sessions.push(forked); messages = messages.slice(0, 2);
            return send({ session: forked, draft: null }, 201);
        }
        if (endpoint === '/api/pi/status') return send({ ok: true, sessionWorkflows: true, replyFork: !legacy, projectRoots: ['/srv'] });
        if (endpoint === '/api/pi/projects') return send({ projects: [{ cwd, name: 'Message actions', sessionCount: sessions.length }], roots: ['/srv'] });
        if (endpoint === '/api/pi/sessions') return send({ sessions });
        if (endpoint === '/api/pi/activity') return send({ runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] });
        if (endpoint.endsWith('/workflow')) return send(snapshot());
        if (endpoint.endsWith('/deferred')) return send({ jobs: [] });
        if (endpoint.includes('/prompt/')) return send({ message: latestQuestion, images: [png], leafId: snapshot().leafId });
        if (endpoint.includes('history') || endpoint === '/api/prompts') return send([]);
        return send({ configured: false });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        socket = ws;
        ws.onMessage(raw => {
            const command = JSON.parse(raw); commands.push(command.type);
            const runtime = { model, isStreaming: streaming, isCompacting: false, thinkingLevel: 'off', autoCompactionEnabled: true };
            if (command.type === 'open_session') {
                active = sessions.find(session => session.id === command.sessionId);
                return reply(ws, command, { session: active, state: runtime, messages: { messages }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } });
            }
            if (command.type === 'get_messages') return reply(ws, command, { messages });
            if (command.type === 'get_state') return reply(ws, command, runtime);
            if (command.type === 'get_session_stats') return reply(ws, command, {});
            throw new Error(`Unexpected RPC ${command.type}`);
        });
    });
    try { await page.goto(base, { waitUntil: 'domcontentloaded' }); }
    catch (error) { console.error('Unfinished page resources:', [...pendingRequests]); throw error; }
    await page.waitForFunction(() => document.querySelectorAll('[data-message-workflow="reply-fork"]').length === 2);
    const users = page.locator('article.user');
    const replies = page.locator('article.assistant');
    assert.equal(await page.locator('article.assistant > header .pi-message-copy').count(), 0);
    assert.equal(await page.locator('article.user [data-message-workflow="fork"]').count(), 0);
    assert.equal(await users.locator('time').count(), 2);
    assert.equal(await users.first().locator('time').textContent(), '2026/09/07 16:20');
    assert.equal(await users.first().locator('time').getAttribute('datetime'), new Date(time).toISOString());
    assert.equal(await users.first().locator('[data-message-workflow="retry"]').count(), 0);
    assert.equal(await users.last().locator('[data-message-workflow="retry"]').count(), 1);
    assert.equal(await replies.filter({ hasText: '检查当前状态。' }).locator('.pi-message-actions').count(), 0, 'tool commentary has no action row');
    assert.equal(await replies.filter({ hasText: '正在核对方案和现有配置' }).locator('.pi-message-actions').count(), 0, 'plain-text progress also has no action row');
    assert.equal(await page.locator('.pi-message-actions').count(), 2, 'one final action row per question');
    const replyTime = replies.first().locator('.pi-reply-time');
    assert.equal(await replyTime.textContent(), '16:20');
    assert.equal(await replyTime.getAttribute('datetime'), new Date(time + 1000).toISOString());
    assert.ok((await replyTime.getAttribute('title')).includes('2026/09/07 16:20'));
    assert.equal(await replyTime.evaluate(node => node === node.parentElement.lastElementChild), true, 'time follows the dynamically added fork action');
    await users.last().locator('[aria-label="复制问题"]').click();
    assert.equal(await page.evaluate(() => window.__copies.at(-1)), latestQuestion);
    await replies.first().locator('[aria-label="复制回复"]').click();
    assert.equal(await page.evaluate(() => window.__copies.at(-1)), firstReply);
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: undefined }));
    await users.first().locator('[aria-label="复制问题"]').click();
    assert.equal(await page.evaluate(() => window.__copies.at(-1)), firstQuestion, 'HTTP fallback copies only the question');
    const layout = async () => {
        const failures = await page.evaluate(() => {
            const failures = [];
            for (const article of document.querySelectorAll('article.pi-message')) {
                const footer = article.querySelector('.pi-message-actions'), body = article.querySelector('.pi-message-body');
                if (footer && footer.getBoundingClientRect().top < body.getBoundingClientRect().bottom - 1) failures.push('footer overlaps body');
                const replyTime = footer?.querySelector('.pi-reply-time');
                if (replyTime) {
                    const lastButton = [...footer.querySelectorAll('button')].at(-1);
                    if (lastButton && replyTime.getBoundingClientRect().left < lastButton.getBoundingClientRect().right) failures.push('reply time overlaps icons');
                    if (replyTime.getBoundingClientRect().right > footer.getBoundingClientRect().right + 1) failures.push('reply time overflows footer');
                }
                const header = article.querySelector('header'), time = header?.querySelector('time'), actions = header?.querySelector('.pi-user-actions');
                if (time && time.getBoundingClientRect().right > actions.getBoundingClientRect().left + 1) failures.push('time overlaps actions');
                for (const group of article.querySelectorAll('.pi-message-actions, .pi-user-actions')) {
                    const buttons = [...group.querySelectorAll('button')];
                    buttons.forEach((button, index) => {
                        const box = button.getBoundingClientRect();
                        if (index && box.left < buttons[index - 1].getBoundingClientRect().right - 1) failures.push('buttons overlap');
                        if (box.width < 30 || box.height < 30 || box.right > innerWidth) failures.push('button framing');
                    });
                }
            }
            if (document.body.scrollWidth > document.body.clientWidth) failures.push('horizontal overflow');
            return failures;
        });
        assert.deepEqual(failures, []);
    };
    await layout();
    await users.last().scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/pi-message-actions-${viewport.width}-question.png` });
    await replies.last().locator('.pi-message-copy').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/pi-message-actions-${viewport.width}-reply.png` });
    await page.locator('[data-transcript-mode="full"]').click(); await layout();
    assert.equal(await page.locator('.pi-message-actions').count(), 2);
    await page.locator('[data-transcript-mode="reading"]').click(); await layout();
    await replies.filter({ hasText: '检查当前状态。' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/pi-message-actions-${viewport.width}-process.png` });
    await users.last().locator('[data-message-workflow="retry"]').click();
    assert.equal(await page.locator('#pi-workflow-message').inputValue(), latestQuestion);
    assert.equal(await page.locator('#pi-workflow-images img').count(), 1);
    await page.locator('#pi-workflow-close').click();
    assert.equal(writes.length, 0);
    streaming = true; emit({ type: 'agent_start' });
    await page.waitForFunction(() => [...document.querySelectorAll('[data-message-workflow="reply-fork"]')].every(button => button.disabled));
    assert.equal(await users.last().locator('[aria-label="复制问题"]').isDisabled(), false);
    const live = { id: 'a3', role: 'assistant', content: [{ type: 'text', text: '流式回复已结束。' }], stopReason: 'stop', timestamp: time + 120000 };
    emit({ type: 'message_start', message: { ...live, content: [] } });
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '流式回复已结束。' } });
    await page.waitForFunction(() => document.querySelector('.streaming .pi-markdown')?.textContent.trim() === '流式回复已结束。');
    assert.equal(await page.locator('.streaming .pi-message-actions').count(), 0);
    messages.push(live); emit({ type: 'message_end', message: live });
    await page.waitForFunction(() => !document.querySelector('article.streaming'));
    assert.equal(await page.locator('.pi-message-actions').count(), 1, 'message_end alone must not expose progress actions');
    socket.close({ code: 1012, reason: 'Fixture reconnect during run' });
    await page.waitForFunction(() => document.querySelector('#pi-connection-text').textContent.includes('重连'));
    await page.waitForFunction(() => document.querySelector('#pi-connection-text').textContent.includes('正在执行'));
    assert.equal(await page.locator('.pi-message-actions').count(), 1, 'running snapshot retains only earlier completed rounds');
    emit({ type: 'agent_end' });
    await page.waitForTimeout(80);
    assert.equal(await page.locator('.pi-message-actions').count(), 1, 'low-level agent_end is not settled');
    streaming = false; emit({ type: 'agent_settled' });
    await page.waitForFunction(() => document.querySelectorAll('[data-message-workflow="reply-fork"]').length === 2);
    assert.equal(await replies.filter({ hasText: '最后一段回复。' }).locator('.pi-message-actions').count(), 0, 'superseded reply in the same round loses its action row');
    assert.equal(await replies.filter({ hasText: '流式回复已结束。' }).locator('.pi-message-actions').count(), 1);
    await layout();
    socket.close({ code: 1012, reason: 'Fixture reconnect' });
    await page.waitForFunction(() => document.querySelector('#pi-connection-text').textContent.includes('重连'));
    await page.waitForFunction(() => document.querySelector('#pi-connection-text').textContent.includes('已连接'));
    await page.waitForFunction(() => document.querySelectorAll('[data-message-workflow="reply-fork"]').length === 2);
    await layout();
    stale = true;
    await replies.first().locator('[data-message-workflow="reply-fork"]').click();
    await page.waitForFunction(() => document.querySelector('#pi-workflow-dialog').open && document.querySelector('#pi-workflow-title').textContent === '从此回复后分叉');
    assert.ok((await page.locator('#pi-workflow-content').textContent()).includes('两个方案'));
    await page.locator('#pi-workflow-submit').click();
    await page.locator('#pi-workflow-error:not([hidden])').waitFor();
    assert.equal(sessions.length, 1);
    await page.locator('#pi-workflow-close').click(); stale = false;
    await page.locator('#pi-input').fill('原线程未发送草稿');
    await replies.first().locator('[data-message-workflow="reply-fork"]').click();
    await page.locator('#pi-workflow-submit').click();
    await page.waitForFunction(() => document.querySelector('#pi-meta-id').textContent === 'reply-fork' && !document.querySelector('#pi-workflow-dialog').open);
    assert.equal(await page.locator('#pi-input').inputValue(), '');
    assert.ok(!(await page.locator('#pi-transcript-content').textContent()).includes('先验证方案 A'));
    assert.equal(writes.at(-1).body.entryId, 'a1');
    assert.equal(writes.at(-1).body.position, 'at');
    legacy = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#pi-connection-text').textContent.includes('已连接'));
    await page.waitForTimeout(200);
    assert.equal(await page.locator('[data-message-workflow="reply-fork"]').count(), 0, 'old backend does not silently clone the wrong boundary');
    assert.equal(await page.locator('.pi-message-copy').count(), 2);
    messages.push(
        { id: 'unfinished-user', role: 'user', content: '尚未得到最终回复的问题', timestamp: time + 180000 },
        { id: 'unfinished-progress', role: 'assistant', content: '只有过程说明，不是最终回复。', timestamp: time + 181000 },
        { id: 'unfinished-tool', role: 'assistant', content: [{ type: 'toolCall', id: 'unfinished-read', name: 'read', arguments: {} }], stopReason: 'toolUse', timestamp: time + 182000 },
        { role: 'toolResult', toolCallId: 'unfinished-read', toolName: 'read', content: [{ type: 'text', text: '工具结果仍可查看' }], timestamp: time + 183000 }
    );
    emit({ type: 'gateway_context_changed', messages });
    await page.waitForFunction(() => document.querySelector('#pi-transcript-content').textContent.includes('只有过程说明'));
    assert.equal(await page.locator('.pi-message-actions').count(), 1, 'tool-only stopped tail must not promote earlier commentary');
    assert.equal(await replies.filter({ hasText: '只有过程说明' }).locator('.pi-message-actions').count(), 0);
    const failure = { id: 'final-failure', role: 'assistant', content: '已终止的部分回复仍可复制。', errorMessage: '受控失败', stopReason: 'error', timestamp: time + 184000 };
    messages.push(failure); emit({ type: 'gateway_context_changed', messages });
    await page.waitForFunction(() => document.querySelector('#pi-transcript-content').textContent.includes('已终止的部分回复'));
    assert.equal(await replies.filter({ hasText: '已终止的部分回复' }).locator('.pi-message-copy').count(), 1);
    const longQuestion = '长问题正文，复制时必须保留完整内容。'.repeat(180);
    const lineQuestion = Array.from({ length: 31 }, (_, i) => `第 ${i + 1} 行`).join('\n');
    messages.push(
        { role: 'user', timestamp: time + 190000, content: [{ type: 'text', text: longQuestion }, png] },
        { role: 'user', timestamp: time + 191000, content: lineQuestion },
        { role: 'user', timestamp: time + 192000, content: '边'.repeat(2400) },
        { role: 'user', timestamp: time + 193000, content: Array(30).fill('普通行').join('\n') }
    );
    emit({ type: 'gateway_context_changed', messages });
    const longUser = users.filter({ hasText: longQuestion });
    const lineUser = users.filter({ hasText: lineQuestion.split('\n')[0] });
    await longUser.locator('.pi-user-text-toggle').waitFor();
    assert.equal(await users.locator('.pi-user-text-toggle').count(), 2, 'only messages beyond generous thresholds fold');
    const toggle = longUser.locator('.pi-user-text-toggle');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    const collapsed = await longUser.locator('.pi-user-long-text').evaluate(node => ({ height: node.clientHeight, full: node.scrollHeight }));
    assert.ok(collapsed.full > collapsed.height, 'preview clips long text');
    assert.equal(await longUser.locator('img').isVisible(), true, 'attachment remains outside the folded text');
    await longUser.locator('.pi-message-copy').click();
    assert.equal(await page.evaluate(() => window.__copies.at(-1)), longQuestion);
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.ok(await longUser.locator('.pi-user-long-text').evaluate(node => node.clientHeight >= node.scrollHeight));
    messages.push({ role: 'assistant', timestamp: time + 194000, content: '折叠状态刷新检查', stopReason: 'stop' });
    emit({ type: 'gateway_context_changed', messages });
    await replies.filter({ hasText: '折叠状态刷新检查' }).waitFor();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'snapshot rebuild preserves expansion');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await lineUser.locator('.pi-user-text-toggle').focus();
    await page.keyboard.press('Enter');
    assert.equal(await lineUser.locator('.pi-user-text-toggle').getAttribute('aria-expanded'), 'true');
    const overflow = await users.evaluateAll(nodes => nodes.flatMap(node => [...node.querySelectorAll('.pi-message-body, .pi-markdown, .pi-user-text-toggle')]).filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.className));
    assert.deepEqual(overflow, [], 'actual message children fit the viewport');
    assert.deepEqual(errors, []);
    assert.equal(commands.some(command => ['prompt', 'steer', 'follow_up'].includes(command)), false);
    await context.close();
    console.log(`Message actions ${viewport.width}x${viewport.height}: passed`);
}
(async () => {
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        for (const [viewport, theme] of [[{ width: 1440, height: 1000 }, 'daylight'], [{ width: 393, height: 852 }, 'mint'], [{ width: 412, height: 915 }, 'dark'], [{ width: 320, height: 740 }, 'daylight']]) await run(browser, viewport, theme);
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
