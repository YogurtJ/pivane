const assert = require('node:assert/strict');
const { selectMessageView } = require('./pi-mobile-view-helper.cjs');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const cwd = '/synthetic/subagent-project';
const sessions = [{ cwd, id: 'main', name: 'Subagent fixture' }, { cwd, id: 'empty', name: 'Empty fixture' }];
const model = { provider: 'fixture', id: 'fixture', input: ['text'], contextWindow: 32000 };
const now = Date.now();
let revision = 0;
const running = { version: 1, generatedAt: now, omitted: { runs: 0, children: 0 }, runs: [{
    id: 'run-1', kind: 'workflow', label: 'Review <img src=x onerror=alert(1)> ' + 'long-workflow-label-'.repeat(6), state: 'running', startedAt: now - 65000,
    activity: { currentTool: 'read', turnCount: 3, toolCount: 7 },
    children: [{ id: 'run-1:0', kind: 'step', label: 'scout', state: 'complete' }, { id: 'run-1:1', kind: 'step', label: 'reviewer ' + 'x'.repeat(80), state: 'running', activity: { currentTool: 'bash' } }]
}] };
const finished = { ...running, runs: [{ ...running.runs[0], state: 'paused', endedAt: now - 1000, children: [] }] };
const controls = (snapshot, active) => ({ runtimeId: 'main', revision: ++revision, queue: { steering: [], followUp: [] }, recoveries: [], stopping: false, drafts: [], draftOverflow: false,
    extension: { title: '', statuses: [], widgets: [] }, subagents: { snapshot, background: active === null ? null : { supported: true, active, sources: active ? ['pi-subagents'] : [] } } });
