const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PI_MATH_TEST_URL || 'http://127.0.0.1:3001';
const cwd = '/srv/math-fixture', session = { id: 'math-fixture', cwd, name: '公式测试' };
const mathText = String.raw`行内 $E=mc^2$，以及 \(\frac{a_1}{b^2}\)。

$$
\int_0^1 x^2\,dx = \frac{1}{3}
$$

\[
\begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}
\]

\`占位\`
` .replace('\\`占位\\`', () => '`$code$`') + '\n\n```js\nconst price = "$5";\n```\n\n价格 $5 和 $10。转义 \\$literal\\$。\n\n' + '```math\n\\sum_{i=1}^n i\n```';
(async () => {
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        for (const width of [1440, 393, 320]) {
            const context = await browser.newContext({ viewport: { width, height: 950 }, isMobile: width < 900, hasTouch: width < 900 });
            const page = await context.newPage(), errors = [], unexpected = [];
            let socket;
            let messages = [{ role: 'user', content: [{ type: 'text', text: '画图' }] }, { role: 'assistant', content: [{ type: 'text', text: mathText }], timestamp: 1234 }];
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
            await page.waitForSelector('#pi-transcript-content .katex');
            assert.equal(await page.locator('#pi-transcript-content .katex').count(), 5);
            assert.equal(await page.locator('#pi-transcript-content code .katex').count(), 0);
            assert.ok((await page.locator('#pi-transcript-content').textContent()).includes('价格 $5 和 $10'));
            assert.equal(await page.locator('.pi-math-fallback').count(), 0);
            assert.equal(await page.evaluate(() => { const t = document.createElement('template'); t.innerHTML = PiFileViewer.markdown('<code>$x$</code>'); return t.content.querySelectorAll('.katex').length; }), 0);
            // Shared renderer used by side chat and the actual file viewer, including preview sanitization.
            await page.evaluate(() => {
                const source = String.raw`$$\underbrace{a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a+a}_{n\text{ 项}}$$`;
                const node = document.createElement('div'); node.className = 'pi-markdown math-wide';
                node.innerHTML = PiFileViewer.markdown(source); document.querySelector('#pi-transcript-content').append(node);
                const side = document.createElement('div'); side.className = 'pi-markdown';
                side.innerHTML = PiFileViewer.markdown(String.raw`\(\sqrt{x}\)`); document.querySelector('#pi-side-messages').append(side);
                const preview = document.createElement('article'); preview.className = 'pi-markdown pi-file-markdown math-preview';
                preview.innerHTML = PiFileViewer.markdown(String.raw`$x_i$ <img src="https://example.invalid/no">`, '/srv/math.md', true);
                document.querySelector('#pi-transcript-content').append(preview);
            });
            assert.equal(await page.locator('#pi-side-messages .katex').count(), 1);
            assert.equal(await page.locator('.math-preview .katex').count(), 1);
            assert.equal(await page.locator('.math-preview img').count(), 0);
            for (const theme of ['daylight', 'mint', 'dark']) {
                await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
                await page.evaluate(() => document.fonts.ready);
                const widths = await page.evaluate(() => ['#pi-transcript', '#pi-transcript-content', '.math-wide', '.math-preview', 'body'].map(s => {
                    const e = document.querySelector(s); return [s, e.scrollWidth, e.clientWidth];
                }));
                for (const [s, scroll, client] of widths) assert.ok(scroll <= client + 1, `${width}/${theme}/${s}: ${scroll}>${client}`);
                assert.ok(await page.evaluate(() => { const scroll = document.querySelector('.math-wide .pi-math'); const content = scroll.querySelector('.katex-display'); return content.getBoundingClientRect().left >= scroll.getBoundingClientRect().left - 1 && scroll.scrollWidth > 0; }));
            }
            await page.screenshot({ path: `/tmp/pi-math-${width}.png` });
            socket.send(JSON.stringify({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 2222 } }));
            const partial = String.raw`公式：\(\frac{1}{2}`;
            const delta = text => socket.send(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text } }));
            delta(partial);
            await page.waitForFunction(partial => document.querySelector('.streaming')?.textContent.includes(partial), partial);
            assert.equal(await page.locator('.streaming .katex').count(), 0);
            assert.ok((await page.locator('.streaming').textContent()).includes(partial));
            delta(String.raw`\)`);
            await page.waitForSelector('.streaming .katex');
            const completed = { role: 'assistant', timestamp: 2222, content: [{ type: 'text', text: partial + String.raw`\)` }] };
            messages = [...messages, completed];
            socket.send(JSON.stringify({ type: 'message_end', message: completed }));
            socket.send(JSON.stringify({ type: 'agent_settled' }));
            await page.waitForFunction(() => !document.querySelector('.streaming') && document.querySelectorAll('#pi-transcript-content .katex').length === 6);
            // Invalid, oversized, recursive, and untrusted commands preserve readable content, never run HTML/network.
            const security = await page.evaluate(() => {
                const sources = [String.raw`$\badcommand{x}$`, String.raw`$\href{javascript:alert(1)}{x}$`, String.raw`$\includegraphics{https://example.invalid/x}$`, String.raw`$\htmlStyle{background:url(https://example.invalid/x)}{x}$`, String.raw`$\def\a{\a}\a$`, '$' + 'x'.repeat(10001) + '$'];
                const root = document.createElement('div'); root.className = 'pi-markdown math-bad';
                root.innerHTML = PiFileViewer.markdown(sources.join('\n\n') + '\n<span style="color:red" onclick="alert(1)">ordinary</span>');
                document.querySelector('#pi-transcript-content').append(root);
                return { fallback: root.querySelectorAll('.pi-math-fallback').length, unsafe: root.querySelectorAll('a, img, script, iframe, [onclick]').length, ordinaryStyle: [...root.querySelectorAll('span')].find(e => e.textContent === 'ordinary')?.getAttribute('style') };
            });
            assert.ok(security.fallback >= 4); assert.equal(security.unsafe, 0); assert.equal(security.ordinaryStyle, null);
            // Budget must not prevent the rest of the reply from rendering.
            assert.equal(await page.evaluate(() => { const t = document.createElement('template'); t.innerHTML = PiFileViewer.markdown('$x$ '.repeat(140) + 'END'); return t.content.querySelectorAll('.katex').length; }), 128);
            assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
            console.log(`Math ${width}: passed`); await context.close();
        }
    } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
