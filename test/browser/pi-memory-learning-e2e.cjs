// End-to-end rehearsal of the profile "remember -> correct -> use" loop against the real
// assembled gateway, a real isolated Hermes bundle, real Pi RPC workers and a local synthetic
// provider. Uses a throwaway identity; never touches a real agent directory or provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { createRequire } = require('node:module');

const sourceRoot = fs.realpathSync.native(process.env.PIVANE_TEST_SOURCE_ROOT || path.resolve(__dirname, '../..'));
const screenshots = path.resolve(process.env.PIVANE_TEST_SCREENSHOT_DIR || path.join(os.tmpdir(), 'pivane-memory-learning-e2e'));
const bundle = process.env.PIVANE_TEST_HERMES_BUNDLE;
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const sourceRequire = createRequire(path.join(sourceRoot, 'package.json'));

const PREFERENCE = '以后默认用 pnpm 安装依赖，不要用 npm。';
const LEARNED = '安装依赖默认使用 pnpm，不使用 npm。';
const TOOL_FACT = 'Synthetic service listens on port 4321.';
const MERGED = '用 pnpm 安装依赖，npm 会遇到 lockfile 冲突。';
// Synthetic credential assembled at runtime; the content scan must keep it out of every write path.
const SECRET = 'ghp_' + 'Z'.repeat(36);

