#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { REVIEWED_PI_VERSION: piVersion } = require('../server/pi-reviewed-host');
const LOCK_SHA256 = '7a4586cad2ad86e3f9c48576f41e85d470463e4eeaa7e5b7e07107746020e262';

const manifest = {
    name: 'pivane-profile-memory-isolated', version: '1.0.0', private: true,
    dependencies: {
        'pi-hermes-memory': '0.9.10', 'better-sqlite3': '13.0.3',
        '@earendil-works/pi-coding-agent': piVersion, '@earendil-works/pi-ai': piVersion,
        '@earendil-works/pi-tui': piVersion, 'typebox': '1.3.27', 'strip-ansi': '7.2.0',
        'brace-expansion': '5.0.12', undici: '8.12.2',
    },
    overrides: { '@earendil-works/pi-tui': piVersion, '@earendil-works/pi-agent-core': piVersion,
        '@earendil-works/pi-codemode': piVersion, '@earendil-works/pi-mcp': piVersion,
        '@earendil-works/pi-telemetry': piVersion, undici: '8.12.2', 'brace-expansion': '5.0.12' },
};
function install(prefix) {
    if (!prefix || !path.isAbsolute(prefix) || !fs.existsSync(path.join(prefix, 'package', 'profile-memory-bundle.mjs')))
        throw new Error('Build a fresh isolated prefix with profile-memory-build.cjs first');
    if (fs.existsSync(path.join(prefix, 'node_modules')))
        throw new Error('Prefix already has installed dependencies; choose a fresh prefix, do not overwrite user data');
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
    require('./install-bundled-capabilities.cjs').enforceShrinkwrapFixes(prefix);
    require('../server/pi-update-installer').verifyPiPackages(prefix, manifest,
        JSON.parse(fs.readFileSync(path.join(prefix, 'package-lock.json'), 'utf8')), piVersion);
    // Only this pinned native dependency's trusted install script runs, in the isolated prefix.
    execFileSync(npm, ['rebuild', '--prefix', prefix, 'better-sqlite3', '--foreground-scripts', ...flags], { stdio: 'inherit', timeout: 600000 });
    const req = createRequire(path.join(prefix, 'package.json'));
    const Database = req('better-sqlite3');
    const db = new Database(':memory:');
    try {
        db.exec('CREATE VIRTUAL TABLE verify_fts USING fts5(content, tokenize=trigram)');
    } finally { db.close(); }
    if (req('pi-hermes-memory/package.json').version !== '0.9.10'
        || JSON.parse(fs.readFileSync(path.join(prefix, 'package-lock.json'), 'utf8')).packages['node_modules/pi-hermes-memory'].integrity
            !== 'sha512-1cZzVieL1H3o5ZNtgunwu7nD1+Cn/7GQv5SvPpWDoN+7iLHEy4dkY5D30g/gKdVhW2Pm+63wFwQ3mXxc7k2/OA==')
        throw new Error('Installed versions or upstream integrity differ from verified recipe');
    console.log(JSON.stringify({ prefix, bundle: path.join(prefix, 'package', 'profile-memory-bundle.mjs'), node: process.version, sqlite: 'ok' }));
}
module.exports = { manifest, install };
if (require.main === module) install(process.argv[2]);
