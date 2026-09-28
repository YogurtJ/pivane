// Synthetic Pi RPC process for startup and liveness tests. It never contacts a
// model. FIXTURE_START_DELAY_MS delays attaching stdin, FIXTURE_EXIT_AFTER_MS
// exits during startup, and control commands freeze the command loop while the
// process stays alive.
const fs = require('node:fs');
const args = process.argv.slice(2);
const at = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const sessionFile = at('--session');
const extension = args.find((value, index) => args[index - 1] === '-e' && value.endsWith('pi-web-session-extension.ts'));
const sessionId = sessionFile ? JSON.parse(fs.readFileSync(sessionFile, 'utf8').split('\n')[0]).id : 'ephemeral-fixture';
if (process.env.FIXTURE_LOG) fs.appendFileSync(process.env.FIXTURE_LOG, `${process.pid}\n`);
if (process.env.FIXTURE_EXIT_AFTER_MS) setTimeout(() => process.exit(3), Number(process.env.FIXTURE_EXIT_AFTER_MS));
let frozen = false, replyDelay = 0;
const send = record => process.stdout.write(`${JSON.stringify(record)}\n`);
function handle(message) {
    if (frozen) return;
    const reply = data => send({ type: 'response', id: message.id, command: message.type, success: true, data });
    if (message.type === 'fixture_freeze') { frozen = true; return; }
    if (message.type === 'fixture_busy_freeze') { send({ type: 'agent_start' }); frozen = true; return; }
    if (message.type === 'fixture_delay') { replyDelay = message.ms; reply({}); return; }
    if (message.type === 'get_commands') {
        reply({ commands: extension ? [{ name: 'pivane-web-navigate', source: 'extension', path: extension, description: 'managed-v1 fixture' }] : [] });
        return;
    }
    if (message.type === 'get_state') {
        const state = { sessionFile, sessionId, isStreaming: false, isCompacting: false, pendingMessageCount: 0, messageCount: 0 };
        if (replyDelay) setTimeout(() => reply(state), replyDelay); else reply(state);
        return;
    }
    reply({});
}
function attach() {
    let buffer = '';
    process.stdin.on('data', chunk => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
            if (line.trim()) handle(JSON.parse(line));
        }
    });
}
// Like a slow bootstrap, stdin is not read until loading has finished.
const delay = Number(process.env.FIXTURE_START_DELAY_MS || 0);
if (delay) setTimeout(attach, delay); else attach();
setInterval(() => {}, 1 << 30);
