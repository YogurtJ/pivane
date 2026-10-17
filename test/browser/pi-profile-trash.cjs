// Synthetic assistant selection regression; no native identity, live service or provider is used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const cwd = '/fixture/trash-selection';
const profiles = [
    { id: '11111111-1111-4111-8111-111111111111', name: 'Research', enabled: true },
    { id: '22222222-2222-4222-8222-222222222222', name: 'Editor', enabled: true }
];
const groups = profiles.map((profile, index) => ({ id: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${index}`, name: profile.name,
    cwd, description: '', instructions: '', profileIds: [profile.id], archived: false }));
const evidence = process.env.PIVANE_TEST_SCREENSHOT_DIR || os.tmpdir();

async function main() {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
    await fs.mkdir(evidence, { recursive: true });
    try {
        for (const width of [1440, 393, 320]) {
            const context = await browser.newContext({ viewport: { width, height: 900 }, locale: width === 1440 ? 'en-US' : 'zh-CN' });
            const page = await context.newPage(), errors = [], writes = [];
            page.on('pageerror', error => errors.push(error.message));
            let visibleProfiles = profiles;
            await page.addInitScript(() => { if (!sessionStorage.getItem('fixture-started')) { localStorage.clear(); sessionStorage.setItem('fixture-started', '1'); } });
            await page.route('**/pi-agent-profiles.js', route => route.fulfill({ contentType: 'text/javascript', body:
                'window.PiAgentProfiles={create:()=>({setEnabled(){},open(){},close(){},displaySession(){},setLoadedProfile(){},projectChanged(){}})};' }));
            await page.route('**/api/**', async route => {
                const request = route.request(), url = new URL(request.url()), pathname = url.pathname;
                if (request.method() !== 'GET') {
                    const body = request.postDataJSON(); writes.push({ pathname, body });
                    if (pathname === '/api/pi/sessions') return route.fulfill({ json: { id: 'synthetic-created', cwd, name: 'Created',
                        agentProfile: profiles.find(profile => profile.id === body.profileId), assistantProject: groups.find(group => group.id === body.assistantProjectId) } });
                    return route.fulfill({ json: { ok: true } });
                }
                if (pathname === '/api/pi/status') return route.fulfill({ json: { ok: true, agentProfiles: true, assistantProjects: true, projectRoots: ['/fixture'], defaultProject: cwd } });
                if (pathname === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd, name: 'Synthetic project', sessionCount: 0 }], roots: ['/fixture'] } });
                if (pathname === '/api/pi/profiles') return route.fulfill({ json: { version: 1, revision: 'profiles-fixture', profiles: visibleProfiles, trash: profiles.filter(profile => !visibleProfiles.includes(profile)).map(profile => ({ ...profile, trashedAt: '2026-10-17T00:00:00.000Z' })) } });
                if (pathname === '/api/pi/assistant-projects') return route.fulfill({ json: { version: 1, revision: 'projects-fixture', projects: groups.filter(group => group.profileIds.includes(url.searchParams.get('profileId'))) } });
                if (pathname === '/api/pi/sessions' || /^\/api\/pi\/assistant-projects\/[^/]+\/sessions$/.test(pathname)) return route.fulfill({ json: { sessions: [] } });
                if (pathname === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] } });
                return route.fulfill({ json: {} });
            });
            const model = { provider: 'synthetic', id: 'fixture', name: 'Fixture', input: ['text'] };
            await page.routeWebSocket('**/api/pi/ws', ws => ws.onMessage(raw => {
                const command = JSON.parse(raw);
                const data = command.type === 'open_session' ? { session: { id: 'synthetic-created', cwd, agentProfile: profiles[1], assistantProject: groups[1] },
                    state: { model, isStreaming: false, thinkingLevel: 'off' }, messages: { messages: [] }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } } : {};
                ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
            }));
            const base = process.env.PI_PROFILE_TRASH_URL;
            assert.ok(base, 'Run this synthetic fixture through npm run test:browser');
            await page.goto(`${base}/#/assistant?profileId=${profiles[0].id}`, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(id => document.querySelector('#pi-assistant-profile')?.value === id && document.querySelectorAll('[data-assistant-project-id]').length === 1, profiles[0].id);
            visibleProfiles = [profiles[1]];
            await page.evaluate(() => window.dispatchEvent(new CustomEvent('workspace:agent-profiles-changed')));
            await page.waitForFunction(() => document.querySelector('#pi-assistant-profile')?.value === '' && document.querySelector('#pi-new-session').disabled && !document.querySelector('[data-assistant-project-id]'));
            assert.equal(await page.locator('#pi-assistant-profile').isEnabled(), true, 'remaining identities require explicit selection');
            assert.match(await page.locator('#pi-assistant-profile-status').textContent(), /不会自动改用|no other profile/);
            assert.equal(await page.evaluate(() => localStorage.getItem('pi.web.assistantProfile')), profiles[0].id, 'missing selection is retained');
            await page.evaluate(() => document.querySelector('#pi-new-session').click());
            assert.deepEqual(writes, [], 'missing identity cannot create a thread under another identity');
            // Repeated refresh must not lose the missing selection and choose the first available identity.
            await page.evaluate(() => window.dispatchEvent(new CustomEvent('workspace:agent-profiles-changed')));
            await page.waitForFunction(() => document.querySelector('#pi-assistant-profile')?.value === '' && document.querySelector('#pi-new-session').disabled);
            if (width < 700) {
                await page.locator('#pi-toggle-sessions').click();
                await page.waitForFunction(() => {
                    const pane = document.querySelector('#pi-session-pane');
                    return pane.classList.contains('open') && pane.getBoundingClientRect().left >= -1;
                });
            }
            const dimensions = await page.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth,
                select: parseFloat(getComputedStyle(document.querySelector('#pi-assistant-profile')).fontSize) }));
            assert.ok(dimensions.body <= width + 1, JSON.stringify(dimensions));
            if (width < 700) assert.ok(dimensions.select >= 16, JSON.stringify(dimensions));
            await page.screenshot({ path: path.join(evidence, `trash-selection-${width}.png`) });
            if (width === 1440) {
                await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
                await page.screenshot({ path: path.join(evidence, 'trash-selection-1440-dark.png') });
            }
            await page.locator('#pi-assistant-profile').selectOption(profiles[1].id);
            await page.waitForFunction(id => document.querySelector('#pi-assistant-profile')?.value === id && document.querySelectorAll('[data-assistant-project-id]').length === 1, profiles[1].id);
            assert.equal(await page.locator('#pi-new-session').isEnabled(), true, 'explicit selection restores creation');
            await page.locator('#pi-new-session').click();
            await page.waitForFunction(() => document.querySelector('#pi-meta-id')?.textContent === 'synthetic-created');
            assert.deepEqual(writes, [{ pathname: '/api/pi/sessions', body: { cwd, profileId: profiles[1].id, assistantProjectId: groups[1].id } }]);
            if (width === 1440) {
                // A choice remembered from an earlier visit (not requested, not on screen) falls back to an available identity.
                await page.evaluate(id => localStorage.setItem('pi.web.assistantProfile', id), profiles[0].id);
                visibleProfiles = [profiles[1]];
                await page.goto(`${base}/#/assistant`, { waitUntil: 'domcontentloaded' });
                await page.reload({ waitUntil: 'domcontentloaded' });
                await page.waitForFunction(id => document.querySelector('#pi-assistant-profile')?.value === id && !document.querySelector('#pi-new-session').disabled, profiles[1].id);
            }
            assert.deepEqual(errors, [], `${width}: ${errors.join(' | ')}`);
            await context.close();
        }
        console.log('Trash selection: 1440/393/320, en/zh, light/dark, explicit selection and thread creation passed');
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
