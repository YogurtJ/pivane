const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
// Inject races at the shared opener so native Windows handles are covered too.
const fileIo = require('../server/pi-file-io');
const fsp = { get open() { return fileIo.openRead; }, set open(value) { fileIo.openRead = value; } };
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-file-viewer-')));
const project = path.join(temporary, 'project'), agent = path.join(temporary, 'private-agent');
fs.mkdirSync(project); fs.mkdirSync(agent);
process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = temporary;
process.env.PI_WEB_DEFERRED_FILE = path.join(temporary, 'deferred.json'); process.env.PI_OFFLINE = '1'; process.env.PI_WEB_TOKEN = 'file-fixture';
const { PiSessionStore } = require('../server/pi-session-store');
const { PiFileService } = require('../server/pi-file-service');
const service = new PiFileService(new PiSessionStore());
const content = '\ufeff# 报告\r\n中文\u2028line\u2029tail\r\n<script>alert(1)</script>\n';
fs.writeFileSync(path.join(project, '报告.md'), content);
const read = (file, cwd = project) => service.content({ cwd, path: file });
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

test('file viewer reads exact bounded UTF-8 text, empty files, versions and in-project symlinks without writes', async () => {
    const before = fs.statSync(path.join(project, '报告.md'));
    const a = await read('报告.md');
    assert.equal(a.content, content); assert.equal(a.size, Buffer.byteLength(content)); assert.match(a.revision, /^[a-f0-9]{64}$/);
    assert.equal(a.absolutePath, path.join(project, '报告.md'));
    assert.equal((await read(a.absolutePath)).revision, a.revision);
    const caseAlias = path.join(temporary, 'PROJECT');
    if (fs.existsSync(caseAlias)) {
        const alternate = await read('报告.MD', caseAlias);
        assert.equal(alternate.cwd, project); assert.equal(alternate.content, content);
    }
    fs.symlinkSync('报告.md', path.join(project, 'alias.md'));
    assert.equal((await read('alias.md')).path, '报告.md');
    fs.writeFileSync(path.join(project, 'empty.txt'), ''); assert.equal((await read('empty.txt')).content, '');
    assert.equal(fs.statSync(path.join(project, '报告.md')).mtimeMs, before.mtimeMs);
    fs.writeFileSync(path.join(project, '报告.md'), content + 'new');
    const b = await read('报告.md'); assert.notEqual(b.revision, a.revision); assert.equal(b.content, content + 'new');
});

test('file viewer rejects out-of-project, private paths and aliases, binary/invalid UTF-8, large and nonregular files', async () => {
    fs.writeFileSync(path.join(temporary, 'outside.txt'), 'outside');
    fs.writeFileSync(path.join(agent, 'innocent.txt'), 'private directory fixture');
    fs.symlinkSync('../outside.txt', path.join(project, 'outside-link.txt'));
    fs.symlinkSync(agent, path.join(project, 'agent-link'));
    for (const name of ['.env', '.env.local', 'auth.json', 'models.json', 'credentials.json', 'id_rsa', 'cert.pem']) {
        fs.writeFileSync(path.join(project, name), 'private fixture');
        await assert.rejects(read(name), { code: 'FILE_PRIVATE' });
    }
    fs.symlinkSync('.env', path.join(project, 'disguised.txt'));
    await assert.rejects(read('disguised.txt'), { code: 'FILE_PRIVATE' });
    await assert.rejects(read('agent-link/innocent.txt'), e => e.status === 403);
    await assert.rejects(read('innocent.txt', agent), { code: 'FILE_PRIVATE' });
    for (const file of ['../outside.txt', 'outside-link.txt', path.join(temporary, 'outside.txt')]) await assert.rejects(read(file), { code: 'FILE_OUTSIDE' });
    await assert.rejects(read('报告.md', os.tmpdir()), { code: 'FILE_PROJECT' });
    await assert.rejects(read('missing.txt'), { code: 'FILE_MISSING' });
    await assert.rejects(read('.'), { code: 'FILE_TYPE' });
    fs.writeFileSync(path.join(project, 'binary.txt'), Buffer.from([0, 1, 2, 3])); await assert.rejects(read('binary.txt'), { code: 'FILE_BINARY' });
    fs.writeFileSync(path.join(project, 'bad.txt'), Buffer.from([0xff, 0xfe])); await assert.rejects(read('bad.txt'), { code: 'FILE_ENCODING' });
    fs.writeFileSync(path.join(project, 'large.txt'), 'x'.repeat(2 * 1024 * 1024 + 1)); await assert.rejects(read('large.txt'), { code: 'FILE_SIZE' });
    if (process.platform === 'win32') {
        fs.writeFileSync(path.join(project, '.env') + ':hidden', 'private stream fixture');
        for (const file of ['.env:hidden', '报告.md:stream', 'NUL.txt', 'CON', '\\\\.\\pipe\\pi-file-fixture', 'ambiguous. ']) await assert.rejects(read(file), { code: 'FILE_PATH' });
    } else {
        execFileSync('mkfifo', [path.join(project, 'pipe.txt')]); await assert.rejects(read('pipe.txt'), { code: 'FILE_TYPE' });
        await assert.rejects(read('a\\b'), { code: 'FILE_PATH' });
    }
    for (const file of ['', '\0']) await assert.rejects(read(file), { code: 'FILE_PATH' });
    assert.equal(service.reading, 0);
});

