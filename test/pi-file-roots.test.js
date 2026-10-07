const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-roots-')));
const project = path.join(temporary, 'project'), other = path.join(temporary, 'other'), agent = path.join(temporary, 'private-agent');
for (const root of [project, other, agent]) fs.mkdirSync(root);
process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = temporary; process.env.PI_OFFLINE = '1';
const { PiSessionStore } = require('../server/pi-session-store');
const { PiFileBrowser } = require('../server/pi-file-browser');
const { PiFileRoots } = require('../server/pi-file-roots');
const { WorkspacePreferencesService } = require('../server/workspace-preferences-service');
const store = new PiSessionStore(), browser = new PiFileBrowser(store), preferences = new WorkspacePreferencesService({ agentDir: agent });
const service = new PiFileRoots({ store, browser, preferences });
const request = (root, action, expectedRevision) => service.change({ cwd: project, root, action, expectedRevision });
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

test('associated roots are revisioned per-project navigation, preserving other preferences and removable when missing', async () => {
    preferences.writeDocument({ unknownFuture: { keep: true } });
    assert.deepEqual(await service.list({ cwd: project }), { cwd: project, revision: 0, roots: [] });
    const saved = await request(other, 'add', 0); assert.deepEqual(saved.roots, [other]);
    await assert.rejects(request(other, 'remove', 0), { code: 'FILE_ROOTS_CHANGED' });
    assert.equal(preferences.readDocument().unknownFuture.keep, true);
    assert.equal((await service.list({ cwd: other })).roots.length, 0);
    const alias = path.join(temporary, 'alias'); fs.symlinkSync(other, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.deepEqual((await request(alias, 'add', 1)).roots, [other]);
    fs.rmdirSync(other);
    assert.deepEqual((await service.list({ cwd: project })).roots, [other]);
    assert.deepEqual((await request(other, 'remove', 2)).roots, []);
    fs.mkdirSync(other); fs.unlinkSync(alias);
    await assert.rejects(request(agent, 'add', 3), { code: 'FILE_PRIVATE' });
    await assert.rejects(service.change({ cwd: project, root: other, action: 'add', expectedRevision: 3, arbitrary: true }), { code: 'FILE_PATH' });
});

test('root selection, safe directory picker and external file resolution preserve descriptor/private/alias boundaries', async () => {
    for (const root of [project, other]) fs.writeFileSync(path.join(root, 'README.md'), root);
    fs.writeFileSync(path.join(other, '.env'), 'private fixture');
    fs.writeFileSync(path.join(agent, 'innocent.md'), 'private fixture');
    fs.symlinkSync(other, path.join(project, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.symlinkSync(path.join(other, '.env'), path.join(other, 'disguised.md'));
    const before = await service.resolve({ cwd: project, path: path.join(other, 'README.md') });
    assert.equal(before.associated, false); assert.equal(before.root, other); assert.equal(before.path, 'README.md');
    assert.equal('content' in before, false);
    await request(other, 'add', 3);
    assert.equal((await service.resolve({ cwd: project, path: path.join(other, 'README.md') })).associated, true);
    assert.equal((await service.resolve({ cwd: project, path: 'README.md' })).root, project);
    assert.equal((await service.resolve({ cwd: project, path: '../other/README.md' })).root, other);
    await assert.rejects(service.resolve({ cwd: project, path: 'escape/README.md' }), { code: 'FILE_OUTSIDE' });
    await assert.rejects(service.resolve({ cwd: project, path: path.join(other, 'disguised.md') }), { code: 'FILE_PRIVATE' });
    await assert.rejects(service.resolve({ cwd: project, path: path.join(agent, 'innocent.md') }), { code: 'FILE_PRIVATE' });
    await assert.rejects(service.resolve({ cwd: project, path: other }), { code: 'FILE_TYPE' });
    const listed = await service.directories({ path: temporary });
    assert.ok(listed.directories.some(row => row.path === other));
    assert.ok(!listed.directories.some(row => row.path === agent));
    assert.ok(!(await service.directories({ path: project })).directories.some(row => row.name === 'escape'));
    assert.equal((await service.directories({ path: '' })).directories[0].path, temporary);
    await assert.rejects(service.directories({ path: agent }), { code: 'FILE_PRIVATE' });
    await assert.rejects(service.directories({ path: 'relative' }), { code: 'FILE_PATH' });
    const abort = new AbortController(); abort.abort();
    await assert.rejects(service.directories({ path: '' }, abort.signal), { code: 'FILE_ABORTED' });
});

test('shutdown reserves before waiting, rejects new saves and awaits the existing validation without committing', async () => {
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const closing = new PiFileRoots({ store, preferences, browser: { resolveRoot: async value => { entered(); await gate; return value; } } });
    const revision = preferences.getFileRoots(project).revision;
    const pending = closing.change({ cwd: project, root: other, action: 'add', expectedRevision: revision });
    const rejected = assert.rejects(pending, { code: 'FILE_ROOTS_BUSY' });
    await started;
    let done = false;
    const disposed = closing.dispose().then(() => { done = true; });
    await Promise.resolve(); assert.equal(done, false);
    await assert.rejects(closing.change({ cwd: project, root: other, action: 'add', expectedRevision: revision }), { code: 'FILE_ROOTS_BUSY' });
    release(); await rejected; await disposed;
    assert.equal(closing.jobs.size, 0); assert.equal(preferences.getFileRoots(project).revision, revision);
});

test('canonical case keeps unrelated siblings separate; native Windows accepts case aliases without widening final scope', async () => {
    const upper = path.join(temporary, 'CaseNotes'), lower = path.join(temporary, 'casenotes');
    fs.mkdirSync(upper); fs.writeFileSync(path.join(upper, 'README.md'), 'upper');
    const current = preferences.getFileRoots(project).revision;
    await request(upper, 'add', current);
    if (process.platform === 'win32' && fs.existsSync(lower)) {
        const result = await service.resolve({ cwd: project, path: path.join(lower, 'README.md') });
        assert.equal(result.associated, true); assert.equal(result.root, fs.realpathSync.native(upper));
    } else if (!fs.existsSync(lower)) {
        fs.mkdirSync(lower); fs.writeFileSync(path.join(lower, 'README.md'), 'lower');
        const result = await service.resolve({ cwd: project, path: path.join(lower, 'README.md') });
        assert.equal(result.associated, false); assert.equal(result.root, fs.realpathSync.native(lower));
    }
    await request(upper, 'remove', current + 1);
});

test('add reserves before asynchronous validation; roots remain bounded and unsafe object types are rejected', async () => {
    const revision = preferences.getFileRoots(project).revision;
    const pending = request(other, 'add', revision);
    await assert.rejects(request(other, 'add', revision), { code: 'FILE_ROOTS_BUSY' });
    await pending;
    const file = path.join(project, 'ordinary.txt'); fs.writeFileSync(file, 'text');
    await assert.rejects(browser.resolveRoot(file), { code: 'FILE_PROJECT' });
    const original = require('../server/pi-file-io').openRead, io = require('../server/pi-file-io');
    try {
        io.openRead = async (...args) => { const handle = await original(...args); if (args[0] === file) fs.utimesSync(file, new Date(), new Date(Date.now() + 10000)); return handle; };
        // Resolution only returns metadata. A subsequent read always revalidates the file.
        assert.equal((await browser.resolveFile(project, file)).path, 'ordinary.txt');
    } finally { io.openRead = original; }
    assert.equal(browser.running, 0); assert.equal(service.jobs.size, 0);
    const doc = preferences.readDocument(); doc.fileRoots[0].roots = Array.from({ length: 16 }, (_, i) => path.join(temporary, String(i))); preferences.writeDocument(doc);
    await assert.rejects(request(other, 'add', revision + 1), { code: 'FILE_ROOTS_LIMIT' });
});
