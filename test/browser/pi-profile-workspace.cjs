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
        soul: '# 协作方式\n\n用清晰、温暖的语言解释复杂问题。\n\n## 学习与交流\n\n- 先理解问题，再拆解关键步骤。\n- 使用具体例子帮助理解。\n- 对不确定的内容给出核对方法。', memory: { enabled: true, autoLearn: false }, skills: { learnedEnabled: true } },
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
        for (const [width, locale, theme] of [[1440, 'zh-CN', 'light'], [1440, 'en', 'dark'], [900, 'en', 'violet'], [393, 'zh-CN', 'light'], [320, 'en', 'dark']]) {
            const context = await browser.newContext({ viewport: { width, height: 900 }, locale, isMobile: width < 681, hasTouch: width < 681 });
            const page = await context.newPage(), errors = [], nativeDialogs = [], writes = [];
            const rows = structuredClone(profiles);
            let saveMode = 'ok', revision = 1, heldSave, releaseSave;
            const trash = [{ ...structuredClone(profiles[1]), id: 'cccccccc-cccc-4ccc-cccc-cccccccccccc', name: 'Old writing partner' }];
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
                    const body = req.postDataJSON(); writes.push({ p, body, method: req.method() });
                    if (p === '/api/pi/profiles') {
                        if (saveMode === 'conflict') return route.fulfill({ status: 409, json: { error: 'Synthetic revision conflict' } });
                        if (saveMode === 'hold') await new Promise(resolve => { releaseSave = resolve; heldSave = true; });
                        const index = rows.findIndex(row => row.id === body.profile.id);
                        const profile = { ...body.profile, id: body.profile.id || 'dddddddd-dddd-4ddd-dddd-dddddddddddd',
                            memory: { ...rows[index]?.memory, ...body.profile.memory } };
                        if (index < 0) rows.push(profile); else rows[index] = profile;
                        revision++;
                        if (saveMode === 'uncertain') return route.abort('failed');
                        return reply({ revision: `r${revision}`, profile });
                    }
                    if (p.endsWith('/trash')) { const index = rows.findIndex(row => p.includes(row.id)); trash.push(rows.splice(index, 1)[0]); revision++; return reply({ ok: true, revision: `r${revision}` }); }
                    if (p.endsWith('/restore')) { const index = trash.findIndex(row => p.includes(row.id)); rows.push(trash.splice(index, 1)[0]); revision++; return reply({ ok: true, revision: `r${revision}` }); }
                    return reply({ ok: true });
                }
                if (p === '/api/pi/status') return reply({ ok: true, agentProfiles: true, assistantProjects: true, profileMemory: true, projectRoots: ['/synthetic'], defaultProject: cwd });
                if (p === '/api/pi/projects') return reply({ projects: [{ cwd, name: 'Synthetic project', sessionCount: 0 }], roots: ['/synthetic'] });
                if (p === '/api/pi/profiles') return reply({ version: 1, revision: `r${revision}`, cwd, profiles: rows, profileRevisions: { [rows[0].id]: 'p1' }, ...(width !== 900 ? { trash } : {}) });
                if (p.endsWith('/documents')) return reply({ status: 'ready', target: url.searchParams.get('target'), content: '# Saved document', revision: 'd1', profileRevision: 'p1', usage: { used: 16, limit: 8000 } });
                if (p.includes('/knowledge/items/')) return reply({ version: 1, status: 'ready', item: { id: p.split('/').at(-1), kind: 'memory', category: 'preference', content: '完整的合成记忆正文。'.repeat(60), state: 'active', scope: 'profile', revision: 's1' } });
                if (p.endsWith('/knowledge')) return reply({ version: 1, status: 'ready', revision: 'a'.repeat(64), items: url.searchParams.get('kind') === 'memory'
                    ? Array.from({ length: 18 }, (_, i) => ({ id: `memory-${i}`, kind: 'memory', content: `合成记忆 ${i + 1}：用于验证长列表中的就地展开。`, category: 'preference', state: 'active', scope: 'profile', revision: 's1' }))
                    : [{ id: 'skill-1', kind: 'skill', name: 'source-review', description: '核对引用、比较来源并整理可复用的研究方法。', state: 'active', scope: 'profile', revision: 's1' }], counts: { memory: { total: 42, user: 12, memory: 26, project: 4 }, skill: { total: 8, active: 6, draft: 2, disabled: 0 } }, receipts: [{ id: 'receipt-1', itemId: 'memory-1', kind: 'memory', operation: 'create', preview: '喜欢先了解整体思路，再逐步展开细节。', origin: 'learning', at: new Date().toISOString() }], hasMore: false, usage: { memory: { chars: 13800, limit: 16000 }, user: { chars: 396, limit: 8000 } }, capabilities: { memory: true, skill: true } });
                if (p.endsWith('/learning')) return reply({ version: 1, revision: 1, health: { state: p.includes(profiles[1].id) ? 'off' : 'quota-exhausted', today: { runs: 20, maxRuns: 20, reservedTokens: 120000, maxTokens: 200000, exhaustedBy: 'runs' } }, drafts: { pending: 2 }, proposals: [], settings: { enabled: true, correctionEnabled: true, reviewEnabled: false, extractionEnabled: true, maxRunsPerDay: 20, maxTokensPerDay: 200000, periodicReviewMinutes: 0 }, jobs: [], recentRuns: [], capabilities: { settingsWrite: true, installed: true } });
                if (p === '/api/pi/assistant-projects') return reply({ projects: [{ id: 'p1', name: '研究笔记 / Research notes', cwd: '/synthetic/research/long-project-directory-for-layout-checking', description: '记录研究过程、参考资料与后续问题。' }] });
                if (p === '/api/pi/sessions') return reply({ sessions: [] });
                if (p === '/api/pi/activity') return reply({ runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] });
                return reply({});
            });
            await page.routeWebSocket('**/api/pi/ws', ws => ws.close());
            await page.goto(`${process.env.PIVANE_TEST_PROFILE_URL || `http://127.0.0.1:${server.address().port}`}/#/profiles`);
            await page.locator('.pi-profile-row').first().waitFor();
            const shot = async name => { await page.waitForTimeout(220); return page.screenshot({ path: path.join(evidence, `profiles-${width}-${locale}-${theme}-${name}.png`) }); };
            const geometry = async () => {
                const overflow = await page.evaluate(() => [...document.querySelectorAll('body,#pi-profiles-panel,#pi-profiles-content,.pi-id-detail,.pi-id-card,.pi-id-page,.pi-id-header,.pi-id-stat')]
                    .filter(el => el.clientWidth && el.scrollWidth > el.clientWidth + 2).map(el => `${el.id || el.className}: ${el.scrollWidth}/${el.clientWidth}`));
                if (overflow.length) console.log(await page.locator('.pi-id-detail').evaluate(root => [...root.querySelectorAll('*')].filter(el => el.getBoundingClientRect().right > root.getBoundingClientRect().right + 2).map(el => [el.tagName, el.className, el.scrollWidth, el.clientWidth, el.getBoundingClientRect().right]).slice(0, 30)));
                assert.deepEqual(overflow, [], `${width}: overflow`);
            };
            const backToList = async () => { if (width < 681) await page.locator('#pi-profile-list-back').click(); };
            const confirmCancel = async () => { await page.locator('.pi-profile-confirm[open]').waitFor(); await page.keyboard.press('Escape'); };
            const confirmAccept = async () => { await page.locator('.pi-profile-confirm[open] .settings-primary-button').click(); };
            const persona = () => page.locator('[data-profile-section=persona]').click();
            const save = () => page.locator('[data-page=persona] .pi-id-savebar .pi-id-btn-primary').click();
            const waitSaved = () => page.waitForFunction(() => document.querySelector('[data-page=persona] .pi-id-savebar')?.dataset.visible === 'false');
            await geometry(); await shot('list');
            assert.equal(await page.locator('.pi-id-list-foot').count(), width === 900 ? 0 : 1, 'trash feature detection');
            await page.locator('#pi-profile-list-query').fill('development');
            assert.equal(await page.locator('.pi-profile-row:visible').count(), 1);
            await page.locator('#pi-profile-list-query').fill('no-match');
            assert.equal(await page.locator('.pi-profile-row:visible').count(), 0);
            await page.locator('#pi-profile-list-query').fill('');
            await page.locator('.pi-profile-row').first().click();
            await page.locator('.pi-id-stats').waitFor();
            await geometry(); await shot('overview');
            assert.equal(await page.locator('#pi-profiles-panel .settings-panel-header').isVisible(), false);
            if (width < 681) assert.equal(await page.locator('#pi-profiles-list').isVisible(), false);
            await persona();
            assert.equal(Object.hasOwn(rows[0].memory, 'memoryCharLimit'), false, 'legacy fixture omits optional MEMORY limit');
            assert.equal(Object.hasOwn(rows[0].memory, 'userCharLimit'), false, 'legacy fixture omits optional USER limit');
            const displayedLimits = {
                memoryCharLimit: Number(await page.locator('#pi-profile-form [name=memoryCharLimit]').inputValue()),
                userCharLimit: Number(await page.locator('#pi-profile-form [name=userCharLimit]').inputValue())
            };
            assert.deepEqual(displayedLimits, { memoryCharLimit: 16000, userCharLimit: 8000 });
            await geometry(); await shot('persona-top');
            if (width < 681) assert.equal(await page.locator('#pi-profile-form [name=name]').evaluate(el => getComputedStyle(el).fontSize), '16px');
            // The registry preserves existing memory key order when adding omitted limits.
            const legacyPuts = () => writes.filter(write => write.p === '/api/pi/profiles' && write.method === 'PUT');
            const beforeLegacySave = legacyPuts().length;
            saveMode = 'uncertain';
            await page.locator('#pi-profile-form [name=description]').fill('Legacy limits save applied with lost response');
            await save();
            await page.locator('#pi-profile-persona-notice .pi-id-notice').waitFor();
            assert.equal(legacyPuts().length, beforeLegacySave + 1);
            assert.equal(rows[0].description, 'Legacy limits save applied with lost response', 'the uncertain PUT applied on the server');
            assert.notDeepEqual(Object.keys(rows[0].memory), Object.keys(legacyPuts().at(-1).body.profile.memory), 'fixture retains registry memory key order');
            saveMode = 'ok';
            await page.locator('#pi-profiles-refresh').evaluate(el => el.click());
            await page.waitForFunction(() => document.querySelector('#pi-profile-persona-notice')?.textContent.includes(PiI18n.t('这些修改已保存。关闭草稿后可继续编辑身份。')));
            assert.equal(await page.locator('[data-page=persona] .pi-id-savebar .pi-id-btn-primary').isDisabled(), true, 'applied legacy save cannot become a fresh submit');
            await page.keyboard.press('Control+s');
            assert.equal(legacyPuts().length, beforeLegacySave + 1, 'reconciliation never sends a second PUT');
            await page.locator('#pi-profile-editor-close').click(); await confirmAccept();
            await page.locator('.pi-profile-row').first().click(); await persona();
            await page.locator('#pi-profile-form [name=description]').fill('Unsent persona draft');
            assert.equal(await page.locator('[data-page=persona] .pi-id-savebar').getAttribute('data-visible'), 'true');
            await backToList();
            await page.locator('.pi-profile-row').first().click();
            assert.equal(await page.locator('.pi-profile-confirm[open]').count(), 0, 'reselect retains draft');
            await backToList(); await page.locator('.pi-profile-row').nth(1).click();
            await confirmCancel();
            if (width < 681) await page.locator('.pi-profile-row').first().click();
            await persona(); assert.equal(await page.locator('#pi-profile-form [name=description]').inputValue(), 'Unsent persona draft');
            await page.locator('#pi-profile-form [name=soul]').fill(rows[0].soul + '\n\nKeep this draft.');
            await page.locator('[data-page=persona] [data-value=preview]').click();
            assert.match(await page.locator('[data-page=persona] .pi-id-editor-preview').innerText(), /Keep this draft/);
            await page.locator('[data-page=persona] [data-value=edit]').click();
            await geometry(); await shot('persona-dirty');
            await page.locator('.pi-id-detail').evaluate(el => { el.scrollTop = 0; }); await shot('persona-savebar');
            saveMode = 'hold'; await save();
            while (!heldSave) await page.waitForTimeout(10);
            assert.equal(await page.locator('#pi-profile-form [name=soul]').isDisabled(), true);
            assert.equal(writes.at(-1).method, 'PUT', 'legacy profile sends its save');
            assert.equal(writes.at(-1).body.profile.memory.memoryCharLimit, displayedLimits.memoryCharLimit);
            assert.equal(writes.at(-1).body.profile.memory.userCharLimit, displayedLimits.userCharLimit);
            assert.equal(await page.locator('#pi-profile-persona-notice').innerText(), '', 'default limits do not trigger an advanced-settings validation notice');
            await page.locator('[data-profile-section=skills]').click();
            assert.equal(await page.locator('#pi-profiles-content').getAttribute('data-section'), 'persona', 'held save keeps the current section');
            await page.locator('.pi-id-toasts').getByText(await page.evaluate(() => PiI18n.t('正在保存，请等待服务器确认后再离开。')), { exact: true }).waitFor();
            assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), true);
            releaseSave(); saveMode = 'ok'; await waitSaved();
            assert.equal(await page.locator('[data-profile-section=persona]').getAttribute('aria-current'), 'page');
            assert.equal(rows[0].description, 'Unsent persona draft');
            assert.equal(rows[0].memory.memoryCharLimit, displayedLimits.memoryCharLimit);
            assert.equal(rows[0].memory.userCharLimit, displayedLimits.userCharLimit);
            await page.locator('#pi-profile-form [name=description]').fill('Saved with Ctrl+S');
            await page.keyboard.press('Control+s'); await waitSaved();
            assert.equal(rows[0].description, 'Saved with Ctrl+S');
            await page.locator('#pi-profile-form [name=description]').fill('Saved with Cmd+S');
            await page.keyboard.press('Meta+s'); await waitSaved();
            assert.equal(rows[0].description, 'Saved with Cmd+S');
            await geometry(); await shot('persona-saved');
            saveMode = 'conflict';
            await page.locator('#pi-profile-form [name=description]').fill('Conflict draft'); await save();
            await page.locator('#pi-profile-persona-notice .pi-id-notice').waitFor();
            assert.equal(await page.locator('#pi-profile-form [name=description]').inputValue(), 'Conflict draft');
            assert.equal(await page.locator('[data-page=persona] .pi-id-savebar .pi-id-btn-primary').isDisabled(), true);
            const conflictWrites = writes.length;
            await page.keyboard.press('Control+s'); assert.equal(writes.length, conflictWrites, 'conflicts are not retried');
            saveMode = 'ok'; await page.locator('#pi-profiles-refresh').evaluate(el => el.click());
            await page.waitForFunction(() => !document.querySelector('[data-page=persona] .pi-id-savebar .pi-id-btn-primary').disabled);
            assert.equal(await page.locator('#pi-profile-form [name=description]').inputValue(), 'Conflict draft');
            await save(); await waitSaved();
            saveMode = 'uncertain'; await page.locator('#pi-profile-form [name=description]').fill('Uncertain but applied'); await save();
            await page.locator('#pi-profile-persona-notice .pi-id-notice').waitFor();
            const uncertainWrites = writes.length;
            await page.keyboard.press('Control+s'); assert.equal(writes.length, uncertainWrites, 'uncertain writes are not retried');
            saveMode = 'ok'; await page.locator('#pi-profiles-refresh').evaluate(el => el.click());
            await page.waitForFunction(() => document.querySelector('#pi-profile-persona-notice')?.textContent.includes(PiI18n.t('这些修改已保存。关闭草稿后可继续编辑身份。')));
            assert.equal(await page.locator('#pi-profile-form [name=description]').inputValue(), 'Uncertain but applied');
            assert.equal(await page.locator('[data-page=persona] .pi-id-savebar .pi-id-btn-primary').isDisabled(), true);
            await geometry(); await shot('reconcile');
            await page.locator('#pi-profile-editor-close').click(); await confirmAccept();
            await page.locator('.pi-profile-row').first().click(); await persona();
            assert.equal(await page.locator('#pi-profile-form [name=description]').inputValue(), 'Uncertain but applied');
            for (const [alias, resolved] of [['soul', 'persona'], ['user', 'memory'], ['projects', 'overview'], ['memory', 'memory'], ['skills', 'skills'], ['learning', 'learning']]) {
                await page.evaluate(({ id, alias }) => PiAgentProfilesUI.open({ profileId: id, section: alias }), { id: rows[0].id, alias });
                await page.waitForFunction(resolved => document.querySelector('#pi-profiles-content')?.dataset.section === resolved, resolved);
                if (alias === 'user' || alias === 'memory') await page.locator(`.pi-knowledge-target-row [data-value=${alias === 'user' ? 'user' : 'memory'}][aria-pressed=true]`).waitFor();
            }
            await page.evaluate(id => PiAgentProfilesUI.revealKnowledge(id, 'memory-1', 'memory'), rows[0].id);
            await page.waitForFunction(() => document.querySelector('#pi-profiles-content')?.dataset.section === 'memory');
            await page.evaluate(id => PiAgentProfilesUI.revealProjectMemory(id, 'verified-session'), rows[0].id);
            await page.waitForFunction(() => document.querySelector('#pi-profiles-content')?.dataset.section === 'memory');
            await persona(); await page.locator('#pi-profile-form [name=description]').fill('Panel close guard');
            await page.evaluate(() => PiWorkspaceRoute.navigate('assistant', {}));
            await confirmCancel();
            await page.waitForFunction(() => location.hash.startsWith('#/profiles'));
            assert.equal(await page.locator('#pi-profile-form [name=description]').inputValue(), 'Panel close guard');
            await page.locator('[data-profile-chat]').click(); await confirmCancel();
            assert.equal(await page.locator('#pi-profile-form [name=description]').inputValue(), 'Panel close guard');
            await page.locator('[data-page=persona] .pi-id-savebar .pi-id-btn-ghost').click(); await confirmAccept();
            await waitSaved();
            await page.locator('#pi-profile-avatar-picker').click();
            assert.equal(await page.locator('.pi-profile-emoji-grid button').count(), 16);
            await page.locator('.pi-profile-emoji-grid button').nth(2).click();
            await geometry(); await shot('avatar-draft');
            await page.locator('[data-page=persona] .pi-id-savebar .pi-id-btn-ghost').click(); await confirmAccept();
            await backToList(); await page.locator('#pi-profile-add').click();
            assert.equal(await page.locator('[data-profile-section=overview]').isDisabled(), true);
            await save();
            assert.equal(await page.locator('#pi-profile-form [name=name]').getAttribute('aria-invalid'), 'true');
            await geometry(); await shot('new');
            await page.locator('#pi-profile-editor-close').click();
            if (width === 1440 && locale === 'zh-CN') {
                await page.locator('.pi-profile-row').first().click(); await persona();
                await page.locator('[data-page=persona] .pi-id-menu > button').click();
                await page.locator('[data-page=persona] [role=menuitem]').first().click();
                await confirmCancel();
                assert.match(await page.locator('#pi-profile-form [name=soul]').inputValue(), /协作方式/);
                await page.locator('[data-page=persona] .pi-id-menu > button').click();
                await page.locator('[data-page=persona] [role=menuitem]').first().click(); await confirmAccept();
                assert.match(await page.locator('#pi-profile-form [name=soul]').inputValue(), /研究伙伴/);
                await page.locator('[data-page=persona] .pi-id-savebar .pi-id-btn-ghost').click(); await confirmAccept();
                await page.locator('.pi-id-list-foot summary').click();
                await page.locator('.pi-id-trash-row .pi-id-btn').click();
                await page.waitForFunction(() => document.querySelectorAll('.pi-profile-row').length === 3);
                await page.locator('.pi-id-header-actions .pi-id-menu > button').click();
                await page.locator('.pi-id-header-actions [role=menuitem]').last().click(); await confirmAccept();
                await page.waitForFunction(() => document.querySelectorAll('.pi-profile-row').length === 2);
                assert.equal(writes.filter(write => write.p.endsWith('/trash')).length, 1);
                assert.equal(writes.filter(write => write.p.endsWith('/restore')).length, 1);
            }
            assert.deepEqual(nativeDialogs, []);
            assert.deepEqual(errors, []);
            await context.close();
        }
        console.log('Profile workspace: selection/search, persona saves and Ctrl+S, guards, conflict/uncertain reconciliation, aliases, avatar, new validation, responsive geometry, themes/locales passed.');
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