const longReport = '## Review result\n\n' + Array.from({ length: 30 }, (_, index) => `- finding ${index} <img src=x onerror="window.__xss=1">`).join('\n');
const messages = [
    { role: 'user', timestamp: 1, content: 'Delegate a review' },
    { role: 'assistant', timestamp: 2, content: [{ type: 'toolCall', name: 'subagents_enable', id: 'enable', arguments: {} }] },
    { role: 'toolResult', toolName: 'subagents_enable', toolCallId: 'enable', timestamp: 3, content: [{ type: 'text', text: 'enabled' }], isError: false },
    { role: 'assistant', timestamp: 4, content: [{ type: 'toolCall', name: 'subagent', id: 'launch', arguments: { agent: 'reviewer', task: 'Review', async: true } }] },
    { role: 'toolResult', toolName: 'subagent', toolCallId: 'launch', timestamp: 5, content: [{ type: 'text', text: 'Started run-1' }], isError: false },
    { role: 'assistant', timestamp: 6, content: [{ type: 'toolCall', name: 'subagent_supervisor', id: 'reply', arguments: { action: 'reply', message: 'ok' } }] },
    { role: 'toolResult', toolName: 'subagent_supervisor', toolCallId: 'reply', timestamp: 7, content: [{ type: 'text', text: 'sent' }], isError: false },
    { role: 'custom', customType: 'subagent_supervisor_request', display: true, timestamp: 8, content: 'reviewer asks: **may I edit tests?**' },
    { role: 'custom', customType: 'subagent-notify', display: true, timestamp: 9, content: longReport },
    { role: 'custom', customType: 'unrelated-extension', display: true, timestamp: 10, content: 'Other extension note' }
];
const innerWidthOf = width => width;
async function check(browser, base, width, language) {
    const fixtureNow = Date.now();
    running.generatedAt = fixtureNow; running.runs[0].startedAt = fixtureNow - 65000;
    finished.runs[0].startedAt = fixtureNow - 65000; finished.runs[0].endedAt = fixtureNow - 1000;
    const en = language === 'en';
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: language });
    const page = await context.newPage(), errors = [], commands = [];
    page.on('pageerror', error => errors.push(error.message));
    let socket, sequence = 0, active = sessions[0], stopFails = false;
    const emit = event => socket.send(JSON.stringify({ ...event, webRuntimeId: active.id, webSequence: ++sequence }));
    await page.addInitScript(({ cwd, language }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'main'); localStorage.setItem('pi.workspace.language', language); }, { cwd, language });
    await page.route('https://**', route => route.abort());
    await page.route('**/api/**', route => {
        const url = new URL(route.request().url()), send = json => route.fulfill({ json });
        if (url.pathname === '/api/pi/status') return send({ ok: true, projectRoots: ['/synthetic'] });
        if (url.pathname === '/api/pi/projects') return send({ projects: [{ cwd, name: 'Fixture', sessionCount: 2 }], roots: ['/synthetic'] });
        if (url.pathname === '/api/pi/sessions') return send({ sessions });
        if (url.pathname === '/api/pi/activity') return send({ runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] });
        if (url.pathname.includes('history') || url.pathname === '/api/prompts') return send([]);
        return send({ configured: false });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => {
        socket = ws;
        const cmd = JSON.parse(raw);
        const reply = data => ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }));
        const fail = error => ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: false, error }));
        const state = { model, thinkingLevel: 'off', isStreaming: false, isCompacting: false };
        const data = () => ({ messages: active.id === 'main' ? messages : [], webLive: { runtimeId: active.id, sequence, tools: [], running: false } });
        if (cmd.type === 'open_session') {
            active = sessions.find(s => s.id === cmd.sessionId);
            return reply({ session: active, state, messages: data(), models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] }, stats: {},
                controls: active.id === 'main' ? controls(running, true) : controls(null, null) });
        }
        if (cmd.type === 'get_state') return reply(state);
        if (cmd.type === 'get_session_stats') return reply({});
        if (cmd.type === 'get_messages') return reply(data());
        if (cmd.type === 'subagent_control') {
            commands.push({ method: cmd.method, params: cmd.params });
            if (cmd.method === 'status' && cmd.params.id) return reply({ text: ['Run: run-1', 'Dir: /private/async/run-1',
                'Step 1: reviewer <b>x</b> (reviewer) running (claude-opus-4-5 · thinking high), active now', 'Step 2: scout (scout) complete'].join('\n') });
            if (cmd.method === 'status') return reply({ text: 'ok', snapshot: running });
            if (cmd.method === 'cost') return reply({ cost: { parent: { input: 1200, output: 300, cost: 0.012 }, childTotal: { input: 45000, output: 2000, cost: 0.31 },
                total: { input: 46200, output: 2300, cost: 0.322 }, unresolvedAsyncChildren: 1, children: [{ label: 'reviewer: check auth', agent: 'reviewer', usage: { input: 45000, output: 2000, cost: 0.31 } }] } });
            if (cmd.method === 'stop' && stopFails) return fail('Async run run-1 is complete; stop only supports running async runs.');
            return reply(cmd.method === 'stop' ? { state: 'stopping', text: 'Stop requested' } : { text: 'delivered' });
        }
        throw new Error(`Unexpected command: ${cmd.type}`);
    }));
    await page.goto(base);
    await page.locator('#pi-input').fill('Keep my draft');
    const panel = page.locator('#pi-subagent-runs');
    await panel.waitFor({ state: 'visible' });
    assert.equal(await page.locator('#pi-agent-state').textContent(), en ? 'Subagents running · 1' : '子 Agent 运行中 · 1');
    emit({ type: 'agent_settled' });
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#pi-agent-state').textContent(), en ? 'Subagents running · 1' : '子 Agent 运行中 · 1', 'main settlement must not hide child work');
    emit({ type: 'auto_retry_start', attempt: 1, delayMs: 1000 });
    await page.waitForFunction(label => document.querySelector('#pi-agent-state').textContent === label, en ? 'Retrying' : '重试中');
    emit({ type: 'auto_retry_end', success: true });
    assert.equal(await panel.evaluate(node => node.open), false, 'running work stays collapsed');
    assert.ok(await panel.evaluate(node => node.getBoundingClientRect().height) <= 42, 'collapsed chip is one line');
    // With a plan too, both chips share one row; only one popover is open at a time.
    emit({ type: 'gateway_progress', progress: { version: 1, id: 'plan', explanation: '', plan: [{ step: 'Review the auth flow '.repeat(4), status: 'in_progress' }, { step: 'Ship', status: 'pending' }] } });
    const progress = page.locator('#pi-task-progress');
    await progress.waitFor({ state: 'visible' });
    const rows = await page.locator('#pi-composer-chips > details:not([hidden])').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { top: Math.round(r.top), right: r.right }; }));
    assert.equal(rows.length, 2); assert.equal(rows[0].top, rows[1].top, 'chips share one row');
    assert.ok(rows.every(row => row.right <= innerWidthOf(width) + 1), 'chips fit the width');
    assert.equal(await panel.locator('.sa-runs-count').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'subagent count is not truncated');
    await progress.locator('summary').click();
    await panel.locator('summary').click();
    assert.deepEqual([await panel.evaluate(node => node.open), await progress.evaluate(node => node.open)], [true, false], 'opening one closes the other');
    await page.screenshot({ path: `/tmp/pivane-composer-status-open-${width}-${language}.png` });
    assert.equal(await panel.locator('.sa-runs-count').textContent(), en ? '1 running' : '1 个运行中');
    assert.equal(await panel.locator('.sa-runs-keep').isVisible(), true);
    assert.equal(await panel.locator('.sa-run').count(), 1);
    assert.equal(await panel.locator('.sa-run-children > li').count(), 2);
    assert.equal(await panel.locator('img').count(), 0, 'labels are text');
    assert.match(await panel.locator('.sa-run-time').textContent(), en ? /1m \d+s/ : /1 分 \d+ 秒/);
    assert.match(await panel.locator('.sa-run-meta').textContent(), en ? /Workflow · Using read · 3 turns · 7 tool calls/ : /工作流 · 正在使用 read · 3 轮 · 7 次工具/);

    // Models (the log view was removed)
    assert.equal(await panel.getByRole('button', { name: en ? 'View log' : '查看记录' }).count(), 0);
    await panel.getByRole('button', { name: en ? 'View models' : '查看模型' }).click();
    const dialog = page.locator('dialog.sa-runs-dialog[open]');
    await dialog.waitFor();
    assert.deepEqual(commands.at(-1), { method: 'status', params: { id: 'run-1' } });
    assert.equal(await dialog.evaluate(node => node.textContent.includes('/private')), false, 'only step lines are shown');
    assert.deepEqual(await page.evaluate(() => window.PiSubagentRuns.stepModels([
        'Step 1: reviewer running (anthropic/claude-opus-4 · thinking high), active now, error: later failed',
        'Step 2/3 Agent 1/2: [review] auth check (reviewer) complete (gpt-5)',
        'Workflow child s1: s1-source (worker) failed, error: boom', 'Agent 2/2: scout pending (thinking low)', 'Dir: /x'].join('\n'))), [
        { step: 'Step 1', name: 'reviewer', agent: '', state: 'running', model: 'anthropic/claude-opus-4', thinking: 'high' },
        { step: 'Step 2/3 Agent 1/2', name: 'auth check', agent: 'reviewer', state: 'complete', model: 'gpt-5', thinking: '' },
        { step: 'Workflow child s1', name: 's1-source', agent: 'worker', state: 'failed', model: '', thinking: '' },
        { step: 'Agent 2/2', name: 'scout', state: 'pending', agent: '', model: '', thinking: 'low' }]);
    assert.equal(await dialog.locator('.sa-model').count(), 2);
    assert.equal(await dialog.locator('.sa-model-name').first().textContent(), 'reviewer <b>x</b>');
    assert.equal(await dialog.locator('.sa-model-id').first().textContent(), 'claude-opus-4-5');
    assert.equal(await dialog.locator('.sa-model-thinking').first().textContent(), en ? 'Thinking High' : '思考 高');
    assert.equal(await dialog.locator('.sa-model-id.muted').textContent(), en ? 'Default model' : '默认模型');
    assert.ok(await dialog.evaluate(node => node.getBoundingClientRect().right <= innerWidth + 1 && [...node.querySelectorAll('.sa-model')].every(item => item.scrollWidth <= item.clientWidth + 1)));
    await page.screenshot({ path: `/tmp/pivane-subagent-models-${width}-${language}.png` });
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' }).catch(() => {});
    assert.equal(await page.locator('dialog.sa-runs-dialog[open]').count(), 0);

    // Steer
    await panel.getByRole('button', { name: en ? 'Steer' : '引导' }).click();
    await dialog.waitFor();
    const textarea = dialog.locator('textarea');
    if (width < 700) assert.ok(await textarea.evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 16));
    const before = commands.length;
    await dialog.locator('button.primary').click();
    assert.equal(commands.length, before, 'empty guidance is not sent');
    await textarea.fill('Focus on sign-in');
    await dialog.locator('select').selectOption('follow_up');
    await dialog.locator('button.primary').click();
    await page.locator('dialog.sa-runs-dialog[open]').waitFor({ state: 'detached' });
    assert.deepEqual(commands.at(-1), { method: 'steer', params: { id: 'run-1', message: 'Focus on sign-in', mode: 'follow_up' } });
    await page.locator('.pi-toast.success').first().waitFor();

    // Stop: cancel sends nothing; accepted failure is reported without retry.
    page.once('dialog', prompt => prompt.dismiss());
    const beforeStop = commands.length;
    await panel.getByRole('button', { name: en ? 'Stop' : '停止' }).click();
    await page.waitForTimeout(100);
    assert.equal(commands.length, beforeStop);
    stopFails = true; page.once('dialog', prompt => prompt.accept());
    await panel.getByRole('button', { name: en ? 'Stop' : '停止' }).click();
    await page.locator('.pi-toast.error', { hasText: 'stop only supports running' }).waitFor();
    assert.equal(commands.filter(item => item.method === 'stop').length, 1);

    // Cost
    await panel.getByRole('button', { name: en ? 'Usage and cost' : '用量与费用' }).click();
    await dialog.waitFor();
    assert.equal(await dialog.locator('tr').count(), 5);
    assert.match(await dialog.locator('tr.sum').last().textContent(), /46\.2k.*2300.*\$0\.32/);
    assert.equal(await dialog.locator('.pi-native-help.warning').count(), 1);
    assert.ok(await dialog.evaluate(node => node.getBoundingClientRect().right <= innerWidth + 1));
    await dialog.locator('.pi-native-heading button').click();

    // Layout
    const overflow = await panel.locator('summary, .sa-run, .sa-run-head, .sa-run-children li, .sa-run-actions').evaluateAll(nodes => nodes.filter(n => n.getBoundingClientRect().right > innerWidth + 1).map(n => n.className));
    assert.deepEqual(overflow, []);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await page.locator('#pi-input').evaluate(node => node.getBoundingClientRect().bottom <= innerHeight));
    await page.screenshot({ path: `/tmp/pivane-subagent-runs-${width}-${language}.png` });

    // Attention must remain visible alongside active work, including narrow layouts.
    emit({ type: 'gateway_controls', controls: controls({ ...running, runs: [...running.runs, { ...finished.runs[0], id: 'attention-run' }] }, true) });
    await page.waitForFunction(() => document.querySelector('#pi-subagent-runs').dataset.state === 'attention');
    assert.match(await panel.locator('.sa-runs-count').textContent(), en ? /1 running.*1 need attention/ : /1 个运行中.*1 个需处理/);
    assert.ok(await panel.locator('.sa-runs-count').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    // Paused run: continue offered, retention badge gone, manual collapse respected.
    emit({ type: 'gateway_controls', controls: controls(finished, false) });
    await page.waitForFunction(label => document.querySelector('#pi-subagent-runs .sa-runs-count').textContent === label, en ? '1 need attention' : '1 个需处理');
    assert.equal(await panel.locator('.sa-runs-keep').isVisible(), false);
    assert.equal(await page.locator('#pi-agent-state').textContent(), en ? 'Subagents need attention · 1' : '子 Agent 需处理 · 1');
    await panel.getByRole('button', { name: en ? 'Continue' : '继续' }).click();
    await dialog.waitFor();
    await dialog.locator('textarea').fill('Finish the rest');
    await dialog.locator('button.primary').click();
    await page.locator('dialog.sa-runs-dialog[open]').waitFor({ state: 'detached' });
    assert.deepEqual(commands.at(-1), { method: 'resume', params: { id: 'run-1', message: 'Finish the rest' } });
    await panel.locator('summary').click();
    emit({ type: 'gateway_controls', controls: controls(running, true) });
    await page.waitForFunction(() => document.querySelector('#pi-subagent-runs .sa-runs-keep:not([hidden])'));
    assert.equal(await panel.evaluate(node => node.open), false, 'updates respect manual collapse');
    emit({ type: 'gateway_controls', controls: controls(null, false) });
    await page.waitForFunction(() => document.querySelector('#pi-subagent-runs').hidden);

    assert.equal(await page.locator('#pi-agent-state').textContent(), en ? 'Idle' : '空闲');
    emit({ type: 'gateway_controls', controls: controls(null, true) });
    await page.waitForFunction(label => document.querySelector('#pi-agent-state').textContent === label, en ? 'Background work in progress' : '后台工作进行中');
    emit({ type: 'gateway_controls', controls: controls(null, false) });

    const queuedControls = controls(null, false);
    queuedControls.queue.followUp = ['next'];
    emit({ type: 'gateway_controls', controls: queuedControls });
    await page.waitForFunction(label => document.querySelector('#pi-agent-state').textContent === label, en ? '1 messages queued' : '待执行 1 条');
    const stoppingControls = { ...controls(null, false), stopping: true };
    emit({ type: 'gateway_controls', controls: stoppingControls });
    await page.waitForFunction(label => document.querySelector('#pi-agent-state').textContent === label, en ? 'Stopping / recovering' : '正在停止 / 取回');
    emit({ type: 'gateway_controls', controls: queuedControls }); // older revision must not resurrect queue state
    await page.waitForTimeout(50);
    assert.equal(await page.locator('#pi-agent-state').textContent(), en ? 'Stopping / recovering' : '正在停止 / 取回');
    emit({ type: 'gateway_controls', controls: controls(null, false) });

    // Transcript notices and tool titles
    await selectMessageView(page, 'full');
    const request = page.locator('.pi-message.pi-subagent-notice[data-subagent-tone="attention"]');
    assert.equal(await request.locator('summary strong').textContent(), en ? 'Subagent needs guidance' : '子 Agent 请求指示');
    assert.equal(await request.locator('.pi-subagent-notice-preview').textContent(), 'reviewer asks: may I edit tests?');
    assert.equal(await request.locator('details').evaluate(node => node.open), false, 'notices start collapsed');
    assert.equal(await request.locator('.pi-markdown strong').count(), 0, 'Markdown renders on expansion');
    const rowHeight = await request.evaluate(node => node.getBoundingClientRect().height);
    assert.ok(rowHeight <= 44, 'collapsed notice is one row: ' + rowHeight);
    await request.scrollIntoViewIfNeeded(); await page.screenshot({ path: `/tmp/pivane-subagent-notices-collapsed-${width}-${language}.png` });
    await request.locator('summary').click();
    await request.locator('.pi-markdown strong').waitFor();
    assert.equal(await request.locator('.pi-markdown strong').textContent(), 'may I edit tests?');
    const result = page.locator('.pi-message.pi-subagent-notice[data-subagent-tone="result"]');
    assert.equal(await result.locator('summary strong').textContent(), en ? 'Subagent result' : '子 Agent 结果');
    assert.equal(await result.locator('.pi-subagent-notice-preview').textContent(), 'Review result');
    assert.ok(await result.evaluate(node => node.getBoundingClientRect().height) <= 44, 'long reports collapse to one row');
    await result.locator('summary').click();
    await result.locator('.pi-markdown li').first().waitFor();
    assert.equal(await result.locator('.pi-markdown li').count(), 30);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.equal(await page.locator('.pi-message-body [onerror]').count(), 0);
    assert.equal(await page.locator('.pi-message.custom:not(.pi-subagent-notice) header strong').first().textContent(), en ? 'System' : '系统');
    const title = id => page.locator(`[data-tool-id="${id}"] summary > strong`).textContent();
    assert.equal(await title('launch'), en ? 'Start background subagent · Code reviewer' : '后台启动子 Agent · 代码审查');
    assert.equal(await title('enable'), en ? 'Enable subagent tools' : '启用子 Agent 工具');
    assert.equal(await title('reply'), en ? 'Reply to subagent' : '回复子 Agent 请示');
    await page.screenshot({ path: `/tmp/pivane-subagent-notices-${width}-${language}.png` });

    // Switching sessions resets the panel; returning restores it from the snapshot.
    emit({ type: 'gateway_controls', controls: controls(running, true) });
    await panel.waitFor({ state: 'visible' });
    if (width < 900) { await page.locator('#pi-toggle-sessions').click(); await page.locator('#pi-session-pane.open').waitFor(); }
    await page.locator('[data-session-id="empty"] .pi-session-main').click();
    await page.waitForFunction(() => document.querySelector('#pi-subagent-runs').hidden);
    await page.waitForFunction(label => document.querySelector('#pi-agent-state').textContent === label, en ? 'Idle' : '空闲');
    if (width < 900) await page.locator('#pi-toggle-sessions').click();
    await page.locator('[data-session-id="main"] .pi-session-main').click();
    await panel.waitFor({ state: 'visible' });
    assert.equal(await panel.evaluate(node => node.open), false, 'restored panel stays collapsed');
    await panel.locator('summary').click();
    await panel.locator('.sa-run').first().waitFor();
    assert.equal(await panel.locator('.sa-run').count(), 1, 'open_session snapshot restores the panel');
    assert.equal(await page.locator('#pi-input').inputValue(), 'Keep my draft');
    for (const theme of ['daylight', 'dark']) await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    socket.close({ code: 1000, reason: 'fixture disconnect' });
    await page.waitForFunction(label => document.querySelector('#pi-agent-state').textContent === label, en ? 'Disconnected' : '连接已断开');
    assert.deepEqual(errors, []);
    await context.close();
}
(async () => {
    const root = path.resolve(__dirname, '../..'), app = express();
    for (const [url, folder] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use(`/vendor/${url}`, express.static(path.join(root, 'node_modules', folder)));
    app.use(express.static(path.join(root, 'public')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        for (const width of [1440, 393, 320]) for (const language of ['zh-CN', 'en']) {
            await check(browser, `http://127.0.0.1:${server.address().port}`, width, language);
            console.log(`Subagent runs passed: ${width} ${language}`);
        }
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
