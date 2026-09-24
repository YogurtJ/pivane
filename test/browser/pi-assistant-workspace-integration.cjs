// Run against this checkout, or set PIVANE_TEST_SOURCE_ROOT to a frozen assembled checkout.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

const sourceRoot = fs.realpathSync.native(process.env.PIVANE_TEST_SOURCE_ROOT || path.resolve(__dirname, '../..'));
const screenshots = path.resolve(process.env.PIVANE_TEST_SCREENSHOT_DIR || path.join(os.tmpdir(), 'pivane-assistant-browser'));
const bundle = process.env.PIVANE_TEST_HERMES_BUNDLE;
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const sourceRequire = createRequire(path.join(sourceRoot, 'package.json'));
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();

async function main() {
    if (!bundle || !fs.existsSync(bundle)) throw new Error('PIVANE_TEST_HERMES_BUNDLE must point to the reviewed read-only bundle');
    // Before constructing Pi services, remove inherited identities and provider credentials.
    for (const key of Object.keys(process.env)) if (/^(?:PI_|PIVANE_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|OPENROUTER_|AZURE_OPENAI_|AWS_|BEDROCK_|MISTRAL_|GROQ_|XAI_|DEEPSEEK_)/.test(key)) delete process.env[key];
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-assistant-browser-')));
    let provider, access, gateway, server, wss, browser;
    try {
    const agentDir = path.join(root, 'agent'), cwd = path.join(root, 'work');
    fs.mkdirSync(path.join(agentDir, 'pivane-profiles'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(screenshots, { recursive: true });
    Object.assign(process.env, { PI_CODING_AGENT_DIR: agentDir, PI_PROJECT_ROOTS: root,
        PI_WEB_DEFERRED_FILE: path.join(root, 'deferred.json'), PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_WEB_TOKEN: '' });
    const express = sourceRequire('express');
    const { createPiAgentGateway } = sourceRequire('./server/pi-agent-routes.js');
    const { WorkspaceAccessService } = sourceRequire('./server/workspace-access-service.js');
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const calls = [];
    const base = () => `http://127.0.0.1:${server.address().port}`;
    const api = async (method, suffix, body) => {
        const response = await fetch(`${base()}/api/pi${suffix}`, { method,
            headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        const data = await response.json();
        assert.ok(response.ok, `${method} ${suffix}: HTTP ${response.status}: ${JSON.stringify(data)}`);
        return data;
    };
    const captures = [], issues = [];
    const screenshot = async (page, name) => {
        const file = path.join(screenshots, `${name}.png`);
        await page.screenshot({ path: file, fullPage: true }); captures.push(file);
    };
    const open = async (width, locale, theme, route = '#/chat') => {
        const context = await browser.newContext({ viewport: { width, height: width < 900 ? 852 : 920 }, locale,
            isMobile: width < 900, hasTouch: width < 900 });
        await context.addInitScript(({ cwd, locale, theme }) => {
            localStorage.setItem('pi.web.cwd', cwd);
            localStorage.setItem('pi.workspace.language', locale);
            localStorage.setItem('pi.workspace.theme', theme);
            Object.defineProperty(window.crypto, 'subtle', { configurable: true, value: undefined });
        }, { cwd, locale, theme });
        const page = await context.newPage(), errors = [], snapshots = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('websocket', socket => socket.on('framereceived', frame => {
            try {
                const data = JSON.parse(frame.payload.toString());
                if (data.command === 'open_session' && data.success) snapshots.push({ id: data.data?.session?.id,
                    profileAuthoring: data.data?.session?.profileAuthoring ?? null });
            } catch { /* Other native frames are not snapshot responses. */ }
        }));
        await page.route('**/*', request => {
            if (new URL(request.request().url()).origin === base()) return request.continue();
            return request.abort();
        });
        await page.goto(base() + '/' + route, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.PiWorkspaceRoute && window.PiChatNavigation && window.PiAgentProfiles && window.PiExtensions);
        await page.waitForFunction(() => !document.querySelector('#pi-project-button')?.disabled);
        if (await page.locator('#pi-project-dialog').isVisible()) {
            await page.locator('#pi-project-input').fill(cwd);
            await page.locator('#pi-project-form [type=submit]').click();
            await page.locator('#pi-project-dialog').waitFor({ state: 'hidden' });
        }
        assert.equal(await page.evaluate(() => crypto.subtle), undefined, 'Crypto.subtle must be absent in the test page');
        assert.equal(await page.locator('html').getAttribute('lang'), locale);
        assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
        return { page, context, errors, snapshots };
    };
        provider = http.createServer(async (req, res) => {
            let text = ''; for await (const part of req) text += part;
            const body = JSON.parse(text); calls.push(body);
            const last = body.messages?.at(-1);
            const proposal = { name: 'Fixture Reviewed', description: 'Suggested by synthetic model',
                soul: 'Ask before changing saved facts.', user: 'Verified user fact', memory: 'Verified shared fact' };
            const useTool = last?.role === 'user' && JSON.stringify(last.content).includes('PROFILE_DRAFT_FIXTURE');
            const delta = useTool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call-profile-draft-fixture', type: 'function',
                function: { name: 'profile_draft', arguments: JSON.stringify(proposal) } }] }
                : { role: 'assistant', content: 'Synthetic drafting response.' };
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(`data: ${JSON.stringify({ id: 'assistant-fixture', object: 'chat.completion.chunk', model: 'fixture',
                choices: [{ index: 0, delta, finish_reason: useTool ? 'tool_calls' : 'stop' }] })}\n\n`);
            res.end('data: [DONE]\n\n');
        });
        provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
        fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture',
            defaultProjectTrust: 'never', enableInstallTelemetry: false, compaction: { enabled: false } }));
        fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: {
            api: 'openai-completions', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'synthetic',
            models: [{ id: 'fixture', name: 'Local fixture', input: ['text'], contextWindow: 32000, maxTokens: 1000,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
        fs.writeFileSync(path.join(agentDir, 'pivane-profiles', 'runtime.json'), JSON.stringify({ version: 1, bundlePath: bundle }));
        access = new WorkspaceAccessService({ envToken: () => '' });
        gateway = createPiAgentGateway({ accessService: access, deferredFilePath: process.env.PI_WEB_DEFERRED_FILE });
        const app = express(); access.mount(app); app.use(express.json({ limit: '32mb' })); gateway.mount(app);
        for (const [url, dir] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']])
            app.use(`/vendor/${url}`, express.static(path.join(sourceRoot, 'node_modules', dir)));
        app.use(express.static(path.join(sourceRoot, 'public')));
        server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
        wss = gateway.attachWebSocket(server);
        browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });

        const desktop = await open(1440, 'en', 'dark');
        const { page } = desktop;
        await page.locator('#workspace-profiles-toggle').click();
        await page.locator('#pi-profiles-list .pi-profile-note').waitFor();
        assert.equal((await api('GET', '/profiles')).profiles.length, 0);
        await page.locator('#pi-profile-add').click();
        await page.locator('#pi-profile-form [name=name]').fill('Fixture Guide');
        await page.locator('#pi-profile-form [name=description]').fill('Manual fixture profile');
        await page.locator('#pi-profile-form [name=userCharLimit]').fill('512');
        await page.locator('#pi-profile-form [name=memoryEnabled]').check();
        await page.locator('#pi-profile-form button[type=submit]').click();
        const firstProfile = await api('GET', '/profiles');
        await page.waitForFunction(() => document.querySelectorAll('[data-profile-id]').length === 1);
        assert.equal(firstProfile.profiles.length, 1);
        const profileId = firstProfile.profiles[0].id;
        assert.match(firstProfile.profileRevisions[profileId], /^[a-f0-9]{64}$/);
        await page.locator('#pi-profile-form [name=description]').fill('Edited with unavailable crypto.subtle');
        await page.locator('#pi-profile-form button[type=submit]').click();
        await page.waitForFunction(() => document.querySelector('#pi-profile-form [name=description]')?.value === 'Edited with unavailable crypto.subtle'
            && !document.querySelector('#pi-profile-form button[type=submit]')?.disabled);
        const edited = await api('GET', '/profiles');
        assert.equal(edited.profiles[0].description, 'Edited with unavailable crypto.subtle');
        assert.notEqual(edited.profileRevisions[profileId], firstProfile.profileRevisions[profileId]);
        // Real file chooser: the browser transcodes this PNG before calling the avatar route.
        const png = Buffer.from(await page.evaluate(() => {
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2;
            canvas.getContext('2d').fillRect(0, 0, 2, 2);
            return canvas.toDataURL('image/png').split(',')[1];
        }), 'base64');
        await page.locator('#pi-profile-avatar-upload').setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: png });
        try { await page.waitForFunction(() => Boolean(document.querySelector('.pi-profile-row img')), null, { timeout: 10000 }); }
        catch (error) {
            console.error(JSON.stringify({ stage: 'avatar', profileStatus: await page.locator('#pi-profiles-status').innerText(),
                editorStatus: await page.locator('#pi-profile-editor-status').innerText(), errors: desktop.errors }));
            await screenshot(page, 'avatar-failure-1440-en-dark'); throw error;
        }
        const avatar = (await api('GET', '/profiles')).profiles[0].avatar;
        assert.equal(avatar.kind, 'image');
        const avatarResponse = await fetch(`${base()}/api/pi/profiles/${profileId}/avatar?version=${avatar.version}`);
        assert.equal(avatarResponse.status, 200);
        assert.equal(avatarResponse.headers.get('content-type'), 'image/png');

        await page.locator('[data-profile-section=user]').click();
        await page.locator('#pi-profile-document-text:not([disabled])').waitFor();
        assert.match(await page.locator('#pi-profile-document-usage').innerText(), /512/);
        await page.locator('#pi-profile-document-text').fill('Synthetic verified user fact');
        let injected = false;
        const unlink = fs.unlinkSync;
        fs.unlinkSync = function (file, ...args) {
            if (!injected && typeof file === 'string' && file.endsWith('.pivane-memory-index-user.pending')) {
                injected = true; throw new Error('Synthetic index finalization failure');
            }
            return unlink.call(fs, file, ...args);
        };
        let partial;
        try {
            [partial] = await Promise.all([
                page.waitForResponse(res => res.url().endsWith(`/profiles/${profileId}/documents`) && res.request().method() === 'PUT'),
                page.locator('#pi-profile-document-save').click()
            ]);
        } finally { fs.unlinkSync = unlink; }
        assert.equal(injected, true);
        assert.equal(partial.status(), 503);
        const partialBody = await partial.json();
        assert.deepEqual([partialBody.documentSaved, partialBody.indexSynced, partialBody.indexStatus], [true, false, 'pending']);
        await page.locator('#pi-profile-document-sync:visible').waitFor();
        await page.locator('#pi-profile-document-sync').click();
        await page.waitForFunction(() => document.querySelector('#pi-profile-document-sync')?.hidden === true,
            null, { timeout: 2500 }).catch(() => {});
        if (!await page.locator('#pi-profile-document-sync').evaluate(button => button.hidden)) {
            issues.push('USER index sync button did not dispatch PUT: document button is in #pi-profile-documents, but pi-agent-profiles.js listens for it on sibling #pi-profiles-editor');
            await screenshot(page, 'document-sync-failure-1440-en-dark');
            const pending = await api('GET', `/profiles/${profileId}/documents?target=user`);
            assert.equal(pending.indexStatus, 'pending');
            // Repair this synthetic fixture through the real endpoint to reach later browser checks.
            await api('PUT', `/profiles/${profileId}/documents`, { target: 'user', content: pending.content,
                expectedRevision: pending.revision, expectedProfileRevision: pending.profileRevision });
        }
        const savedUser = await api('GET', `/profiles/${profileId}/documents?target=user`);
        assert.equal(savedUser.content, 'Synthetic verified user fact');
        assert.equal(savedUser.indexSynced, true);
        assert.equal(savedUser.usage.limit, 512);

        await page.locator('#workspace-assistant-toggle').click();
        await page.locator('#pi-assistant-profile').selectOption(profileId);
        for (const name of ['Fixture Alpha', 'Fixture Beta']) {
            await page.locator('#pi-assistant-add-project').click();
            const dialog = page.locator('.pi-assistant-project-editor[open]');
            await dialog.locator('[name=name]').fill(name);
            await dialog.locator('[name=cwd]').fill(cwd);
            await dialog.locator('[name=instructions]').fill(`Synthetic instructions for ${name}`);
            await dialog.locator('[type=submit]').click();
            await dialog.waitFor({ state: 'hidden' });
            await page.locator('.pi-assistant-group').filter({ hasText: name }).waitFor();
        }
        const groups = (await api('GET', `/assistant-projects?profileId=${profileId}`)).projects;
        assert.equal(groups.length, 2);
        assert.equal(groups[0].cwd, groups[1].cwd);
        const groupSessions = [];
        for (const group of groups) {
            await page.locator(`.pi-assistant-group[data-assistant-project-id="${group.id}"] [data-assistant-action=select]`).click();
            await page.locator('#pi-new-session').click();
            try { await page.waitForFunction(id => location.hash.includes('sessionId=')
                && document.querySelector('#pi-session-profile')?.textContent.includes('Fixture Guide')
                && document.querySelector(`.pi-assistant-group[data-assistant-project-id="${id}"] [data-session-id]`), group.id, { timeout: 10000 }); }
            catch (error) {
                console.error(JSON.stringify({ stage: 'group-session', name: group.name, hash: await page.evaluate(() => location.hash),
                    badge: await page.locator('#pi-session-profile').innerText(), toast: await page.locator('#toast-region').allInnerTexts().catch(() => []),
                    sessions: (await api('GET', `/assistant-projects/${group.id}/sessions?profileId=${profileId}`)).sessions.length,
                    pageerrors: desktop.errors }));
                await screenshot(page, 'group-session-failure-1440-en-dark'); throw error;
            }
            const sessions = (await api('GET', `/assistant-projects/${group.id}/sessions?profileId=${profileId}`)).sessions;
            assert.equal(sessions.length, 1);
            assert.equal(sessions[0].assistantProject.id, group.id);
            assert.equal(sessions[0].agentProfile.id, profileId);
            await page.locator('#pi-actual-identity img').waitFor();
            await page.locator('#pi-composer-identity img').waitFor();
            groupSessions.push(sessions[0]);
            await page.locator('#pi-input:not([disabled])').waitFor();
            await page.locator('#pi-new-session:not([disabled])').waitFor();
        }
        assert.notEqual(groupSessions[0].id, groupSessions[1].id);
        const first = page.locator(`.pi-assistant-group[data-assistant-project-id="${groups[0].id}"] [data-session-id="${groupSessions[0].id}"]`);
        await first.click();
        await page.locator('#pi-input').fill('Draft retained through navigation');
        await page.locator('#pi-file-input').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic attachment') });
        await page.locator('#pi-attachments .pi-attachment-chip').waitFor();
        await page.locator('#pi-refresh-sessions').click();
        await page.locator('#workspace-profiles-toggle').click();
        await page.goBack();
        await page.waitForFunction(() => location.hash.startsWith('#/assistant'));
        assert.equal(await page.locator('#pi-input').inputValue(), 'Draft retained through navigation');
        assert.equal(await page.locator('#pi-attachments .pi-attachment-chip').count(), 1);
        await page.goForward();
        await page.goBack();
        assert.equal(await page.locator('#pi-attachments .pi-attachment-chip').count(), 1);
        await page.waitForFunction(() => document.querySelectorAll('.pi-assistant-group').length === 2
            && !document.querySelector('#pi-assistant-profile-status')?.textContent.trim());
        await screenshot(page, 'assistant-1440-en-dark');

        await page.locator('.nav-btn[data-tab=chat]').click();
        await page.locator('#pi-new-session').click();
        await page.waitForFunction(() => location.hash.startsWith('#/chat') && location.hash.includes('sessionId='));
        const plainId = new URLSearchParams(page.url().split('?')[1]).get('sessionId');
        const plain = await gateway.store.getSession(cwd, plainId);
        assert.equal(plain.agentProfile, null);
        assert.equal(plain.assistantProject, null);
        assert.equal(await page.locator('#pi-session-profile').innerText(), 'No profile');

        await page.locator('#workspace-profiles-toggle').click();
        await page.locator(`[data-profile-id="${profileId}"]`).click();
        await page.locator('#pi-profile-form [name=description]').fill('User-owned unsaved description');
        await page.locator('#pi-profile-form [data-profile-assist]').click();
        await page.waitForFunction(() => location.hash.startsWith('#/chat') && location.hash.includes('sessionId=')
            && document.querySelector('#pi-profile-authoring-return')?.hidden === false && document.querySelector('#pi-input')?.value.length > 0);
        const helperId = new URLSearchParams(page.url().split('?')[1]).get('sessionId');
        const helper = await gateway.store.getSession(cwd, helperId);
        assert.equal(helper.agentProfile, null);
        assert.equal(helper.profileAuthoring.profileId, profileId);
        const helperSnapshot = desktop.snapshots.find(frame => frame.id === helperId);
        assert.equal(helperSnapshot?.profileAuthoring?.profileId, profileId, 'initial real WS snapshot retains helper marker');
        const listedHelper = (await api('GET', `/sessions?cwd=${encodeURIComponent(cwd)}`)).sessions.find(row => row.id === helperId);
        assert.ok(listedHelper, 'real native session remains discoverable in the physical cwd');
        assert.equal((await api('GET', `/profiles/authoring-sessions/${helperId}/draft?cwd=${encodeURIComponent(cwd)}`)).status, 'missing');
        assert.equal(calls.length, 0, 'opening authoring conversation never calls the provider');
        assert.equal(SessionManager.open(helper.path).getEntries().some(e => e.type === 'message'), false);
        await page.locator('#pi-input').fill('PROFILE_DRAFT_FIXTURE: write a synthetic profile proposal with profile_draft.');
        await page.locator('#pi-send-button').click();
        await page.waitForFunction(async ({ cwd, id }) => {
            const response = await fetch(`/api/pi/profiles/authoring-sessions/${id}/draft?cwd=${encodeURIComponent(cwd)}`);
            return response.ok && (await response.json()).status === 'ready';
        }, { cwd, id: helperId }, { timeout: 25000 });
        await page.locator('#pi-transcript').getByText('Synthetic drafting response.', { exact: false }).waitFor({ timeout: 20000 });
        assert.ok(calls.length >= 2, 'real Pi RPC made a tool-call and final local SSE request');
        try { await page.locator('#pi-profile-authoring-return').click({ timeout: 4000 }); }
        catch (error) {
            issues.push('Profile authoring return button disappears after agent_settled: refresh in pi-chat.js replaces state.session with a /sessions list row lacking profileAuthoring');
            console.error(JSON.stringify({ stage: 'authoring-return', ui: await page.locator('#pi-profile-authoring-return').evaluate(node => ({
                hidden: node.hidden, display: getComputedStyle(node).display, rect: node.getBoundingClientRect().toJSON(),
                ancestor: node.parentElement?.outerHTML.slice(0, 500) })), hash: await page.evaluate(() => location.hash),
                wsMarker: Boolean(helperSnapshot?.profileAuthoring), listMarker: Boolean(listedHelper.profileAuthoring),
                errors: desktop.errors }));
            await screenshot(page, 'authoring-return-failure-1440-en-dark');
            // Exercise the same public event the hidden button would dispatch, without replacing any API.
            await page.evaluate(({ cwd, id, profileId }) => window.dispatchEvent(new CustomEvent('workspace:open-settings', {
                detail: { tab: 'profiles', profileId, authoringSession: { cwd, id } }
            })), { cwd, id: helperId, profileId });
        }
        await page.locator('#pi-profile-proposal-apply').waitFor();
        await page.locator('#pi-profile-proposal-apply').click();
        await page.waitForFunction(() => document.querySelector('#pi-profile-form [name=name]')?.value === 'Fixture Reviewed');
        assert.equal(await page.locator('#pi-profile-form [name=name]').inputValue(), 'Fixture Reviewed');
        assert.equal(await page.locator('#pi-profile-form [name=description]').inputValue(), 'User-owned unsaved description');
        assert.equal((await api('GET', '/profiles')).profiles[0].name, 'Fixture Guide', 'proposal must remain unsaved');
        await screenshot(page, 'authoring-review-1440-en-dark');
        assert.deepEqual(desktop.errors, []);
        await desktop.context.close();

        for (const [width, locale, theme] of [[1280, 'zh-CN', 'mint'], [393, 'zh-CN', 'dark'], [320, 'en', 'mint']]) {
            const view = await open(width, locale, theme, `#/assistant?profileId=${profileId}&projectId=${groups[0].id}&sessionId=${groupSessions[0].id}`);
            try {
                await view.page.locator('#pi-assistant-profile').waitFor();
                await view.page.waitForFunction(id => document.querySelector('#pi-assistant-profile')?.value === id, profileId);
                if (width === 1280) {
                    await view.page.reload({ waitUntil: 'domcontentloaded' });
                    await view.page.waitForFunction(({ id, sessionId }) => location.hash.includes(`sessionId=${sessionId}`)
                        && document.querySelector('#pi-assistant-profile')?.value === id, { id: profileId, sessionId: groupSessions[0].id });
                }
                if (width < 900) {
                    await view.page.locator('#pi-toggle-sessions').click();
                    await view.page.locator('.pi-assistant-group').first().waitFor();
                    await view.page.waitForFunction(() => {
                        const pane = document.querySelector('#pi-session-pane');
                        return pane.classList.contains('open') && pane.getBoundingClientRect().left >= -1;
                    });
                    const drawer = await view.page.locator('#pi-session-pane').evaluate(node => node.getBoundingClientRect().toJSON());
                    assert.ok(drawer.right <= width + 1, `mobile drawer outside viewport: ${JSON.stringify(drawer)}`);
                }
                await screenshot(view.page, `assistant-${width}-${locale}-${theme}`);
                const overflow = await view.page.evaluate(() => ({ viewport: innerWidth,
                    document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
                assert.ok(overflow.document <= overflow.viewport + 1 && overflow.body <= overflow.viewport + 1,
                    `horizontal overflow: ${JSON.stringify(overflow)}`);
                assert.deepEqual(view.errors, [], `pageerror at ${width}/${locale}/${theme}`);
            } finally { await view.context.close(); }
        }
        console.log(JSON.stringify({ status: issues.length ? 'failed' : 'passed', sourceSha, screenshots: captures,
            localProviderCalls: calls.length, projects: groups.length, profileRevisions: true,
            partialDocumentRepair: true, helperDraftReview: true, issues }));
        assert.deepEqual(issues, [], 'Frozen-source assistant integration defects');
    } finally {
        if (browser) await browser.close();
        for (const socket of wss?.clients || []) socket.terminate();
        if (gateway) await gateway.dispose();
        access?.dispose();
        if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch(error => { console.error(JSON.stringify({ status: 'failed', sourceSha, error: error.stack || String(error) })); process.exitCode = 1; });
