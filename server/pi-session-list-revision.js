'use strict';

const fs = require('node:fs');
const path = require('node:path');
const io = require('./pi-file-io');
const { descriptorPathSync } = require('./pi-file-descriptor');
const stamp = stat => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');

// A disposable list cache must prove every directory member again. Directory
// timestamps alone do not prove unchanged membership or unchanged file bytes.
function sessionListRevision(directory) {
    let directoryFd;
    try {
        if (fs.realpathSync.native(directory) !== directory) return null;
        directoryFd = io.openReadSync(directory);
        const before = fs.fstatSync(directoryFd, { bigint: true });
        const identity = io.identity(directoryFd);
        if (!before.isDirectory() || descriptorPathSync(directoryFd) !== directory) return null;
        const names = fs.readdirSync(directory).filter(name => name.endsWith('.jsonl')).sort();
        if (names.length > 5000) return null;
        const revisions = [];
        for (const name of names) {
            const file = path.join(directory, name);
            let fd;
            try {
                const listed = fs.lstatSync(file, { bigint: true });
                if (!listed.isFile() || listed.isSymbolicLink()) return null;
                fd = io.openReadSync(file);
                const opened = fs.fstatSync(fd, { bigint: true }), native = io.identity(fd);
                if (stamp(listed) !== stamp(opened) || descriptorPathSync(fd) !== file
                    || fs.realpathSync.native(file) !== file || !io.sameIdentityAtPath(file, native)
                    || stamp(opened) !== stamp(fs.fstatSync(fd, { bigint: true }))
                    || stamp(opened) !== stamp(fs.lstatSync(file, { bigint: true }))) return null;
                revisions.push([name, stamp(opened), native]);
            } finally { if (fd !== undefined) fs.closeSync(fd); }
        }
        if (stamp(before) !== stamp(fs.fstatSync(directoryFd, { bigint: true }))
            || stamp(before) !== stamp(fs.lstatSync(directory, { bigint: true }))
            || descriptorPathSync(directoryFd) !== directory || !io.sameIdentityAtPath(directory, identity)
            || fs.realpathSync.native(directory) !== directory
            || JSON.stringify(names) !== JSON.stringify(fs.readdirSync(directory).filter(name => name.endsWith('.jsonl')).sort())) return null;
        return JSON.stringify([stamp(before), identity, revisions]);
    } catch { return null; }
    finally { if (directoryFd !== undefined) fs.closeSync(directoryFd); }
}
module.exports = { sessionListRevision };
