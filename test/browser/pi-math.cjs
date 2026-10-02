const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
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
    const app = express();
    for (const [name, directory] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use('/vendor/' + name, express.static(path.join(root, 'node_modules', directory)));
    app.use(express.static(process.env.PI_MATH_PUBLIC_ROOT || path.join(root, 'public')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    let browser;
    try {
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
        for (const width of [1440, 393, 320]) {
            const context = await browser.newContext({ locale: 'zh-CN', viewport: { width, height: 950 }, isMobile: width < 900, hasTouch: width < 900 });
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
                const source = String.raw`$$\underbrace{` + Array(120).fill('a').join('+') + String.raw`}_{n\text{ 项}}$$`;
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
            // Subscripts have a small KaTeX overhang; short formulas must not scroll.
            await page.evaluate(() => {
                const short = document.createElement('div'); short.className = 'pi-markdown math-short';
                short.innerHTML = PiFileViewer.markdown(String.raw`那么：

- \(\sum v_n\) **收敛** ⇒ \(\sum u_n\) **收敛**。
- \(\sum u_n\) **发散** ⇒ \(\sum v_n\) **发散**。

\(\sqrt[n]{u_n}\) \(\frac{u_{n+1}}{u_n}\)

\[\sum v_n\]`);
                document.querySelector('#pi-transcript-content').append(short);
                const inline = document.createElement('div'); inline.className = 'pi-markdown math-wide-inline';
                inline.innerHTML = PiFileViewer.markdown('$' + 'x'.repeat(240) + '$');
                document.querySelector('#pi-transcript-content').append(inline);
            });
            for (const fontSize of [12, 16, 24]) {
                await page.evaluate(size => document.querySelector('.math-short').style.fontSize = `${size}px`, fontSize);
                await page.evaluate(() => document.fonts.ready);
                const short = await page.evaluate(() => [...document.querySelectorAll('.math-short .pi-math')].map(e => ({ source: e.querySelector('annotation')?.textContent, scroll: e.scrollWidth, client: e.clientWidth, height: e.offsetHeight - e.clientHeight })));
                for (const formula of short) { assert.equal(formula.scroll, formula.client, `${width}/${fontSize}: ${formula.source}`); assert.equal(formula.height, 0); }
            }
            for (const theme of ['daylight', 'mint', 'dark']) {
                await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
                await page.evaluate(() => document.fonts.ready);
                const widths = await page.evaluate(() => ['#pi-transcript', '#pi-transcript-content', '.math-wide', '.math-wide-inline', '.math-short', '.math-preview', 'body'].map(s => {
                    const e = document.querySelector(s); return [s, e.scrollWidth, e.clientWidth];
                }));
                for (const [s, scroll, client] of widths) assert.ok(scroll <= client + 1, `${width}/${theme}/${s}: ${scroll}>${client}`);
                assert.ok(await page.evaluate(() => { const scroll = document.querySelector('.math-wide .pi-math'); const content = scroll.querySelector('.katex-display'); return content.getBoundingClientRect().left >= scroll.getBoundingClientRect().left - 1 && scroll.scrollWidth > scroll.clientWidth; }));
                for (const selector of ['.math-wide .pi-math', '.math-wide-inline .pi-math']) {
                    const movement = await page.evaluate(selector => { const e = document.querySelector(selector); e.scrollLeft = 50; return e.scrollLeft; }, selector);
                    assert.ok(movement > 0, `${width}/${theme}/${selector} remains scrollable`);
                    await page.evaluate(selector => { document.querySelector(selector).scrollLeft = 0; }, selector);
                }
            }
            await page.screenshot({ path: `/tmp/pi-math-${width}.png` });
            await page.evaluate(() => document.querySelectorAll('.math-short, .math-wide-inline').forEach(e => e.remove()));
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
            // A lesson with 146 formulas must render its entire summary and final exercise.
            const longReply = await page.evaluate(() => {
                const tail = String.raw`| 方法 | 看什么 | 题型 |
|---|---|---|
| 比值法 | \(\dfrac{u_{n+1}}{u_n}\) | \(a^n\)、\(n^n\) |
| 根值法 | \(\sqrt[n]{u_n}\) | \(n\) 或 \(n^2\) 次方 |
| 积分法 | \(\int f(x)\,dx\) | \(p\)、\(\ln n\) |

\[\boxed{\rho=1\text{ 时无法判断}}\]

\(k\)、\(\rho\)、\(\rho\)、\(1\)、\(\rho=1\)、\(\sum\frac1n\)、\(\sum\frac1{n^2}\)、\(p=1\)、\(\ln n\)。

\[\sum\frac{3^n}{n!}\]`;
                const source = Array.from({ length: 126 }, (_, i) => `$x_{${i}}$`).join(' ') + '\n\n' + tail;
                const node = document.createElement('article'); node.className = 'pi-markdown math-lesson';
                node.innerHTML = PiFileViewer.markdown(source); document.querySelector('#pi-transcript-content').append(node);
                const result = { count: node.querySelectorAll('.katex').length, fallback: node.querySelectorAll('.pi-math-fallback').length, final: node.querySelectorAll('annotation')[145]?.textContent, tailCount: (() => { const t = document.createElement('template'); t.innerHTML = PiFileViewer.markdown(tail); return t.content.querySelectorAll('.katex').length; })() };
                node.remove(); return result;
            });
            assert.deepEqual(longReply, { count: 146, fallback: 0, final: String.raw`\sum\frac{3^n}{n!}`, tailCount: 20 });
            assert.equal(await page.evaluate(() => { const t = document.createElement('template'); t.innerHTML = PiFileViewer.markdown('$x$ '.repeat(140) + 'END'); return t.content.querySelectorAll('.katex').length; }), 140);
            // Text and output budgets still bound expensive input and preserve trailing prose.
            const budgets = await page.evaluate(() => {
                const inspect = source => { const t = document.createElement('template'); t.innerHTML = PiFileViewer.markdown(source + 'END'); return { count: t.content.querySelectorAll('.katex').length, fallback: t.content.querySelectorAll('.pi-math-fallback').length, end: t.content.textContent.trimEnd().endsWith('END') }; };
                let calls = 0;
                const original = katex.renderToString; katex.renderToString = (...args) => { calls++; return original(...args); };
                let source;
                try { source = inspect(Array.from({ length: 20 }, (_, i) => '$' + String.raw`\badcommand` + ' '.repeat(9000) + i + '$ ').join('')); }
                finally { katex.renderToString = original; }
                const output = inspect(('$' + 'x+'.repeat(160) + 'y$ ').repeat(100));
                const fresh = inspect('$z$ ');
                return { source, calls, output, fresh };
            });
            assert.ok(budgets.calls > 0 && budgets.calls < 20); assert.equal(budgets.source.fallback, 20); assert.equal(budgets.source.end, true);
            assert.ok(budgets.output.count > 0 && budgets.output.count < 100); assert.equal(budgets.output.count + budgets.output.fallback, 100); assert.equal(budgets.output.end, true);
            assert.equal(budgets.fresh.count, 1); assert.equal(budgets.fresh.fallback, 0);
            assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
            console.log(`Math ${width}: passed`); await context.close();
        }
    } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
