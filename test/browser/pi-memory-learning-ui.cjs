// Identity memory/learning/chat integration with synthetic API snapshots. Deep page contracts
// live in pi-profile-learning.cjs and pi-profile-knowledge.cjs; this harness checks their seams.
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const hash = letter => letter.repeat(64);
const app = express();
for (const [url, directory] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']])
    app.use(`/vendor/${url}`, express.static(path.join(root, 'node_modules', directory)));
app.use(express.static(path.join(root, 'public')));
const settings = { enabled: false, correctionEnabled: true, reviewEnabled: false, extractionEnabled: false,
    maxRunsPerDay: 4, maxTokensPerDay: 24000, periodicReviewMinutes: 0, consolidationInputChars: 12000,
    triggerPhrases: { correction: [], preference: [], temporary: [], ignore: [] } };
app.get('/fixture', (_req, res) => res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/workspace.css"><link rel="stylesheet" href="/pi-identity-ui.css"><link rel="stylesheet" href="/pi-profile-learning.css"><link rel="stylesheet" href="/pi-profile-knowledge.css"><link rel="stylesheet" href="/pi-chat-knowledge.css">
<style>:root{--line:#ccc;--text-main:#222;--text-soft:#555;--text-muted:#777;--surface-1:#fff;--surface-2:#eee;--accent:#168a68}body{margin:0;font-family:Arial,sans-serif;background:#f8f8f8;color:#222}main{max-width:720px;padding:12px;margin:auto;min-width:0}button{cursor:pointer}section{min-width:0}#pi-transcript-content{display:grid;gap:6px;padding:8px 0}</style></head><body><main><section class="pi-id-page" id="pi-profiles-memory"></section><section class="pi-id-page" id="learning" hidden></section><div id="pi-chat-knowledge"></div><div id="pi-transcript-content"></div></main>
<script src="/vendor/marked/marked.umd.js"></script><script src="/vendor/dompurify/purify.min.js"></script><script src="/pi-i18n-catalog.js"></script><script src="/pi-i18n.js"></script><script src="/pi-profile-dialog.js"></script><script src="/pi-identity-ui.js"></script><script src="/pi-profile-learning.js"></script><script src="/pi-profile-knowledge.js"></script><script src="/pi-chat-knowledge.js"></script>
<script>
window.current = { cwd: '/synthetic', sessionId: 'thread-one', profileId: 'profile-one', generation: 1 };
window.calls = []; window.events = [];
window.PiAgentProfilesUI = { revealKnowledge: (profileId, itemId, kind, sessionId) => window.calls.push({ reveal: [profileId, itemId, kind, sessionId] }),
    revealProjectMemory: (profileId, sessionId) => window.calls.push({ revealProject: [profileId, sessionId] }) };
window.addEventListener('workspace:open-settings', event => window.events.push(event.detail));
window.addEventListener('chat:reload-resources', event => window.events.push({ reload: event.detail }));
window.fixtureEntries = { leafId: 'entry-user-2', entries: [
    { id: 'entry-user-1', type: 'message', timestamp: 10, message: { role: 'user', content: 'First question', timestamp: 10 } },
    { id: 'entry-reply-1', type: 'message', timestamp: 11, message: { role: 'assistant', content: [{ type: 'text', text: 'First reply' }], timestamp: 11 } },
    { id: 'entry-user-2', type: 'message', timestamp: 20, message: { role: 'user', content: 'Second question', timestamp: 20 } } ] };
const transcript = document.getElementById('pi-transcript-content');
for (const [role, timestamp, text] of [['user', 10, 'First question'], ['assistant', 11, 'First reply'], ['user', 20, 'Second question']]) {
    const article = document.createElement('article');
    article.className = 'pi-message ' + role;
    article.dataset.messageKey = JSON.stringify([role, timestamp, '']);
    article.textContent = text;
    transcript.append(article);
}
window.api = async (url, options) => {
    window.calls.push({ url, body: options && options.body ? JSON.parse(options.body) : null });
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || response.statusText), { status: response.status, data });
    return data;
};
const toaster = PiIdentityUI.createToaster(document.querySelector('main'));
const ui = { toast: toaster.show, confirm: PiProfileDialog.confirm, profile: () => ({id:'profile-one', enabled:true, memory:{enabled:true}, skills:{learnedEnabled:true}}), openSettings: detail => events.push(detail), navigate: section => window.showPage(section) };
window.manager = PiProfileKnowledge.create({ apiFetch: window.api, root: document.getElementById('pi-profiles-memory'), ui });
window.learning = PiProfileLearning.create({ apiFetch: window.api, root: document.getElementById('learning'), ui });
window.showPage = async section => {
    document.getElementById('pi-profiles-memory').hidden = section === 'learning';
    document.getElementById('learning').hidden = section !== 'learning';
    if (section === 'learning') { manager.close(); await learning.open('profile-one'); }
    else { learning.close(); await manager.open('profile-one', {view:section}); }
};
window.chat = PiChatKnowledge.create({ fetch: window.api, root: document.getElementById('pi-chat-knowledge'),
    transcript, anchors: () => window.fixtureEntries.entries.map(entry => [entry.id, entry.message.role, entry.message.timestamp, '']),
    scope: () => window.current });
window.manager.open('profile-one', {view:'memory',target:'memory'}); window.chat.update();
window.refreshAll = () => Promise.all([window.manager.refresh(), window.learning.refresh(), window.chat.refresh()]);
</script></body></html>`));
app.get('/profiles-fixture', (_req, res) => res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/pi-agent-profiles.css"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/workspace.css"><link rel="stylesheet" href="/pi-identity-ui.css"><link rel="stylesheet" href="/pi-profile-learning.css"><link rel="stylesheet" href="/pi-profile-knowledge.css"><link rel="stylesheet" href="/pi-chat-knowledge.css">
<style>:root{--line:#ccc;--text-main:#222;--text-soft:#555;--text-muted:#777;--surface-1:#fff;--surface-2:#eee;--accent:#168a68}body{margin:0;font-family:Arial,sans-serif;background:#f8f8f8;color:#222}main{max-width:720px;padding:12px;margin:auto;min-width:0}button{cursor:pointer}</style></head><body><main>
<div id="pi-profiles-panel"><h3></h3><div class="settings-panel-header"><p></p></div></div>
<div id="pi-profiles-content"></div>
<dl id="pi-meta-profile-row"><dt></dt><dd id="pi-meta-profile"></dd></dl><div id="pi-session-profile"></div>
</main>
<script src="/vendor/marked/marked.umd.js"></script><script src="/vendor/dompurify/purify.min.js"></script><script src="/pi-i18n-catalog.js"></script><script src="/pi-i18n.js"></script><script src="/pi-profile-dialog.js"></script><script src="/pi-identity-ui.js"></script><script src="/pi-profile-learning.js"></script><script src="/pi-profile-knowledge.js"></script><script src="/pi-profile-session.js"></script><script src="/pi-agent-profiles.js"></script>
<script>
window.api = async (url, options) => {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || response.statusText), { status: response.status, data });
    return data;
};
window.profiles = PiAgentProfiles.create({ apiFetch: window.api, currentCwd: () => '/synthetic' });
window.profiles.setEnabled(true, true); window.profiles.open();
</script></body></html>`));

