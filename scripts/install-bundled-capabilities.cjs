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
// Pi ships an npm-shrinkwrap that npm applies ahead of root overrides. Keep the
// reviewed fixed release from the root lockfile and remove only a known-vulnerable
// nested copy so Node resolves the hoisted package. Fail closed on anything else.
const SHRINKWRAP_FIXES = [{
    name: 'brace-expansion', owner: '@earendil-works/pi-coding-agent', consumer: 'minimatch', fixed: '5.0.12',
    vulnerable: version => /^4\.\d+\.\d+$/.test(version) || /^5\.0\.(\d|1[01])$/.test(version),
}];
function packageVersion(directory) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unexpected dependency layout: ${directory}`);
    return JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).version;
}
function dependencyCopies(modules, name, depth = 0, found = []) {
    if (depth > 12 || !fs.existsSync(modules)) return found;
    for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const dirs = entry.name.startsWith('@')
            ? fs.readdirSync(path.join(modules, entry.name), { withFileTypes: true }).filter(item => item.isDirectory()).map(item => path.join(modules, entry.name, item.name))
            : [path.join(modules, entry.name)];
        for (const dir of dirs) {
            if (path.relative(modules, dir) === name) found.push(dir);
            dependencyCopies(path.join(dir, 'node_modules'), name, depth + 1, found);
        }
    }
    return found;
}
function enforceShrinkwrapFixes(base = root, fixes = SHRINKWRAP_FIXES) {
    const manifest = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(base, 'package-lock.json'), 'utf8'));
    const modules = path.join(base, 'node_modules'), removed = [];
    for (const fix of fixes) {
        if (manifest.overrides?.[fix.name] !== fix.fixed || lock.packages?.[`node_modules/${fix.name}`]?.version !== fix.fixed
            || packageVersion(path.join(modules, fix.name)) !== fix.fixed) throw new Error(`Reviewed ${fix.name} ${fix.fixed} is not installed`);
        const nested = path.join(modules, fix.owner, 'node_modules', fix.name);
        if (fs.existsSync(nested)) {
            const version = packageVersion(nested);
            if (version !== fix.fixed) {
                if (!fix.vulnerable(version)) throw new Error(`Unexpected ${fix.name} ${version}; review the dependency fix`);
                fs.rmSync(nested, { recursive: true });
                removed.push(`${fix.name}@${version}`);
            }
        }
        for (const copy of dependencyCopies(modules, fix.name))
            if (fix.vulnerable(packageVersion(copy))) throw new Error(`Vulnerable ${fix.name} remains at ${path.relative(base, copy)}`);
        const consumer = path.join(modules, fix.owner, 'node_modules', fix.consumer);
        if (fs.existsSync(consumer)) {
            // Node's module lookup order, without require.resolve's process cache.
            let dir = consumer, version = null;
            while (!version) {
                const candidate = path.join(dir, 'node_modules', fix.name);
                if (fs.existsSync(candidate)) version = packageVersion(candidate);
                else if (dir === base || path.dirname(dir) === dir) break;
                else dir = path.dirname(dir);
            }
            if (version !== fix.fixed) throw new Error(`${fix.consumer} does not resolve ${fix.name} ${fix.fixed}`);
        }
    }
    return removed;
}
function install() {
    const removed = enforceShrinkwrapFixes();
    if (removed.length) console.log('[Pivane] Replaced shrinkwrapped ' + removed.join(', ') + ' with reviewed fixed release.');
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
module.exports = { install, enforceShrinkwrapFixes, SHRINKWRAP_FIXES };
