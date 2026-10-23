// Synthetic learning-page contract and responsive regression. No real profile or provider is used.
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const app = express();
for (const [name, directory] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']])
    app.use(`/vendor/${name}`, express.static(path.join(root, 'node_modules', directory)));
app.use(express.static(path.join(root, 'public')));
app.get('/learning-fixture', (_req, res) => res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/workspace.css">
<link rel="stylesheet" href="/brand/fontawesome-6.4.0/css/all.min.css"><link rel="stylesheet" href="/pi-identity-ui.css"><link rel="stylesheet" href="/pi-profile-learning.css">
<style>html,body{height:100%;margin:0}body{font-family:Inter,"Noto Sans SC",system-ui,sans-serif;background:var(--surface-1)}#fixture{height:100dvh;display:flex;flex-direction:column}.pi-id-detail{flex:1}.fixture-shell{display:grid;grid-template-columns:240px minmax(0,1fr);height:100%;min-height:0}.fixture-side{padding:20px}.fixture-side .pi-id-row{margin-top:16px}@media(max-width:680px){.fixture-shell{grid-template-columns:minmax(0,1fr)}.fixture-side{display:none}}</style>
<script>document.documentElement.dataset.theme=new URLSearchParams(location.search).get('theme')||'mint';</script></head><body>
<div id="fixture" class="pi-id-root"><div class="fixture-shell"><aside class="pi-id-list fixture-side"><h3>Pivane</h3><button class="pi-id-row" aria-current="true"><span class="pi-id-avatar">🍀</span><span class="pi-id-row-copy"><strong class="pi-id-row-name">Clover</strong><span class="pi-id-row-desc">Learning companion</span></span></button></aside><div class="pi-id-detail"><header class="pi-id-header"><span class="pi-id-avatar is-lg">🍀</span><div class="pi-id-header-copy"><h2>Clover</h2><p>Learning companion</p></div></header><nav class="pi-id-tabs"></nav><div id="learning" class="pi-id-page" data-page="learning"></div></div></div></div>
<script src="/pi-i18n-catalog.js"></script><script src="/pi-i18n.js"></script><script src="/pi-identity-ui.js"></script><script src="/pi-profile-dialog.js"></script><script src="/pi-profile-learning.js"></script>
<script>
window.events=[];window.toasts=[];
const U=PiIdentityUI;
for(const [id,label,icon] of [['overview','概览','compass'],['persona','设定','id-card'],['memory','记忆','brain'],['skills','技能','toolbox'],['learning','学习','seedling']])document.querySelector('nav').append(U.el('button',{class:'pi-id-tab','aria-current':id==='learning'?'page':'false'},[U.icon(icon),U.t(label)]));
const toaster=U.createToaster(document.getElementById('fixture'));
window.api=async(url,options)=>{const response=await fetch(url,options);const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error||response.statusText),{status:response.status,data});return data;};
window.manager=PiProfileLearning.create({apiFetch:window.api,root:document.getElementById('learning'),ui:{toast:(text,options)=>{window.toasts.push(text);toaster.show(text,options)},confirm:async()=>true,openSettings:detail=>window.events.push(detail),navigate:section=>window.events.push({section}),profile:()=>({id:'fixture',enabled:true,memory:{enabled:true}}),scroller:document.querySelector('.pi-id-detail')}});
window.ready=window.manager.open('fixture');
</script></body></html>`));
const settings = { enabled: true, correctionEnabled: true, reviewEnabled: true, extractionEnabled: false, periodicReviewMinutes: 0,
    maxRunsPerDay: 20, maxTokensPerDay: 200000, consolidationInputChars: 12000,
    triggerPhrases: { correction: [], preference: [], temporary: [], ignore: [] } };
const screenshots = process.env.PIVANE_TEST_SCREENSHOT_DIR;
async function run(browser, base, { width, locale, theme, behaviors }) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale });
    await context.addInitScript(language => localStorage.setItem('pi.workspace.language', language), locale.startsWith('en') ? 'en' : 'zh-CN');
    const page = await context.newPage(), errors = [], puts = [], actions = [];
    page.on('pageerror', error => errors.push(error.message));
    const date = new Date().toISOString();
    const state = { settings: structuredClone(settings), revision: 1, health: { state: 'ok', missingModels: [], today: { runs: 3, maxRuns: 20, reservedTokens: 18000, maxTokens: 200000, usedTokens: 1234 } },
        jobs: [{ id: 'queued-job', status: 'queued', reason: 'review', createdAt: date, model: { provider: 'fixture', modelId: 'small' } }],
        recentRuns: [{ id: 'done-job', status: 'completed', reason: 'correction', startedAt: date, endedAt: date, createdAt: date, model: { provider: 'fixture', modelId: 'small' }, usage: { totalTokens: 1234, reportedCostUsd: 0.002 }, costStatus: 'reported' }], legacy: null,
        failure: null, actionFailure: null, limits: { maxRunsPerDay: { min: 1, max: 500 }, maxTokensPerDay: { min: 6000, max: 5000000 }, periodicReviewMinutes: { min: 0, max: 10080 }, consolidationInputChars: { min: 4000, max: 40000 }, triggerPhrases: { maxPhrases: 50, maxLength: 80 } } };
    const visualJobs = structuredClone(state.jobs), visualRuns = structuredClone(state.recentRuns);
    const snapshot = () => ({ version: 1, status: 'ready', revision: state.revision, settings: state.settings, health: state.health, jobs: state.jobs, recentRuns: state.recentRuns, legacy: state.legacy,
        capabilities: { installed: true, settingsWrite: true, actions: ['save', 'enable', 'review-now', 'cancel', 'adopt-legacy', 'dismiss-legacy'], reservedTokensPerRun: 6000, limits: state.limits } });
    await page.route('**/api/pi/**', async route => {
        const req = route.request(), url = new URL(req.url());
        const respond = (json, status = 200) => route.fulfill({ json, status });
        if (url.pathname === '/api/pi/settings/models') return respond({ providers: [{ id: 'fixture', name: 'Fixture provider' }], models: [
            { provider: 'fixture', id: 'small', name: 'Small model', input: ['text'], available: true },
            { provider: 'fixture', id: 'hidden:batch', input: ['text'], available: true }, { provider: 'fixture', id: 'unavailable', input: ['text'], available: false }] });
        if (url.pathname.endsWith('/learning') && req.method() === 'GET') return respond(snapshot());
        if (url.pathname.endsWith('/learning') && req.method() === 'PUT') {
            const input = req.postDataJSON(); puts.push(input);
            if (state.failure) { const failure = state.failure; state.failure = null; return respond(failure.status === 200 ? { version: 1, status: 'uncertain' } : { error: failure.message }, failure.status); }
            assert.equal(input.expectedRevision, state.revision);
            state.settings = { ...state.settings, ...input.changes }; state.revision++;
            return respond(snapshot());
        }
        if (url.pathname.endsWith('/learning/actions')) {
            const input = req.postDataJSON(); actions.push(input);
            if (state.actionFailure) { const failure = state.actionFailure; state.actionFailure = null; return respond(failure.status === 200 ? { status: 'uncertain' } : { error: failure.message }, failure.status); }
            if (input.action === 'enable') state.settings = { ...state.settings, enabled: true, correctionEnabled: true };
            if (input.action === 'cancel') {
                const job = state.jobs.find(job => job.id === input.jobId);
                state.jobs = state.jobs.filter(job => job.id !== input.jobId);
                if (job) state.recentRuns.push({ ...job, status: 'cancelled', endedAt: new Date().toISOString() });
            }
            if (input.action === 'adopt-legacy' || input.action === 'dismiss-legacy') state.legacy = null;
            state.revision++; return respond(snapshot());
        }
        return respond({ error: 'Unexpected endpoint' }, 404);
    });
    await page.goto(`${base}/learning-fixture?theme=${theme}`);
    await page.evaluate(() => window.ready);
    const say = (zh, en) => locale.startsWith('en') ? en : zh;
    const btn = (zh, en) => page.getByRole('button', { name: say(zh, en), exact: true });
    const refresh = () => page.evaluate(() => window.manager.refresh());
    const save = () => btn('保存学习设置', 'Save learning settings').click();
    const waitIdle = () => page.waitForFunction(() => !window.manager.busy());
    const choice = value => page.locator(`input[name=budget][value=${value}]`);
    const checkedChoice = value => choice(value).locator('..').click();
    const draftDirty = () => page.evaluate(() => window.manager.dirty());
    const sourceText = async selector => page.locator(selector).innerText();
    assert.equal(await page.locator('.pi-learning-hero label').innerText(), say('后台学习', 'Background learning'));
    assert.equal(await page.locator('.pi-learning-hero h3').count(), 0, 'hero does not duplicate its switch title');
    for (const [zh, en] of [['今日用量', "Today's usage"], ['学习方式', 'Learning modes'], ['每日预算', 'Daily budget'], ['运行记录', 'Run history']])
        assert.equal(await page.getByRole('heading', { name: say(zh, en), exact: true }).count(), 1);
    if (locale.startsWith('en')) assert.deepEqual((await sourceText('#learning')).match(/.{0,20}[\u4e00-\u9fff].{0,20}/g) || [], [], 'English page uses the public translation catalog');
    // Every learning option has an (i): enabled, three modes, today, budget, review frequency, read size and four trigger lists.
    assert.equal(await page.locator('.pi-id-info').count(), 12);
    assert.equal(await page.locator('.pi-id-timeline > li').count(), 2);
    assert.ok((await sourceText('.pi-id-timeline')).includes('fixture/small'));
    assert.ok((await sourceText('.pi-id-timeline')).includes('$0.002'));
    assert.ok((await sourceText('.pi-id-timeline')).includes(say('费用未知', 'Cost unknown')));
    assert.equal(await page.locator('select[name=frequency]').inputValue(), '0');
    const heroInfo = page.locator('.pi-learning-hero .pi-id-info');
    await heroInfo.focus(); await page.keyboard.press('Enter');
    assert.equal(await heroInfo.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('.pi-learning-hero .pi-id-info-panel').isVisible(), true);
    await page.keyboard.press('Space');
    assert.equal(await heroInfo.getAttribute('aria-expanded'), 'false');
    if (behaviors) {
        await checkedChoice('save'); assert.equal(await draftDirty(), true);
        await save(); await waitIdle();
        assert.deepEqual(puts.at(-1).changes, { maxRunsPerDay: 8, maxTokensPerDay: 80000 });
        assert.equal(actions.length, 0, 'saving settings never starts a job');
        await checkedChoice('active'); await save(); await waitIdle();
        assert.deepEqual(puts.at(-1).changes, { maxRunsPerDay: 80, maxTokensPerDay: 800000 });
        await checkedChoice('balanced'); await save(); await waitIdle();
        assert.deepEqual(puts.at(-1).changes, { maxRunsPerDay: 20, maxTokensPerDay: 200000 });
        await checkedChoice('custom');
        assert.equal(await page.locator('input[name=maxRunsPerDay]').getAttribute('max'), '500');
        assert.equal(await page.locator('input[name=maxTokensPerDay]').getAttribute('max'), '5000000');
        await page.locator('input[name=maxRunsPerDay]').fill('42');
        await page.evaluate(async () => { window.manager.close(); await window.manager.open('fixture'); });
        assert.equal(await page.locator('input[name=maxRunsPerDay]').inputValue(), '42', 'draft survives close/open');
        await save(); await waitIdle(); assert.deepEqual(puts.at(-1).changes, { maxRunsPerDay: 42 });
        await page.locator('select[name=frequency]').selectOption('30'); await save(); await waitIdle();
        assert.deepEqual(puts.at(-1).changes, { periodicReviewMinutes: 30 });
        await page.locator('select[name=frequency]').selectOption('custom');
        await page.locator('input[name=periodicReviewMinutes]').fill('17'); await save(); await waitIdle();
        assert.deepEqual(puts.at(-1).changes, { periodicReviewMinutes: 17 });
        await page.locator('input[name=reviewEnabled]').uncheck();
        assert.equal(await page.locator('select[name=frequency]').count(), 0);
        await page.evaluate(() => window.manager.discardChanges());
        // 409 retains the draft; explicit refresh rebases on the current revision without overwriting unrelated keys.
        await page.locator('input[name=extractionEnabled]').check();
        state.revision++; state.settings.correctionEnabled = false;
        state.failure = { status: 409, message: 'Settings changed' };
        await save(); await waitIdle();
        assert.equal(await draftDirty(), true);
        assert.ok((await sourceText('#learning')).includes('草稿已保留'));
        await refresh();
        assert.equal(await page.locator('input[name=extractionEnabled]').isChecked(), true);
        assert.equal(await page.locator('input[name=correctionEnabled]').isChecked(), false);
        await save(); await waitIdle(); assert.deepEqual(puts.at(-1).changes, { extractionEnabled: true });
        await page.locator('input[name=extractionEnabled]').uncheck();
        state.failure = { status: 400, message: 'Synthetic rejection' };
        await save(); await waitIdle(); assert.equal(await draftDirty(), true);
        assert.ok((await sourceText('#learning')).includes('Synthetic rejection'));
        state.failure = { status: 503, message: 'Synthetic uncertain save' };
        await save(); await waitIdle(); assert.equal(await draftDirty(), true);
        assert.equal(await btn('保存学习设置', 'Save learning settings').isDisabled(), true);
        const putCount = puts.length;
        await page.locator('input[name=enabled]').focus(); await page.keyboard.press('Control+s');
        assert.equal(puts.length, putCount, 'uncertain save is never auto-retried');
        await refresh(); await save(); await waitIdle();
        // Trigger validation and normalization; invalid retained drafts stay invalid after a refresh.
        await page.locator('.pi-learning-advanced > summary').click();
        const phrase = page.locator('textarea[name=trigger-correction]');
        await phrase.fill(' Nein \n\nnope'); await save(); await waitIdle();
        assert.deepEqual(puts.at(-1).changes, { triggerPhrases: { correction: ['Nein', 'nope'], preference: [], temporary: [], ignore: [] } });
        await phrase.fill('x'.repeat(81)); const beforeInvalid = puts.length;
        await refresh(); await save(); assert.equal(puts.length, beforeInvalid);
        assert.equal(await phrase.getAttribute('aria-invalid'), 'true');
        await phrase.fill('okay\tinvalid'); await save(); assert.equal(puts.length, beforeInvalid);
        await phrase.fill('Fine'); await phrase.focus(); await page.keyboard.press('Control+s'); await waitIdle();
        assert.deepEqual(puts.at(-1).changes.triggerPhrases.correction, ['Fine']);
        // Budget cards respect older server capabilities instead of posting an unsupported preset.
        state.limits.maxRunsPerDay.max = 20; state.limits.maxTokensPerDay.max = 200000;
        await refresh(); assert.equal(await choice('active').isDisabled(), true);
        state.limits.maxRunsPerDay.max = 500; state.limits.maxTokensPerDay.max = 5000000;
        state.settings.enabled = false; state.health = { ...state.health, state: 'off', missingModels: ['memory-correction', 'memory-review'] };
        await refresh();
        assert.ok((await sourceText('.pi-learning-missing')).includes('纠错模型 / 复盘模型'));
        await btn('前往设置 → 辅助模型', 'Settings → Auxiliary models').click();
        assert.deepEqual(await page.evaluate(() => window.events.at(-1)), { tab: 'models' });
        await btn('一键开启（推荐设置）', 'Enable recommended settings').click(); await waitIdle();
        assert.equal(actions.at(-1).action, 'enable'); assert.equal(typeof actions.at(-1).requestId, 'string');
        assert.equal(await page.locator('input[name=enabled]').isChecked(), true);
        await btn('立即复盘', 'Review now').click(); await waitIdle(); assert.equal(actions.at(-1).action, 'review-now');
        await btn('取消作业', 'Cancel job').click(); await waitIdle(); assert.equal(actions.at(-1).jobId, 'queued-job');
        assert.equal(state.jobs.length, 0);
        assert.equal(await btn('取消作业', 'Cancel job').count(), 0, 'archived cancellation leaves no live action');
        assert.equal(await page.locator('.pi-id-timeline > li').count(), 2, 'the cancelled run remains visible in history');
        state.actionFailure = { status: 409, message: 'Conflict' };
        await btn('立即复盘', 'Review now').click(); await waitIdle(); assert.equal(await page.locator('.pi-learning-uncertain').count(), 0);
        state.actionFailure = { status: 400, message: 'Rejected action' };
        await btn('立即复盘', 'Review now').click(); await waitIdle(); assert.ok((await sourceText('#learning')).includes('Rejected action'));
        // Malformed successful responses are uncertain too, and the same request ID stays visible across reopen.
        state.actionFailure = { status: 200 };
        await btn('立即复盘', 'Review now').click(); await waitIdle();
        const uncertain = actions.at(-1), actionCount = actions.length;
        assert.ok((await sourceText('.pi-learning-uncertain')).includes(uncertain.requestId));
        assert.equal(await btn('立即复盘', 'Review now').isDisabled(), true);
        await refresh(); await page.evaluate(async () => { window.manager.close(); await window.manager.open('fixture'); });
        assert.equal(actions.length, actionCount); assert.ok((await sourceText('.pi-learning-uncertain')).includes(uncertain.requestId));
        await btn('已核对作业列表', 'I have checked the run history').click();
        assert.equal(await btn('立即复盘', 'Review now').isEnabled(), true);
        state.legacy = { autoLearn: true, purposes: ['memory-review'], reviewModel: { provider: 'fixture', modelId: 'old' }, reviewModelAvailable: false };
        await refresh(); await page.waitForFunction(() => document.querySelector('.pi-learning-legacy select[aria-label="模型"]')?.options.length === 1);
        assert.deepEqual(await page.locator('.pi-learning-legacy select').last().locator('option').evaluateAll(nodes => nodes.map(node => node.value)), ['small']);
        await btn('迁移并开启', 'Migrate and enable').click(); await waitIdle();
        assert.deepEqual(actions.at(-1).model, { provider: 'fixture', modelId: 'small' });
        assert.equal(await page.locator('.pi-learning-legacy').count(), 0);
        state.legacy = { autoLearn: true, purposes: [], reviewModel: null, reviewModelAvailable: true };
        await refresh(); await btn('不再提示', 'Dismiss').click(); await waitIdle(); assert.equal(actions.at(-1).action, 'dismiss-legacy');
        state.jobs = []; state.recentRuns = []; await refresh();
        assert.ok((await sourceText('#learning')).includes('还没有运行记录'));
        state.settings = structuredClone(settings); state.jobs = visualJobs; state.recentRuns = visualRuns; state.revision++;
        await refresh(); await page.evaluate(() => window.manager.discardChanges());
    }
    // Render the token reservation boundary even before the numeric maximum is reached.
    state.health = { state: 'quota-exhausted', missingModels: [], today: { runs: 2, maxRuns: 20, reservedTokens: 196000, maxTokens: 200000, exhaustedBy: 'tokens', resetsAt: new Date(new Date().setUTCHours(24, 0, 0, 0)).toISOString(), usedTokens: 1234 } };
    await refresh();
    assert.equal(await page.locator('.pi-learning-usage .pi-id-meter').nth(1).getAttribute('data-level'), 'full');
    assert.ok((await sourceText('.pi-learning-usage')).includes(say('剩余不足一次运行', 'Not enough left for one run')));
    await page.locator('.pi-learning-hero .pi-id-info').click();
    if (screenshots) {
        fs.mkdirSync(screenshots, { recursive: true });
        await page.evaluate(() => document.querySelector('.pi-id-toasts').replaceChildren());
        await page.locator('.pi-id-detail').evaluate(node => { node.scrollTop = 0; });
        await page.screenshot({ path: path.join(screenshots, `learning-${width}-${theme}-${locale}-tokens-info.png`) });
    }
    // Old snapshots derive the token boundary as well as the later run boundary.
    state.health.today = { runs: 2, maxRuns: 20, reservedTokens: 196000, maxTokens: 200000 };
    await refresh();
    assert.equal(await page.locator('.pi-learning-usage .pi-id-meter').nth(1).getAttribute('data-level'), 'full');
    assert.ok((await sourceText('.pi-learning-usage')).includes('1234') || (await sourceText('.pi-learning-usage')).includes('1.2K'));
    // An explicit unknown aggregate remains authoritative even when today's runs contain usage.
    const countedRuns = state.recentRuns;
    state.recentRuns = [...visualRuns, { ...visualRuns[0], id: 'refunded-run', quotaRefund: true, usage: { totalTokens: 98765 } }];
    state.health.today.usedTokens = null;
    await refresh();
    const noReport = await page.evaluate(() => PiI18n.t('供应商报告的实际用量：暂无报告'));
    assert.ok((await sourceText('.pi-learning-usage')).includes(noReport), 'explicit null does not fall back to run usage');
    delete state.health.today.usedTokens;
    state.recentRuns = state.recentRuns.filter(run => run.quotaRefund);
    await refresh();
    assert.ok((await sourceText('.pi-learning-usage')).includes(noReport), 'legacy usage fallback excludes refunded runs');
    state.recentRuns = countedRuns;
    state.health.today = { runs: 20, maxRuns: 20, reservedTokens: 120000, maxTokens: 200000 };
    await refresh();
    assert.equal(await page.locator('.pi-learning-usage .pi-id-meter').first().getAttribute('data-level'), 'full');
    assert.equal(await page.locator('.pi-learning-usage .pi-id-meter').nth(1).getAttribute('data-level'), 'ok');
    assert.ok((await sourceText('.pi-learning-usage')).includes(say('已达上限', 'Limit reached')));
    if (screenshots) {
        await page.screenshot({ path: path.join(screenshots, `learning-${width}-${theme}-${locale}-runs.png`) });
    }
    await checkedChoice('custom');
    await page.locator('input[name=maxRunsPerDay]').fill('43');
    await page.locator('.pi-learning-advanced').evaluate(node => { node.open = true; });
    if (screenshots) {
        await page.getByRole('heading', { name: say('每日预算', 'Daily budget') }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(screenshots, `learning-${width}-${theme}-${locale}-budget-advanced.png`) });
        await page.locator('.pi-id-timeline').scrollIntoViewIfNeeded().catch(() => {});
        await page.screenshot({ path: path.join(screenshots, `learning-${width}-${theme}-${locale}-history.png`) });
    }
    const geometry = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth, detail: document.querySelector('.pi-id-detail').clientWidth, detailScroll: document.querySelector('.pi-id-detail').scrollWidth,
        overflowing: [...document.querySelectorAll('#learning *')].filter(node => node.getBoundingClientRect().right > innerWidth + 1).map(node => [node.className, node.getBoundingClientRect().right]).slice(0, 10), controls: [...document.querySelectorAll('.pi-id-input,.pi-id-select,.pi-id-textarea')].map(node => parseFloat(getComputedStyle(node).fontSize)) }));
    assert.ok(geometry.page <= geometry.viewport + 1 && geometry.detailScroll <= geometry.detail + 1, JSON.stringify(geometry));
    if (width <= 680) assert.ok(geometry.controls.every(size => size >= 16), JSON.stringify(geometry));
    assert.deepEqual(errors, []);
    console.log(`PASS learning ${width} ${locale} ${theme}: ${puts.length} saves, ${actions.length} actions, no overflow or pageerror`);
    await context.close();
}
(async () => {
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    let browser;
    try {
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
        const base = `http://127.0.0.1:${server.address().port}`;
        for (const options of [
            { width: 1440, locale: 'zh-CN', theme: 'mint', behaviors: true },
            { width: 393, locale: 'zh-CN', theme: 'mint', behaviors: true },
            { width: 320, locale: 'zh-CN', theme: 'mint' },
            { width: 1440, locale: 'en-US', theme: 'dark' },
            { width: 393, locale: 'en-US', theme: 'dark' },
            { width: 900, locale: 'en-US', theme: 'oat' },
        ]) await run(browser, base, options);
    } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
