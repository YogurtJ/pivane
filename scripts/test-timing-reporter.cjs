// Keep Node's normal TAP output; append bounded timing diagnostics from its events.
const { tap } = require('node:test/reporters');
const path = require('node:path');
module.exports = async function* timingReporter(source) {
    const files = new Map();
    const cases = [];
    async function* observe() {
        for await (const event of source) {
            const data = event.data;
            if (event.type === 'test:summary' && data.file && Number.isFinite(data.duration_ms)) {
                files.set(data.file, data.duration_ms);
            }
            if (['test:pass', 'test:fail'].includes(event.type) && data.file && Number.isFinite(data.details?.duration_ms)) {
                cases.push({ file: data.file, name: data.name, ms: data.details.duration_ms });
                cases.sort((a, b) => b.ms - a.ms);
                if (cases.length > 10) cases.pop();
            }
            yield event;
        }
    }
    yield* tap(observe());
    const label = value => JSON.stringify(String(value));
    yield '# Timing diagnostics (Node-reported durations; nested cases overlap, not additive)\n';
    if (files.size) {
        yield '# Slowest files (up to 10; excludes parent runner overhead)\n';
        for (const [file, ms] of [...files].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
            yield `# ${ms.toFixed(1)} ms ${label(path.relative(process.cwd(), file))}\n`;
        }
    } else yield '# Per-file summaries unavailable on this Node version; use case timings below\n';
    yield '# Slowest cases/suites (up to 10; setup outside cases may be excluded)\n';
    for (const row of cases) yield `# ${row.ms.toFixed(1)} ms ${label(path.relative(process.cwd(), row.file))} ${label(row.name)}\n`;
};
