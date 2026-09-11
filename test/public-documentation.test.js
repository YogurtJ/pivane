const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkDocumentation, assertPublicPath } = require('../scripts/check-docs.cjs');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-docs-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'docs/local'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/public-files.json'), JSON.stringify({ version: 1, files: ['README.md', 'docs/GUIDE.md'] }));
    fs.writeFileSync(path.join(root, 'README.md'), '# Pivane\n\n[Guide](docs/GUIDE.md)\n');
    fs.writeFileSync(path.join(root, 'docs/GUIDE.md'), '# Guide\n\n[Home](../README.md)\n');
    fs.writeFileSync(path.join(root, 'docs/local/NOTES.md'), 'PRIVATE_FIXTURE_NOT_FOR_DISTRIBUTION');
    return root;
}
test('public documentation resolves Markdown links without treating code examples as published dependencies', t => {
    const root = fixture(t);
    fs.appendFileSync(path.join(root, 'docs/GUIDE.md'), '\n```md\n[example](not-a-real-file.md)\n```\n');
    assert.equal(checkDocumentation(root, ['README.md', 'docs/GUIDE.md', 'docs/public-files.json']).documents, 2);
    assert.throws(() => checkDocumentation(root, ['README.md']), /omitted from package/);
});
test('private, unclassified and broken documentation cannot enter the published graph', t => {
    const root = fixture(t);
    fs.appendFileSync(path.join(root, 'README.md'), '\n[private](docs/local/NOTES.md)');
    assert.throws(() => checkDocumentation(root), /Broken\/private link/);
    fs.writeFileSync(path.join(root, 'README.md'), '[missing](docs/MISSING.md)');
    assert.throws(() => checkDocumentation(root), /Broken\/private link/);
    fs.writeFileSync(path.join(root, 'README.md'), '# Pivane');
    fs.writeFileSync(path.join(root, 'docs/NOTES.md'), 'unclassified draft');
    assert.throws(() => checkDocumentation(root), /Classify documentation/);
    assert.throws(() => checkDocumentation(root, ['docs/local/NOTES.md']), /Private or invalid distribution path/);
    for (const file of ['AGENTS.local.md', 'docs/LOCAL/private.md', 'backups/archive.md', '../escape.md', '/absolute.md', 'docs\\local\\private.md', '.env', 'public/images/user.png']) assert.throws(() => assertPublicPath(file));
    assert.doesNotThrow(() => assertPublicPath('.env.example'));
});
test('public documentation rejects known instance records and portable symlink escapes', t => {
    const root = fixture(t);
    fs.appendFileSync(path.join(root, 'docs/GUIDE.md'), '\nDeployment result: /tmp/pi-example-deploy-result.json');
    assert.throws(() => checkDocumentation(root), /Maintainer instance record/);
    fs.writeFileSync(path.join(root, 'docs/GUIDE.md'), '# Guide');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-doc-outside-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.writeFileSync(path.join(outside, 'NOTE.md'), 'private outside target');
    fs.symlinkSync(outside, path.join(root, 'docs/escape'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.appendFileSync(path.join(root, 'README.md'), '\n[escape](docs/escape/NOTE.md)');
    assert.throws(() => checkDocumentation(root), /symlink is not allowed/);
});
