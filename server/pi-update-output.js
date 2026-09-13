const { StringDecoder } = require('node:string_decoder');
const { stripVTControlCharacters } = require('node:util');

function outputRedactor(env = {}) {
    const secrets = new Set();
    const add = value => {
        if (typeof value !== 'string' || value.length < 4) return;
        for (const part of [value, ...value.split(/\r?\n/)].filter(s => s.length >= 4)) {
            secrets.add(part); secrets.add(encodeURIComponent(part));
        }
    };
    for (const [name, value] of Object.entries(env)) {
        if (/key|token|secret|password|cookie|credential|auth/i.test(name)) add(value);
        if (/proxy/i.test(name) && value) try {
            const url = new URL(value);
            add(url.username); add(url.password); add(decodeURIComponent(url.username)); add(decodeURIComponent(url.password));
            if (url.username || url.password) add(Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64'));
        } catch { /* A non-URL proxy setting is never logged by the runner. */ }
    }
    const values = [...secrets].sort((a, b) => b.length - a.length);
    return text => {
        let safe = stripVTControlCharacters(String(text)).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
        for (const value of values) safe = safe.split(value).join('[redacted]');
        return safe.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@')
            .replace(/([?&](?:api[_-]?key|token|access_token|refresh_token|secret|password)=)[^&\s]*/gi, '$1[redacted]')
            .replace(/\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|access_token|refresh_token|password|secret)["']?\s*[:=].*$/gim, '$1: [redacted]')
            .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[redacted]');
    };
}
function outputLines(stream, emit, redact) {
    const decoder = new StringDecoder('utf8');
    let pending = '', dropping = false, privateBlock = false;
    const line = value => {
        if (/-----BEGIN .*PRIVATE KEY-----/.test(value)) { privateBlock = true; emit(stream, '[private material redacted]'); return; }
        if (privateBlock) { if (/-----END .*PRIVATE KEY-----/.test(value)) privateBlock = false; return; }
        emit(stream, redact(value.replace(/\r/g, '\n')));
    };
    const consume = text => {
        pending += text;
        let at;
        while ((at = pending.indexOf('\n')) >= 0) {
            const current = pending.slice(0, at); pending = pending.slice(at + 1);
            if (!dropping && current.length <= 16384) line(current);
            else if (!dropping) emit(stream, '[oversized output line omitted]');
            dropping = false;
        }
        if (pending.length > 16384) { if (!dropping) emit(stream, '[oversized output line omitted]'); pending = ''; dropping = true; }
    };
    return { write(bytes) { consume(decoder.write(bytes)); }, end() { consume(decoder.end()); if (pending && !dropping) line(pending); pending = ''; } };
}
function appendOutput(job, stream, text) {
    const prefix = stream === 'stderr' ? '[stderr] ' : '';
    job.output = (job.output || '') + prefix + text + '\n';
    // Keep a bounded tail of already-redacted output; never expose an unfiltered buffer.
    if (job.output.length > 32768) { job.output = job.output.slice(-32768); job.outputTruncated = true; }
}
module.exports = { outputRedactor, outputLines, appendOutput };
