const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PI_MERMAID_TEST_URL || 'http://127.0.0.1:3001';
const cwd = '/srv/mermaid-fixture', session = { id: 'mermaid-fixture', cwd, name: 'Mermaid 测试' };
const fence = source => '```mermaid\n' + source + '\n```';
const diagrams = ['flowchart LR\n A[网页] --> B[网关] --> C[Pi 会话]', 'sequenceDiagram\n participant A as 网页\n participant B as 服务\n A->>B: 请求\n B-->>A: 回复', 'stateDiagram-v2\n [*] --> Idle\n Idle --> Running\n Running --> Idle'];
(async () => {
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        for (const width of [1440, 393, 320]) {
            const context = await browser.newContext({ locale: 'zh-CN', viewport: { width, height: 950 }, isMobile: width < 900, hasTouch: width < 900 });
            const page = await context.newPage(), errors = [], unexpected = [];
            let socket;
            let messages = [{ role: 'user', content: [{ type: 'text', text: '画图' }] }, { role: 'assistant', content: [{ type: 'text', text: diagrams.map(fence).join('\n\n') }], timestamp: 1234 }];
            page.on('pageerror', e => errors.push(e.message));
            page.on('request', request => { if (request.url().includes('example.invalid')) unexpected.push(request.url()); });
            await page.addInitScript(({ cwd, id }) => { if (window !== window.top) return; localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, id); }, { cwd, id: session.id });
            await page.route('**/api/**', route => {
                const path = new URL(route.request().url()).pathname;
                if (route.request().method() !== 'GET') unexpected.push(path);
                let json = {};
                if (path.endsWith('/status')) json = { ok: true, version: '0.85.0', projectRoots: ['/srv'] };
                if (path.endsWith('/projects')) json = { projects: [{ cwd, name: '测试', sessionCount: 1 }], roots: ['/srv'] };
                if (path.endsWith('/sessions')) json = { sessions: [session] };
                if (path.endsWith('/activity')) json = { runtimes: [], pinnedProjects: [], replyNotices: [] };
                if (path.includes('history') || path.endsWith('/prompts')) json = [];
                return route.fulfill({ json });
            });
            await page.routeWebSocket('**/api/pi/ws', ws => {
                socket = ws;
                ws.onMessage(raw => {
                    const c = JSON.parse(raw), model = { id: 'fixture', provider: 'fixture', input: ['text'] }, state = { model, isStreaming: false };
                    const data = c.type === 'open_session' ? { session, state, messages: { messages }, models: { models: [model] }, stats: {}, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } } : c.type === 'get_messages' ? { messages } : c.type === 'get_state' ? state : {};
                    ws.send(JSON.stringify({ type: 'response', id: c.id, command: c.type, success: true, data }));
                });
            });
            await page.goto(base, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => document.querySelectorAll('.pi-mermaid[data-state="ready"]').length === 3, null, { timeout: 45000 });
            for (const theme of ['daylight', 'mint', 'dark']) {
                await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
                await page.waitForFunction(theme => [...document.querySelectorAll('.pi-mermaid')].every(e => e.dataset.theme === (theme === 'dark' ? 'dark' : 'light')), theme);
                await page.waitForFunction(() => [...document.querySelectorAll('.pi-mermaid-image')].every(i => i.complete && i.naturalWidth > 0));
                const widths = await page.evaluate(() => ['#pi-transcript', '#pi-transcript-content', 'body'].map(s => { const e = document.querySelector(s); return [s, e.scrollWidth, e.clientWidth]; }));
                for (const [s, scroll, client] of widths) assert.ok(scroll <= client + 1, `${width}/${theme}/${s}: ${scroll}>${client}`);
            }
            await page.locator('.pi-mermaid-source summary').first().click();
            assert.equal(await page.locator('.pi-mermaid-source code').first().textContent(), diagrams[0] + '\n');
            await page.screenshot({ path: `/tmp/pi-mermaid-${width}.png` });
            // Streaming fences stay as code until the closing fence arrives.
            socket.send(JSON.stringify({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 2222 } }));
            const partial = '```mermaid\nflowchart LR\n X --> Y';
            const delta = text => socket.send(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text } }));
            delta(partial);
            await page.waitForSelector('.streaming .language-mermaid-pending');
            assert.equal(await page.locator('.streaming .pi-mermaid').count(), 0);
            delta('\n```');
            await page.waitForSelector('.streaming .pi-mermaid[data-state="ready"]');
            delta('\n\n图后的正文继续输出。');
            await page.waitForSelector('.streaming .pi-mermaid[data-state="ready"]');
            const completed = { role: 'assistant', timestamp: 2222, content: [{ type: 'text', text: partial + '\n```\n\n图后的正文继续输出。' }] };
            messages = [...messages, { ...completed, content: [{ type: 'text', text: completed.content[0].text + '\n\n权威快照已恢复。' }] }];
            socket.send(JSON.stringify({ type: 'message_end', message: completed }));
            socket.send(JSON.stringify({ type: 'agent_settled' }));
            await page.waitForFunction(() => document.querySelector('#pi-transcript-content').textContent.includes('权威快照已恢复。'));
            await page.waitForFunction(() => document.querySelectorAll('.pi-mermaid[data-state="ready"]').length === 4 && !document.querySelector('.streaming'));
            assert.equal(await page.locator('.pi-mermaid').count(), 4);
            // Invalid syntax, document configuration and HTML stay isolated and preserve source.
            await page.evaluate(sources => {
                for (const source of sources) { const host = document.createElement('div'); host.className = 'pi-markdown mermaid-bad'; host.innerHTML = PiFileViewer.markdown('```mermaid\n' + source + '\n```'); document.querySelector('#pi-transcript-content').append(host); }
            }, ['not-a-diagram', '%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\n A-->B', 'flowchart LR\n A["<img src=https://example.invalid/x onerror=parent.alert(1)>"] --> B', 'flowchart LR\n' + ' '.repeat(20001)]);
            await page.waitForFunction(() => [...document.querySelectorAll('.mermaid-bad .pi-mermaid')].length === 4 && [...document.querySelectorAll('.mermaid-bad .pi-mermaid')].every(e => e.dataset.state));
            assert.equal(await page.locator('.mermaid-bad .pi-mermaid[data-state="error"]').count() >= 3, true);
            assert.equal(await page.locator('.pi-mermaid iframe, .pi-mermaid svg, .pi-mermaid script').count(), 0);
            // Remove queued work; late results must not revive removed content.
            await page.evaluate(() => document.querySelectorAll('.mermaid-bad').forEach(e => e.remove()));
            assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
            console.log(`Mermaid ${width}: passed`); await context.close();
        }
    } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
