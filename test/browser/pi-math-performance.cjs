const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');

(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto('about:blank');
        for (const file of ['node_modules/marked/lib/marked.umd.js', 'node_modules/dompurify/dist/purify.min.js', 'public/vendor/katex-0.18.7/katex.min.js', 'public/pi-math.js', 'public/pi-file-viewer.js']) {
            await page.addScriptTag({ content: fs.readFileSync(path.join(root, file), 'utf8') });
        }
        const scans = await page.evaluate(() => {
            const result = [], startsWith = String.prototype.startsWith;
            // Count actual delimiter probes, independent of elapsed time and the
            // scanner's loop spelling. Every ordinary character receives these
            // probes, so a scan of repeated document suffixes is observable.
            for (const kind of ['paragraph', 'list text', 'setext']) {
                for (const count of [100, 1000, 3000]) {
                    const row = 'x'.repeat(198);
                    const source = kind === 'paragraph' ? (row + '\n\n').repeat(count)
                        : kind === 'list text' ? '- ' + (row + '\n').repeat(count) : (row + '\n====\n\n').repeat(count);
                    let probes = 0, html;
                    String.prototype.startsWith = function(search, position) {
                        if (search === '\\(' || search === '\\[') probes++;
                        return startsWith.call(this, search, position);
                    };
                    try { html = PiFileViewer.markdown(source); }
                    finally { String.prototype.startsWith = startsWith; }
                    const expected = DOMPurify.sanitize(new marked.Marked({ renderer: new marked.Renderer() }).parse(source));
                    result.push({ kind, count, chars: source.length, probes, sameHTML: html === expected });
                }
            }
            return result;
        });
        for (const sample of scans) {
            assert.equal(sample.sameHTML, true, JSON.stringify(sample));
            assert.ok(sample.probes > sample.chars, `missing scan evidence: ${JSON.stringify(sample)}`);
            assert.ok(sample.probes <= 4 * sample.chars, `scan work exceeds linear budget: ${JSON.stringify(sample)}`);
        }
        console.log('Math scan work:', JSON.stringify(scans));
        const timings = await page.evaluate(() => {
            const adapter = PiMath, results = [], median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
            const run = (source, enabled) => {
                window.PiMath = enabled ? adapter : undefined;
                const start = performance.now(), html = PiFileViewer.markdown(source);
                return { ms: performance.now() - start, html };
            };
            try {
                for (let i = 0; i < 3; i++) { run('warm up\n\n'.repeat(20), true); run('warm up\n\n'.repeat(20), false); }
                for (const count of [100, 1000, 3000]) {
                    const source = ('x'.repeat(198) + '\n\n').repeat(count), math = [], plain = [];
                    let sameHTML = true;
                    for (let i = 0; i < 5; i++) {
                        const a = run(source, true), b = run(source, false);
                        math.push(a.ms); plain.push(b.ms); sameHTML &&= a.html === b.html;
                    }
                    results.push({ count, chars: source.length, mathMs: median(math), plainMs: median(plain), sameHTML });
                }
            } finally { window.PiMath = adapter; }
            return results;
        });
        for (const sample of timings) assert.equal(sample.sameHTML, true);
        console.log('Math timing (informational):', JSON.stringify(timings));
        const reuse = await page.evaluate(() => {
            const original = katex.renderToString;
            let calls = 0;
            katex.renderToString = (...args) => { calls++; return original(...args); };
            const source = Array.from({ length: 160 }, (_, i) => `$x_{160_${i}}$`).join(' ');
            const render = text => {
                calls = 0;
                const start = performance.now(), node = document.createElement('template');
                node.innerHTML = PiFileViewer.markdown(text);
                return { calls, ms: performance.now() - start, formulas: node.content.querySelectorAll('.katex').length, fallback: node.content.querySelectorAll('.pi-math-fallback').length };
            };
            try { return { cold: render(source), warm: render(source + ' trailing prose'), again: render(source + ' more prose') }; }
            finally { katex.renderToString = original; }
        });
        assert.equal(reuse.cold.calls, 160);
        for (const result of [reuse.warm, reuse.again]) { assert.equal(result.calls, 0); assert.equal(result.formulas, 160); assert.equal(result.fallback, 0); }
        console.log('Math cache reuse:', JSON.stringify(reuse));
        const eviction = await page.evaluate(() => {
            const original = katex.renderToString;
            let calls = 0;
            // Small output isolates entry-count eviction; large sanitized output
            // isolates byte eviction below the entry-count limit.
            katex.renderToString = text => { calls++; return `<span>${text.startsWith('large') ? 'x'.repeat(240000) : text}</span>`; };
            const render = text => PiFileViewer.markdown(`$${text}$`);
            const count = text => { calls = 0; render(text); return calls; };
            try {
                for (let i = 0; i < 256; i++) render(`small_{${i}}`);
                const oldestWarm = count('small_{0}');
                render('small_{256}');
                const refreshedWarm = count('small_{0}'), oldestEvicted = count('small_{1}');
                for (let i = 0; i < 5; i++) render(`large_{${i}}`);
                const newestLargeWarm = count('large_{4}'), oldestLargeEvicted = count('large_{0}');
                return { oldestWarm, refreshedWarm, oldestEvicted, newestLargeWarm, oldestLargeEvicted };
            } finally { katex.renderToString = original; }
        });
        assert.deepEqual(eviction, { oldestWarm: 0, refreshedWarm: 0, oldestEvicted: 1, newestLargeWarm: 0, oldestLargeEvicted: 1 });
        assert.deepEqual(errors, []);
        if (process.env.PIVANE_TEST_SCREENSHOT_DIR) {
            fs.mkdirSync(process.env.PIVANE_TEST_SCREENSHOT_DIR, { recursive: true });
            fs.writeFileSync(path.join(process.env.PIVANE_TEST_SCREENSHOT_DIR, 'math-performance.json'), JSON.stringify({ root, browser: browser.version(), scans, timings, reuse, eviction }, null, 2));
        }
        console.log(`Math performance: passed; Chromium ${browser.version()}; root ${root}`);
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
