const { sourceFiles } = require('./source-files.cjs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = [...new Set(['server.js', ...['server', 'public', 'scripts', 'testSupport'].flatMap(group => sourceFiles(root, group))
    .filter(file => /\.(?:js|cjs|mjs|ts)$/.test(file)), 'pi-packages/media-workbench/extensions/media-tools.ts'])];
for (const filename of files) {
    const result = spawnSync(process.execPath, ['--check', path.join(root, filename)], { stdio: 'inherit' });
    if (result.error) { console.error(result.error.message); process.exit(1); }
    if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax checked ${files.length} files`);
