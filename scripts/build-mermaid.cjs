#!/usr/bin/env node
'use strict';
// Build the official Mermaid module with a reviewed sanitizer in an isolated prefix.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const prefix = process.argv[2] && fs.realpathSync.native(process.argv[2]);
if (!prefix || prefix === root) throw new Error('Supply an independently installed mermaid-build prefix');
for (const name of ['package.json', 'package-lock.json'])
    assert.deepEqual(fs.readFileSync(path.join(prefix, name)), fs.readFileSync(path.join(__dirname, 'mermaid-build', name)), `Build ${name} differs from reviewed recipe`);
const req = createRequire(path.join(prefix, 'package.json'));
const recipe = require('./mermaid-build/package.json');
for (const [name, version] of Object.entries({ ...recipe.dependencies, ...recipe.overrides }))
    assert.equal(JSON.parse(fs.readFileSync(path.join(prefix, 'node_modules', name, 'package.json'))).version, version, name);
const esbuild = req('esbuild');
const result = esbuild.buildSync({
    absWorkingDir: prefix,
    stdin: { contents: "import mermaid from './node_modules/mermaid/dist/mermaid.core.mjs'; globalThis.mermaid = mermaid;", resolveDir: prefix, sourcefile: 'pivane-mermaid-entry.mjs', loader: 'js' },
    bundle: true, platform: 'browser', format: 'iife', target: 'es2020', minify: true,
    keepNames: true, legalComments: 'eof', metafile: true, write: false,
    define: { 'process.env.NODE_ENV': '"production"' },
});
const purifier = Object.keys(result.metafile.inputs).filter(name => name.includes('/dompurify/'));
assert.equal(purifier.length, 1, 'Expected one sanitizer input');
assert.ok(purifier[0].startsWith('node_modules/dompurify/'), 'Nested sanitizer input is not reviewed');
const mathInputs = Object.keys(result.metafile.inputs).filter(name => name.includes('/katex/'));
assert.ok(mathInputs.length && mathInputs.every(name => name.startsWith('node_modules/katex/')), 'Nested math dependency is not reviewed');
const bytes = result.outputFiles[0].contents;
assert.ok(Buffer.from(bytes).includes(Buffer.from('3.4.17')), 'Sanitizer version missing');
assert.ok(!Buffer.from(bytes).includes(Buffer.from('3.4.12')), 'Old embedded sanitizer remains');
const target = path.join(root, 'public/vendor/mermaid-11.17.2-dompurify-3.4.17.min.js');
fs.writeFileSync(target, bytes);
fs.copyFileSync(path.join(prefix, 'node_modules/mermaid/LICENSE'), path.join(root, 'public/vendor/mermaid-LICENSE.txt'));
console.log(JSON.stringify({ target: path.basename(target), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), sanitizer: '3.4.17', mermaid: '11.17.2', katex: recipe.overrides.katex, esbuild: esbuild.version, sanitizerInput: purifier[0], inputs: Object.keys(result.metafile.inputs).length }));
