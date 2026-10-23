// Synthetic REST/WS only. Delayed project lists expose navigation continuations.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PI_CHAT_NAVIGATION_TEST_URL;
const projects = ['/synthetic/a', '/synthetic/b', '/synthetic/c', '/synthetic/d'];
const sessions = projects.flatMap((cwd, index) => ['1', '2'].map(suffix => ({ cwd, id: `${index}-${suffix}`, name: `${cwd} ${suffix}` })));
const model = { provider: 'fixture', id: 'fixture', input: ['text', 'image'] };
async function run(browser, width) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'zh-CN', isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(), errors = [], opens = [], writes = [], created = [], held = new Map(), heldWaiters = new Map();
    const holdRoute = (key, route) => { held.set(key, route); heldWaiters.get(key)?.(); };
    const waitHeld = key => held.has(key) ? Promise.resolve() : new Promise(resolve => heldWaiters.set(key, resolve));
    let holdCwd, holdResolveCwd, socket;
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(projects => {
        localStorage.setItem('pi.web.cwd', projects[0]); localStorage.setItem(`pi.web.session:${projects[0]}`, '0-1');
        localStorage.setItem('pi.web.expandedProjects', JSON.stringify(projects));
    }, projects);
    await page.route('**/api/**', route => {
        const url = new URL(route.request().url()), endpoint = url.pathname, cwd = url.searchParams.get('cwd');
        if (route.request().method() === 'POST' && endpoint.endsWith('/fork')) {
            writes.push(endpoint); holdRoute('fork', route); return;
        }
        if (route.request().method() !== 'GET') { writes.push(endpoint); return route.fulfill({ json: {} }); }
        if (endpoint.endsWith('/workflow')) return route.fulfill({ json: { leafId: 'leaf', prompts: [], replies: [], versions: [] } });
        if (endpoint.endsWith('/deferred')) return route.fulfill({ json: { jobs: [] } });
        if (endpoint === '/api/pi/status') return route.fulfill({ json: { ok: true, projectRoots: ['/synthetic'], projectIdentity: true, sessionTree: true, sessionWorkflows: true } });
        if (endpoint === '/api/pi/projects/resolve') {
            if (cwd === holdResolveCwd) { holdRoute('resolve:' + cwd, route); return; }
            return route.fulfill({ json: { cwd } });
        }
        if (endpoint === '/api/pi/projects') return route.fulfill({ json: { projects: projects.map(cwd => ({ cwd, sessionCount: 2 })), roots: ['/synthetic'] } });
        if (endpoint === '/api/pi/sessions') {
            if (cwd === holdCwd) { holdRoute(cwd, route); return; }
            return route.fulfill({ json: { sessions: [...sessions, ...created].filter(s => s.cwd === cwd) } });
        }
        if (endpoint === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], hiddenProjects: [], pinnedProjects: [], replyNotices: [] } });
        return route.fulfill({ json: {} });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        ws.onMessage(raw => {
            const cmd = JSON.parse(raw); let data = {};
            if (cmd.type === 'open_session') {
                opens.push({ cwd: cmd.cwd, id: cmd.sessionId }); socket = ws;
                const session = sessions.find(s => s.id === cmd.sessionId);
                data = { session, state: { model, thinkingLevel: 'off' }, messages: { messages: [{ role: 'user', content: 'Synthetic history', timestamp: 1 }] }, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } };
            }
            if (cmd.type === 'get_state') data = { model, thinkingLevel: 'off' };
            ws.send(JSON.stringify({ type: 'response', command: cmd.type, id: cmd.id, success: true, data }));
        });
    });
    const ready = id => page.waitForFunction(id => document.querySelector('#pi-meta-id').textContent === id && !document.querySelector('#pi-input').disabled, id);
    const drawer = async () => { if (width < 900 && !await page.locator('#pi-session-pane').evaluate(n => n.classList.contains('open'))) await page.locator('#pi-toggle-sessions').click(); };
    const click = async id => { await drawer(); await page.locator(`[data-session-id="${id}"] .pi-session-main`).click(); };
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const release = async cwd => { holdCwd = null; await held.get(cwd).fulfill({ json: { sessions: sessions.filter(s => s.cwd === cwd) } }); held.delete(cwd); await settle(); };
    await page.goto(base, { waitUntil: 'domcontentloaded' }); await ready('0-1');
    await page.locator('#pi-input').fill('A draft');
    await page.locator('#pi-file-input').setInputFiles({ name: 'retained.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic attachment') });
    await page.waitForFunction(() => document.querySelector('#pi-attachments').textContent.includes('retained.txt'));
    // A fork already submitted in A must not reclaim navigation after A -> B -> A.
    await page.locator('#pi-current-thread-menu').click();
    await page.getByRole('menuitem', { name: '复制为新线程', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#pi-workflow-submit').disabled);
    await page.locator('#pi-workflow-submit').click(); await waitHeld('fork');
    await page.evaluate(({ cwd }) => PiChatNavigation.openSession({ cwd, sessionId: '1-1' }), { cwd: projects[1] }); await ready('1-1');
    await page.evaluate(({ cwd }) => PiChatNavigation.openSession({ cwd, sessionId: '0-1' }), { cwd: projects[0] }); await ready('0-1');
    const beforeForkReply = opens.length, fork = { cwd: projects[0], id: 'fork-created', name: 'Created once' };
    created.push(fork); await held.get('fork').fulfill({ json: { session: fork, draft: { message: 'old fork draft', images: [] } } }); held.delete('fork');
    await page.locator('#pi-workflow-dialog').waitFor({ state: 'hidden' }); await settle();
    assert.equal(opens.length, beforeForkReply, 'an old fork response must not reopen after A-B-A');
    assert.equal(await page.locator('#pi-meta-id').textContent(), '0-1');
    assert.equal(await page.locator('#pi-input').inputValue(), 'A draft'); assert.match(await page.locator('#pi-attachments').textContent(), /retained.txt/);
    assert.equal(created.length, 1); assert.equal(writes.filter(endpoint => endpoint.endsWith('/fork')).length, 1, 'created fork is kept and never replayed');
    // Closing and reopening a fork editor reserves a new choice without sending anything.
    await page.locator('#pi-current-thread-menu').click(); await page.getByRole('menuitem', { name: '复制为新线程', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#pi-workflow-submit').disabled); await page.locator('#pi-workflow-cancel').click();
    await page.locator('#pi-current-thread-menu').click(); await page.getByRole('menuitem', { name: '复制为新线程', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#pi-workflow-submit').disabled); await page.locator('#pi-workflow-cancel').click();
    assert.equal(writes.filter(endpoint => endpoint.endsWith('/fork')).length, 1);
    // Populate background rows so a click can select B while its refreshed list is held.
    await drawer(); await page.locator('#pi-session-search-toggle').click(); await page.locator('#pi-session-search').fill('synthetic');
    await page.waitForFunction(() => document.querySelectorAll('[data-session-id="1-1"]').length > 0);
    await page.locator('#pi-session-search-toggle').click();
    holdCwd = projects[1];
    await click('1-1');
    await page.waitForFunction(cwd => document.querySelector('#pi-project-path').textContent === cwd, projects[1]);
    // A -> B -> A returns to the exact cwd and does not change the route while B loads.
    await click('0-1'); await ready('0-1');
    const before = opens.length;
    await release(projects[1]); await settle();
    assert.equal(opens.length, before, 'the late B click must never reopen after the user reselects A');
    assert.equal(await page.locator('#pi-meta-id').textContent(), '0-1');
    assert.equal(await page.locator('#pi-input').inputValue(), 'A draft');
    assert.match(await page.locator('#pi-attachments').textContent(), /retained.txt/);
    assert.ok(opens.every(open => [...sessions, ...created].some(s => s.id === open.id && s.cwd === open.cwd)), JSON.stringify(opens));
    // Same-cwd latest click must cancel a pending project path resolution/list, too.
    holdCwd = projects[2]; await click('2-1');
    await page.waitForFunction(cwd => document.querySelector('#pi-project-path').textContent === cwd, projects[2]);
    const side = page.evaluate(({ cwd }) => PiChatNavigation.openSession({ cwd, sessionId: '0-2' }).then(() => 'opened', error => error.message), { cwd: projects[0] });
    await ready('0-2'); const sideCount = opens.length;
    await release(projects[2]); await side;
    assert.equal(opens.length, sideCount, 'late list cannot override the side entry');
    assert.equal(await page.locator('#pi-meta-id').textContent(), '0-2');
    // Reconnect the selected session without losing its separate draft.
    await page.locator('#pi-input').fill('A2 draft');
    socket.close({ code: 1012, reason: 'synthetic reconnect' }); await page.waitForFunction(() => document.querySelector('#pi-connection-text').textContent.includes('重连'));
    await click('0-2'); await ready('0-2'); assert.equal(await page.locator('#pi-input').inputValue(), 'A2 draft');
    // Selecting the current cwd still supersedes an unresolved cross-project click.
    holdResolveCwd = projects[3]; await click('3-1');
    await waitHeld('resolve:' + projects[3]);
    await click('0-2'); await ready('0-2'); const beforeResolution = opens.length;
    await held.get('resolve:' + projects[3]).fulfill({ json: { cwd: projects[3] } }); holdResolveCwd = null; await settle();
    assert.equal(opens.length, beforeResolution, 'a same-cwd click invalidates the earlier unresolved project');
    // Two clicks sharing a pending B list: the second session wins.
    holdCwd = projects[1]; await click('1-1'); await click('1-2'); const beforeDouble = opens.length;
    await release(projects[1]); await ready('1-2'); assert.equal(opens.length, beforeDouble + 1);
    // A side entry waiting for B must not reopen after the user chooses A.
    holdCwd = projects[1];
    const oldSide = page.evaluate(({ cwd }) => PiChatNavigation.openSession({ cwd, sessionId: '1-1' }).then(() => 'opened', error => error.message), { cwd: projects[1] });
    await waitHeld(projects[1]);
    await click('0-2'); await ready('0-2'); const beforeSide = opens.length;
    await release(projects[1]); assert.match(await oldSide, /导航已改变/); await settle();
    assert.equal(opens.length, beforeSide);
    // A menu continuation must not open the old tree after selection changes.
    holdCwd = projects[2]; await drawer(); await page.locator('[data-session-id="2-1"] [data-action="menu"]').click();
    await page.getByRole('menuitem', { name: '历史与记录', exact: true }).click();
    await page.getByRole('menuitem', { name: '会话树', exact: true }).click();
    await page.waitForFunction(cwd => document.querySelector('#pi-project-path').textContent === cwd, projects[2]);
    await click('0-1'); await ready('0-1'); const beforeMenu = opens.length;
    await release(projects[2]); await settle(); assert.equal(opens.length, beforeMenu);
    assert.equal(await page.locator('#pi-input').inputValue(), 'A draft');
    assert.match(await page.locator('#pi-attachments').textContent(), /retained.txt/);
    // A late project new-chat continuation must not POST in the newly selected cwd.
    holdCwd = projects[2]; await drawer(); await page.locator(`[data-project-cwd="${projects[2]}"] [data-project-action="menu"]`).click();
    await page.getByRole('menuitem', { name: '新聊天', exact: true }).click();
    await waitHeld(projects[2]); await click('0-1'); await ready('0-1'); await release(projects[2]); await settle();
    assert.deepEqual(writes.filter(endpoint => !endpoint.endsWith('/fork')), [], 'superseded new-chat must not create a session');
    // Real list failures remain visible even when their navigation has expired.
    holdCwd = projects[1]; await click('1-1'); await waitHeld(projects[1]); await click('0-1'); await ready('0-1');
    const beforeError = opens.length; holdCwd = null;
    await held.get(projects[1]).fulfill({ status: 500, json: { error: 'Synthetic list failure' } }); held.delete(projects[1]);
    await page.waitForFunction(() => document.querySelector('#pi-toast-region').textContent.includes('Synthetic list failure'));
    assert.equal(opens.length, beforeError);
    // A mismatched session row is rejected before it can open a socket under this cwd.
    holdCwd = projects[3]; await click('3-1'); await waitHeld(projects[3]); const beforeMismatch = opens.length; holdCwd = null;
    await held.get(projects[3]).fulfill({ json: { sessions: [{ ...sessions.find(s => s.id === '3-1'), cwd: projects[0] }] } }); held.delete(projects[3]);
    await page.waitForFunction(() => document.querySelector('#pi-toast-region').textContent.includes('会话不属于当前项目'));
    assert.equal(opens.length, beforeMismatch); await click('0-1'); await ready('0-1');
    await drawer();
    if (width < 900) { await page.waitForFunction(() => document.querySelector('#pi-session-pane').getBoundingClientRect().left >= -1); assert.equal(await page.locator('#pi-session-pane').evaluate(n => n.getBoundingClientRect().left >= -1), true); }
    assert.deepEqual(await page.evaluate(() => ['body', '.pi-composer', '#pi-transcript-content'].filter(selector => { const n = document.querySelector(selector); return n.scrollWidth > n.clientWidth + 1; })), []);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, opens, draft: 'preserved', attachment: 'preserved', pageerror: errors }));
    await context.close();
}
async function runReviewedGates(browser, width, scenario) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'zh-CN', isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(), errors = [], opens = [], writes = [];
    const [a, b, c] = projects;
    const source = { cwd: a, id: 'source', name: 'Source' }, target = { cwd: b, id: 'target', name: 'Target' }, moved = { ...source, cwd: c };
    const reply = { entryId: 'reply-entry', timestamp: 2, text: 'Synthetic reply' };
    const workflow = { leafId: 'leaf', prompts: [], replies: [reply], versions: [] };
    const history = [{ role: 'user', timestamp: 1, content: 'Synthetic prompt' }, { role: 'assistant', timestamp: 2, stopReason: 'stop', content: [{ type: 'text', text: reply.text }] }];
    let holdWorkflow = false, pendingWorkflow, workflowHeld, holdResolve = true, pendingResolve, resolveHeld, sourceSocket, didMove = false, moveRefreshed, forked;
    const workflowRequested = new Promise(resolve => { workflowHeld = resolve; });
    const resolveRequested = new Promise(resolve => { resolveHeld = resolve; });
    const moveRefresh = new Promise(resolve => { moveRefreshed = resolve; });
    const waitGate = async (promise, label) => {
        let timer;
        try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Synthetic gate did not arrive: ${label}`)), 5000); })]); }
        finally { clearTimeout(timer); }
    };
    const rows = cwd => [didMove ? moved : source, target, ...(forked ? [forked] : [])].filter(row => row.cwd === cwd);
    const ready = id => page.waitForFunction(id => document.querySelector('#pi-meta-id').textContent === id && !document.querySelector('#pi-input').disabled, id);
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const drawer = async () => { if (width < 900 && !await page.locator('#pi-session-pane').evaluate(node => node.classList.contains('open'))) await page.locator('#pi-toggle-sessions').click(); };
    const chooseB = async () => { await drawer(); await page.locator('[data-session-id="target"] .pi-session-main').click(); await waitGate(resolveRequested, 'B project resolve request'); };
    const releaseB = async () => {
        const received = page.waitForResponse(response => new URL(response.url()).pathname === '/api/pi/projects/resolve' && new URL(response.url()).searchParams.get('cwd') === b);
        holdResolve = false; await pendingResolve.fulfill({ json: { cwd: b } }); await (await received).finished(); await settle();
    };
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(projects => {
        localStorage.setItem('pi.web.cwd', projects[0]); localStorage.setItem(`pi.web.session:${projects[0]}`, 'source');
        localStorage.setItem('pi.web.expandedProjects', JSON.stringify(projects.slice(0, 3)));
    }, projects);
    await page.route('**/api/**', route => {
        const request = route.request(), url = new URL(request.url()), endpoint = url.pathname, cwd = url.searchParams.get('cwd');
        if (request.method() === 'POST' && endpoint.endsWith('/fork')) {
            writes.push(endpoint); forked = { cwd: a, id: 'reply-fork-created', name: 'Reply fork' };
            return route.fulfill({ json: { session: forked, draft: { message: 'Reply fork draft', images: [] } } });
        }
        if (request.method() !== 'GET') { writes.push(endpoint); return route.fulfill({ json: {} }); }
        if (endpoint.endsWith('/workflow')) {
            if (holdWorkflow) { pendingWorkflow = route; workflowHeld(); return; }
            return route.fulfill({ json: workflow });
        }
        if (endpoint.endsWith('/deferred')) return route.fulfill({ json: { jobs: [] } });
        if (endpoint === '/api/pi/status') return route.fulfill({ json: { ok: true, projectRoots: ['/synthetic'], projectIdentity: true, sessionWorkflows: true } });
        if (endpoint === '/api/pi/projects/resolve') {
            if (cwd === b && holdResolve) { pendingResolve = route; resolveHeld(); return; }
            return route.fulfill({ json: { cwd } });
        }
        if (endpoint === '/api/pi/projects') return route.fulfill({ json: { projects: [a, b, c].map(cwd => ({ cwd, sessionCount: rows(cwd).length })), roots: ['/synthetic'] } });
        if (endpoint === '/api/pi/sessions') {
            if (didMove && cwd === c) moveRefreshed();
            return route.fulfill({ json: { sessions: rows(cwd) } });
        }
        if (endpoint === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], hiddenProjects: [], pinnedProjects: [], replyNotices: [] } });
        return route.fulfill({ json: {} });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        ws.onMessage(raw => {
            const cmd = JSON.parse(raw); let data = {};
            if (cmd.type === 'open_session') {
                opens.push({ cwd: cmd.cwd, id: cmd.sessionId }); if (cmd.cwd === a) sourceSocket = ws;
                data = { session: rows(cmd.cwd).find(row => row.id === cmd.sessionId), state: { model, thinkingLevel: 'off' }, messages: { messages: history },
                    models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } };
            }
            if (cmd.type === 'get_state') data = { model, thinkingLevel: 'off' };
            ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }));
        });
    });
    try {
        await page.goto(base, { waitUntil: 'domcontentloaded' }); await ready('source');
        await page.waitForFunction(() => !document.querySelector('[data-message-workflow="reply-fork"]')?.disabled);
        await page.locator('#pi-input').fill('Source draft');
        await page.locator('#pi-file-input').setInputFiles({ name: 'retained.txt', mimeType: 'text/plain', buffer: Buffer.from('retained source attachment') });
        await page.waitForFunction(() => document.querySelector('#pi-attachments').textContent.includes('retained.txt'));
        await drawer(); await page.locator('#pi-session-search-toggle').click(); await page.locator('#pi-session-search').fill('synthetic');
        await page.waitForFunction(() => document.querySelector('[data-session-id="target"]'));
        await page.locator('#pi-session-search-toggle').click();
        if (width < 900) await page.locator('#pi-toggle-sessions').click();
        if (scenario.startsWith('reply-')) {
            holdWorkflow = true;
            await page.locator('[data-message-workflow="reply-fork"]').click(); await waitGate(workflowRequested, 'A workflow refresh request');
            if (scenario === 'reply-editor-replaced') {
                for (const text of ['First editor', 'Reopened editor']) {
                    await page.locator('#pi-composer-add-button').click(); await page.locator('#pi-schedule-button').click();
                    await page.locator('#pi-workflow-message').fill(text);
                    if (text === 'First editor') await page.locator('#pi-workflow-cancel').click();
                }
            } else if (scenario !== 'reply-current') await chooseB();
            holdWorkflow = false;
            await pendingWorkflow.fulfill(scenario === 'reply-refresh-error' ? { status: 500, json: { error: 'Synthetic workflow failure' } } : { json: workflow });
            await page.waitForFunction(() => document.querySelector('[data-message-workflow="reply-fork"]')?.getAttribute('aria-busy') !== 'true');
            await settle();
            if (scenario === 'reply-current') {
                assert.equal(await page.locator('#pi-workflow-title').textContent(), '从此回复后分叉');
                await page.locator('#pi-workflow-submit').click(); await ready('reply-fork-created');
                await page.locator('#pi-workflow-dialog').waitFor({ state: 'hidden' });
                assert.equal(await page.locator('#pi-input').inputValue(), 'Reply fork draft');
                await page.evaluate(({ cwd }) => PiChatNavigation.openSession({ cwd, sessionId: 'source' }), { cwd: a }); await ready('source');
                assert.equal(await page.locator('#pi-input').inputValue(), 'Source draft'); assert.match(await page.locator('#pi-attachments').textContent(), /retained.txt/);
            } else if (scenario === 'reply-editor-replaced') {
                assert.equal(await page.locator('#pi-workflow-title').textContent(), '延迟发送');
                assert.equal(await page.locator('#pi-workflow-message').inputValue(), 'Reopened editor', 'a late message refresh must not replace a reopened editor');
                await page.locator('#pi-workflow-cancel').click();
            } else {
                assert.equal(await page.locator('#pi-workflow-dialog').evaluate(node => node.open), false, 'a late reply refresh must not show a fork panel over the newer B choice');
                if (scenario === 'reply-refresh-error') assert.match(await page.locator('#pi-toast-region').textContent(), /Synthetic workflow failure/, 'a real refresh error remains visible after navigation changes');
                await releaseB(); await ready('target');
            }
        } else {
            await page.evaluate(() => {
                const originalBuffer = File.prototype.arrayBuffer, originalRead = PiAttachments.read;
                window.moveAttachmentRead = { started: false, settled: false };
                File.prototype.arrayBuffer = function (...args) {
                    if (this.name !== 'slow-move.txt') return originalBuffer.apply(this, args);
                    moveAttachmentRead.started = true;
                    return new Promise(resolve => { moveAttachmentRead.release = () => resolve(originalBuffer.apply(this, args)); });
                };
                PiAttachments.read = async function (file, ...args) {
                    try { return await originalRead.call(this, file, ...args); }
                    finally { if (file.name === 'slow-move.txt') { moveAttachmentRead.settled = true; File.prototype.arrayBuffer = originalBuffer; PiAttachments.read = originalRead; } }
                };
            });
            await page.locator('#pi-file-input').setInputFiles({ name: 'slow-move.txt', mimeType: 'text/plain', buffer: Buffer.from('delayed source attachment') });
            await page.waitForFunction(() => moveAttachmentRead.started);
            if (scenario !== 'move-current') await chooseB();
            didMove = true; sourceSocket.send(JSON.stringify({ type: 'gateway_session_moved', sourceCwd: a, session: moved }));
            // A following WS record proves the moved handler reached its first await.
            sourceSocket.send(JSON.stringify({ type: 'gateway_error', error: 'Synthetic moved delivery marker' }));
            await page.waitForFunction(() => document.querySelector('#pi-toast-region').textContent.includes('Synthetic moved delivery marker'));
            if (scenario === 'move-resolve-first') {
                await releaseB();
                assert.equal(await page.locator('#pi-project-path').textContent(), b, 'a remote move awaiting an attachment must not cancel B resolve');
                await ready('target');
            }
            await page.evaluate(() => moveAttachmentRead.release()); await page.waitForFunction(() => moveAttachmentRead.settled);
            await waitGate(moveRefresh, 'move draft/list refresh after attachment gate'); await settle();
            if (scenario === 'move-current') {
                await ready('source');
                assert.equal(await page.locator('#pi-project-path').textContent(), c);
                assert.equal(opens.filter(open => open.cwd === c).length, 1, 'a move follows a still-valid visible session exactly once');
            } else {
                assert.equal(opens.some(open => open.cwd === c), false, 'remote move cannot auto-follow C using a ticket owned by pending B');
                if (scenario === 'move-read-first') { await releaseB(); await ready('target'); }
                assert.equal(await page.locator('#pi-meta-id').textContent(), 'target');
                assert.equal(await page.locator('#pi-input').inputValue(), '');
                await page.locator('#pi-input').fill('B draft');
                await page.evaluate(({ cwd }) => PiChatNavigation.openSession({ cwd, sessionId: 'source' }), { cwd: c }); await ready('source');
            }
            assert.equal(await page.locator('#pi-input').inputValue(), 'Source draft', 'source draft maps to the moved session independently of auto-follow');
            assert.match(await page.locator('#pi-attachments').textContent(), /retained.txt/);
            if (scenario !== 'move-resolve-first') assert.match(await page.locator('#pi-attachments').textContent(), /slow-move.txt/, 'completed source read belongs to the moved draft');
            else assert.doesNotMatch(await page.locator('#pi-attachments').textContent(), /slow-move.txt/, 'a read invalidated by B must remain discarded');
            if (scenario !== 'move-current') {
                await page.evaluate(({ cwd }) => PiChatNavigation.openSession({ cwd, sessionId: 'target' }), { cwd: b }); await ready('target');
                assert.equal(await page.locator('#pi-input').inputValue(), 'B draft'); assert.equal(await page.locator('#pi-attachments').textContent(), '');
            }
        }
        assert.deepEqual(writes, scenario === 'reply-current' ? ['/api/pi/sessions/source/fork'] : [], 'only the explicitly confirmed current reply fork may submit; no late fork is replayed');
        assert.deepEqual(errors, []);
        assert.equal(await page.evaluate(() => innerWidth), width);
        await drawer();
        if (width < 900) await page.waitForFunction(() => document.querySelector('#pi-session-pane').getBoundingClientRect().left >= -1);
        assert.deepEqual(await page.evaluate(() => ['body', '.pi-composer', '#pi-transcript-content'].filter(selector => { const node = document.querySelector(selector); return node.scrollWidth > node.clientWidth + 1; })), []);
        console.log(JSON.stringify({ reviewedGate: scenario, width, opens, draftsAndAttachments: 'preserved', pageerror: errors }));
    } finally { await context.close(); }
}

(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
    try {
        const failures = [];
        for (const width of [1440, 393]) for (const scenario of ['reply-refresh', 'reply-refresh-error', 'reply-editor-replaced', 'reply-current', 'move-resolve-first', 'move-read-first', 'move-current']) {
            try { await runReviewedGates(browser, width, scenario); }
            catch (error) { const failure = { scenario, width, message: error.message, actual: error.actual, expected: error.expected, stack: error.stack }; console.error(JSON.stringify(failure)); failures.push(failure); }
        }
        if (failures.length) throw new Error(`${failures.length} reviewed navigation gates failed`);
        for (const width of [1440, 393]) await run(browser, width);
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
