const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { BUILTINS } = require('../../server/pi-composer-service');
const base = process.env.PI_COMPOSER_TOOLS_TEST_URL || 'http://127.0.0.1:3108';
const cwd = '/srv/composer-fixture';
const sessions = ['a', 'b'].map(id => ({ id, cwd, name: `Composer ${id}`, messageCount: 2 }));
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text', 'image'], contextWindow: 32000 };
const nextModel = { ...model, id: 'next', name: 'Next fixture' };
const messages = [{ role: 'user', content: 'fixture question', timestamp: 1 }, { role: 'assistant', content: [{ type: 'text', text: 'Fixture reply' }], timestamp: 2 }];
let debugPage;
async function run(browser, viewport) {
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 900, hasTouch: viewport.width < 900, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage(), errors = [], commands = [], mutations = [], pending = [];
    debugPage = page;
    let socket, compact, extensionPending, rejectExtension = false, holdExtension = false;
    const runtime = { model, thinkingLevel: 'off', isStreaming: false, isCompacting: false };
    const controls = { runtimeId: 'a', revision: 1, stopping: false, queue: { steering: [], followUp: [] }, recoveries: [], extension: { title: '', statuses: [], widgets: [] } };
    const templates = []; let remote = Array.from({ length: 35 }, (_, i) => ({ name: `fixture-${i}`, source: 'extension', description: `Command ${i} <img src=x onerror=alert(1)>` }));
    remote.push({ name: 'fixture-1', source: 'prompt', description: 'Shadowed by extension' }, { name: 'skill:review', source: 'prompt', description: 'Shadowed by Skill' }, { name: 'skill:review', source: 'skill', description: 'Review Skill' }, { name: 'pi5-web-navigate', source: 'extension', description: 'internal' });
    const reply = (ws, cmd, data = {}, error) => ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: !error, data, error }));
    const emit = event => socket.send(JSON.stringify(event));
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ cwd }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'a'); }, { cwd });
    await page.route('**/api/**', async route => {
        const req = route.request(), url = new URL(req.url()), endpoint = url.pathname;
        if (endpoint === '/api/pi/status') return route.fulfill({ json: { ok: true, composerTools: true, sessionWorkflows: true, runtimeControls: true, projectRoots: ['/srv'] } });
        if (endpoint === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd, name: 'Fixture', sessionCount: 2 }], roots: ['/srv'] } });
        if (endpoint === '/api/pi/sessions') return route.fulfill({ json: { sessions } });
        if (endpoint === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] } });
        if (endpoint === '/api/pi/settings/resources') return route.fulfill({ json: { packages: [], skills: [], diagnostics: [], settings: { enableSkillCommands: true }, resources: { extensions: [], skills: [], prompts: [], themes: [] } } });
        if (endpoint.endsWith('/deferred')) return route.fulfill({ json: { jobs: [] } });
        if (endpoint.endsWith('/workflow')) return route.fulfill({ json: { prompts: [], replies: [], versions: [], leafId: 'fixture' } });
        if (endpoint === '/api/pi/composer/catalog') return route.fulfill({ json: { cwd, builtins: BUILTINS, templates, warnings: [] } });
        if (endpoint === '/api/pi/composer/files') {
            if (url.searchParams.get('q') === 'late') { pending.push(route); return; }
            return route.fulfill({ json: { cwd, files: [{ path: 'src/button click.js' }, { path: 'src/组件.ts' }], truncated: false } });
        }
        if (endpoint === '/api/pi/composer/template') {
            if (req.method() === 'GET') return route.fulfill({ json: templates.find(t => t.name === url.searchParams.get('name')) });
            const input = req.postDataJSON(); mutations.push(input);
            const old = templates.find(t => t.name === input.name && t.scope === input.scope);
            if (input.expectedRevision !== (old?.revision || null)) return route.fulfill({ status: 409, json: { error: '模板已被其他页面修改' } });
            if (req.method() === 'DELETE') templates.splice(templates.indexOf(old), 1);
            else {
                const saved = { ...input, description: 'Fixture saved template', argumentHint: '<file> [notes]', filePath: `/fixture/agent/prompts/${input.name}.md`, revision: String(Number(old?.revision || 0) + 1) };
                if (old) Object.assign(old, saved); else templates.push(saved);
            }
            return route.fulfill({ json: { ok: true, requiresReload: true } });
        }
        if (req.method() !== 'GET') throw Error('Unexpected write ' + endpoint);
        return route.fulfill({ json: endpoint.includes('history') ? [] : {} });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        socket = ws;
        ws.onMessage(raw => {
            const cmd = JSON.parse(raw); commands.push(cmd);
            if (cmd.type === 'open_session') return reply(ws, cmd, { session: sessions.find(s => s.id === cmd.sessionId), state: runtime, controls, commands: { commands: remote }, messages: { messages }, stats: {}, models: { models: [model, nextModel] }, thinkingLevels: { levels: ['off', 'low', 'max'] } });
            if (cmd.type === 'get_state') return reply(ws, cmd, { ...runtime, webControls: controls });
            if (cmd.type === 'get_messages') return reply(ws, cmd, { messages });
            if (cmd.type === 'get_session_stats') return reply(ws, cmd, {});
            if (cmd.type === 'get_available_thinking_levels') return reply(ws, cmd, { levels: ['off', 'low', 'max'] });
            if (cmd.type === 'set_model') { runtime.model = nextModel; return reply(ws, cmd, nextModel); }
            if (cmd.type === 'set_thinking_level') { runtime.thinkingLevel = cmd.level; return reply(ws, cmd, {}); }
            if (cmd.type === 'reload_resources') {
                remote = remote.filter(c => c.source !== 'prompt').concat(templates.map(t => ({ name: t.name, source: 'prompt', description: t.description, sourceInfo: { path: t.filePath } })));
                emit({ type: 'gateway_commands', commands: remote }); return reply(ws, cmd, { commands: remote });
            }
            if (cmd.type === 'compact') { compact = { ws, cmd }; runtime.isCompacting = true; emit({ type: 'compaction_start', reason: 'manual' }); return; }
            if (cmd.type === 'quit_session') return reply(ws, cmd, { quit: true });
            if (['prompt', 'steer', 'follow_up'].includes(cmd.type)) {
                if (rejectExtension) return reply(ws, cmd, null, 'Controlled command rejection');
                if (holdExtension) { extensionPending = { ws, cmd }; return; }
                return reply(ws, cmd, {});
            }
            throw Error('Unexpected RPC ' + cmd.type);
        });
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.querySelector('#pi-input').disabled);
    const input = page.locator('#pi-input'), menu = page.locator('#pi-command-menu'), dialog = page.locator('#pi-template-dialog');
    const plus = page.locator('#pi-composer-add-button'), addMenu = page.locator('#pi-composer-add-menu');
    const assertMenuRows = async () => {
        const geometry = await addMenu.evaluate(menu => ({
            width: menu.clientWidth, clipped: menu.scrollHeight > menu.clientHeight + 1,
            rows: [...menu.querySelectorAll('button:not([hidden])')].map(button => {
                const label = button.querySelector('span'), subtitle = label.querySelector('small');
                const titleRange = document.createRange(); titleRange.selectNodeContents(label.firstChild);
                const subtitleRange = document.createRange(); subtitleRange.selectNodeContents(subtitle);
                return { width: button.getBoundingClientRect().width, titleLines: titleRange.getClientRects().length, subtitleLines: subtitleRange.getClientRects().length };
            })
        }));
        assert.equal(geometry.clipped, false, 'both menu items must fit without vertical clipping');
        assert.equal(geometry.rows.length, 2);
        for (const row of geometry.rows) {
            assert.ok(row.width >= geometry.width - 12, 'each item fills the menu instead of retaining icon-button width');
            assert.equal(row.titleLines, 1, 'menu title stays on one line');
            assert.equal(row.subtitleLines, 1, 'menu description stays on one line');
        }
    };
    const openTemplates = async () => {
        await page.locator('#workspace-settings-toggle').click();
        await page.locator('[data-settings-tab="skills"]').click();
        if (!await page.locator('#settings-skills-options').evaluate(e => e.open)) await page.locator('#settings-skills-options > summary').click();
        await page.locator('#settings-manage-templates').click();
    };
    assert.equal(await page.locator('#pi-composer-dialog, #pi-composer-tools-button, #pi-composer-tabs').count(), 0);
    assert.equal(await page.locator('.pi-composer > .pi-composer-actions:first-child > button:visible').count(), 1, 'one plus replaces the extra composer buttons');
    assert.equal(await page.locator('#pi-attach-button').isVisible(), false);
    assert.equal(await page.locator('#pi-schedule-button').isVisible(), false);
    await input.fill('Keep this draft'); await plus.click();
    assert.equal(await plus.getAttribute('aria-expanded'), 'true');
    await assertMenuRows();
    await page.screenshot({ path: `/tmp/pi-schedule-menu-${viewport.width}.png` });
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('#pi-schedule-button').evaluate(n => n === document.activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await addMenu.isVisible(), false); assert.equal(await plus.evaluate(n => n === document.activeElement), true);
    assert.equal(await input.inputValue(), 'Keep this draft');
    await plus.press('ArrowDown'); await page.keyboard.press('Tab');
    assert.equal(await addMenu.isVisible(), false); assert.equal(await input.evaluate(n => n === document.activeElement), true);
    await plus.click(); await input.click(); assert.equal(await addMenu.isVisible(), false, 'outside focus dismisses plus menu');
    await plus.click(); const chooser = page.waitForEvent('filechooser'); await page.locator('#pi-attach-button').click();
    await (await chooser).setFiles({ name: 'sample.txt', mimeType: 'text/plain', buffer: Buffer.from('File chooser fixture') });
    await page.locator('.pi-attachment-chip').waitFor(); assert.equal(await addMenu.isVisible(), false);
    assert.equal(await input.inputValue(), 'Keep this draft');
    await page.locator('.pi-attachment-chip > button').last().click();
    await page.locator('.pi-attachment-chip').waitFor({ state: 'detached' });
    await plus.click(); await page.locator('#pi-schedule-button').click();
    await page.locator('#pi-workflow-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#pi-workflow-message').inputValue(), 'Keep this draft');
    assert.equal(await addMenu.isVisible(), false);
    assert.equal(await page.locator('#pi-workflow-dialog').evaluate(n => n.contains(document.activeElement)), true, 'plus closes before the workflow takes focus');
    await page.locator('#pi-workflow-close').click();
    assert.equal(await input.inputValue(), 'Keep this draft');
    await input.fill('/');
    await page.waitForFunction(() => document.querySelectorAll('#pi-command-menu button').length > 50);
    assert.equal(await menu.locator('img').count(), 0);
    assert.doesNotMatch(await menu.textContent(), /pi5-web-navigate|Shadowed/);
    assert.equal(await menu.getByText('/fixture-1', { exact: true }).count(), 1, 'native command precedence prevents ambiguous invocation');
    await menu.hover(); await page.mouse.wheel(0, 500);
    await page.waitForFunction(() => document.querySelector('#pi-command-menu').scrollTop > 0);
    await input.press('ArrowUp');
    assert.equal(await menu.locator('[aria-selected=true]').count(), 1);
    await input.press('Escape'); assert.equal(await menu.isVisible(), false);
    await input.fill('/fixture-25'); await input.press('ArrowDown'); await input.press('Enter');
    assert.equal(await input.inputValue(), '/fixture-25 ');
    assert.equal(commands.filter(c => c.type === 'prompt').length, 0, 'completion never executes a command');
    await input.press('Enter'); await page.waitForFunction(() => document.querySelector('#pi-input').value === '');
    assert.equal(await page.locator('.optimistic').count(), 0, 'extension commands do not fabricate transcript messages');
    await input.fill('/fixture-2');
    await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
    assert.equal(await input.inputValue(), '/fixture-2');
    await input.press('Escape');
    rejectExtension = true; await page.locator('#pi-send-button').click();
    await page.waitForFunction(() => document.querySelector('#pi-toast-region').textContent.includes('Controlled command rejection'));
    assert.equal(await input.inputValue(), '/fixture-2'); rejectExtension = false;
    holdExtension = true; await page.locator('#pi-send-button').click();
    while (!extensionPending) await page.waitForTimeout(10);
    await input.fill('New draft while command is pending'); reply(extensionPending.ws, extensionPending.cmd);
    await page.waitForFunction(() => !document.querySelector('#pi-send-button').disabled);
    assert.equal(await input.inputValue(), 'New draft while command is pending'); holdExtension = false;
    const count = commands.length;
    await input.fill('/share'); await input.press('Enter'); assert.equal(await input.inputValue(), '/share');
    await input.fill('/not-a-command'); await input.press('Enter');
    assert.equal(commands.length, count, 'unsupported and unknown slash commands cannot become model prompts');
    await input.fill('/model fixture/next'); await input.press('Enter');
    await page.waitForFunction(() => document.querySelector('#pi-input').value === '');
    assert.equal(await page.locator('#pi-model-select').inputValue(), 'fixture|||next');
    await input.fill('/thinking max'); await input.press('Enter');
    await page.waitForFunction(() => document.querySelector('#pi-input').value === '');
    assert.ok(commands.some(c => c.type === 'set_thinking_level' && c.level === 'max'));
    await input.fill('/compact Preserve decisions'); await input.press('Enter');
    await page.waitForFunction(() => document.querySelector('#pi-input').value === '');
    assert.ok(compact, 'compact clears at authoritative start, before the RPC finishes');
    await input.fill('Draft during compaction'); runtime.isCompacting = false;
    reply(compact.ws, compact.cmd, {}); emit({ type: 'compaction_end', reason: 'manual', result: { summary: 'summary', tokensBefore: 100 } });
    await page.waitForFunction(() => !document.querySelector('#pi-send-button').disabled);
    assert.equal(await input.inputValue(), 'Draft during compaction');
    await input.fill('/copy'); await input.press('Enter'); await page.waitForFunction(() => document.querySelector('#pi-input').value === '');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Fixture reply');
    await input.fill('/skill:review'); await input.press('ArrowDown'); await input.press('Enter');
    assert.equal(await input.inputValue(), '/skill:review ');
    assert.equal(await dialog.isVisible(), false, 'inline selection never opens a command dialog');
    await input.fill(''); await openTemplates();
    await dialog.getByRole('button', { name: '新建模板', exact: true }).click();
    await page.locator('#pi-template-name').fill('my-review');
    const templateText = '---\ndescription: Fixture\nargument-hint: "<file> [notes]"\ncustom: preserve\n---\nRead $1. Notes: ${2:-default}';
    await page.locator('#pi-template-content').fill(templateText);
    await dialog.getByRole('button', { name: '保存模板', exact: true }).click();
    await dialog.locator('.pi-composer-template').waitFor();
    assert.equal(templates[0].content, templateText); assert.equal(mutations[0].expectedRevision, null);
    assert.match(await dialog.textContent(), /尚未加载到当前会话/);
    await dialog.getByRole('button', { name: '重新加载当前会话资源' }).click();
    await page.waitForFunction(() => document.querySelector('#pi-template-body').textContent.includes('已加载，在输入框输入 /my-review'));
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await page.locator('#workspace-settings-dialog').isVisible(), true, 'closing template manager keeps settings open');
    assert.equal(await page.locator('#settings-manage-templates').evaluate(n => n === document.activeElement), true);
    await page.locator('#workspace-settings-close').click();
    await input.fill('/my-review'); await input.press('ArrowDown'); await input.press('Tab');
    assert.equal(await input.inputValue(), '/my-review ');
    await input.fill('/my-review "src/button click.js" "检查中文"');
    const invocation = await input.inputValue();
    runtime.isStreaming = true; emit({ type: 'agent_start' });
    await input.press('Enter'); await page.waitForFunction(() => document.querySelector('#pi-input').value === '');
    assert.ok(commands.some(c => c.type === 'steer' && c.message === invocation), 'templates queued through native steer still expand in Pi');
    await input.fill('/fixture-1'); await input.press('Enter'); await page.waitForFunction(() => document.querySelector('#pi-input').value === '');
    assert.ok(commands.some(c => c.type === 'prompt' && c.message === '/fixture-1'), 'extension commands use prompt even during a run');
    runtime.isStreaming = false; emit({ type: 'agent_settled' });
    await input.fill('Please explain @btn');
    await menu.locator('[data-completion]').first().waitFor(); await input.press('ArrowDown'); await input.press('Enter');
    assert.equal(await input.inputValue(), 'Please explain @"./src/button click.js" ');
    await input.fill('user@example.com'); await page.waitForTimeout(200); assert.equal(await menu.isVisible(), false);
    await input.fill('@late'); while (!pending.length) await page.waitForTimeout(10);
    await input.fill('A newer draft'); await pending.shift().fulfill({ json: { cwd, files: [{ path: 'old-result.js' }] } });
    await page.waitForTimeout(150); assert.equal(await menu.isVisible(), false); assert.equal(await input.inputValue(), 'A newer draft');
    await input.fill('A newer draft @组件');
    await menu.locator('[data-completion]').first().waitFor();
    await menu.getByText('@src/组件.ts', { exact: true }).click();
    assert.match(await input.inputValue(), /@\.\/src\/组件.ts/);
    await openTemplates();
    await dialog.getByRole('button', { name: '编辑', exact: true }).click();
    await page.locator('#pi-template-content').fill('unsaved edit'); templates[0].revision = '99';
    await dialog.getByRole('button', { name: '保存模板', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#pi-toast-region').textContent.includes('模板已被其他页面修改'));
    assert.equal(await page.locator('#pi-template-content').inputValue(), 'unsaved edit');
    await page.locator('#pi-template-close').click();
    await page.locator('#workspace-settings-close').click();
    await input.fill('@late'); while (!pending.length) await page.waitForTimeout(10);
    if (viewport.width < 900) await page.locator('#pi-toggle-sessions').click();
    await page.locator('[data-session-id="b"] .pi-session-main').click();
    await page.waitForFunction(() => document.querySelector('#pi-meta-id').textContent === 'b' && !document.querySelector('#pi-input').disabled);
    await pending.shift().fulfill({ json: { cwd, files: [{ path: 'old-thread.js' }] } });
    await page.waitForTimeout(100); assert.equal(await menu.isVisible(), false); assert.equal(await input.inputValue(), '');
    for (const theme of ['daylight', 'mint', 'dark']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        await plus.click();
        await assertMenuRows();
        const bounds = await addMenu.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height);
        await page.screenshot({ path: `/tmp/pi-composer-plus-${viewport.width}-${theme}.png` });
        await page.keyboard.press('Escape');
        await openTemplates();
        const box = await dialog.boundingBox();
        assert.ok(Math.abs(box.x - (viewport.width - box.width) / 2) < 1, 'template manager stays centered');
        await page.screenshot({ path: `/tmp/pi-composer-tools-${viewport.width}-${theme}.png` });
        assert.deepEqual(await page.evaluate(() => ['body', '#pi-template-dialog', '#pi-template-body', '.pi-composer', '#pi-transcript-content'].filter(s => { const n = document.querySelector(s); return n.scrollWidth > n.clientWidth + 1; })), []);
        await page.locator('#pi-template-close').click();
        await page.locator('#workspace-settings-close').click();
    }
    await input.fill('/quit'); await input.press('Enter'); await page.waitForFunction(() => document.querySelector('#pi-input').disabled);
    assert.equal(await input.inputValue(), '', 'quit removes the accepted slash draft');
    assert.deepEqual(errors, []);
    console.log(`PASS ${viewport.width}: plus menu/upload/scheduling/focus, inline scroll/keyboard/IME commands, built-ins, queue dispatch, slash clearing/new drafts, settings template CRUD/reload, @file and thread races, three themes`);
    await context.close();
}
(async () => {
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try { for (const viewport of [{ width: 1440, height: 1000 }, { width: 393, height: 852 }, { width: 320, height: 740 }].filter(v => !process.env.PI_COMPOSER_VIEWPORT || v.width === Number(process.env.PI_COMPOSER_VIEWPORT))) await run(browser, viewport); }
    catch (error) {
        await debugPage.screenshot({ path: '/tmp/pi-composer-plus-failure.png', timeout: 5000 }).catch(() => {});
        console.log(await debugPage.evaluate(() => ['#workspace-settings-close', '#workspace-settings-dialog', '.workspace-settings-dialog', '[data-settings-panel="skills"]', '#settings-manage-templates', '#pi-template-dialog'].map(s => { const n = document.querySelector(s), box = n.getBoundingClientRect(); return { selector: s, x: box.x, y: box.y, width: box.width, height: box.height, scroll: n.scrollTop, focused: document.activeElement?.id }; })).catch(() => []));
        console.log(await debugPage.evaluate(async () => {
            const samples = [];
            for (let i = 0; i < 12; i++) { await new Promise(requestAnimationFrame); const b = document.querySelector('#workspace-settings-close'), h = b.parentElement, s = getComputedStyle(b); samples.push({ y: b.getBoundingClientRect().y, x: b.getBoundingClientRect().x, header: h.getBoundingClientRect().height, transform: s.transform, animation: s.animationName }); }
            return samples;
        }).catch(() => []));
        throw error;
    }
    finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
