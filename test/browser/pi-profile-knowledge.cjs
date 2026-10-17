const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const app = express(), root = path.resolve(__dirname, '../..');
const catalog = {};
require('node:vm').runInNewContext(fs.readFileSync(path.join(root, 'public/pi-i18n-catalog.js'), 'utf8'), catalog);
const pairs = catalog.PiI18nCatalog;
const hash = n => n.toString(16).padStart(64, '0');
const ids = { user: hash(1), memory: hash(2), memory2: hash(3), project: hash(4), skill: hash(5), draft: hash(6), disabled: hash(7), remote: hash(8), failure: hash(9) };
const stamp = new Date(Date.now() - 3600000).toISOString();
app.use(express.static(path.join(root, 'public')));
app.use('/vendor/marked', express.static(path.join(root, 'node_modules/marked/lib')));
app.use('/vendor/dompurify', express.static(path.join(root, 'node_modules/dompurify/dist')));
app.get('/fixture', (_req, res) => res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/workspace.css"><link rel="stylesheet" href="/brand/fontawesome-6.4.0/css/all.min.css">
<link rel="stylesheet" href="/pi-identity-ui.css"><link rel="stylesheet" href="/pi-profile-knowledge.css">
<style>html,body{margin:0;height:100%;font-family:Inter,system-ui,sans-serif}main{width:100%;min-width:0;height:100%;display:flex;flex-direction:column;background:var(--surface-1)}#scroll{flex:1;min-height:0;overflow:auto;position:relative}.fixture-nav{display:flex;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line)}</style></head><body>
<main class="pi-id-root"><nav class="fixture-nav"><button id="memory" class="pi-id-btn">记忆</button><button id="skills" class="pi-id-btn">技能</button></nav><div id="scroll"><section class="pi-id-page" id="knowledge"></section></div></main>
<script src="/vendor/marked/marked.umd.js"></script><script src="/vendor/dompurify/purify.min.js"></script>
<script src="/pi-i18n-catalog.js"></script><script src="/pi-i18n.js"></script><script src="/pi-profile-dialog.js"></script><script src="/pi-identity-ui.js"></script><script src="/pi-profile-knowledge.js"></script>
<script>window.profile={id:'profile-one',enabled:true,memory:{enabled:true,userCharLimit:8000,memoryCharLimit:16000},skills:{learnedEnabled:true}};
window.api=async(url,options)=>{const response=await fetch(url,options);const data=await response.json();if(!response.ok){const error=new Error(data.error||response.statusText);error.status=response.status;error.data=data;throw error;}return data};
window.toaster=PiIdentityUI.createToaster(document.querySelector('main'));window.badges={};window.routes=[];window.PiWorkspaceRoute={navigate:(...args)=>routes.push(args)};
window.manager=PiProfileKnowledge.create({apiFetch:api,root:document.getElementById('knowledge'),ui:{toast:toaster.show,confirm:PiProfileDialog.confirm,profile:()=>profile,setBadge:(key,value)=>badges[key]=value,navigate:(...args)=>routes.push(args),scroller:document.getElementById('scroll')}});
document.getElementById('memory').onclick=()=>manager.open(profile.id,{view:'memory'});document.getElementById('skills').onclick=()=>manager.open(profile.id,{view:'skills'});manager.open(profile.id,{view:'memory',target:'memory'});</script></body></html>`));
async function run(browser, base, width, locale, theme) {
    const context = await browser.newContext({ viewport: { width, height: 960 }, locale, colorScheme: theme === 'dark' ? 'dark' : 'light' });
    const page = await context.newPage(), errors = [], calls = [], reads = [];
    const en = locale.startsWith('en'), translations = new Map(pairs);
    const T = (s, ...args) => (en ? translations.get(s) || s : s).replace(/\{(\d+)\}/g, (_, index) => args[index]);
    const button = (scope, s) => scope.getByRole('button', { name: T(s), exact: true });
    const main = page.locator('#knowledge'), entry = id => main.locator(`.pi-id-entry[data-item-id="${id}"]`);
    const shotDir = process.env.PIVANE_TEST_SCREENSHOT_DIR;
    const screenshots = [];
    async function shot(name) {
        await page.evaluate(() => { toaster.clear(); return document.fonts.ready; });
        const dimensions = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth,
            offenders: [...document.querySelectorAll('#knowledge, #knowledge *')].filter(el => el.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(el).position !== 'absolute' && getComputedStyle(el).visibility !== 'hidden').slice(0, 10).map(el => [el.className, el.textContent.slice(0, 50)]) }));
        assert.ok(dimensions.document <= width + 1, JSON.stringify(dimensions));
        assert.deepEqual(dimensions.offenders, [], JSON.stringify(dimensions));
        if (width <= 680) {
            const sizes = await main.locator('input:not([type=checkbox]),textarea,select').evaluateAll(nodes => nodes.map(el => [el.tagName, getComputedStyle(el).fontSize]));
            assert.ok(sizes.every(([, size]) => parseFloat(size) >= 16), JSON.stringify(sizes));
        }
        if (shotDir) {
            fs.mkdirSync(shotDir, { recursive: true });
            const file = path.join(shotDir, `${name}-${width}-${locale}-${theme}.png`);
            await page.screenshot({ path: file, fullPage: true }); screenshots.push(file);
        }
    }
    const memory = (id, content, category, target = 'memory', scope = 'profile') => ({ id, kind: 'memory', content, category, target, scope, state: 'active', revision: hash(10), updatedAt: stamp });
    const skill = (id, name, state) => ({ id, kind: 'skill', name, description: 'A reusable approach for careful research and clear collaboration.', content: `---\nname: ${name}\ndescription: A reusable approach for careful research and clear collaboration.\n---\n# Research workflow\n\nCompare **sources** before writing.\n\n<script>window.unsafe=true</script>`, state, scope: 'profile', revision: hash(10), updatedAt: stamp });
    const state = { rev: 20, status: 'ready', filters: true, counts: true, receipts: [], fail: '', learnedRevision: 1, proposals: [], projectWrites: false,
        documentRevision: { user: 1, memory: 1 }, profileRevision: hash(200), documentText: { user: '# About you\n\nPrefers clear examples.', memory: '# Long-term memory\n\nReferences are kept in Zotero.\n§\nKeep an explicit research log.' },
        mutationHeld: false, mutationStarted: null, releaseMutation: null, actionHeld: false, actionStarted: null, releaseAction: null, actionFail: false,
        documentHeld: false, documentStarted: null, releaseDocument: null,
        documentReadFail: false, detailFailure: '', delayedDetail: false, detailStarted: null, releaseDetail: null, documentFail: '', indexPending: false, documentStatus: 'ready', delayedRead: false, releaseRead: null, delayStarted: null,
        items: [memory(ids.user, '喜欢先了解整体思路，再逐步展开细节；讨论学习问题时，请给出一个具体例子。', 'preference', 'user'),
            memory(ids.memory, '项目“研究笔记”的参考资料统一放在 Zotero 的 Research 文件夹，引用格式使用 APA 第 7 版。', 'fact'),
            memory(ids.memory2, '整理周报：先列完成事项，再列风险和下周计划，每项不超过两行。', 'procedure'),
            { ...memory(ids.failure, 'Legacy failure kept for reference.', 'failure', 'failure'), readOnly: true },
            memory(ids.project, 'Project-specific build steps.', 'procedure', 'project', 'project'), skill(ids.skill, 'source-review', 'active'), skill(ids.draft, 'research-notes', 'draft'), skill(ids.disabled, 'weekly-report', 'disabled')],
        remote: memory(ids.remote, 'This entry was not on the first page.', 'correction', 'user'), undo: new Map() };
    const document = key => ({ status: state.documentStatus, target: key, content: state.documentText[key], revision: hash(100 + state.documentRevision[key]), profileRevision: state.profileRevision,
        usage: { used: state.documentText[key].length, limit: key === 'user' ? 8000 : 16000 }, indexStatus: state.indexPending ? 'pending' : 'ready', indexSynced: !state.indexPending });
    const learning = () => ({ version: 1, status: 'ready', revision: state.learnedRevision, settings: { enabled: true }, drafts: { pending: state.items.filter(item => item.state === 'draft').length },
        proposals: state.proposals, capabilities: { actions: ['propose-consolidation', 'dismiss-proposal'] } });
    function record(input) {
        const existing = state.items.find(item => item.id === input.itemId);
        if (existing && input.itemRevision) assert.equal(input.itemRevision, existing.revision, 'item CAS');
        const before = existing ? structuredClone(existing) : null;
        let item = existing;
        if (input.operation === 'create') { item = { ...memory(hash(50 + calls.length), input.content, input.category, input.target, input.scope), kind: input.kind, name: input.name, description: input.description }; state.items.unshift(item); }
        if (input.operation === 'consolidate') {
            for (const source of input.items) {
                const old = state.items.find(row => row.id === source.itemId); assert.equal(old.revision, source.itemRevision); old.state = 'deleted';
            }
            item = memory(hash(50 + calls.length), input.content, input.category, input.target); state.items.unshift(item);
        }
        if (input.operation === 'update') Object.assign(item, { content: input.content, category: input.category || item.category, name: input.name || item.name, description: input.description || item.description });
        if (['delete', 'restore', 'enable', 'disable'].includes(input.operation)) item.state = { delete: 'deleted', restore: 'active', enable: 'active', disable: 'disabled' }[input.operation];
        if (input.operation === 'undo') {
            const change = state.undo.get(input.receiptId);
            assert.ok(change, 'undo must refer to a recorded receipt');
            if (change.before) { state.items = state.items.filter(item => item.id !== change.itemId); state.items.unshift(change.before); item = change.before; }
            else { state.items = state.items.filter(item => item.id !== change.itemId); item = null; }
        }
        state.rev++;
        if (item) item.revision = hash(state.rev + 300);
        const receipt = { id: `receipt-${calls.length}`, requestId: input.requestId, kind: input.kind, operation: input.operation, status: 'saved', itemId: item?.id || input.itemId,
            scope: item?.scope || input.scope, afterRevision: item?.revision, at: stamp, indexStatus: 'ready', undoable: input.operation !== 'undo', activation: input.kind === 'skill' ? 'reload-required' : 'next-turn' };
        state.undo.set(receipt.id, { before, itemId: item?.id }); state.receipts.unshift(receipt); return receipt;
    }
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/pi/profiles/**', async route => {
        const req = route.request(), url = new URL(req.url()), pathname = url.pathname;
        const fulfill = (body, status = 200) => route.fulfill({ json: body, status });
        if (pathname.endsWith('/knowledge')) {
            reads.push(Object.fromEntries(url.searchParams));
            let items = state.items.filter(item => item.kind === url.searchParams.get('kind'));
            items = items.filter(item => url.searchParams.get('state') === 'deleted' ? item.state === 'deleted' : url.searchParams.get('state') === 'draft' ? item.state === 'draft' : item.state !== 'deleted');
            if (state.filters && url.searchParams.get('target')) items = items.filter(item => (item.scope === 'project' ? 'project' : item.target === 'user' ? 'user' : 'memory') === url.searchParams.get('target'));
            if (state.filters && url.searchParams.get('category')) items = items.filter(item => item.category === url.searchParams.get('category'));
            if (url.searchParams.get('query')) items = items.filter(item => (item.content + item.name).toLowerCase().includes(url.searchParams.get('query').toLowerCase()));
            const counts = { memory: { total: 5, user: 1, memory: 3, project: 1, deleted: 0 }, skill: { total: 3, active: 1, draft: state.items.filter(item => item.state === 'draft').length, disabled: 1, deleted: 0 } };
            return fulfill({ version: 1, status: state.status, revision: state.status === 'ready' ? hash(state.rev) : null, items, hasMore: false, receipts: state.receipts,
                ...(state.counts ? { counts } : {}), usage: { user: { chars: 1200, limit: 8000 }, memory: { chars: 13800, limit: 16000 } },
                capabilities: { memory: true, skill: true, operations: ['create', 'update', 'delete', 'restore', 'undo', 'enable', 'disable', 'consolidate'], projectWritesBySession: state.projectWrites,
                    projectSkillDeletesBySession: true, maxContentLength: 65536, skillNameMaxLength: 64 } });
        }
        if (pathname.includes('/knowledge/items/')) {
            const id = pathname.split('/').at(-1), item = state.items.find(item => item.id === id) || (id === ids.remote ? state.remote : null);
            if (state.detailFailure) {
                const failure = state.detailFailure; state.detailFailure = '';
                return failure === 'missing' ? fulfill({version:1,status:'missing'}) : fulfill({error:'Synthetic detail read failure'},500);
            }
            if (state.delayedDetail) { state.delayedDetail = false; state.detailStarted?.(); await new Promise(resolve => { state.releaseDetail = resolve; }); }
            return item ? fulfill({ version: 1, status: 'ready', item }) : fulfill({ error: 'Missing' }, 404);
        }
        if (pathname.endsWith('/knowledge/injection')) return fulfill({ version: 1, status: 'ready', profile: { entries: 3, chars: 1200 }, block: 'USER.md\nPrefers examples.\n\nMEMORY.md\nResearch references.', truncated: true });
        if (pathname.endsWith('/learning/actions')) {
            const input = req.postDataJSON(); calls.push(input); assert.ok(['propose-consolidation', 'dismiss-proposal'].includes(input.action));
            if (state.actionHeld) { state.actionHeld = false; state.actionStarted?.(); await new Promise(resolve => { state.releaseAction = resolve; }); }
            if (state.actionFail) { state.actionFail = false; return route.abort('failed'); }
            if (input.action === 'dismiss-proposal') state.proposals = []; state.learnedRevision++; return fulfill(learning());
        }
        if (pathname.endsWith('/learning')) { assert.equal(req.method(), 'GET', 'F2 must never save learning settings'); return fulfill(learning()); }
        if (pathname.endsWith('/documents')) {
            if (req.method() === 'GET') {
                if (state.documentReadFail) { state.documentReadFail = false; return fulfill({error:'Synthetic document read failure'},500); }
                const data = document(url.searchParams.get('target'));
                if (state.delayedRead) { state.delayedRead = false; state.delayStarted?.(); await new Promise(resolve => { state.releaseRead = resolve; }); }
                return fulfill(data);
            }
            const input = req.postDataJSON(); calls.push(input);
            assert.equal(input.expectedProfileRevision, state.profileRevision, 'document profile CAS');
            if (state.documentFail === 'conflict') { state.documentFail = ''; state.documentRevision[input.target]++; state.documentText[input.target] = '# Changed on server'; return fulfill({ error: 'Conflict' }, 409); }
            assert.equal(input.expectedRevision, hash(100 + state.documentRevision[input.target]), 'document CAS');
            if (state.documentHeld) { state.documentHeld = false; state.documentStarted?.(); await new Promise(resolve => { state.releaseDocument = resolve; }); }
            state.documentText[input.target] = input.content; state.documentRevision[input.target]++;
            if (state.documentFail === 'pending') { state.documentFail = ''; state.indexPending = true; return fulfill({ error: 'Index pending', documentSaved: true, indexSynced: false, document: document(input.target) }, 503); }
            state.indexPending = false; return fulfill(document(input.target));
        }
        if (pathname.endsWith('/knowledge/mutations')) {
            const input = req.postDataJSON(); calls.push(input);
            assert.equal(input.expectedRevision, hash(state.rev), 'snapshot CAS');
            assert.equal(input.source, undefined); assert.equal(input.projectKey, undefined);
            if (input.scope === 'project') assert.equal(input.sessionId, 'verified-thread');
            if (state.fail === 'rejected') { state.fail = ''; return fulfill({ error: 'Invalid content' }, 400); }
            if (state.fail === 'conflict') {
                state.fail = ''; state.rev++; const item = state.items.find(item => item.id === input.itemId); if (item) { item.revision = hash(900); item.content = 'Changed server content'; }
                return fulfill({ error: 'Conflict' }, 409);
            }
            if (state.mutationHeld) { state.mutationHeld = false; state.mutationStarted?.(); await new Promise(resolve => { state.releaseMutation = resolve; }); }
            const receipt = record(input);
            if (state.fail === 'uncertain') { state.fail = ''; return route.abort('failed'); }
            return fulfill({ version: 1, status: 'saved', revision: hash(state.rev), receipt });
        }
        return fulfill({ error: pathname }, 404);
    });
    await page.goto(`${base}/fixture`); await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await entry(ids.memory).waitFor(); await shot('memory-entries');
    // Legacy failures belong to MEMORY and never expose mutation controls.
    await entry(ids.failure).waitFor();
    assert.equal(await main.locator('.pi-knowledge-target-row [data-value=memory]').getAttribute('aria-pressed'), 'true');
    assert.ok((await entry(ids.failure).innerText()).includes(T('只读')));
    assert.equal(await entry(ids.failure).locator('.pi-id-entry-actions button').count(), 0);
    await entry(ids.failure).locator('.pi-id-entry-main').click();
    await button(entry(ids.failure), '收起详情').waitFor();
    assert.equal(await button(entry(ids.failure), '编辑').count(), 0);
    assert.equal(await button(entry(ids.failure), '删除').count(), 0);
    await entry(ids.failure).locator('.pi-id-entry-main').click();
    if (width === 393) {
        const actions = await main.locator('.pi-id-entry-actions .pi-id-btn-sm').evaluateAll(nodes => nodes.map(node => {
            const rect = node.getBoundingClientRect(); return { width: rect.width, height: rect.height };
        }));
        assert.ok(actions.length > 0, 'compact entry actions are present');
        assert.ok(actions.every(rect => rect.width >= 40 && rect.height >= 40), JSON.stringify(actions));
        for (const label of ['显示方式', '类别']) {
            const heights = await main.getByRole('group', { name: T(label), exact: true }).locator('.pi-id-seg-item').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
            assert.ok(heights.length > 0, `${label} segmented buttons are present`);
            assert.ok(heights.every(height => height >= 40), `${label}: ${JSON.stringify(heights)}`);
        }
        await page.evaluate(() => manager.open('profile-one', { view: 'skills' }));
        const skillFilterHeights = await main.getByRole('group', { name: T('技能状态'), exact: true }).locator('.pi-id-seg-item').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
        assert.equal(skillFilterHeights.length, 4, 'all skill-state filter buttons are present');
        assert.ok(skillFilterHeights.every(height => height >= 40), JSON.stringify(skillFilterHeights));
        await page.evaluate(() => manager.open('profile-one', { view: 'memory', target: 'memory' }));
    }
    await button(main.locator('.pi-knowledge-usage'), '整理合并').click();
    await page.waitForFunction(() => !manager.busy());
    assert.equal(calls.at(-1).action, 'propose-consolidation');
    assert.equal(calls.at(-1).target, 'memory');
    assert.equal(typeof calls.at(-1).requestId, 'string');
    // Refresh advances the learning epoch, but a failed in-flight action must retain its request ID.
    const actionStarted = new Promise(resolve => { state.actionStarted = resolve; });
    state.actionHeld = true; state.actionFail = true;
    await button(main.locator('.pi-knowledge-usage'), '整理合并').click(); await actionStarted;
    const actionRequest = calls.at(-1).requestId, actionCalls = calls.length;
    await page.evaluate(() => manager.refresh());
    state.releaseAction(); await page.waitForFunction(() => !manager.busy());
    await main.getByText(T('作业请求 {0} 结果未确认；请先核对作业列表，勿重复提交。', actionRequest), { exact: true }).waitFor();
    assert.equal(await button(main.locator('.pi-knowledge-usage'), '整理合并').isDisabled(), true);
    await page.evaluate(() => manager.refresh());
    assert.equal(await button(main.locator('.pi-knowledge-usage'), '整理合并').isDisabled(), true);
    assert.equal(calls.length, actionCalls, 'refresh never retries an uncertain learning action');
    await button(main, '已核对作业列表').click();
    assert.equal(await button(main.locator('.pi-knowledge-usage'), '整理合并').isEnabled(), true);
    // A MEMORY submission owns its view while pending and can only clear its own composer.
    for (const outcome of ['saved', 'uncertain']) {
        const skillDraft = `# Keep unrelated skill draft after ${outcome}`;
        const memoryDraft = `MEMORY create with ${outcome} response`;
        await page.evaluate(() => manager.open('profile-one', { view: 'skills' }));
        await main.locator('.pi-knowledge-add').click();
        await main.locator('[data-focus=entry-name]').fill('pending-memory-skill');
        await main.locator('[data-focus=entry-description]').fill('An unrelated unsaved skill.');
        if (outcome === 'saved') {
            // Pi selects skills by description; the editor allows Pi's full 1024-character limit and says so.
            assert.equal(await main.locator('[data-focus=entry-description]').evaluate(el => el.maxLength), 1024);
            assert.ok(await main.locator('.pi-knowledge-editor .pi-id-help', { hasText: T('Pi 只按描述决定何时使用技能：写清用途，以及会触发它的说法、报错或场景') }).isVisible());
            await shot('skill-editor-description');
        }
        await main.locator('.pi-knowledge-editor textarea').fill(skillDraft);
        await page.evaluate(() => manager.open('profile-one', { view: 'memory', target: 'memory', mode: 'entries' }));
        await main.locator('.pi-knowledge-add').click();
        await main.locator('.pi-knowledge-editor textarea').fill(memoryDraft);
        const mutationStarted = new Promise(resolve => { state.mutationStarted = resolve; });
        state.mutationHeld = true; state.fail = outcome === 'uncertain' ? 'uncertain' : '';
        await main.locator('.pi-knowledge-editor button[type=submit]').click(); await mutationStarted;
        const request = calls.at(-1), submissionCount = calls.length;
        assert.equal(request.kind, 'memory'); assert.equal(request.target, 'memory'); assert.equal(request.content, memoryDraft);
        await page.evaluate(() => manager.open('profile-one', { view: 'skills' }));
        assert.equal(await main.getAttribute('data-view'), 'memory', 'pending MEMORY submission blocks skills open');
        await page.evaluate(() => manager.open('profile-one', { view: 'memory', target: 'user', mode: 'document' }));
        assert.equal(await main.getAttribute('data-view'), 'memory');
        assert.equal(await main.locator('.pi-knowledge-target-row [data-value=memory]').getAttribute('aria-pressed'), 'true');
        assert.equal(await main.locator('.pi-id-page-head [data-value=entries]').getAttribute('aria-pressed'), 'true');
        assert.equal(await main.locator('.pi-knowledge-editor textarea').inputValue(), memoryDraft);
        state.releaseMutation(); await page.waitForFunction(() => !manager.busy());
        if (outcome === 'uncertain') {
            await main.getByText(T('提交结果未确认；请求 ID {0} 已保留，请勿重复提交。', request.requestId), { exact: true }).waitFor();
            const receipts = state.receipts; state.receipts = [];
            await page.evaluate(() => manager.open('profile-one', { view: 'skills' }));
            assert.equal(await main.locator('.pi-knowledge-editor textarea').inputValue(), skillDraft);
            await page.evaluate(() => manager.open('profile-one', { view: 'memory', target: 'memory' }));
            assert.equal(await main.locator('.pi-knowledge-editor textarea').inputValue(), memoryDraft, 'uncertainty retains the MEMORY composer');
            await page.evaluate(() => manager.open('profile-one', { view: 'skills' }));
            state.receipts = receipts; await page.evaluate(() => manager.refresh());
            assert.equal(await main.locator('.pi-knowledge-editor textarea').inputValue(), skillDraft, 'MEMORY receipt never clears the skill draft');
            await page.evaluate(() => manager.open('profile-one', { view: 'memory', target: 'memory' }));
        } else {
            await main.locator('.pi-knowledge-editor').waitFor({ state: 'hidden' });
        }
        assert.equal(await main.locator('.pi-knowledge-editor').count(), 0, 'confirmed receipt clears only the MEMORY draft');
        await page.evaluate(() => manager.open('profile-one', { view: 'skills' }));
        assert.equal(await main.locator('.pi-knowledge-editor textarea').inputValue(), skillDraft);
        assert.equal(await main.locator('[data-focus=entry-name]').inputValue(), 'pending-memory-skill');
        assert.equal(await main.locator('[data-focus=entry-description]').inputValue(), 'An unrelated unsaved skill.');
        assert.equal(calls.length, submissionCount, 'view changes and reconciliation never replay the mutation');
        assert.deepEqual(errors, [], `no pageerror after ${outcome} MEMORY response`);
        await page.evaluate(() => manager.discardChanges());
    }
    // A reveal detail response arriving after a view switch must not enter the skills list.
    await page.evaluate(() => manager.open('profile-one', { view: 'memory', target: 'memory' }));
    const revealStarted = new Promise(resolve => { state.detailStarted = resolve; }); state.delayedDetail = true;
    await page.evaluate(itemId => { window.pendingReveal = manager.reveal(itemId, 'memory'); }, ids.remote); await revealStarted;
    await page.evaluate(() => manager.open('profile-one', { view: 'skills' }));
    state.releaseDetail(); await page.evaluate(() => window.pendingReveal);
    assert.equal(await main.getAttribute('data-view'), 'skills');
    assert.equal(await entry(ids.remote).count(), 0, 'late MEMORY reveal cannot prepend itself to skills');
    assert.deepEqual(await main.locator('.pi-id-entry').evaluateAll(nodes => nodes.map(node => node.dataset.itemId).sort()), [ids.skill, ids.draft, ids.disabled].sort());
    await page.evaluate(() => manager.open('profile-one', { view: 'memory', target: 'memory' }));
    await main.locator('.pi-knowledge-injection summary').click();
    assert.match(await main.locator('.pi-knowledge-injection pre').innerText(), /USER.md[\s\S]*MEMORY.md/);
    assert.ok((await main.locator('.pi-knowledge-injection').innerText()).includes(T('身份记忆：{0} 条 / {1} 字', '3', '1,200')));
    assert.ok((await main.locator('.pi-knowledge-injection').innerText()).includes(T('注入不代表模型一定遵守。')));
    await main.locator('.pi-knowledge-injection summary').click();
    assert.equal(await main.locator('.pi-knowledge-pages').count(), 0, 'no redundant pagination');
    assert.equal(await main.locator('.pi-learning-settings,.pi-learning-job').count(), 0, 'learning UI removed');
    await entry(ids.memory).locator('.pi-id-entry-main').click(); await entry(ids.memory).locator('.pi-id-entry-body').waitFor();
    await button(entry(ids.memory), '编辑').waitFor(); await shot('memory-open');
    await button(entry(ids.memory), '编辑').click(); await main.locator('.pi-knowledge-editor textarea').fill('Keep this draft through a conflict.');
    state.fail = 'conflict'; await main.locator('.pi-knowledge-editor button[type=submit]').click();
    await main.locator('.pi-knowledge-editor input[type=checkbox]').waitFor();
    assert.equal(await main.locator('.pi-knowledge-editor textarea').inputValue(), 'Keep this draft through a conflict.');
    assert.equal(await main.locator('.pi-knowledge-editor button[type=submit]').isDisabled(), true);
    await main.locator('.pi-knowledge-editor input[type=checkbox]').check();
    await main.locator('.pi-knowledge-editor button[type=submit]').click();
    await main.locator('.pi-knowledge-editor').waitFor({ state: 'hidden' }); assert.equal(calls.at(-1).itemRevision, hash(900));
    await main.locator('.pi-knowledge-receipt').waitFor(); await button(main.locator('.pi-knowledge-receipt'), '撤销').click();
    await page.waitForFunction(() => !manager.busy()); assert.equal(calls.at(-1).operation, 'undo');
    await entry(ids.memory).locator('.pi-id-entry-main').click(); await button(entry(ids.memory), '删除').click();
    await page.locator('.pi-profile-confirm[open]').waitFor(); await page.keyboard.press('Escape');
    const mutationsBeforeDelete = calls.length;
    await button(entry(ids.memory), '删除').click(); await page.locator('.pi-profile-confirm .settings-primary-button').click();
    await entry(ids.memory).waitFor({ state: 'hidden' }); assert.equal(calls.length, mutationsBeforeDelete + 1);
    await main.locator('.pi-knowledge-trash').click(); await entry(ids.memory).waitFor();
    await button(entry(ids.memory), '恢复').click(); await entry(ids.memory).waitFor({ state: 'hidden' });
    assert.equal(calls.at(-1).operation, 'restore'); await main.locator('.pi-knowledge-trash').click();
    await main.locator('.pi-knowledge-target-row [data-value=user]').click(); await entry(ids.user).waitFor();
    await main.locator('.pi-knowledge-add').click(); await main.locator('.pi-knowledge-editor textarea').fill('New USER preference'); await shot('memory-composer');
    await button(main.locator('.pi-knowledge-editor'), '取消').click(); await page.locator('.pi-profile-confirm[open]').waitFor(); await page.keyboard.press('Escape');
    assert.equal(await main.locator('.pi-knowledge-editor textarea').inputValue(), 'New USER preference', 'cancelled discard keeps composer');
    await page.evaluate(async () => { await manager.open('profile-one', {view:'skills'}); manager.close(); await manager.open('profile-two', {view:'skills'}); manager.close(); await manager.open('profile-one', {view:'memory',target:'user'}); });
    assert.equal(await main.locator('.pi-knowledge-editor textarea').inputValue(), 'New USER preference', 'per-profile composer survives close/open and other views');
    state.fail = 'rejected'; await main.locator('.pi-knowledge-editor button[type=submit]').click();
    await main.getByText(T('提交被服务端拒绝：{0}，草稿已保留。', 'Invalid content'), { exact: true }).waitFor();
    assert.equal(await main.locator('.pi-knowledge-editor textarea').inputValue(), 'New USER preference');
    state.fail = 'uncertain'; await main.locator('.pi-knowledge-editor button[type=submit]').click();
    await button(main, '刷新回执核对').waitFor(); const uncertainRequest = calls.at(-1).requestId, submitted = calls.length;
    assert.equal(calls.at(-1).target, 'user');
    const committedReceipts = state.receipts; state.receipts = [];
    await page.evaluate(async () => { manager.close(); await manager.open('profile-two', { view: 'skills' }); manager.close(); await manager.open('profile-one', { view: 'skills' }); });
    assert.equal(calls.length, submitted, 'uncertain operation is never replayed while another view is open');
    state.receipts = committedReceipts; await page.evaluate(() => manager.refresh());
    await page.evaluate(() => manager.open('profile-one', { view: 'memory', target: 'user' }));
    await main.locator('.pi-knowledge-editor').waitFor({ state: 'hidden' });
    assert.equal(calls.length, submitted, 'uncertain operation is reconciled by receipt without replay');
    assert.equal(state.receipts.find(receipt => receipt.requestId === uncertainRequest).status, 'saved');
    // Old servers may ignore target/category and omit counts. Client filtering remains bounded to the returned page.
    state.filters = false; state.counts = false;
    await page.evaluate(() => manager.refresh()); await main.locator('.pi-knowledge-target-row [data-value=memory]').click();
    await entry(ids.memory2).waitFor(); await main.locator('.pi-id-toolbar [data-value=procedure]').click();
    await page.waitForFunction(() => document.querySelectorAll('#knowledge .pi-id-entry').length === 1);
    assert.equal(reads.at(-1).category, 'procedure'); assert.equal(await main.locator('.pi-knowledge-target-row .pi-id-seg-count').count(), 0);
    const search = main.locator('input[type=search]'); await search.fill('weekly'); await page.waitForTimeout(350);
    assert.equal(reads.at(-1).query, 'weekly'); await search.fill(''); await page.waitForTimeout(350);
    await main.locator('.pi-id-toolbar [data-value=all]').click(); state.filters = true; state.counts = true;
    await page.evaluate(() => manager.reveal('0000000000000000000000000000000000000000000000000000000000000008', 'memory'));
    await entry(ids.remote).locator('.pi-id-entry-body').waitFor(); assert.equal(await main.locator('.pi-knowledge-target-row [data-value=user]').getAttribute('aria-pressed'), 'true');
    await page.evaluate(() => manager.open('profile-one', { view: 'memory', target: 'project' }));
    assert.equal(await main.locator('.pi-knowledge-add').isDisabled(), true);
    assert.equal(await main.locator('.pi-id-page-head [data-value=document]').isDisabled(), true);
    state.projectWrites = true;
    await page.evaluate(() => manager.open('profile-one', { view: 'memory', target: 'project', sessionId: 'verified-thread' }));
    await main.locator('.pi-knowledge-add').click(); await main.locator('.pi-knowledge-editor textarea').fill('Verified project memory');
    await main.locator('.pi-knowledge-editor button[type=submit]').click(); await main.locator('.pi-knowledge-editor').waitFor({ state: 'hidden' });
    assert.equal(calls.at(-1).sessionId, 'verified-thread'); assert.equal(calls.at(-1).target, undefined);
    await page.evaluate(() => manager.open('profile-one', { view: 'memory', target: 'memory', mode: 'document' }));
    const docText = main.locator('.pi-id-editor-text'); await docText.waitFor(); await shot('memory-full-text');
    assert.equal(await docText.inputValue(), state.documentText.memory, 'MEMORY full document loads');
    await docText.fill('# Unsaved document'); assert.equal(await page.evaluate(() => manager.dirty()), true);
    await page.locator('#skills').click(); await entry(ids.skill).waitFor(); await page.locator('#memory').click();
    assert.equal(await docText.inputValue(), '# Unsaved document', 'tab switches retain full-text drafts');
    state.documentFail = 'conflict'; await button(main.locator('.pi-id-savebar'), '保存文档').click();
    await main.getByText(T('文档已变化。草稿已保留；请重新读取并核对。'), { exact: true }).waitFor();
    await button(main.locator('.pi-id-editor-tools'), '从服务器重新读取').click();
    await main.locator('.pi-knowledge-document-reviewed').waitFor();
    await main.locator('details[data-detail^=server]').evaluate(el => { el.open = true; });
    assert.equal(await main.locator('details[data-detail^=server] pre').innerText(), '# Changed on server');
    assert.equal(await docText.inputValue(), '# Unsaved document', 'conflict refresh preserves the document draft');
    await main.locator('.pi-knowledge-document-reviewed').scrollIntoViewIfNeeded(); await shot('memory-conflict');
    assert.equal(await button(main.locator('.pi-id-savebar'), '保存文档').isDisabled(), true);
    await main.locator('.pi-knowledge-document-reviewed').check(); await page.keyboard.press('Control+s');
    await page.waitForFunction(() => !manager.dirty());
    assert.equal(state.documentText.memory, '# Unsaved document');
    await docText.fill('# Published, index pending'); state.documentFail = 'pending'; await page.keyboard.press('Control+s');
    await main.locator('.pi-knowledge-document-sync').waitFor(); assert.equal(await page.evaluate(() => manager.dirty()), false);
    await docText.fill('# Keep draft during sync');
    await page.evaluate(() => manager.refresh());
    assert.equal(await docText.inputValue(), '# Keep draft during sync', 'index-pending refresh retains local document input');
    await main.locator('.pi-knowledge-document-sync').click();
    await main.locator('.pi-knowledge-document-sync').waitFor({ state: 'hidden' });
    assert.equal(await docText.inputValue(), '# Keep draft during sync');
    await main.locator('.pi-knowledge-document-reviewed').check(); await page.keyboard.press('Control+s'); await page.waitForFunction(() => !manager.dirty());
    // A stale read must not replace typing that occurs while the request is in flight.
    await docText.fill('# Input before read'); const started = new Promise(resolve => { state.delayStarted = resolve; }); state.delayedRead = true;
    await button(main.locator('.pi-id-editor-tools'), '从服务器重新读取').click(); await started;
    await docText.fill('# Input during read'); state.releaseRead(); await page.waitForTimeout(40);
    assert.equal(await docText.inputValue(), '# Input during read');
    await page.evaluate(() => manager.discardChanges());
    // A refresh begun before a save must not restore the older server body or revision.
    const beforeSaveRead = new Promise(resolve => { state.delayStarted = resolve; }); state.delayedRead = true;
    await button(main.locator('.pi-id-editor-tools'), '从服务器重新读取').click(); await beforeSaveRead;
    await docText.fill('# Saved while old read is pending'); await page.keyboard.press('Control+s');
    await page.waitForFunction(() => !manager.dirty());
    state.releaseRead(); await page.waitForTimeout(40);
    assert.equal(await docText.inputValue(), '# Saved while old read is pending');
    assert.equal(state.documentText.memory, '# Saved while old read is pending');
    // Failed refreshes keep both the editor and its unsaved input usable.
    await docText.fill('# Retain after failed read'); state.documentReadFail = true;
    await button(main.locator('.pi-id-editor-tools'), '从服务器重新读取').click();
    await main.getByText('Synthetic document read failure', {exact:true}).waitFor();
    assert.equal(await docText.inputValue(), '# Retain after failed read');
    assert.equal(await docText.isEnabled(), true);
    await page.evaluate(() => manager.discardChanges());
    // Proposal staging must refuse a pending document save without replacing its editor state.
    await page.evaluate(() => manager.open('profile-one', { view: 'memory', target: 'user', mode: 'document' }));
    await docText.fill('# USER save before proposal import');
    const documentStarted = new Promise(resolve => { state.documentStarted = resolve; }); state.documentHeld = true;
    await button(main.locator('.pi-id-savebar'), '保存文档').click(); await documentStarted;
    const pendingDocumentCalls = calls.length;
    assert.equal(await page.evaluate(() => manager.busy()), true);
    assert.equal(await page.evaluate(() => manager.stageDocuments({ user: 'X' })), false, 'busy document module refuses imported text');
    assert.equal(await docText.inputValue(), '# USER save before proposal import', 'refused staging keeps the pending document content');
    state.releaseDocument(); await page.waitForFunction(() => !manager.busy());
    assert.equal(await docText.inputValue(), '# USER save before proposal import');
    assert.equal(state.documentText.user, '# USER save before proposal import');
    assert.equal(await page.evaluate(() => manager.dirty()), false);
    assert.equal(await page.evaluate(() => manager.stageDocuments({ user: 'X' })), true, 'settled document module accepts imported text');
    assert.equal(await docText.inputValue(), 'X');
    assert.equal(await page.evaluate(() => manager.dirty()), true);
    assert.equal(calls.length, pendingDocumentCalls, 'staging neither saves nor replays the document PUT');
    await page.evaluate(() => manager.discardChanges());
    await page.evaluate(() => manager.stageDocuments({ user: '# Agent USER draft', memory: '# Agent MEMORY draft' }));
    assert.equal(await page.evaluate(() => manager.dirty()), true);
    await page.evaluate(() => manager.open('profile-one', { view: 'memory', target: 'user', mode: 'document' }));
    assert.equal(await docText.inputValue(), '# Agent USER draft');
    await page.evaluate(() => manager.discardChanges());
    state.profileRevision = hash(201); await page.evaluate(() => manager.profileSaved(profile));
    await page.waitForTimeout(60); await docText.fill('# Updated profile revision');
    if (await main.locator('.pi-knowledge-document-reviewed').count()) await main.locator('.pi-knowledge-document-reviewed').check();
    await page.keyboard.press('Control+s'); await page.waitForFunction(() => !manager.dirty());
    assert.equal(calls.at(-1).expectedProfileRevision, hash(201));
    await page.evaluate(() => manager.open('profile-one', {view:'memory',target:'memory',mode:'document'}));
    await docText.fill('# Other target after profile save');
    if (await main.locator('.pi-knowledge-document-reviewed').count()) await main.locator('.pi-knowledge-document-reviewed').check();
    await page.keyboard.press('Control+s'); await page.waitForFunction(() => !manager.dirty());
    assert.equal(calls.at(-1).expectedProfileRevision, hash(201), 'both cached documents refresh their profile revision');
    // Shell proposal imports use stageDocuments; saving persona then refreshes document CAS.
    await page.evaluate(() => manager.open('profile-one', {view:'memory',target:'user',mode:'document'}));
    assert.equal(await docText.inputValue(), state.documentText.user, 'USER full document loads');
    await page.evaluate(() => manager.stageDocuments({user:'# Imported proposal USER'}));
    state.profileRevision = hash(202); await page.evaluate(() => manager.profileSaved(profile));
    await main.locator('.pi-knowledge-document-reviewed').waitFor();
    assert.equal(await docText.inputValue(), '# Imported proposal USER');
    assert.equal(await button(main.locator('.pi-id-savebar'), '保存文档').isDisabled(), true);
    await main.locator('.pi-knowledge-document-reviewed').check(); await page.keyboard.press('Control+s');
    await page.waitForFunction(() => !manager.dirty());
    assert.equal(state.documentText.user, '# Imported proposal USER');
    assert.equal(calls.at(-1).expectedProfileRevision, hash(202));
    await page.evaluate(() => manager.open('profile-one', { view: 'skills' })); await entry(ids.skill).waitFor(); await shot('skills-grid');
    await entry(ids.skill).locator('.pi-id-entry-main').click(); await entry(ids.skill).locator('.pi-id-markdown').waitFor(); await shot('skills-open');
    assert.equal(await entry(ids.skill).locator('.pi-id-markdown strong').innerText(), 'sources');
    assert.equal(await page.evaluate(() => window.unsafe), undefined, 'Markdown scripts are sanitized');
    // Missing/error detail reads offer refresh without exposing mutation controls.
    await entry(ids.skill).locator('.pi-id-entry-main').click();
    state.detailFailure = 'missing'; await entry(ids.skill).locator('.pi-id-entry-main').click();
    await entry(ids.skill).getByText(T('正文不可用，请刷新核对。'), {exact:true}).waitFor();
    assert.equal(await button(entry(ids.skill), '编辑').count(), 0);
    state.detailFailure = 'error'; await button(entry(ids.skill), '刷新').click();
    await entry(ids.skill).getByText('Synthetic detail read failure', {exact:true}).waitFor();
    assert.equal(await button(entry(ids.skill), '编辑').count(), 0);
    await button(entry(ids.skill), '刷新').click(); await entry(ids.skill).locator('.pi-id-markdown').waitFor();
    // A late detail response after leaving cannot repopulate the closed page.
    await entry(ids.skill).locator('.pi-id-entry-main').click();
    const detailStarted = new Promise(resolve => { state.detailStarted = resolve; }); state.delayedDetail = true;
    await entry(ids.skill).locator('.pi-id-entry-main').click(); await detailStarted;
    await page.evaluate(() => manager.close()); state.releaseDetail(); await page.waitForTimeout(40);
    assert.equal(await main.locator('.pi-id-entry').count(), 0, 'closed knowledge page stays empty after a late detail');
    await page.evaluate(() => manager.open('profile-one', {view:'memory',target:'user',mode:'entries'}));
    assert.equal(await main.locator('.pi-id-markdown').count(), 0, 'late skill detail does not enter another view');
    await page.evaluate(() => manager.open('profile-one', {view:'skills'}));
    await entry(ids.skill).locator('.pi-id-entry-main').click();
    await entry(ids.skill).locator('.pi-id-entry-main').click();
    await entry(ids.skill).locator('.pi-id-markdown').waitFor();
    await button(entry(ids.skill), '编辑').click(); await main.locator('.pi-knowledge-editor textarea').fill('# Revised skill');
    await main.locator('.pi-knowledge-editor button[type=submit]').click(); await main.locator('.pi-knowledge-editor').waitFor({ state: 'hidden' });
    assert.equal(calls.at(-1).name, 'source-review');
    await main.locator('.pi-id-toolbar [data-value=draft]').click(); await entry(ids.draft).waitFor(); await shot('skills-drafts');
    await entry(ids.draft).locator('.pi-id-entry-main').click(); await button(entry(ids.draft), '启用').click();
    await entry(ids.draft).waitFor({ state: 'hidden' }); assert.equal(calls.at(-1).operation, 'enable');
    await main.locator('.pi-id-toolbar [data-value=active]').click(); await entry(ids.skill).waitFor();
    await entry(ids.skill).locator('.pi-id-entry-main').click(); await button(entry(ids.skill), '停用').click();
    await entry(ids.skill).waitFor({ state: 'hidden' });
    await main.locator('.pi-id-toolbar [data-value=disabled]').click(); await entry(ids.skill).waitFor();
    await button(main, '前往扩展').click(); assert.deepEqual(await page.evaluate(() => routes.at(-1)), ['extensions', { tab: 'installed', resourceType: 'skills' }]);
    state.proposals = [{ id: 'proposal-1', target: 'memory', groups: [{ items: [ids.memory, ids.memory2].map(id => { const item = state.items.find(row => row.id === id); return { itemId: id, itemRevision: item.revision, preview: item.content, category: item.category }; }), content: 'Merged research workflow and weekly review.', category: 'procedure' }] }];
    await page.evaluate(() => manager.open('profile-one', { view: 'memory', target: 'memory', mode: 'entries', proposals: true }));
    await main.locator('.pi-knowledge-proposals').waitFor(); await shot('memory-proposals');
    const proposed = main.locator('.pi-knowledge-proposal textarea'); await proposed.fill('Edited consolidation draft');
    assert.equal(await page.evaluate(() => manager.dirty()), true);
    const source = state.items.find(item => item.id === ids.memory); source.revision = hash(999); state.rev++;
    await page.evaluate(() => manager.refresh());
    assert.equal(await button(main.locator('.pi-knowledge-proposal'), '应用').isDisabled(), true, 'stale proposal cannot apply');
    assert.equal(await proposed.inputValue(), 'Edited consolidation draft');
    await button(main.locator('.pi-knowledge-proposal'), '忽略').click(); await main.locator('.pi-knowledge-proposals').waitFor({ state: 'hidden' });
    state.proposals = [{id:'proposal-2',target:'memory',groups:[{items:[ids.memory,ids.memory2].map(id=>({itemId:id,itemRevision:state.items.find(row=>row.id===id).revision})),content:'Verified merged memory',category:'fact'}]}];
    await page.evaluate(() => manager.refresh()); await main.locator('.pi-knowledge-proposals').waitFor();
    await main.locator('.pi-knowledge-proposal textarea').fill('Edited verified merged memory');
    await main.locator('.pi-knowledge-proposal select').selectOption('procedure');
    state.fail = 'uncertain'; await button(main.locator('.pi-knowledge-proposal'), '应用').click(); await button(main, '刷新回执核对').waitFor();
    assert.equal(calls.at(-1).content, 'Edited verified merged memory');
    assert.equal(calls.at(-1).category, 'procedure');
    assert.equal(calls.at(-1).target, 'memory');
    const consolidationCalls = calls.length; assert.equal(calls.at(-1).operation, 'consolidate');
    await page.evaluate(async () => { await manager.open('profile-one',{view:'skills'}); await manager.open('profile-one',{view:'memory',target:'memory'}); });
    assert.equal(await main.locator('.pi-knowledge-proposals').count(),0,'confirmed uncertain consolidation stays applied across views');
    assert.equal(calls.length,consolidationCalls,'consolidation is not retried');
    await page.evaluate(() => manager.discardChanges()); state.status = 'pending'; await page.evaluate(() => manager.refresh());
    assert.equal(await main.locator('.pi-knowledge-add').isDisabled(), true);
    state.status = 'ready'; state.documentStatus = 'unsupported'; await page.evaluate(() => manager.open('profile-one', { view: 'memory', target: 'user', mode: 'document' }));
    await main.getByText(T('此服务尚未安装记忆组件。'), { exact: true }).waitFor(); assert.equal(await main.locator('.pi-id-editor-text').count(), 0);
    await page.evaluate(() => { profile.memory.enabled = false; manager.profileSaved(profile); });
    await main.getByText(T('长期记忆未启用：助手不会读取或写入这些内容。'), { exact: true }).first().waitFor();
    assert.deepEqual(errors, [], 'no pageerror');
    console.log(`PASS knowledge ${width} ${locale} ${theme}: ${calls.length} mutations/actions/documents; ${screenshots.length} screenshots`);
    await context.close();
}
(async () => {
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
    try {
        for (const [width, locale, theme] of [[1440, 'zh-CN', 'mint'], [393, 'zh-CN', 'mint'], [320, 'en-US', 'dark'], [1440, 'en-US', 'dark'], [393, 'en-US', 'violet'], [900, 'en-US', 'mint']])
            await run(browser, `http://127.0.0.1:${server.address().port}`, width, locale, theme);
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
