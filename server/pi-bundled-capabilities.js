// Pivane-owned integration catalog; vendor manifests and source remain upstream originals.
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const catalog = Object.freeze([
    Object.freeze({ id: 'subagents', name: 'pi-subagents', version: '0.74.0', directory: 'vendor/pi-subagents',
        repository: 'nicobailon/pi-subagents', mode: 'package' }),
    Object.freeze({ id: 'memory', name: 'pi-hermes-memory', version: '0.9.9', directory: 'vendor/pi-hermes-memory',
        repository: 'chandra447/pi-hermes-memory', mode: 'adapter' })
]);
const packagePath = entry => path.join(root, entry.directory);
const memoryBundle = () => path.join(root, 'server/profile-memory/upstream-bundle.mjs');
module.exports = { catalog, packagePath, memoryBundle };
