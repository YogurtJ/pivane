const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { readVerifiedFile } = require('./pi-file-bytes');
const privateFiles = require('./pi-private-files');
const { MAX_MEDIA_BYTES, parseMedia } = require('./media-attachments');

// Reference images and videos for chat media cards. A chat card carries a short
// `mediaref:<sha256>` instead of base64, so the plan, the card journal and the
// conversation stay small and a later "generate again" still has the exact
// bytes the user confirmed. Files are content-addressed and never rewritten.

const REF = /^mediaref:([0-9a-f]{64})$/;
const EXTENSIONS = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'video/mp4': '.mp4' };
const MIME = Object.fromEntries(Object.entries(EXTENSIONS).map(([mime, extension]) => [extension, mime]));
const DATA_URL = /^data:(?:image\/(?:png|jpeg|webp)|video\/mp4);base64,/;
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };

class MediaReferences {
    constructor({ directory, maxFiles = 5000, maxBytes = 4 * 1024 * 1024 * 1024 }) {
        const target = path.resolve(directory);
        privateFiles.privateDirectory(target);
        if (!fs.lstatSync(target).isDirectory()) fail('Invalid reference directory');
        Object.assign(this, { directory: fs.realpathSync(target), maxFiles, maxBytes });
    }

    static isReference(value) { return typeof value === 'string' && REF.test(value); }
    static isDataUrl(value) { return typeof value === 'string' && DATA_URL.test(value); }

    usage() {
        let files = 0, bytes = 0;
        try {
            for (const entry of fs.readdirSync(this.directory, { withFileTypes: true })) {
                if (!entry.isFile() || !/^[0-9a-f]{64}\.(png|jpg|webp|mp4)$/.test(entry.name)) continue;
                files++; bytes += fs.statSync(path.join(this.directory, entry.name)).size;
            }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        return { files, bytes };
    }

    // Validates the data URL (type, magic bytes, 20 MiB) and stores it once.
    put(dataUrl) {
        if (!MediaReferences.isDataUrl(dataUrl)) fail('Reference must be a PNG, JPEG, WebP or MP4 data URL');
        const mimeType = dataUrl.slice(5, dataUrl.indexOf(';'));
        const parsed = parseMedia(dataUrl, mimeType.split('/')[0]);
        const bytes = Buffer.from(parsed.data, 'base64');
        const sha = createHash('sha256').update(bytes).digest('hex');
        const existing = this.locate(sha);
        if (existing) {
            if (existing.mimeType !== mimeType) fail('The same bytes were stored with a different type');
            return { ref: `mediaref:${sha}`, mimeType, bytes: bytes.length };
        }
        const usage = this.usage();
        if (usage.files >= this.maxFiles || usage.bytes + bytes.length > this.maxBytes) fail('Reference storage is full; remove old references before adding more', 507);
        if (fs.realpathSync(this.directory) !== this.directory) fail('Reference directory changed', 409);
        const target = path.join(this.directory, sha + EXTENSIONS[mimeType]);
        const temporary = path.join(this.directory, `.${randomUUID()}.tmp`);
        try {
            privateFiles.writePrivateFileSync(temporary, bytes, true);
            fs.renameSync(temporary, target);
        } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
        return { ref: `mediaref:${sha}`, mimeType, bytes: bytes.length };
    }

    locate(sha) {
        if (!/^[0-9a-f]{64}$/.test(sha)) return null;
        for (const [extension, mimeType] of Object.entries(MIME)) {
            const file = path.join(this.directory, sha + extension);
            let stat;
            try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            if (!stat.isFile() || !stat.size || stat.size > MAX_MEDIA_BYTES) fail('Reference file is invalid', 500);
            return { file, mimeType, size: stat.size };
        }
        return null;
    }

    // Reads and checks the stored bytes against their name before they are sent anywhere.
    async read(ref) {
        const match = REF.exec(typeof ref === 'string' ? ref : '');
        if (!match) fail('Unknown media reference');
        const found = this.locate(match[1]);
        if (!found) fail('This reference image is no longer available; attach it again', 404);
        const root = await fs.promises.realpath(this.directory);
        if (root !== this.directory) fail('Reference directory changed', 409);
        const { bytes } = await readVerifiedFile(found.file, { maxBytes: MAX_MEDIA_BYTES, check: file => {
            if (path.dirname(file) !== root) fail('Reference is outside its storage directory', 403);
        } });
        if (createHash('sha256').update(bytes).digest('hex') !== match[1]) fail('Reference file changed on disk', 500);
        return { ...found, bytes };
    }

    async gallery(url, directory) {
        if (typeof url !== 'string' || !/^\/images\/[^/?#\\]+$/.test(url) || !directory) fail('Invalid gallery image');
        const filename = decodeURIComponent(url.slice(8));
        if (filename !== path.basename(filename) || /[/\\]/.test(filename)) fail('Invalid gallery image');
        const mimeType = MIME[path.extname(filename).toLowerCase().replace('.jpeg', '.jpg')];
        if (!mimeType?.startsWith('image/')) fail('Invalid gallery image');
        const root = await fs.promises.realpath(directory);
        const { bytes } = await readVerifiedFile(path.join(root, filename), { maxBytes: MAX_MEDIA_BYTES, check: file => {
            if (path.dirname(file) !== root) fail('Gallery image is outside the gallery', 403);
        } });
        return this.put(`data:${mimeType};base64,${bytes.toString('base64')}`).ref;
    }

    async resolve(ref, kind) {
        const { mimeType, bytes } = await this.read(ref);
        if (kind && !mimeType.startsWith(kind + '/')) fail(`This reference is not ${kind === 'image' ? 'an image' : 'a video'}`);
        return `data:${mimeType};base64,${bytes.toString('base64')}`;
    }
}

module.exports = { MediaReferences, REFERENCE: REF };