test('file viewer refuses changed files, final symlink swaps and concurrent excess reads instead of publishing partial content', async () => {
    const name = path.join(project, 'race.txt'); fs.writeFileSync(name, 'before');
    const original = fsp.open;
    try {
        fsp.open = async (...args) => {
            const handle = await original(...args);
            if (args[0] === name) {
                const actualRead = handle.read.bind(handle);
                handle.read = async (...values) => {
                    const result = await actualRead(...values);
                    fs.writeFileSync(name, 'after!');
                    // Same-size writes can share a filesystem timestamp tick; make this race deterministic.
                    fs.utimesSync(name, new Date(), new Date(Date.now() + 1000));
                    return result;
                };
            }
            return handle;
        };
        await assert.rejects(read('race.txt'), { code: 'FILE_CHANGED' });
        fsp.open = async (...args) => {
            if (args[0] === name) { fs.unlinkSync(name); fs.symlinkSync(path.join(temporary, 'outside.txt'), name); }
            return original(...args);
        };
        await assert.rejects(read('race.txt'), e => e.status === 403);
    } finally { fsp.open = original; }
    service.reading = 4;
    try { await assert.rejects(read('报告.md'), { code: 'FILE_BUSY' }); } finally { service.reading = 0; }
});

test('file viewer refuses a moved-directory race or the OS-denied attempt without publishing content', async t => {
    const source = path.join(project, 'moving'), moved = path.join(temporary, 'moved-outside');
    fs.mkdirSync(source);
    const file = path.join(source, 'data.txt'); fs.writeFileSync(file, 'must not be published');
    let renameDenied = false;
    const original = fsp.open;
    try {
        fsp.open = async (...args) => {
            const handle = await original(...args);
            if (args[0] === file) {
                const actualRead = handle.read.bind(handle); let changed = false;
                handle.read = async (...values) => {
                    const result = await actualRead(...values);
                    if (!changed) {
                        changed = true;
                        try { fs.renameSync(source, moved); }
                        catch (error) { renameDenied = process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code); throw error; }
                        fs.mkdirSync(source);
                        fs.writeFileSync(file, 'a different allowed file');
                    }
                    return result;
                };
            }
            return handle;
        };
        await assert.rejects(read('moving/data.txt'), error => error.code === (renameDenied ? 'FILE_DENIED' : 'FILE_OUTSIDE'));
        if (renameDenied) {
            assert.equal(fs.existsSync(moved), false);
            assert.equal(fs.readFileSync(file, 'utf8'), 'must not be published');
            t.diagnostic('Windows prevented moving a directory with an open file; attempted mutation also terminated this injected read');
        }
        assert.equal(service.reading, 0);
    } finally { fsp.open = original; }
});

test('native canonical case keeps distinct case-sensitive siblings outside the selected project', async () => {
    const directory = path.join(project, 'case-boundary'); fs.mkdirSync(directory);
    if (process.platform === 'win32') execFileSync('fsutil.exe', ['file', 'setCaseSensitiveInfo', directory, 'enable'], { stdio: 'ignore' });
    const upper = path.join(directory, 'Case'), lower = path.join(directory, 'case');
    fs.mkdirSync(upper); fs.writeFileSync(path.join(upper, 'data.txt'), 'selected project');
    if (fs.existsSync(lower)) {
        const alias = await read('data.txt', lower);
        assert.equal(alias.cwd, fs.realpathSync.native(upper));
        assert.equal(alias.content, 'selected project');
    } else {
        fs.mkdirSync(lower); fs.writeFileSync(path.join(lower, 'data.txt'), 'must stay outside');
        assert.equal((await read('data.txt', upper)).content, 'selected project');
        await assert.rejects(read(path.join(lower, 'data.txt'), upper), { code: 'FILE_OUTSIDE' });
    }
});

test('file API requires existing origin/token authentication, advertises capability and never starts a session worker', async t => {
    const { createPiAgentGateway } = require('../server/pi-agent-routes');
    const gateway = createPiAgentGateway({ deferredFilePath: process.env.PI_WEB_DEFERRED_FILE });
    const app = require('express')(); app.use(require('express').json()); gateway.mount(app);
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { await gateway.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const url = base + '/api/pi/files/content?' + new URLSearchParams({ cwd: project, path: '报告.md' });
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer file-fixture', Origin: 'https://other.test' } })).status, 403);
    const headers = { Authorization: 'Bearer file-fixture', Origin: base };
    const response = await fetch(url, { headers }); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).content, content + 'new');
    assert.equal((await (await fetch(base + '/api/pi/status', { headers })).json()).fileViewer, true);
    const missing = await fetch(base + '/api/pi/files/content?' + new URLSearchParams({ cwd: project, path: '../outside.txt' }), { headers });
    assert.equal(missing.status, 403); assert.doesNotMatch(JSON.stringify(await missing.json()), /outside\.txt|private fixture/);
    assert.equal(gateway.supervisor.workers.size, 0); assert.equal(gateway.supervisor.ephemeralWorkers.size, 0);
});
