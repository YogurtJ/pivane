// Executed only in a fresh, credential-free identity by the maintenance launcher.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let gateway;
const cleanup = async () => { try { await gateway?.dispose(); } finally { await require('./pi-rpc-client').shutdownRpcProcesses(); } };
require('./pi-process-shutdown').registerProcessShutdown(cleanup);
(async () => {
    const directory = process.env.PI_UPDATE_PROBE;
    assert.ok(directory && path.isAbsolute(directory) && process.env.PI_CODING_AGENT_DIR === path.join(directory, 'agent'));
    fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true, mode: 0o700 });
    const sdk = await import('@earendil-works/pi-coding-agent');
    const ai = await import('@earendil-works/pi-ai');
    assert.equal(typeof sdk.ModelRuntime.create, 'function');
    assert.equal(typeof sdk.SettingsManager.create, 'function');
    assert.equal(typeof ai.getSupportedThinkingLevels, 'function');
    const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false });
    assert.ok(Array.isArray(await runtime.getAvailable()));
    const legacy = path.join(directory, 'legacy.jsonl');
    fs.copyFileSync(path.join(__dirname, '../test/fixtures/pi-0843-session.jsonl'), legacy);
    assert.ok(sdk.SessionManager.open(legacy).getEntries().length);
    const { createPiAgentGateway } = require('./pi-agent-routes');
    gateway = createPiAgentGateway();
    try {
        const session = await gateway.store.createSession(directory, 'Update compatibility probe');
        const worker = await gateway.supervisor.getWorker({ cwd: directory, sessionId: session.id, sessionPath: session.path });
        const state = await worker.request('get_state');
        assert.equal(state.sessionId, session.id);
        const messages = await worker.request('get_messages');
        assert.ok(Array.isArray(messages.messages));
        assert.ok(Array.isArray((await worker.request('get_commands')).commands));
        await worker.request('set_session_name', { name: 'Update compatibility passed' });
        assert.equal(sdk.SessionManager.open(session.path).getSessionName(), 'Update compatibility passed');
    } finally { await cleanup(); }
})().then(() => process.exit(0), () => { console.error('Isolated Pi SDK/RPC compatibility probe failed'); process.exit(1); });
