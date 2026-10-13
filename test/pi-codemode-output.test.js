const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-codemode-output-')));
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_OFFLINE = '1';
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

async function tool() {
    const sdk = await import('@earendil-works/pi-coding-agent');
    assert.equal(sdk.VERSION, '1.2.0', 'isolated SDK metadata');
    let registered;
    sdk.createCodemodeExtension({ models: false })({
        registerTool: value => { registered = value; }, getSettings: () => ({}),
        getAllTools: () => [registered], appendEntry: () => {},
    });
    return registered;
}
// Independent byte oracle for the documented layout, including empty strings
// and console lines grouped after the returned value.
function expectedOutput(output, value) {
    const items = [...output];
    if (value !== undefined) items.push({ text: typeof value === 'string' ? value : JSON.stringify(value) });
    const total = items.filter(item => !item.console).length;
    const parts = [], consoleLines = [];
    let index = 0;
    for (const item of items) {
        if (item.console) consoleLines.push(item.text);
        else parts.push(total > 1 ? `==> text ${++index}/${total} <==\n${item.text}` : item.text);
    }
    if (consoleLines.length) parts.push(`<console_output>\n${consoleLines.join('\n')}\n</console_output>`);
    return parts.reduce((joined, part) => joined + (joined === '' || joined.endsWith('\n') ? '' : '\n') + part, '');
}
function output(result) {
    assert.match(result.content[0].text, /^Script completed\nWall time \d+\.\d seconds\nOutput:\n$/);
    return result.content.slice(1).map(item => item.text).join('');
}

test('official 1.2 output preserves text/empty/console/return ordering byte for byte', async () => {
    const native = await tool();
    const strings = ['', '\n', 'a', 'b\n', '双字😀', '\r', '\n\n'];
    for (const count of [0, 1, 7, 255, 256, 257, 1024]) {
        for (const mode of ['text', 'console', 'mixed']) {
            const values = [undefined, null, '', 'returned\n', false, 0, { nested: ['value', 1] }];
            for (const value of values) {
                const items = Array.from({ length: count }, (_, i) => ({ text: strings[i % strings.length], console: mode === 'console' || mode === 'mixed' && i % 3 === 0 }));
                const code = items.map(item => `${item.console ? 'console.log' : 'text'}(${JSON.stringify(item.text)});`).join('\n')
                    + (value === undefined ? '' : `\nreturn ${JSON.stringify(value)};`);
                const result = await native.execute('native-layout', { code: code || 'void 0;' });
                assert.equal(result.isError, undefined);
                assert.equal(output(result), expectedOutput(items, value), `${mode}/${count}/${JSON.stringify(value)}`);
            }
        }
    }
});

test('official mixed text and images retain item ordering and group console after the return', async () => {
    const native = await tool();
    const block = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC' };
    const result = await native.execute('mixed-output', { code: `text('start'); console.log('console-first'); image(${JSON.stringify(block)}); text(''); image(${JSON.stringify(block)}); text('after'); console.log('console-last'); return 'returned';` });
    assert.equal(result.isError, undefined);
    const files = [...result.content.filter(item => item.type === 'text').map(item => item.text).join('\n').matchAll(/\[Image saved to ([^\n]+?) \(image\/png,/g)].map(match => match[1]);
    try {
        assert.equal(files.length, 2);
        assert.equal(files[0], files[1]);
        assert.deepEqual(result.content.slice(1).map(item => item.type), ['text', 'image', 'text', 'image', 'text']);
        assert.deepEqual(result.content.filter(item => item.type === 'image'), [block, block]);
        assert.equal(result.content[1].text.replace(/\[Image saved to [^\n]+\]/g, 'IMAGE_PATH'), '==> text 1/4 <==\nstart\nIMAGE_PATH');
        assert.equal(result.content[3].text.replace(/\[Image saved to [^\n]+\]/g, 'IMAGE_PATH'), '==> text 2/4 <==\nIMAGE_PATH');
        assert.equal(result.content[5].text, '==> text 3/4 <==\nafter\n==> text 4/4 <==\nreturned\n<console_output>\nconsole-first\nconsole-last\n</console_output>');
        assert.deepEqual(fs.readFileSync(files[0]), Buffer.from(block.data, 'base64'));
    } finally { for (const file of new Set(files)) fs.rmSync(file, { force: true }); }
});

test('official 100001-item pressure settles within the original 60 seconds without replay or failed store', { timeout: 60000 }, async () => {
    const native = await tool();
    const { MAX_OUTPUT_ITEMS, MAX_OUTPUT_CHARS } = await import('@earendil-works/pi-codemode');
    assert.equal(MAX_OUTPUT_ITEMS, 100000);
    assert.equal(MAX_OUTPUT_CHARS, 16 * 1024 * 1024);
    const entries = [], calls = [];
    const sdk = await import('@earendil-works/pi-coding-agent');
    let registered;
    sdk.createCodemodeExtension({ models: false })({ registerTool: value => { registered = value; }, getSettings: () => ({}),
        getAllTools: () => [registered], appendEntry: (type, data) => entries.push({ type, data }) });
    const ctx = { tools: [{ name: 'once', description: 'Synthetic side effect', parameters: { type: 'object' } }],
        sessionManager: { getBranch: () => [] }, executeTool: async name => {
            calls.push(name); return { toolCall: { id: 'once' }, isError: false, result: { content: [{ type: 'text', text: 'accepted' }] } };
        } };
    const started = performance.now();
    const result = await registered.execute('native-pressure', { code: 'await tools.once({}); store("discard",true); for(let i=0;i<=100000;i++)text("");' }, undefined, undefined, ctx);
    assert.ok(performance.now() - started < 60000);
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /script output exceeded the limit/);
    assert.deepEqual(calls, ['once']);
    assert.deepEqual(entries, []);
    assert.deepEqual(result.details.calls.map(call => [call.name, call.status]), [['once', 'ok']]);
    const file = result.details.fullOutputPath;
    assert.ok(file, 'native pressure retains the complete partial output');
    try {
        const full = fs.readFileSync(file, 'utf8');
        assert.ok(full.startsWith('==> text 1/100000 <==\n'));
        assert.ok(full.includes('==> text 100000/100000 <==\n'));
        assert.match(full, /Script error:[\s\S]*script output exceeded the limit[\s\S]*once \(ok\)/);
        if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    } finally { fs.rmSync(file, { force: true }); }
    assert.equal((await native.execute('after-pressure', { code: 'return "still-usable";' })).isError, undefined);
});
