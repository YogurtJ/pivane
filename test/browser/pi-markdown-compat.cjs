const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PI_MARKDOWN_TEST_URL || 'http://127.0.0.1:3001';
const cwd = '/synthetic/markdown-compat', session = { id: 'markdown-compat', cwd, name: 'Markdown compatibility' };
const source = String.raw`| \(x_1\) 处的情况 | 结论 | 理由 |
|---|---|---|
| 收敛 | \(R\ge|x_1-x_0|\) | 区间外会发散 |
| 发散 | \(R\le|x_1-x_0|\) | 区间内会收敛 |
| **条件收敛** | \(\boxed{R=|x_1-x_0|}\) | 必须是端点 |

提示：**先判断半径。**然后检查端点。

**端点如何处理：**代入原式。

**“端点”的提醒：**单独判断。

> **区间内绝对收敛。**端点另判。`;
(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        for (const width of [1440, 393, 320]) {
            const context = await browser.newContext({ locale: 'zh-CN', viewport: { width, height: 950 }, isMobile: width < 900, hasTouch: width < 900 });
            const page = await context.newPage(), errors = [], writes = [], unsafeRequests = [];
            let socket;
            let messages = [{ role: 'user', content: [{ type: 'text', text: 'Synthetic lesson' }] }, { role: 'assistant', content: [{ type: 'text', text: source }], timestamp: 1000 }];
            page.on('pageerror', error => errors.push(error.message));
            page.on('request', request => { if (request.url().includes('example.invalid')) unsafeRequests.push(request.url()); });
            await page.addInitScript(({ cwd, id }) => {
                localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, id);
            }, { cwd, id: session.id });
            await page.route('**/api/**', route => {
                const request = route.request(), endpoint = new URL(request.url()).pathname;
                if (request.method() !== 'GET') writes.push(endpoint);
                let json = {};
                if (endpoint.endsWith('/status')) json = { ok: true, projectRoots: ['/synthetic'] };
                if (endpoint.endsWith('/projects')) json = { projects: [{ cwd, name: 'Fixture', sessionCount: 1 }] };
                if (endpoint.endsWith('/sessions')) json = { sessions: [session] };
                if (endpoint.endsWith('/activity')) json = { runtimes: [], pinnedProjects: [], replyNotices: [] };
                if (endpoint.includes('history') || endpoint.endsWith('/prompts')) json = [];
                return route.fulfill({ json });
            });
            await page.routeWebSocket('**/api/pi/ws', ws => {
                socket = ws;
                ws.onMessage(raw => {
                    const command = JSON.parse(raw), model = { provider: 'fixture', id: 'fixture', input: ['text'] }, state = { model, isStreaming: false };
                    const data = command.type === 'open_session' ? { session, state, messages: { messages }, models: { models: [model] }, stats: {}, thinkingLevels: { levels: ['off'] }, commands: { commands: [] } } : command.type === 'get_messages' ? { messages } : command.type === 'get_state' ? state : {};
                    ws.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
                });
            });
            await page.goto(base, { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('#pi-transcript-content table .katex');
            const initial = await page.evaluate(() => {
                const root = document.querySelector('#pi-transcript-content table').closest('.pi-markdown');
                return { formulas: root.querySelectorAll('.katex').length, fallback: root.querySelectorAll('.pi-math-fallback').length, columns: [...root.querySelectorAll('tbody tr')].map(e => e.cells.length), reasons: [...root.querySelectorAll('tbody tr td:last-child')].map(e => e.textContent), bold: [...root.querySelectorAll('strong')].map(e => e.textContent), stars: root.textContent.includes('**') };
            });
            assert.equal(initial.formulas, 4); assert.equal(initial.fallback, 0);
            assert.deepEqual(initial.columns, [3, 3, 3]); assert.deepEqual(initial.reasons, ['区间外会发散', '区间内会收敛', '必须是端点']);
            assert.deepEqual(initial.bold, ['条件收敛', '先判断半径。', '端点如何处理：', '“端点”的提醒：', '区间内绝对收敛。']);
            assert.equal(initial.stars, false);
            const consumers = await page.evaluate(source => {
                const result = [];
                for (const [host, preview] of [['#pi-side-messages', false], ['#pi-transcript-content', true]]) {
                    const node = document.createElement('article'); node.className = 'pi-markdown compat-consumer';
                    node.innerHTML = PiFileViewer.markdown(source, '/synthetic/lesson.md', preview); document.querySelector(host).append(node);
                    result.push({ formulas: node.querySelectorAll('.katex').length, bold: node.querySelectorAll('strong').length, fallback: node.querySelectorAll('.pi-math-fallback').length, stars: node.textContent.includes('**') });
                }
                return result;
            }, source);
            assert.deepEqual(consumers, [{ formulas: 4, bold: 5, fallback: 0, stars: false }, { formulas: 4, bold: 5, fallback: 0, stars: false }]);
            // Characterize ordinary Markdown against the unchanged stock parser.
            const ordinary = await page.evaluate(() => {
                const samples = [
                    '# Heading\n\nPlain text.', '**bold** and *italic* and ~~delete~~', '**Title:**next stays strict', '*提示：*文字 stays strict', '***标题：***正文 stays strict', '**未闭合：正文', '** padded ** stays literal', '**词语**接着正文',
                    '`**标题：**正文`', '``a ` **标题：**正文``', String.raw`\*\*标题：\*\*正文`, String.raw`**标题：\**正文`, '```markdown\n**标题：**正文\n| a | b |\n```', '    **标题：**正文',
                    '<code>**标题：**正文</code>', '<kbd>**标题：**正文</kbd>', '<samp>**标题：**正文</samp>', '<pre>**标题：**正文</pre>', '<code><kbd>**标题：**正文</kbd>**标题：**正文</code>', '<code>**未闭合：**正文',
                    '<span title="<code>">ordinary</span>', '[link](https://example.invalid/path "title")', '[reference][id]\n\n[id]: https://example.invalid/', '- one\n- two\n\n> quote', '1. first\n2. second', '---\n\n## Heading',
                    '| a | b |\n|:---|---:|\n| 1 | 2 |\n\nAFTER', String.raw`| a | b |
|---|---|
| a\|b | KEEP |`, '| a | b |\n|---|---|\n| `\\(x\\|y\\)` | KEEP |', '<img src="x" onerror="window.fixtureXss=true">', '<span style="color:red" onclick="window.fixtureXss=true">safe text</span>'
                ];
                const sanitize = html => DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button'], FORBID_ATTR: ['style', 'onerror', 'onclick'] });
                return samples.flatMap(text => { const expected = sanitize(marked.parse(text, { renderer: new marked.Renderer() })), actual = PiFileViewer.markdown(text); return actual === expected ? [] : [{ text, expected, actual }]; });
            });
            assert.deepEqual(ordinary, []);
            const tables = await page.evaluate(() => {
                const sources = [String.raw`$|x|$`, String.raw`$$|x|$$`, String.raw`\(|x|\)`, String.raw`\[|x|\]`, String.raw`\(\left|\frac{x}{y}\right|\)`, String.raw`\(R\ge\|x\|\)`];
                return sources.map(math => {
                    const node = document.createElement('div'); node.innerHTML = PiFileViewer.markdown(`| ${math} | 注释 |\n|:---|---:|\n| ${math} | KEEP |\n\nAFTER`);
                    return { formulas: node.querySelectorAll('.katex').length, columns: node.querySelector('tbody tr')?.cells.length, reason: node.querySelector('tbody td:last-child')?.textContent, after: node.textContent.trimEnd().endsWith('AFTER'), align: node.querySelector('thead th')?.getAttribute('align') };
                });
            });
            for (const table of tables) assert.deepEqual(table, { formulas: 2, columns: 2, reason: 'KEEP', after: true, align: 'left' });
            const nested = await page.evaluate(() => {
                const node = document.createElement('div'); node.innerHTML = PiFileViewer.markdown(String.raw`**含 \(x\) 的提示：**继续正文。

**含 [链接](https://example.invalid/) 和 ` + '`代码`' + String.raw` 的提示：**继续正文。

<code>**代码：**正文</code> **正常：**正文`);
                return { bold: node.querySelectorAll('strong').length, formulas: node.querySelectorAll('.katex').length, codeBold: node.querySelectorAll('code strong').length, links: node.querySelectorAll('strong a').length };
            });
            assert.deepEqual(nested, { bold: 3, formulas: 1, codeBold: 0, links: 1 });
            const adjacent = await page.evaluate(() => {
                const node = document.createElement('div'); node.innerHTML = PiFileViewer.markdown('**标题：**正文和**重点**\n\n**含 *斜体* 的标题：**正文');
                return { bold: [...node.querySelectorAll('strong')].map(e => e.textContent), nested: node.querySelectorAll('strong strong').length, italic: node.querySelectorAll('strong em').length };
            });
            assert.deepEqual(adjacent, { bold: ['标题：', '重点', '含 斜体 的标题：'], nested: 0, italic: 1 });
            for (const theme of ['daylight', 'mint', 'dark']) {
                await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
                await page.evaluate(() => document.fonts.ready);
                const overflow = await page.evaluate(() => ['body', '#pi-transcript', '#pi-transcript-content', '.compat-consumer'].flatMap(selector => [...document.querySelectorAll(selector)].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => ({ selector, scroll: e.scrollWidth, client: e.clientWidth }))));
                assert.deepEqual(overflow, []);
            }
            if (process.env.PIVANE_TEST_SCREENSHOT_DIR) {
                fs.mkdirSync(process.env.PIVANE_TEST_SCREENSHOT_DIR, { recursive: true });
                await page.screenshot({ path: path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR, `compat-${width}.png`) });
            }
            await page.evaluate(() => document.querySelectorAll('.compat-consumer').forEach(e => e.remove()));
            socket.send(JSON.stringify({ type: 'message_start', message: { role: 'assistant', timestamp: 2000, content: [] } }));
            const partial = String.raw`| 公式 | 理由 |
|---|---|
| \(R\ge|x|`;
            const delta = text => socket.send(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text } }));
            delta(partial);
            await page.waitForFunction(() => document.querySelector('.streaming')?.textContent.includes('R\\ge'));
            assert.equal(await page.locator('.streaming .katex').count(), 0);
            const rest = String.raw`\) | KEEP |

**端点：**单独检查。`;
            delta(rest); await page.waitForSelector('.streaming table .katex');
            assert.equal(await page.locator('.streaming tbody td:last-child').textContent(), 'KEEP');
            assert.equal(await page.locator('.streaming .pi-markdown strong').textContent(), '端点：');
            const completed = { role: 'assistant', timestamp: 2000, content: [{ type: 'text', text: partial + rest }] };
            messages = [...messages, completed];
            socket.send(JSON.stringify({ type: 'message_end', message: completed })); socket.send(JSON.stringify({ type: 'agent_settled' }));
            await page.waitForFunction(() => !document.querySelector('.streaming') && document.querySelector('#pi-transcript-content').textContent.includes('单独检查。'));
            assert.deepEqual(errors, []); assert.deepEqual(writes, []); assert.deepEqual(unsafeRequests, []);
            console.log(`Markdown compatibility ${width}: passed`); await context.close();
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
