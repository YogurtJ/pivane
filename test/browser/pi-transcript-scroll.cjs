const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const baseUrl = process.env.PI_SCROLL_TEST_URL || 'http://127.0.0.1:3101';
const cwd = '/srv/pi-scroll-fixture';
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', input: ['text', 'image'] };
const session = { id: 'scroll-long', cwd, name: 'Transcript scroll verification', messageCount: 80 };
const shortSession = { ...session, id: 'scroll-short', name: 'Short session', messageCount: 1 };
const runtime = { model, isStreaming: false, thinkingLevel: 'off' };
const text = index => ({ role: index % 2 ? 'assistant' : 'user', timestamp: 1000 + index,
    content: [{ type: 'text', text: `Message ${index}\n\n${'A stable paragraph for transcript navigation. '.repeat(10)}` }] });

async function run(browser, size) {
    const context = await browser.newContext({ locale: 'zh-CN', viewport: size, hasTouch: size.width < 900, isMobile: size.width < 900 });
    const page = await context.newPage();
    const errors = [];
    const writes = [];
    const loadingRequests = new Set();
    page.on('request', request => loadingRequests.add(request.url()));
    page.on('requestfinished', request => loadingRequests.delete(request.url()));
    page.on('requestfailed', request => loadingRequests.delete(request.url()));
    let socket;
    let activeId = session.id;
    let messages = Array.from({ length: 80 }, (_, i) => text(i));
    messages[20].content.unshift({ type: 'thinking', thinking: 'Preserved expanded thinking. '.repeat(30) });
    messages[21].content.push({ type: 'toolCall', id: 'tool-fixture', name: 'bash', arguments: { command: 'pwd' } });
    const currentMessages = () => activeId === session.id ? messages : [text(0)];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ cwd, id }) => {
        localStorage.setItem('pi.web.cwd', cwd);
        localStorage.setItem('pi.web.transcriptMode', 'full');
        localStorage.setItem(`pi.web.session:${cwd}`, id);
        Object.defineProperty(window, 'PiTranscriptScroll', {
            configurable: true,
            set(Controller) {
                Object.defineProperty(window, 'PiTranscriptScroll', { value: class extends Controller {
                    constructor(options) { super(options); window.scrollFixtureController = this; }
                } });
            }
        });
    }, { cwd, id: session.id });
    await page.route('**/api/**', async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (request.method() !== 'GET') {
            writes.push(path);
            return route.fulfill({ json: { ok: true } });
        }
        if (path === '/api/pi/status') return route.fulfill({ json: { ok: true, version: '0.84.3', projectRoots: ['/srv'] } });
        if (path === '/api/pi/projects') return route.fulfill({ json: { projects: [{ cwd, name: 'Scroll fixture', sessionCount: 2 }], roots: ['/srv'] } });
        if (path === '/api/pi/sessions') return route.fulfill({ json: { sessions: [session, shortSession] } });
        if (path === '/api/pi/activity') return route.fulfill({ json: { runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] } });
        if (path.startsWith('/api/pi/')) return route.fulfill({ json: {} });
        if (path.includes('history') || path === '/api/prompts') return route.fulfill({ json: [] });
        if (path.includes('/health')) return route.fulfill({ json: { ok: false, configured: false } });
        await route.continue();
    });
    await page.routeWebSocket('**/api/pi/ws', ws => {
        socket = ws;
        ws.onMessage(raw => {
            const command = JSON.parse(raw);
            let data = {};
            if (command.type === 'open_session') {
                activeId = command.sessionId;
                data = { session: activeId === session.id ? session : shortSession,
                    state: runtime, messages: { messages: currentMessages() }, stats: {}, models: { models: [model] },
                    thinkingLevels: { levels: ['off'] }, commands: { commands: [] } };
            } else if (command.type === 'get_messages') data = { messages: currentMessages() };
            else if (command.type === 'get_state') data = runtime;
            else if (!['get_session_stats', 'get_available_models', 'get_available_thinking_levels'].includes(command.type)) {
                throw new Error(`Unexpected RPC command: ${command.type}`);
            }
            ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
        });
    });
    const send = event => socket.send(JSON.stringify(event));
    const settle = async () => { send({ type: 'agent_settled' }); await page.waitForTimeout(300); };
    const metrics = () => page.locator('#pi-transcript').evaluate(el => ({
        top: el.scrollTop, max: el.scrollHeight - el.clientHeight, height: el.clientHeight,
        latest: !document.getElementById('pi-jump-latest').hidden
    }));
    const expectBottom = async () => {
        await page.waitForFunction(() => {
            const el = document.getElementById('pi-transcript');
            return el.scrollHeight - el.clientHeight - el.scrollTop <= 2;
        }).catch(async error => {
            console.error('Bottom failure', size, await metrics(), await page.evaluate(() => ({ following: window.scrollFixtureController.following, lastTop: window.scrollFixtureController.lastTop })));
            await page.screenshot({ path: `/tmp/pi-scroll-failure-${size.width}.png` });
            throw error;
        });
        assert.equal((await metrics()).latest, false);
    };
    const scrollTo = async value => {
        await page.locator('#pi-transcript').evaluate((el, value) => { el.scrollTop = value; }, value);
        await page.waitForTimeout(100);
    };
    const jump = async () => { await page.locator('#pi-jump-latest').click(); await expectBottom(); };
    await page.goto(baseUrl).catch(async error => {
        console.error('Unfinished page requests:', [...loadingRequests]);
        throw error;
    });
    await page.waitForFunction(() => document.querySelectorAll('#pi-transcript-content > .pi-message').length === 80);
    await expectBottom();
    assert.equal(await page.locator('#pi-transcript-track').isVisible(), size.width > 900);

    // Real wheel scrolling pauses follow before the next streamed frame.
    if (size.width > 900) {
        await page.locator('#pi-transcript').hover();
        await page.mouse.wheel(0, -700);
        await page.waitForTimeout(250);
    } else {
        const cdp = await context.newCDPSession(page);
        const box = await page.locator('#pi-transcript').boundingBox();
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 3 };
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
        for (let i = 1; i <= 8; i++) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y + i * 25 }] });
            await page.waitForTimeout(20);
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(500);
        assert.ok((await metrics()).latest, 'touch gesture pauses follow');
    }
    let before = await metrics();
    assert.ok(before.latest);
    const live = { role: 'assistant', timestamp: 2000, content: [{ type: 'text', text: 'Stream result. '.repeat(180) }] };
    send({ type: 'agent_start' });
    send({ type: 'message_start', message: { ...live, content: [] } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: live.content[0].text } });
    await page.waitForTimeout(150);
    assert.ok(Math.abs((await metrics()).top - before.top) <= 2, 'stream must not move history');
    send({ type: 'tool_execution_start', toolCallId: 'live-tool', toolName: 'bash', args: { command: 'pwd' } });
    await page.waitForTimeout(80);
    await page.locator('[data-tool-id="live-tool"]').evaluate(el => { el.open = true; });
    send({ type: 'tool_execution_update', toolCallId: 'live-tool', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'Tool output\n'.repeat(100) }] } });
    send({ type: 'tool_execution_end', toolCallId: 'live-tool', toolName: 'bash', isError: true, result: { content: [{ type: 'text', text: 'Controlled tool error' }] } });
    await page.waitForTimeout(120);
    assert.ok(Math.abs((await metrics()).top - before.top) <= 2, 'tool output must not move history');
    assert.equal(await page.locator('[data-tool-id="live-tool"]').getAttribute('data-state'), 'error');
    send({ type: 'message_end', message: live });
    messages.push(live);
    await settle();
    assert.ok(Math.abs((await metrics()).top - before.top) <= 2, 'settled redraw must not move history');
    await jump();

    const next = { role: 'assistant', timestamp: 2001, content: [{ type: 'text', text: 'Large delta. '.repeat(1800) }] };
    send({ type: 'message_start', message: { ...next, content: [] } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: next.content[0].text } });
    await page.waitForTimeout(150);
    await expectBottom();
    send({ type: 'message_end', message: next });
    messages.push(next);
    await settle();
    await expectBottom();

    // Expanded details survive authoritative redraw and reconnect.
    await page.locator('#pi-transcript-content > :nth-child(21) .pi-thinking-block').evaluate(el => { el.open = true; });
    await page.locator('#pi-transcript-content > :nth-child(22) .pi-tool-row').evaluate(el => { el.open = true; });
    await scrollTo(0);
    await page.locator('#pi-transcript').evaluate(el => {
        const anchor = document.querySelector('#pi-transcript-content > :nth-child(23)');
        el.scrollTop = anchor.getBoundingClientRect().top - el.getBoundingClientRect().top + 15;
    });
    await page.waitForTimeout(100);
    before = await metrics();
    await settle();
    assert.ok(Math.abs((await metrics()).top - before.top) <= 2);
    assert.equal(await page.locator('#pi-transcript-content > :nth-child(21) .pi-thinking-block').evaluate(el => el.open), true);
    assert.equal(await page.locator('#pi-transcript-content > :nth-child(22) .pi-tool-row').evaluate(el => el.open), true);
    socket.close({ code: 1012, reason: 'Reconnect fixture' });
    await page.waitForTimeout(2400);
    assert.ok(Math.abs((await metrics()).top - before.top) <= 2, 'reconnect must preserve reading position');

    if (size.width > 900) {
        const track = await page.locator('#pi-transcript-track').boundingBox();
        await page.mouse.click(track.x + track.width / 2, track.y + track.height * 0.6);
        let ratio = (await metrics()).top / (await metrics()).max;
        assert.ok(ratio > 0.55 && ratio < 0.65, 'track click jumps proportionally');
        const thumb = await page.locator('#pi-transcript-thumb').boundingBox();
        await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
        await page.mouse.down();
        await page.mouse.move(track.x + 8, track.y + track.height * 0.25, { steps: 10 });
        await page.mouse.up();
        ratio = (await metrics()).top / (await metrics()).max;
        assert.ok(ratio > 0.2 && ratio < 0.3, 'thumb drag maps position');
        await page.locator('#pi-transcript-track').press('End');
        await expectBottom();
        await page.locator('#pi-transcript-track').press('Home');
        assert.equal((await metrics()).top, 0);
        await page.locator('#pi-transcript-track').press('PageDown');
        assert.ok((await metrics()).top > 0);
    }
    await jump();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await scrollTo(1000);
    await jump();
    assert.equal(await page.locator('#pi-transcript').evaluate(el => getComputedStyle(el).scrollBehavior), 'auto');
    const imageSize = await page.evaluate(async () => {
        const image = document.createElement('img');
        image.className = 'pi-message-image';
        document.getElementById('pi-transcript-content').appendChild(image);
        await new Promise(resolve => setTimeout(resolve, 80));
        image.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="450"><rect width="600" height="450" fill="#568d79"/></svg>');
        await image.decode();
        return image.getBoundingClientRect().height;
    });
    assert.ok(imageSize > 100, 'delayed image must render');
    await page.waitForTimeout(100);
    await expectBottom();
    await page.locator('#pi-transcript-content > img').evaluate(el => el.remove());
    await page.locator('#pi-composer-add-button').click();
    await page.locator('#pi-attach-button').click();
    await page.locator('#pi-file-input').setInputFiles({ name: 'scroll-fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('Attachment fixture') });
    await expectBottom();
    await page.locator('#pi-attachments [data-remove-attachment]').click();
    await expectBottom();
    await page.locator('#pi-toggle-inspector').click();
    await page.waitForTimeout(150);
    await page.locator('#pi-close-inspector').click();
    await expectBottom();

    // A switch must not inherit the old session's paused follow state.
    await scrollTo(300);
    if (size.width <= 900) await page.locator('#pi-toggle-sessions').click();
    await page.locator(`[data-session-id="${shortSession.id}"] .pi-session-main`).click();
    await page.waitForTimeout(200);
    await expectBottom();
    if (size.width <= 900) await page.locator('#pi-toggle-sessions').click();
    await page.locator(`[data-session-id="${session.id}"] .pi-session-main`).click();
    await page.waitForTimeout(200);
    await expectBottom();
    await scrollTo(1200);
    before = await metrics();
    await page.locator('[data-tab="media"]').click();
    await page.waitForTimeout(100);
    messages.push({ role: 'assistant', timestamp: 9000, content: [{ type: 'text', text: 'Completed while another workspace was visible.' }] });
    await settle();
    await page.locator('[data-tab="chat"]').click();
    await page.waitForTimeout(150);
    assert.ok(Math.abs((await metrics()).top - before.top) <= 2, 'workspace switch must retain history position');
    for (const theme of ['daylight', 'mint', 'dark']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await page.screenshot({ path: `/tmp/pi-scroll-${size.width}-${theme}.png` });
    }
    assert.equal(await page.evaluate(() => document.body.scrollWidth > document.body.clientWidth), false);
    const button = await page.locator('#pi-jump-latest').boundingBox();
    const composer = await page.locator('.pi-composer-wrap').boundingBox();
    assert.ok(button.y + button.height < composer.y, 'latest button must not overlap composer');
    assert.deepEqual(errors, []);
    assert.deepEqual(writes, []);
    console.log(`PASS ${size.width}x${size.height}: follow, history, redraw, reconnect, track, details, attachments, drawers, session switch; no writes/errors/overflow`);
    await context.close();
}

(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        for (const size of [{ width: 1440, height: 1000 }, { width: 393, height: 852 }, { width: 412, height: 915 }]) await run(browser, size);
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
