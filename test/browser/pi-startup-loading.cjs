// Synthetic loading contract: real page assets, isolated HTTP/WS fixtures, no providers or writes.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PI_STARTUP_URL || 'http://127.0.0.1:5199';
const cwd = '/synthetic/startup';
const profile = { id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'Fixture identity', enabled: true, soul: '', memory: {}, skills: {} };
const session = { id: 'startup-thread', cwd, name: 'Synthetic thread', messageCount: 1, agentProfile: profile };
const model = { id: 'fixture', provider: 'fixture', name: 'Fixture', input: ['text'] };
const deferredScripts = ['pi-channels.js', 'settings.js', 'pi-agent-profiles.js', 'pi-native-settings.js', 'pi-system-prompts.js', 'pi-profile-knowledge.js', 'pi-profile-learning.js', 'media-connections.js', 'pi-transcription-settings.js', 'media-lab.js', 'pi-cron.js', 'pi-artifacts.js', 'pi-artifacts-preview.js'];
async function fixture(browser, width, hash = '#/chat', options = {}) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: width < 700 ? 'zh-CN' : 'en-US', isMobile: width < 700, hasTouch: width < 700 });
    const page = await context.newPage(), errors = [], requests = [], writes = [], commands = [];
    if (options.clock) await page.clock.install();
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(new URL(request.url()).pathname));
    await page.addInitScript(({ cwd }) => {
        localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'startup-thread');
        localStorage.setItem('pi.workspace.theme', 'dark');
    }, { cwd });
    await page.route('https://fonts.googleapis.com/**', route => route.abort());
    await page.route('**/api/**', route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        if (request.method() !== 'GET') writes.push({ path, method: request.method() });
        if (options.updates && path.startsWith('/api/pi/settings/updates')) {
            const updates = options.updates, body = request.postDataJSON();
            updates.calls.push({ path, method: request.method(), body });
            if (path.endsWith('/automatic')) updates.state = { ...updates.state, available: true, eligible: true, version: '1.2.1', nextCheckAt: Date.now() + 86400000 };
            if (body?.action === 'claim') {
                const claimed = updates.state.idle && updates.state.eligible;
                if (claimed) updates.state.eligible = false;
                return route.fulfill({ json: { ...updates.state, claimed } });
            }
            if (path === '/api/pi/settings/updates') return route.fulfill({ json: { appVersion: '1.8.0', piVersion: '1.2.0', dependencyMatches: true, checkedAt: '2026-01-01', pi: { status: 'current' }, pivane: { status: 'current' } } });
            return route.fulfill({ json: updates.state });
        }
        if (options.oauth && path === '/api/pi/settings/providers/fixture/login') return route.fulfill({ json: { id: 'fixture-login', revision: 1, finished: false, status: 'waiting', events: [], prompts: [] } });
        if (options.oauth && path === '/api/pi/settings/login/fixture-login') return route.fulfill({ json: { id: 'fixture-login', revision: 1, finished: false, status: 'waiting', events: [], prompts: [] } });
        const data = path === '/api/pi/status' ? { ok: true, agentProfiles: true, assistantProjects: true, scheduledTasks: true, messageChannels: true, projectIdentity: true, defaultProject: cwd, projectRoots: ['/synthetic'] }
            : path === '/api/pi/projects/resolve' ? { cwd }
            : path === '/api/pi/projects' ? { projects: [{ cwd, name: 'Synthetic', sessionCount: 1 }], roots: ['/synthetic'] }
            : path === '/api/pi/sessions' ? { sessions: [session] }
            : path === '/api/pi/profiles' ? { version: 1, revision: 'profiles-1', cwd, profiles: [profile] }
            : path === '/api/pi/assistant-projects' ? { version: 1, revision: 'projects-1', projects: [] }
            : path === '/api/pi/activity' ? { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] }
            : path === '/api/pi/settings/models' ? { models: options.oauth ? [model] : [], providers: options.oauth ? [{ id: 'fixture', name: 'Fixture', configured: true, authMethods: { oauth: true } }] : [], customProviders: [], providerLogin: options.oauth === true, preferences: {}, prompts: [] }
            : path === '/api/pi/channels' ? { revision: 'channels-1', component: { installed: false }, accounts: [], bindings: [], peers: [], jobs: [], login: null }
            : path === '/api/pi/cron' ? { jobs: [], today: { runs: 0 }, limits: { maxRunsPerDay: 10 }, mainThreads: [] }
            : path === '/api/pi/media/lab' ? { models: [], mediaConnections: true }
            : path === '/api/pi/media/lab/connections' ? { revision: 'connections-1', providers: [], models: [], transcriptionModels: [] }
            : path === '/api/pi/composer/transcription/settings' ? { revision: 'asr-1', availableModels: [], transcriptionModels: [], providers: [] }
            : path.includes('/history') || path === '/api/prompts' ? [] : {};
        return route.fulfill({ json: data });
    });
    let sockets = 0;
    await page.routeWebSocket('**/api/pi/ws', ws => {
        sockets++;
        ws.onMessage(raw => {
            const command = JSON.parse(raw); commands.push(command.type);
            const state = { model, thinkingLevel: 'off', isStreaming: false };
            const data = command.type === 'open_session' ? { session, state, messages: { messages: [{ role: 'user', content: [{ type: 'text', text: 'Fixture' }] }] }, stats: {}, models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } }
                : command.type === 'get_state' ? state : {};
            ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
        });
    });
    const go = async () => { await page.goto((options.base || base) + '/' + hash, { waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => window.PiChatNavigation && window.PiWorkspaceRoute); };
    return { page, context, go, errors, requests, writes, commands, socketCount: () => sockets };
}
async function clean(f, label) {
    assert.deepEqual(f.errors, [], label + ': pageerrors');
    assert.deepEqual(f.writes, [], label + ': no writes during navigation or loading');
    assert.equal(f.commands.includes('prompt'), false, label + ': no prompt');
    assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, label + ': viewport width');
    assert.equal(await f.page.locator('html').getAttribute('data-theme'), 'dark');
    await f.context.close();
}
async function main() {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
    const results = [];
    try {
        for (const width of [1440, 393]) {
            for (const mode of ['chat', 'assistant']) {
                const f = await fixture(browser, width, `#/${mode}`), { page } = f;
                await f.go();
                await page.waitForFunction(mode => mode === 'assistant' ? document.querySelector('#pi-assistant-profile')?.options.length > 0 : document.querySelector('#pi-input')?.disabled === false, mode);
                assert.deepEqual(f.requests.filter(url => deferredScripts.some(file => url.endsWith('/' + file))), [], 'initial chat requests no page scripts');
                if (mode === 'chat') {
                    assert.equal(await page.locator('#pi-meta-profile').textContent().then(text => text.includes('Fixture identity')), true, 'identity details work before profile editor loads');
                    await page.locator('#pi-input').fill('Unsent draft');
                    await page.locator('#pi-file-input').setInputFiles({ name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('Fixture') });
                    await page.waitForFunction(() => document.querySelectorAll('#pi-attachments .pi-attachment-chip').length === 1);
                    await page.evaluate(() => PiWorkspaceRoute.navigate('settings', { tab: 'providers' }));
                    await page.locator('[data-settings-panel="providers"]').waitFor({ state: 'visible' });
                    await page.locator('#workspace-settings-close').click();
                    await page.locator('#pi-current-thread-menu').click();
                    await page.getByRole('menuitem', { name: /连接微信|Connect to WeChat/ }).click();
                    await page.locator('[data-settings-panel="channels"]').waitFor({ state: 'visible' });
                    await page.waitForFunction(() => document.querySelector('[data-settings-panel="channels"] select[aria-label="线程"], [data-settings-panel="channels"] select[aria-label="Thread"]')?.value === 'startup-thread');
                    if (process.env.PIVANE_TEST_SCREENSHOT_DIR) {
                        require('node:fs').mkdirSync(process.env.PIVANE_TEST_SCREENSHOT_DIR, { recursive: true });
                        await page.screenshot({ path: require('node:path').join(process.env.PIVANE_TEST_SCREENSHOT_DIR, `channel-shell-${width}.png`), fullPage: true });
                    }
                    await page.locator('#workspace-settings-close').click();
                    assert.equal(await page.locator('#pi-input').inputValue(), 'Unsent draft');
                    assert.equal(await page.locator('#pi-attachments .pi-attachment-chip').count(), 1);
                    assert.equal(f.socketCount(), 1, 'management navigation does not reconnect chat');
                    assert.equal(f.commands.filter(type => type === 'open_session').length, 1);
                    assert.equal(await page.locator('#pi-send-button').isVisible(), true);
                    assert.equal(await page.locator('#pi-stop-button').isVisible(), false);
                    if (width < 700) {
                        await page.locator('#pi-toggle-sessions').click();
                        await page.waitForFunction(() => document.querySelector('#pi-session-pane').classList.contains('open'));
                        assert.equal(await page.locator('#pi-session-pane').isVisible(), true);
                        await page.locator('#pi-toggle-sessions').click();
                    }
                }
                results.push({ width, mode, deferredOnStartup: true }); await clean(f, mode);
            }
            for (const [hash, group, selector] of [
                ['#/profiles', 'settings', '#pi-profiles-content'], ['#/extensions?tab=channels', 'settings', '[data-settings-panel="channels"]'], ['#/extensions?tab=mcp', 'settings', '[data-settings-panel="mcp"]'],
                ['#/settings?tab=models', 'settings', '[data-settings-panel="models"]'], ['#/cron', 'cron', '#cron-tab .cron-header'],
                ['#/media', 'media', '#media-tab .lab-header'], ['#/artifacts', 'artifacts', '#artifacts-tab .artifacts-header'],
                ['#/settings?tab=skills', 'settings', '[data-settings-panel="installed"]']
            ]) {
                const f = await fixture(browser, width, hash), { page } = f;
                await f.go();
                await page.waitForFunction(group => PiFeatures.ready(group), group);
                await page.locator(selector).waitFor({ state: 'visible' });
                const styles = await page.evaluate(() => [...document.querySelectorAll('link[rel="stylesheet"]')].filter(link => !link.href.startsWith('https:')).every(link => link.sheet));
                assert.equal(styles, true, hash + ': styles applied before visibility');
                assert.equal(await page.locator('#workspace-feature-state').isVisible(), false);
                if (hash === '#/media') assert.equal(await page.locator('#lab-open-artifacts').count(), 1, 'media link works before visiting artifacts');
                if (hash.includes('skills')) assert.match(page.url(), /#\/extensions\?tab=installed&type=skills$/);
                if (group === 'settings') {
                    await page.evaluate(() => PiWorkspaceRoute.navigate('chat'));
                    await page.goBack(); await page.locator(selector).waitFor({ state: 'visible' });
                    await page.goForward(); await page.locator('#chat-tab').waitFor({ state: 'visible' });
                    await page.goBack(); await page.locator(selector).waitFor({ state: 'visible' });
                    assert.equal(f.requests.filter(url => url.endsWith('/settings.js')).length, 1, 'one management bootstrap');
                }
                results.push({ width, hash, group }); await clean(f, hash);
            }
        }
        // Finishing the initial feature load must not cancel an in-flight chat restore.
        const restore = await fixture(browser, 393, '#/artifacts'); let releaseSessions, requestedSessions;
        const sessionsRequested = new Promise(resolve => { requestedSessions = resolve; });
        await restore.page.route('**/api/pi/sessions?**', async route => { requestedSessions(); await new Promise(resolve => { releaseSessions = resolve; }); await route.fallback(); });
        await restore.go(); await sessionsRequested;
        await restore.page.waitForFunction(() => PiFeatures.ready('artifacts'));
        releaseSessions(); await restore.page.waitForFunction(() => document.querySelector('#pi-input')?.disabled === false);
        assert.equal(restore.commands.filter(type => type === 'open_session').length, 1, 'one restored session across lazy-ready event');
        await clean(restore, 'feature ready during session restore');
        // A stylesheet failure keeps the page hidden and retry uses the same fixed URL.
        const failed = await fixture(browser, 393, '#/artifacts'); let failures = 0;
        await failed.page.route('**/pi-artifacts.css', route => ++failures === 1 ? route.abort() : route.continue());
        await failed.go();
        await failed.page.locator('#workspace-feature-state button').waitFor({ state: 'visible' });
        assert.equal(await failed.page.locator('#artifacts-tab').isVisible(), false);
        await failed.page.locator('#workspace-feature-state button').click();
        await failed.page.locator('#artifacts-tab .artifacts-header').waitFor({ state: 'visible' });
        assert.equal(failures, 2); await clean(failed, 'style failure retry');
        // Script failure retries without executing already loaded dependencies a second time.
        const scriptFailure = await fixture(browser, 1440, '#/profiles'); let scriptFailures = 0;
        await scriptFailure.page.route('**/pi-agent-profiles.js', route => ++scriptFailures === 1 ? route.abort() : route.continue());
        await scriptFailure.go(); await scriptFailure.page.locator('#workspace-feature-state button').waitFor({ state: 'visible' });
        await scriptFailure.page.locator('#workspace-feature-state button').click();
        await scriptFailure.page.locator('#pi-profiles-content').waitFor({ state: 'visible' });
        assert.equal(scriptFailures, 2); assert.equal(scriptFailure.requests.filter(url => url.endsWith('/pi-native-settings.js')).length, 1);
        await clean(scriptFailure, 'script failure retry');
        const race = await fixture(browser, 1440); let release, started;
        const held = new Promise(resolve => { started = resolve; });
        await race.page.route('**/pi-artifacts.css', async route => { started(); await new Promise(resolve => { release = resolve; }); await route.continue(); });
        await race.go(); await race.page.waitForFunction(() => document.querySelector('#pi-input')?.disabled === false);
        await race.page.evaluate(() => { PiWorkspaceRoute.navigate('artifacts'); const a = PiFeatures.ensure('artifacts'); window.sharedLoading = a === PiFeatures.ensure('artifacts'); PiWorkspaceRoute.navigate('media'); PiWorkspaceRoute.navigate('chat'); });
        await held; assert.equal(await race.page.evaluate(() => sharedLoading), true); release();
        await race.page.waitForFunction(() => PiFeatures.ready('artifacts') && PiFeatures.ready('media'));
        assert.match(race.page.url(), /#\/chat$/); assert.equal(await race.page.locator('#chat-tab').isVisible(), true);
        assert.equal(race.requests.filter(url => url.endsWith('/pi-artifacts.js')).length, 1);
        assert.equal(await race.page.locator('#artifacts-tab .artifacts-header').count(), 1);
        assert.equal(race.requests.filter(url => url.startsWith('/api/pi/artifacts')).length, 0, 'late initialization does not activate artifacts');
        assert.equal(await race.page.evaluate(() => PiFeatures.ensure('https://example.invalid/evil.js').then(() => false, () => true)), true);
        await race.page.evaluate(() => PiMediaConnections.open({ kind: 'tts', section: 'asr', origin: 'settings' }));
        await race.page.locator('#lab-connections-dialog').waitFor({ state: 'visible' });
        await race.page.locator('#settings-transcription-model').waitFor({ state: 'visible' });
        await race.page.locator('#mc-close').click();
        await race.page.evaluate(() => PiMediaConnections.open({ kind: 'image' }));
        await race.page.locator('#lab-connections-dialog').waitFor({ state: 'visible' });
        assert.equal(race.requests.filter(url => url.endsWith('/media-connections.js')).length, 1);
        assert.equal(await race.page.locator('#lab-connections-dialog').count(), 1);
        await clean(race, 'rapid navigation and speech');
        const lateDialog = await fixture(browser, 393); let releaseDialog, requestedDialog;
        const heldDialog = new Promise(resolve => { requestedDialog = resolve; });
        await lateDialog.page.route('**/media-connections.css', async route => { requestedDialog(); await new Promise(resolve => { releaseDialog = resolve; }); await route.continue(); });
        await lateDialog.go();
        await lateDialog.page.evaluate(() => { PiMediaConnections.open({ kind: 'image' }); PiWorkspaceRoute.navigate('media'); PiWorkspaceRoute.navigate('chat'); });
        await heldDialog; releaseDialog();
        await lateDialog.page.waitForFunction(() => PiFeatures.ready('connections'));
        assert.equal(await lateDialog.page.locator('#lab-connections-dialog').isVisible(), false, 'late dialog load cannot reopen after leaving and returning');
        await clean(lateDialog, 'late dialog');
        console.log(JSON.stringify({ results, failures: ['style retry', 'script retry'], race: 'shared promise, no late activation or dialog', writes: 0 }));
    } finally { await browser.close(); }
}
module.exports = { fixture, clean };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
