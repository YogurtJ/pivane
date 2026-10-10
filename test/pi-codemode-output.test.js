const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

function nativeLayout(result) {
    const output = [...result.output];
    if (result.ok && result.value !== undefined) output.push({ type: 'text', text: typeof result.value === 'string' ? result.value : JSON.stringify(result.value) ?? String(result.value) });
    const total = output.filter(item => item.type === 'text' && !item.console).length;
    const items = [], consoleLines = [];
    let index = 0;
    for (const item of output) {
        if (item.type === 'image') items.push(item);
        else if (item.console) consoleLines.push(item.text);
        else { index++; items.push({ type: 'text', text: total > 1 ? `==> text ${index}/${total} <==\n${item.text}` : item.text }); }
    }
    if (consoleLines.length) items.push({ type: 'text', text: `<console_output>\n${consoleLines.join('\n')}\n</console_output>` });
    const joined = [];
    for (const item of items) {
        const last = joined.at(-1);
        if (item.type === 'text' && last?.type === 'text') joined[joined.length - 1] = { type: 'text', text: `${last.text}${last.text === '' || last.text.endsWith('\n') ? '' : '\n'}${item.text}` };
        else joined.push(item);
    }
    return joined;
}
const success = (output, value) => ({ ok: true, output, value, calls: [], storeWrites: { set: { preserved: true }, delete: [] } });

test('linear text output preserves native bytes, return placement and console grouping', async () => {
    const { compactCodemodeTextOutput } = await import('../server/pi-codemode-output.mjs');
    const values = [undefined, null, '', 'returned\n', false, 0, { nested: ['value', 1] }];
    for (const count of [256, 257, 1024]) for (const value of values) for (const mode of ['text', 'console', 'mixed']) {
        const output = Array.from({ length: count }, (_, i) => ({ type: 'text', text: ['', '\n', 'a', 'b\n', '双字😀', '\r', '\n\n'][i % 7], ...(mode === 'console' || mode === 'mixed' && i % 3 === 0 ? { console: true } : {}) }));
        const input = success(output, value), before = JSON.stringify(input), compact = compactCodemodeTextOutput(input);
        assert.deepEqual(nativeLayout(compact), nativeLayout(input), `${mode}/${count}/${JSON.stringify(value)}`);
        assert.equal(compact.calls, input.calls); assert.equal(compact.storeWrites, input.storeWrites);
        assert.equal(JSON.stringify(input), before, 'native result not mutated');
    }
});

test('small or mixed image output remains native, and failed result retains identity fields', async () => {
    const { compactCodemodeTextOutput } = await import('../server/pi-codemode-output.mjs');
    const small = success(Array.from({ length: 255 }, () => ({ type: 'text', text: '' })), 1);
    assert.equal(compactCodemodeTextOutput(small), small);
    const mixed = success([...Array.from({ length: 256 }, () => ({ type: 'text', text: '' })), { type: 'image', data: 'fixture', mimeType: 'image/png' }]);
    assert.equal(compactCodemodeTextOutput(mixed), mixed);
    for (const kind of ['script', 'aborted', 'timeout', 'sandbox']) {
        const failed = { ok: false, output: Array.from({ length: 256 }, (_, i) => ({ type: 'text', text: String(i), ...(i % 2 ? { console: true } : {}) })), calls: [{ name: 'fixture', status: 'ok', durationMs: 1 }], error: { kind, message: 'preserved' } };
        const compact = compactCodemodeTextOutput(failed);
        assert.equal(compact.error, failed.error); assert.equal(compact.calls, failed.calls); assert.equal(compact.ok, false);
        assert.equal(Object.hasOwn(compact, 'storeWrites'), false); assert.deepEqual(nativeLayout(compact), nativeLayout(failed));
    }
});

test('exact output import seam rejects unknown versions, changed executor bytes and wrong resolution', async () => {
    const { verifyCodemodeOutputHost } = await import('../server/pi-codemode-output-loader.mjs');
    const hostRoot = path.join(root, 'node_modules/@earendil-works/pi-coding-agent');
    const host = JSON.parse(fs.readFileSync(hostRoot + '/package.json'));
    const sandbox = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@earendil-works/pi-codemode/package.json')));
    const source = fs.readFileSync(hostRoot + '/dist/extensions/codemode/execute.js');
    const resolved = pathToFileURL(path.join(root, 'node_modules/@earendil-works/pi-codemode/dist/index.js')).href;
    verifyCodemodeOutputHost(host, sandbox, source, resolved);
    for (const args of [[{ ...host, version: '1.1.1' }, sandbox, source, resolved], [host, { ...sandbox, version: '1.0.2' }, source, resolved], [host, sandbox, Buffer.concat([source, Buffer.from(' ')]), resolved], [host, sandbox, source, resolved + '?unexpected=1']]) {
        assert.throws(() => verifyCodemodeOutputHost(...args), /Unreviewed Pi Codemode output host/);
    }
});

test('only exact SDK executor sandbox import is adapted; public sandbox and tool schema stay native', () => {
    // CommonJS eval uses dynamic imports: no --input-type flag reaches native workers.
    const code = `(async()=>{ await import('./server/pi-codemode-output-loader.mjs');
        const upstream=await import('@earendil-works/pi-codemode');
        const adapted=await import('./server/pi-codemode-output.mjs');
        if(upstream.CodemodeSandbox===adapted.CodemodeSandbox)throw Error('Public import intercepted');
        const sdk=await import('@earendil-works/pi-coding-agent');
        const piRoot=process.cwd()+'/node_modules/@earendil-works/pi-coding-agent/';
        const official=await import((await import('node:url')).pathToFileURL(piRoot+'dist/extensions/codemode/tool.js').href);
        const extension=sdk.createCodemodeExtension({models:false});let tool;extension({registerTool:t=>tool=t,getSettings:()=>({}),getAllTools:()=>[tool],appendEntry:()=>{}});
        if(!official.isCodemodeTool(tool))throw Error('Schema identity lost');
        const result=await tool.execute('formatter-fixture',{code:'for(let i=0;i<300;i++)text(i);console.log("console-tail");return "end";'});
        const text=result.content.filter(i=>i.type==='text').map(i=>i.text).join('');
        if(result.isError||!text.includes('==> text 301/301 <==')||!text.includes('<console_output>\\nconsole-tail\\n</console_output>'))throw Error(text);
        console.log(JSON.stringify({nativePublicImport:true,nativeSchema:true,adaptedExecution:true}));
        })().catch(error=>{console.error(error);process.exitCode=1;});`;
    const child = spawnSync(process.execPath, ['-e', code], { cwd: root, encoding: 'utf8', timeout: 30000 });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.equal(JSON.parse(child.stdout.trim()).adaptedExecution, true);
});
