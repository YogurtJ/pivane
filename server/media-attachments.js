const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MEDIA_TYPES = new Set(['image', 'video']);
function parseMedia(value, kind) {
    const fail = () => { throw Object.assign(new Error(`Invalid ${kind} attachment: use PNG, JPEG, WebP or MP4, at most 20MiB`), { statusCode: 400 }); };
    if (typeof value !== 'string' || value.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4 + 64) fail();
    const match = /^data:(image\/(?:png|jpeg|webp)|video\/mp4);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match || !match[1].startsWith(kind + '/')) fail();
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > MAX_MEDIA_BYTES || bytes.toString('base64') !== match[2]) fail();
    const mime = match[1];
    const valid = mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
        : mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
            : mime === 'image/webp' ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
                : bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp';
    if (!valid) fail();
    return { mimeType: mime, data: match[2], bytes: bytes.length };
}
function parseMediaField(value, field) {
    if (!field.multiple) return parseMedia(value, field.type);
    if (!Array.isArray(value) || !value.length || value.length > (field.maxItems || 8)) throw Object.assign(new Error('Invalid attachment list or too many references'), { statusCode: 400 });
    return value.map(item => parseMedia(item, field.type));
}
function mediaParameters(definitions, parameters) {
    const result = {};
    let bytes = 0, count = 0;
    for (const [key, field] of Object.entries(definitions)) {
        if (!MEDIA_TYPES.has(field.type) || parameters[key] === undefined) continue;
        const parsed = parseMediaField(parameters[key], field);
        count += [parsed].flat().length;
        if (count > 20) throw Object.assign(new Error('At most 20 reference attachments per request'), { statusCode: 400 });
        bytes += [parsed].flat().reduce((total, item) => total + item.bytes, 0);
        result[key] = parsed;
    }
    if (bytes > MAX_MEDIA_BYTES) throw Object.assign(new Error('Attachments exceed the combined 20MiB limit'), { statusCode: 400 });
    return result;
}
module.exports = { MAX_MEDIA_BYTES, MEDIA_TYPES, parseMedia, parseMediaField, mediaParameters };
