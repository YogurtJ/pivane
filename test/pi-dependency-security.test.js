'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { enforceShrinkwrapFixes, SHRINKWRAP_FIXES } = require('../scripts/install-bundled-capabilities.cjs');

function pkg(dir, name, version) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version, main: 'index.js', exports: { './package.json': './package.json', '.': './index.js' } }));
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = 1;');
}
function fixture(t, fix, { nested, hoisted = fix.fixed, override = fix.fixed, extra } = {}) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-dep-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({ overrides: override ? { [fix.name]: override } : {} }));
    fs.writeFileSync(path.join(base, 'package-lock.json'), JSON.stringify({ packages: { [`node_modules/${fix.name}`]: { version: fix.fixed } } }));
    const owner = path.join(base, 'node_modules', fix.owner, 'node_modules');
    pkg(path.join(owner, fix.consumer), fix.consumer, '1.0.0');
    if (nested) pkg(path.join(owner, fix.name), fix.name, nested);
    if (hoisted) pkg(path.join(base, 'node_modules', fix.name), fix.name, hoisted);
    if (extra) pkg(path.join(base, 'node_modules', 'other', 'node_modules', fix.name), fix.name, extra);
    return base;
}
for (const fix of SHRINKWRAP_FIXES) {
    const vulnerable = fix.name === 'brace-expansion' ? '5.0.9' : '8.10.2';
    test(`shrinkwrapped vulnerable ${fix.name} resolves to the reviewed fixed release`, t => {
        const base = fixture(t, fix, { nested: vulnerable });
        const nested = path.join(base, 'node_modules', fix.owner, 'node_modules', fix.name);
        assert.deepEqual(enforceShrinkwrapFixes(base, [fix]), [`${fix.name}@${vulnerable}`]);
        assert.equal(fs.existsSync(nested), false);
        const resolved = require.resolve(`${fix.name}/package.json`, { paths: [path.join(base, 'node_modules', fix.owner, 'node_modules', fix.consumer)] });
        assert.equal(JSON.parse(fs.readFileSync(resolved, 'utf8')).version, fix.fixed);
        assert.deepEqual(enforceShrinkwrapFixes(base, [fix]), []);
    });
    test(`${fix.name} fix rejects absent override, stale fixed copy, unexpected version and residual vulnerable copy`, t => {
        const enforce = options => enforceShrinkwrapFixes(fixture(t, fix, options), [fix]);
        assert.throws(() => enforce({ override: null }), /not installed/);
        assert.throws(() => enforce({ hoisted: vulnerable }), /not installed/);
        const unexpected = fixture(t, fix, { nested: '99.0.0' });
        assert.throws(() => enforceShrinkwrapFixes(unexpected, [fix]), /Unexpected/);
        assert.ok(fs.existsSync(path.join(unexpected, 'node_modules', fix.owner, 'node_modules', fix.name)));
        assert.throws(() => enforce({ extra: vulnerable }), /Vulnerable .* remains/);
        const link = fixture(t, fix);
        fs.symlinkSync(path.join(link, 'node_modules', fix.name), path.join(link, 'node_modules', fix.owner, 'node_modules', fix.name));
        assert.throws(() => enforceShrinkwrapFixes(link, [fix]), /Unexpected dependency layout/);
    });
    test(`${fix.name} validates a hoisted consumer without shrinkwrap and fails closed when it disappears`, t => {
        const base = fixture(t, fix);
        const consumer = path.join(base, 'node_modules', fix.owner, 'node_modules', fix.consumer);
        const hoisted = path.join(base, 'node_modules', fix.consumer);
        fs.mkdirSync(path.dirname(hoisted), { recursive: true });
        fs.renameSync(consumer, hoisted);
        assert.deepEqual(enforceShrinkwrapFixes(base, [fix]), []);
        const shadow = path.join(hoisted, 'node_modules', fix.name);
        pkg(shadow, fix.name, '99.0.0');
        assert.throws(() => enforceShrinkwrapFixes(base, [fix]), /does not resolve/);
        fs.rmSync(shadow, { recursive: true });
        fs.rmSync(hoisted, { recursive: true });
        assert.throws(() => enforceShrinkwrapFixes(base, [fix]), /does not resolve/);
    });
}
