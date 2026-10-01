const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const nested = require('../public/pi-nested-tools');
const policy = require('../public/pi-file-policy');
const call = (id, name = 'write', status = 'ok', args = { path: 'safe.txt', content: 'saved' }) => ({ id, name, status, arguments: args });
test('native hierarchy accepts only unique start-ordered descendants and bounded depth/count', () => {
    const record = { complete: true, calls: [call('p/1'), call('p/1/1'), call('alien/1'), call('p/2/1'), call('p/3'), call('p/3'), call('p/0')] };
    assert.deepEqual(nested.records('p', record).calls.map(c => c.id), ['p/1', 'p/1/1']);
    assert.equal(nested.records('p', record).complete, false);
    assert.equal(nested.records('p', { complete: true, calls: Array.from({ length: 300 }, (_, i) => call(`p/${i + 1}`)) }).calls.length, 256);
});
test('imported native records enforce per-call and total argument budgets before file attribution', () => {
    const oversized = { complete: true, calls: [call('p/1', 'write', 'ok', { path: 'safe.txt', content: 'x'.repeat(9000) })] };
    assert.equal(nested.records('p', oversized).complete, false);
    assert.equal(nested.records('p', oversized).calls[0].arguments, undefined);
    assert.equal(nested.mutations('p', oversized, policy).length, 0);
    const cumulative = { complete: true, calls: Array.from({ length: 6 }, (_, i) => call(`p/${i + 1}`, 'write', 'ok', { path: 'safe.txt', content: 'x'.repeat(7000) })) };
    assert.equal(nested.records('p', cumulative).complete, false);
    assert.equal(nested.mutations('p', cumulative, policy).length, 4);
});

test('mutation proof excludes failures unfinished restricted missing and oversized paths/content', () => {
    const record = { complete: false, calls: [call('p/1'), call('p/2', 'edit'), call('p/3', 'write', 'error'), call('p/4', 'write', 'unfinished'),
        call('p/5', 'write', 'ok', { path: '.env', content: 'secret' }), call('p/6', 'write', 'ok', { path: 'x'.repeat(4097), content: '' }),
        call('p/7', 'write', 'ok', { path: 'file.txt' }), call('p/8', 'write', 'ok', { path: 'file.txt', content: 'x'.repeat(policy.maxBytes + 1) })] };
    assert.deepEqual(nested.mutations('p', record, policy).map(c => c.id), ['p/1', 'p/2']);
});
function collect(messages) {
    const window = { PiFilePolicy: policy, PiNestedTools: nested, PiToolDiff: { describe: () => null } };
    vm.runInNewContext(fs.readFileSync('public/pi-turn-edits.js', 'utf8'), { window, TextEncoder });
    return window.PiTurnEdits.collect(messages, false);
}
const messages = record => [{ role: 'user', content: 'fixture', timestamp: 1 }, { role: 'assistant', content: [{ type: 'toolCall', id: 'p', name: 'codemode' }] },
    { role: 'toolResult', toolCallId: 'p', toolName: 'codemode', isError: true, nestedCalls: record }];
test('file ownership comes from parent native result even if script fails; no synthetic edit diff', () => {
    const result = collect(messages({ complete: true, calls: [call('p/1'), call('p/2', 'edit')] }));
    assert.equal(result.length, 1);
    assert.equal(result[0].files[0].writes[0].owner, 'codemode → write');
    assert.equal(result[0].files[0].edits[0].result, null);
    assert.equal(collect(messages({ complete: false, calls: [call('p/1', 'write', 'unfinished')] })).length, 0);
});
test('orphan results, repeated parent calls/results and colliding top-level ids never claim nested mutations', () => {
    const source = messages({ complete: true, calls: [call('p/1')] });
    assert.equal(collect(source.slice(2)).length, 0);
    assert.equal(collect([...source, structuredClone(source[2])]).length, 1, 'identical authoritative replay does not duplicate or discard success');
    assert.equal(collect([...source, { ...source[2], isError: false }]).length, 0, 'conflicting result identities fail closed');
    assert.equal(collect([source[0], source[1], source[1], source[2]]).length, 0);
    assert.equal(collect([source[0], { ...source[1], content: [...source[1].content, { type: 'toolCall', id: 'p/1', name: 'read' }] }, source[2]]).length, 0);
});
