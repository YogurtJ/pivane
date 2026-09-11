const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = ['server.js'];
for (const [directory, extensions] of [['server', ['.js', '.mjs']], ['public', ['.js']], ['scripts', ['.cjs']]]) {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isFile() && extensions.includes(path.extname(entry.name))) files.push(path.join(directory, entry.name));
    }
}
for (const filename of files) {
    const result = spawnSync(process.execPath, ['--check', path.join(root, filename)], { stdio: 'inherit' });
    if (result.error) { console.error(result.error.message); process.exit(1); }
    if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax checked ${files.length} files`);
