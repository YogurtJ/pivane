// Loading and activity feedback: boot cover, list/transcript placeholders that never claim
// "empty" before the answer is known, the live activity line before visible output, the
// compaction card and result notice, the deferred chip in the status row, and deliberate-reload drafts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.PI_FEEDBACK_TEST_URL || 'http://127.0.0.1:3103';
const cwd = '/srv/feedback-fixture';
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text'], contextWindow: 128000 };
const session = { id: 'feedback-thread', cwd, name: 'Feedback fixture', messageCount: 2 };
const initialMessages = () => [{ role: 'user', content: 'First question', timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: 'First answer' }], timestamp: 2, stopReason: 'stop' }];
const stats = { contextUsage: { tokens: 1000, percent: 1, contextWindow: 128000 }, tokens: { input: 10, output: 5 }, totalMessages: 2 };
const gate = () => { let open; const promise = new Promise(resolve => { open = resolve; }); return { promise, open }; };
const delta = (type, contentIndex, extra = {}) => ({ type: 'message_update', assistantMessageEvent: { type, contentIndex, ...extra, partial: { role: 'assistant', content: [] } } });

async function run(browser, viewport) {
    const context = await browser.newContext({ locale: 'zh-CN', viewport, isMobile: viewport.width < 900, hasTouch: viewport.width < 900 });
    const page = await context.newPage();
    const errors = [];
    let socket, pendingPrompt = null, messages = initialMessages(), jobs = [];
    let runtime = { model, isStreaming: false, isCompacting: false, autoCompactionEnabled: true, thinkingLevel: 'off' };
    const projectsGate = gate(), openGate = gate();
    const send = event => socket.send(JSON.stringify(event));
    const reply = (command, data = {}) => socket.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
    page.on('pageerror', error => errors.push(error.message));
    await page.route(/https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)\//, route => route.abort());
    await page.addInitScript(({ cwd, id }) => {
        localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, id);
        // Record whether a welcome page or a false "no projects" state ever flashed before the thread opened.
        window.__falseEmpty = [];
        new MutationObserver(() => {
            if (document.querySelector('#pi-transcript-content .pi-empty-state')) window.__falseEmpty.push('welcome');
            if (/还没有 Pi 项目/.test(document.querySelector('#pi-session-list')?.textContent || '')) window.__falseEmpty.push('no-projects');
        }).observe(document, { childList: true, subtree: true });
    }, { cwd, id: session.id });
    await page.route('**/api/**', async route => {
        const req = route.request(), url = new URL(req.url()), path = url.pathname;
        if (path === '/api/pi/status') return route.fulfill({ json: { ok: true, version: '1.1.0', sessionWorkflows: true, projectRoots: ['/srv'] } });
        if (path === '/api/pi/projects') { await projectsGate.promise; return route.fulfill({ json: { projects: [{ cwd, name: 'Feedback fixture', sessionCount: 1 }], roots: ['/srv'] } }); }
        if (path === '/api/pi/sessions') return route.fulfill({ json: { sessions: [session] } });
        if (path === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] } });
        if (path.endsWith('/deferred') && req.method() === 'POST') {
            const body = req.postDataJSON();
            jobs.push({ id: body.id, sessionId: session.id, status: 'scheduled', revision: 1, preview: body.message, dueAt: body.dueAt });
            return route.fulfill({ status: 201, json: jobs.at(-1) });
        }
        if (path.endsWith('/deferred')) return route.fulfill({ json: { revision: `jobs-${jobs.length}`, jobs } });
        if (path.endsWith('/workflow')) return route.fulfill({ json: { leafId: 'leaf', lastUserId: 'user', prompts: [], versions: [] } });
        if (req.method() !== 'GET') return route.fulfill({ json: { ok: true } });
        return route.fulfill({ json: path.includes('history') ? [] : {} });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        socket = ws;
        ws.onMessage(async raw => {
            const command = JSON.parse(raw);
            if (command.type === 'open_session') {
                await openGate.promise;
                return reply(command, { session, state: runtime, messages: { messages }, stats, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } });
            }
            if (command.type === 'prompt') { pendingPrompt = command; return; }
            if (command.type === 'get_state') return reply(command, runtime);
            if (command.type === 'get_session_stats') return reply(command, stats);
            if (command.type === 'get_messages') return reply(command, { messages });
            return reply(command, {});
        });
    });

    // 1. Boot: the cover leaves, and placeholders never claim "empty" before discovery answers.
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.documentElement.classList.contains('pv-booting'));
    assert.equal(await page.locator('#pi-session-list .pv-skeleton[role="status"]').count(), 1, 'project list shows a skeleton while discovery is pending');
    assert.equal(await page.locator('#pi-transcript-content > .pi-transcript-loading[data-placeholder] .pv-skeleton').count(), 1, 'transcript shows a skeleton while booting');
    projectsGate.open();
    await page.locator(`[data-project-cwd="${cwd}"]`).waitFor({ state: 'attached' });
    await page.locator('#pi-transcript-content > .pi-transcript-loading .pv-skeleton').waitFor({ state: 'attached' });
    openGate.open();
    await page.waitForFunction(() => document.querySelector('#pi-transcript-content')?.textContent.includes('First answer'));
    assert.deepEqual(await page.evaluate(() => window.__falseEmpty), [], 'no welcome page or "no projects" state flashed while restoring');
    await page.waitForFunction(() => !document.querySelector('#pi-input').disabled);

    // 2. Activity line from send to the first visible output, tools, and settle.
    const live = page.locator('#pi-transcript-activity .pi-activity-live');
    await page.locator('#pi-input').fill('Draw a chart');
    await page.locator('#pi-input').press('Enter');
    await page.waitForFunction(() => /正在发送/.test(document.querySelector('#pi-transcript-activity .pi-activity-live')?.textContent || ''));
    reply(pendingPrompt, {}); runtime.isStreaming = true;
    send({ type: 'agent_start' });
    await page.waitForFunction(() => /正在等待模型响应/.test(document.querySelector('#pi-transcript-activity .pi-activity-live')?.textContent || ''));
    const box = await live.boundingBox();
    const lastUser = await page.locator('#pi-transcript-content .pi-message.user').last().boundingBox();
    assert.ok(box.y >= lastUser.y + lastUser.height - 1 && box.y - (lastUser.y + lastUser.height) < 120, 'activity sits directly below the question');
    send({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 10 } });
    send(delta('thinking_start', 0)); send(delta('thinking_delta', 0, { delta: 'Plan' }));
    await page.waitForFunction(() => /正在思考/.test(document.querySelector('#pi-transcript-activity .pi-activity-live')?.textContent || ''));
    send(delta('text_start', 1)); send(delta('text_delta', 1, { delta: 'Sure' }));
    await live.waitFor({ state: 'hidden' });
    send(delta('toolcall_start', 2, { id: 'call-1', toolName: 'bash' }));
    send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Sure' }, { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } }], timestamp: 10, stopReason: 'toolUse' } });
    send({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'ls' } });
    await page.waitForFunction(() => /正在执行/.test(document.querySelector('#pi-transcript-activity .pi-activity-live')?.textContent || ''));
    send({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'bash', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false });
    await page.waitForFunction(() => /正在根据结果继续/.test(document.querySelector('#pi-transcript-activity .pi-activity-live')?.textContent || ''));
    runtime.isStreaming = false;
    messages = [...initialMessages(), { role: 'user', content: 'Draw a chart', timestamp: 9 }, { role: 'assistant', content: [{ type: 'text', text: 'Chart ready' }], timestamp: 11, stopReason: 'stop' }];
    send({ type: 'agent_settled' });
    await page.locator('#pi-transcript-activity').waitFor({ state: 'hidden' });

    // 3. Compaction: a visible card while it runs, then a result notice that locates the summary.
    runtime.isCompacting = true;
    send({ type: 'compaction_start', reason: 'threshold' });
    const card = page.locator('#pi-transcript-activity .pi-activity-live[data-phase="compacting"]');
    await card.waitFor();
    assert.match(await card.textContent(), /正在压缩上下文/);
    runtime.isCompacting = false;
    messages = [{ role: 'compactionSummary', summary: 'Retained summary text', tokensBefore: 98000, timestamp: 8 }, ...messages.slice(2)];
    send({ type: 'compaction_end', reason: 'threshold', result: { summary: 'Retained summary text', tokensBefore: 98000, estimatedTokensAfter: 6200 } });
    const notice = page.locator('#pi-transcript-activity .pi-activity-notice[data-tone="success"]');
    await notice.waitFor();
    assert.match(await notice.textContent(), /上下文已压缩/);
    assert.match(await notice.textContent(), /98\.0k → 6\.2k/);
    await page.locator('#pi-transcript-content .pi-summary-notice.compactionSummary').waitFor({ state: 'attached' });
    await notice.locator('.pi-activity-notice-action').click();
    await page.waitForFunction(() => document.querySelector('#pi-transcript-content .pi-summary-notice.compactionSummary')?.open === true);

    // 4. A scheduled message appears at once as a chip in the status row.
    await page.locator('#pi-input').fill('Remind me tomorrow');
    await page.locator('#pi-composer-add-button').click();
    await page.locator('#pi-schedule-button').click();
    await page.locator('#pi-workflow-delay').fill('5');
    await page.locator('#pi-workflow-submit').click();
    const chip = page.locator('#pi-composer-chips > #pi-deferred-banner');
    await chip.waitFor({ timeout: 3000 });
    assert.match(await chip.textContent(), /1 条待发送/);
    assert.match(await page.locator('#pi-deferred-next').textContent(), /\d{2}:\d{2}/);
    await chip.locator('button').click();
    await page.locator('#pi-workflow-dialog').waitFor();
    assert.match(await page.locator('#pi-workflow-content').textContent(), /Remind me tomorrow/);
    await page.locator('#pi-workflow-close').click();

    // 5. Deliberate reloads keep unsent text drafts and report what would be lost.
    await page.locator('#pi-input').fill('Draft that survives');
    const assessed = await page.evaluate(() => window.PiWorkbenchReload.assess());
    assert.deepEqual(assessed, { blockers: [], restorable: 1 });
    await page.evaluate(() => window.PiWorkbenchReload.prepare());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#pi-input')?.value === 'Draft that survives');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('pi.web.reloadDrafts')), null, 'the stash is consumed once');

    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal overflow');
    assert.deepEqual(errors, []);
    await context.close();
}

