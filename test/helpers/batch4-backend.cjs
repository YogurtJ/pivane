'use strict';

// Measurement helpers only. No production module or dependency is written.
const fs = require('node:fs');
const path = require('node:path');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const Module = require('node:module');
const assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '../..');
const profileId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = data => createHash('sha256').update(data).digest('hex');

function denyNetwork() {
    const denied = () => { throw new Error('batch4 synthetic benchmark forbids network access'); };
    globalThis.fetch = denied;
    for (const name of ['node:http', 'node:https']) {
        const api = require(name); api.request = denied; api.get = denied;
    }
    const net = require('node:net'); net.connect = denied; net.createConnection = denied;
    require('node:dgram').createSocket = denied;
}

async function measure(operation, verify, { samples = 3 } = {}) {
    const rows = [];
    for (let i = 0; i <= samples; i++) {
        global.gc?.();
        await delay(3);
        // Exclude explicit GC and semantic verification from loop-delay monitoring.
        const histogram = monitorEventLoopDelay({ resolution: 1 });
        histogram.enable();
        await delay(3);
        const before = process.memoryUsage();
        const queuedAt = performance.now();
        const timer = new Promise(resolve => setTimeout(() => resolve(performance.now() - queuedAt), 0));
        const started = performance.now();
        const value = await operation();
        const milliseconds = performance.now() - started;
        const after = process.memoryUsage();
        const timerDelayMs = await timer;
        await delay(3);
        histogram.disable();
        const eventLoop = { resolutionMs: 1, meanMs: histogram.mean / 1e6, maxMs: histogram.max / 1e6,
            p99Ms: histogram.percentile(99) / 1e6 };
        // Assertions and response encoding are excluded unless operation explicitly includes them.
        const semantic = await verify(value);
        rows.push({ condition: i ? 'warm' : 'first-call-os-cache-uncontrolled', milliseconds,
            timerDelayMs, eventLoop, rssBefore: before.rss, rssAfter: after.rss, heapUsedBefore: before.heapUsed,
            heapUsedAfter: after.heapUsed, externalBefore: before.external, externalAfter: after.external, semantic });
    }
    const warm = rows.slice(1).map(row => row.milliseconds).sort((a, b) => a - b);
    return { rows, warmMedianMs: warm[Math.floor(warm.length / 2)],
        eventLoop: { resolutionMs: 1, excludesExplicitGcAndVerification: true,
            maxMs: Math.max(...rows.map(row => row.eventLoop.maxMs)),
            maxSampleP99Ms: Math.max(...rows.map(row => row.eventLoop.p99Ms)) },
        peakRssBytesIncludingSetup: process.resourceUsage().maxRSS * 1024 };
}

// Expose the exact private functions in memory; preserve all original source bytes on disk.
function learningInternals() {
    const filename = path.join(repo, 'server/profile-memory/learning-service.js');
    const source = fs.readFileSync(filename, 'utf8');
    const loaded = new Module(filename, module);
    loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    loaded._compile(source + '\nmodule.exports.batch4Measurement = { pairs, effectiveText };\n', filename);
    return { ...loaded.exports.batch4Measurement, sourceSha256: hash(source) };
}

function countedBranch(branch) {
    const counts = { traversals: 0, visited: 0 };
    const counted = new Proxy(branch, { get(target, key, receiver) {
        if (key !== Symbol.iterator) return Reflect.get(target, key, receiver);
        return function* () { counts.traversals++; for (const entry of target) { counts.visited++; yield entry; } };
    } });
    return { branch: counted, counts };
}

function assistant(content = 'Synthetic answer') {
    return { role: 'assistant', content: [{ type: 'text', text: content }], timestamp: 1700000000000,
        api: 'openai-completions', provider: 'fixture', model: 'synthetic', stopReason: 'stop',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

async function nativeHistory(count, { edits = false, textBytes = 64, directory = process.env.PI_CODING_AGENT_DIR } = {}) {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const manager = SessionManager.create(process.env.PI_PROJECT_ROOTS, path.join(directory, 'sessions'));
    // The SDK writes its initial metadata at the first assistant response.
    const ids = [];
    for (let i = 0; i < count; i++) {
        const user = manager.appendMessage({ role: 'user', content: `question-${i}:` + 'u'.repeat(textBytes), timestamp: 1700000000000 + i });
        const reply = manager.appendMessage(assistant(`answer-${i}:` + 'a'.repeat(textBytes)));
        if (edits) manager.appendContextEdit(user, { content: `edited question-${i}` });
        ids.push({ user, reply });
    }
    const file = manager.getSessionFile();
    assert.ok(file && fs.existsSync(file));
    return { manager: SessionManager.open(file), ids, file, bytes: fs.statSync(file).size };
}

function sqliteProbe(Database) {
    const original = Database.prototype.prepare;
    const counts = {}, rowsReturned = {};
    Database.prototype.prepare = function (sql, ...args) {
        const statement = original.call(this, sql, ...args);
        for (const name of ['get', 'all', 'run']) {
            const invoke = statement[name];
            statement[name] = function (...values) {
                const key = `${name}: ${sql.replace(/\s+/g, ' ').trim()}`;
                counts[key] = (counts[key] || 0) + 1;
                const result = invoke.apply(this, values);
                if (Array.isArray(result)) rowsReturned[key] = (rowsReturned[key] || 0) + result.length;
                return result;
            };
        }
        return statement;
    };
    return { counts, rowsReturned, restore: () => { Database.prototype.prepare = original; } };
}

module.exports = { repo, profileId, delay, hash, denyNetwork, measure, learningInternals, countedBranch,
    assistant, nativeHistory, sqliteProbe };
