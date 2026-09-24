const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '../..');
const evidence = process.env.PIVANE_TEST_SCREENSHOT_DIR || os.tmpdir();
const profile = { id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Research', description: 'Notes', soul: 'Be exact', enabled: true,
    avatar: { kind: 'emoji', value: '✦' }, memory: { enabled: true, autoLearn: false, memoryCharLimit: 16000, userCharLimit: 8000 }, skills: { learnedEnabled: true } };
const second = { ...profile, id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', name: 'Writing' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
const app = express();
app.get('/api/pi/profiles/:id/avatar', (_req, res) => res.type('png').send(png));
app.use(express.static(path.join(root, 'public')));
app.get('/fixture', (_req, res) => res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root {--text-main:#25312c;--text-soft:#5c6560;--text-muted:#64706a;--surface-1:#fff;--surface-2:#edf4ed;--line:#c9d1ca;--line-strong:#a9b7ac;--accent:#137757}body {font:16px system-ui;margin:0;padding:20px;background:#f7f9f7;color:var(--text-main)}.workspace-settings-content {max-width:1100px;margin:auto}.workspace-settings-panel {padding:12px 0}.settings-primary-button,.settings-secondary-button {padding:9px 12px;border:1px solid var(--line);background:#fff;color:var(--text-main);cursor:pointer}.settings-panel-header{display:flex;align-items:center;gap:10px}button{font:inherit}</style>
<link rel="stylesheet" href="/pi-agent-profiles.css"><link rel="stylesheet" href="/pi-extensions.css"></head><body>
<nav class="workspace-settings-nav"><button id="pi-profiles-nav" hidden><span></span></button><button data-settings-tab="extensions"><span>Extensions</span></button><button data-settings-tab="packages"><span>Packages</span></button><button data-settings-tab="skills"><span>Skills</span></button></nav>
<div id="workspace-settings-dialog"><div class="workspace-settings-dialog"><h2 id="workspace-settings-title"></h2><button id="workspace-settings-close"></button><div class="workspace-settings-content"><section id="pi-profiles-panel" class="workspace-settings-panel"><div class="settings-panel-header"><i aria-hidden="true"></i><div><h3>Profiles</h3><p></p></div><button id="pi-profiles-refresh">Refresh</button></div><div id="pi-profiles-content"></div></section></div></div></div>
<span id="pi-session-profile" hidden></span><dl><div id="pi-meta-profile-row" hidden><dt></dt><dd id="pi-meta-profile"></dd></div></dl><div class="pi-empty-state"></div>
<script src="/pi-agent-profiles.js"></script><script src="/pi-extensions.js"></script>
<script>window.addEventListener('DOMContentLoaded', () => { window.fixtureCwd = '/synthetic/project'; window.PiAgentProfilesUI = PiAgentProfiles.create({ apiFetch: window.syntheticFetch, currentCwd: () => window.fixtureCwd }); if (!window.synthetic.deferCapability) window.PiAgentProfilesUI.setEnabled(true, true); PiExtensions.connect({ apiFetch: window.syntheticFetch, currentCwd: () => window.fixtureCwd }); PiExtensions.setAssistantEnabled(true); });</script></body></html>`));

async function main() {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    let browser;
    try {
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
        for (const width of [1440, 393, 320]) {
            const context = await browser.newContext({ viewport: { width, height: 900 } });
            const page = await context.newPage(), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.addInitScript(({ p, other }) => {
                window.synthetic = { profile: p, second: other, created: [], revision: 'r1', document: 'Original USER', documentRevision: 'd1', conflict: false, calls: [], navigation: null, skillStatus: 'ready', skillFail: false, skillHold: false, skillRelease: null, deferCapability: window.innerWidth === 393, heldProfileRequests: [] };
                window.PiChatNavigation = { openSession: async value => { window.synthetic.navigation = value; } };
                window.syntheticFetch = async (url, options = {}) => {
                    const s = window.synthetic, method = options.method || 'GET', body = options.body ? JSON.parse(options.body) : null;
                    s.calls.push({ url, method, body });
                    if (url.startsWith('/api/pi/profiles/authoring-sessions/') && method === 'GET') return { status: 'ready', profileId: s.lastAuthoringProfileId === undefined ? s.profile.id : s.lastAuthoringProfileId, profileRevision: null, proposal: { name: 'Proposed name', user: 'Proposed USER' } };
                    if (url === '/api/pi/profiles/authoring-sessions') {
                        if (s.holdAuthoring) await new Promise(resolve => { s.authoringRelease = resolve; });
                        s.lastAuthoringProfileId = body.profileId; return { session: { id: 'authoring-1', cwd: '/synthetic/project' }, prompt: 'Please discuss my profile' };
                    }
                    if (url.includes('/documents?')) return { status: 'ready', content: s.document, revision: s.documentRevision, profileRevision: s.revision, indexSynced: s.indexSynced !== false, indexStatus: s.indexSynced === false ? 'pending' : 'ready', usage: { used: s.document.length, limit: 8000, unit: 'characters' } };
                    if (url.endsWith('/documents') && method === 'PUT') {
                        if (s.conflict) throw Object.assign(new Error('Conflict'), { status: 409 });
                        s.document = body.content; s.documentRevision = 'd2'; s.indexSynced = true;
                        return { status: 'ready', content: s.document, revision: s.documentRevision, profileRevision: s.revision, indexSynced: true, indexStatus: 'ready', usage: { used: s.document.length, limit: 8000, unit: 'characters' } };
                    }
                    if (url.endsWith('/avatar') && method === 'POST') {
                        if (!body.dataUrl.startsWith('data:image/png;base64,')) throw new Error('Expected PNG upload');
                        if (s.avatarHold) await new Promise(resolve => { s.avatarRelease = resolve; });
                        s.avatarUploaded = true; s.profile.avatar = { kind: 'image', version: 'synthetic' }; s.revision = 'r-avatar';
                        return { ok: true, profile: s.profile, revision: s.revision };
                    }
                    if (/\/skills\/s[12]$/.test(url)) {
                        if (s.skillHold && url.includes(p.id)) await new Promise(resolve => { s.skillRelease = resolve; });
                        if (s.skillFail) throw new Error('Synthetic read error');
                        return s.skillStatus === 'ready' ? { version: 1, profileId: url.includes(p.id) ? p.id : other.id, status: 'ready', item: { id: url.endsWith('s1') ? 's1' : 's2', name: 'Check sources', description: 'Use references', scope: 'project', source: 'profile-owned', content: '<img src=x onerror=alert(1)>\n# Real skill text', revision: 's-revision' } } : { version: 1, status: s.skillStatus };
                    }
                    if (url.includes('/memory?')) return { status: s.memoryStatus || 'ready', items: s.memoryStatus ? [] : [{ kind: 'skill', id: url.includes(p.id) ? 's1' : 's2', name: url.includes(p.id) ? 'Check sources' : 'Draft outline', description: 'Use references', scope: 'project', source: 'profile-owned' }], hasMore: false };
                    if (url.startsWith('/api/pi/assistant-projects')) return { projects: [{ id: 'g1', name: 'Notes', cwd: '/synthetic/project' }] };
                    if (url === '/api/pi/profiles' && method === 'PUT') {
                        const updated = { ...body.profile, id: body.profile.id || (s.created.length ? 'dddddddd-dddd-4ddd-dddd-dddddddddddd' : 'cccccccc-cccc-4ccc-cccc-cccccccccccc') };
                        if (body.profile.id) s.profile = updated; else s.created.push(updated);
                        s.revision = 'r2'; return { revision: s.revision, profile: updated };
                    }
                    if (url.startsWith('/api/pi/profiles') && method === 'GET') {
                        if (s.holdProfileReads) await new Promise(resolve => { s.heldProfileRequests.push(resolve); });
                        return { version: 1, revision: s.revision, cwd: window.fixtureCwd || null, profiles: s.emptyProfiles ? [] : [structuredClone(s.profile), structuredClone(s.second), ...structuredClone(s.created)] };
                    }
                    throw new Error(`Unexpected ${method} ${url}`);
                };
            }, { p: profile, other: second });
            await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
            if (width === 1440) {
                await page.evaluate(() => PiAgentProfilesUI.open());
                await page.locator('.pi-profile-empty').waitFor();
                assert.equal(await page.locator('.pi-profiles-layout').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 2);
            }
            if (width === 393) {
                await page.evaluate(() => PiAgentProfilesUI.open({ profileId: synthetic.profile.id, section: 'user', authoringSession: { id: 'authoring-1', cwd: '/synthetic/project' } }));
                assert.equal(await page.evaluate(() => synthetic.calls.filter(call => call.url.startsWith('/api/pi/profiles?')).length), 0);
                await page.evaluate(() => { PiAgentProfilesUI.setEnabled(false); PiAgentProfilesUI.setEnabled(true, true); });
                await page.locator('#pi-profile-document-text:not([disabled])').waitFor();
                assert.equal(await page.locator('[data-profile-section="user"]').getAttribute('aria-current'), 'page');
                assert.equal(await page.locator('#pi-profile-form [name=name]').inputValue(), 'Research');
                await page.waitForFunction(() => synthetic.calls.some(call => call.url.includes('/authoring-sessions/authoring-1/draft')));
                const reads = await page.evaluate(() => synthetic.calls.filter(call => call.url.startsWith('/api/pi/profiles?')).length);
                await page.evaluate(() => { PiAgentProfilesUI.setEnabled(true, true); PiAgentProfilesUI.setEnabled(true, true); });
                assert.equal(await page.evaluate(() => synthetic.calls.filter(call => call.url.startsWith('/api/pi/profiles?')).length), reads, 'repeated capability event must not reload');
            }
            await page.evaluate(() => PiAgentProfilesUI.open({ profileId: window.synthetic.profile.id }));
            await page.locator('#pi-profile-form').waitFor();
            await page.locator('[data-profile-section="overview"]').click();
            await page.locator('#pi-profile-form [name=description]').fill('Draft kept while capability is unavailable');
            await page.evaluate(() => PiAgentProfilesUI.setEnabled(false));
            assert.equal(await page.locator('#pi-profile-form [type=submit]').isDisabled(), true);
            assert.equal(await page.locator('#pi-profile-form [data-profile-assist]').isDisabled(), true);
            assert.equal(await page.locator('#pi-profile-form [name=description]').inputValue(), 'Draft kept while capability is unavailable');
            await page.evaluate(() => PiAgentProfilesUI.setEnabled(true, true));
            await page.waitForFunction(() => document.querySelector('#pi-profile-form [type=submit]')?.disabled === false);
            assert.equal(await page.locator('#pi-profile-form [name=description]').inputValue(), 'Draft kept while capability is unavailable');
            await page.locator('#pi-profile-form [name=description]').fill('Notes');
            if (width === 393) await page.locator('[data-profile-section="overview"]').click();
            if (width === 1440) {
                await page.evaluate(() => { synthetic.holdProfileReads = true; PiAgentProfilesUI.open({ profileId: synthetic.profile.id, section: 'skills' }); PiAgentProfilesUI.open({ profileId: synthetic.second.id, section: 'overview' }); });
                await page.waitForFunction(() => synthetic.heldProfileRequests.length === 2);
                await page.evaluate(() => synthetic.heldProfileRequests[1]());
                await page.waitForFunction(() => document.querySelector('#pi-profile-form [name=name]')?.value === 'Writing');
                await page.evaluate(() => synthetic.heldProfileRequests[0]());
                await page.waitForTimeout(50);
                assert.equal(await page.locator('#pi-profile-form [name=name]').inputValue(), 'Writing', 'stale open must not select prior profile');
                await page.evaluate(() => { synthetic.holdProfileReads = false; PiAgentProfilesUI.open({ profileId: synthetic.profile.id }); });
                await page.waitForFunction(() => document.querySelector('#pi-profile-form [name=name]')?.value === 'Research');
            }
            const image = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 4; canvas.getContext('2d').fillRect(0, 0, 4, 4); return canvas.toDataURL('image/jpeg').split(',')[1]; });
            if (width === 1440) await page.evaluate(() => { synthetic.avatarHold = true; });
            await page.locator('#pi-profile-avatar-upload').setInputFiles({ name: 'avatar.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(image, 'base64') });
            if (width === 1440) {
                await page.waitForFunction(() => !!synthetic.avatarRelease);
                assert.equal(await page.locator('#pi-profile-form [type=submit]').isDisabled(), true);
                await page.evaluate(() => synthetic.avatarRelease());
            }
            await page.waitForFunction(() => synthetic.avatarUploaded === true);
            await page.waitForFunction(() => document.querySelector('#pi-profile-avatar-status')?.textContent.includes('已单独保存'));
            assert.equal(await page.locator('#pi-profile-form [type=submit]').isDisabled(), false);
            await page.locator('[data-profile-section="projects"]').click();
            await page.locator('.pi-profile-projects article').waitFor();
            assert.match(await page.locator('.pi-profile-projects article').innerText(), /Notes/);
            await page.locator('[data-profile-section="user"]').click();
            await page.locator('#pi-profile-document-text:not([disabled])').waitFor();
            await page.evaluate(() => { synthetic.indexSynced = false; });
            await page.locator('#pi-profile-document-refresh').click();
            await page.locator('#pi-profile-document-sync:not([hidden])').waitFor();
            await page.locator('#pi-profile-document-text').fill('Local draft during index repair');
            await page.locator('#pi-profile-document-sync').click();
            await page.waitForFunction(() => window.synthetic.indexSynced === true);
            assert.equal(await page.evaluate(() => synthetic.document), 'Original USER', 'index repair submits stored content, not the unsaved draft');
            assert.equal(await page.locator('#pi-profile-document-text').inputValue(), 'Local draft during index repair');
            await page.locator('#pi-profile-document-reviewed').check();
            await page.locator('#pi-profile-document-save').click();
            await page.waitForFunction(() => window.synthetic.document === 'Local draft during index repair');
            await page.locator('#pi-profile-document-text').fill('Unsaved USER');
            await page.locator('[data-profile-section="overview"]').click();
            await page.locator('[data-profile-section="user"]').click();
            assert.equal(await page.locator('#pi-profile-document-text').inputValue(), 'Unsaved USER');
            await page.evaluate(() => { synthetic.conflict = true; });
            await page.locator('#pi-profile-document-save').click();
            await page.waitForFunction(() => document.querySelector('#pi-profile-document-status')?.textContent.includes('草稿'));
            assert.equal(await page.locator('#pi-profile-document-text').inputValue(), 'Unsaved USER');
            await page.evaluate(() => { synthetic.conflict = false; synthetic.document = 'Server USER'; synthetic.documentRevision = 'd3'; });
            await page.locator('#pi-profile-document-refresh').click();
            await page.locator('.pi-profile-server-version summary').click();
            await page.locator('.pi-profile-server-version pre').waitFor();
            assert.equal(await page.locator('.pi-profile-server-version pre').innerText(), 'Server USER');
            assert.equal(await page.locator('#pi-profile-document-save').isDisabled(), true);
            await page.locator('#pi-profile-document-reviewed').check();
            await page.locator('#pi-profile-document-save').click();
            await page.waitForFunction(() => window.synthetic.document === 'Unsaved USER');
            await page.locator('[data-profile-section="overview"]').click();
            await page.locator('[data-profile-assist]').last().click();
            await page.waitForFunction(() => !!window.synthetic.navigation);
            const navigation = await page.evaluate(() => synthetic.navigation);
            assert.equal(navigation.draft, 'Please discuss my profile');
            assert.ok(!(await page.evaluate(() => synthetic.calls)).some(call => call.url.includes('send')));
            await page.locator('#pi-profile-form [name=description]').fill('Keep my description');
            await page.evaluate(() => PiAgentProfilesUI.open({ profileId: synthetic.profile.id, authoringSession: { id: 'authoring-1', cwd: '/synthetic/project' } }));
            await page.locator('#pi-profile-proposal-apply').click();
            assert.equal(await page.locator('#pi-profile-form [name=name]').inputValue(), 'Proposed name');
            assert.equal(await page.locator('#pi-profile-form [name=description]').inputValue(), 'Keep my description');
            await page.locator('#pi-profile-form [name=memoryCharLimit]').fill('8192');
            await page.locator('#pi-profile-form [type=submit]').click();
            await page.waitForFunction(() => synthetic.profile.name === 'Proposed name');
            assert.equal(await page.evaluate(() => synthetic.profile.memory.memoryCharLimit), 8192);
            await page.locator('[data-profile-section="user"]').click();
            assert.equal(await page.locator('#pi-profile-document-text').inputValue(), 'Proposed USER');
            await page.locator('#pi-profile-document-refresh').click();
            await page.locator('.pi-profile-server-version summary').click();
            await page.locator('.pi-profile-server-version pre').waitFor();
            assert.equal(await page.locator('#pi-profile-document-save').isDisabled(), true);
            await page.locator('#pi-profile-document-reviewed').check();
            await page.locator('#pi-profile-document-save').click();
            await page.waitForFunction(() => synthetic.document === 'Proposed USER');
            await page.locator('[data-profile-section="overview"]').click();
            await page.locator('[data-profile-section="skills"]').click();
            await page.evaluate(() => { synthetic.profile.skills.learnedEnabled = false; synthetic.memoryStatus = 'disabled'; PiAgentProfilesUI.projectChanged(); });
            await page.waitForFunction(() => document.querySelector('#pi-profile-memory-status')?.textContent.includes('已学习技能已停用'));
            await page.evaluate(() => { synthetic.profile.skills.learnedEnabled = true; synthetic.profile.memory.enabled = false; PiAgentProfilesUI.projectChanged(); });
            await page.waitForFunction(() => document.querySelector('#pi-profile-memory-status')?.textContent.includes('数据不可用'));
            await page.locator('[data-kind="memories"]').click();
            await page.waitForFunction(() => document.querySelector('#pi-profile-memory-status')?.textContent.includes('记忆已停用'));
            await page.evaluate(() => { synthetic.profile.enabled = false; PiAgentProfilesUI.projectChanged(); });
            await page.waitForFunction(() => document.querySelector('#pi-profile-memory-status')?.textContent.includes('身份已停用'));
            await page.evaluate(() => { synthetic.profile.enabled = true; synthetic.profile.memory.enabled = true; synthetic.memoryStatus = null; PiAgentProfilesUI.projectChanged(); });
            await page.locator('[data-kind="skills"]').click();
            await page.locator('.pi-profile-memory-item details').first().evaluate(el => { el.open = true; });
            await page.waitForFunction(() => document.querySelector('.pi-profile-skill-text')?.textContent.includes('# Real skill text'));
            assert.equal(await page.locator('.pi-profile-memory-item img').count(), 0);
            await page.locator('.pi-profile-memory-item details').first().evaluate(el => { el.open = false; });
            await page.evaluate(() => { synthetic.skillStatus = 'missing'; });
            await page.locator('.pi-profile-memory-item details').first().evaluate(el => { el.open = true; });
            await page.waitForFunction(() => document.querySelector('.pi-profile-skill-text')?.textContent.includes('不可用'));
            await page.locator('.pi-profile-memory-item details').first().evaluate(el => { el.open = false; });
            await page.evaluate(() => { synthetic.skillStatus = 'ready'; synthetic.skillFail = true; });
            await page.locator('.pi-profile-memory-item details').first().evaluate(el => { el.open = true; });
            await page.waitForFunction(() => document.querySelector('.pi-profile-skill-text')?.textContent.includes('Synthetic read error'));
            await page.locator('.pi-profile-memory-item details').first().evaluate(el => { el.open = false; });
            await page.evaluate(() => { synthetic.skillFail = false; synthetic.skillHold = true; });
            await page.locator('.pi-profile-memory-item details').first().evaluate(el => { el.open = true; });
            await page.waitForFunction(() => !!synthetic.skillRelease);
            await page.locator('[data-profile-section="overview"]').click();
            await page.evaluate(() => synthetic.skillRelease());
            assert.equal(await page.locator('.pi-profile-skill-text').count(), 0);
            await page.evaluate(() => PiExtensions.setView('extensions'));
            assert.equal(await page.locator('.workspace-settings-nav [data-settings-tab="extensions"]').isVisible(), true);
            await page.locator('.extensions-card').first().waitFor();
            assert.equal(await page.locator('#extensions-learned').count(), 0);
            const overflow = await page.evaluate(() => [...document.querySelectorAll('body,#pi-profiles-content,.pi-profiles-layout,.pi-profile-detail,#extensions-featured')].filter(el => el.scrollWidth > el.clientWidth + 2).map(el => `${el.tagName}.${el.className}:${el.scrollWidth}/${el.clientWidth}`));
            assert.deepEqual(overflow, []);
            assert.deepEqual(errors, []);
            fs.mkdirSync(evidence, { recursive: true });
            await page.screenshot({ path: path.join(evidence, `pages-${width}.png`), fullPage: true });
            await page.evaluate(() => { fixtureCwd = ''; PiAgentProfilesUI.projectChanged(); });
            await page.waitForFunction(() => document.querySelector('#pi-profiles-status')?.textContent === '');
            page.once('dialog', dialog => dialog.accept());
            await page.locator('#pi-profile-add').click();
            await page.locator('#pi-profile-form [name=name]').fill('New assistant');
            assert.equal(await page.locator('#pi-profile-form [type=submit]').isDisabled(), false);
            await page.locator('#pi-profile-form [type=submit]').click();
            await page.waitForFunction(() => synthetic.created.length === 1);
            await page.locator('#pi-profile-editor-close').click();
            await page.evaluate(() => { synthetic.emptyProfiles = true; synthetic.navigation = null; synthetic.holdAuthoring = true; PiAgentProfilesUI.projectChanged(); });
            await page.waitForFunction(() => document.querySelector('#pi-profiles-list')?.textContent.includes('尚无'));
            await page.locator('#pi-profiles-list [data-profile-assist]').click();
            await page.waitForFunction(() => !!synthetic.authoringRelease);
            await page.evaluate(() => document.querySelector('#pi-profiles-list [data-profile-assist]').click());
            assert.equal(await page.evaluate(() => synthetic.calls.filter(call => call.url === '/api/pi/profiles/authoring-sessions').length), 2);
            await page.evaluate(() => synthetic.authoringRelease());
            await page.waitForFunction(() => synthetic.navigation?.sessionId === 'authoring-1');
            assert.equal((await page.evaluate(() => synthetic.calls.filter(call => call.url === '/api/pi/profiles/authoring-sessions').at(-1))).body.profileId, null);
            await page.evaluate(() => PiAgentProfilesUI.open({ authoringSession: { id: 'authoring-1', cwd: '/synthetic/project' } }));
            await page.locator('#pi-profile-proposal-apply').click();
            assert.equal(await page.locator('#pi-profile-form [name=name]').inputValue(), 'Proposed name');
            await context.close();
        }
        console.log(`Assistant pages: profile documents, avatar conversion, authoring, learned skills, stale details and geometry passed at 1440/393/320; screenshots: ${evidence}/pages-{1440,393,320}.png`);
    } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
