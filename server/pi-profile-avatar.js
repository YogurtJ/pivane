'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const io = require('./pi-file-io');
const { descriptorPathSync } = require('./pi-file-descriptor');
const { location } = require('./pi-profile-documents');
const privateFiles = require('./pi-private-files');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const ID = /^[a-f0-9-]{36}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAGIC = Buffer.from('89504e470d0a1a0a', 'hex');
function crc32(bytes) {
    let crc = -1;
    for (const byte of bytes) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ -1) >>> 0;
}
function validatePng(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 60 || bytes.length > 1024 * 1024 || !bytes.subarray(0, 8).equals(MAGIC)) throw fail('Invalid PNG avatar');
    let pos = 8, width, height, channels, ended = false, idat = [], imageStarted = false;
    while (pos + 12 <= bytes.length) {
        const size = bytes.readUInt32BE(pos), next = pos + 12 + size;
        if (next > bytes.length) throw fail('Invalid PNG chunk');
        const type = bytes.toString('ascii', pos + 4, pos + 8);
        if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(pos + 4, pos + 8 + size)) !== bytes.readUInt32BE(pos + 8 + size)) throw fail('Invalid PNG checksum');
        if (pos === 8) {
            if (type !== 'IHDR' || size !== 13) throw fail('Invalid PNG header');
            width = bytes.readUInt32BE(pos + 8); height = bytes.readUInt32BE(pos + 12);
            channels = bytes[pos + 17] === 6 ? 4 : bytes[pos + 17] === 2 ? 3 : 0;
            if (!width || !height || width > 2048 || height > 2048 || !channels || bytes[pos + 16] !== 8
                || bytes[pos + 18] !== 0 || bytes[pos + 19] !== 0 || bytes[pos + 20] !== 0) throw fail('Unsupported PNG format');
        } else if (type === 'IDAT') {
            if (ended) throw fail('Invalid PNG order');
            imageStarted = true; idat.push(bytes.subarray(pos + 8, pos + 8 + size));
        } else if (type === 'IEND') {
            if (size || !imageStarted || next !== bytes.length) throw fail('Invalid PNG end');
            ended = true; break;
        } else if (type[0] === type[0].toUpperCase() || imageStarted) throw fail('Unsupported PNG chunk');
        pos = next;
    }
    if (!ended) throw fail('Incomplete PNG');
    let decoded;
    try { decoded = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: height * (1 + width * channels) }); }
    catch { throw fail('Invalid PNG pixels'); }
    if (decoded.length !== height * (1 + width * channels)) throw fail('Invalid PNG pixels');
    for (let row = 0; row < height; row++) if (decoded[row * (1 + width * channels)] > 4) throw fail('Invalid PNG filter');
}
function readAvatar(file) {
    let fd;
    try {
        const before = fs.lstatSync(file, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || before.size > 1024n * 1024n) throw fail('Unsafe avatar asset', 409);
        fd = io.openReadSync(file);
        const opened = fs.fstatSync(fd, { bigint: true }), identity = io.identity(fd);
        const same = (a, b) => ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
        if (!opened.isFile() || !same(before, opened) || descriptorPathSync(fd) !== file) throw fail('Avatar changed', 409);
        const bytes = Buffer.alloc(Number(opened.size));
        if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length
            || !same(opened, fs.fstatSync(fd, { bigint: true })) || !same(opened, fs.lstatSync(file, { bigint: true }))
            || descriptorPathSync(fd) !== file || !io.sameIdentityAtPath(file, identity)) throw fail('Avatar changed', 409);
        return bytes;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function mountProfileAvatarRoutes(router, { profiles, getAgentDir } = {}) {
    if (!profiles?.saveAvatar || !profiles?.getProfile || typeof getAgentDir !== 'function') throw new TypeError('Expected profiles and getAgentDir');
    router.post('/profiles/:id/avatar', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            const id = req.params.id, body = req.body;
            if (!ID.test(id) || typeof body?.expectedRevision !== 'string' || typeof body?.dataUrl !== 'string'
                || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(body.dataUrl) || body.dataUrl.length > 1.5 * 1024 * 1024) throw fail('Invalid avatar upload');
            const bytes = Buffer.from(body.dataUrl.slice('data:image/png;base64,'.length), 'base64');
            if (bytes.toString('base64') !== body.dataUrl.slice('data:image/png;base64,'.length)) throw fail('Invalid avatar encoding');
            validatePng(bytes);
            const version = createHash('sha256').update(bytes).digest('hex');
            const record = await profiles.getProfile(id);
            if (!record) throw fail('Profile not found', 404);
            const root = location(await getAgentDir(), id, true);
            const file = path.join(root, `avatar-${version}.png`);
            try { privateFiles.writePrivateFileSync(file, bytes, true); }
            catch (error) { if (error.code !== 'EEXIST' || !readAvatar(file).equals(bytes)) {
                if (error.code === 'EEXIST') throw fail('Avatar asset already exists with conflicting contents', 409);
                throw error;
            } }
            const result = await profiles.saveAvatar(id, body.expectedRevision, version);
            res.json(result);
        } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Avatar upload unavailable' }); }
    });
    router.get('/profiles/:id/avatar', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            const id = req.params.id, version = req.query.version;
            if (!ID.test(id) || typeof version !== 'string' || !HASH.test(version)) throw fail('Invalid avatar version');
            const profile = await profiles.getProfile(id);
            if (!profile || profile.avatar?.kind !== 'image' || profile.avatar.version !== version) throw fail('Avatar not found', 404);
            const root = location(await getAgentDir(), id, false);
            const file = path.join(root, `avatar-${version}.png`);
            const bytes = readAvatar(file);
            if (createHash('sha256').update(bytes).digest('hex') !== version) throw fail('Avatar changed', 409);
            res.type('image/png').send(bytes);
        } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Avatar unavailable' }); }
    });
}
module.exports = { mountProfileAvatarRoutes, validatePng };
