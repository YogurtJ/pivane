'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { enforceShrinkwrapFixes, SHRINKWRAP_FIXES } = require('../scripts/install-bundled-capabilities.cjs');

const fix = SHRINKWRAP_FIXES[0];
function pkg(dir, name, version) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version, main: 'index.js', exports: { './package.json': './package.json', '.': './index.js' } }));
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = 1;');
}
function fixture({ nested = '5.0.9', hoisted = fix.fixed, override = fix.fixed, extra } = {}) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-dep-'));
    fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({ overrides: override ? { [fix.name]: override } : {} }));
    fs.writeFileSync(path.join(base, 'package-lock.json'), JSON.stringify({ packages: { [`node_modules/${fix.name}`]: { version: fix.fixed } } }));
    const owner = path.join(base, 'node_modules', fix.owner, 'node_modules');
    pkg(path.join(owner, fix.consumer), fix.consumer, '10.2.6');
    if (nested) pkg(path.join(owner, fix.name), fix.name, nested);
    if (hoisted) pkg(path.join(base, 'node_modules', fix.name), fix.name, hoisted);
    if (extra) pkg(path.join(base, 'node_modules', 'other', 'node_modules', fix.name), fix.name, extra);
    return base;
}
const resolved = base => JSON.parse(fs.readFileSync(require.resolve(`${fix.name}/package.json`,
    { paths: [path.join(base, 'node_modules', fix.owner, 'node_modules', fix.consumer)] }), 'utf8')).version;

test('shrinkwrapped vulnerable brace-expansion is replaced by the reviewed hoisted release', () => {
    const base = fixture();
    const nested = path.join(base, 'node_modules', fix.owner, 'node_modules', fix.name);
    assert.equal(JSON.parse(fs.readFileSync(path.join(nested, 'package.json'), 'utf8')).version, '5.0.9');
    assert.deepEqual(enforceShrinkwrapFixes(base), ['brace-expansion@5.0.9']);
    assert.equal(fs.existsSync(nested), false);
    assert.equal(resolved(base), fix.fixed);
    assert.deepEqual(enforceShrinkwrapFixes(base), []);
});

test('dependency fix fails closed without reviewed override, fixed copy or expected versions', () => {
    assert.throws(() => enforceShrinkwrapFixes(fixture({ override: null })), /not installed/);
    assert.throws(() => enforceShrinkwrapFixes(fixture({ hoisted: '5.0.11' })), /not installed/);
    const unexpected = fixture({ nested: '6.0.0' });
    assert.throws(() => enforceShrinkwrapFixes(unexpected), /Unexpected brace-expansion 6\.0\.0/);
    assert.ok(fs.existsSync(path.join(unexpected, 'node_modules', fix.owner, 'node_modules', fix.name)));
    assert.throws(() => enforceShrinkwrapFixes(fixture({ extra: '4.0.1' })), /Vulnerable brace-expansion remains/);
    const link = fixture({ nested: null });
    fs.symlinkSync(path.join(link, 'node_modules', fix.name), path.join(link, 'node_modules', fix.owner, 'node_modules', fix.name));
    assert.throws(() => enforceShrinkwrapFixes(link), /Unexpected dependency layout/);
});
