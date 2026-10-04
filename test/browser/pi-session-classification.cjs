// Full UI against synthetic loopback REST/WS. No real sessions, identities or model calls.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const cwd = '/synthetic/408', profileId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const a = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', b = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
const groups = [{ id: a, name: '数据结构', cwd, profileIds: [profileId], archived: false },
    { id: b, name: '计算机网络 / Network research with a longer category name', cwd, profileIds: [profileId], archived: false },
    { id: 'archived', name: '归档分类', cwd, profileIds: [profileId], archived: true },
    { id: 'elsewhere', name: '其他目录分类', cwd: '/synthetic/other', profileIds: [profileId], archived: false }];
const model = { id: 'fixture', provider: 'fixture', name: 'Fixture', input: ['text', 'image'] };
const evidence = process.env.PIVANE_TEST_SCREENSHOT_DIR || path.join(os.tmpdir(), 'pivane-classification-design');
let classificationWrite;
async function run(browser, base, width, language, variant = 'assistant') {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: language, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(), errors = [], posts = [], opened = [];
    const en = language === 'en', assistant = variant !== 'ordinary', noGroups = variant === 'no-categories';
    let category = noGroups ? null : a, fail = false, hold = false, release, readHold = false, releaseRead, readEntered, revision = 'binding-1', activeSocket, forked = false, writeEntered;
    const original = () => ({ id: 'original', cwd, name: '带有完整历史与附件的学习会话 / Study conversation', messageCount: 4, modified: '2026-10-03T00:00:00Z',
        agentProfile: assistant ? { id: profileId, name: 'Study partner', available: true } : null,
        assistantProject: assistant && category ? { id: category, name: groups.find(group => group.id === category).name, cwd, available: true } : null });
    const fork = () => ({ ...original(), id: 'forked', name: '学习会话 · 分叉' });
    const history = [{ role: 'user', content: '历史问题', timestamp: 1 },
        { role: 'assistant', content: [{ type: 'text', text: '历史回答与保留的工具记录' }, { type: 'toolCall', id: 't', name: 'read', arguments: { path: 'notes.md' } }], timestamp: 2 },
        { role: 'toolResult', toolCallId: 't', toolName: 'read', content: [{ type: 'text', text: '保留的工具结果' }], timestamp: 3 },
        { role: 'assistant', content: [{ type: 'text', text: '最终回答' }], stopReason: 'stop', timestamp: 4 }];
    // Let classification writes cross the real HTTP parser: postDataJSON() also
    // parses text/plain bodies, which would hide a missing JSON Content-Type.
    classificationWrite = async (req, res) => {
        const input = req.body;
        posts.push({ p: req.path, body: input });
        writeEntered?.(input); writeEntered = null;
        if (!req.is('application/json') || !input) return res.status(400).json({ error: '分类变更参数无效' });
        assert.equal(input.cwd, cwd); assert.equal(input.expectedRevision, revision);
        assert.equal(input.expectedProjectsRevision, 'projects');
        if (hold) { hold = false; await new Promise(resolve => { release = resolve; }); }
        if (fail) return res.status(409).json({ error: 'Synthetic category conflict' });
        category = input.projectId; revision = 'binding-' + posts.length;
        activeSocket?.send(JSON.stringify({ type: 'gateway_session_classified', session: original() }));
        activeSocket?.close({ code: 1012, reason: 'Classification changed' });
        return res.json({ session: original(), changed: true });
    };
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ cwd, language }) => {
        localStorage.setItem('pi.workspace.language', language); localStorage.setItem('pi.web.cwd', cwd);
        localStorage.setItem('pi.web.session:' + cwd, 'original'); localStorage.setItem('pi.web.expandedProjects', JSON.stringify([cwd]));
        sessionStorage.setItem('pi.web.token', 'synthetic-token');
    }, { cwd, language });
    await page.route('**/api/**', async route => {
        const req = route.request(), url = new URL(req.url()), p = url.pathname;
        const reply = json => route.fulfill({ json });
        if (req.method() !== 'GET') {
            if (p.endsWith('/classification')) return route.continue();
            posts.push({ p, body: req.postDataJSON() });
            assert.ok(p.endsWith('/fork'), 'no prompts or unrelated writes'); forked = true; return reply({ session: fork(), draft: null });
        }
        if (p === '/api/pi/status') return reply({ ok: true, agentProfiles: true, assistantProjects: true, sessionClassification: true,
            sessionTransfer: true, sessionMoves: true, sessionWorkflows: true, replyFork: true, projectRoots: ['/synthetic'], defaultProject: cwd });
        if (p === '/api/pi/projects') return reply({ projects: [{ cwd, name: '408', sessionCount: forked ? 2 : 1 }], roots: ['/synthetic'] });
        if (p === '/api/pi/projects/resolve') return reply({ cwd: url.searchParams.get('cwd') });
        if (p === '/api/pi/profiles') return reply({ version: 1, revision: 'profiles', profiles: [{ id: profileId, name: 'Study partner', enabled: true }] });
        if (p === '/api/pi/assistant-projects') return reply({ version: 1, revision: 'projects', projects: noGroups ? [] : groups });
        if (p === '/api/pi/sessions') return reply({ sessions: url.searchParams.get('cwd') === cwd ? [original(), ...(forked ? [fork()] : [])] : [] });
        if (p.endsWith('/classification')) {
            if (readHold) { readHold = false; await new Promise(resolve => { releaseRead = resolve; readEntered(); }); }
            return reply({ session: original(), projectId: category, revision, projectsRevision: 'projects', projects: groups.slice(0, 2) });
        }
        if (p.endsWith('/workflow')) return reply({ leafId: 'leaf', prompts: [], replies: [], versions: [] });
        if (p.endsWith('/deferred')) return reply({ jobs: [], revision: 'deferred' });
        if (p === '/api/pi/activity') return reply({ runtimes: [], replyNotices: [], pinnedProjects: [], hiddenProjects: [] });
        if (p.includes('history') || p === '/api/prompts') return reply([]);
        return reply({});
    });
    await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => {
        const command = JSON.parse(raw), state = { model, isStreaming: false, thinkingLevel: 'off' };
        let data = {};
        if (command.type === 'open_session') {
            activeSocket = ws; opened.push(command.sessionId);
            data = { session: command.sessionId === 'forked' ? fork() : original(), state,
                messages: { messages: history },
                stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } };
        } else if (command.type === 'get_messages') data = { messages: history };
        else if (command.type === 'get_state') data = state;
        assert.ok(!['prompt', 'steer', 'follow_up'].includes(command.type));
        ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
    }));
    await page.route(/https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)\//, route => route.abort());
    const route = assistant ? '/#/assistant?' + new URLSearchParams({ profileId, projectId: noGroups ? 'unclassified:' + cwd : a, sessionId: 'original' }) : '/#/chat';
    await page.goto(base + route, { waitUntil: 'domcontentloaded' });
    await page.locator('#pi-input:not([disabled])').waitFor();
    const menu = page.locator('.pi-thread-menu:not(.hidden)');
    const menuOpen = async () => { await page.locator('#pi-input').evaluate(input => input.blur());
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.locator('#pi-current-thread-menu').click(); };
    await menuOpen();
    assert.equal(await menu.getByRole('menuitem', { name: en ? 'Change category…' : '更改分类…', exact: true }).count(), assistant && !noGroups ? 1 : 0);
    assert.equal(await menu.getByRole('menuitem', { name: en ? 'Move to project…' : '移动到项目…', exact: true }).count(), assistant ? 0 : 1);
    if (!assistant || noGroups) { assert.equal(posts.length, 0); assert.deepEqual(errors, []); await context.close(); return; }
    await page.keyboard.press('Escape');
    await page.locator('#pi-input').fill('保存后保留的草稿');
    await page.locator('#pi-file-input').setInputFiles({ name: '保留附件.txt', mimeType: 'text/plain', buffer: Buffer.from('附件正文') });
    await page.locator('#pi-attachments').getByText('保留附件.txt', { exact: true }).waitFor();
    const open = async () => { await menuOpen(); await menu.getByRole('menuitem', { name: en ? 'Change category…' : '更改分类…', exact: true }).click(); };
    const dialog = page.locator('#pi-classification-dialog');
    const save = dialog.getByRole('button', { name: en ? 'Save category' : '保存分类', exact: true });
    await open(); await page.locator('#pi-classification-target').waitFor();
    assert.deepEqual(await page.locator('#pi-classification-target option').evaluateAll(items => items.map(item => item.value)), ['', a, b]);
    assert.equal(await save.isDisabled(), true);
    for (const theme of ['daylight', 'mint', 'dark']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        const overflow = await dialog.evaluate(el => [el, ...el.querySelectorAll('label,p,strong,span,select,footer')]
            .filter(item => item.getClientRects().length && item.scrollWidth > item.clientWidth + 1).map(item => item.tagName));
        assert.deepEqual(overflow, []); assert.ok(await page.evaluate(() => document.body.scrollWidth <= innerWidth + 1));
        await page.screenshot({ path: path.join(evidence, `classification-${width}-${language}-${theme}.png`) });
    }
    if (width < 900) assert.equal(await page.locator('#pi-classification-target').evaluate(el => getComputedStyle(el).fontSize), '16px');
    await page.locator('#pi-classification-target').selectOption(b); await page.keyboard.press('Escape'); assert.equal(posts.length, 0);
    readHold = true; const readStarted = new Promise(resolve => { readEntered = resolve; }); await open(); await readStarted;
    await page.keyboard.press('Escape'); releaseRead(); releaseRead = null;
    await open(); await page.locator('#pi-classification-target').waitFor();
    const writeStarted = new Promise(resolve => { writeEntered = resolve; });
    fail = true; hold = true; await page.locator('#pi-classification-target').selectOption(b); await save.click();
    assert.ok(await writeStarted, 'classification form must submit a JSON body that Express can parse');
    await page.waitForFunction(() => document.querySelector('#pi-classification-dialog header button').disabled);
    await page.keyboard.press('Escape'); assert.equal(await dialog.evaluate(el => el.open), true); assert.equal(posts.length, 1);
    assert.ok(release); release(); release = null;
    await dialog.getByText('Synthetic category conflict').waitFor(); assert.equal(await save.isDisabled(), true);
    assert.equal(await page.locator('#pi-classification-target').inputValue(), b);
    await page.keyboard.press('Escape'); fail = false;
    await open(); await page.locator('#pi-classification-target').selectOption(b); await save.click();
    await page.waitForFunction(() => !document.querySelector('#pi-classification-dialog').open);
    await page.locator('#pi-input:not([disabled])').waitFor();
    assert.equal(await page.locator('#pi-input').inputValue(), '保存后保留的草稿');
    assert.equal(await page.locator('#pi-attachments').getByText('保留附件.txt', { exact: true }).count(), 1);
    assert.equal(await page.locator(`[data-assistant-project-id="${b}"] [data-session-id="original"]`).count(), 1);
    assert.equal(await page.locator(`[data-assistant-project-id="${a}"] [data-session-id="original"]`).count(), 0);
    assert.equal(new URL(page.url()).hash.includes('projectId=' + b), true);
    await open(); await page.locator('#pi-classification-target').selectOption(''); await save.click();
    await page.waitForFunction(() => !document.querySelector('#pi-classification-dialog').open);
    await page.locator('#pi-input:not([disabled])').waitFor();
    assert.equal(await page.locator('[data-assistant-project-id^="unclassified:"] [data-session-id="original"]').count(), 1);
    await open(); await page.locator('#pi-classification-target').selectOption(a); await save.click();
    await page.waitForFunction(() => !document.querySelector('#pi-classification-dialog').open);
    await page.locator('#pi-input:not([disabled])').waitFor();
    await menuOpen(); await menu.getByRole('menuitem', { name: en ? 'Copy to new thread' : '复制为新线程', exact: true }).click();
    await page.locator('#pi-workflow-submit:not([disabled])').waitFor(); await page.locator('#pi-workflow-submit').click();
    await page.waitForFunction(() => document.querySelector(`[data-assistant-project-id="bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb"] [data-session-id="forked"]`) !== null);
    await page.locator('#pi-input:not([disabled])').waitFor();
    assert.equal(new URL(page.url()).hash.includes('sessionId=forked'), true);
    assert.ok(opened.includes('forked')); await page.locator('#pi-transcript').getByText('最终回答', { exact: true }).waitFor();
    assert.deepEqual(errors, []); await context.close();
    console.log(JSON.stringify({ width, language, variant, writes: posts.length, pageerrors: errors.length, status: 'passed' }));
}
(async () => {
    fs.mkdirSync(evidence, { recursive: true });
    const app = express(), root = path.resolve(__dirname, '../..');
    app.use(express.json());
    app.put('/api/pi/sessions/:id/classification', (req, res, next) => {
        Promise.resolve().then(() => classificationWrite(req, res)).catch(next);
    });
    for (const [name, folder] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use('/vendor/' + name, express.static(path.join(root, 'node_modules', folder)));
    app.use(express.static(path.join(root, 'public')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        const base = 'http://127.0.0.1:' + server.address().port;
        for (const width of [1440, 393, 320]) for (const language of ['zh-CN', 'en']) await run(browser, base, width, language);
        await run(browser, base, 1440, 'zh-CN', 'no-categories'); await run(browser, base, 393, 'en', 'no-categories');
        await run(browser, base, 1440, 'en', 'ordinary'); await run(browser, base, 393, 'zh-CN', 'ordinary');
    } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
