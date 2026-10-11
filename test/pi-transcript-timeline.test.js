const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');

const context = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/pi-transcript-timeline.js'), 'utf8'), context, { filename: 'public/pi-transcript-timeline.js' });
// Normalize objects from the VM realm before comparing their public values.
const excerpt = (...args) => JSON.parse(JSON.stringify(context.window.PiTranscriptTimeline.excerpt(...args)));

test('timeline excerpt joins soft wraps, paragraphs, headings and list items', () => {
    assert.deepEqual(excerpt('Latin soft\nwrap joins.\n\n中文软换行\n连续正文。\n\n## Heading ##\n\n- First item\n1. Second item'), {
        items: [
            { type: 'p', text: 'Latin soft wrap joins.' },
            { type: 'p', text: '中文软换行连续正文。' },
            { type: 'p', text: 'Heading' },
            { type: 'li', text: 'First item' },
            { type: 'li', text: 'Second item' }
        ], skipped: false
    });
});

test('timeline excerpt strips inline formatting and HTML tags to plain text', () => {
    assert.deepEqual(excerpt('**Bold** __strong__ *italic* [link text](https://example.test) `inline code` <b>HTML text</b>.'), {
        items: [{ type: 'p', text: 'Bold strong italic link text inline code HTML text.' }], skipped: false
    });
});

test('timeline excerpt skips fenced code including four-space fences inside a list', () => {
    const markdown = 'Before.\n\n```js\nTOP_LEVEL_CODE\n```\n\n- Item before code\n\n    ```js\n    INDENTED_LIST_CODE\n    ```\n\n- Item after code\n\n~~~txt\nTILDE_CODE\n~~~\n\nAfter.';
    assert.deepEqual(excerpt(markdown), {
        items: [{ type: 'p', text: 'Before.' }, { type: 'li', text: 'Item before code' }, { type: 'li', text: 'Item after code' }, { type: 'p', text: 'After.' }], skipped: true
    });
});

test('timeline excerpt omits GFM tables and their headers with or without outer pipes', () => {
    for (const table of [
        '| Header A | Header B |\n| --- | :---: |\n| Cell A | Cell B |',
        'Header A | Header B\n--- | :---:\nCell A | Cell B'
    ]) assert.deepEqual(excerpt(`Before.\n\n${table}\n\nAfter.`), {
        items: [{ type: 'p', text: 'Before.' }, { type: 'p', text: 'After.' }], skipped: true
    });
});

test('timeline excerpt clips every item to the remaining output budget', () => {
    const limit = 24;
    for (const source of ['x'.repeat(100), '- ' + 'x'.repeat(100), '## ' + 'x'.repeat(100)]) {
        const result = excerpt(source, limit);
        assert.deepEqual(result.items, [{ type: source.startsWith('- ') ? 'li' : 'p', text: 'x'.repeat(limit) + '…' }]);
        assert.ok(result.items.reduce((length, item) => length + item.text.length, 0) <= limit + 1);
    }
    assert.deepEqual(excerpt('First.\n\n- ' + 'x'.repeat(100) + '\n\nExcluded.', limit), {
        items: [{ type: 'p', text: 'First.' }, { type: 'li', text: 'x'.repeat(limit - 6) + '…' }], skipped: false
    });
    assert.deepEqual(excerpt('No output', 0), { items: [], skipped: false });
});

test('timeline excerpt bounds a million-character paragraph within 200 ms', () => {
    const input = 'x'.repeat(1000000), limit = 420;
    const start = performance.now(), result = excerpt(input, limit), duration = performance.now() - start;
    assert.ok(duration < 200, `excerpt took ${duration.toFixed(1)} ms`);
    assert.deepEqual(result.items, [{ type: 'p', text: 'x'.repeat(limit) + '…' }]);
    assert.ok(result.items.reduce((length, item) => length + item.text.length, 0) <= limit + 1);
});
