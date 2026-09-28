const path = require('node:path');
const { fail } = require('./pi-file-scope');
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_PIXELS = 32 * 1024 * 1024;
function utf8(bytes) {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw fail('只支持 UTF-8 文本文件', 415, 'FILE_ENCODING'); }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw fail('二进制文件暂不支持全文查看', 415, 'FILE_BINARY');
    return text;
}
function dimensions(bytes) {
    if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii', 12, 16) === 'IHDR')
        return { mime: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)))
        return { mime: 'image/gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
        const kind = bytes.toString('ascii', 12, 16);
        if (kind === 'VP8X') return { mime: 'image/webp', width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
        if (kind === 'VP8 ' && bytes.subarray(23, 26).equals(Buffer.from([157,1,42]))) return { mime: 'image/webp', width: bytes.readUInt16LE(26) & 16383, height: bytes.readUInt16LE(28) & 16383 };
        if (kind === 'VP8L' && bytes[20] === 47) { const bits = bytes.readUInt32LE(21); return { mime: 'image/webp', width: (bits & 16383) + 1, height: ((bits >>> 14) & 16383) + 1 }; }
    }
    if (bytes[0] === 255 && bytes[1] === 216) {
        let at = 2;
        while (at + 4 <= bytes.length) {
            if (bytes[at++] !== 255) break;
            while (bytes[at] === 255) at++;
            const marker = bytes[at++];
            if (marker === 217 || marker === 218) break;
            if (marker === 1 || marker >= 208 && marker <= 215) continue;
            if (at + 2 > bytes.length) break;
            const length = bytes.readUInt16BE(at);
            if (length < 2 || at + length > bytes.length) break;
            if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 8)
                return { mime: 'image/jpeg', height: bytes.readUInt16BE(at + 3), width: bytes.readUInt16BE(at + 5) };
            at += length;
        }
    }
    return null;
}
function classify(bytes, filename) {
    const image = dimensions(bytes);
    if (image) {
        if (!image.width || !image.height || image.width > 16384 || image.height > 16384 || image.width * image.height > MAX_PIXELS)
            return { kind: 'binary', mime: 'application/octet-stream', previewReason: '图片像素超过预览限制，可下载原文件' };
        return { kind: 'image', ...image };
    }
    if (/\.(?:png|jpe?g|gif|webp)$/i.test(filename)) return { kind: 'binary', mime: 'application/octet-stream', previewReason: '图片格式无效或不支持，可下载原文件' };
    if (bytes.length <= MAX_TEXT_BYTES) {
        try {
            utf8(bytes);
            const ext = path.extname(filename).toLowerCase();
            return { kind: ['.html', '.htm'].includes(ext) ? 'html' : ['.md', '.markdown'].includes(ext) ? 'markdown' : 'text', mime: 'text/plain; charset=utf-8' };
        } catch {}
    }
    return { kind: 'binary', mime: 'application/octet-stream', previewReason: '此类型暂不支持预览，可下载原文件' };
}
function representation(file, name) {
    const { bytes, ...metadata } = file, type = classify(bytes, name);
    return { ...metadata, ...type, encoding: ['text', 'markdown', 'html'].includes(type.kind) ? 'utf8' : 'base64',
        ...( ['text', 'markdown', 'html'].includes(type.kind) ? { content: utf8(bytes) } : { base64: bytes.toString('base64') }) };
}
module.exports = { MAX_FILE_BYTES, MAX_TEXT_BYTES, MAX_PIXELS, utf8, classify, representation };
