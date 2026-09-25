const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const app = express();
const root = path.resolve(__dirname, '../..');
const hash = letter => letter.repeat(64);
const skill = { id: hash('b'), kind: 'skill', name: 'example-skill', description: 'Example', state: 'active', scope: 'profile', revision: hash('c'), updatedAt: '2026-01-01' };
const settings = { enabled: false, correctionEnabled: true, reviewEnabled: false, extractionEnabled: false,
    maxRunsPerDay: 4, maxTokensPerDay: 24000, periodicReviewMinutes: 0 };
app.use(express.static(path.join(root, 'public')));
app.get('/fixture', (_req, res) => res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/pi-profile-knowledge.css"><link rel="stylesheet" href="/pi-chat-knowledge.css">
<style>:root{--line:#ccc;--text-main:#222;--text-soft:#555;--surface-1:#fff;--surface-2:#eee;--accent:#168a68}body{margin:0;font-family:Arial,sans-serif;background:#f8f8f8;color:#222}main{max-width:720px;padding:12px;margin:auto;min-width:0}button{cursor:pointer}section{min-width:0}</style></head><body><main><section id="pi-profiles-memory"></section><div id="pi-chat-knowledge"></div></main>
<script src="/pi-i18n-catalog.js"></script><script src="/pi-i18n.js"></script><script src="/pi-profile-knowledge.js"></script><script src="/pi-chat-knowledge.js"></script>
<script>window.current={cwd:'/synthetic',sessionId:'thread-one',profileId:'profile-one',generation:1};
window.api=async (url,options)=>{const response=await fetch(url,options);if(!response.ok){const error=new Error((await response.json().catch(()=>({}))).error||response.statusText);error.status=response.status;throw error;}return response.json()};
window.manager=PiProfileKnowledge.create({apiFetch:api,root:document.getElementById('pi-profiles-memory')});
window.chat=PiChatKnowledge.create({fetch:api,root:document.getElementById('pi-chat-knowledge'),scope:()=>window.current});
window.manager.open('profile-one');window.chat.update();</script></body></html>`));
async function run(browser, base, width, locale, dark) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, locale, colorScheme: dark ? 'dark' : 'light' });
    const page = await context.newPage(), errors = [], calls = [];
    const state = { revision: hash('a'), status: 'ready', receipts: [], item: structuredClone(skill), learningRevision: 0,
        jobs: [], settings: structuredClone(settings), conflict: false, reject: false, abort: false, actionAbort: false, slow: false, release: null, slowStarted: null };
    const learning = () => ({ version: 1, status: 'ready', revision: state.learningRevision, settings: state.settings,
        jobs: state.jobs, recentRuns: [], capabilities: { installed: true, settingsWrite: true, reservedTokensPerRun: 6000,
            actions: ['save', ...(state.settings.enabled ? ['review-now'] : []), 'cancel'],
            limits: { maxRunsPerDay: { min: 1, max: 20 }, maxTokensPerDay: { min: 6000, max: 200000 }, periodicReviewMinutes: { min: 0, max: 10080 } } } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/pi/profiles/**', async route => {
        const req = route.request(), url = new URL(req.url()), p = url.pathname;
        if (state.slow && p.endsWith('/knowledge') && req.method() === 'GET') {
            state.slowStarted?.(); await new Promise(resolve => { state.release = resolve; });
        }
        const fulfill = (body, status = 200) => route.fulfill({ json: body, status });
        const snapshot = () => ({ version: 1, status: state.status, revision: state.status === 'ready' ? state.revision : null,
            items: state.status === 'ready' && url.searchParams.get('kind') !== 'memory' ? [state.item] : [],
            receipts: state.receipts, hasMore: false, capabilities: { memory: true, skill: true, projectWrites: false, operations: ['create','update','delete','restore','enable','disable','undo'], skillNameMaxLength: 64, maxContentLength: 65536 } });
        if (p.endsWith('/knowledge') && req.method() === 'GET') return fulfill(snapshot());
        if (p.endsWith('/knowledge/items/' + skill.id)) return fulfill({ version: 1, status: 'ready', item: { ...state.item,
            content: `---\nname: ${state.item.name}\ndescription: ${state.item.description}\n---\nSkill content\n` } });
        if (p.endsWith('/learning') && req.method() === 'GET') return fulfill(learning());
        if (p.endsWith('/learning') && req.method() === 'PUT') {
            const input = req.postDataJSON(); calls.push(input);
            if (input.expectedRevision !== state.learningRevision || state.conflict) return fulfill({ error: 'Conflict' }, 409);
            assert.ok(input.changes.maxRunsPerDay === undefined || input.changes.maxRunsPerDay >= 1 && input.changes.maxRunsPerDay <= 20);
            Object.assign(state.settings, input.changes); state.learningRevision++;
            return fulfill(learning());
        }
        if (p.endsWith('/learning/actions')) {
            const input = req.postDataJSON(); calls.push(input);
            if (state.actionAbort) { state.actionAbort = false; return route.abort('failed'); }
            if (input.action === 'review-now') state.jobs.push({ id: hash('e'), reason: 'manual', status: 'queued' });
            else { assert.equal(input.jobId, hash('e')); state.jobs[0].status = 'cancelled'; }
            state.learningRevision++;
            return fulfill(learning());
        }
        if (p.endsWith('/knowledge/mutations')) {
            const input = req.postDataJSON(); calls.push(input);
            if (state.reject) { state.reject = false; return fulfill({ error: 'Invalid content' }, 400); }
            if (state.conflict || input.expectedRevision !== state.revision) return fulfill({ error: 'Conflict' }, 409);
            if (state.abort) { state.abort = false; return route.abort('failed'); }
            assert.equal(input.source, undefined);
            if (input.operation === 'undo') { assert.deepEqual(Object.keys(input).sort(), ['expectedRevision', 'kind', 'operation', 'receiptId', 'requestId']); }
            const receipt = { id: 'receipt-1', requestId: input.requestId, kind: input.kind, operation: input.operation,
                status: 'saved', itemId: input.itemId || skill.id, indexStatus: 'ready', activation: input.kind === 'skill' ? 'reload-required' : 'next-turn', undoable: input.operation !== 'undo' };
            state.receipts.unshift(receipt); state.revision = hash('d');
            return fulfill({ version: 1, status: 'saved', revision: state.revision, receipt });
        }
        return fulfill({ error: 'missing' }, 404);
    });
    await page.goto(`${base}/fixture`);
    await page.locator('.pi-knowledge-row').waitFor();
    assert.equal(await page.locator('.pi-knowledge-tools button').isEnabled(), true);
    await page.locator('.pi-knowledge-row').click();
    await page.locator('.pi-knowledge-detail pre').waitFor();
    assert.match(await page.locator('.pi-knowledge-detail small').innerText(), /[cC]{64}/);
    await page.locator('.pi-knowledge-detail button').filter({ hasText: locale.startsWith('zh') ? '编辑' : 'Edit' }).click();
    assert.equal(await page.locator('.pi-knowledge-editor input').first().getAttribute('maxlength'), '64');
    await page.locator('.pi-knowledge-editor textarea').fill('New skill content');
    await page.locator('.pi-knowledge-editor details').evaluate(el => { el.open = true; });
    assert.match(await page.locator('.pi-knowledge-proposed').innerText(), /New skill content/);
    await page.locator('.pi-knowledge-editor button[type=submit]').click();
    await page.locator('.pi-knowledge-receipt').waitFor();
    assert.equal(calls.at(-1).kind, 'skill');
    await page.locator('.pi-profile-kinds button').first().click();
    await page.locator('.pi-knowledge-receipt button').click();
    await page.waitForFunction(() => document.querySelector('.pi-knowledge-receipt')?.textContent.includes('Undo') || document.querySelector('.pi-knowledge-receipt')?.textContent.includes('撤销'));
    assert.equal(calls.at(-1).operation, 'undo');
    assert.equal(calls.at(-1).kind, 'skill');
    await page.locator('.pi-profile-kinds button').last().click();
    await page.locator('.pi-knowledge-row').click();
    await page.locator('.pi-knowledge-history').waitFor();
    assert.equal(await page.locator('.pi-knowledge-version').count(), 2);
    const inputs = page.locator('.pi-learning-settings input[type=number]');
    assert.equal(await inputs.count(), 3);
    assert.deepEqual(await inputs.evaluateAll(nodes => nodes.map(node => [node.min, node.max])), [['1','20'],['6000','200000'],['0','10080']]);
    await inputs.first().fill('5'); await page.locator('.pi-learning-settings button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('.pi-knowledge-status')?.textContent.includes('saved') || document.querySelector('.pi-knowledge-status')?.textContent.includes('已保存'));
    assert.equal(state.learningRevision, 1);
    await page.locator('.pi-learning-settings input[type=checkbox]').first().check();
    await page.locator('.pi-learning-settings input[type=checkbox]').nth(2).check();
    await page.locator('.pi-learning-settings button[type=submit]').click();
    await page.locator('.pi-learning > button').click();
    await page.locator('.pi-learning-job button').click();
    assert.equal(calls.at(-1).action, 'cancel');
    assert.equal(state.jobs[0].status, 'cancelled');
    state.actionAbort = true; await page.locator('.pi-learning > button').click();
    await page.waitForFunction(() => document.querySelector('.pi-learning')?.textContent.includes('request') || document.querySelector('.pi-learning')?.textContent.includes('请求'));
    assert.equal(await page.locator('.pi-learning > button').filter({ hasText: locale.startsWith('zh') ? '立即复盘' : 'Review now' }).count(), 0);
    await page.locator('.pi-learning > button').filter({ hasText: locale.startsWith('zh') ? '已核对作业列表' : 'I checked the job list' }).click();
    assert.equal(await page.locator('.pi-learning > button').filter({ hasText: locale.startsWith('zh') ? '立即复盘' : 'Review now' }).count(), 1);
    await inputs.first().fill('6'); state.conflict = true;
    await page.locator('.pi-learning-settings button[type=submit]').click();
    await page.waitForFunction(() => /conflict|changed|冲突/i.test(document.querySelector('.pi-knowledge-status')?.textContent || ''));
    assert.equal(await inputs.first().inputValue(), '6'); state.conflict = false;
    await page.locator('.pi-profile-kinds button').first().click(); await page.locator('.pi-knowledge-tools button').click();
    await page.locator('.pi-knowledge-editor textarea').fill('A correction draft');
    state.reject = true; await page.locator('.pi-knowledge-editor button[type=submit]').click();
    await page.waitForFunction(() => /rejected|拒绝/i.test(document.querySelector('.pi-knowledge-status')?.textContent || ''));
    assert.equal(await page.locator('.pi-knowledge-editor button[type=submit]').isEnabled(), true);
    state.conflict = true; await page.locator('.pi-knowledge-editor button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('.pi-knowledge-editor textarea')?.value === 'A correction draft' && /conflict|冲突/i.test(document.querySelector('.pi-knowledge-status')?.textContent || ''));
    assert.equal(await page.locator('.pi-knowledge-editor textarea').inputValue(), 'A correction draft');
    state.conflict = false; state.abort = true;
    await page.locator('.pi-knowledge-editor button[type=submit]').click();
    await page.locator('.pi-knowledge-status').filter({ hasText: locale.startsWith('zh') ? '未确认' : 'unconfirmed' }).waitFor();
    assert.equal(await page.locator('.pi-knowledge-editor textarea').inputValue(), 'A correction draft');
    await page.evaluate(() => { window.manager.open('profile-two'); window.manager.open('profile-one'); });
    assert.equal(await page.locator('.pi-knowledge-editor textarea').inputValue(), 'A correction draft');
    assert.equal(await page.locator('.pi-knowledge-editor button[type=submit]').isDisabled(), true);
    state.status = 'pending'; await page.locator('.pi-knowledge-head button').click();
    await page.waitForFunction(() => document.querySelector('.pi-knowledge-status')?.textContent.includes('pending') || document.querySelector('.pi-knowledge-status')?.textContent.includes('待同步'));
    assert.equal(await page.locator('.pi-knowledge-tools button').isDisabled(), true);
    state.status = 'ready'; state.receipts.unshift({ id:'verified', kind:'memory', operation:'create', requestId:'server', source:{sessionId:'thread-one',entryId:'native-one'}, status:'saved', undoable:false });
    state.receipts.unshift({ id:'other', kind:'memory', operation:'create', requestId:'other', source:{sessionId:'thread-two',entryId:'native-two'}, status:'saved', undoable:false });
    await page.evaluate(() => window.chat.refresh());
    await page.locator('.pi-chat-knowledge summary').click();
    await page.locator('.pi-chat-knowledge-receipt').waitFor();
    assert.equal(await page.locator('.pi-chat-knowledge-receipt').count(), 1);
    const delayed = new Promise(resolve => { state.slowStarted = resolve; }); state.slow = true;
    await page.evaluate(() => { void window.chat.refresh(); }); await delayed;
    state.slow = false;
    await page.evaluate(() => { window.current = { ...window.current, sessionId:'thread-two',generation:2 }; window.chat.update(); });
    state.release();
    await page.waitForFunction(() => document.querySelector('.pi-chat-knowledge-receipt')?.textContent.includes('native-two'));
    assert.equal(await page.locator('.pi-chat-knowledge-receipt').count(), 1);
    await page.locator('.pi-chat-knowledge textarea').fill('Thread two draft');
    await page.evaluate(() => { window.current = { ...window.current, sessionId:'thread-one',generation:3 }; window.chat.update(); });
    await page.evaluate(() => { window.current = { ...window.current, sessionId:'thread-two',generation:4 }; window.chat.update(); });
    assert.equal(await page.locator('.pi-chat-knowledge textarea').inputValue(), 'Thread two draft');
    state.abort = true;
    await page.locator('.pi-chat-knowledge-form button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('.pi-chat-knowledge-form button')?.disabled === true);
    assert.equal(await page.locator('.pi-chat-knowledge textarea').inputValue(), 'Thread two draft');
    assert.equal(calls.at(-1).category, 'correction');
    assert.equal(calls.at(-1).source, undefined);
    const manualId = calls.at(-1).requestId;
    state.receipts.unshift({ id:'manual-confirmed', requestId:manualId, kind:'memory', operation:'create', status:'pending', indexStatus:'pending', undoable:false });
    await page.evaluate(() => window.chat.refresh());
    await page.waitForFunction(() => document.querySelector('.pi-chat-knowledge-form textarea')?.value === '');
    assert.match(await page.locator('.pi-chat-knowledge .pi-knowledge-receipt').innerText(), /Pending|待同步/);
    await page.locator('.pi-chat-knowledge textarea').fill('Keep correction draft'); state.reject = true;
    await page.locator('.pi-chat-knowledge-form button[type=submit]').click();
    await page.waitForFunction(() => /rejected|拒绝/i.test(document.querySelector('.pi-chat-knowledge .pi-knowledge-status')?.textContent || ''));
    assert.equal(await page.locator('.pi-chat-knowledge-form button[type=submit]').isEnabled(), true);
    state.conflict = true; await page.locator('.pi-chat-knowledge-form button[type=submit]').click();
    await page.waitForFunction(() => /conflict|冲突/i.test(document.querySelector('.pi-chat-knowledge .pi-knowledge-status')?.textContent || ''));
    assert.equal(await page.locator('.pi-chat-knowledge textarea').inputValue(), 'Keep correction draft'); state.conflict = false;
    state.item = { ...state.item, state: 'deleted', revision: hash('e') };
    await page.evaluate(() => window.manager.open('profile-three'));
    await page.locator('.pi-knowledge-row').click();
    await page.locator('.pi-knowledge-detail pre').waitFor();
    await page.locator('.pi-knowledge-detail button').filter({ hasText: locale.startsWith('zh') ? '恢复条目' : 'Restore item' }).click();
    assert.equal(calls.at(-1).operation, 'restore');
    assert.equal(calls.at(-1).itemId, skill.id);
    assert.equal(calls.at(-1).itemRevision, hash('e'));
    const dimensions = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth,
        overflows: [...document.querySelectorAll('main,section,#pi-chat-knowledge,.pi-chat-knowledge-body')].filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.className || el.id) }));
    assert.ok(dimensions.document <= dimensions.viewport + 1, JSON.stringify(dimensions));
    assert.deepEqual(dimensions.overflows, []);
    if (width < 900) {
        // Form controls are measured while a re-render can still swap transient nodes;
        // wait until every mounted control settles at the mobile font size, then assert
        // with per-control detail so a persistent miss identifies the culprit.
        await page.waitForFunction(() => [...document.querySelectorAll('textarea,input,select')]
            .every(el => parseFloat(getComputedStyle(el).fontSize) >= 16), undefined, { timeout: 5000 }).catch(() => {});
        const sizes = await page.locator('textarea,input,select').evaluateAll(nodes => nodes.map(el => [el.tagName.toLowerCase(), el.id || el.className || el.name, parseFloat(getComputedStyle(el).fontSize)]));
        assert.ok(sizes.every(entry => entry[2] >= 16), `mobile form font sizes: ${JSON.stringify(sizes)}`);
    }
    assert.deepEqual(errors, []);
    console.log(`PASS knowledge ${width} ${locale} ${dark ? 'dark' : 'light'} ${JSON.stringify(dimensions)}`);
    await context.close();
}
(async () => {
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
    try { for (const width of [320,393,1440]) await run(browser, `http://127.0.0.1:${server.address().port}`, width, width === 393 ? 'zh-CN' : 'en-US', width === 393); }
    finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
