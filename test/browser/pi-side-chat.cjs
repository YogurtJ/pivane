const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PI_SIDE_TEST_URL || 'http://127.0.0.1:3102';
const cwd = '/srv/side-browser-fixture';
const mainSession = { id: 'main', cwd, name: '主任务', messageCount: 3 };
const otherSession = { ...mainSession, id: 'other', name: '另一个任务' };
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text', 'image'], contextWindow: 32000 };
const sourceTime = Date.parse('2026-09-07T10:00:00Z');
const firstReply = '此前已经比较了 A/B 两个方案，目前继续验证方案 A。';

async function run(browser, viewport, theme, fullContext = true, retention = fullContext) {
    const context = await browser.newContext({ locale: 'zh-CN', viewport, isMobile: viewport.width <= 900, hasTouch: viewport.width <= 900 });
    const page = await context.newPage(); page.setDefaultNavigationTimeout(60000);
    const errors = [], writes = [], mainPrompts = [], sidePrompts = [], preparations = [], sockets = [];
    let mainSocket, activeSide, parentBusy = true, ticks = 0, ticketId = 0, sideCount = 0, closedSides = 0, sendMode = 'normal', holdOpen = false, acceptDialogs = true;
    let messages = [{ role: 'user', content: '先比较两套方案。', timestamp: sourceTime }, { role: 'assistant', content: firstReply, stopReason: 'stop', timestamp: sourceTime + 1 }, { role: 'user', content: '继续验证方案 A。', timestamp: sourceTime + 2 }];
    const tickets = new Map();
    const reply = (ws, cmd, data, error, errorCode) => ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: !error, data, error, errorCode }));
    const send = (ws, event) => ws.send(JSON.stringify(event));
    const mainStats = { contextUsage: { tokens: 2000, percent: 6.25, contextWindow: 32000 }, cost: 0.1, totalMessages: 3 };
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => acceptDialogs ? dialog.accept() : dialog.dismiss());
    await page.addInitScript(({ cwd, theme }) => {
        localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'main'); localStorage.setItem('pi.workspace.theme', theme);
        window.__sideCopies = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => window.__sideCopies.push(text) } });
    }, { cwd, theme });
    await page.route('**/api/**', route => {
        const req = route.request(), endpoint = new URL(req.url()).pathname;
        const respond = json => route.fulfill({ json });
        if (req.method() !== 'GET') { writes.push(endpoint); return respond({ ok: true }); }
        if (endpoint === '/api/pi/status') return respond({ ok: true, sideChat: true, sideChatContext: fullContext, sideChatRetention: retention, sessionWorkflows: true, replyFork: true, projectRoots: ['/srv'] });
        if (endpoint === '/api/pi/projects') return respond({ projects: [{ cwd, name: 'Side fixture', sessionCount: 2 }], roots: ['/srv'] });
        if (endpoint === '/api/pi/sessions') return respond({ sessions: [mainSession, otherSession, ...(retention ? [{ ...mainSession, id: 'third', name: '第三个任务' }, { ...mainSession, id: 'fourth', name: '第四个任务' }] : [])] });
        if (endpoint === '/api/pi/activity') return respond({ runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] });
        if (endpoint.endsWith('/workflow')) return respond({ leafId: 'leaf', lastUserId: 'u2', prompts: [{ entryId: 'u2', text: '继续验证方案 A。', timestamp: sourceTime + 2 }], replies: [{ entryId: 'a1', text: firstReply, timestamp: sourceTime + 1 }], versions: [] });
        if (endpoint.endsWith('/deferred')) return respond({ jobs: [] });
        if (endpoint.includes('history') || endpoint === '/api/prompts') return respond([]);
        return respond({ configured: false });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        const connection = { kind: null, ws, messages: [], busy: false, closed: false };
        sockets.push(connection);
        ws.onClose(() => { connection.closed = true; if (connection.kind === 'side') closedSides++; });
        ws.onMessage(raw => {
            const cmd = JSON.parse(raw);
            if (cmd.type === 'open_session') {
                assert.notEqual(connection.kind, 'side'); connection.kind = 'main'; connection.sessionId = cmd.sessionId; mainSocket = ws;
                return reply(ws, cmd, { session: cmd.sessionId === 'main' ? mainSession : { ...otherSession, id: cmd.sessionId },
                    state: { model, isStreaming: parentBusy, isCompacting: false, thinkingLevel: 'off' },
                    messages: { messages }, stats: mainStats, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } });
            }
            if (connection.kind === 'main') {
                if (cmd.type === 'prepare_side_chat') {
                    preparations.push(cmd);
                    const ticket = `ticket-${++ticketId}`;
                    const mode = cmd.mode || 'context';
                    const reference = { mode, count: cmd.count || 6, capturedAt: new Date(sourceTime + ticketId * 1000).toISOString(),
                        source: { cwd, sessionId: connection.sessionId, name: connection.sessionId === 'main' ? '主任务' : '另一个任务' }, messageCount: mode === 'context' ? messages.length + 40 : mode === 'recent' ? 3 : 0,
                        summaryIncluded: ['context', 'recent'].includes(mode), summaryCount: 2, toolCalls: 20, toolResults: 20, systemIncluded: mode === 'context', omittedThinking: 12,
                        omittedMessages: mode === 'recent' ? 2 : 0, characters: 300, estimatedTokens: mode === 'context' ? 16000 : 100, tokenBudget: mode === 'context' ? 28000 : 8000,
                        preview: ['blank', 'context'].includes(mode) ? [] : [{ role: mode === 'quote' ? 'quote' : 'user', text: mode === 'quote' ? cmd.quote : messages.at(-1).content }] };
                    tickets.set(ticket, reference); return reply(ws, cmd, { ticket, reference, limits: { messageCharacters: 8000 } });
                }
                if (cmd.type === 'get_messages') return reply(ws, cmd, { messages });
                if (cmd.type === 'get_state') return reply(ws, cmd, { model, isStreaming: parentBusy, isCompacting: false, thinkingLevel: 'off' });
                if (cmd.type === 'get_session_stats') return reply(ws, cmd, mainStats);
                if (cmd.type === 'extension_ui_response') { send(ws, { type: 'gateway_ui_resolved', id: cmd.id }); return; }
                if (['prompt', 'steer', 'follow_up'].includes(cmd.type)) { mainPrompts.push(cmd); throw new Error('BTW or transfer must never submit a main prompt'); }
                throw new Error(`Unexpected main command ${cmd.type}`);
            }
            if (cmd.type === 'open_side_chat') {
                connection.kind = 'side'; activeSide = connection; sideCount++;
                assert.ok(tickets.has(cmd.ticket));
                const reference = tickets.get(cmd.ticket); tickets.delete(cmd.ticket);
                if (holdOpen) { connection.pendingOpen = { cmd, reference }; return; }
                return reply(ws, cmd, { state: { sessionId: `side-${sideCount}`, model, isStreaming: false, isCompacting: false }, reference, limits: { messageCharacters: 8000 }, messages: [], stats: {} });
            }
            assert.equal(connection.kind, 'side');
            if (cmd.type === 'get_state') return reply(ws, cmd, { model, isStreaming: connection.busy, isCompacting: false });
            if (cmd.type === 'get_messages') return reply(ws, cmd, { messages: connection.messages });
            if (cmd.type === 'get_session_stats') return reply(ws, cmd, { contextUsage: { tokens: 300, percent: 0.94, contextWindow: 32000 }, cost: 0.002 });
            if (cmd.type === 'quit_side_chat') { reply(ws, cmd, { quit: true }); ws.close({ code: 1000, reason: 'Side ended' }); return; }
            if (cmd.type === 'abort') {
                connection.busy = false;
                if (connection.pendingReply) {
                    const ended = { ...connection.pendingReply, stopReason: 'aborted' }; connection.messages.push(ended); send(ws, { type: 'message_end', message: ended }); connection.pendingReply = null;
                }
                send(ws, { type: 'agent_settled' }); return reply(ws, cmd, {});
            }
            if (cmd.type === 'prompt') {
                sidePrompts.push(cmd);
                if (sendMode === 'reject') return reply(ws, cmd, null, '受控拒绝', 'RPC_REJECTED');
                if (sendMode === 'timeout') return reply(ws, cmd, null, '投递结果不确定', 'RPC_TIMEOUT');
                const user = { role: 'user', content: cmd.message, timestamp: ++ticks };
                const answer = { role: 'assistant', content: [{ type: 'text', text: `## 侧聊回答\n\n${cmd.message}\n\n这是一条独立回答。<script>window.badSide=true</script>` }], stopReason: 'stop', timestamp: ++ticks };
                connection.busy = true; connection.messages.push(user);
                reply(ws, cmd, { accepted: true }); send(ws, { type: 'agent_start' }); send(ws, { type: 'message_end', message: user });
                send(ws, { type: 'message_start', message: { ...answer, content: [] } });
                send(ws, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: answer.content[0].text } });
                if (sendMode === 'hold') { connection.pendingReply = answer; return; }
                connection.messages.push(answer); connection.busy = false;
                send(ws, { type: 'message_end', message: answer }); send(ws, { type: 'agent_settled' }); return;
            }
            throw new Error(`Unexpected side command ${cmd.type}`);
        });
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.querySelector('#pi-input').disabled);
    const parentUsage = await page.locator('#pi-context-tokens').textContent();
    const selectParentText = async () => page.evaluate(() => {
        const node = document.querySelector('#pi-transcript-content .assistant .pi-markdown');
        const selection = window.getSelection(); selection.removeAllRanges();
        const range = document.createRange(); range.selectNodeContents(node); selection.addRange(range);
        return selection.toString();
    });
    await page.locator('#pi-input').fill('/btw 解释乐观锁');
    assert.ok((await selectParentText()).includes(firstReply));
    await page.locator('#pi-input').press('Enter');
    await page.waitForFunction(() => document.querySelector('#pi-side-messages').textContent.includes('这是一条独立回答。') && document.querySelector('#pi-input').value === '');
    assert.equal(sideCount, 1); assert.equal(mainPrompts.length, 0);
    assert.equal(preparations[0].mode, fullContext ? 'context' : 'recent');
    assert.equal(preparations[0].retainOnSwitch, retention ? true : undefined);
    assert.equal(preparations[0].quote, undefined, 'text selection does not change /btw background');
    assert.equal(await page.locator('[data-side-quote]').count(), 0);
    assert.equal(await page.locator('#pi-side-source option[value="quote"]').count(), 0);
    if (fullContext) assert.deepEqual(await page.locator('#pi-side-source option').evaluateAll(options => options.filter(option => !option.hidden).map(option => option.textContent)), ['接着当前任务聊', '单独问个问题']);
    assert.equal(await page.locator('#pi-side-source option[value="recent-6"]').evaluate(node => node.hidden), fullContext);
    if (fullContext) assert.match(await page.locator('#pi-side-reference-preview').textContent(), /工具调用.*主会话指令.*创建时冻结/);
    assert.ok(!await page.locator('#pi-transcript-content').textContent().then(text => text.includes('侧聊回答')));
    assert.match(await page.locator('#pi-side-parent-state').textContent(), /处理中/);
    assert.equal(await page.evaluate(() => window.badSide), undefined);
    // Layout changes must not prepare context, recreate sockets, or touch the main draft.
    const divider = page.locator('#pi-inspector-split');
    const inspectorWidth = () => page.locator('#pi-inspector').evaluate(node => node.getBoundingClientRect().width);
    const reference = page.locator('#pi-side-reference');
    assert.equal(await reference.evaluate(node => node.open), false);
    assert.equal(await page.locator('#pi-side-source').isVisible(), false);
    const collapsedTop = await page.evaluate(() => document.querySelector('.pi-side-viewport').getBoundingClientRect().top - document.querySelector('#pi-inspector').getBoundingClientRect().top);
    assert.ok(collapsedTop <= 140, `compact header uses ${collapsedTop}px`);
    const collapsedHeight = await page.locator('.pi-side-viewport').evaluate(node => node.clientHeight);
    await page.locator('#pi-side-reference summary').click();
    assert.equal(await page.locator('#pi-side-source').isVisible(), true);
    await page.locator('#pi-side-reference summary').click();
    assert.ok(await page.locator('.pi-side-viewport').evaluate(node => node.clientHeight) >= collapsedHeight - 1);
    if (viewport.width > 900) {
        await divider.waitFor({ state: 'visible' });
        const beforeWidth = await inspectorWidth();
        let grip = await divider.boundingBox();
        await page.mouse.move(grip.x + grip.width / 2, grip.y + 100);
        await page.mouse.down(); await page.mouse.move(grip.x - 100, grip.y + 100, { steps: 8 }); await page.mouse.up();
        assert.ok(await inspectorWidth() > beforeWidth + 20, 'drag left gives the side panel more width');
        assert.equal(await page.evaluate(() => document.body.classList.contains('is-resizing')), false);
        await divider.focus(); await page.keyboard.press('ArrowRight');
        const narrower = await inspectorWidth();
        await page.keyboard.press('ArrowLeft');
        assert.equal(await inspectorWidth(), narrower + 16, 'keyboard follows the physical divider direction');
        const savedWidth = await inspectorWidth();
        assert.equal(await page.evaluate(() => Number(localStorage.getItem('pi.workspace.split:agent-inspector'))), savedWidth);
        await page.locator('#pi-details-tab').click();
        assert.equal(await inspectorWidth(), savedWidth, 'details and side chat share the chosen width');
        await page.locator('#pi-side-tab').click();
        await page.locator('#pi-side-input').fill('分栏布局草稿');
        await page.setViewportSize({ width: 393, height: 852 });
        await page.waitForTimeout(100);
        assert.equal(await divider.isVisible(), false, 'mobile retains a drawer');
        await page.setViewportSize(viewport);
        await page.waitForFunction(width => Math.abs(document.querySelector('#pi-inspector').getBoundingClientRect().width - width) < 1, savedWidth);
        assert.equal(await inspectorWidth(), savedWidth, 'desktop width returns after a mobile viewport');
        assert.equal(await page.locator('#pi-side-input').inputValue(), '分栏布局草稿');
        await page.locator('#pi-side-input').fill('');
        await divider.focus(); await page.keyboard.press('End');
        await page.waitForTimeout(100);
        const bounds = await page.evaluate(() => {
            const main = document.querySelector('.pi-transcript-shell').getBoundingClientRect();
            const side = document.querySelector('#pi-inspector').getBoundingClientRect();
            const overflow = ['.pi-transcript-shell', '#pi-transcript', '#pi-transcript-content', '.pi-composer-wrap'].filter(selector => {
                const node = document.querySelector(selector); return node.scrollWidth > node.clientWidth + 1;
            });
            return { mainWidth: main.width, mainRight: main.right, sideLeft: side.left, overflow };
        });
        assert.ok(bounds.mainWidth >= 359, 'resizing reserves a readable main conversation');
        assert.ok(bounds.mainRight <= bounds.sideLeft, 'desktop side pane does not cover the main conversation');
        assert.deepEqual(bounds.overflow, [], 'narrow main transcript and composer must not overflow');
        await divider.dblclick();
        assert.ok(Math.abs(await inspectorWidth() - beforeWidth) <= 1);
        await page.locator('#pi-close-inspector').click();
        assert.equal(await divider.isVisible(), false, 'closed inspector leaves no splitter or tab stop');
        await page.locator('#pi-toggle-side-chat').click();
    } else assert.equal(await divider.isVisible(), false);
    assert.equal(sideCount, 1); assert.equal(preparations.length, 1);
    assert.equal(await reference.evaluate(node => node.open), false);
    await page.screenshot({ path: `/tmp/pi-side-panel-${viewport.width}-collapsed.png` });
    const referenceBefore = await page.locator('#pi-side-reference-label').textContent();
    await page.locator('#pi-side-input').fill('继续解释'); await page.locator('#pi-side-send').click();
    await page.waitForFunction(() => document.querySelectorAll('#pi-side-messages article.assistant').length === 2 && document.querySelector('#pi-side-input').value === '' && document.querySelector('#pi-side-stop').hidden);
    await page.locator('#pi-side-messages [data-side-action="copy"]').last().click();
    assert.ok((await page.evaluate(() => window.__sideCopies.at(-1))).includes('继续解释'));
    await page.locator('#pi-side-input').fill('保留当前侧聊草稿');
    await page.locator('#pi-close-inspector').click();
    assert.equal(closedSides, 0, 'collapsing does not end the side runtime');
    assert.ok((await selectParentText()).includes(firstReply));
    await page.locator('#pi-toggle-side-chat').click();
    assert.equal(sideCount, 1);
    assert.equal(await page.locator('#pi-side-input').inputValue(), '保留当前侧聊草稿');
    await page.locator('#pi-side-input').fill('');
    if (viewport.width <= 900) {
        send(mainSocket, { type: 'extension_ui_request', id: 'side-parent-confirm', method: 'confirm', title: '主任务确认', message: '受控确认' });
        await page.waitForFunction(() => document.querySelector('#pi-side-parent-state').textContent.includes('等待确认'));
        assert.equal(await page.locator('#pi-request-dialog').evaluate(node => node.open), false);
        await page.locator('#pi-side-parent-state').click();
        await page.locator('#pi-request-submit').click();
        await page.waitForFunction(() => !document.querySelector('#pi-request-dialog').open);
        await page.locator('#pi-toggle-side-chat').click();
        assert.equal(sideCount, 1);
    }
    await page.locator('#pi-details-tab').click();
    assert.equal(await page.locator('#pi-context-tokens').textContent(), parentUsage);
    await page.locator('#pi-side-tab').click();
    assert.equal(sideCount, 1, 'switching inspector tabs does not recreate the runtime');
    const update = { role: 'assistant', content: '主任务后续输出。', stopReason: 'stop', timestamp: sourceTime + 3 };
    send(mainSocket, { type: 'message_start', message: update }); messages.push(update); send(mainSocket, { type: 'message_end', message: update });
    parentBusy = false; send(mainSocket, { type: 'agent_settled' });
    await page.waitForFunction(() => document.querySelector('#pi-side-parent-state').textContent.includes('空闲'));
    assert.equal(await page.locator('#pi-side-reference-label').textContent(), referenceBefore);
    assert.ok(!(await page.locator('#pi-side-reference-preview').textContent()).includes('主任务后续输出'));
    await page.locator('#pi-input').fill('保留主草稿');
    await page.locator('#pi-side-messages [data-side-action="insert"]').last().click();
    assert.match(await page.locator('#pi-input').inputValue(), /^保留主草稿\n\n## 侧聊回答/);
    assert.equal(mainPrompts.length, 0);
    await page.locator('#pi-toggle-side-chat').click();
    await page.locator('#pi-side-reference summary').click();
    const checkLayout = async () => {
        assert.equal(await page.evaluate(() => document.body.scrollWidth > document.body.clientWidth), false);
        assert.equal(await page.locator('#pi-side-chat').evaluate(node => node.scrollWidth > node.clientWidth), false);
        const box = await page.locator('#pi-inspector').boundingBox();
        let inputBox = await page.locator('#pi-side-input').boundingBox();
        if (inputBox.y + inputBox.height > box.y + box.height + 1) {
            assert.equal(await page.locator('#pi-side-chat').evaluate(node => getComputedStyle(node).overflowY), 'auto');
            await page.locator('#pi-side-input').scrollIntoViewIfNeeded();
            inputBox = await page.locator('#pi-side-input').boundingBox();
        }
        assert.ok(inputBox.x >= box.x && inputBox.x + inputBox.width <= box.x + box.width + 1);
        assert.ok(inputBox.y + inputBox.height <= box.y + box.height + 1, 'side composer remains inside the panel');
        if (viewport.width <= 900) assert.ok(await page.locator('#pi-side-input').evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 16));
    };
    await checkLayout();
    await page.screenshot({ path: `/tmp/pi-side-chat-${viewport.width}-conversation.png` });
    if (fullContext) await page.locator('#pi-side-refresh').click();
    else await page.locator('#pi-side-source').selectOption('recent-12');
    await page.waitForFunction(() => document.querySelector('#pi-side-status').textContent === '侧聊已就绪' && document.querySelectorAll('#pi-side-messages article').length === 0);
    assert.equal(preparations.at(-1).mode, fullContext ? 'context' : 'recent');
    if (!fullContext) assert.equal(preparations.at(-1).count, 12);
    assert.equal(sideCount, 2);
    if (fullContext) assert.notEqual(await page.locator('#pi-side-reference-label').textContent(), referenceBefore);
    else assert.ok((await page.locator('#pi-side-reference-preview').textContent()).includes('主任务后续输出'));
    const beforeCancel = preparations.length;
    await page.locator('#pi-side-input').fill('切换背景前的草稿');
    const previousSource = await page.locator('#pi-side-source').inputValue();
    acceptDialogs = false;
    await page.locator('#pi-side-source').selectOption('blank');
    await page.waitForFunction(value => document.querySelector('#pi-side-source').value === value, previousSource);
    assert.equal(preparations.length, beforeCancel);
    assert.equal(await page.locator('#pi-side-input').inputValue(), '切换背景前的草稿');
    acceptDialogs = true;
    await page.locator('#pi-side-source').selectOption('blank');
    await page.waitForFunction(() => document.querySelector('#pi-side-source').value === 'blank' && document.querySelector('#pi-side-status').textContent === '侧聊已就绪');
    assert.equal(preparations.at(-1).mode, 'blank');
    assert.equal(preparations.at(-1).quote, undefined);
    assert.match(await page.locator('#pi-side-reference-preview').textContent(), /无主会话背景/);
    await page.locator('#pi-side-input').fill(`解释这段文字：\n${firstReply}`);
    await page.locator('#pi-side-send').click();
    await page.waitForFunction(() => document.querySelector('#pi-side-input').value === '' && document.querySelector('#pi-side-stop').hidden);
    assert.equal(sidePrompts.at(-1).message, `解释这段文字：\n${firstReply}`);
    sendMode = 'reject';
    await page.locator('#pi-side-input').fill('保留被拒绝的问题'); await page.locator('#pi-side-send').click();
    await page.waitForFunction(() => document.querySelector('#pi-side-status').textContent.includes('受控拒绝'));
    assert.equal(await page.locator('#pi-side-input').inputValue(), '保留被拒绝的问题');
    sendMode = 'timeout'; await page.locator('#pi-side-send').click();
    await page.waitForFunction(() => document.querySelector('#pi-side-status').textContent.includes('不确定'));
    sendMode = 'normal'; await page.locator('#pi-side-send').click();
    await page.waitForFunction(() => document.querySelector('#pi-side-input').value === '');
    assert.equal(sidePrompts.at(-1).confirmUncertain, true);
    sendMode = 'hold'; await page.locator('#pi-side-input').fill('停止这条侧聊'); await page.locator('#pi-side-send').click();
    await page.locator('#pi-side-stop:not([hidden])').waitFor(); await page.locator('#pi-side-stop').click();
    await page.waitForFunction(() => document.querySelector('#pi-side-stop').hidden);
    assert.ok(!sockets.find(item => item.kind === 'main').closed);
    await checkLayout();
    await page.screenshot({ path: `/tmp/pi-side-chat-${viewport.width}-stopped.png` });
    activeSide.ws.close({ code: 1011, reason: 'Fixture disconnect' });
    await page.waitForFunction(() => document.querySelector('#pi-side-status').textContent.includes('连接已断开'));
    const countBefore = sideCount; await page.waitForTimeout(1800);
    assert.equal(sideCount, countBefore, 'no silent ephemeral reconnect or resend');
    assert.ok((await page.locator('#pi-side-messages').textContent()).includes('停止这条侧聊'));
    await page.locator('#pi-side-end').click();
    await page.waitForFunction(() => document.querySelector('#pi-side-messages').textContent === '暂无侧聊消息');
    assert.equal(await page.locator('#pi-side-reference-preview').textContent(), '');
    assert.equal(await page.locator('#pi-side-input').inputValue(), '');
    sendMode = 'normal'; holdOpen = true;
    assert.ok((await selectParentText()).includes(firstReply));
    await page.locator('#pi-toggle-side-chat').click();
    assert.equal(preparations.at(-1).mode, fullContext ? 'context' : 'recent');
    assert.equal(preparations.at(-1).quote, undefined);
    await page.waitForFunction(() => document.querySelector('#pi-side-status').textContent === '正在启动无工具侧聊');
    await page.locator('#pi-side-end').click();
    await page.waitForFunction(() => document.querySelector('#pi-side-status').textContent === '侧聊已结束');
    holdOpen = false;
    await page.locator('#pi-side-refresh').click();
    await page.waitForFunction(() => document.querySelector('#pi-side-status').textContent === '侧聊已就绪');
    await page.locator('#pi-side-input').fill('切换前的侧聊'); await page.locator('#pi-side-send').click();
    await page.waitForFunction(() => document.querySelector('#pi-side-stop').hidden && document.querySelector('#pi-side-input').value === '' && document.querySelector('#pi-side-messages [data-side-action="insert"]'));
    if (retention) {
        const switchThread = async id => {
            if (viewport.width <= 900) await page.locator('#pi-toggle-sessions').click();
            else await page.locator('#pi-close-inspector').click();
            await page.locator('[data-filter="all"]').click();
            await page.locator(`[data-session-id="${id}"] .pi-session-main`).click();
            await page.waitForFunction(id => document.querySelector('#pi-meta-id').textContent === id && !document.querySelector('#pi-input').disabled, id);
        };
        const sourceReference = await page.locator('#pi-side-reference-label').textContent();
        sendMode = 'hold';
        await page.locator('#pi-side-input').fill('A 后台继续回答\n' + '保持阅读位置。\n'.repeat(50));
        await page.locator('#pi-side-send').click();
        await page.locator('#pi-side-stop:not([hidden])').waitFor();
        const retainedA = activeSide, openedCount = sideCount;
        await page.locator('#pi-side-input').fill('A 的未发送草稿');
        await page.locator('#pi-side-transcript').evaluate(node => {
            node.scrollTop = 60; node.dispatchEvent(new Event('scroll'));
            node.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
        });
        const readingTop = await page.locator('#pi-side-transcript').evaluate(node => node.scrollTop);
        await switchThread('other');
        assert.equal(retainedA.closed, false, 'switching must keep the original side socket');
        assert.ok(!(await page.locator('#pi-side-messages').textContent()).includes('切换前的侧聊'));
        assert.equal(await page.locator('#pi-side-input').inputValue(), '');
        sendMode = 'normal';
        await page.locator('#pi-toggle-side-chat').click();
        await page.waitForFunction(() => document.querySelector('#pi-side-status').textContent === '侧聊已就绪');
        await page.locator('#pi-side-input').fill('B 独立问题'); await page.locator('#pi-side-send').click();
        await page.waitForFunction(() => document.querySelector('#pi-side-input').value === '' && document.querySelector('#pi-side-stop').hidden);
        const retainedB = activeSide;
        await page.locator('#pi-side-input').fill('B 的草稿');
        const completed = retainedA.pendingReply; retainedA.pendingReply = null; retainedA.messages.push(completed); retainedA.busy = false;
        send(retainedA.ws, { type: 'message_end', message: completed }); send(retainedA.ws, { type: 'agent_settled' });
        await page.waitForTimeout(100);
        assert.ok(!(await page.locator('#pi-side-messages').textContent()).includes('A 后台继续回答'));
        assert.equal(await page.locator('#pi-side-input').inputValue(), 'B 的草稿');
        await switchThread('main');
        await page.locator('#pi-toggle-side-chat').click();
        await page.waitForFunction(() => document.querySelector('#pi-side-messages').textContent.includes('A 后台继续回答') && document.querySelector('#pi-side-stop').hidden);
        assert.equal(sideCount, openedCount + 1, 'returning does not create a new side runtime');
        assert.equal(await page.locator('#pi-side-input').inputValue(), 'A 的未发送草稿');
        assert.equal(await page.locator('#pi-side-reference-label').textContent(), sourceReference, 'background stays frozen');
        assert.ok(!(await page.locator('#pi-side-messages').textContent()).includes('B 独立问题'));
        assert.ok(Math.abs(await page.locator('#pi-side-transcript').evaluate(node => node.scrollTop) - readingTop) <= 4, 'return restores the side reading position');
        assert.equal(await page.locator('#pi-side-chat').count(), 1, 'only the selected thread DOM is attached');
        await page.locator('#pi-side-messages [data-side-action="insert"]').last().click();
        assert.ok((await page.locator('#pi-input').inputValue()).includes('A 后台继续回答'));
        await page.locator('#pi-toggle-side-chat').click();
        await switchThread('third');
        await page.locator('#pi-toggle-side-chat').click();
        await page.waitForFunction(() => document.querySelector('#pi-side-status').textContent === '侧聊已就绪');
        const retainedC = activeSide;
        await switchThread('fourth');
        const atLimit = sideCount;
        await page.locator('#pi-toggle-side-chat').click();
        await page.waitForFunction(() => document.querySelector('#pi-side-status').textContent.includes('最多保留 3 段'));
        assert.equal(sideCount, atLimit);
        assert.ok([retainedA, retainedB, retainedC].every(side => !side.closed));
        await switchThread('other'); await page.locator('#pi-toggle-side-chat').click();
        assert.equal(await page.locator('#pi-side-input').inputValue(), 'B 的草稿');
        await page.locator('#pi-side-end').click();
        await switchThread('fourth'); await page.locator('#pi-toggle-side-chat').click();
        await page.waitForFunction(() => document.querySelector('#pi-side-status').textContent === '侧聊已就绪');
        assert.equal(sideCount, atLimit + 1, 'ending a cached side chat releases its slot');
        assert.ok(!retainedA.closed && !retainedC.closed);
        await page.locator('#pi-side-end').click();
        holdOpen = true;
        await page.locator('#pi-side-reference summary').click();
        await page.locator('#pi-side-refresh').click();
        await page.waitForFunction(() => document.querySelector('#pi-side-status').textContent === '正在启动无工具侧聊');
        const startingD = activeSide, countAtStartup = sideCount;
        await switchThread('main'); await page.locator('#pi-toggle-side-chat').click();
        const aText = await page.locator('#pi-side-messages').textContent();
        holdOpen = false;
        reply(startingD.ws, startingD.pendingOpen.cmd, { state: { sessionId: 'delayed-side', model, isStreaming: false }, reference: startingD.pendingOpen.reference,
            limits: { messageCharacters: 8000 }, messages: [], stats: {} });
        await page.waitForTimeout(100);
        assert.equal(await page.locator('#pi-side-messages').textContent(), aText, 'late startup stays with its own thread');
        assert.equal(await page.locator('#pi-side-input').inputValue(), 'A 的未发送草稿');
        await switchThread('fourth'); await page.locator('#pi-toggle-side-chat').click();
        await page.waitForFunction(() => document.querySelector('#pi-side-status').textContent === '侧聊已就绪');
        assert.equal(sideCount, countAtStartup, 'return resumes an already claimed startup');
        await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
        await page.waitForTimeout(100);
        assert.ok([retainedA, retainedB, retainedC, activeSide].every(side => side.closed), 'page exit closes all retained side sockets');
    } else {
        if (viewport.width <= 900) await page.locator('#pi-toggle-sessions').click();
        else await page.locator('#pi-close-inspector').click();
        await page.locator('[data-filter="all"]').click();
        await page.locator('[data-session-id="other"] .pi-session-main').click();
        await page.waitForFunction(() => document.querySelector('#pi-meta-id').textContent === 'other');
        acceptDialogs = false;
        await page.locator('#pi-toggle-side-chat').click();
        await page.locator('#pi-side-messages [data-side-action="insert"]').last().click();
        await page.waitForFunction(() => document.querySelector('#pi-side-status').textContent.includes('主会话已切换'));
        assert.equal(await page.locator('#pi-input').inputValue(), '', 'old side replies cannot be inserted into a different main thread');
        acceptDialogs = true;
        await page.locator('#pi-side-end').click();
    }
    assert.deepEqual(errors, []); assert.deepEqual(writes, []); assert.equal(mainPrompts.length, 0);
    await context.close();
    console.log(`Side chat ${viewport.width}x${viewport.height} (${fullContext ? 'full context' : 'legacy backend'}): passed`);
}
(async () => {
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        for (const [viewport, theme] of [[{ width: 1440, height: 1000 }, 'daylight'], [{ width: 393, height: 852 }, 'mint'], [{ width: 412, height: 915 }, 'dark'], [{ width: 1024, height: 768 }, 'daylight'], [{ width: 320, height: 740 }, 'daylight'], [{ width: 852, height: 430 }, 'dark']]) if (!process.env.PI_SIDE_VIEWPORT || process.env.PI_SIDE_VIEWPORT === String(viewport.width)) await run(browser, viewport, theme);
        if (!process.env.PI_SIDE_VIEWPORT || process.env.PI_SIDE_VIEWPORT === 'legacy') await run(browser, { width: 393, height: 852 }, 'daylight', false);
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