async function main() {
    if (!bundle || !fs.existsSync(bundle)) throw new Error('PIVANE_TEST_HERMES_BUNDLE must point to the reviewed read-only bundle');
    for (const key of Object.keys(process.env)) if (/^(?:PI_|PIVANE_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|OPENROUTER_|AZURE_OPENAI_|AWS_|BEDROCK_|MISTRAL_|GROQ_|XAI_|DEEPSEEK_)/.test(key)) delete process.env[key];
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-memory-e2e-')));
    let provider, access, gateway, server, wss, browser;
    const report = { steps: [], findings: [] };
    const pages = [];
    const step = (name, detail) => { report.steps.push(detail === undefined ? name : { name, ...detail }); };
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

        const chat = [], learner = [];
        const sse = (res, delta, finish) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture',
                choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: finish }] })}\n\n`);
            res.end('data: [DONE]\n\n');
        };
        const toolCall = (name, args) => ({ tool_calls: [{ index: 0, id: `call-${name}-${chat.length}`, type: 'function',
            function: { name, arguments: JSON.stringify(args) } }] });
        provider = http.createServer(async (req, res) => {
            let text = ''; for await (const part of req) text += part;
            const body = JSON.parse(text);
            const raw = JSON.stringify(body.messages || []);
            if (body.model === 'learner') {
                learner.push({ tools: body.tools?.length || 0, raw });
                if (raw.includes('consolidate duplicate or overlapping')) {
                    // Merge the pnpm preference and the npm failure into one shorter record.
                    const offered = JSON.parse(body.messages.filter(m => m.role === 'user').at(-1).content);
                    const ids = offered.filter(row => /pnpm|lockfile/.test(row.content)).map(row => row.id);
                    return sse(res, { content: JSON.stringify({ groups: ids.length >= 2 ? [{ itemIds: ids, content: MERGED, category: 'preference' }] : [] }) }, 'stop');
                }
                // An English correction whose learned text carries a credential must be refused by the scan.
                if (raw.includes('SECRET_LEARN_FIXTURE') && !raw.includes('consolidate')) return sse(res, { content: JSON.stringify({ content: `Deploy with token ${SECRET}.` }) }, 'stop');
                // Only the explicit preference is durable; anything else yields no proposal.
                return sse(res, { content: JSON.stringify(raw.includes('pnpm') && !raw.includes(LEARNED) ? { content: LEARNED } : {}) }, 'stop');
            }
            chat.push({ system: JSON.stringify(body.messages?.[0] || ''), last: body.messages?.at(-1) });
            const last = body.messages?.at(-1);
            if (last?.role === 'tool') return sse(res, { content: 'Tool step finished.' }, 'stop');
            const said = JSON.stringify(last?.content || '');
            if (said.includes('MEMORY_TOOL_FIXTURE')) return sse(res, toolCall('memory_add', { target: 'memory', content: TOOL_FACT }), 'tool_calls');
            if (said.includes('FAILURE_TOOL_FIXTURE')) return sse(res, toolCall('memory_add', { target: 'failure', category: 'failure',
                content: 'npm install failed with a lockfile conflict.' }), 'tool_calls');
            if (said.includes('SECRET_TOOL_FIXTURE')) return sse(res, toolCall('memory_add', { target: 'memory', content: `Deploy token is ${SECRET}` }), 'tool_calls');
            if (said.includes('SKILL_VIEW_FIXTURE')) return sse(res, toolCall('skill_manage', { action: 'view' }), 'tool_calls');
            return sse(res, { content: '好的，我记下了。' }, 'stop');
        });
        provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
        const model = (id, name) => ({ id, name, input: ['text'], contextWindow: 32000, maxTokens: 1000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
        fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture',
            defaultProjectTrust: 'never', enableInstallTelemetry: false, compaction: { enabled: false } }));
        fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: {
            api: 'openai-completions', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'synthetic',
            models: [model('fixture', 'Local chat fixture'), model('learner', 'Local learning fixture')] } } }));
        fs.writeFileSync(path.join(agentDir, 'pivane-profiles', 'runtime.json'), JSON.stringify({ version: 1, bundlePath: bundle, reviewModel: { provider: 'fixture', modelId: 'learner' } }));
        access = new WorkspaceAccessService({ envToken: () => '' });
        gateway = createPiAgentGateway({ accessService: access, deferredFilePath: process.env.PI_WEB_DEFERRED_FILE });
        const app = express(); access.mount(app); app.use(express.json({ limit: '32mb' })); gateway.mount(app);
        for (const [url, dir] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']])
            app.use(`/vendor/${url}`, express.static(path.join(sourceRoot, 'node_modules', dir)));
        app.use(express.static(path.join(sourceRoot, 'public')));
        server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
        wss = gateway.attachWebSocket(server);
        const base = () => `http://127.0.0.1:${server.address().port}`;
        const api = async (method, suffix, body) => {
            const response = await fetch(`${base()}/api/pi${suffix}`, { method, headers: { 'Content-Type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body) });
            const data = await response.json();
            assert.ok(response.ok, `${method} ${suffix}: HTTP ${response.status}: ${JSON.stringify(data)}`);
            return data;
        };
        const until = async (label, check, timeout = 30000) => {
            const end = Date.now() + timeout; let last;
            while (Date.now() < end) { last = await check(); if (last) return last; await new Promise(r => setTimeout(r, 200)); }
            throw new Error(`Timed out: ${label}`);
        };
        browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
        const open = async (width, route) => {
            const context = await browser.newContext({ viewport: { width, height: width < 900 ? 852 : 920 }, locale: 'zh-CN',
                isMobile: width < 900, hasTouch: width < 900 });
            await context.addInitScript(cwd => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem('pi.workspace.language', 'zh-CN'); }, cwd);
            const page = await context.newPage(), errors = [];
            pages.push(page);
            page.on('pageerror', error => errors.push(error.message));
            await page.route('**/*', request => new URL(request.request().url()).origin === base() ? request.continue() : request.abort());
            await page.goto(`${base()}/${route}`, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => window.PiWorkspaceRoute && window.PiAgentProfiles);
            await page.waitForFunction(() => !document.querySelector('#pi-project-button')?.disabled);
            if (await page.locator('#pi-project-dialog').isVisible()) {
                await page.locator('#pi-project-input').fill(cwd);
                await page.locator('#pi-project-form [type=submit]').click();
                await page.locator('#pi-project-dialog').waitFor({ state: 'hidden' });
            }
            return { page, context, errors };
        };

        // 1. Profile with memory, created through the real UI.
        const desktop = await open(1440, '#/profiles');
        const { page } = desktop;
        await page.locator('#pi-profile-add').click();
        await page.locator('#pi-profile-form [name=name]').fill('Memory Fixture');
        await page.locator('#pi-profile-form [name=description]').fill('End-to-end learning rehearsal');
        await page.locator('#pi-profile-form [name=memoryEnabled]').check();
        await page.locator('#pi-profile-form button[type=submit]').click();
        await page.waitForFunction(() => document.querySelectorAll('[data-profile-id]').length === 1);
        const profileId = (await api('GET', '/profiles')).profiles[0].id;
        assert.equal((await api('GET', '/status')).profileLearning, true);

        // 2. Dedicated learning models and learning settings; saving must not call any model.
        const aux = await api('GET', '/settings/auxiliary-models');
        const route = { provider: 'fixture', modelId: 'learner' };
        await api('PUT', '/settings/auxiliary-models', { expectedRevision: aux.revision,
            changes: { 'memory-correction': route, 'memory-review': route, 'memory-extraction': route } });
        const learning0 = await api('GET', `/profiles/${profileId}/learning`);
        await api('PUT', `/profiles/${profileId}/learning`, { expectedRevision: learning0.revision,
            changes: { enabled: true, correctionEnabled: true, reviewEnabled: false, extractionEnabled: true,
                maxRunsPerDay: 20, maxTokensPerDay: 200000 } });
        assert.equal(chat.length + learner.length, 0, 'saving settings made no model request');
        step('settings saved without model calls');

        // 3. Profile-bound thread: explicit preference in a real chat turn.
        const session = await api('POST', '/sessions', { cwd, profileId });
        const chatView = await open(1440, `#/chat?cwd=${encodeURIComponent(cwd)}&sessionId=${session.id}`);
        const send = async (view, text) => {
            await view.page.locator('#pi-input:not([disabled])').waitFor({ timeout: 20000 });
            await view.page.locator('#pi-input').fill(text);
            await view.page.locator('#pi-send-button').click();
        };
        if (!(await chatView.page.evaluate(() => location.hash)).includes('sessionId=') || !await chatView.page.locator('#pi-session-profile').innerText())
            await chatView.page.locator(`[data-session-id="${session.id}"]`).first().click();
        try { await chatView.page.locator('.pi-chat-knowledge').waitFor({ timeout: 20000 }); }
        catch (error) {
            console.error(JSON.stringify({ stage: 'chat-card', hash: await chatView.page.evaluate(() => location.hash),
                card: await chatView.page.locator('#pi-chat-knowledge').evaluate(n => ({ hidden: n.hidden, html: n.innerHTML.slice(0, 300) })),
                badge: await chatView.page.locator('#pi-session-profile').innerText().catch(() => null), errors: chatView.errors }));
            await chatView.page.screenshot({ path: path.join(screenshots, 'chat-card-failure.png'), fullPage: true });
            throw error;
        }
        await send(chatView, PREFERENCE);
        await chatView.page.locator('#pi-transcript').getByText('好的，我记下了。').waitFor({ timeout: 20000 });
        const learned = await until('correction learned', async () => {
            const snap = await api('GET', `/profiles/${profileId}/knowledge?kind=memory&sessionId=${session.id}`);
            return snap.items.find(item => item.content === LEARNED) && snap;
        }, Number(process.env.E2E_LEARN_TIMEOUT || 30000)).catch(async error => {
            const snap = await api('GET', `/profiles/${profileId}/learning`);
            console.error(JSON.stringify({ stage: 'learning', entries: SessionManager.open(session.path).getEntries().map(e => e.type === 'message' ? e.message.role : e.customType || e.type), blockers: [...gateway.supervisor.workers.values()].map(w => w.lifecycle().blockers), maintenance: gateway.supervisor.isIdle(), learner: learner.map(c => c.raw.slice(0, 400)), jobs: snap.jobs,
                runs: snap.recentRuns, capabilities: snap.capabilities, status: snap.status,
                memory: (await api('GET', `/profiles/${profileId}/knowledge?kind=memory`)).items.map(i => [i.category, i.content]) }, null, 1));
            throw error;
        });
        const copies = learned.items.filter(item => item.content === LEARNED);
        report.findings.push({ case: 'learned memory listing', copies: copies.map(item => ({ id: item.id.slice(0, 8), readOnly: !!item.readOnly,
            mirrored: !!item.mirrored, category: item.category, target: item.target })) });
        const learnedItem = copies.find(item => !item.readOnly) || copies[0];
        // Receipts filtered by sessionId only include writes whose verified native source is this thread.
        assert.ok(learned.receipts.some(receipt => receipt.itemId === learnedItem.id), `learned memory receipt belongs to this thread: ${JSON.stringify({ item: learnedItem, receipts: learned.receipts })}`);
        assert.ok(learner.length >= 1 && learner.every(call => call.tools === 0), 'learning calls used no tools');
        const learnedReceipt = learned.receipts.find(receipt => receipt.itemId === learnedItem.id);
        assert.deepEqual({ origin: learnedReceipt.origin, reason: learnedReceipt.learningReason, preview: learnedReceipt.preview,
            category: learnedReceipt.category }, { origin: 'learning', reason: 'correction', preview: LEARNED, category: 'preference' });
        assert.ok(learned.usage?.memory?.chars >= LEARNED.length && learned.usage.memory.limit > 0, `usage: ${JSON.stringify(learned.usage)}`);
        const learningSnap = await api('GET', `/profiles/${profileId}/learning`);
        assert.equal(learningSnap.health?.state, 'ok', JSON.stringify(learningSnap.health));
        assert.equal(learningSnap.legacy, null, 'a profile created without legacy auto-learning has no migration prompt');
        const runs = learningSnap.recentRuns;
        step('correction learned', { category: learnedItem.category, learnerCalls: learner.length,
            run: runs[0] && { status: runs[0].status, reason: runs[0].reason, costStatus: runs[0].costStatus ?? runs[0].cost?.status } });

        // 4. The learned preference is shown under the user message that taught it (display only).
        const learnedHint = chatView.page.locator('#pi-transcript-content > .pi-memory-hint').filter({ hasText: `已记住：${LEARNED}` });
        await learnedHint.waitFor({ timeout: 20000 });
        const hintAnchor = await chatView.page.evaluate(text => { const node = [...document.querySelectorAll('#pi-transcript-content > .pi-memory-hint')]
            .find(item => item.textContent.includes(text)); const prev = node?.previousElementSibling;
            return prev?.dataset.messageKey ? JSON.parse(prev.dataset.messageKey)[0] : null; }, `已记住：${LEARNED}`);
        assert.equal(hintAnchor, 'user', 'learned hint sits under the teaching user message');
        assert.match(await chatView.page.locator('.pi-chat-knowledge summary').innerText(), /本会话已记住 1 条/);
        assert.ok(!fs.readFileSync(session.path, 'utf8').includes('已记住：'), 'hints are never written to the session');
        step('in-chat remembered hint', { anchor: hintAnchor });
        await chatView.page.screenshot({ path: path.join(screenshots, 'chat-card-1440.png'), fullPage: true });

        // 5. Next turn: memory is injected, and the agent's own memory tool uses the trusted journal.
        const before = chat.length;
        await send(chatView, 'MEMORY_TOOL_FIXTURE: remember the service port.');
        await chatView.page.locator('#pi-transcript').getByText('Tool step finished.').first().waitFor({ timeout: 20000 });
        assert.ok(chat.slice(before).some(call => call.system.includes('pnpm')), 'learned preference was provided to the next turn');
        const withTool = await until('tool memory saved', async () => {
            const snap = await api('GET', `/profiles/${profileId}/knowledge?kind=memory`);
            return snap.items.find(item => item.content === TOOL_FACT) && snap;
        });
        assert.ok(withTool.receipts.some(r => r.kind === 'memory' && r.operation === 'create' && r.origin === 'agent'
            && r.preview === TOOL_FACT && r.category === 'fact'), 'tool write has an agent receipt');
        const read = SessionManager.open(session.path).getEntries().filter(e => e.type === 'custom' && e.customType === 'pivane-profile-memory-read');
        assert.ok(read.length >= 2 && read.at(-1).data.provided === true, 'memory read recorded per turn');
        step('memory injected and agent tool write journaled', { memoryReadEntries: read.length });

        // 6. Upstream guidance steers corrections to target "failure"; record what really happens.
        await send(chatView, 'FAILURE_TOOL_FIXTURE: note that npm failed.');
        await until('failure tool settled', async () => chat.at(-1)?.last?.role === 'tool' && chat.at(-1));
        const toolResults = SessionManager.open(session.path).getEntries()
            .filter(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolName === 'memory_add');
        const failureResult = toolResults.at(-1).message;
        assert.equal(failureResult.details?.success, true, `failure write: ${JSON.stringify(failureResult.content)}`);
        // A concurrent learning write can leave the listing briefly pending; read until ready.
        const failureItem = await until('failure memory listed', async () => {
            const snap = await api('GET', `/profiles/${profileId}/knowledge?kind=memory&query=lockfile`);
            return snap.status === 'ready' && snap.items.find(item => item.content === 'npm install failed with a lockfile conflict.' && !item.readOnly);
        });
        assert.ok(failureItem.category === 'failure' && failureItem.target === 'memory', JSON.stringify(failureItem));
        step('agent failure memory saved', { category: failureItem.category });

        // 6b. Content scan on every real write path: the agent's tool write, a learned entry from an
        // English correction, and a manual web write never persist a credential.
        const toolCount = () => SessionManager.open(session.path).getEntries()
            .filter(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolName === 'memory_add').length;
        const toolsBefore = toolCount();
        await send(chatView, 'SECRET_TOOL_FIXTURE: remember the deploy token.');
        await until('secret tool settled', async () => toolCount() > toolsBefore && chat.at(-1)?.last?.role === 'tool');
        const secretResult = SessionManager.open(session.path).getEntries()
            .filter(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolName === 'memory_add').at(-1).message;
        const secretText = JSON.stringify(secretResult.content);
        assert.ok(secretResult.isError === true || secretResult.details?.success === false, `secret tool write refused: ${secretText}`);
        assert.ok(/credential|secret/i.test(secretText) && !secretText.includes(SECRET), secretText);
        const blockedBefore = (await api('GET', `/profiles/${profileId}/learning`)).recentRuns.filter(run => run.error === 'content-blocked').length;
        await send(chatView, 'No, use SECRET_LEARN_FIXTURE as the deploy token instead.');
        const blockedRun = await until('learned secret refused', async () => {
            const runs = (await api('GET', `/profiles/${profileId}/learning`)).recentRuns.filter(run => run.error === 'content-blocked');
            return runs.length > blockedBefore && runs.at(-1);
        });
        assert.deepEqual({ status: blockedRun.status, reason: blockedRun.reason }, { status: 'skipped', reason: 'correction' });
        const webSecret = await fetch(`${base()}/api/pi/profiles/${profileId}/knowledge/mutations`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestId: 'e2e-web-secret', expectedRevision: (await api('GET', `/profiles/${profileId}/knowledge?kind=memory`)).revision,
                operation: 'create', kind: 'memory', category: 'fact', content: `Deploy token ${SECRET}` }) });
        const webBody = await webSecret.json();
        assert.deepEqual({ status: webSecret.status, code: webBody.code }, { status: 400, code: 'content-blocked' });
        assert.ok(!JSON.stringify(webBody).includes(SECRET));
        const scanned = await api('GET', `/profiles/${profileId}/knowledge?kind=memory`);
        assert.ok(!JSON.stringify(scanned.items).includes('ghp_'), 'no credential persisted');
        step('content scan on agent, learning and web writes', { learnedRun: `${blockedRun.reason}:${blockedRun.status}:${blockedRun.error}` });

        // 7. skill_manage view is a read action.
        await send(chatView, 'SKILL_VIEW_FIXTURE: list skills.');
        await until('skill view settled', async () => SessionManager.open(session.path).getEntries()
            .some(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolName === 'skill_manage'));
        const view = SessionManager.open(session.path).getEntries()
            .filter(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolName === 'skill_manage').at(-1).message;
        assert.notEqual(view.isError, true, `skill view: ${JSON.stringify(view.content)}`);
        step('skill view');

        // 7b. The agent's own write is hinted under its assistant message; "不对" deletes it with a tombstone.
        const agentHint = chatView.page.locator('#pi-transcript-content > .pi-memory-hint').filter({ hasText: `Agent 记下：${TOOL_FACT}` });
        await agentHint.waitFor({ timeout: 20000 });
        // Query and inspect in one synchronous page call: hints are rebuilt on every render.
        await chatView.page.waitForFunction(fact => [...document.querySelectorAll('#pi-transcript-content > .pi-memory-hint')]
            .filter(node => node.textContent.includes(fact)).some(node => { let prev = node.previousElementSibling;
                while (prev?.classList.contains('pi-memory-hint')) prev = prev.previousElementSibling;
                return Boolean(prev?.matches('.pi-message.user') && prev.textContent.includes('MEMORY_TOOL_FIXTURE')); }), TOOL_FACT, { timeout: 20000 });
        assert.ok(await agentHint.isVisible(), 'agent hint stays visible in the compact view');
        chatView.page.once('dialog', dialog => dialog.accept());
        await agentHint.locator('button').filter({ hasText: '不对' }).click();
        await until('agent fact rejected', async () => !(await api('GET', `/profiles/${profileId}/knowledge?kind=memory`)).items
            .some(item => item.content === TOOL_FACT && item.state === 'active'));
        await agentHint.waitFor({ state: 'detached', timeout: 20000 });
        step('agent hint rejected with 不对');
        assert.ok(!fs.readFileSync(session.path, 'utf8').includes('Agent 记下：'), 'hints are never written to the session');
        await chatView.page.screenshot({ path: path.join(screenshots, 'chat-hints-1440.png'), fullPage: true });

        // 7c. "编辑" opens the profile's knowledge page on that entry.
        await learnedHint.locator('button').filter({ hasText: '编辑' }).click();
        await chatView.page.locator('.pi-knowledge-detail pre').filter({ hasText: 'pnpm' }).waitFor({ timeout: 20000 });
        step('hint edit opens the entry');
        assert.deepEqual(chatView.errors, []);
        await chatView.context.close();

        // 8. Management page: edit the learned memory and undo it through the receipt.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator(`[data-profile-id="${profileId}"]`).click();
        await page.locator('[data-profile-section="skills"]').click();
        await page.locator('.pi-profile-kinds button').first().click();
        await page.locator('.pi-knowledge-row').filter({ hasText: 'pnpm' }).first().click();
        await page.locator('.pi-knowledge-detail pre').waitFor();
        await page.locator('.pi-knowledge-detail button').filter({ hasText: '编辑' }).click();
        await page.locator('.pi-knowledge-editor textarea').fill('安装依赖默认使用 pnpm 9。');
        await page.locator('.pi-knowledge-editor button[type=submit]').click();
        await page.locator('.pi-knowledge-receipt').waitFor();
        await until('edit saved', async () => (await api('GET', `/profiles/${profileId}/knowledge/items/${learnedItem.id}`)).item.content === '安装依赖默认使用 pnpm 9。');
        await page.locator('.pi-knowledge-receipt button').first().click();
        await until('undo applied', async () => (await api('GET', `/profiles/${profileId}/knowledge/items/${learnedItem.id}`)).item.content === LEARNED);
        step('edit and undo in management page');

        // 8b. Consolidation: the review model proposes a merge (plan only), the page applies it
        // as one batch, and one undo restores every original entry.
        const memoryBefore = (await api('GET', `/profiles/${profileId}/knowledge?kind=memory`)).items
            .filter(item => item.state === 'active' && !item.readOnly).map(item => item.content).sort();
        await api('POST', `/profiles/${profileId}/learning/actions`, { requestId: 'e2e-consolidate-1', action: 'propose-consolidation', target: 'memory' });
        const proposed = await until('consolidation proposal', async () => {
            const snap = await api('GET', `/profiles/${profileId}/learning`);
            return snap.proposals?.length === 1 && snap;
        });
        assert.deepEqual((await api('GET', `/profiles/${profileId}/knowledge?kind=memory`)).items
            .filter(item => item.state === 'active' && !item.readOnly).map(item => item.content).sort(), memoryBefore, 'a proposal writes nothing');
        assert.equal(proposed.proposals[0].groups[0].items.length, 2);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator(`[data-profile-id="${profileId}"]`).click();
        await page.locator('[data-profile-section="skills"]').click();
        const group = page.locator('.pi-proposal-group').first();
        await group.waitFor({ timeout: 20000 });
        await group.locator('button').filter({ hasText: '应用' }).click();
        const merged = await until('consolidation applied', async () => {
            const snap = await api('GET', `/profiles/${profileId}/knowledge?kind=memory`);
            const active = snap.items.filter(item => item.state === 'active' && !item.readOnly).map(item => item.content);
            return active.includes(MERGED) && !active.includes(LEARNED) && snap;
        });
        const consolidated = merged.receipts.find(r => r.operation === 'consolidate');
        assert.ok(consolidated?.undoable && consolidated.consolidated?.length === 2 && consolidated.origin === 'manual', JSON.stringify(consolidated));
        await page.locator('.pi-knowledge-receipt button').filter({ hasText: '撤销' }).first().click();
        await until('consolidation undone', async () => JSON.stringify((await api('GET', `/profiles/${profileId}/knowledge?kind=memory`)).items
            .filter(item => item.state === 'active' && !item.readOnly).map(item => item.content).sort()) === JSON.stringify(memoryBefore));
        step('consolidation proposed, applied and undone');
        await page.screenshot({ path: path.join(screenshots, 'consolidation-1440.png'), fullPage: true });

        // 8c. Injection preview matches what the last turn loaded; project memory is editable
        // only through a verified session, never with a client project key.
        const preview = await api('GET', `/profiles/${profileId}/knowledge/injection?sessionId=${session.id}`);
        assert.ok(preview.status === 'ready' && preview.block.includes(LEARNED) && preview.lastRead?.provided === true
            && preview.lastRead.chars > 0, JSON.stringify({ ...preview, block: preview.block?.slice(0, 200) }));
        const knowledgeRevision = async () => (await api('GET', `/profiles/${profileId}/knowledge?kind=memory`)).revision;
        const forged = await fetch(`${base()}/api/pi/profiles/${profileId}/knowledge/mutations`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestId: 'e2e-forged-project', expectedRevision: await knowledgeRevision(), operation: 'create', kind: 'memory',
                category: 'fact', scope: 'project', sessionId: session.id, projectKey: 'a'.repeat(64), content: 'Forged project note.' }) });
        assert.equal(forged.status, 400, 'a client project key is refused');
        const projectWrite = await api('POST', `/profiles/${profileId}/knowledge/mutations`, { requestId: 'e2e-project-note', expectedRevision: await knowledgeRevision(),
            operation: 'create', kind: 'memory', category: 'procedure', scope: 'project', sessionId: session.id, content: 'Run tests with pnpm test in this folder.' });
        assert.ok(projectWrite.receipt.scope === 'project' && projectWrite.receipt.source?.sessionId === session.id, JSON.stringify(projectWrite.receipt));
        const projectPreview = await api('GET', `/profiles/${profileId}/knowledge/injection?sessionId=${session.id}`);
        assert.ok(projectPreview.project?.entries >= 1 && projectPreview.block.includes('pnpm test'), JSON.stringify(projectPreview.project));
        step('injection preview and session-verified project memory', { chars: projectPreview.chars, entries: projectPreview.entries });
        await page.screenshot({ path: path.join(screenshots, 'knowledge-1440.png'), fullPage: true });
        assert.deepEqual(desktop.errors, []);
        await desktop.context.close();

        // 9. Exit boundary: disposing the worker registers extraction without re-learning the same fact.
        const learnerBefore = learner.length;
        const worker = gateway.supervisor.workers.get(session.path) || [...gateway.supervisor.workers.values()][0];
        if (worker) await worker.dispose();
        await until('exit extraction ran', async () => {
            const snap = await api('GET', `/profiles/${profileId}/learning`);
            return snap.recentRuns.some(run => run.reason === 'exit' || run.reason === 'extraction') && snap;
        }, 30000).then(snap => step('exit extraction', { runs: snap.recentRuns.map(r => `${r.reason}:${r.status}`),
            newLearnerCalls: learner.length - learnerBefore }));
        const final = await api('GET', `/profiles/${profileId}/knowledge?kind=memory`);
        assert.equal(final.items.filter(item => item.content === LEARNED).length, 1, 'no duplicate learned memory');

        // 10. Legacy auto-learning: a profile saved with autoLearn is offered adoption, never enabled silently.
        const registry = await api('GET', '/profiles');
        const legacyProfile = (await api('PUT', '/profiles', { expectedRevision: registry.revision, profile: { name: 'Legacy Fixture',
            description: '', soul: '', enabled: true, memory: { enabled: true, autoLearn: true, memoryCharLimit: 16000, userCharLimit: 8000 },
            skills: { learnedEnabled: true } } })).profile.id;
        const legacySnap = await api('GET', `/profiles/${legacyProfile}/learning`);
        assert.equal(legacySnap.settings.enabled, false, 'legacy profile is not enabled by the upgrade');
        assert.deepEqual({ reviewModel: legacySnap.legacy?.reviewModel, available: legacySnap.legacy?.reviewModelAvailable,
            purposes: legacySnap.legacy?.purposes }, { reviewModel: { provider: 'fixture', modelId: 'learner' }, available: true, purposes: [] });
        // The previous profile's asynchronous exit extraction is independent of
        // adoption. Drain it before measuring whether adoption makes a request.
        await gateway.learning.flushRegistrations();
        await until('previous learning settled before legacy adoption', async () => {
            const snap = await api('GET', `/profiles/${profileId}/learning`);
            return !gateway.learning.busy && !snap.jobs.some(job => ['queued', 'running', 'cancelling'].includes(job.status));
        }, 30000);
        const learnerBeforeAdopt = learner.length;
        const adopted = await api('POST', `/profiles/${legacyProfile}/learning/actions`, { requestId: 'e2e-adopt-legacy-1', action: 'adopt-legacy' });
        assert.deepEqual({ enabled: adopted.settings.enabled, review: adopted.settings.reviewEnabled, legacy: adopted.legacy },
            { enabled: true, review: true, legacy: null });
        assert.equal(learner.length, learnerBeforeAdopt, 'adoption made no model request');
        step('legacy adoption', { health: adopted.health.state });

        // 11. Mobile management layout with real data.
        const mobile = await open(393, '#/profiles');
        await mobile.page.locator(`[data-profile-id="${profileId}"]`).click();
        await mobile.page.locator('[data-profile-section="skills"]').click();
        await mobile.page.locator('.pi-profile-kinds button').first().click();
        await mobile.page.locator('.pi-knowledge-row').first().waitFor();
        const geometry = await mobile.page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth,
            small: [...document.querySelectorAll('textarea,input,select')].filter(el => el.offsetParent && parseFloat(getComputedStyle(el).fontSize) < 16).map(el => el.name || el.className) }));
        assert.ok(geometry.document <= geometry.viewport + 1, JSON.stringify(geometry));
        assert.deepEqual(geometry.small, []);
        await mobile.page.screenshot({ path: path.join(screenshots, 'knowledge-393.png'), fullPage: true });
        assert.deepEqual(mobile.errors, []);
        await mobile.context.close();
        step('mobile layout', geometry);

        console.log(JSON.stringify({ status: 'passed', chatCalls: chat.length, learnerCalls: learner.length, ...report }, null, 1));
    } catch (error) {
        for (const [index, page] of pages.entries()) await page.screenshot({ path: path.join(screenshots, `failure-${index}.png`), fullPage: true }).catch(() => {});
        console.error(JSON.stringify({ stepsSoFar: report.steps, findings: report.findings }));
        throw error;
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

main().catch(error => { console.error(JSON.stringify({ status: 'failed', error: error.stack || String(error) })); process.exitCode = 1; });
