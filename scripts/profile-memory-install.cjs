#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const LOCK_SHA256 = '4f242aaee52d1be13c1d9a795d77595a2f6ef0070d18cf7546f21b01d7a2881b';

const prefix = process.argv[2];
if (!prefix || !path.isAbsolute(prefix) || !fs.existsSync(path.join(prefix, 'package', 'profile-memory-bundle.mjs')))
    throw new Error('Build a fresh isolated prefix with profile-memory-build.cjs first');
if (fs.existsSync(path.join(prefix, 'node_modules')))
    throw new Error('Prefix already has installed dependencies; choose a fresh prefix, do not overwrite user data');
const manifest = {
    name: 'pivane-profile-memory-isolated', version: '1.0.0', private: true,
    dependencies: {
        'pi-hermes-memory': '0.9.9', 'better-sqlite3': '13.0.3',
        '@earendil-works/pi-coding-agent': '0.87.1', '@earendil-works/pi-ai': '0.87.1',
        '@earendil-works/pi-tui': '0.80.10', 'typebox': '1.3.27', 'strip-ansi': '7.2.0',
    },
};
const manifestFile = path.join(prefix, 'package.json');
if (fs.existsSync(manifestFile)) {
    if (fs.readFileSync(manifestFile, 'utf8') !== JSON.stringify(manifest, null, 2) + '\n')
        throw new Error('Existing manifest differs; choose a fresh prefix');
} else fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
// Keep the generated lockfile with the isolated installation for exact reinstall.
const lockSource = process.env.PIVANE_PROFILE_MEMORY_LOCKFILE || path.join(__dirname, '..', 'server', 'profile-memory', 'upstream-lock.json');
const bytes = fs.readFileSync(lockSource);
if (createHash('sha256').update(bytes).digest('hex') !== LOCK_SHA256) throw new Error('Verified lockfile hash mismatch');
fs.copyFileSync(lockSource, path.join(prefix, 'package-lock.json'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const flags = ['--no-audit', '--no-fund', '--fetch-retries=1', '--fetch-timeout=30000'];
execFileSync(npm, ['ci', '--prefix', prefix, '--ignore-scripts', ...flags], { stdio: 'inherit', timeout: 600000 });
execFileSync(npm, ['ci', '--prefix', prefix, '--ignore-scripts', ...flags], { stdio: 'inherit', timeout: 600000 });
// Only this pinned native dependency's trusted install script runs, in the isolated prefix.
execFileSync(npm, ['rebuild', '--prefix', prefix, 'better-sqlite3', '--foreground-scripts', ...flags], { stdio: 'inherit', timeout: 600000 });
const req = createRequire(path.join(prefix, 'package.json'));
const Database = req('better-sqlite3');
const db = new Database(':memory:');
try {
    db.exec('CREATE VIRTUAL TABLE verify_fts USING fts5(content, tokenize=trigram)');
} finally { db.close(); }
if (req('pi-hermes-memory/package.json').version !== '0.9.9'
    || JSON.parse(fs.readFileSync(path.join(prefix, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), 'utf8')).version !== '0.87.1'
    || JSON.parse(fs.readFileSync(path.join(prefix, 'package-lock.json'), 'utf8')).packages['node_modules/pi-hermes-memory'].integrity
        !== 'sha512-6EfhmlgBuMfN7bQwN+xHMDVwX/Tm0fKKi6X8lAIBZtcjqxS9Of0rboJzmxfO3r+rGMWb71ss4p+dY34aEsJ1dg==')
    throw new Error('Installed versions or upstream integrity differ from verified recipe');
console.log(JSON.stringify({ prefix, bundle: path.join(prefix, 'package', 'profile-memory-bundle.mjs'), node: process.version, sqlite: 'ok' }));
