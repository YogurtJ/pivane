#!/usr/bin/env node
// Compatibility with older installation instructions. No identity configuration
// or external Pi package installation is performed.
try { require('./install-bundled-capabilities.cjs').install(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
