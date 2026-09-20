const test = require('node:test');
const assert = require('node:assert/strict');
const { registerToolProvenance } = require('../server/pi-tool-provenance');
test('call-time provenance is bounded, invocation-bound and leaves foreign result shapes intact', () => {
    const old = process.env.PI_WEB_NAVIGATION_TOKEN; process.env.PI_WEB_NAVIGATION_TOKEN = 'fixture';
    try {
        const handlers = {};
        let source = { source: 'npm:fixture@1', path: '/fixture/index.ts', origin: 'package', scope: 'user' };
        const pi = { on: (name, fn) => handlers[name] = fn, getAllTools: () => [
            { name: 'fixture', sourceInfo: source }, { name: 'read', sourceInfo: { source: 'builtin' } }
        ] };
        registerToolProvenance(pi);
        const path = require('node:path'), cwd = path.resolve('fixture-project');
        const ctx = { mode: 'rpc', cwd };
        handlers.before_agent_start({ systemPromptOptions: { skills: [{ name: 'slides', filePath: path.join(cwd, 'skills/slides/SKILL.md') }] } });
        const call = { toolName: 'fixture', toolCallId: 'first', input: {} };
        handlers.tool_call(call, ctx); source = { ...source, source: 'npm:new-owner' };
        const patched = handlers.tool_result({ ...call, details: { original: true } });
        assert.equal(patched.details.original, true);
        assert.equal(patched.details.pi5ToolProvenance.source.source, 'npm:fixture@1');
        assert.deepEqual(Object.keys(patched), ['details']);
        assert.equal(handlers.tool_result(call), undefined, 'consumed once');
        const read = { toolName: 'read', toolCallId: 'read', input: { path: 'skills/slides/SKILL.md' } };
        handlers.tool_call(read, ctx);
        assert.equal(handlers.tool_result(read).details.pi5ToolProvenance.skill.name, 'slides');
        handlers.tool_call(read, ctx);
        assert.equal(handlers.tool_result({ ...read, input: { path: 'unrelated/SKILL.md' } }), undefined, 'later argument changes cannot inherit a skill label');
        for (const details of [[], 'text', 42, { pi5ToolProvenance: { foreign: true } }]) {
            handlers.tool_call(call, ctx); assert.equal(handlers.tool_result({ ...call, details }), undefined);
        }
        handlers.tool_call(call, ctx); assert.equal(handlers.tool_result({ ...call, toolName: 'other' }), undefined);
        handlers.tool_call(call, ctx); handlers.session_start(); assert.equal(handlers.tool_result(call), undefined);
        pi.getAllTools = () => { throw new Error('Synthetic metadata failure'); };
        assert.equal(handlers.tool_call(call, ctx), undefined, 'annotation cannot block execution');
    } finally { if (old === undefined) delete process.env.PI_WEB_NAVIGATION_TOKEN; else process.env.PI_WEB_NAVIGATION_TOKEN = old; }
});
