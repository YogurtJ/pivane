const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.setContent('<div id="scroller" style="height:600px;overflow:auto"><div id="archive"></div><div id="content"></div></div><div id="host"></div>');
        for (const file of ['pi-transcript-archive.js', 'pi-transcript-timeline.js']) await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public', file), 'utf8') });
        const results = await page.evaluate(async () => {
            const scroller = document.getElementById('scroller'), content = document.getElementById('content'), container = document.getElementById('archive');
            const context = () => ({ key: 'fixture', generation: 1, connected: false, session: null });
            const archive = PiTranscriptArchive.create({ scroller, content, container, context });
            const timeline = PiTranscriptTimeline.create({ host: document.getElementById('host'), scroller, content, archive, context, anchors: () => new Map() });
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            container.hidden = false;
            const gap = document.createElement('div'); gap.className = 'pi-archive-gap'; gap.dataset.start = '0'; gap.dataset.end = '5000'; container.append(gap);
            let queries = 0, offsets = 0;
            const query = container.querySelectorAll.bind(container);
            container.querySelectorAll = selector => { if (selector.includes('pi-archive-gap')) queries++; return query(selector); };
            Object.defineProperty(gap, 'offsetTop', { configurable: true, get() { offsets++; return 100; } });
            timeline.turns = Array.from({ length: 5000 }, (_, index) => {
                const tick = document.createElement('button'); tick.dataset.index = index; timeline.rail.append(tick);
                return { archive: { index }, tick };
            });
            timeline.nav.hidden = false;
            timeline.updateView();
            const first = { queries, offsets, turns: timeline.turns.length };
            timeline.lens(10); timeline.lens(3000);
            if (timeline.rail.querySelectorAll('.is-hovered').length !== 1 || !timeline.turns[3000].tick.classList.contains('is-hovered')) throw Error('hover moved incorrectly');
            timeline.lens(-1);
            if (timeline.rail.querySelector('.is-hovered')) throw Error('hover failed to clear');
            gap.remove();
            const left = document.createElement('div'), right = document.createElement('div');
            for (const node of [left, right]) node.className = 'pi-archive-gap';
            left.dataset.start = '0'; left.dataset.end = '10'; right.dataset.start = '20'; right.dataset.end = '5000';
            container.append(left, right);
            const lookup = archive.placeholderLookup();
            if (lookup(0) !== left || lookup(9) !== left || lookup(10) !== null || lookup(19) !== null || lookup(20) !== right || lookup(4999) !== right || lookup(5000) !== null) throw Error('gap boundaries or refresh are stale');
            timeline.nav.hidden = true; queries = 0; timeline.updateView();
            if (queries) throw Error('hidden outline queried gaps');
            archive.reset();
            if (archive.placeholderLookup()(1) !== null) throw Error('reset retained gaps');
            return first;
        });
        assert.equal(results.queries, 1, 'one gap query per outline pass');
        assert.equal(results.offsets, 1, 'questions sharing a gap measure its position once');
        assert.deepEqual(errors, []);
        console.log(JSON.stringify(results));
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
