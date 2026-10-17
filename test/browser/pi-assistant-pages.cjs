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
<style>:root {--text-main:#25312c;--text-soft:#5c6560;--text-muted:#64706a;--surface-1:#fff;--surface-2:#edf4ed;--line:#c9d1ca;--line-strong:#a9b7ac;--accent:#137757}body {font:16px system-ui;margin:0;padding:20px;background:#f7f9f7;color:var(--text-main)}.workspace-settings-content {max-width:1100px;margin:auto}.workspace-settings-panel {padding:12px 0}.settings-primary-button,.settings-secondary-button {padding:9px 12px;border:1px solid var(--line);background:#fff;color:var(--text-main);cursor:pointer}.settings-panel-header{display:flex;align-items:center;gap:10px}button{font:inherit}.pi-profiles-layout{min-height:650px}.pi-id-detail{max-height:800px}:root{--surface-0:#f7f9f7;--surface-3:#e2ece5;--primary:#137757;--primary-contrast:#fff;--green:#137757;--amber:#a86c12;--danger:#b23a37;--blue:#2875ad;--radius:12px}</style>
<link rel="stylesheet" href="/pi-identity-ui.css"><link rel="stylesheet" href="/pi-agent-profiles.css"><link rel="stylesheet" href="/pi-profile-learning.css"><link rel="stylesheet" href="/pi-profile-knowledge.css"><link rel="stylesheet" href="/pi-extensions.css"></head><body>
<div id="workspace-settings-dialog"><div class="workspace-settings-dialog"><header class="workspace-settings-header"><h2 id="workspace-settings-title"></h2><button id="workspace-settings-close"></button></header><div class="workspace-settings-body"><nav class="workspace-settings-nav" aria-label="设置分类"></nav><div class="workspace-settings-content"><section id="pi-profiles-panel" class="workspace-settings-panel"><div class="settings-panel-header"><i aria-hidden="true"></i><div><h3>Profiles</h3><p></p></div></div><div id="pi-profiles-content"></div></section></div></div></div></div>
<span id="pi-session-profile" hidden></span><dl><div id="pi-meta-profile-row" hidden><dt></dt><dd id="pi-meta-profile"></dd></div></dl><div class="pi-empty-state"></div>
<script src="/pi-i18n-catalog.js"></script><script src="/pi-i18n.js"></script><script src="/pi-identity-ui.js"></script><script src="/pi-identity-templates.js"></script><script src="/pi-profile-dialog.js"></script><script src="/pi-profile-knowledge.js"></script><script src="/pi-profile-learning.js"></script><script src="/pi-agent-profiles.js"></script><script src="/pi-extensions.js"></script>
<script>window.addEventListener('DOMContentLoaded', () => { window.fixtureCwd = '/synthetic/project'; window.PiAgentProfilesUI = PiAgentProfiles.create({ apiFetch: window.syntheticFetch, currentCwd: () => window.fixtureCwd }); if (!window.synthetic.deferCapability) window.PiAgentProfilesUI.setEnabled(true, true); PiExtensions.connect({ apiFetch: window.syntheticFetch, currentCwd: () => window.fixtureCwd }); PiExtensions.setAssistantEnabled(true); });</script></body></html>`));

async function main() {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    let browser;
    try {
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
        for (const width of [1440, 393, 320]) {
            const context = await browser.newContext({ viewport: { width, height: 900 } });
            const page = await context.newPage(), errors = [], nativeDialogs = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('dialog', dialog => { nativeDialogs.push(dialog.message()); void dialog.dismiss(); });
            await page.addInitScript(({ p, other }) => {
                window.synthetic = { profile: p, second: other, created: [], revision: 'r1', document: 'Original USER', documentRevision: 'd1', calls: [], navigation: null, deferCapability: window.innerWidth === 393, heldProfileRequests: [] };
                window.PiChatNavigation = { openSession: async value => { window.synthetic.navigation = value; } };
                window.syntheticFetch = async (url, options = {}) => {
                    const s = window.synthetic, method = options.method || 'GET', body = options.body ? JSON.parse(options.body) : null;
                    s.calls.push({ url, method, body });
                    if (url.startsWith('/api/pi/profiles/authoring-sessions/') && method === 'GET') return { status: 'ready', profileId: s.lastAuthoringProfileId === undefined ? s.profile.id : s.lastAuthoringProfileId, profileRevision: s.revision, proposal: { name: 'Proposed name', user: 'Proposed USER' } };
                    if (url === '/api/pi/profiles/authoring-sessions') {
                        if (s.holdAuthoring) await new Promise(resolve => { s.authoringRelease = resolve; });
                        s.lastAuthoringProfileId = body.profileId; return { session: { id: 'authoring-1', cwd: '/synthetic/project' }, prompt: 'Please discuss my profile' };
                    }
                    if (url.includes('/documents?')) return { status: 'ready', content: s.document, revision: s.documentRevision, profileRevision: s.revision, indexSynced: s.indexSynced !== false, indexStatus: s.indexSynced === false ? 'pending' : 'ready', usage: { used: s.document.length, limit: 8000, unit: 'characters' } };
                    if (url.endsWith('/documents') && method === 'PUT') {
                        s.document = body.content; s.documentRevision = 'd2'; s.indexSynced = true;
                        return { status: 'ready', content: s.document, revision: s.documentRevision, profileRevision: s.revision, indexSynced: true, indexStatus: 'ready', usage: { used: s.document.length, limit: 8000, unit: 'characters' } };
                    }
                    if (url.endsWith('/avatar') && method === 'POST') {
                        if (!body.dataUrl.startsWith('data:image/png;base64,')) throw new Error('Expected PNG upload');
                        if (s.avatarHold) await new Promise(resolve => { s.avatarRelease = resolve; });
                        s.avatarUploaded = true; s.profile.avatar = { kind: 'image', version: 'synthetic' }; s.revision = 'r-avatar';
                        return { ok: true, profile: s.profile, revision: s.revision };
                    }
                    if (url.includes('/knowledge?')) {
                        const kind = new URL(url, location.origin).searchParams.get('kind');
                        const status = !s.profile.enabled ? 'disabled' : kind === 'skill' && !s.profile.skills.learnedEnabled || kind === 'memory' && !s.profile.memory.enabled ? 'disabled' : s.memoryStatus || 'ready';
                        return { version: 1, status, revision: status === 'ready' ? 'a'.repeat(64) : null,
                            capabilities: { skill: status === 'ready' && s.profile.skills.learnedEnabled, memory: status === 'ready' && s.profile.memory.enabled, projectWrites: false },
                            items: status === 'ready' && kind === 'skill' ? [{ kind: 'skill', id: url.includes(p.id) ? 's1' : 's2', name: url.includes(p.id) ? 'check-sources' : 'draft-outline', description: 'Use references', scope: 'profile', state: 'active', revision: 's-revision' }] : [],
                            receipts: [], hasMore: false };
                    }
                    if (url.endsWith('/learning')) return { version: 1, status: 'ready', revision: 0, settings: { enabled: false, correctionEnabled: true, reviewEnabled: false, extractionEnabled: false, maxRunsPerDay: 4, maxTokensPerDay: 24000, periodicReviewMinutes: 0 }, jobs: [], recentRuns: [], capabilities: { installed: true } };
                    if (url.startsWith('/api/pi/assistant-projects')) return { projects: [{ id: 'g1', name: 'Notes', cwd: '/synthetic/project' }] };
                    if (url === '/api/pi/profiles' && method === 'PUT') {
                        const updated = { ...body.profile, id: body.profile.id || (s.created.length ? 'dddddddd-dddd-4ddd-dddd-dddddddddddd' : 'cccccccc-cccc-4ccc-cccc-cccccccccccc') };
                        if (body.profile.id) s.profile = updated; else s.created.push(updated);
                        s.revision = 'r2'; return { revision: s.revision, profile: updated };
                    }
                    if (url.startsWith('/api/pi/profiles') && method === 'GET') {
                        if (url === '/api/pi/profiles' && s.holdProposalVerification) await new Promise(resolve => { s.proposalVerificationRelease = resolve; });
                        if (s.holdProfileReads) await new Promise(resolve => { s.heldProfileRequests.push(resolve); });
                        return { version: 1, revision: s.revision, cwd: window.fixtureCwd || null, profileRevisions: { [s.profile.id]: s.revision }, profiles: s.emptyProfiles ? [] : [structuredClone(s.profile), structuredClone(s.second), ...structuredClone(s.created)] };
                    }
                    throw new Error(`Unexpected ${method} ${url}`);
                };
            }, { p: profile, other: second });
            await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
            await page.waitForFunction(() => Boolean(window.PiAgentProfilesUI));
            const persona = () => page.locator('[data-profile-section=persona]').click();
            const saveButton = () => page.locator('[data-page=persona] .pi-id-savebar .pi-id-btn-primary');
            const waitSaved = () => page.waitForFunction(() => document.querySelector('[data-page=persona] .pi-id-savebar')?.dataset.visible === 'false');
            if (width === 393) {
                await page.evaluate(() => PiAgentProfilesUI.open({ profileId: synthetic.profile.id, section: 'user', authoringSession: { id: 'authoring-1', cwd: '/synthetic/project' } }));
                assert.equal(await page.evaluate(() => synthetic.calls.filter(call => call.url.startsWith('/api/pi/profiles?')).length), 0);
                await page.evaluate(() => PiAgentProfilesUI.setEnabled(true, true));
                await page.locator('.pi-profile-proposal').waitFor();
                assert.equal(await page.locator('[data-profile-section=persona]').getAttribute('aria-current'), 'page');
                const reads = await page.evaluate(() => synthetic.calls.filter(call => call.url.startsWith('/api/pi/profiles?')).length);
                await page.evaluate(() => { PiAgentProfilesUI.setEnabled(true, true); PiAgentProfilesUI.setEnabled(true, true); });
                assert.equal(await page.evaluate(() => synthetic.calls.filter(call => call.url.startsWith('/api/pi/profiles?')).length), reads);
            }
            await page.evaluate(() => PiAgentProfilesUI.open({ profileId: synthetic.profile.id, section: 'soul' }));
            await page.locator('#pi-profile-form [name=description]:visible').waitFor();
            if (width === 1440) assert.equal(await page.locator('.pi-profiles-layout').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 2);
            await page.locator('#pi-profile-form [name=description]').fill('Draft kept while capability is unavailable');
            await page.evaluate(() => PiAgentProfilesUI.setEnabled(false));
            assert.equal(await saveButton().isDisabled(), true);
            assert.equal(await page.locator('[data-profile-assist]').isDisabled(), true);
            assert.equal(await page.locator('#pi-profile-form [name=description]').inputValue(), 'Draft kept while capability is unavailable');
            await page.evaluate(() => PiAgentProfilesUI.setEnabled(true, true));
            await page.waitForFunction(() => !document.querySelector('[data-page=persona] .pi-id-savebar .pi-id-btn-primary').disabled);
            assert.equal(await page.locator('#pi-profile-form [name=description]').inputValue(), 'Draft kept while capability is unavailable');
            await page.locator('#pi-profile-form [name=description]').fill('Notes');
            if (width === 1440) {
                await page.evaluate(() => { synthetic.holdProfileReads = true; PiAgentProfilesUI.open({ profileId: synthetic.profile.id, section: 'skills' }); PiAgentProfilesUI.open({ profileId: synthetic.second.id, section: 'overview' }); });
                await page.waitForFunction(() => synthetic.heldProfileRequests.length === 2);
                await page.evaluate(() => synthetic.heldProfileRequests[1]());
                await page.waitForFunction(() => document.querySelector('#pi-profile-form [name=name]')?.value === 'Writing');
                await page.evaluate(() => synthetic.heldProfileRequests[0]());
                await page.waitForTimeout(50);
                assert.equal(await page.locator('#pi-profile-form [name=name]').inputValue(), 'Writing', 'stale open must not select prior profile');
                await page.evaluate(() => { synthetic.holdProfileReads = false; PiAgentProfilesUI.open({ profileId: synthetic.profile.id, section: 'persona' }); });
                await page.waitForFunction(() => document.querySelector('#pi-profile-form [name=name]')?.value === 'Research');
            }
            await persona();
            const image = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 4; canvas.getContext('2d').fillRect(0, 0, 4, 4); return canvas.toDataURL('image/jpeg').split(',')[1]; });
            if (width === 1440) await page.evaluate(() => { synthetic.avatarHold = true; });
            await page.locator('#pi-profile-avatar-upload').setInputFiles({ name: 'avatar.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(image, 'base64') });
            if (width === 1440) {
                await page.waitForFunction(() => Boolean(synthetic.avatarRelease));
                assert.equal(await saveButton().isDisabled(), true);
                await page.evaluate(() => synthetic.avatarRelease());
            }
            await page.waitForFunction(() => synthetic.avatarUploaded === true);
            await page.waitForFunction(() => document.querySelector('#pi-profile-avatar-picker img'));
            assert.equal(await saveButton().isDisabled(), true, 'avatar saves independently');
            await page.evaluate(() => PiAgentProfilesUI.open({ profileId: synthetic.profile.id, section: 'projects' }));
            await page.locator('[data-projects-card] .pi-profile-project').waitFor();
            assert.match(await page.locator('[data-projects-card]').innerText(), /Notes/);
            await persona();
            await page.locator('[data-profile-assist]').click();
            await page.waitForFunction(() => Boolean(synthetic.navigation));
            assert.equal((await page.evaluate(() => synthetic.navigation)).draft, 'Please discuss my profile');
            assert.ok(!(await page.evaluate(() => synthetic.calls)).some(call => call.url.includes('send')));
            await page.locator('#pi-profile-form [name=description]').fill('Keep my description');
            await page.evaluate(() => PiAgentProfilesUI.open({ profileId: synthetic.profile.id, authoringSession: { id: 'authoring-1', cwd: '/synthetic/project' } }));
            await page.locator('.pi-profile-proposal .pi-id-btn-quiet').click();
            await page.waitForFunction(() => document.querySelector('#pi-profile-form [name=name]')?.value === 'Proposed name');
            assert.equal(await page.locator('#pi-profile-form [name=description]').inputValue(), 'Keep my description');
            await page.waitForFunction(() => !document.querySelector('[data-page=persona] .pi-id-savebar .pi-id-btn-primary').disabled);
            // A persistent warning toast may cover the bottom card on phones; open it from the keyboard.
            await page.locator('.pi-profile-advanced summary').press('Enter');
            await page.locator('#pi-profile-form [name=memoryCharLimit]').fill('8192');
            await saveButton().click();
            await page.waitForFunction(() => synthetic.profile.name === 'Proposed name');
            assert.equal(await page.evaluate(() => synthetic.profile.memory.memoryCharLimit), 8192);
            await waitSaved();
            // Document drafts imported by the proposal remain module-owned and participate in the shell guard.
            await page.locator('#pi-profile-editor-close').click();
            await page.locator('.pi-profile-confirm[open]').waitFor(); await page.keyboard.press('Escape');
            assert.equal(await page.locator('#pi-profile-form [name=name]').inputValue(), 'Proposed name');
            await page.locator('#pi-profile-editor-close').click();
            await page.locator('.pi-profile-confirm .settings-primary-button').click();
            await page.locator('#pi-profile-form').waitFor({ state: 'detached' });
            // A proposal with a revision reserves the shell while its verification read is pending.
            await page.evaluate(() => PiAgentProfilesUI.open({ profileId: synthetic.profile.id, section: 'persona', authoringSession: { id: 'authoring-1', cwd: '/synthetic/project' } }));
            await page.locator('.pi-profile-proposal').waitFor();
            await page.evaluate(() => { synthetic.holdProposalVerification = true; });
            const documentPutsBeforeImport = await page.evaluate(() => synthetic.calls.filter(call => call.method === 'PUT' && call.url.endsWith('/documents')).length);
            await page.locator('.pi-profile-proposal .pi-id-btn-quiet').click();
            await page.waitForFunction(() => Boolean(synthetic.proposalVerificationRelease));
            assert.equal(await page.locator('#pi-profile-form [name=description]').isDisabled(), true, 'proposal verification disables persona edits');
            assert.equal(await saveButton().isDisabled(), true);
            await page.locator('[data-profile-section=memory]').click();
            assert.equal(await page.locator('#pi-profiles-content').getAttribute('data-section'), 'persona', 'pending proposal verification keeps the persona section');
            assert.equal(await page.locator('[data-profile-section=persona]').getAttribute('aria-current'), 'page');
            await page.locator('.pi-id-toasts').getByText(await page.evaluate(() => PiI18n.t('正在保存，请等待服务器确认后再离开。')), { exact: true }).waitFor();
            assert.equal(await page.locator('#pi-profiles-memory .pi-id-editor-text:visible').count(), 0, 'navigation cannot expose a document save during verification');
            assert.equal(await page.evaluate(() => synthetic.calls.filter(call => call.method === 'PUT' && call.url.endsWith('/documents')).length), documentPutsBeforeImport);
            await page.evaluate(() => { synthetic.holdProposalVerification = false; synthetic.proposalVerificationRelease(); });
            await page.locator('.pi-profile-proposal').waitFor({ state: 'detached' });
            await page.waitForFunction(() => !document.querySelector('#pi-profile-form [name=description]').disabled);
            await page.locator('[data-profile-section=memory]').click();
            await page.locator('.pi-knowledge-target-row [data-value=user]').click();
            const importedDocument = page.locator('#pi-profiles-memory .pi-id-editor-text');
            await importedDocument.waitFor();
            assert.equal(await importedDocument.inputValue(), 'Proposed USER', 'shell hands the imported USER draft to the full-text editor');
            assert.equal(await page.locator('.pi-knowledge-target-row [data-value=user]').getAttribute('aria-pressed'), 'true');
            const documentSave = page.locator('#pi-profiles-memory .pi-id-savebar .pi-id-btn-primary');
            assert.equal(await page.locator('#pi-profiles-memory .pi-id-savebar').getAttribute('data-visible'), 'true', 'import remains an unsaved document draft');
            assert.equal(await documentSave.isEnabled(), true);
            assert.equal(await page.evaluate(() => synthetic.document), 'Original USER', 'import does not save the document automatically');
            await documentSave.click();
            await page.waitForFunction(() => document.querySelector('#pi-profiles-memory .pi-id-savebar')?.dataset.visible === 'false');
            const importedPuts = await page.evaluate(() => synthetic.calls.filter(call => call.method === 'PUT' && call.url.endsWith('/documents')));
            assert.equal(importedPuts.length, documentPutsBeforeImport + 1);
            assert.equal(importedPuts.at(-1).body.target, 'user');
            assert.equal(importedPuts.at(-1).body.content, 'Proposed USER', 'document PUT contains the imported USER text');
            assert.equal(await page.evaluate(() => synthetic.document), 'Proposed USER');
            await page.locator('#pi-profile-editor-close').click();
            await page.locator('#pi-profile-form').waitFor({ state: 'detached' });
            await page.locator('#pi-profile-add').click();
            await page.locator('#pi-profile-form [name=name]').fill('New assistant');
            await saveButton().click();
            await page.waitForFunction(() => synthetic.created.length === 1); await waitSaved();
            await page.locator('#pi-profile-editor-close').click();
            await page.evaluate(() => { fixtureCwd = ''; PiAgentProfilesUI.projectChanged(); });
            await page.waitForFunction(() => synthetic.calls.some(call => call.url === '/api/pi/profiles' && call.method === 'GET'));
            await page.evaluate(() => PiExtensions.setView('extensions', 'extensions'));
            assert.equal(await page.locator('#extensions-nav').isVisible(), true);
            assert.equal(await page.locator('#extensions-nav [data-extensions-tab="extensions"]').getAttribute('aria-current'), 'page');
            await page.locator('.extensions-card').first().waitFor();
            assert.equal(await page.locator('#extensions-learned').count(), 0);
            const overflow = await page.evaluate(() => [...document.querySelectorAll('body,#pi-profiles-content,.pi-profiles-layout,.pi-profile-detail,#extensions-featured')].filter(el => el.clientWidth && el.scrollWidth > el.clientWidth + 2).map(el => `${el.tagName}.${el.className}:${el.scrollWidth}/${el.clientWidth}`));
            assert.deepEqual(overflow, []);
            assert.deepEqual(errors, []);
            assert.deepEqual(nativeDialogs, []);
            fs.mkdirSync(evidence, { recursive: true });
            await page.screenshot({ path: path.join(evidence, `pages-${width}.png`), fullPage: true });
            await context.close();
        }
        console.log(`Assistant pages: capability recovery, stale navigation, avatar conversion, authoring, proposal import, draft guard, creation and extensions entry passed at 1440/393/320; screenshots: ${evidence}/pages-{1440,393,320}.png`);
    } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
