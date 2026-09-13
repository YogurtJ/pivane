const path = require('node:path');
const { ManagedLauncher } = require('./pi-managed-launcher');
function startManaged(root) {
    require('./pi-local-env').loadLocalEnv(path.join(root, '.env'));
    let launcher;
    require('./pi-process-shutdown').registerProcessShutdown(async () => { await launcher?.close(); });
    try {
        launcher = new ManagedLauncher({ root });
        launcher.start().catch(() => {
            console.error('Pivane managed startup failed. Check installation permissions and whether another process uses this installation.');
            void launcher.close().finally(() => process.exit(1));
        });
    } catch { console.error('Pivane maintenance state could not be opened; no update was attempted.'); process.exit(1); }
    return launcher;
}
function handoff(root) {
    if (process.argv.includes('--direct') || process.send && process.env.PI_MANAGED_LAUNCHER) return false;
    startManaged(root); return true;
}
module.exports = { startManaged, handoff };
