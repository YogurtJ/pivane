// Synthetic shell contract test. No Pi identity, live server or model call is used.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const publicRoot = path.resolve(__dirname, '../../public');
const evidence = process.env.PI_SHELL_EVIDENCE || '/srv/pivane-maintenance/work/assistant-workspaces/evidence';
const cwd = '/fixture/assistant-work';
const profiles = [
    { id: '11111111-1111-4111-8111-111111111111', name: 'Research', enabled: true, avatar: { kind: 'emoji', value: '✦' } },
    { id: '22222222-2222-4222-8222-222222222222', name: 'Editor', enabled: true }
];
const groups = [
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Reference', cwd, description: '', instructions: '', profileIds: [profiles[0].id], archived: false },
    { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Drafts', cwd, description: '', instructions: '', profileIds: [profiles[0].id], archived: false },
    { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Editing', cwd, description: '', instructions: '', profileIds: [profiles[1].id], archived: false }
];
const thread = (id, profile, group) => ({ id, cwd, name: id, firstMessage: 'Synthetic message', messageCount: 1,
    modified: '2026-01-01T00:00:00Z', created: '2026-01-01T00:00:00Z', agentProfile: profile,
    assistantProject: group && { id: group.id, name: group.name, cwd, available: true } });
const sessions = [thread('agent-original', null, null), thread('reference-one', profiles[0], groups[0]),
    thread('draft-one', profiles[0], groups[1]), thread('old-bound', profiles[0], null), thread('editor-one', profiles[1], groups[2])];
const model = { provider: 'synthetic', id: 'visual', name: 'Visual fixture', input: ['text'] };
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' };

async function main() {
    await fs.mkdir(evidence, { recursive: true });
    const server = http.createServer(async (req, res) => {
        const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        const file = path.resolve(publicRoot, `.${name === '/' ? '/index.html' : name}`);
        if (!file.startsWith(publicRoot + path.sep)) { res.writeHead(403).end(); return; }
        try { const body = await fs.readFile(file); res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }).end(body); }
        catch { res.writeHead(404).end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
    const result = [];
    try {
        for (const width of [1280, 1440, 1920, 393, 320]) {
            const context = await browser.newContext({ viewport: { width, height: width < 700 ? 852 : 900 }, locale: 'en-US', isMobile: width < 700, hasTouch: width < 700 });
            const page = await context.newPage(), errors = [], writes = [], sockets = [], rpc = [];
            let closedSockets = 0;
            let holdProfile = false, releaseProfile;
            page.on('pageerror', error => errors.push(error.message));
            await page.addInitScript(data => {
                localStorage.setItem('pi.web.cwd', data.cwd);
                if (!localStorage.getItem(`pi.web.session:${data.cwd}`)) localStorage.setItem(`pi.web.session:${data.cwd}`, 'agent-original');
            }, { cwd });
            await page.route('**/pi-agent-profiles.js', route => route.fulfill({ contentType: 'text/javascript', body: `window.PiAgentProfiles={create:()=>({setEnabled(){},open(options){window.__profileOpenOptions=options;document.querySelector('#pi-profiles-content').textContent='Synthetic profiles';},close(){},displaySession(){},setLoadedProfile(){},projectChanged(){}})};` }));
            await page.route('**/pi-extensions.js', route => route.fulfill({ contentType: 'text/javascript', body: `window.PiExtensions={connect(){},setView(tab){document.querySelector('#workspace-settings-title').textContent=tab==='extensions'?'Extensions':'Settings';},setAssistantEnabled(){},mountExplore(){}};document.addEventListener('DOMContentLoaded',()=>{const p=document.createElement('section');p.className='workspace-settings-panel';p.dataset.settingsPanel='extensions';p.textContent='Synthetic extensions';document.querySelector('.workspace-settings-content').prepend(p)});` }));
            await page.route('**/api/**', async route => {
                const request = route.request(), url = new URL(request.url()), pathname = url.pathname;
                if (request.method() !== 'GET') {
                    const body = request.postDataJSON(); writes.push({ pathname, body });
                    if (pathname === '/api/pi/sessions') {
                        const created = thread('created-' + writes.length, body.profileId ? profiles.find(p => p.id === body.profileId) : null, groups.find(g => g.id === body.assistantProjectId));
                        sessions.unshift(created); return route.fulfill({ json: created });
                    }
                    if (pathname === '/api/pi/assistant-projects') {
                        const index = groups.findIndex(group => group.id === body.project.id);
                        if (index < 0) throw new Error('Fixture expected existing logical project');
                        groups[index] = { ...groups[index], ...body.project };
                        return route.fulfill({ json: { ok: true, revision: 'projects-2', project: groups[index] } });
                    }
                    return route.fulfill({ json: { ok: true } });
                }
                if (pathname === '/api/pi/status') return route.fulfill({ json: { ok: true, agentProfiles: true, assistantProjects: true, projectRoots: ['/fixture'], defaultProject: cwd } });
                if (pathname === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd, name: 'Assistant work', sessionCount: sessions.length }], roots: ['/fixture'] } });
                if (pathname === '/api/pi/profiles') return route.fulfill({ json: { version: 1, revision: 'profiles-1', profiles } });
                if (pathname === '/api/pi/assistant-projects') {
                    const selected = url.searchParams.get('profileId');
                    if (holdProfile && selected === profiles[0].id) await new Promise(resolve => { releaseProfile = resolve; });
                    return route.fulfill({ json: { version: 1, revision: 'projects-1', projects: groups.filter(g => g.profileIds.includes(selected)) } });
                }
                if (/^\/api\/pi\/assistant-projects\/[^/]+\/sessions$/.test(pathname)) return route.fulfill({ json: { sessions: sessions.filter(s => s.assistantProject?.id === pathname.split('/')[4] && s.agentProfile?.id === url.searchParams.get('profileId')) } });
                if (pathname === '/api/pi/sessions') return route.fulfill({ json: { sessions } });
                if (pathname === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] } });
                if (pathname.startsWith('/api/pi/')) return route.fulfill({ json: {} });
                return route.fulfill({ json: [] });
            });
            await page.routeWebSocket('**/api/pi/ws', ws => {
                sockets.push(ws);
                ws.onClose(() => { closedSockets++; });
                ws.onMessage(raw => {
                    const command = JSON.parse(raw);
                    rpc.push(command.type);
                    const selected = sessions.find(s => s.id === command.sessionId) || sessions[0];
                    const data = command.type === 'open_session' ? { session: selected,
                        state: { model, isStreaming: selected.id === 'agent-original', thinkingLevel: 'off' },
                        messages: { messages: selected.id === 'reference-one' ? [{ role: 'user', timestamp: 1, content: [{ type: 'text', text: 'Archived fixture message visible' }] }] : [] }, stats: {},
                        models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } }
                        : command.type === 'get_state' ? { model, isStreaming: false, thinkingLevel: 'off' } : {};
                    ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
                });
            });
            await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => document.querySelector('#pi-input')?.disabled === false);
            await page.locator('#pi-input').fill('Unsent synthetic draft');
            await page.locator('#pi-file-input').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('Fixture attachment') });
            await page.waitForFunction(() => document.querySelectorAll('#pi-attachments .pi-attachment-chip').length === 1 && document.querySelector('#pi-attachments').getAttribute('aria-busy') === 'false');
            assert.equal(await page.locator('#pi-stop-button').isVisible(), true);
            if (width < 700) {
                await page.locator('#workspace-settings-toggle').click();
                assert.equal(await page.locator('#workspace-settings-dialog').isVisible(), true);
                await page.locator('#workspace-settings-close').click();
            } else {
                await page.locator('#workspace-profiles-toggle').click();
                assert.match(page.url(), /#\/profiles/);
                await page.locator('#workspace-settings-close').click();
                assert.match(page.url(), /#\/chat/);
            }
            assert.equal(await page.locator('#pi-input').inputValue(), 'Unsent synthetic draft');
            assert.equal(await page.locator('#pi-attachments .pi-attachment-chip').count(), 1);
            assert.equal(await page.locator('#pi-stop-button').isVisible(), true);
            assert.equal(closedSockets, 0, 'page routing keeps the current worker socket');
            assert.equal(await page.locator('#pi-actual-identity').isVisible(), false);
            await page.locator('#workspace-assistant-toggle').click();
            await page.waitForFunction(() => document.querySelectorAll('[data-assistant-project-id]').length === 3);
            assert.deepEqual(await page.locator('[data-assistant-project-id]').evaluateAll(nodes => nodes.map(n => n.dataset.assistantProjectId)), [groups[0].id, groups[1].id, `unclassified:${cwd}`]);
            assert.equal(await page.locator('[data-assistant-project-id]').first().locator('[data-session-id]').count(), 1);
            assert.equal(await page.locator('[data-assistant-project-id]').nth(1).locator('[data-session-id]').count(), 1);
            if (width === 1280) {
                await page.evaluate(({ cwd, profileId }) => window.dispatchEvent(new CustomEvent('workspace:open-settings', { detail: {
                    tab: 'profiles', profileId, section: 'soul', authoringSession: { cwd, id: 'synthetic-helper' }
                } })), { cwd, profileId: profiles[0].id });
                assert.match(page.url(), /#\/profiles\?/);
                assert.deepEqual(await page.evaluate(() => window.__profileOpenOptions), { profileId: profiles[0].id, section: 'soul', authoringSession: { id: 'synthetic-helper', cwd } });
                await page.locator('#workspace-settings-close').click();
                assert.match(page.url(), /#\/assistant/);
                await page.locator('#workspace-extensions-toggle').click();
                assert.equal(await page.locator('#workspace-settings-dialog').isVisible(), true);
                await page.locator('#workspace-settings-close').click();
                await page.waitForFunction(() => document.querySelectorAll('[data-assistant-project-id]').length === 3);
            }
            const shell = await page.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth,
                nav: document.querySelector('.sidebar').getBoundingClientRect().width,
                pane: document.querySelector('#pi-session-pane').getBoundingClientRect().width,
                transcript: document.querySelector('.pi-transcript-shell').getBoundingClientRect().width }));
            assert.ok(shell.body <= width + 1, JSON.stringify(shell));
            if (width >= 1200) { assert.ok(shell.nav >= 175 && shell.nav <= 195, JSON.stringify(shell)); assert.ok(shell.pane >= 232 && shell.pane <= 440, JSON.stringify(shell)); assert.ok(shell.transcript > 300, JSON.stringify(shell)); }
            await page.screenshot({ path: path.join(evidence, `shell-assistant-${width}.png`) });
            if (width === 1440) {
                for (const theme of ['mint', 'dark']) {
                    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
                    await page.screenshot({ path: path.join(evidence, `shell-assistant-1440-${theme}.png`) });
                }
                await page.evaluate(() => { document.documentElement.dataset.theme = 'daylight'; });
            }
            if (width >= 1200) {
                await page.locator('#pi-assistant-profile').selectOption(profiles[1].id);
                await page.waitForFunction(() => document.querySelectorAll('[data-assistant-project-id]').length === 1);
                assert.equal(await page.locator('[data-assistant-project-id]').first().getAttribute('data-assistant-project-id'), groups[2].id);
                await page.locator('[data-assistant-project-id] [data-assistant-action="menu"]').click();
                assert.equal(await page.locator('.pi-thread-menu:not(.hidden)').getByRole('menuitem', { name: /Temporary conversation/ }).count(), 1);
                await page.keyboard.press('Escape');
                await page.locator('#pi-new-session').click();
                await page.waitForFunction(() => document.querySelector('.pi-session-item.active')?.dataset.sessionId.startsWith('created-'));
                assert.deepEqual(writes.at(-1).body, { cwd, profileId: profiles[1].id, assistantProjectId: groups[2].id });
                assert.equal(await page.locator('#pi-actual-identity').isVisible(), true);
                assert.match(await page.locator('#pi-composer-identity').innerText(), /Editor/);
                await page.screenshot({ path: path.join(evidence, `shell-bound-${width}.png`) });
                holdProfile = true;
                await page.locator('#pi-assistant-profile').selectOption(profiles[0].id);
                for (let i = 0; !releaseProfile && i < 100; i++) await page.waitForTimeout(10);
                assert.ok(releaseProfile, 'first profile request is held');
                await page.locator('#pi-assistant-profile').selectOption(profiles[1].id);
                await page.waitForFunction(id => document.querySelector('#pi-assistant-profile').value === id && document.querySelectorAll('[data-assistant-project-id]').length === 1, profiles[1].id);
                holdProfile = false; releaseProfile(); releaseProfile = null;
                await page.waitForTimeout(100);
                assert.equal(await page.locator('[data-assistant-project-id]').first().getAttribute('data-assistant-project-id'), groups[2].id, 'late profile response cannot replace selection');
                await page.locator('#workspace-profiles-toggle').click();
                await page.screenshot({ path: path.join(evidence, `shell-profiles-${width}.png`) });
                await page.locator('#workspace-settings-close').click();
                assert.match(page.url(), /#\/assistant\?/);
                await page.goBack();
                assert.match(page.url(), /#\/profiles/);
                await page.goForward();
                await page.waitForFunction(id => document.querySelector('#pi-assistant-profile')?.value === id && document.querySelectorAll('[data-assistant-project-id]').length === 1, profiles[1].id);
                await page.locator('[data-tab="chat"]').click();
                await page.locator('#pi-new-session').click();
                for (let i = 0; writes.length < 2 && i < 100; i++) await page.waitForTimeout(10);
                assert.equal(writes.length, 2, 'Agent creates a second session');
                await page.waitForFunction(() => document.querySelector('#pi-meta-id')?.textContent === 'created-2' && document.querySelector('#pi-input')?.disabled === false);
                assert.deepEqual(writes.at(-1).body, { cwd, profileId: null });
                const helperId = `helper-${width}`;
                sessions.push(thread(helperId, null, null));
                await page.evaluate(({ cwd, helperId }) => window.PiChatNavigation.openSession({ cwd, sessionId: helperId, draft: 'Visible helper draft' }), { cwd, helperId });
                assert.equal(await page.locator('#pi-input').inputValue(), 'Visible helper draft');
                assert.equal(rpc.includes('prompt'), false, 'navigation does not send a model request');
                const refused = await page.evaluate(({ cwd, helperId }) => window.PiChatNavigation.openSession({ cwd, sessionId: helperId, draft: 'Replacement' }).then(() => '', error => error.message), { cwd, helperId });
                assert.match(refused, /draft|草稿/i);
                assert.equal(await page.locator('#pi-input').inputValue(), 'Visible helper draft');
                assert.ok(sockets.length >= 1);
                await page.goto(`http://127.0.0.1:${server.address().port}/?direct=1#/profiles`, { waitUntil: 'domcontentloaded' });
                await page.waitForFunction(() => document.querySelector('#pi-input')?.disabled === false);
                assert.match(page.url(), /#\/profiles$/, 'session restoration must not leave a direct management URL');
                assert.equal(await page.locator('#workspace-settings-dialog').isVisible(), true);
                await page.locator('#workspace-settings-close').click();
                assert.match(page.url(), new RegExp(`sessionId=${helperId}`));
                await page.goto(`http://127.0.0.1:${server.address().port}/?direct=2#/assistant?profileId=${profiles[0].id}&projectId=${groups[1].id}&sessionId=draft-one`, { waitUntil: 'domcontentloaded' });
                await page.waitForFunction(() => document.querySelector('#pi-meta-id')?.textContent === 'draft-one' && document.querySelector('#pi-input')?.disabled === false);
                assert.equal(await page.locator('[data-assistant-project-id].current').getAttribute('data-assistant-project-id'), groups[1].id);
                assert.match(page.url(), /sessionId=draft-one/);
                if (width === 1920) {
                    groups[0].archived = true;
                    await page.locator('#pi-refresh-sessions').click();
                    await page.locator('[data-archive-kind="assistant-projects"] summary').waitFor();
                    await page.locator('[data-archive-kind="assistant-projects"] summary').click();
                    const archived = page.locator(`[data-assistant-project-id="${groups[0].id}"]`);
                    assert.equal(await archived.locator('[data-session-id="reference-one"]').count(), 1, 'archived group retains its native thread');
                    assert.equal(await page.locator(`[data-assistant-project-id="${groups[1].id}"] [data-session-id="reference-one"]`).count(), 0, 'shared cwd does not duplicate group membership');
                    assert.equal(await page.locator('[data-session-id="reference-one"]').count(), 1);
                    await page.locator('#pi-input').fill('Draft in active group');
                    await archived.locator('[data-session-id="reference-one"] .pi-session-main').click();
                    await page.waitForFunction(() => document.querySelector('#pi-meta-id')?.textContent === 'reference-one' && document.querySelector('#pi-input')?.disabled === false);
                    assert.match(await page.locator('#pi-transcript-content').innerText(), /Archived fixture message visible/);
                    assert.match(await page.locator('#pi-actual-identity').innerText(), /Research/);
                    assert.equal(await page.locator('#pi-new-session').isDisabled(), true, 'archived group cannot create a new grouped thread');
                    await page.screenshot({ path: path.join(evidence, 'shell-archived-open-1920.png') });
                    const writesBefore = writes.length;
                    await page.locator('#pi-new-session').evaluate(button => button.click());
                    assert.equal(writes.length, writesBefore, 'disabled new control does not POST');
                    await page.locator('#pi-input').fill('Draft in archived thread');
                    await page.locator(`[data-assistant-project-id="${groups[1].id}"] [data-session-id="draft-one"] .pi-session-main`).click();
                    await page.waitForFunction(() => document.querySelector('#pi-meta-id')?.textContent === 'draft-one' && document.querySelector('#pi-input')?.disabled === false);
                    assert.equal(await page.locator('#pi-input').inputValue(), 'Draft in active group');
                    await archived.locator('[data-session-id="reference-one"] .pi-session-main').click();
                    await page.waitForFunction(() => document.querySelector('#pi-meta-id')?.textContent === 'reference-one' && document.querySelector('#pi-input')?.disabled === false);
                    assert.equal(await page.locator('#pi-input').inputValue(), 'Draft in archived thread');
                    await page.locator(`[data-assistant-project-id="${groups[0].id}"] [data-assistant-action="menu"]`).click();
                    assert.equal(await page.locator('.pi-thread-menu:not(.hidden)').getByRole('menuitem', { name: /New conversation|New thread/ }).count(), 0);
                    await page.locator('.pi-thread-menu:not(.hidden)').getByRole('menuitem', { name: /Edit project/ }).click();
                    assert.equal(await page.locator('.pi-assistant-project-form [name=archived]').isChecked(), true);
                    await page.locator('.pi-assistant-project-form [name=archived]').uncheck();
                    await page.locator('.pi-assistant-project-form [type=submit]').click();
                    await page.waitForFunction(id => document.querySelector(`[data-assistant-project-id="${id}"]:not(.archived)`), groups[0].id);
                    assert.equal(groups[0].archived, false);
                }
            } else {
                await page.locator('#pi-toggle-sessions').click();
                await page.waitForFunction(() => document.querySelector('#pi-session-pane').classList.contains('open') && document.querySelector('#pi-session-pane').getBoundingClientRect().left >= -1);
                await page.screenshot({ path: path.join(evidence, `shell-drawer-${width}.png`) });
            }
            assert.deepEqual(errors, [], `${width}: ${errors.join(' | ')}`);
            result.push({ width, shell, errors, writes: writes.length, screenshot: path.join(evidence, `shell-assistant-${width}.png`) });
            await context.close();
        }
        console.log(JSON.stringify(result));
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