async function composerLayout(browser, width, language, theme) {
    const baseline = process.env.PI_COMPOSER_LAYOUT_BASELINE === '1';
    const screenshotDir = process.env.PI_COMPOSER_SCREENSHOT_DIR || process.env.PIVANE_TEST_SCREENSHOT_DIR;
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width, height: 900 }, isMobile: width <= 680, hasTouch: width <= 680 });
    const page = await context.newPage();
    const errors = [], measurements = [];
    const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    let socket, pendingPrompt;
    const runtime = { model, thinkingLevel: 'medium', isStreaming: false, isCompacting: false };
    const reply = (command, data = {}) => socket.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
    const send = event => socket.send(JSON.stringify(event));
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ cwd, id, language, theme }) => {
        localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, id);
        localStorage.setItem('pi.workspace.language', language); localStorage.setItem('pi.workspace.theme', theme);
    }, { cwd, id: session.id, language, theme });
    await page.route(/https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)\//, route => route.abort());
    await page.route('**/api/**', route => {
        const endpoint = new URL(route.request().url()).pathname;
        if (endpoint === '/api/pi/status') return route.fulfill({ json: { ok: true, version: '1.1.0', projectRoots: ['/srv'] } });
        if (endpoint === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd, name: 'Composer fixture', sessionCount: 1 }], roots: ['/srv'] } });
        if (endpoint === '/api/pi/sessions') return route.fulfill({ json: { sessions: [session] } });
        if (endpoint === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] } });
        return route.fulfill({ json: endpoint.includes('history') ? [] : {} });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        socket = ws;
        ws.onMessage(raw => {
            const command = JSON.parse(raw);
            if (command.type === 'open_session') return reply(command, { session, state: runtime, messages: { messages: initialMessages() }, stats,
                models: { models: [model] }, thinkingLevels: { levels }, commands: { commands: [] } });
            if (command.type === 'get_state') return reply(command, runtime);
            if (command.type === 'get_session_stats') return reply(command, stats);
            if (command.type === 'get_messages') return reply(command, { messages: initialMessages() });
            if (command.type === 'set_thinking_level') { runtime.thinkingLevel = command.level; return reply(command); }
            if (command.type === 'prompt') { pendingPrompt = command; return; }
            return reply(command);
        });
    });
    if (baseline) {
        // Capture the saved pre-edit assets through the same isolated static fixture.
        const snapshotDir = path.join(screenshotDir, 'baseline');
        for (const file of ['pi-chat.js', 'pi-workbench.css']) await page.route(`**/${file}*`, route => route.fulfill({ path: path.join(snapshotDir, file) }));
        await page.route(`${baseUrl}/`, route => route.fulfill({ path: path.join(snapshotDir, 'index.html'), contentType: 'text/html' }));
    }
    const capture = async state => {
        if (!screenshotDir) return;
        fs.mkdirSync(screenshotDir, { recursive: true });
        await page.screenshot({ path: path.join(screenshotDir, `${baseline ? 'before' : 'after'}-${width}-${language}-${theme}-${state}.png`),
            style: '#pi-toast-region { visibility: hidden !important; }' });
    };
    const geometry = () => page.evaluate(() => {
        const box = selector => {
            const r = document.querySelector(selector).getBoundingClientRect();
            return { top: r.top, height: r.height, left: r.left, right: r.right };
        };
        return { composer: box('.pi-composer'), meta: box('.pi-composer-meta') };
    });
    const stable = async (before, state) => {
        const after = await geometry(); measurements.push({ state, geometry: after });
        if (!baseline) for (const selector of ['composer', 'meta']) for (const property of ['top', 'height']) {
            assert.ok(Math.abs(after[selector][property] - before[selector][property]) <= 1, `${width}/${language}/${theme}: ${selector} ${property} moved during ${state}`);
        }
    };
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.querySelector('#pi-thinking-select').disabled);
    const status = page.locator('#pi-composer-status');
    if (baseline) {
        const ready = await page.evaluate(() => window.PiI18n.t('Pi Agent 已就绪'));
        assert.equal(await status.textContent(), ready, 'baseline uses the saved pre-edit chat asset');
        if (width > 680) assert.equal(await page.locator('.pi-composer-models .pi-thinking-field').evaluate(node => getComputedStyle(node).flexBasis), '90px', 'baseline uses the saved pre-edit composer CSS');
    }
    if (!baseline) {
        assert.equal(await status.textContent(), '', 'idle composer is quiet');
        assert.equal(await status.getAttribute('role'), 'status');
        assert.equal(await status.getAttribute('aria-live'), 'polite');
    }
    await page.locator('#pi-input').fill('Composer layout draft');
    await capture('idle-medium');
    const thinking = page.locator(width <= 680 ? '#pi-mobile-thinking' : '#pi-thinking-select');
    if (width <= 680) await page.locator('#pi-mobile-context-trigger').click();
    for (const level of levels) {
        await thinking.selectOption(level);
        await page.waitForFunction(level => document.querySelector('#pi-thinking-select').value === level && !document.querySelector('#pi-thinking-select').disabled, level);
        const metrics = await thinking.evaluate(select => {
            const style = getComputedStyle(select), rect = select.getBoundingClientRect();
            const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
            ctx.font = style.font;
            const textWidth = ctx.measureText(select.selectedOptions[0].textContent).width;
            const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
            const parent = select.closest('.pi-composer, dialog').getBoundingClientRect();
            return { level: select.value, label: select.selectedOptions[0].textContent, width: rect.width, textWidth, padding, fontSize: parseFloat(style.fontSize),
                inside: rect.left >= parent.left && rect.right <= parent.right + 1 };
        });
        measurements.push(metrics);
        if (!baseline) {
            assert.ok(metrics.width >= metrics.textWidth + metrics.padding - 1, `selected thinking label fits: ${JSON.stringify(metrics)}`);
            assert.ok(metrics.inside, `thinking control stays inside composer/sheet: ${JSON.stringify(metrics)}`);
            if (width <= 680) assert.ok(metrics.fontSize >= 16, 'phone thinking select keeps a 16px font');
            else {
                assert.ok(metrics.width - metrics.textWidth - metrics.padding <= 8, `select has no oversized gap: ${JSON.stringify(metrics)}`);
                const rowFits = await page.locator('.pi-composer-models').evaluate(row => {
                    const bounds = row.getBoundingClientRect();
                    return [...row.children].filter(node => !node.hidden).every(node => {
                        const rect = node.getBoundingClientRect();
                        return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
                    });
                });
                assert.equal(rowFits, true, `${width}/${language}: model row children fit`);
            }
        }
    }
    await thinking.selectOption('medium');
    await page.waitForFunction(() => !document.querySelector('#pi-thinking-select').disabled);
    if (width <= 680) {
        await capture('thinking-medium');
        await page.locator('#pi-mobile-session-dialog .pi-mobile-sheet-head button').click();
    }
    // Exercise the measured-label fallback even in a Chromium that supports field-sizing.
    if (!baseline && width > 680) {
        const fallback = await page.addStyleTag({ content: '.pi-composer-models #pi-thinking-select { field-sizing: fixed; width: calc(var(--pi-thinking-label-width, 4em) + 34px); }' });
        for (const level of ['low', 'medium', 'xhigh']) {
            await thinking.selectOption(level);
            await page.waitForFunction(() => !document.querySelector('#pi-thinking-select').disabled);
            const fits = await thinking.evaluate(select => {
                const style = getComputedStyle(select), ctx = document.createElement('canvas').getContext('2d'); ctx.font = style.font;
                const needed = ctx.measureText(select.selectedOptions[0].textContent).width + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
                return Math.abs(select.getBoundingClientRect().width - needed) <= 3;
            });
            assert.equal(fits, true, `fallback fits ${language}/${level}`);
        }
        await fallback.evaluate(node => node.remove());
        await thinking.selectOption('medium');
        await page.waitForFunction(() => !document.querySelector('#pi-thinking-select').disabled);
    }
    const idle = await geometry();
    await page.locator('#pi-input').press('Enter');
    await page.waitForFunction(() => document.querySelector('#pi-transcript-activity .pi-activity-live')?.dataset.phase === 'sending');
    if (!baseline) {
        assert.equal(await page.locator('#pi-attachment-status').textContent(), '', 'sending has one transcript activity status');
        assert.equal(await page.locator('#pi-attachment-status').isVisible(), false);
        assert.equal(await page.locator('#pi-send-button').isDisabled(), true);
    }
    await stable(idle, 'sending');
    // Keep the same text while the acknowledgement arrives to isolate status layout from draft-height changes.
    runtime.isStreaming = true; send({ type: 'agent_start' });
    await page.waitForFunction(() => document.querySelector('.pi-composer').dataset.running === 'true');
    const steerHint = language === 'en' ? 'Running · New messages arrive after this tool step' : '运行中 · 新消息在本轮工具后送达';
    const followHint = language === 'en' ? 'Running · New messages arrive when the task ends' : '运行中 · 新消息在任务完成后送达';
    if (!baseline) assert.equal(await status.textContent(), steerHint);
    await stable(idle, 'streaming-steer');
    if (!baseline) {
        const hintFits = await status.evaluate(node => node.scrollHeight <= node.clientHeight + 1);
        assert.equal(hintFits, true, `${width}/${language}: delivery hint is fully visible`);
    }
    await capture('streaming-steer');
    await page.locator('#pi-composer-add-button').click(); await page.locator('#pi-delivery-toggle').click();
    await page.locator('[data-delivery-mode="follow_up"]').click();
    if (!baseline) assert.equal(await status.textContent(), followHint, 'hint follows the selected delivery mode');
    await stable(idle, 'streaming-follow-up');
    runtime.isCompacting = true; send({ type: 'compaction_start', reason: 'threshold' });
    await page.locator('#pi-transcript-activity .pi-activity-live[data-phase="compacting"]').waitFor();
    if (!baseline) assert.equal(await status.textContent(), '', 'compaction status stays in its transcript card');
    await stable(idle, 'compaction');
    reply(pendingPrompt); runtime.isStreaming = false; runtime.isCompacting = false;
    send({ type: 'compaction_end', reason: 'threshold', aborted: true }); send({ type: 'agent_settled' });
    await page.waitForFunction(() => document.querySelector('#pi-input').value === '' && document.querySelector('.pi-composer').dataset.running === 'false');
    // Long retained states and visible identity/attachment metadata must fit the same reserved row.
    if (!baseline) {
        const identity = await geometry();
        await page.evaluate(() => {
            const identity = document.querySelector('#pi-composer-identity'); identity.hidden = false; identity.textContent = 'Fixture identity';
            document.querySelector('#pi-attachment-limit').style.display = 'block';
            document.querySelector('#pi-composer-status').textContent = 'Shell 正在执行，可继续编辑草稿；停止请使用命令卡片';
        });
        await stable(identity, 'identity-and-retained-state');
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}/${language}/${theme}: no page overflow`);
    assert.deepEqual(errors, []);
    if (screenshotDir) fs.writeFileSync(path.join(screenshotDir, `${baseline ? 'before' : 'after'}-${width}-${language}-${theme}-measurements.json`), JSON.stringify(measurements, null, 2));
    await context.close();
}

(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
    try {
        for (const width of [1440, 1024, 393, 320]) for (const language of ['zh-CN', 'en']) for (const theme of ['daylight', 'dark']) await composerLayout(browser, width, language, theme);
        if (process.env.PI_COMPOSER_LAYOUT_BASELINE !== '1') for (const viewport of [{ width: 1440, height: 900 }, { width: 393, height: 852 }]) await run(browser, viewport);
        console.log('feedback states and composer layout passed');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
