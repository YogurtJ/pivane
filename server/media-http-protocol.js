const { setTimeout: delay } = require('node:timers/promises');
const MAX_OUTPUT = 64 * 1024 * 1024;
const MAX_JSON = 90 * 1024 * 1024;
const MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'audio/wav', 'audio/mpeg'];
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
function fail(message, statusCode = 400) { throw Object.assign(new Error(message), { statusCode }); }
function keys(value, allowed, label) {
    if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(`Invalid ${label} fields`);
}
function jsonPath(value, label = 'JSON path') {
    if (!Array.isArray(value) || value.length > 24 || value.some(key => RESERVED.has(String(key)) || !(typeof key === 'string' && key.length <= 160 || Number.isInteger(key) && key >= 0))) fail(`Invalid ${label}`);
    return clone(value);
}
function atPath(value, parts) {
    for (let index = 0; index < parts.length; index++) {
        const key = parts[index];
        // A response may interleave text and media parts. Select the first matching part.
        if (key === '*' && Array.isArray(value)) {
            for (const item of value) {
                const found = atPath(item, parts.slice(index + 1));
                if (found !== undefined && found !== null) return found;
            }
            return undefined;
        }
        if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
        value = value[key];
    }
    return value;
}
function endpoint(baseUrl, requestPath, variables = {}, definitions) {
    if (typeof requestPath !== 'string' || requestPath.length > 2000 || /[\r\n\\]/.test(requestPath) || /^\w+:|^\/\//.test(requestPath)) fail('Use a relative API path');
    if (/[?&](?:api[_-]?key|access[_-]?token|token|key|secret|password)=/i.test(requestPath)) fail('Credentials belong in provider authentication, not API URLs');
    const withParameters = requestPath.replace(/\{param:([A-Za-z][A-Za-z0-9_-]*)\}/g, (_, key) => {
        if (definitions) { if (!Object.hasOwn(definitions, key)) fail('Unknown URL parameter reference'); return 'fixture'; }
        const value = variables.parameters?.[key];
        if (!['string','number','boolean'].includes(typeof value)) fail(`URL parameter ${key} is missing or not scalar`);
        return encodeURIComponent(value);
    });
    const rendered = withParameters.replace(/\{(id|model)\}/g, (_, key) => encodeURIComponent(variables[key] ?? 'fixture'));
    if (/[{}]/.test(rendered)) fail('Only {id}, {model} and {param:name} are supported in API paths');
    if (rendered.length > 8000) fail('Rendered API path is too long');
    const base = new URL(baseUrl);
    const url = new URL(baseUrl.replace(/\/+$/, '') + '/' + rendered.replace(/^\/+/, ''));
    if (url.origin !== base.origin || url.username || url.password || url.hash) fail('API paths must stay on the configured provider');
    return url;
}
function validateTemplate(value, definitions, depth = 0) {
    if (depth > 24) fail('Request template is too deeply nested');
    if (Array.isArray(value)) { if (value.length > 200) fail('Request template array is too large'); value.forEach(item => validateTemplate(item, definitions, depth + 1)); return; }
    if (object(value)) {
        const entries = Object.entries(value);
        if (entries.some(([key]) => RESERVED.has(key))) fail('Reserved request field');
        if (entries.some(([key]) => /^(authorization|api[_-]?key|access[_-]?token|secret|password|cookie)$/i.test(key))) fail('Credentials belong in provider authentication, not request templates');
        if (entries.some(([key]) => key.startsWith('$'))) {
            if (entries.length !== 1) fail('Template references must stand alone');
            const [key, target] = entries[0];
            if (key === '$param' && typeof target === 'string' && Object.hasOwn(definitions, target)) return;
            if ((key === '$model' || key === '$params') && target === true) return;
            fail('Unknown request template reference');
        }
        entries.forEach(([, item]) => validateTemplate(item, definitions, depth + 1));
    } else if (!['string','number','boolean'].includes(typeof value) && value !== null) fail('Request template must contain JSON values');
}
function renderTemplate(value, parameters, remoteModel) {
    let budget = 4 * 1024 * 1024;
    const consume = value => { budget -= Buffer.byteLength(JSON.stringify(value)); if (budget < 0) fail('Rendered media request exceeds 4MiB'); return clone(value); };
    function render(value) {
        budget -= 2; if (budget < 0) fail('Rendered media request exceeds 4MiB');
        if (Array.isArray(value)) return value.map(render).filter(item => item !== undefined);
        if (!object(value)) return consume(value);
        if (Object.hasOwn(value, '$param')) return parameters[value.$param] === undefined ? undefined : consume(parameters[value.$param]);
        if (value.$model === true) return consume(remoteModel);
        if (value.$params === true) return consume(parameters);
        return Object.fromEntries(Object.entries(value).map(([key, item]) => { consume(key); return [key, render(item)]; }).filter(([, item]) => item !== undefined));
    }
    return render(value);
}
function validateHttp(raw, definitions, kind) {
    keys(raw, ['path', 'body', 'response', 'poll', 'timeoutMs'], 'HTTP contract');
    endpoint('https://example.invalid', raw.path, {}, definitions);
    if (!object(raw.body)) fail('Request body template must be an object');
    if (JSON.stringify(raw.body).length > 32000) fail('Request template is too large');
    validateTemplate(raw.body, definitions);
    const response = raw.response;
    keys(response, ['type', 'path', 'mimeType'], 'response');
    if (!['base64','url','binary','image-json'].includes(response.type)) fail('Unsupported response type');
    if (response.type === 'image-json' && kind !== 'image') fail('Standard image JSON output requires an image model');
    const mimeType = response.mimeType || 'auto';
    if (mimeType !== 'auto' && (!MIME_TYPES.includes(mimeType) || !mimeType.startsWith((kind === 'tts' ? 'audio' : kind) + '/'))) fail('Output MIME type does not match media kind');
    if (response.type !== 'binary') jsonPath(response.path);
    const http = { path: raw.path, body: clone(raw.body), response: { type: response.type, mimeType, ...(response.type !== 'binary' ? { path: clone(response.path) } : {}) }, timeoutMs: raw.timeoutMs ?? (raw.poll ? 1800000 : 180000) };
    if (!Number.isInteger(http.timeoutMs) || http.timeoutMs < 1000 || http.timeoutMs > 1800000) fail('HTTP timeout must be 1000–1800000 ms');
    if (raw.poll) {
        const poll = raw.poll;
        keys(poll, ['idPath','path','urlPath','statusPath','pending','succeeded','failed','intervalMs'], 'polling');
        jsonPath(poll.idPath, 'task ID path'); jsonPath(poll.statusPath, 'status path');
        if (Boolean(poll.path) === Boolean(poll.urlPath)) fail('Choose a polling path or response URL path');
        if (poll.path) { endpoint('https://example.invalid', poll.path, {}, definitions); if (!poll.path.includes('{id}')) fail('Polling path requires {id}'); }
        else jsonPath(poll.urlPath, 'poll URL path');
        if (response.type === 'binary') fail('Polling requires a JSON result containing a URL or base64');
        const statuses = [];
        for (const key of ['pending','succeeded','failed']) {
            if (!Array.isArray(poll[key]) || !poll[key].length || poll[key].length > 30 || poll[key].some(value => value !== null && !['string','number','boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value) || typeof value === 'string' && (!value || value.length > 80))) fail(`Invalid polling ${key} states`);
            statuses.push(...poll[key]);
        }
        if (new Set(statuses).size !== statuses.length) fail('Polling state groups must not overlap');
        const intervalMs = poll.intervalMs ?? 5000;
        if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60000) fail('Polling interval must be 1000–60000 ms');
        http.poll = { ...clone(poll), intervalMs };
    }
    return http;
}
function detectMime(bytes) {
    if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    if (bytes.toString('ascii', 0, 4) === 'RIFF') {
        if (bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
        if (bytes.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
    }
    if (bytes.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
    if (bytes.toString('ascii', 0, 3) === 'ID3' || bytes[0] === 255 && (bytes[1] & 224) === 224) return 'audio/mpeg';
    fail('Media output does not match a supported file signature', 502);
}
async function readBounded(response, maximum) {
    const declared = Number(response.headers?.get?.('content-length'));
    if (declared > maximum) { response.body?.destroy?.(); fail('Media response is too large', 502); }
    const chunks = []; let length = 0;
    try {
        if (response.body?.[Symbol.asyncIterator]) {
            for await (const chunk of response.body) {
                length += chunk.length; if (length > maximum) fail('Media response is too large', 502);
                chunks.push(Buffer.from(chunk));
            }
            return Buffer.concat(chunks);
        }
        const bytes = response.arrayBuffer ? Buffer.from(await response.arrayBuffer()) : response.buffer ? await response.buffer() : Buffer.from(JSON.stringify(await response.json()));
        if (bytes.length > maximum) fail('Media response is too large', 502);
        return bytes;
    } catch (error) { response.body?.destroy?.(); if (error.statusCode) throw error; fail('Media response was interrupted; check provider before resubmitting', 502); }
}
async function readJson(response, maximum = MAX_JSON) {
    const bytes = await readBounded(response, maximum);
    try { return JSON.parse(bytes.toString('utf8')); } catch { fail('Media service returned invalid JSON', 502); }
}
function authHeaders(provider, key) {
    if (provider.auth.mode === 'none') return {};
    if (!key) fail('Media provider API Key is missing', 503);
    return provider.auth.mode === 'bearer' ? { Authorization: `Bearer ${key}` } : { [provider.auth.header]: (provider.auth.prefix || '') + key };
}
class MediaHttpExecutor {
    constructor(options = {}) { this.fetch = options.fetch || require('node-fetch'); this.delay = options.delay || delay; }
    async request(url, options, maximum) {
        let response;
        try { response = await this.fetch(String(url), { ...options, redirect: 'manual', size: maximum }); }
        catch { fail('Media request failed or timed out; check provider before resubmitting', 502); }
        if (!response.ok) { response.body?.destroy?.(); fail(`Media service returned HTTP ${response.status}; the request was not replayed`, 502); }
        return response;
    }
    async download(value, provider, key, signal) {
        let url;
        if (typeof value !== 'string' || value.length > 16000) fail('Invalid media output URL', 502);
        try { url = new URL(value, provider.baseUrl + '/'); } catch { fail('Media service returned an invalid output URL', 502); }
        const origin = new URL(provider.baseUrl).origin;
        const allowed = new Set([origin, ...provider.downloadOrigins]);
        for (let attempt = 0; attempt <= 3; attempt++) {
            if (url.href.length > 16000 || key.length >= 4 && (url.href.includes(key) || url.href.includes(encodeURIComponent(key)))) fail('Output URL must not contain the provider API Key or exceed URL limits', 502);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !allowed.has(url.origin)) fail('Output download origin is not allowed by this provider; check its existing task before changing configuration', 502);
            let response;
            try { response = await this.fetch(url.href, { method: 'GET', redirect: 'manual', size: MAX_OUTPUT, signal, headers: url.origin === origin ? authHeaders(provider, key) : {} }); }
            catch { fail('Media output download failed or timed out; check the existing task', 502); }
            if ([301,302,303,307,308].includes(response.status)) {
                const location = response.headers.get('location'); response.body?.destroy?.();
                try { url = new URL(location, url); } catch { fail('Invalid output redirect', 502); }
                continue;
            }
            if (!response.ok) { response.body?.destroy?.(); fail(`Media download returned HTTP ${response.status}`, 502); }
            return readBounded(response, MAX_OUTPUT);
        }
        fail('Too many media output redirects', 502);
    }
    async execute({ provider, key, model, parameters, progress = () => {} }) {
        const http = model.http;
        const signal = AbortSignal.timeout(http.timeoutMs);
        const headers = { 'Content-Type': 'application/json', ...authHeaders(provider, key) };
        const requestBody = renderTemplate(http.body, parameters, model.remoteModel);
        let taskId;
        try {
            progress({ stage: 'submitting' });
            let response = await this.request(endpoint(provider.baseUrl, http.path, { model: model.remoteModel, parameters }), { method: 'POST', headers, body: JSON.stringify(requestBody), signal }, http.response.type === 'binary' ? MAX_OUTPUT : MAX_JSON);
            let data = http.response.type === 'binary' ? null : await readJson(response);
            if (http.poll) {
                const poll = http.poll, rawId = atPath(data, poll.idPath);
                if (!['string','number'].includes(typeof rawId) || !/^[A-Za-z0-9_./:+-]{1,500}$/.test(String(rawId)) || key.length >= 4 && String(rawId).includes(key)) fail('Media service did not return a valid task ID; do not resubmit automatically', 502);
                taskId = String(rawId);
                let pollUrl;
                if (poll.path) pollUrl = endpoint(provider.baseUrl, poll.path, { id: taskId, model: model.remoteModel, parameters });
                else {
                    const rawUrl = atPath(data, poll.urlPath);
                    if (typeof rawUrl !== 'string' || rawUrl.length > 16000) fail('Media service did not return a valid polling URL', 502);
                    try { pollUrl = new URL(rawUrl, provider.baseUrl + '/'); } catch { fail('Invalid polling URL', 502); }
                }
                if (pollUrl.origin !== new URL(provider.baseUrl).origin || pollUrl.username || pollUrl.password || pollUrl.hash) fail('Polling URL must stay on the configured provider', 502);
                while (true) {
                    signal.throwIfAborted(); progress({ stage: 'polling', taskId });
                    response = await this.request(pollUrl, { method: 'GET', headers: authHeaders(provider, key), signal }, MAX_JSON);
                    data = await readJson(response);
                    const state = atPath(data, poll.statusPath) ?? null;
                    if (poll.succeeded.includes(state)) break;
                    if (poll.failed.includes(state)) fail('Media task failed or was cancelled at the provider', 502);
                    if (!poll.pending.includes(state)) fail('Media service returned an unknown task state', 502);
                    await this.delay(poll.intervalMs, undefined, { signal });
                }
            }
            progress({ stage: 'downloading', ...(taskId ? { taskId } : {}) });
            let bytes;
            if (http.response.type === 'binary') bytes = await readBounded(response, MAX_OUTPUT);
            else {
                let value = atPath(data, http.response.path), outputType = http.response.type;
                if (outputType === 'image-json') {
                    if (typeof value?.b64_json === 'string' && value.b64_json) { value = value.b64_json; outputType = 'base64'; }
                    else { value = value?.url; outputType = 'url'; }
                }
                if (typeof value !== 'string') fail('Media result path did not contain an output', 502);
                if (outputType === 'url') bytes = await this.download(value, provider, key, signal);
                else {
                    if (value.length > MAX_JSON || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail('Media output is not bounded base64', 502);
                    bytes = Buffer.from(value, 'base64');
                }
            }
            if (!bytes.length || bytes.length > MAX_OUTPUT) fail('Media output is empty or too large', 502);
            const mimeType = detectMime(bytes);
            if (!mimeType.startsWith((model.kind === 'tts' ? 'audio' : model.kind) + '/') || http.response.mimeType !== 'auto' && http.response.mimeType !== mimeType) fail('Media output does not match its MIME type or kind', 502);
            return { bytes, mimeType, ...(taskId ? { taskId } : {}) };
        } catch (error) {
            const message = signal.aborted ? 'Media request timed out; its remote task may still be running' : error.statusCode ? error.message : 'Media request failed; check the existing task before submitting again';
            throw Object.assign(new Error(message), { statusCode: error.statusCode || 502, ...(taskId ? { taskId } : {}) });
        }
    }
}
module.exports = { MediaHttpExecutor, validateHttp, renderTemplate, validateTemplate, jsonPath, atPath, endpoint, authHeaders, readJson, readBounded, detectMime, keys, object, fail, MIME_TYPES, MAX_OUTPUT };
