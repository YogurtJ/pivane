// Legacy entrypoint retained for callers; built-ins belong to the release.
const { identify } = require('./pi-bundled-resources');
function packageIdentity(item, name) {
    return identify(item.source, process.cwd())?.name === name || (item.installedPath && identify(item.installedPath, process.cwd())?.name === name);
}
async function installDefaults() { require('../scripts/install-bundled-capabilities.cjs').install(); }
module.exports = { installDefaults, packageIdentity };
