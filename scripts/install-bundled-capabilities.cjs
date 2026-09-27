#!/usr/bin/env node
'use strict';
// Installation is local to this release. It never writes the user's Pi settings.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const { vendorFiles } = require('./vendor-files.cjs');
const { catalog, packagePath, memoryBundle } = require('../server/pi-bundled-capabilities');
const imports = [
    ['DatabaseManager', 'store/db'], ['MemoryStore', 'store/memory-store'], ['SkillStore', 'store/skill-store'],
    ['parseSessionManagerSnapshot', 'store/session-indexer'], ['indexSession', 'store/session-indexer'],
    ['upsertSessionFileMetadata', 'store/session-indexer'], ['searchSessions', 'store/session-search'],
    ['searchMemories', 'store/sqlite-memory-store'], ['registerMemoryTool', 'tools/memory-tool'],
    ['registerMemorySearchTool', 'tools/memory-search-tool'], ['registerSessionSearchTool', 'tools/session-search-tool'],
    ['registerSkillTool', 'tools/skill-tool'],
];
function install() {
    vendorFiles(root);
    for (const entry of catalog) {
        const metadata = JSON.parse(fs.readFileSync(path.join(packagePath(entry), 'package.json'), 'utf8'));
        if (metadata.name !== entry.name || metadata.version !== entry.version) throw new Error('Bundled integration catalog differs from upstream');
    }
    const source = packagePath(catalog.find(entry => entry.id === 'memory'));
    const result = require('esbuild').buildSync({
        stdin: { contents: imports.map(([name, file]) => `export { ${name} } from './src/${file}.ts';`).join('\n'),
            resolveDir: source, sourcefile: 'profile-memory-entry.ts', loader: 'ts' },
        bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node22',
        minifyWhitespace: true, legalComments: 'none', write: false,
    });
    const bytes = result.outputFiles[0].contents;
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== require('../server/profile-memory/management').BUNDLE_SHA256) throw new Error(`Memory build differs from reviewed bundle: ${digest}`);
    const Database = require('better-sqlite3'), db = new Database(':memory:');
    try { db.exec('CREATE VIRTUAL TABLE verify_fts USING fts5(content, tokenize=trigram)'); } finally { db.close(); }
    const target = memoryBundle(), tmp = `${target}.${process.pid}.tmp`;
    try { fs.writeFileSync(tmp, bytes); fs.renameSync(tmp, target); } finally { fs.rmSync(tmp, { force: true }); }
    console.log('[Pivane] Bundled ' + catalog.map(entry => `${entry.name} ${entry.version}`).join(', ') + ' ready.');
}
if (require.main === module) { try { install(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { install };
