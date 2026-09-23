'use strict';

const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const io = require('../pi-file-io');
const { descriptorPathSync, assertDescriptorBackend } = require('../pi-file-descriptor');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { setTimeout: delay } = require('node:timers/promises');

// One directory lock and generation for all adapter memory targets in this profile.
function createMutationLock(root) {
    const dir = path.join(root, '.pivane-memory-mutation.lock');
    const versionFile = path.join(root, '.pivane-memory-revision');
    const local = new AsyncLocalStorage();
    const token = randomUUID();
    async function revision() {
        let fd;
        try {
            assertDescriptorBackend();
            const before = nativeFs.lstatSync(versionFile, { bigint: true });
            if (!before.isFile() || before.isSymbolicLink() || before.size < 1n || before.size > 16n)
                throw new Error('Invalid memory revision');
            fd = io.openReadSync(versionFile);
            const opened = nativeFs.fstatSync(fd, { bigint: true }), native = io.identity(fd);
            const same = (a, b) => ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
            if (!opened.isFile() || !same(opened, before) || descriptorPathSync(fd) !== versionFile)
                throw new Error('Changed memory revision');
            const bytes = Buffer.alloc(Number(opened.size));
            if (nativeFs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length
                || !same(nativeFs.fstatSync(fd, { bigint: true }), opened)
                || !same(nativeFs.lstatSync(versionFile, { bigint: true }), opened)
                || descriptorPathSync(fd) !== versionFile || !io.sameIdentityAtPath(versionFile, native))
                throw new Error('Changed memory revision');
            const value = bytes.toString('utf8');
            if (!/^\d{1,16}$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid memory revision');
            return Number(value);
        } catch (error) {
            if (error.code === 'ENOENT' && fd === undefined) return 0;
            throw error;
        } finally { if (fd !== undefined) nativeFs.closeSync(fd); }
    }
    async function bump(current) {
        if (current >= Number.MAX_SAFE_INTEGER) throw new Error('Memory revision exhausted');
        const tmp = `${versionFile}.${token}.tmp`;
        try {
            await fs.writeFile(tmp, String(current + 1), { flag: 'wx', mode: 0o600 });
            await fs.rename(tmp, versionFile);
        } finally { await fs.rm(tmp, { force: true }); }
    }
    async function locked(signal, work, expected, mutation) {
        if (local.getStore() === token) return work(await revision());
        const until = Date.now() + 5000;
        while (true) {
            if (signal?.aborted) throw signal.reason || new Error('Memory mutation cancelled');
            try { await fs.mkdir(dir, { mode: 0o700 }); break; }
            catch (error) {
                if (error.code !== 'EEXIST') throw error;
                if (Date.now() >= until) throw new Error('Profile memory mutation is busy');
                await delay(30, undefined, signal ? { signal } : undefined);
            }
        }
        try {
            return await local.run(token, async () => {
                if (signal?.aborted) throw signal.reason || new Error('Memory mutation cancelled');
                const current = await revision();
                if (expected !== undefined && current !== expected) return { conflict: true };
                if (mutation) await bump(current); // Reserve before an uncertain write, including process death.
                return work(current);
            });
        } finally { await fs.rmdir(dir); }
    }
    return {
        inspect: (work, signal) => locked(signal, work, undefined, false),
        run: (signal, work, expected) => locked(signal, work, expected, true),
    };
}
module.exports = { createMutationLock };
