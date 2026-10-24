#!/usr/bin/env node
// Measurement only. No candidate implementation is installed or patched.
// node test/benchmarks/batch4-storage.cjs --out /absolute/private/output [--group document|media] [--processes 3] [--warm 2] [--cases document-1x100,media-4000]
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { spawn } = require('node:child_process');
const h = require('../helpers/batch4-storage-fixtures.cjs');

async function setup(config) {
    const attempts = h.prohibitNetworkAndProcesses(), start = performance.now();
    h.directories(config.base);
    const fixture = config.group === 'document' ? await h.prepareDocuments(config.base, config.sizes) : h.prepareMedia(config.base, config.count);
    assert.deepEqual(attempts, { network: 0, subprocess: 0 });
    const result = { fixture, setupMs: performance.now() - start, maxRSSKiB: process.resourceUsage().maxRSS, attempts };
    fs.writeFileSync(path.join(config.base, 'fixture.json'), JSON.stringify(fixture, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(result));
}
async function worker(config) {
    const attempts = h.prohibitNetworkAndProcesses(), startup = performance.now();
    const fixture = JSON.parse(fs.readFileSync(path.join(config.base, 'fixture.json'), 'utf8'));
    assert.equal(os.homedir(), path.join(config.base, 'home'));
    let uploads, references, chat, model;
    if (fixture.group === 'document') {
        const { PiSessionStore, getSdk } = require('../../server/pi-session-store');
        const { DocumentUploads } = require('../../server/pi-document-uploads');
        const sdk = await getSdk(); assert.equal(fs.realpathSync(sdk.getAgentDir()), path.join(config.base, 'agent'));
        uploads = new DocumentUploads({ store: new PiSessionStore(), root: fixture.root,
            supervisor: { removing: new Set(), moving: new Set(), getActiveWorker: () => null },
            protectedDocuments: async ({ nativeScope }) => {
                assert.equal(nativeScope.complete, true); assert.deepEqual(nativeScope.projects, [fixture.cwd]);
                return JSON.parse(fs.readFileSync(path.join(config.base, 'queue', 'protected-documents.json'), 'utf8'));
            },
            storageGuard: { acquire: () => ({ check() {}, release() {} }) } });
    } else {
        const { MediaReferences } = require('../../server/media-references');
        const { MediaLabService } = require('../../server/media-lab-service');
        const { MediaChatRequests } = require('../../server/media-chat-requests');
        references = new MediaReferences({ directory: fixture.directory });
        model = { id: 'synthetic-storage', name: 'Synthetic local planning model', kind: 'image', adapter: 'manual',
            parameters: Object.fromEntries([0, 1, 2].map(index => ['images' + index, { type: 'image', multiple: true, maxItems: 8 }])) };
        const lab = new MediaLabService({ profile: { models: [model], directory: config.base }, references,
            videoService: { getConfig: async () => ({ models: [] }) }, ttsService: { getPublicConfig: () => ({ providers: [] }) } });
        chat = new MediaChatRequests({ lab, file: path.join(config.base, 'queue', 'media-chat.json') });
        assert.equal(references.maxFiles, 5000); assert.equal(references.maxBytes, 4 * 1024 ** 3);
    }
    const startupMs = performance.now() - startup, observer = h.observations(), samples = [];
    try {
        for (let iteration = 0; iteration <= config.warm; iteration++) {
            let input, expectedRefs = [], inputBytes = 0;
            if (fixture.group === 'media' && config.action === 'intern') {
                const urls = Array.from({ length: config.batch }, (_, index) => {
                    const bytes = h.png(`new-process-${config.processIndex}-sample-${iteration}-item-${index}`);
                    inputBytes += bytes.length; expectedRefs.push('mediaref:' + h.sha(bytes));
                    return 'data:image/png;base64,' + bytes.toString('base64');
                });
                input = Object.fromEntries([0, 1, 2].map(index => ['images' + index, urls.slice(index * 8, (index + 1) * 8)]).filter(([, values]) => values.length));
                // Verify real per-field, total-count and combined-byte budgets outside the timed intern seam.
                require('../../server/media-lab-service').validateParameters(model.parameters, input);
            }
            const measured = await observer.measure(async () => {
                if (fixture.group === 'document') {
                    if (config.action === 'usage') return uploads.storage.usage({ cwd: fixture.cwd });
                    const inventory = await uploads.storage.inventory(fixture.cwd);
                    return { cwd: inventory.cwd, count: inventory.count, totalBytes: inventory.totalBytes, items: uploads.storage.rows(inventory) };
                }
                return config.action === 'usage' ? references.usage() : chat.intern(model.id, input);
            });
            const value = measured.value;
            if (fixture.group === 'document') {
                assert.equal(value.count, fixture.count); assert.equal(value.totalBytes, fixture.bytes);
                assert.equal(value.items.length, fixture.count);
                if (config.action === 'usage') {
                    assert.equal(value.complete, true); assert.equal(value.warning, null);
                    assert.equal(value.items.filter(item => item.savedReference === 'protected').length, fixture.protectedCount);
                }
            } else if (config.action === 'usage') assert.deepEqual(value, { files: fixture.count, bytes: fixture.bytes });
            else {
                assert.deepEqual(Object.values(value).flat(), expectedRefs);
                assert.deepEqual(references.usage(), { files: fixture.count + config.batch, bytes: fixture.bytes + inputBytes });
                for (const ref of expectedRefs) {
                    const file = path.join(fixture.directory, ref.slice(9) + '.png');
                    assert.equal(h.sha(fs.readFileSync(file)), ref.slice(9));
                    fs.unlinkSync(file); // Restore the exact initial count outside the measurement.
                }
                assert.deepEqual(references.usage(), { files: fixture.count, bytes: fixture.bytes });
            }
            samples.push({ iteration, phase: iteration === 0 ? 'fresh-process-first-call' : 'same-process-warm-call',
                input: fixture.group === 'document' ? { count: fixture.count, bytes: fixture.bytes, sizes: fixture.sizes, manifestBytes: fixture.manifestBytes, nativeBytes: fixture.nativeBytes }
                    : { existingFiles: fixture.count, existingBytes: fixture.bytes, newFiles: config.action === 'intern' ? config.batch : 0, newBytes: inputBytes,
                        parameterJsonBytes: input ? Buffer.byteLength(JSON.stringify(input)) : 0 },
                outputJsonBytes: Buffer.byteLength(JSON.stringify(value)), outputSha256: h.sha(JSON.stringify(value)), ...measured.metrics });
        }
        assert.equal(uploads?.operations.size || 0, 0); assert.equal(uploads?.pool.jobs.size || 0, 0);
        assert.equal(observer.openSyncDescriptors(), 0); assert.deepEqual(attempts, { network: 0, subprocess: 0 });
        console.log(JSON.stringify({ case: config.case, action: config.action, batch: config.batch || null, processIndex: config.processIndex,
            node: process.version, platform: process.platform, arch: process.arch, startupMs, attempts, samples,
            isolation: { home: os.homedir(), agent: process.env.PI_CODING_AGENT_DIR, project: process.env.PI_PROJECT_ROOTS,
                media: process.env.PI_MEDIA_DATA_DIR, queue: path.join(config.base, 'queue'), envKeys: Object.keys(h.environment(config.base)).sort() },
            cleanup: { activeUploads: uploads?.operations.size || 0, parserJobs: uploads?.pool.jobs.size || 0, observedSyncDescriptors: observer.openSyncDescriptors(), fixtureCountRestored: true } }));
    } finally { observer.restore(); await uploads?.dispose(); }
}
function child(mode, config, env) {
    return new Promise((resolve, reject) => {
        const processChild = spawn(process.execPath, ['--expose-gc', __filename, mode, JSON.stringify(config)], { cwd: path.resolve(__dirname, '../..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        processChild.stdout.on('data', chunk => { stdout += chunk; }); processChild.stderr.on('data', chunk => { stderr += chunk; });
        processChild.once('error', reject);
        processChild.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
}
function quantile(values, fraction) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.ceil((sorted.length - 1) * fraction)]; }
function summary(raw) {
    return ['fresh-process-first-call', 'same-process-warm-call'].map(phase => {
        const samples = raw.flatMap(record => record.samples.filter(sample => sample.phase === phase));
        const range = fn => { const values = samples.map(fn); return { min: Math.min(...values), median: quantile(values, 0.5), max: Math.max(...values) }; };
        return { phase, samples: samples.length, elapsedMs: range(s => s.elapsedMs), rssPeakDeltaMiB: range(s => s.rssPeakDeltaBytes / h.MiB),
            absolutePeakRSSMiB: range(s => s.peak.rss / h.MiB), processMaxRSSMiB: range(s => s.maxRSSKiBAfter / 1024),
            eventLoopMaxMs: range(s => s.eventLoopMaxMs), heartbeatGapMs: range(s => s.maxHeartbeatGapMs),
            statSyncCalls: range(s => s.counts.statSync || 0), readdirSyncCalls: range(s => s.counts.readdirSync || 0),
            originalReadBytes: range(s => s.counts.originalReadBytes || 0), originalReadCalls: range(s => s.counts.originalReadCalls || 0),
            concatBytes: range(s => s.counts.concatBytes || 0), descriptorPaths: range(s => (s.counts.descriptorPathSync || 0) + (s.counts.descriptorPathAsync || 0)),
            outputJsonBytes: range(s => s.outputJsonBytes) };
    });
}
async function main(args) {
    const options = { processes: 3, warm: 2, group: 'all' };
    for (let index = 0; index < args.length; index += 2) {
        const key = args[index], value = args[index + 1];
        if (!['--out', '--group', '--processes', '--warm', '--cases'].includes(key) || !value) throw new Error('Expected --out PATH [--group document|media] [--processes N] [--warm N] [--cases comma-separated-ids]');
        options[key.slice(2)] = ['--processes', '--warm'].includes(key) ? Number(value) : value;
    }
    assert.ok(options.out && path.isAbsolute(options.out)); assert.ok(['all', 'document', 'media'].includes(options.group));
    assert.ok(Number.isInteger(options.processes) && options.processes >= 1 && options.processes <= 10);
    assert.ok(Number.isInteger(options.warm) && options.warm >= 0 && options.warm <= 10);
    const out = path.resolve(options.out); fs.mkdirSync(out, { recursive: true, mode: 0o700 });
    if (fs.existsSync(path.join(out, 'run.json'))) throw new Error('Use a new output directory for each run');
    const plan = [
        ...[[1, 1], [1, 32], [1, 100], [4, 32], [32, 1]].map(([count, size]) => ({ case: `document-${count}x${size}`, group: 'document', sizes: Array(count).fill(size * h.MiB) })),
        ...[32, 512, 4000].map(count => ({ case: `media-${count}`, group: 'media', count }))
    ].filter(item => (options.group === 'all' || options.group === item.group) && (!options.cases || options.cases.split(',').includes(item.case)));
    assert.ok(plan.length);
    const run = { startedAt: new Date().toISOString(), options, node: process.version, platform: process.platform, arch: process.arch, release: os.release(), cpus: os.cpus().length,
        loadAverageAtStart: os.loadavg(), execPath: process.execPath, notes: [
            'Concurrent first-stage lane measurements are diagnostic only; no after/candidate implementation is measured.',
            'Each fixture is created/fsynced in a separate setup child. Measurement processes never hold the large fixture-construction buffer.',
            'Fresh process excludes imports and SDK initialization; OS page/dentry cache is uncontrolled and already touched by setup. Warm calls follow explicit GC.',
            'Read counters observe production fs/handle calls; Buffer.concat observation captures large synchronous allocation. Instrumentation is common to every sample.',
            'Timing includes production operation and returned projection construction, excludes JSON encoding, input preparation, validation assertions and cleanup.',
            'RSS is sampled at 1 ms, after the operation and at large Buffer.concat. maxRSS is process lifetime, including imports; it is not a per-call delta.',
            'Use heartbeatGapMs for blocking comparisons: monitorEventLoopDelay can miss the first synchronous span before its first observation.',
            'CPU counters include the short observer setup/drain timers; elapsedMs excludes them.',
            'All child environments use an allowlist and independent paths; all network and further subprocess creation is prohibited.'
        ], setups: [], results: [], cleanup: [], commands: [] };
    fs.writeFileSync(path.join(out, 'run.json'), JSON.stringify(run, null, 2), { mode: 0o600 });
    let failed = false;
    try {
        for (const item of plan) {
            const base = path.join(out, 'fixtures', item.case); fs.mkdirSync(base, { recursive: true, mode: 0o700 }); h.directories(base);
            try {
                const setupResult = await child('--setup', { ...item, base }, h.environment(base));
                fs.writeFileSync(path.join(out, item.case + '-setup.log'), setupResult.stdout + setupResult.stderr, { mode: 0o600 });
                run.commands.push({ mode: 'setup', case: item.case, exitCode: setupResult.code, signal: setupResult.signal });
                if (setupResult.code !== 0) throw new Error('Setup failed: ' + item.case);
                const prepared = JSON.parse(setupResult.stdout); run.setups.push({ case: item.case, ...prepared });
                fs.writeFileSync(path.join(out, item.case + '-fixture.json'), JSON.stringify(prepared.fixture, null, 2), { mode: 0o600 });
                const operations = item.group === 'document' ? [{ action: 'inventory' }, { action: 'usage' }] : [{ action: 'usage' }, ...[1, 8, 20].map(batch => ({ action: 'intern', batch }))];
                for (const operation of operations) {
                    const records = [], name = item.case + '-' + operation.action + (operation.batch ? '-' + operation.batch : '');
                    for (let processIndex = 0; processIndex < options.processes; processIndex++) {
                        const config = { base, case: item.case, ...operation, processIndex, warm: options.warm };
                        const result = await child('--worker', config, h.environment(base));
                        fs.writeFileSync(path.join(out, name + '-' + processIndex + '.stdout.json'), result.stdout, { mode: 0o600 });
                        fs.writeFileSync(path.join(out, name + '-' + processIndex + '.stderr.log'), result.stderr, { mode: 0o600 });
                        run.commands.push({ mode: 'worker', case: item.case, ...operation, processIndex, exitCode: result.code, signal: result.signal });
                        if (result.code !== 0) throw new Error('Measurement failed: ' + name + '-' + processIndex);
                        records.push(JSON.parse(result.stdout));
                    }
                    const result = { case: item.case, ...operation, summary: summary(records) }; run.results.push(result);
                    console.log(JSON.stringify(result));
                    fs.writeFileSync(path.join(out, 'run.json'), JSON.stringify(run, null, 2), { mode: 0o600 });
                }
            } finally {
                fs.rmSync(base, { recursive: true, force: true }); run.cleanup.push({ path: base, removed: !fs.existsSync(base) });
            }
        }
    } catch (error) { failed = true; run.error = error.stack; throw error; }
    finally {
        run.finishedAt = new Date().toISOString(); run.loadAverageAtEnd = os.loadavg(); run.exitCode = failed ? 1 : 0;
        fs.rmSync(path.join(out, 'fixtures'), { recursive: true, force: true });
        run.fixtureParentRemoved = !fs.existsSync(path.join(out, 'fixtures'));
        fs.writeFileSync(path.join(out, 'run.json'), JSON.stringify(run, null, 2), { mode: 0o600 });
    }
}
const args = process.argv.slice(2);
const action = args[0] === '--setup' ? setup(JSON.parse(args[1])) : args[0] === '--worker' ? worker(JSON.parse(args[1])) : main(args);
action.catch(error => { console.error(error.stack); process.exitCode = 1; });