async function runFixture(browser, base, width, locale) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale });
    const page = await context.newPage(), errors = [], dialogs = [], state = {
        usage: { memory: { chars: 5000, limit: 16000 }, user: { chars: 7000, limit: 8000 } },
        learningRevision: 1, settings: structuredClone(settings), jobs: [], recentRuns: [],
        health: { state: 'needs-model', missingModels: ['memory-correction', 'memory-extraction'], lastFailure: null, today: { runs: 0, maxRuns: 4, reservedTokens: 0, maxTokens: 24000 } },
        rejectMemoryFull: false, rejectBlocked: false, hintConflict: false,
        actions: ['save', 'enable'] };
    const receipts = [
        { id: 'receipt-learning', requestId: 'learning-1', kind: 'memory', operation: 'create', status: 'saved', origin: 'learning', reason: 'extraction',
            category: 'preference', preview: '以后默认用 pnpm 安装依赖', summary: 'create memory', undoable: true, itemId: hash('a'), afterRevision: hash('c'),
            source: { sessionId: 'thread-one', entryId: 'entry-user-1' } },
        { id: 'receipt-agent', requestId: 'tool-1', kind: 'memory', operation: 'create', status: 'saved', origin: 'agent',
            category: 'fact', preview: '服务监听 4321 端口', undoable: true, itemId: hash('d'), afterRevision: hash('e'),
            source: { sessionId: 'thread-one', entryId: 'entry-missing' } },
        { id: 'receipt-skill', requestId: 'tool-2', kind: 'skill', operation: 'create', status: 'saved', origin: 'learning', reason: 'review',
            preview: 'pnpm-install — 用 pnpm 安装依赖', undoable: false, itemId: hash('f'), afterRevision: hash('g'), activation: 'reload-required',
            source: { sessionId: 'thread-one', entryId: 'entry-user-2' } },
        { id: 'receipt-old', requestId: 'native-1', kind: 'memory', operation: 'create', status: 'saved',
            summary: 'create memory', undoable: true, source: { sessionId: 'thread-one', entryId: 'entry-user-1' } } ];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.accept(); });
    await page.route('**/api/pi/**', async route => {
        const req = route.request(), url = new URL(req.url()), p = url.pathname;
        const fulfill = (body, status = 200) => route.fulfill({ json: body, status });
        const learning = () => ({ version: 1, status: 'ready', revision: state.learningRevision, settings: state.settings,
            jobs: state.jobs, recentRuns: state.recentRuns, health: state.health,
            capabilities: { installed: true, settingsWrite: true, reservedTokensPerRun: 6000, actions: state.actions,
                limits: { maxRunsPerDay: { min: 1, max: 500 }, maxTokensPerDay: { min: 6000, max: 5000000 }, periodicReviewMinutes: { min: 0, max: 10080 } } } });
        const snapshot = () => ({ version: 1, status: 'ready', revision: hash('a'), items: [], receipts, hasMore: false,
            usage: state.usage, capabilities: { memory: true, skill: true, projectWrites: false, operations: ['create', 'update', 'delete', 'undo'], maxContentLength: 65536 } });
        if (p.endsWith('/knowledge') && req.method() === 'GET') return fulfill(snapshot());
        if (p.endsWith('/learning') && req.method() === 'GET') return fulfill(learning());
        if (p.endsWith('/learning/actions')) {
            const input = req.postDataJSON();
            if (input.action === 'enable') {
                state.settings = { ...state.settings, enabled: true, correctionEnabled: true };
                state.health = { ...state.health, state: 'needs-model', missingModels: ['memory-correction'] };
            }
            state.learningRevision++;
            return fulfill(learning());
        }
        if (p.endsWith('/knowledge/mutations')) {
            const input = req.postDataJSON();
            if (state.hintConflict) { state.hintConflict = false; return fulfill({ error: 'Conflict' }, 409); }
            if (state.rejectBlocked) { state.rejectBlocked = false; return fulfill({ error: 'Content looks like a credential or secret and cannot be saved to memory or skills',
                code: 'content-blocked', details: { rule: 'github_token', kind: 'secret' } }, 400); }
            if (state.rejectMemoryFull) { state.rejectMemoryFull = false; return fulfill({ error: 'Memory is full', code: 'memory-full', details: { target: 'memory', chars: 16000, limit: 16000, needed: 16120 } }, 409); }
            return fulfill({ version: 1, status: 'saved', revision: hash('b'), receipt: { id: 'mutated', requestId: input.requestId,
                kind: input.kind, operation: input.operation, status: 'saved', undoable: false, source: { sessionId: 'thread-one', entryId: 'entry-user-1' } } });
        }
        if (p === '/api/pi/profiles' && req.method() === 'GET') return fulfill({ version: 1, revision: 'p1', cwd: '/synthetic',
            profiles: [{ id: 'profile-one', name: 'Research', enabled: true, memory: { enabled: true }, skills: { learnedEnabled: true } },
                { id: 'profile-two', name: 'Archive', enabled: false, memory: { enabled: true }, skills: { learnedEnabled: true } }] });
        return fulfill({ error: 'missing' }, 404);
    });
    await page.goto(`${base}/fixture`);
    const text = selector => page.locator(selector).first().innerText();
    const zh = locale.startsWith('zh');
    const say = (source, english) => zh ? source : english;
    const chatStatus = '#pi-chat-knowledge .pi-knowledge-status';
    const memory = page.locator('#pi-profiles-memory');
    // Capacity is per target now. A rejection still marks the problem and keeps the draft.
    await memory.locator('.pi-id-meter[data-level=ok]').waitFor();
    assert.match(await memory.locator('.pi-id-meter').innerText(), /5,?000 \/ 16,?000/);
    await memory.locator('.pi-knowledge-target-row [data-value=user]').click();
    await memory.locator('.pi-id-meter[data-level=near]').waitFor();
    assert.match(await memory.locator('.pi-id-meter').innerText(), /7,?000 \/ 8,?000/);
    state.usage.user.chars = 8000;
    await page.evaluate(() => window.refreshAll());
    await memory.locator('.pi-id-meter[data-level=full]').waitFor();
    assert.ok((await memory.innerText()).includes(say('已满，新内容会被拒绝', 'Storage is full. New content will be rejected.')));
    await memory.locator('.pi-knowledge-target-row [data-value=memory]').click();
    state.rejectMemoryFull = true;
    await memory.locator('.pi-knowledge-add').click();
    await memory.locator('.pi-knowledge-editor textarea').fill('A new fact');
    await memory.locator('.pi-knowledge-editor button[type=submit]').click();
    await memory.getByText(say('记忆已满，新记忆会被拒绝。请整理合并后再试。', 'Memory is full; new memories will be rejected. Consolidate and try again.'), {exact:true}).waitFor();
    assert.equal(await memory.locator('.pi-knowledge-editor textarea').inputValue(), 'A new fact');
    state.rejectBlocked = true;
    await memory.locator('.pi-knowledge-editor button[type=submit]').click();
    await memory.getByText(say('内容疑似密钥或凭据，不能保存到记忆或技能。', 'This looks like a key or credential and cannot be saved to memory or skills.'), {exact:true}).waitFor();
    assert.equal(await memory.locator('.pi-knowledge-editor textarea').inputValue(), 'A new fact');
    await page.evaluate(() => window.manager.refresh());
    assert.equal(await memory.locator('.pi-knowledge-injection').count(), 0, 'an absent endpoint keeps the active memory preview hidden');
    // Learning moved to its own page; ensure the API/settings link is wired there.
    await page.evaluate(() => window.showPage('learning'));
    const learning = page.locator('#learning');
    await learning.locator('.pi-learning-missing').waitFor();
    assert.ok((await learning.innerText()).includes(say('纠错模型 / 提炼模型', 'Correction model / Extraction model')));
    await learning.locator('.pi-learning-missing button').click();
    assert.deepEqual(await page.evaluate(() => window.events.at(-1)), { tab: 'models' });
    await learning.locator('.pi-learning-hero .pi-id-btn-primary').click();
    await page.waitForFunction(() => !window.learning.busy() && document.querySelector('#learning input[name=enabled]')?.checked);
    const enable = await page.evaluate(() => window.calls.filter(call => call.body?.action === 'enable').at(-1));
    assert.equal(enable.url, '/api/pi/profiles/profile-one/learning/actions');
    assert.equal(typeof enable.body.requestId, 'string');
    state.health = { ...state.health, state:'memory-full' };
    state.recentRuns = [{id:'full-run',reason:'review',status:'skipped',error:'memory-full',createdAt:new Date().toISOString()}];
    await page.evaluate(() => window.refreshAll());
    assert.ok((await learning.locator('.pi-learning-hero').innerText()).includes(say('记忆已满','Memory is full')));
    assert.ok((await learning.locator('.pi-id-timeline').innerText()).includes(say('记忆已满，未保存','Memory full; not saved')));
    // Trigger validation, legacy migration, job health and save semantics are covered deeply
    // by pi-profile-learning.cjs. Proposals and page injection are in pi-profile-knowledge.cjs.
    // U1.1: contract receipts render under their source message; unknown entries fall back to the card.
    await page.locator('#pi-chat-knowledge summary').click();
    await page.waitForFunction(() => document.querySelectorAll('#pi-transcript-content .pi-memory-hint').length === 2);
    // Each turn's receipts share one group placed right after that turn's user message.
    const hints = await page.locator('#pi-transcript-content .pi-memory-hint').evaluateAll(nodes => nodes.map(node => ({
        text: node.textContent, label: node.querySelector('.pi-memory-hint-label')?.textContent,
        after: node.closest('.pi-memory-hints')?.previousElementSibling?.textContent })));
    assert.equal(hints.length, 2, JSON.stringify(hints));
    assert.equal(hints[0].label, say('已记住', 'Remembered'), JSON.stringify(hints));
    assert.ok(hints[0].text.includes('以后默认用 pnpm 安装依赖'), JSON.stringify(hints));
    assert.equal(hints[0].after, 'First question');
    assert.equal(hints[1].label, say('学会技能', 'Skill learned'), JSON.stringify(hints));
    assert.ok(hints[1].text.includes('pnpm-install'), JSON.stringify(hints));
    assert.equal(hints[1].after, 'Second question');
    assert.ok(hints[0].text.includes(say('偏好', 'Preference')), JSON.stringify(hints[0]));
    assert.ok(hints[1].text.includes(say('需重载会话后生效', 'Reload the session to apply')), JSON.stringify(hints[1]));
    const fallback = page.locator('.pi-memory-hint-fallback');
    assert.equal(await fallback.count(), 1);
    assert.ok((await fallback.innerText()).includes(say('Agent 记下', 'Agent noted')));
    assert.ok(await page.locator('.pi-chat-knowledge-fallback').isVisible(), 'the fallback section shows when a hint has no rendered anchor');
    assert.ok((await text('#pi-chat-knowledge summary')).includes(say('本会话已记住 3 条', '3 entries remembered in this session')));
    assert.equal(await page.locator('.pi-chat-knowledge-receipt').count(), 1, 'old receipts keep the previous card rows');
    // Without the injection endpoint the chat card explains that content is unavailable.
    await page.locator('.pi-knowledge-entries button').filter({ hasText: say('查看本会话注入内容', "View this session's injected content") }).click();
    await page.waitForFunction(() => Boolean(document.querySelector('.pi-injection-preview .pi-injection-error')));
    assert.ok((await text('.pi-injection-preview')).includes(say('注入内容不可用', 'Injected content is unavailable')), await text('.pi-injection-preview'));
    // The same toolbar button hides the preview again.
    await page.locator('.pi-knowledge-entries button').filter({ hasText: say('收起注入内容', 'Hide injected content') }).click();
    await page.waitForFunction(() => !document.querySelector('.pi-injection-preview'));
    // The undoable:false skill hint keeps only its session-reload button; the two memory hints keep three buttons each.
    assert.equal(await page.locator('.pi-memory-hint button').count(), 7);
    // Undo posts the receipt identity with the confirmed revision.
    await page.locator('#pi-transcript-content .pi-memory-hint').first().locator('button').filter({ hasText: say('撤销', 'Undo') }).click();
    await page.waitForFunction(() => window.calls.some(call => call.body && call.body.operation === 'undo'));
    const undo = await page.evaluate(() => window.calls.filter(call => call.body && call.body.operation === 'undo').at(-1));
    assert.deepEqual(Object.keys(undo.body).sort(), ['expectedRevision', 'kind', 'operation', 'receiptId', 'requestId']);
    assert.equal(undo.body.receiptId, 'receipt-learning');
    assert.equal(undo.body.expectedRevision, hash('a'));
    // "不对" deletes the memory (anti-revival tombstone) after confirmation.
    await page.locator('#pi-transcript-content .pi-memory-hint').first().locator('button').filter({ hasText: say('不对', 'Not right') }).click();
    await page.waitForFunction(() => window.calls.some(call => call.body && call.body.operation === 'delete'));
    const removal = await page.evaluate(() => window.calls.filter(call => call.body && call.body.operation === 'delete').at(-1));
    assert.deepEqual(Object.keys(removal.body).sort(), ['expectedRevision', 'itemId', 'itemRevision', 'kind', 'operation', 'requestId']);
    assert.equal(removal.body.itemId, hash('a'));
    assert.equal(removal.body.itemRevision, hash('c'));
    assert.ok(dialogs.some(message => message.includes(say('这条记忆不对吗', 'Is this memory wrong'))), JSON.stringify(dialogs));
    // "编辑" jumps to the identity page memory management and locates the entry.
    await page.locator('#pi-transcript-content .pi-memory-hint').first().locator('button').filter({ hasText: say('编辑', 'Edit') }).click();
    assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), { reveal: ['profile-one', hash('a'), 'memory', 'thread-one'] });
    assert.deepEqual(await page.evaluate(() => window.events.at(-1)), { tab: 'profiles', profileId: 'profile-one', section: 'memory' });
    // A 409 on a hint refreshes and tells the user instead of silently failing.
    state.hintConflict = true;
    await page.locator('#pi-transcript-content .pi-memory-hint').first().locator('button').first().click();
    await page.waitForFunction(() => /conflict|冲突/i.test(document.querySelector('#pi-chat-knowledge .pi-knowledge-status')?.textContent || ''));
    assert.ok((await text(chatStatus)).includes(say('已刷新数据', 'data refreshed')));
    // Mobile: 16px form controls, no horizontal overflow, no page errors.
    if (width < 900) {
        await page.waitForFunction(() => [...document.querySelectorAll('textarea,input,select')].every(el => parseFloat(getComputedStyle(el).fontSize) >= 16), undefined, { timeout: 5000 }).catch(() => {});
        const sizes = await page.evaluate(() => [...document.querySelectorAll('textarea,input,select')].map(el => [el.tagName.toLowerCase(), parseFloat(getComputedStyle(el).fontSize)]));
        assert.ok(sizes.every(entry => entry[1] >= 16), `mobile form font sizes: ${JSON.stringify(sizes)}`);
    }
    const geometry = await page.evaluate(() => ({ width: innerWidth, body: document.documentElement.scrollWidth }));
    assert.ok(geometry.body <= geometry.width + 1, JSON.stringify(geometry));
    assert.deepEqual(errors, []);
    console.log(`PASS learning ui fixture ${width} ${locale}: ${JSON.stringify(geometry)}`);
    await context.close();
}

