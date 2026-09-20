const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { nativeSchema } = require('../../server/pi-native-service');
let schema;
const baseUrl = process.env.PI_NATIVE_SETTINGS_TEST_URL || 'http://127.0.0.1:3001';
const cwd = '/tmp/native-settings-fixture', other = '/tmp/other-project';
const flags = { ok: true, nativeSettings: true, nativeResources: true, projectTrust: true, modelAdvanced: true, projectRoots: ['/tmp'] };
const tick = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
async function widthCheck(page) {
    const sizes = await page.evaluate(() => [...document.querySelectorAll('body,.workspace-settings-content,.workspace-settings-panel.active,.native-tool-field,.native-tool-options,.native-grid,#pi-project-trust-dialog[open],#pi-project-trust-body,#pi-loaded-resources-body')].filter(e => e.getClientRects().length).map(e => ({ id: e.id, w: e.clientWidth, s: e.scrollWidth })));
    assert.ok(sizes.every(s => s.s <= s.w + 1), JSON.stringify(sizes));
}
async function settingsRun(browser, width) {
    const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width, height: 900 }, isMobile: width < 900, hasTouch: width < 900 });
    const page = await ctx.newPage(), errors = [], writes = [];
    let revision = 'v1', conflict = false, slowScope, releaseScope, failReadAfterWrite = false, failResourceRead = false, failNativeAfterWrite = false, failNativeRead = false;
    const trusts = new Map(), values = { global: {}, project: {} }, enabled = { skill: true, prompt: true }, overrides = {};
    page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
    await page.addInitScript(({ cwd, width }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.workspace.theme', width === 1440 ? 'light' : width === 393 ? 'mint' : 'dark'); }, { cwd, width });
    await page.addInitScript(() => { window.menuDebug = []; for (const name of ['scroll', 'resize', 'pointerdown']) window.addEventListener(name, e => { window.menuDebug.push([name, e.target?.id || e.target?.className || e.target?.nodeName || '', Math.round(performance.now()), scrollX, scrollY, document.documentElement.scrollWidth, document.documentElement.clientWidth]); }, true); });
let legacy = false;
    const native = project => {
        const effective = trusts.get(project) ?? values.global.defaultProjectTrust === 'always';
        return { cwd: project, revision, trust: { effective, decision: trusts.get(project) ?? null, savedPath: trusts.has(project) ? project : null, defaultPolicy: values.global.defaultProjectTrust ?? 'ask', override: null }, schema: legacy ? Object.fromEntries(Object.entries(schema).filter(([k]) => !['defaultTools', 'defaultProjectTrust'].includes(k))) : schema,
            settings: Object.fromEntries(Object.entries(schema).map(([k, f]) => {
                const projectValue = effective && !f.globalOnly ? values.project[k] : null;
                return [k, { value: projectValue ?? values.global[k] ?? (f.type === 'tools' ? f.defaults : f.type === 'boolean' ? true : f.type === 'select' ? f.choices[0] : f.type === 'lines' ? [] : 20000), source: projectValue != null ? 'project' : values.global[k] != null ? 'global' : 'default', global: values.global[k] ?? null, project: values.project[k] ?? null }];
            })), environment: {} };
    };
    await page.route('**/api/**', async route => {
        const r = route.request(), url = new URL(r.url()), p = url.pathname, scope = url.searchParams.get('scope');
        if (r.method() !== 'GET') {
            const body = r.postDataJSON(); writes.push({ p, body });
            if (conflict) return route.fulfill({ status: 409, json: { error: '配置已变化，请刷新后再保存' } });
            revision += 'x';
            if (p.endsWith('/trust')) trusts.set(body.cwd, body.decision);
            if (p === '/api/pi/settings/native') { Object.assign(values[body.scope], body.values); if (failNativeAfterWrite) { failNativeRead = true; failNativeAfterWrite = false; } }
            if (p.endsWith('/native/resources')) { if (failReadAfterWrite) { failResourceRead = true; failReadAfterWrite = false; } if (body.scope === 'global') enabled[body.resourceId] = body.state === 'on'; else overrides[body.resourceId] = body.state; }
            return route.fulfill({ json: { ok: true, requiresReload: true } });
        }
        if (p === '/api/pi/status') return route.fulfill({ json: flags });
        if (p === '/api/pi/settings/native') {
            if (failNativeRead) { failNativeRead = false; return route.fulfill({ status: 503, json: { error: 'Controlled read failure' } }); }
            return route.fulfill({ json: native(url.searchParams.get('cwd')) });
        }
        if (p === '/api/pi/settings/native/resources') {
            if (failResourceRead) { failResourceRead = false; return route.fulfill({ status: 503, json: { error: 'Controlled resource read failure' } }); }
            if (scope === slowScope) await new Promise(r => { releaseScope = r; });
            const state = id => scope === 'project' && ['on', 'off'].includes(overrides[id]) ? overrides[id] === 'on' : enabled[id];
            return route.fulfill({ json: { cwd, revision, trust: native(cwd).trust, scope, packages: [{ source: 'npm:fixture', scope: 'user', installed: true }], resources: [
                { id: 'prompt', type: 'prompts', path: '/tmp/package/prompts/review.md', source: 'npm:fixture', scope: 'user', enabled: state('prompt'), override: overrides.prompt || 'inherit' },
                { id: 'skill', type: 'skills', path: '/tmp/package/skills/review/SKILL.md', source: 'npm:fixture', scope: 'user', enabled: state('skill'), override: overrides.skill || 'inherit' }
            ] } });
        }
        if (p === '/api/pi/settings/models') return route.fulfill({ json: { modelAdvanced: true, preferences: {}, providers: [{ id: 'fixture', name: 'Fixture', configured: true, authMethods: {} }], models: [{ provider: 'fixture', id: 'model', name: 'Model', available: true, input: ['text'], contextWindow: 32000 }], customProviders: [] } });
        if (p === '/api/pi/settings/resources') return route.fulfill({ json: { packages: [], resources: { extensions: [], skills: [], prompts: [], themes: [] }, skills: [{ name: 'review', description: '检查代码改动，整理审查建议。', filePath: '/tmp/package/skills/review/SKILL.md', scope: 'user' }], diagnostics: [], settings: {} } });
        if (p === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd, name: 'Fixture', sessionCount: 0 }, { cwd: other, name: 'Other project', sessionCount: 0 }], roots: ['/tmp'] } });
        if (p === '/api/pi/sessions') return route.fulfill({ json: { sessions: [] } });
        if (p === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], replyNotices: [] } });
        return route.fulfill({ json: p.includes('history') || p === '/api/prompts' ? [] : {} });
    });
    await page.routeWebSocket('**/api/pi/ws', () => { throw Error('project trust and settings must not start a runtime'); });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    if (width < 900) await page.locator('#pi-toggle-sessions').click();
    await page.locator('[data-filter="all"]').click();
    await page.locator(`[data-project-cwd="${other}"] [data-project-action="menu"]`).click();
    await page.evaluate(() => document.dispatchEvent(new Event('scroll')));
    await page.getByRole('menuitem', { name: '更多操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '项目信任', exact: true }).click({ timeout: 5000 }).catch(async e => { console.log(await page.evaluate(() => window.menuDebug)); await page.screenshot({ path: `/tmp/pi-native-menu-failure-${width}.png` }); throw e; });
    await page.locator('#native-trust-state').waitFor();
    const box = await page.locator('#pi-project-trust-dialog').boundingBox();
    assert.ok(Math.abs(box.x + box.width / 2 - width / 2) < 2, 'trust dialog must be centered');
    await page.locator('#native-trust-allow').click();
    await page.waitForFunction(() => document.querySelector('#pi-project-trust-status').textContent.includes('已保存'));
    assert.equal(writes.at(-1).body.cwd, other, 'project menu acts on its project without selecting it');
    assert.equal(await page.evaluate(() => localStorage.getItem('pi.web.cwd')), cwd);
    await widthCheck(page); await page.screenshot({ path: `/tmp/pi-native-trust-${width}.png` });
    await page.keyboard.press('Escape');
    if (width < 900) await page.locator('#pi-toggle-sessions').click();
    await page.locator('#workspace-settings-toggle').click();
    await page.locator('[data-settings-tab="native"]').click();
    await page.locator('.native-setting-group').first().waitFor();
    assert.equal(await page.locator('.native-setting-group').count(), 7);
    assert.equal(await page.locator('.native-setting-group[open]').count(), 0);
    assert.equal(await page.locator('#native-settings-panel #native-trust-state,#native-settings-panel #native-runtime').count(), 0);
    assert.equal(await page.locator('#native-editor,#native-skill-edit,#settings-create-skill').count(), 0);
    await widthCheck(page); await page.screenshot({ path: `/tmp/pi-native-settings-${width}.png` });
    await page.locator('[data-group="tools"] > summary').click();
    assert.equal(await page.locator('#native-tools-mode').inputValue(), 'inherit');
    assert.equal(await page.locator('.native-tool-options input').first().isEnabled(), false);
    assert.equal(await page.locator('#native-tools-runtime').isEnabled(), false);
    await page.locator('#native-tools-mode').selectOption('custom');
    for (const check of await page.locator('.native-tool-options input').all()) await check.uncheck();
    assert.match(await page.locator('#native-tools-selection').textContent(), /未启用任何内置工具/);
    await page.locator('#native-settings-save').click();
    await page.waitForFunction(() => document.querySelector('#native-status').textContent.includes('已保存'));
    assert.deepEqual(writes.at(-1).body.values, { defaultTools: [] });
    assert.equal(await page.locator('#native-tools-mode').inputValue(), 'custom');
    await page.locator('.native-tool-options input[value="grep"]').check();
    await page.locator('#native-settings-save').click();
    await page.waitForFunction(() => document.querySelector('[name="defaultTools"]').dataset.initial === '["grep"]');
    assert.deepEqual(values.global.defaultTools, ['grep']);
    await widthCheck(page);
    const checks = await page.locator('.native-tool-options input').evaluateAll(items => items.map(e => ({ w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height })));
    assert.ok(checks.every(c => c.w >= 16 && c.w <= 24 && c.h >= 16 && c.h <= 24));
    await page.locator('[data-group="tools"]').evaluate(e => e.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: `/tmp/pi-native-tools-${width}.png` });
    trusts.set(cwd, true); await page.locator('#native-refresh').click();
    await page.locator('#native-settings-scope').selectOption('project');
    assert.equal(await page.locator('[name="defaultProjectTrust"]').count(), 0);
    await page.locator('[data-group="tools"] > summary').click();
    assert.equal(await page.locator('#native-tools-mode').inputValue(), 'inherit');
    await page.locator('#native-tools-mode').selectOption('custom');
    await page.locator('.native-tool-options input[value="grep"]').uncheck();
    await page.locator('#native-settings-save').click();
    await page.waitForFunction(() => document.querySelector('[name="defaultTools"]').dataset.initial === '[]');
    assert.deepEqual(values.global.defaultTools, ['grep']); assert.deepEqual(values.project.defaultTools, []);
    await page.locator('#native-tools-mode').selectOption('inherit');
    await page.locator('#native-settings-save').click();
    await page.waitForFunction(() => document.querySelector('[name="defaultTools"]').dataset.initial === 'null');
    assert.equal(values.project.defaultTools, null);
    await page.locator('#native-settings-scope').selectOption('global');
    await page.locator('#native-tools-mode').selectOption('inherit');
    await page.locator('#native-settings-save').click();
    await page.waitForFunction(() => document.querySelector('[name="defaultTools"]').dataset.initial === 'null');
    assert.equal(values.global.defaultTools, null);
    assert.deepEqual(await page.locator('.native-tool-options input:checked').evaluateAll(items => items.map(c => c.value)), schema.defaultTools.defaults);
    await page.locator('[data-group="trust"] > summary').click();
    await page.locator('[name="defaultProjectTrust"]').selectOption('always');
    await page.locator('#native-settings-save').click();
    await page.waitForFunction(() => document.querySelector('[name="defaultProjectTrust"]').dataset.initial === '"always"');
    assert.deepEqual(writes.at(-1).body.values, { defaultProjectTrust: 'always' });
    await widthCheck(page);
    await page.locator('[data-group="trust"]').evaluate(e => e.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: `/tmp/pi-native-policy-${width}.png` });
    conflict = true;
    await page.locator('[name="defaultProjectTrust"]').selectOption('never');
    await page.locator('#native-settings-save').click();
    await page.waitForFunction(() => document.querySelector('#native-status').textContent.includes('变化'));
    assert.equal(await page.locator('[name="defaultProjectTrust"]').inputValue(), 'never'); conflict = false;
    failNativeAfterWrite = true;
    await page.locator('#native-settings-save').click();
    await page.waitForFunction(() => document.querySelector('#native-status').textContent.includes('已保存，但配置读取失败'));
    assert.equal(await page.locator('#native-settings-save').count(), 0);
    await page.locator('#native-refresh').click();
    await page.locator('[data-group="trust"] > summary').click();
    await page.locator('[name="defaultProjectTrust"]').selectOption('');
    await page.locator('#native-settings-save').click();
    await page.waitForFunction(() => document.querySelector('[name="defaultProjectTrust"]').dataset.initial === 'null');
    assert.equal(values.global.defaultProjectTrust, null);
    values.global.defaultTools = ['grep', 'read'];
    await page.locator('#native-refresh').click();
    await page.locator('[data-group="messages"] > summary').click();
    await page.locator('[name="steeringMode"]').selectOption('all');
    await page.locator('#native-settings-save').click();
    await page.waitForFunction(() => document.querySelector('#native-status').textContent.includes('已保存'));
    assert.deepEqual(writes.at(-1).body.values, { steeringMode: 'all' });
    conflict = true; await page.locator('[name="followUpMode"]').selectOption('all'); await page.locator('#native-settings-save').click();
    await page.waitForFunction(() => document.querySelector('#native-status').textContent.includes('变化'));
    assert.equal(await page.locator('[name="followUpMode"]').inputValue(), 'all'); conflict = false;
    await page.locator('[data-settings-tab="skills"]').click();
    const row = page.locator('[data-skill-id="skill"]'); await row.waitFor();
    await row.getByRole('button', { name: '停用 review', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-skill-id="skill"]')?.dataset.enabled === 'false');
    assert.equal(writes.at(-1).body.state, 'off'); assert.equal(writes.at(-1).body.scope, 'global');
    assert.equal(await row.count(), 1, 'disabled skills stay discoverable');
    await row.getByRole('button', { name: '启用 review', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-skill-id="skill"]')?.dataset.enabled === 'true');
    conflict = true; const count = writes.length;
    await row.getByRole('button', { name: '停用 review', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#native-skills-status').textContent.includes('变化'));
    assert.equal(await row.getAttribute('data-enabled'), 'true'); assert.equal(writes.length, count + 1); conflict = false;
    failReadAfterWrite = true; const beforeReadFailure = writes.length;
    await row.getByRole('button', { name: '停用 review', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#native-skills-status').textContent.includes('已保存，但列表读取失败'));
    assert.equal(writes.length, beforeReadFailure + 1); assert.equal(await row.count(), 0);
    await page.locator('#native-skills-refresh').click();
    await row.getByRole('button', { name: '启用 review', exact: true }).click();
    await row.getByRole('button', { name: '停用 review', exact: true }).waitFor();
    trusts.set(cwd, true);
    slowScope = 'project'; await page.locator('#native-skills-scope').selectOption('project');
    for (let i = 0; !releaseScope && i < 100; i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(releaseScope); assert.equal(await row.locator('button').first().isEnabled(), false);
    await page.locator('#native-skills-scope').selectOption('global');
    await page.locator('[data-skill-id="skill"] button:not([disabled])').waitFor();
    releaseScope(); slowScope = null; await tick(page);
    assert.equal(await page.locator('#native-skills-scope').inputValue(), 'global', 'late scope snapshot cannot replace selected scope');
    await page.locator('#native-skills-scope').selectOption('project');
    await page.locator('[data-skill-id="skill"] button:not([disabled])').waitFor();
    await row.getByRole('button', { name: '停用 review', exact: true }).click();
    await row.getByRole('button', { name: '恢复继承' }).waitFor();
    assert.equal(enabled.skill, true, 'project override does not mutate global choice');
    await row.getByRole('button', { name: '恢复继承' }).click();
    await row.getByRole('button', { name: '停用 review', exact: true }).waitFor();
    await widthCheck(page); await page.screenshot({ path: `/tmp/pi-native-skills-${width}.png` });
    await page.locator('[data-settings-tab="providers"]').click();
    await page.locator('.settings-model-group > summary').click();
    assert.equal(await page.locator('[data-action="advanced"]').count(), 0);
    await page.locator('#workspace-settings-close').click();
    await page.evaluate(other => window.dispatchEvent(new CustomEvent('pi:project-trust', { detail: { cwd: other } })), other);
    await page.locator('.native-trust-details > summary').click();
    assert.match(await page.locator('.native-trust-details').textContent(), /全局默认策略/);
    await page.locator('#native-trust-global').click();
    await page.locator('[data-group="trust"][open]').waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('pi.web.cwd')), cwd);
    await widthCheck(page);
    legacy = true; await page.locator('#native-refresh').click();
    await page.waitForFunction(() => document.querySelectorAll('.native-setting-group').length === 5);
    assert.equal(await page.locator('#native-tools-mode,[name="defaultProjectTrust"]').count(), 0);
    assert.ok(writes.every(w => ['/api/pi/settings/native/trust', '/api/pi/settings/native', '/api/pi/settings/native/resources'].includes(w.p)));
    assert.deepEqual(errors, []); console.log('PASS native settings ' + width); await ctx.close();
}
async function contextRun(browser, width) {
    const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width, height: 900 }, isMobile: width < 900, hasTouch: width < 900 });
    const page = await ctx.newPage(), errors = [], commands = [];
    const model = { provider: 'fixture', id: 'model', name: 'Fixture', input: ['text'], contextWindow: 32000 };
    const sessions = ['first', 'second'].map(id => ({ id, cwd, name: id, messageCount: 0 }));
    let socket, active = sessions[0], delayed, hold = false;
    const reply = (ws, cmd, data) => ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }));
    const inventory = () => ({ sessionId: active.id, cwd, projectTrusted: true, contextFiles: [{ path: '/tmp/' + 'long/'.repeat(80) + 'AGENTS.md' }], skills: [{ name: '<img src=x>', path: '/tmp/SKILL.md' }], commands: [], tools: [], systemPrompt: {} });
    await page.addInitScript(({ cwd }) => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'first'); }, { cwd });
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/**', route => {
        const r = route.request(), p = new URL(r.url()).pathname;
        assert.equal(r.method(), 'GET');
        if (p === '/api/pi/status') return route.fulfill({ json: { ...flags, composerTools: true } });
        if (p === '/api/pi/settings/native') return route.fulfill({ json: { cwd, revision: 'fixture', schema, trust: { effective: true, override: null, savedPath: cwd, defaultPolicy: 'ask' }, settings: Object.fromEntries(Object.entries(schema).map(([k, f]) => [k, { global: null, project: null, source: 'default', value: f.type === 'tools' ? f.defaults : f.type === 'select' ? f.choices[0] : f.type === 'boolean' ? true : f.type === 'lines' ? [] : 20000 }])), environment: {} } });
        if (p === '/api/pi/settings/models') return route.fulfill({ json: { preferences: {}, providers: [], models: [], customProviders: [] } });
        if (p === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd, name: 'Fixture', sessionCount: 2 }], roots: ['/tmp'] } });
        if (p === '/api/pi/sessions') return route.fulfill({ json: { sessions } });
        if (p === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], replyNotices: [] } });
        return route.fulfill({ json: p.includes('history') || p === '/api/prompts' ? [] : {} });
    });
    await page.routeWebSocket('**/api/pi/ws', ws => { socket = ws; ws.onMessage(raw => {
        const cmd = JSON.parse(raw); commands.push(cmd.type);
        if (cmd.type === 'open_session') { active = sessions.find(s => s.id === cmd.sessionId); return reply(ws, cmd, { session: active, state: { model, isStreaming: false }, messages: { messages: [] }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } }); }
        if (cmd.type === 'get_native_resources') { if (hold) { delayed = () => reply(ws, cmd, { ...inventory(), skills: [{ name: 'STALE', path: '/old' }] }); return; } return reply(ws, cmd, inventory()); }
        if (cmd.type === 'reload_resources') return reply(ws, cmd, { commands: [] });
        if (cmd.type === 'get_state') return reply(ws, cmd, { model, isStreaming: false });
        if (cmd.type === 'get_messages') return reply(ws, cmd, { messages: [] });
        if (cmd.type === 'get_session_stats') return reply(ws, cmd, {});
        throw Error('Unexpected RPC ' + cmd.type);
    }); });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.querySelector('#pi-input').disabled);
    assert.equal(commands.filter(c => c === 'get_native_resources').length, 0);
    await page.locator('#workspace-settings-toggle').click();
    await page.locator('[data-settings-tab="native"]').click();
    await page.locator('[data-group="tools"] > summary').click();
    await page.locator('#native-tools-runtime').click();
    await page.locator('#pi-loaded-resources-body details').first().waitFor();
    await page.locator('#pi-loaded-resources-body details > summary').first().click();
    assert.equal(await page.locator('#pi-loaded-resources-body img').count(), 0); await widthCheck(page);
    await page.screenshot({ path: `/tmp/pi-native-resources-${width}.png` });
    await page.locator('#pi-loaded-resources-reload').click();
    await page.locator('#pi-loaded-resources-body details').first().waitFor();
    assert.equal(commands.filter(c => c === 'reload_resources').length, 1);
    socket.send(JSON.stringify({ type: 'gateway_commands', commands: [] }));
    await page.waitForFunction(() => document.querySelector('#pi-loaded-resources-body').textContent.includes('资源已更新'));
    await page.locator('#pi-loaded-resources-refresh').click();
    await page.locator('#pi-loaded-resources-body details').first().waitFor();
    socket.send(JSON.stringify({ type: 'agent_start' }));
    await page.waitForFunction(() => document.querySelector('#pi-loaded-resources-reload').disabled);
    hold = true; await page.locator('#pi-loaded-resources-refresh').click();
    for (let i = 0; !delayed && i < 100; i++) await new Promise(r => setTimeout(r, 10)); assert.ok(delayed);
    await page.locator('#pi-close-inspector').click();
    if (width < 900) await page.locator('#pi-toggle-sessions').click();
    await page.locator('[data-filter="all"]').click();
    await page.locator('[data-session-id="second"] .pi-session-main').click();
    await page.waitForFunction(() => document.querySelector('#pi-meta-id').textContent === 'second');
    delayed(); await tick(page);
    assert.equal(await page.locator('#pi-loaded-resources-body').textContent(), '');
    assert.equal(await page.locator('#pi-loaded-resources').getAttribute('open'), null);
    assert.deepEqual(errors, []); console.log('PASS native context ' + width); await ctx.close();
}
(async () => { schema = nativeSchema(await import('@earendil-works/pi-coding-agent'), cwd); const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true }); try { for (const width of (process.env.PI_NATIVE_WIDTHS || '1440,393,320').split(',').map(Number)) { await settingsRun(browser, width); await contextRun(browser, width); } } finally { await browser.close(); } })().catch(e => { console.error(e); process.exitCode = 1; });
