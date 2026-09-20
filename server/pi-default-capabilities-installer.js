const fs = require('node:fs');
const path = require('node:path');
const catalog = require('./pi-default-capabilities');
const { safeFile, read, json, atomic } = require('./pi-native-service');

function packageIdentity(item, name) {
    if (item.source === `npm:${name}` || item.source.startsWith(`npm:${name}@`)) return true;
    // Preserve known alternate sources even when their checkout is currently missing.
    if (name === 'pi-subagents' && /github\.com[/:]nicobailon\/pi-subagents(?:\.git)?(?:@[^\s]+)?\/?$/.test(item.source)) return true;
    if (!item.installedPath) return false;
    try { return json(read(safeFile(item.installedPath, ['package.json']))).name === name; } catch { return false; }
}

async function installDefaults({ agentDir, manager, skip = false, log = console.log }) {
    const file = safeFile(agentDir, ['pivane-default-capabilities.json'], true);
    const lock = file + '.lock';
    try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { return; }
    try {
        const state = json(read(file));
        for (const entry of catalog) {
            // Once attempted, even an interrupted/failed install must be explicitly retried.
            // This also respects later uninstall and prevents upgrades from replacing a user's choice.
            if (Object.hasOwn(state, entry.id)) continue;
            const existing = manager.listConfiguredPackages().some(item => packageIdentity(item, entry.name));
            state[entry.id] = { version: entry.version, status: existing ? 'existing' : skip ? 'skipped' : 'attempted' };
            atomic(file, JSON.stringify(state, null, 2) + '\n');
            if (existing || skip) continue;
            try {
                await manager.installAndPersist(entry.source, { local: false });
                state[entry.id].status = 'installed';
                log(`[Pivane] ${entry.name} ${entry.version} installed.`);
            } catch {
                state[entry.id].status = 'failed';
                log(`[Pivane] Optional ${entry.name} could not be installed. Pivane remains usable; retry in Settings > Models & capabilities.`);
            }
            atomic(file, JSON.stringify(state, null, 2) + '\n');
        }
    } finally { fs.rmdirSync(lock); }
}
module.exports = { installDefaults, packageIdentity };
