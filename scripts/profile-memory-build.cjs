#!/usr/bin/env node
'use strict';

// Build only the selected upstream components in an isolated prefix. Never patch npm's node_modules.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const SHA256 = '6a1b71dfa34f40bba6372a4f71dec54cce76be4ae55923d3b83ebfc1c5920c20';
const [tarball, prefix] = process.argv.slice(2);
if (!tarball || !prefix || !path.isAbsolute(tarball) || !path.isAbsolute(prefix)) {
    throw new Error('Usage: node scripts/profile-memory-build.cjs /absolute/pi-hermes-memory-0.9.9.tgz /absolute/isolated-prefix');
}
if (crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex') !== SHA256) throw new Error('Upstream tarball SHA256 mismatch');
if (fs.existsSync(prefix) && fs.readdirSync(prefix).length) throw new Error('Build prefix must be empty; retain existing data and choose a fresh prefix');
fs.mkdirSync(prefix, { recursive: true, mode: 0o700 });
execFileSync('tar', ['-xzf', tarball, '-C', prefix]);
const source = path.join(prefix, 'package');
const metadata = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
if (metadata.name !== 'pi-hermes-memory' || metadata.version !== '0.9.9' || metadata.license !== 'MIT') throw new Error('Unexpected package metadata');
const esbuild = require(process.env.PIVANE_PROFILE_MEMORY_ESBUILD || 'esbuild');
const imports = [
    ['DatabaseManager', 'store/db'], ['MemoryStore', 'store/memory-store'], ['SkillStore', 'store/skill-store'],
    ['parseSessionFile', 'store/session-parser'], ['indexSession', 'store/session-indexer'],
    ['upsertSessionFileMetadata', 'store/session-indexer'], ['searchSessions', 'store/session-search'],
    ['searchMemories', 'store/sqlite-memory-store'], ['registerMemoryTool', 'tools/memory-tool'],
    ['registerMemorySearchTool', 'tools/memory-search-tool'], ['registerSessionSearchTool', 'tools/session-search-tool'],
    ['registerSkillTool', 'tools/skill-tool'],
];
const entry = imports.map(([name, file]) => `export { ${name} } from './src/${file}.ts';`).join('\n');
esbuild.buildSync({
    stdin: { contents: entry, resolveDir: source, sourcefile: 'profile-memory-entry.ts', loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node22',
    minifyWhitespace: true, legalComments: 'none',
    outfile: path.join(source, 'profile-memory-bundle.mjs'),
});
const bundle = path.join(source, 'profile-memory-bundle.mjs');
console.log(JSON.stringify({ version: metadata.version, source, bundle, sha256: crypto.createHash('sha256').update(fs.readFileSync(bundle)).digest('hex') }));
