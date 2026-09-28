'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sessionListRevision } = require('../server/pi-session-list-revision');

test('list revisions recheck member identities, same-size edits, replacement and symlinks', t => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-list-revision-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'session.jsonl');
    fs.writeFileSync(file, 'old');
    const first = sessionListRevision(root);
    assert.equal(sessionListRevision(root), first);
    const times = fs.statSync(file);
    fs.writeFileSync(file, 'new'); fs.utimesSync(file, times.atime, times.mtime);
    const edited = sessionListRevision(root);
    assert.notEqual(edited, first);
    fs.renameSync(file, path.join(root, 'saved'));
    fs.writeFileSync(file, 'new'); fs.utimesSync(file, times.atime, times.mtime);
    assert.notEqual(sessionListRevision(root), edited);
    const replaced = sessionListRevision(root);
    fs.writeFileSync(path.join(root, 'another.jsonl'), 'new');
    assert.notEqual(sessionListRevision(root), replaced);
    fs.unlinkSync(file); fs.symlinkSync(path.join(root, 'saved'), file);
    assert.equal(sessionListRevision(root), null);
});

test('list revision refuses a path replaced after its descriptor was opened', t => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-list-race-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'session.jsonl'); fs.writeFileSync(file, 'old');
    const io = require('../server/pi-file-io'), original = io.openReadSync;
    let replaced = false;
    io.openReadSync = name => {
        const fd = original(name);
        if (name === file && !replaced) { replaced = true; fs.renameSync(file, file+'.old'); fs.writeFileSync(file, 'new'); }
        return fd;
    };
    try { assert.equal(sessionListRevision(root), null); }
    finally { io.openReadSync = original; }
});
