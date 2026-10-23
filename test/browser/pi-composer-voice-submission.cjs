// Exercise actual pi-chat submission boundaries with synthetic REST/WS and ASR.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PI_VOICE_SUBMISSION_TEST_URL, cwd = '/synthetic/voice';
const sessions = ['one', 'two'].map(id => ({ cwd, id, name: id }));
const model = { provider: 'fixture', id: 'fixture', input: ['text', 'image'] };
async function run(browser, width) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'zh-CN', isMobile: width < 900, hasTouch: width < 900, permissions: ['microphone'] });
    const page = await context.newPage(), errors = [], commands = [], writes = [];
    const existingJob = { id: 'existing', revision: 1, status: 'scheduled', dueAt: Date.now() + 600000, payload: { message: 'existing job', images: [] } };
    let transcription, transcriptionReady, scheduled, socket, sendError, holdSend = false, pendingSend, uploads = 0;
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.addInitScript(({ cwd }) => {
        localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'one');
        const NativeAudioContext = window.AudioContext;
        if (NativeAudioContext && 'setSinkId' in NativeAudioContext.prototype) {
            window.AudioContext = class extends NativeAudioContext { constructor(options = {}) { super({ ...options, sinkId: { type: 'none' } }); } };
        }
        // Capture the real controllers without adding production test exports.
        for (const [name, key] of [['PiComposerVoice', 'voiceFixture'], ['PiSessionWorkflows', 'workflowFixture']]) {
            Object.defineProperty(window, name, { configurable: true, set(Class) {
                Object.defineProperty(window, name, { value: class extends Class { constructor(...args) { super(...args); window[key] = this; } } });
            } });
        }
    }, { cwd });
    await page.route('**/api/**', route => {
        const request = route.request(), endpoint = new URL(request.url()).pathname;
        if (endpoint === '/api/pi/composer/transcription') {
            if (request.method() === 'GET') return route.fulfill({ json: { revision: 'synthetic', models: [{ id: 'synthetic' }] } });
            uploads++; transcription = route; transcriptionReady?.(); return;
        }
        if (request.method() === 'POST' && endpoint.endsWith('/deferred')) { writes.push(request.postDataJSON()); scheduled = route; return; }
        if (endpoint.endsWith('/workflow')) return route.fulfill({ json: { prompts: [], replies: [], versions: [] } });
        if (endpoint.endsWith('/deferred')) return route.fulfill({ json: { jobs: [existingJob] } });
        if (endpoint === '/api/pi/status') return route.fulfill({ json: { ok: true, projectRoots: ['/synthetic'], transcription: true, sessionWorkflows: true, runtimeControls: true, userShell: true } });
        if (endpoint === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd, sessionCount: 2 }], roots: ['/synthetic'] } });
        if (endpoint === '/api/pi/sessions') return route.fulfill({ json: { sessions } });
        if (endpoint === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] } });
        return route.fulfill({ json: {} });
    });
    const reply = (ws, cmd, data = {}, error) => ws.send(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: !error, data, error }));
    await page.routeWebSocket('**/api/pi/ws', ws => {
        ws.onMessage(raw => {
            const cmd = JSON.parse(raw); commands.push(cmd);
            if (cmd.type === 'open_session') {
                socket = ws;
                return reply(ws, cmd, { session: sessions.find(s => s.id === cmd.sessionId), state: { model, thinkingLevel: 'off', isStreaming: false },
                    messages: { messages: [{ role: 'assistant', timestamp: 1, content: [{ type: 'toolCall', id: 'tool-fixture', name: 'read', arguments: { path: '/synthetic/file' } }] },
                        { role: 'toolResult', toolCallId: 'tool-fixture', toolName: 'read', content: [{ type: 'text', text: 'Synthetic tool result' }], timestamp: 2 }] },
                    controls: { runtimeId: cmd.sessionId, revision: 1, stopping: false, queue: { steering: [], followUp: [] }, recoveries: [], extension: { title: '', statuses: [], widgets: [] } },
                    models: { models: [model] }, thinkingLevels: { levels: ['off'] }, commands: { commands: [{ name: 'compact', source: 'web' }] } });
            }
            if (['prompt', 'steer', 'follow_up', 'bash', 'compact'].includes(cmd.type)) {
                if (holdSend) { pendingSend = { ws, cmd }; return; }
                const error = sendError; sendError = null; return reply(ws, cmd, {}, error);
            }
            if (cmd.type === 'get_state') return reply(ws, cmd, { model, thinkingLevel: 'off' });
            if (cmd.type === 'get_messages') return reply(ws, cmd, { messages: [] });
            return reply(ws, cmd);
        });
    });
    const version = () => page.evaluate(() => voiceFixture.host.context().submissionVersion);
    const ready = async id => {
        try { await page.waitForFunction(id => document.querySelector('#pi-meta-id').textContent === id && !document.querySelector('#pi-input').disabled, id); }
        catch (error) { console.error(JSON.stringify({ errors, commands, view: await page.locator('#chat-tab').innerText() })); throw error; }
    };
    const start = async () => {
        transcription = null;
        const uploaded = new Promise(resolve => { transcriptionReady = resolve; });
        await page.evaluate(() => { window.voiceDone = voiceFixture.submit(new Blob(['synthetic WAV'], { type: 'audio/wav' }), voiceFixture.host.context(), 'synthetic', 'synthetic'); });
        await uploaded;
    };
    const finish = async text => { assert.ok(transcription); await transcription.fulfill({ json: { text } }); await page.evaluate(() => voiceDone); };
    const manual = async (draft, text) => {
        assert.equal(await page.locator('#pi-input').inputValue(), draft);
        assert.equal(await page.locator('#pi-voice-result').inputValue(), text);
        assert.equal(await page.locator('#pi-voice-result').isVisible(), true);
        await page.locator('#pi-voice-bar').getByRole('button', { name: '加入当前草稿', exact: true }).click();
        assert.equal(await page.locator('#pi-input').inputValue(), draft + (draft ? '\n\n' : '') + text);
        assert.equal(await page.locator('#pi-voice-bar').isVisible(), false);
    };
    await page.goto(base, { waitUntil: 'domcontentloaded' }); await ready('one');
    assert.equal(await page.locator('[data-tool-id="tool-fixture"] .pi-tool-status').textContent(), '完成');
    // Stop a recording from Chromium's synthetic microphone and retain typed text.
    await page.waitForFunction(() => !document.querySelector('#pi-transcribe-button').disabled);
    await page.locator('#pi-input').fill('recording draft'); await page.locator('#pi-transcribe-button').click();
    await page.waitForFunction(() => document.querySelector('#pi-transcribe-button').dataset.recording === 'true' && document.querySelector('#pi-voice-bar').textContent.includes('1 秒'));
    await page.locator('#pi-input').fill('typed during recording');
    const recorded = new Promise(resolve => { transcriptionReady = resolve; }); await page.locator('#pi-transcribe-button').click(); await recorded;
    const wav = transcription.request().postDataJSON(); assert.equal(wav.audio.format, 'wav');
    assert.equal(Buffer.from(wav.audio.data, 'base64').toString('ascii', 0, 4), 'RIFF');
    await transcription.fulfill({ json: { text: 'recorded speech' } });
    await page.waitForFunction(() => document.querySelector('#pi-input').value === 'typed during recording\n\nrecorded speech');
    const beforeCancel = uploads; await page.locator('#pi-transcribe-button').click();
    await page.waitForFunction(() => document.querySelector('#pi-transcribe-button').dataset.recording === 'true');
    await page.locator('#pi-voice-bar').getByRole('button', { name: '取消录音', exact: true }).click(); assert.equal(uploads, beforeCancel);
    await page.locator('#pi-input').fill('typing'); const initial = await version(); await start();
    await page.locator('#pi-input').fill('continued typing'); await finish('speech');
    assert.equal(await version(), initial); assert.equal(await page.locator('#pi-input').inputValue(), 'continued typing\n\nspeech');
    // Every real dispatch (prompt, steer, follow_up) invalidates an older recording.
    for (const command of ['prompt', 'steer', 'follow_up']) {
        socket.send(JSON.stringify({ type: command === 'prompt' ? 'agent_settled' : 'agent_start' }));
        if (command !== 'prompt') await page.locator('#pi-delivery-mode').evaluate((node, mode) => { node.value = mode; node.dispatchEvent(new Event('change', { bubbles: true })); }, command);
        await page.locator('#pi-input').fill('sent ' + command); await start(); const before = await version();
        await page.locator('#pi-send-button').click();
        console.log(JSON.stringify({ dispatch: command, commands: commands.map(cmd => cmd.type), version: await version(), input: await page.locator('#pi-input').inputValue(), notices: await page.locator('#pi-toast-region').textContent(), errors }));
        await page.waitForFunction(() => document.querySelector('#pi-input').value === '');
        assert.equal(await version(), before + 1); assert.equal(commands.filter(cmd => ['prompt', 'steer', 'follow_up'].includes(cmd.type)).at(-1).type, command);
        await page.locator('#pi-input').fill('next ' + command); await finish('old ' + command); await manual('next ' + command, 'old ' + command);
    }
    socket.send(JSON.stringify({ type: 'agent_settled' }));
    for (const [text, command] of [['!synthetic shell', 'bash'], ['/compact', 'compact']]) {
        await page.locator('#pi-input').fill(text); await start(); const beforeCommand = await version();
        await page.locator('#pi-send-button').click(); await page.waitForFunction(() => document.querySelector('#pi-input').value === '');
        assert.equal(await version(), beforeCommand + 1); assert.ok(commands.some(cmd => cmd.type === command));
        await finish('before command'); await manual('', 'before command');
    }
    // Pending submission prevents duplicates; a lost acknowledgement keeps transcript manual.
    await page.locator('#pi-input').fill('uncertain'); await start(); const beforeUnknown = await version();
    holdSend = true; await page.locator('#pi-send-button').click();
    await page.waitForFunction(() => document.querySelector('#pi-send-button').disabled);
    const sentCount = commands.filter(cmd => cmd.type === 'prompt').length;
    await page.locator('#pi-send-button').dispatchEvent('click');
    assert.equal(commands.filter(cmd => cmd.type === 'prompt').length, sentCount);
    holdSend = false; reply(pendingSend.ws, pendingSend.cmd, {}, 'Synthetic connection closed before acknowledgement');
    await page.waitForFunction(() => document.querySelector('#pi-attachment-status').textContent.includes('不确定'));
    assert.equal(await version(), beforeUnknown + 1); await finish('unknown speech'); await manual('uncertain', 'unknown speech');
    await page.locator('#pi-input').fill('rejected draft'); await start(); const beforeRejection = await version();
    sendError = 'Synthetic explicit rejection'; await page.locator('#pi-send-button').click();
    await page.waitForFunction(() => document.querySelector('#pi-toast-region').textContent.includes('Synthetic explicit rejection'));
    assert.equal(await version(), beforeRejection + 1); await finish('rejected speech'); await manual('rejected draft', 'rejected speech');
    // Schedule validation does not submit the main draft or advance its version.
    await page.locator('#pi-input').fill('schedule draft'); await start(); const beforeValidation = await version();
    await page.evaluate(() => workflowFixture.openSchedule()); await page.locator('#pi-workflow-message').fill('/invalid');
    await page.locator('#pi-workflow-submit').click(); await page.locator('#pi-workflow-error').waitFor({ state: 'visible' });
    assert.equal(writes.length, 0); assert.equal(await version(), beforeValidation);
    await page.locator('#pi-workflow-cancel').click(); await finish('still current');
    assert.equal(await page.locator('#pi-input').inputValue(), 'schedule draft\n\nstill current');
    for (const outcome of ['accepted', 'uncertain']) {
        await page.locator('#pi-input').fill('schedule ' + outcome); await start(); const beforeSchedule = await version();
        scheduled = null; await page.evaluate(() => workflowFixture.openSchedule()); await page.locator('#pi-workflow-submit').click();
        await page.waitForFunction(() => workflowFixture.inFlight && document.querySelector('#pi-workflow-submit').disabled);
        assert.ok(scheduled); assert.equal(await version(), beforeSchedule + 1);
        if (outcome === 'accepted') { await scheduled.fulfill({ json: {} }); await page.locator('#pi-workflow-dialog').waitFor({ state: 'hidden' }); }
        else { await scheduled.abort('connectionfailed'); await page.locator('#pi-workflow-error').waitFor({ state: 'visible' }); await page.locator('#pi-workflow-cancel').click(); }
        const draft = outcome === 'accepted' ? 'after schedule' : 'schedule uncertain';
        if (outcome === 'accepted') await page.locator('#pi-input').fill(draft);
        await finish('scheduled speech'); await manual(draft, 'scheduled speech');
    }
    // Editing an already stored job never submits or consumes the current composer.
    await page.locator('#pi-input').fill('unsubmitted main draft'); await start(); const beforeEdit = await version();
    await page.evaluate(job => workflowFixture.openSchedule(job), existingJob); await page.locator('#pi-workflow-message').fill('edited existing job');
    await page.locator('#pi-workflow-submit').click(); await page.locator('#pi-workflow-dialog').waitFor({ state: 'hidden' });
    assert.equal(await version(), beforeEdit); await finish('current speech');
    assert.equal(await page.locator('#pi-input').inputValue(), 'unsubmitted main draft\n\ncurrent speech');
    // A reconnect leaves an old editor unable to commit the new connection's composer.
    await page.evaluate(() => workflowFixture.openSchedule()); const beforeReconnect = await version(), beforeStaleWrites = writes.length;
    const oldGeneration = await page.evaluate(() => voiceFixture.host.context().generation);
    socket.close({ code: 1012, reason: 'synthetic editor reconnect' });
    await page.waitForFunction(generation => { const ctx = voiceFixture.host.context(); return ctx.connected && ctx.generation > generation; }, oldGeneration);
    await page.locator('#pi-workflow-submit').click(); await page.locator('#pi-workflow-error').waitFor({ state: 'visible' });
    assert.equal(await version(), beforeReconnect); assert.equal(writes.length, beforeStaleWrites);
    await page.locator('#pi-workflow-cancel').click();
    // An old schedule response cannot consume the new thread's identical draft.
    await page.locator('#pi-input').fill('identical'); await page.evaluate(() => workflowFixture.openSchedule()); await page.locator('#pi-workflow-submit').click();
    await page.waitForFunction(() => workflowFixture.inFlight);
    await page.evaluate(({ cwd }) => PiChatNavigation.openSession({ cwd, sessionId: 'two', draft: 'identical' }), { cwd }); await ready('two');
    await scheduled.fulfill({ json: {} });
    await page.waitForFunction(() => !workflowFixture.inFlight); assert.equal(await page.locator('#pi-input').inputValue(), 'identical');
    await page.locator('#pi-file-input').setInputFiles({ name: 'kept.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic attachment') });
    await page.waitForFunction(() => document.querySelector('#pi-attachments').textContent.includes('kept.txt'));
    if (width < 900) { await page.locator('#pi-toggle-sessions').click(); await page.waitForFunction(() => document.querySelector('#pi-session-pane').getBoundingClientRect().left >= -1); assert.equal(await page.locator('#pi-session-pane').evaluate(n => n.getBoundingClientRect().left >= -1), true); }
    assert.deepEqual(await page.evaluate(() => ['body', '.pi-composer', '#pi-transcript-content'].filter(selector => { const node = document.querySelector(selector); return node.scrollWidth > node.clientWidth + 1; })), []);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, commands: commands.map(cmd => cmd.type), scheduled: writes.length, version: await version(), pageerror: errors }));
    await context.close();
}
(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    try { for (const width of [1440, 393]) await run(browser, width); } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
