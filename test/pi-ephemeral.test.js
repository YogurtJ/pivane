const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ephemeral-agent-'));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ephemeral-cwd-'));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { PiAgentSupervisor } = require('../server/pi-agent-supervisor');

test.after(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
});

test('ephemeral worker uses Pi no-session mode and writes no JSONL', async () => {
    const supervisor = new PiAgentSupervisor({ idleMs: 1000 });
    try {
        const worker = await supervisor.createEphemeralWorker(cwd);
        const state = await worker.request('get_state');
        assert.equal(state.sessionFile, undefined);
        assert.equal(worker.noSession, true);

        const sessionRoot = path.join(agentDir, 'sessions');
        const jsonlFiles = fs.existsSync(sessionRoot)
            ? fs.readdirSync(sessionRoot, { recursive: true }).filter(name => String(name).endsWith('.jsonl'))
            : [];
        assert.deepEqual(jsonlFiles, []);
        await worker.dispose();
    } finally {
        await supervisor.dispose();
    }
});
