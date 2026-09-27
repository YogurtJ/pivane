// Full workspace UI with synthetic profile data; no identity, model or live service access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const evidence = process.env.PIVANE_TEST_SCREENSHOT_DIR || path.join(os.tmpdir(), 'pivane-profile-design');
const cwd = '/synthetic/profile-design';
const profiles = [
    { id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Clover 🍀', description: '跨学科与日常聊天的学习伙伴，共同积累知识与经验。', avatar: { kind: 'emoji', value: '🍀' }, enabled: true,
        soul: '# 协作方式\n\n用清晰、温暖的语言解释复杂问题。\n\n## 学习与交流\n\n- 先理解问题，再拆解关键步骤。\n- 使用具体例子帮助理解。\n- 对不确定的内容给出核对方法。', memory: { enabled: true, autoLearn: false, memoryCharLimit: 16000, userCharLimit: 8000 }, skills: { learnedEnabled: true } },
    { id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', name: '开发与代码审查助手 / Development and code review partner', description: '帮助梳理需求、阅读代码和核对实现。', avatar: null, enabled: false,
        soul: '', memory: { enabled: false, autoLearn: false, memoryCharLimit: 16000, userCharLimit: 8000 }, skills: { learnedEnabled: true } }
];
async function main() {
    fs.mkdirSync(evidence, { recursive: true });
    const app = express();
    for (const [name, folder] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use(`/vendor/${name}`, express.static(path.join(root, 'node_modules', folder)));
    app.use(express.static(path.join(root, 'public')));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
    try {
        for (const [width, locale, theme] of [[1440, 'zh-CN', 'light'], [1920, 'en', 'dark'], [900, 'en', 'light'], [393, 'zh-CN', 'light'], [320, 'en', 'dark']]) {
            const context = await browser.newContext({ viewport: { width, height: 900 }, locale, isMobile: width < 681, hasTouch: width < 681 });
            const page = await context.newPage(), errors = [], nativeDialogs = [], writes = [];
            const rows = structuredClone(profiles);
            let savedDocument = '# 偏好与习惯\n\n喜欢先了解整体思路，再逐步展开细节。\n\n讨论学习问题时，请给出一个具体例子。', holdRefresh = false, releaseRefresh;
            page.on('pageerror', error => errors.push(error.message));
            page.on('dialog', dialog => { nativeDialogs.push(dialog.message()); void dialog.dismiss(); });
            await page.addInitScript(({ locale, theme, cwd }) => {
                localStorage.setItem('pi.workspace.language', locale);
                localStorage.setItem('pi.workspace.theme', theme);
                localStorage.setItem('pi.web.cwd', cwd);
            }, { locale, theme, cwd });
            await page.route('**/api/**', async route => {
                const req = route.request(), url = new URL(req.url()), p = url.pathname;
                const reply = data => route.fulfill({ json: data });
                if (req.method() !== 'GET') {
                    const body = req.postDataJSON(); writes.push({ p, body });
                    if (p === '/api/pi/profiles') { rows[0] = { ...body.profile, id: rows[0].id }; return reply({ revision: 'r2', profile: rows[0] }); }
                    if (p.endsWith('/documents')) { savedDocument = body.content; return reply({ status: 'ready', content: savedDocument, revision: 'd2', profileRevision: 'p1', usage: { used: savedDocument.length, limit: 8000 } }); }
                    return reply({ ok: true });
                }
                if (p === '/api/pi/status') return reply({ ok: true, agentProfiles: true, assistantProjects: true, profileMemory: true, projectRoots: ['/synthetic'], defaultProject: cwd });
                if (p === '/api/pi/projects') return reply({ projects: [{ cwd, name: 'Synthetic project', sessionCount: 0 }], roots: ['/synthetic'] });
                if (p === '/api/pi/profiles') return reply({ version: 1, revision: 'r1', cwd, profiles: rows });
                if (p.endsWith('/documents')) {
                    if (holdRefresh) await new Promise(resolve => { releaseRefresh = resolve; });
                    const disabled = p.includes(rows[1].id) && url.searchParams.get('target') === 'memory';
                    return reply({ status: disabled ? 'disabled' : 'ready', content: savedDocument, revision: 'd1', profileRevision: 'p1', usage: { used: savedDocument.length, limit: 8000 } });
                }
                if (p.endsWith('/knowledge')) return reply({ version: 1, status: 'ready', revision: 'a'.repeat(64), items: [
                    { id: 'skill-1', kind: 'skill', name: 'source-review', description: '核对引用、比较来源并整理可复用的研究方法。', state: 'active', scope: 'profile', revision: 's1' }
                ], receipts: [], hasMore: false, usage: { memory: { chars: 1268, limit: 16000 }, user: { chars: 396, limit: 8000 } }, capabilities: { memory: true, skill: true } });
                if (p.endsWith('/learning')) return reply({ version: 1, revision: 1, health: { state: p.includes(rows[1].id) ? 'off' : 'ok' }, settings: { enabled: true, correctionEnabled: true, reviewEnabled: false, extractionEnabled: true, maxRunsPerDay: 20, maxTokensPerDay: 200000, periodicReviewMinutes: 0 }, jobs: [], recentRuns: [], capabilities: { settingsWrite: true, installed: true } });
                if (p === '/api/pi/assistant-projects') return reply({ projects: [{ id: 'p1', name: '研究笔记 / Research notes', cwd: '/synthetic/research/long-project-directory-for-layout-checking', description: '记录研究过程、参考资料与后续问题。' }] });
                if (p === '/api/pi/sessions') return reply({ sessions: [] });
                if (p === '/api/pi/activity') return reply({ runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] });
                return reply({});
            });
            await page.routeWebSocket('**/api/pi/ws', ws => ws.close());
            await page.goto(`${process.env.PIVANE_TEST_PROFILE_URL || `http://127.0.0.1:${server.address().port}`}/#/profiles`);
            await page.locator('.pi-profile-row').first().waitFor();
            const shot = name => page.screenshot({ path: path.join(evidence, `profiles-${width}-${name}.png`) });
            const geometry = async () => {
                const overflow = await page.evaluate(() => [...document.querySelectorAll('body,#pi-profiles-panel,#pi-profiles-content,.pi-profile-detail,.pi-profile-card,.pi-profile-document,.pi-learning')]
                    .filter(el => el.clientWidth && el.scrollWidth > el.clientWidth + 2).map(el => `${el.id || el.className}: ${el.scrollWidth}/${el.clientWidth}`));
                assert.deepEqual(overflow, [], `${width}: overflow`);
            };
            await shot('list');
            await page.locator('#pi-profile-list-query').fill('development');
            assert.equal(await page.locator('.pi-profile-row:visible').count(), 1);
            await page.locator('#pi-profile-list-query').fill('no-match');
            assert.equal(await page.locator('.pi-profile-row:visible').count(), 0);
            await page.locator('#pi-profile-list-query').fill('');
            await page.locator('.pi-profile-row').first().click();
            await page.locator('#pi-profile-form').waitFor();
            await geometry(); await shot('overview');
            const headerHeight = await page.locator('#pi-profiles-panel .settings-panel-header').evaluate(el => el.getBoundingClientRect().height);
            assert.ok(headerHeight < 96, `compact profile intro: ${headerHeight}`);
            if (width < 681) assert.equal(await page.locator('#pi-profiles-list').isVisible(), false);
            await page.locator('#pi-profile-form [name=description]').fill('Unsent overview draft');
            if (width > 680) {
                await page.locator('.pi-profile-row').first().click();
                assert.equal(await page.locator('.pi-profile-confirm[open]').count(), 0, 'same profile must retain draft without confirmation');
            } else {
                await page.locator('#pi-profile-list-back').click();
                await page.evaluate(id => PiAgentProfilesUI.open({ profileId: id }), rows[0].id);
                await page.locator('#pi-profile-form [name=description]').waitFor({ state: 'visible' });
                assert.equal(await page.locator('#pi-profile-form [name=description]').inputValue(), 'Unsent overview draft');
            }
            await page.locator('[data-profile-section=soul]').click();
            await page.locator('#pi-profile-form [name=soul]').fill(rows[0].soul + '\n\nKeep this draft.');
            await page.locator('#pi-profile-form [type=submit]').click();
            await page.waitForFunction(() => document.querySelector('#pi-profile-save-state')?.classList.contains('is-dirty') === false);
            assert.equal(await page.locator('[data-profile-section=soul]').getAttribute('aria-current'), 'page', 'saving retains the current editor');
            await geometry(); await shot('soul');
            await page.locator('[data-profile-section=user]').click();
            await page.locator('#pi-profile-document-text:not([disabled])').waitFor();
            await geometry(); await shot('user');
            const original = await page.locator('#pi-profile-document-text').inputValue();
            await page.locator('#pi-profile-document-text').fill('Unsaved document');
            await page.locator('#pi-profile-document-text').fill(original);
            assert.equal(await page.locator('#pi-profile-document-save').isDisabled(), true, 'reverting text clears dirty state');
            holdRefresh = true;
            await page.locator('#pi-profile-document-refresh').click();
            await page.waitForTimeout(80);
            await page.locator('#pi-profile-document-text').fill('Typed while refresh is pending');
            holdRefresh = false; releaseRefresh();
            await page.waitForFunction(() => !document.querySelector('#pi-profile-document-refresh').disabled);
            assert.equal(await page.locator('#pi-profile-document-text').inputValue(), 'Typed while refresh is pending');
            await page.locator('[data-profile-section=memory]').click();
            await page.locator('#pi-profile-document-text:not([disabled])').waitFor();
            await geometry(); await shot('memory');
            await page.locator('[data-profile-section=skills]').click();
            await page.locator('.pi-learning-settings').waitFor();
            await geometry(); await shot('skills');
            await page.locator('.pi-learning').scrollIntoViewIfNeeded();
            await geometry(); await shot('learning');
            await page.locator('[data-profile-section=projects]').click();
            await page.locator('.pi-profile-projects article').waitFor();
            await geometry(); await shot('projects');
            await page.locator('#pi-profile-editor-close').click();
            await page.locator('.pi-profile-confirm[open]').waitFor();
            await shot('confirm');
            assert.equal(await page.locator('.pi-profile-confirm .settings-secondary-button').evaluate(el => el === document.activeElement), true);
            await page.keyboard.press('Escape');
            await page.locator('[data-profile-section=user]').click();
            assert.equal(await page.locator('#pi-profile-document-text').inputValue(), 'Typed while refresh is pending');
            await page.locator('#pi-profile-editor-close').click();
            await page.locator('.pi-profile-confirm .settings-primary-button').click();
            await page.locator('.pi-profile-row').last().click();
            await page.locator('[data-profile-section=memory]').click();
            await page.waitForFunction(() => document.querySelector('[data-profile-overview]'));
            assert.equal(await page.locator('#pi-profile-document-text').isVisible(), false);
            await page.locator('[data-profile-overview]').click();
            assert.equal(await page.locator('[data-profile-section=overview]').getAttribute('aria-current'), 'page');
            assert.deepEqual(nativeDialogs, []);
            assert.deepEqual(errors, []);
            assert.equal(writes.length, 1, 'only the explicit profile save writes data');
            await context.close();
        }
        console.log('Profile workspace: desktop/tablet/mobile, light/dark, Chinese/English, all subpages, draft protection, save position, refresh race and overflow passed.');
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
