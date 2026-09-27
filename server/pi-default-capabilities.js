// Compatibility export for existing settings integrations. All entries are now
// release-owned; nothing in this catalog installs into the shared Pi identity.
const { catalog, packagePath } = require('./pi-bundled-capabilities');
module.exports = Object.freeze(catalog.map(entry => Object.freeze({ ...entry,
    source: packagePath(entry), compatibleVersions: Object.freeze([entry.version]), managedBy: 'pivane' })));