async function runProfiles(browser, base, width, locale) {
    // Identity list: health dots come from each profile's learning snapshot; absent health keeps the plain row.
    const context = await browser.newContext({ viewport: { width, height: 800 }, locale });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/pi/**', async route => {
        const req = route.request(), url = new URL(req.url()), p = url.pathname;
        const fulfill = (body, status = 200) => route.fulfill({ json: body, status });
        if (p === '/api/pi/profiles') return fulfill({ version: 1, revision: 'p1', cwd: '/synthetic',
            profiles: [{ id: 'profile-one', name: 'Research', enabled: true, memory: { enabled: true }, skills: { learnedEnabled: true } },
                { id: 'profile-two', name: 'Archive', enabled: false, memory: { enabled: true }, skills: { learnedEnabled: true } }] });
        if (p.endsWith('/learning')) {
            const id = p.split('/')[4];
            if (id === 'profile-one') return fulfill({ version: 1, status: 'ready', revision: 1, settings: structuredClone(settings), jobs: [], recentRuns: [],
                drafts: { pending: 2, capped: false },
                health: { state: 'needs-model', missingModels: ['memory-review'], lastFailure: null, today: { runs: 0, maxRuns: 4, reservedTokens: 0, maxTokens: 24000 } },
                capabilities: { installed: true, settingsWrite: true, actions: ['save'] } });
            // Older backends return no health field at all.
            return fulfill({ version: 1, status: 'ready', revision: 1, settings: structuredClone(settings), jobs: [], recentRuns: [],
                capabilities: { installed: true, settingsWrite: true, actions: ['save'] } });
        }
        if (p.endsWith('/knowledge') && req.method() === 'GET') return fulfill({ version: 1, status: 'ready', revision: 'a'.repeat(64),
            items: [{ id: 'b'.repeat(64), kind: 'skill', name: 'draft-skill', description: 'Draft', state: 'draft', scope: 'profile', revision: 'c'.repeat(64) },
                { id: 'd'.repeat(64), kind: 'skill', name: 'active-skill', description: 'Active', state: 'active', scope: 'profile', revision: 'e'.repeat(64) }],
            receipts: [], hasMore: false, capabilities: { memory: true, skill: true, operations: ['create', 'update', 'delete', 'undo'], maxContentLength: 65536 } });
        return fulfill({ error: 'missing' }, 404);
    });
    await page.goto(`${base}/profiles-fixture`);
    await page.locator('.pi-profile-row').first().waitFor();
    await page.waitForFunction(() => Boolean(document.querySelector('.pi-profile-row .pi-health-dot')));
    const zh = locale.startsWith('zh'), say = (source, english) => zh ? source : english;
    const warned = page.locator('.pi-profile-row[data-profile-id="profile-one"]');
    assert.equal(await warned.locator('.pi-health-dot').getAttribute('data-tone'), 'amber');
    assert.equal(await warned.locator('.pi-health-dot').getAttribute('title'), say('缺少学习模型配置', 'A learning model is not configured'));
    // The narrow list shows the short health label; the full sentence stays on the chip title.
    const healthChip = warned.locator('.pi-id-row-meta .pi-id-chip').filter({ hasText: say('缺少模型', 'Models needed') });
    assert.equal(await healthChip.count(), 1);
    assert.equal(await healthChip.getAttribute('title'), say('缺少学习模型配置', 'A learning model is not configured'));
    const plain = page.locator('.pi-profile-row[data-profile-id="profile-two"]');
    assert.equal(await plain.locator('.pi-health-dot').count(), 0, 'absent health keeps the plain list row');
    assert.ok(!(await plain.innerText()).includes(say('缺少学习模型配置', 'A learning model is not configured')));
    // U2.4: draft skills awaiting review show on the identity row and clicking filters the skills.
    const badge = warned.locator('.pi-profile-drafts');
    assert.ok((await badge.innerText()).includes(say('2 待审', '2 to review')), await badge.innerText());
    assert.equal(await plain.locator('.pi-profile-drafts').count(), 0, 'absent drafts keep the plain list row');
    await badge.click();
    await page.waitForFunction(() => document.querySelectorAll('#pi-profiles-memory .pi-id-entry').length === 1);
    assert.ok((await page.locator('#pi-profiles-memory .pi-id-entry').first().innerText()).includes('draft-skill'));
    assert.deepEqual(errors, []);
    console.log(`PASS learning ui profiles ${width} ${locale}`);
    await context.close();
}

async function runChat(browser, base, width, locale) {
    // Real chat shell: verifies the pi-chat.js wiring (context anchors and transcript placement).
    const context = await browser.newContext({ viewport: { width, height: 820 }, locale, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(), errors = [], writes = [], reloads = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(cwd => { localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'thread-one'); }, '/tmp/chat-knowledge-fixture');
    await page.route('**/api/**', async route => {
        const request = route.request(), url = new URL(request.url()), endpoint = url.pathname;
        const respond = (json, status = 200) => route.fulfill({ json, status });
        if (request.method() !== 'GET') {
            const body = request.postDataJSON(); writes.push({ endpoint, body });
            if (endpoint.endsWith('/knowledge/mutations')) return respond({ version: 1, status: 'saved', revision: 'a'.repeat(64),
                receipt: { id: 'mutated', requestId: body.requestId, operation: body.operation, kind: body.kind, status: 'saved', undoable: false } });
            return respond({ error: 'Unexpected write' }, 400);
        }
        if (endpoint.endsWith('/knowledge')) return respond({ version: 1, status: 'ready', revision: 'a'.repeat(64), items: [], hasMore: false,
            capabilities: { memory: true, skill: true, operations: ['create', 'undo', 'delete'], maxContentLength: 65536 },
            receipts: [
                { id: 'receipt-learning', requestId: 'learning-1', kind: 'memory', operation: 'create', status: 'saved', origin: 'learning',
                    category: 'fact', preview: '记下端口 4321', undoable: true, itemId: 'b'.repeat(64), afterRevision: 'c'.repeat(64),
                    source: { sessionId: 'thread-one', entryId: 'entry-user' } },
                { id: 'receipt-agent', requestId: 'tool-1', kind: 'memory', operation: 'create', status: 'saved', origin: 'agent',
                    category: 'procedure', preview: '用 pnpm 安装', undoable: true, itemId: 'd'.repeat(64), afterRevision: 'e'.repeat(64),
                    source: { sessionId: 'thread-one', entryId: 'entry-reply' } },
                { id: 'receipt-skill', requestId: 'tool-2', kind: 'skill', operation: 'create', status: 'saved', origin: 'learning',
                    preview: 'pnpm-install — 用 pnpm 安装依赖', undoable: false, itemId: 'f'.repeat(64), afterRevision: 'g'.repeat(64), activation: 'reload-required',
                    source: { sessionId: 'thread-one', entryId: 'entry-user' } } ] });
        if (endpoint.endsWith('/learning')) return respond({ version: 1, status: 'ready', revision: 1, settings, jobs: [], recentRuns: [],
            health: { state: 'ok', missingModels: [], lastFailure: null, today: { runs: 0, maxRuns: 4, reservedTokens: 0, maxTokens: 24000 } },
            capabilities: { installed: true, settingsWrite: true, actions: ['save'] } });
        if (endpoint === '/api/pi/status') return respond({ ok: true, agentProfiles: true, profileLearning: true,
            projectRoots: ['/tmp'], defaultProject: '/tmp/chat-knowledge-fixture', runtimeConfiguration: true });
        if (endpoint === '/api/pi/projects') return respond({ projects: [{ cwd: '/tmp/chat-knowledge-fixture', name: 'Fixture', sessionCount: 1 }], roots: ['/tmp'] });
        if (endpoint === '/api/pi/sessions') return respond({ sessions: [{ id: 'thread-one', cwd: '/tmp/chat-knowledge-fixture', name: 'Thread one', messageCount: 2,
            agentProfile: { id: 'profile-one', name: 'Research', enabled: true, available: true } }] });
        if (endpoint === '/api/pi/activity') return respond({ runtimes: [], replyNotices: [] });
        if (endpoint === '/api/pi/profiles') return respond({ version: 1, revision: 'p1', profiles: [{ id: 'profile-one', name: 'Research', enabled: true,
            memory: { enabled: true }, skills: { learnedEnabled: true } }] });
        if (endpoint === '/api/prompts' || endpoint.includes('/history')) return respond([]);
        return respond({});
    });
    const reply = (ws, cmd, data) => ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }));
    await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => {
        const cmd = JSON.parse(raw), model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text'], contextWindow: 128000 };
        const state = { model, thinkingLevel: 'off', isStreaming: false, isCompacting: false, autoCompactionEnabled: true };
        if (cmd.type === 'reload_resources') { reloads.push(cmd.type); return reply(ws, cmd, { commands: [] }); }
        if (cmd.type === 'open_session') return reply(ws, cmd, { session: { id: 'thread-one', cwd: '/tmp/chat-knowledge-fixture', name: 'Thread one',
            agentProfile: { id: 'profile-one', name: 'Research', enabled: true, available: true } }, state,
            messages: { messages: [{ role: 'user', content: 'Fixture question', timestamp: 1 },
                { role: 'assistant', content: [{ type: 'text', text: 'Fixture reply' }], timestamp: 2 }],
                webAnchors: [['entry-user', 'user', 1, ''], ['entry-reply', 'assistant', 2, '']] },
            stats: { totalMessages: 2, contextUsage: { tokens: 0, percent: 0, contextWindow: 128000 } },
            models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } });
        if (cmd.type === 'get_state') return reply(ws, cmd, state);
        if (cmd.type === 'get_messages') return reply(ws, cmd, { messages: [{ role: 'user', content: 'Fixture question', timestamp: 1 },
            { role: 'assistant', content: [{ type: 'text', text: 'Fixture reply' }], timestamp: 2 }],
            webAnchors: [['entry-user', 'user', 1, ''], ['entry-reply', 'assistant', 2, '']] });
        if (cmd.type === 'get_session_stats') return reply(ws, cmd, { totalMessages: 2 });
        if (cmd.type === 'get_runtime_configuration') return reply(ws, cmd, { runtimeId: 'fixture-runtime', revision: 'cfg', agentProfile: {
            saved: { id: 'profile-one', name: 'Research', enabled: true, available: true }, loadedProfileId: 'profile-one', loadedConfirmed: true, matchesSavedProfile: true } });
        return reply(ws, cmd, {});
    }));
    await page.goto(base);
    await page.locator('#pi-input:not([disabled])').waitFor();
    const zh = locale.startsWith('zh');
    const say = (source, english) => zh ? source : english;
    await page.waitForFunction(() => document.querySelectorAll('#pi-transcript-content .pi-memory-hint').length === 3);
    const placed = await page.locator('#pi-transcript-content .pi-memory-hint').evaluateAll(nodes => nodes.map(node => ({
        text: node.textContent, label: node.querySelector('.pi-memory-hint-label')?.textContent,
        group: node.parentElement?.className, previous: node.parentElement?.previousElementSibling?.className })));
    // All hints sit in one group under the turn's user message (tool-call messages fold away), oldest first.
    assert.equal(await page.locator('#pi-transcript-content > .pi-memory-hints').count(), 1);
    assert.ok(placed.every(row => row.group === 'pi-memory-hints' && /pi-message user/.test(row.previous || '')), JSON.stringify(placed));
    assert.ok(placed.some(row => row.label === say('已记住', 'Remembered') && row.text.includes('记下端口 4321')), JSON.stringify(placed));
    assert.ok(placed.some(row => row.label === say('Agent 记下', 'Agent noted') && row.text.includes('用 pnpm 安装')), JSON.stringify(placed));
    assert.ok((await page.locator('#pi-chat-knowledge summary').innerText()).includes(say('本会话已记住 3 条', '3 entries remembered in this session')));
    // U2.4: the learned-skill hint reloads the current chat session through pi-chat.js.
    await page.locator('#pi-transcript-content .pi-memory-hint').filter({ hasText: 'pnpm-install' }).locator('button').filter({ hasText: say('重载会话', 'Reload the session') }).click();
    const reloadEnd = Date.now() + 10000;
    while (Date.now() < reloadEnd && !reloads.length) await page.waitForTimeout(100);
    assert.deepEqual(reloads, ['reload_resources'], 'session reload reaches the native runtime');
    await page.locator('#pi-transcript-content .pi-memory-hint').filter({ hasText: '记下端口 4321' }).locator('button').filter({ hasText: say('撤销', 'Undo') }).click();
    const end = Date.now() + 10000;
    while (Date.now() < end && !writes.some(write => write.body?.operation === 'undo')) await page.waitForTimeout(100);
    const undo = writes.filter(write => write.body?.operation === 'undo').at(-1);
    assert.ok(undo, `undo write missing: ${JSON.stringify(writes)}`);
    assert.equal(undo.body.receiptId, 'receipt-learning');
    const geometry = await page.evaluate(() => ({ width: innerWidth, body: document.documentElement.scrollWidth }));
    assert.ok(geometry.body <= geometry.width + 1, JSON.stringify(geometry));
    assert.deepEqual(errors, []);
    console.log(`PASS learning ui chat ${width} ${locale}: ${JSON.stringify(geometry)}, writes=${writes.length}`);
    await context.close();
}

// Chat injection/project navigation and session-verified project mutations with optional
// proposal/draft metadata. No real profile, native session or provider is used.
async function runWave2(browser, base, width, locale) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale });
    const page = await context.newPage(), errors = [], dialogs = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.accept(); });
    const zh = locale.startsWith('zh'), say = (source, english) => zh ? source : english;
    const item = (letter, revision, content, category = 'fact') => ({ id: hash(letter), kind: 'memory', scope: 'profile', target: 'memory',
        category, state: 'active', revision: hash(revision), content, updatedAt: '2026-01-01' });
    const items = [item('a', '1', 'First source entry'), item('b', '2', 'Second source entry'), item('c', '3', 'Third source entry', 'preference'),
        { id: hash('p'), kind: 'memory', scope: 'project', target: 'project', projectKey: hash('k'), category: 'fact', state: 'active',
            revision: hash('r'), content: 'Project entry', updatedAt: '2026-01-01' },
        { id: hash('d'), kind: 'skill', name: 'draft-skill', description: 'Draft skill', state: 'draft', scope: 'profile', revision: hash('u'), updatedAt: '2026-01-01' },
        { id: hash('e'), kind: 'skill', name: 'active-skill', description: 'Active skill', state: 'active', scope: 'profile', revision: hash('v'), updatedAt: '2026-01-01' }];
    const receipts = [
        { id: 'receipt-hint', requestId: 'learning-1', kind: 'memory', operation: 'create', status: 'saved', origin: 'learning',
            category: 'fact', preview: 'First source entry', undoable: true, itemId: hash('a'), afterRevision: hash('1'),
            source: { sessionId: 'thread-one', entryId: 'entry-user-1' } },
        { id: 'receipt-project-hint', requestId: 'learning-2', kind: 'memory', operation: 'create', status: 'saved', origin: 'agent',
            category: 'fact', preview: 'Project entry', undoable: true, itemId: hash('p'), afterRevision: hash('r'), scope: 'project', projectKey: hash('k'),
            source: { sessionId: 'thread-one', entryId: 'entry-user-2' } },
        { id: 'receipt-skill', requestId: 'tool-9', kind: 'skill', operation: 'create', status: 'saved', origin: 'learning', reason: 'review',
            preview: 'pnpm-install — 用 pnpm 安装依赖', undoable: false, itemId: hash('s'), afterRevision: hash('t'), activation: 'reload-required',
            source: { sessionId: 'thread-one', entryId: 'entry-reply-1' } } ];
    const state = { learningRevision: 1, proposals: undefined, drafts: undefined, usage: { memory: { chars: 13600, limit: 16000 }, user: { chars: 100, limit: 8000 } },
        settings: structuredClone(settings), actions: [], undos: [], mutations: [],
        health: { state: 'ok', missingModels: [], lastFailure: null, today: { runs: 0, maxRuns: 4, reservedTokens: 0, maxTokens: 24000 } } };
    await page.route('**/api/pi/**', async route => {
        const req = route.request(), url = new URL(req.url()), p = url.pathname;
        const fulfill = (body, status = 200) => route.fulfill({ json: body, status });
        const learning = () => ({ version: 1, status: 'ready', revision: state.learningRevision, settings: state.settings,
            jobs: [], recentRuns: [], proposals: state.proposals, drafts: state.drafts,
            health: state.health,
            capabilities: { installed: true, settingsWrite: true, reservedTokensPerRun: 6000, actions: state.actions,
                limits: { maxRunsPerDay: { min: 1, max: 500 }, maxTokensPerDay: { min: 6000, max: 5000000 }, periodicReviewMinutes: { min: 0, max: 10080 } } } });
        const snapshot = () => ({ version: 1, status: 'ready', revision: hash('a'), items, receipts, hasMore: false,
            usage: state.usage, capabilities: { memory: true, skill: true, projectWrites: false, projectWritesBySession: true,
                operations: ['create', 'update', 'delete', 'undo', 'consolidate'], maxContentLength: 65536 } });
        // Exact route: a client URL with a doubled /knowledge segment must miss this mock (the real server 404s).
        if (/^\/api\/pi\/profiles\/[^/]+\/knowledge\/injection$/.test(p) && req.method() === 'GET')
            return fulfill(url.searchParams.get('sessionId')
                ? { version: 1, status: 'ready', block: 'PROFILE BLOCK\nPROJECT BLOCK', chars: 40, entries: 5,
                    profile: { chars: 21, entries: 3 }, project: { chars: 19, entries: 2 },
                    lastRead: { at: '2026-02-01', generation: 1, provided: true, chars: 30, entries: 4 }, truncated: false }
                : { version: 1, status: 'ready', block: 'PROFILE BLOCK TEXT', chars: 21, entries: 3,
                    profile: { chars: 21, entries: 3 }, project: null, lastRead: null });
        if (p.includes('/knowledge/items/') && req.method() === 'GET') {
            const row = items.find(entry => entry.id === p.split('/').pop());
            return fulfill(row ? { version: 1, status: 'ready', item: row } : { version: 1, status: 'missing' });
        }
        if (p.endsWith('/knowledge') && req.method() === 'GET') return fulfill(snapshot());
        if (p.endsWith('/learning') && req.method() === 'GET') return fulfill(learning());
        if (p.endsWith('/knowledge/mutations')) {
            const input = req.postDataJSON();
            if (input.operation === 'undo') { state.undos.push(input); return fulfill({ version: 1, status: 'saved', revision: hash('6'),
                receipt: { id: 'receipt-undo', requestId: input.requestId, operation: 'undo', kind: input.kind, status: 'saved', undoable: false, summary: 'undo memory' } }); }
            if (input.operation === 'update' || input.operation === 'delete') {
                state.mutations.push(input);
                return fulfill({ version: 1, status: 'saved', revision: hash('7'), receipt: { id: 'receipt-project-write', requestId: input.requestId,
                    operation: input.operation, kind: input.kind, status: 'saved', undoable: false, scope: 'project', summary: `${input.operation} memory` } });
            }
            return fulfill({ error: 'unexpected mutation' }, 400);
        }
        return fulfill({ error: 'missing' }, 404);
    });
    await page.goto(`${base}/fixture`);
    const text = selector => page.locator(selector).first().innerText();
    await page.locator('.pi-knowledge-usage').waitFor();
    assert.equal(await page.locator('.pi-knowledge-proposals').count(), 0, 'absent proposals keep the plain display');
    // Proposal generation/apply/staleness and the page injection block are exercised in
    // pi-profile-knowledge.cjs and the real gateway pi-memory-learning-e2e.cjs.
    // The chat card can show this session's injection including the project block and last read.
    await page.locator('#pi-chat-knowledge summary').click();
    await page.locator('.pi-knowledge-entries button').filter({ hasText: say('查看本会话注入内容', "View this session's injected content") }).click();
    await page.waitForFunction(() => Boolean(document.querySelector('.pi-injection-preview pre')));
    const preview = page.locator('.pi-injection-preview');
    const stats = await preview.locator('.pi-injection-stat').evaluateAll(nodes => nodes.map(node => [node.querySelector('span')?.textContent, node.querySelector('strong')?.textContent]));
    assert.deepEqual(stats, [[say('身份记忆', 'Profile memory'), say('3 条 · 21 字', '3 entries · 21 chars')],
        [say('项目记忆', 'Project memory'), say('2 条 · 19 字', '2 entries · 19 chars')],
        [say('上一轮已注入', 'Injected last turn'), say('4 条 · 30 字', '4 entries · 30 chars')]]);
    await preview.locator('summary').click();
    assert.match(await preview.locator('pre').innerText(), /PROJECT BLOCK/);
    const askedInjection = await page.evaluate(() => window.calls.filter(call => call.url.includes('/knowledge/injection')).at(-1));
    assert.ok(askedInjection.url.includes('sessionId=thread-one'), askedInjection.url);
    assert.equal(new URL(askedInjection.url, 'http://fixture').pathname, '/api/pi/profiles/profile-one/knowledge/injection', askedInjection.url);
    // The raw block stays open across re-renders (busy changes re-render the card).
    await page.evaluate(() => window.chat.setBusy(true));
    assert.equal(await preview.locator('details').evaluate(node => node.open), true, 'raw block stays open after a re-render');
    await page.evaluate(() => window.chat.setBusy(false));
    // U2.3: a project hint keeps only the edit entry, and "edit" opens the management page
    // with the session id; the card's project entry does the same.
    const projectHint = page.locator('#pi-transcript-content .pi-memory-hint').filter({ hasText: 'Project entry' });
    assert.equal(await projectHint.locator('button').count(), 1, 'project hints keep only the edit entry');
    await projectHint.locator('button').filter({ hasText: say('编辑', 'Edit') }).click();
    assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), { reveal: ['profile-one', hash('p'), 'memory', 'thread-one'] });
    await page.locator('.pi-knowledge-entries button').filter({ hasText: say('本项目记忆', 'Project memory') }).click();
    assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), { revealProject: ['profile-one', 'thread-one'] });
    // Project write capability is unlocked only by a verified caller session.
    await page.evaluate(() => window.manager.open('profile-one', { view:'memory', target:'project', sessionId:'thread-one' }));
    const projectRow = page.locator('.pi-id-entry').filter({ hasText: 'Project entry' });
    await projectRow.locator('.pi-id-entry-main').click();
    const detail = projectRow.locator('.pi-id-entry-body');
    await detail.getByRole('button', {name:say('编辑','Edit'),exact:true}).waitFor();
    await detail.locator('details[data-detail^=receipts] summary').click();
    await detail.getByRole('button', {name:say('撤销','Undo'),exact:true}).click();
    await page.waitForFunction(() => window.calls.some(call => call.body?.operation === 'undo'));
    const projectUndo = state.undos.at(-1);
    assert.deepEqual(Object.keys(projectUndo).sort(), ['expectedRevision', 'kind', 'operation', 'receiptId', 'requestId', 'scope', 'sessionId']);
    assert.equal(projectUndo.scope, 'project'); assert.equal(projectUndo.sessionId, 'thread-one');
    await projectRow.locator('.pi-id-entry-main').click();
    await detail.getByRole('button', {name:say('编辑','Edit'),exact:true}).click();
    await page.locator('.pi-knowledge-editor textarea').fill('Project entry updated');
    await page.locator('.pi-knowledge-editor button[type=submit]').click();
    await page.waitForFunction(() => window.calls.some(call => call.body?.operation === 'update'));
    const update = state.mutations.at(-1);
    assert.deepEqual(Object.keys(update).sort(), ['category', 'content', 'expectedRevision', 'itemId', 'itemRevision', 'kind', 'operation', 'requestId', 'scope', 'sessionId']);
    assert.equal(update.scope, 'project'); assert.equal(update.sessionId, 'thread-one'); assert.equal(update.projectKey, undefined);
    assert.equal(update.itemId, hash('p')); assert.equal(update.itemRevision, hash('r'));
    await projectRow.locator('.pi-id-entry-main').click();
    await detail.getByRole('button', {name:say('删除','Delete'),exact:true}).click();
    await page.locator('.pi-profile-confirm .settings-primary-button').click();
    await page.waitForFunction(() => window.calls.some(call => call.body?.operation === 'delete'));
    const removal = state.mutations.at(-1);
    assert.deepEqual(Object.keys(removal).sort(), ['expectedRevision', 'itemId', 'itemRevision', 'kind', 'operation', 'requestId', 'scope', 'sessionId']);
    assert.equal(removal.scope, 'project'); assert.equal(removal.sessionId, 'thread-one');
    await page.evaluate(async () => { window.manager.close(); await window.manager.open('profile-one', {view:'memory',target:'project',sessionId:''}); });
    await projectRow.locator('.pi-id-entry-main').click();
    await detail.locator('details[data-detail^=tech]').waitFor();
    assert.equal(await detail.getByRole('button', {name:say('编辑','Edit'),exact:true}).count(), 0);
    assert.equal(await detail.getByRole('button', {name:say('删除','Delete'),exact:true}).count(), 0);
    // U2.4: skill hints offer a session reload that is disabled while the chat is busy.
    await page.evaluate(() => { window.current = { ...window.current, busy: true }; window.chat.update(); });
    const skillHint = page.locator('#pi-transcript-content .pi-memory-hint').filter({ hasText: 'pnpm-install' });
    assert.ok((await skillHint.innerText()).includes(say('需重载会话后生效', 'Reload the session to apply')));
    assert.equal(await skillHint.locator('button').filter({ hasText: say('重载会话', 'Reload the session') }).isDisabled(), true);
    await page.evaluate(() => { window.current = { ...window.current, busy: false }; window.chat.update(); });
    await skillHint.locator('button').filter({ hasText: say('重载会话', 'Reload the session') }).click();
    assert.deepEqual(await page.evaluate(() => window.events.at(-1)), { reload: { sessionId: 'thread-one' } });
    // Draft review belongs to the skills view and shell list (runProfiles), not learning.
    state.drafts = { pending: 2, capped: false };
    await page.evaluate(() => window.manager.open('profile-one', {view:'skills',drafts:true}));
    await page.waitForFunction(() => document.querySelectorAll('#pi-profiles-memory .pi-id-entry').length === 1);
    assert.ok((await text('#pi-profiles-memory')).includes('draft-skill'));
    assert.equal(await page.locator('#pi-profiles-memory [data-value=draft]').getAttribute('aria-pressed'), 'true');
    // Mobile: 16px form controls, no horizontal overflow, no page errors.
    if (width < 900) {
        await page.waitForFunction(() => [...document.querySelectorAll('textarea,input,select')].every(el => parseFloat(getComputedStyle(el).fontSize) >= 16), undefined, { timeout: 5000 }).catch(() => {});
        const sizes = await page.evaluate(() => [...document.querySelectorAll('textarea,input,select')].map(el => [el.tagName.toLowerCase(), parseFloat(getComputedStyle(el).fontSize)]));
        assert.ok(sizes.every(entry => entry[1] >= 16), `mobile form font sizes: ${JSON.stringify(sizes)}`);
    }
    const geometry = await page.evaluate(() => ({ width: innerWidth, body: document.documentElement.scrollWidth }));
    assert.ok(geometry.body <= geometry.width + 1, JSON.stringify(geometry));
    assert.deepEqual(errors, []);
    console.log(`PASS wave2 ui ${width} ${locale}: ${JSON.stringify(geometry)}`);
    await context.close();
}

(async () => {
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
    try {
        for (const [width, locale] of [[393, 'zh-CN'], [1440, 'en-US']]) await runFixture(browser, base, width, locale);
        for (const [width, locale] of [[393, 'zh-CN'], [1440, 'en-US']]) await runProfiles(browser, base, width, locale);
        for (const [width, locale] of [[393, 'zh-CN'], [1440, 'en-US']]) await runChat(browser, base, width, locale);
        for (const [width, locale] of [[393, 'zh-CN'], [1440, 'en-US']]) await runWave2(browser, base, width, locale);
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
