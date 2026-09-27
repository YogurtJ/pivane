'use strict';
// Keep dependency lifecycle selection consistent with managed application updates.
// SQLite 13 ships its native bindings; npm's lockfile lifecycle inference can
// otherwise invoke node-gyp even when that package declares gypfile:false.
const path = require('node:path');
const { npmCli, runNode, prepareBundled } = require('../server/pi-update-installer');
async function main() {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--omit=dev')) throw new Error('Usage: node scripts/install.cjs [--omit=dev]');
    const directory = path.resolve(__dirname, '..');
    const cli = npmCli();
    const env = { ...process.env, PI_NPM_CLI: cli };
    const onOutput = (stream, text) => (stream === 'stderr' ? process.stderr : process.stdout).write(text + '\n');
    await runNode([cli, 'ci', '--ignore-scripts', '--no-audit', '--no-fund', ...args], { cwd: directory, env, onOutput });
    await prepareBundled({ directory, env, onOutput });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
