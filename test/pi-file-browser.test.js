const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const fileIo = require('../server/pi-file-io');
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-browser-')));
const project = path.join(temporary, 'project'), agent = path.join(temporary, 'agent-private');
fs.mkdirSync(project); fs.mkdirSync(agent);
process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_PROJECT_ROOTS = temporary; process.env.PI_OFFLINE = '1';
const { PiSessionStore } = require('../server/pi-session-store');
const { PiFileBrowser } = require('../server/pi-file-browser');
const browser = new PiFileBrowser(new PiSessionStore());
const list = (relative = '', extra = {}) => browser.request({ cwd: project, path: relative, ...extra });
const search = (q, extra = {}) => browser.request({ cwd: project, q, ...extra }, true);
for (const name of ['docs/nested', '.github', 'node_modules/pkg']) fs.mkdirSync(path.join(project, name), { recursive: true });
for (const name of ['README.md', 'docs/nested/报告 空格.md', '.github/workflow.yml', 'node_modules/pkg/hidden.md', '.env', 'auth.json']) fs.writeFileSync(path.join(project, name), 'fixture');
test.after(() => fs.rmSync(temporary, { force: true, recursive: true }));

test('project browsing lists bounded verified names and searches unopened directories without file content', async () => {
    const root = await list();
    assert.deepEqual(root.entries.map(e => e.name), ['docs', 'node_modules', 'README.md']);
    assert.equal(root.partial, false);
    assert.ok((await list('', { hidden: 'true' })).entries.some(e => e.name === '.github'));
    assert.ok(!(await list('', { hidden: 'true' })).entries.some(e => e.name === '.env'));
    assert.deepEqual((await search('报告')).entries.map(e => e.path), ['docs/nested/报告 空格.md']);
    assert.equal((await search('hidden.md')).entries.length, 0);
    assert.equal((await search('workflow')).entries.length, 0);
    assert.equal((await search('workflow', { hidden: 'true' })).entries.length, 1);
    assert.equal((await list('node_modules/pkg')).entries[0].name, 'hidden.md');
    assert.ok(root.entries.every(e => !('content' in e) && !('absolutePath' in e)));
});

test('directory paths and aliases retain project, private-root and object-type boundaries', async () => {
    fs.writeFileSync(path.join(agent, 'secret.md'), 'fixture');
    fs.writeFileSync(path.join(temporary, 'outside.md'), 'fixture');
    fs.symlinkSync('../outside.md', path.join(project, 'outside.md'));
    fs.symlinkSync(agent, path.join(project, 'private-alias'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.symlinkSync('docs', path.join(project, 'alias'), 'dir');
    fs.symlinkSync('.env', path.join(project, 'disguised.txt'));
    const media = path.join(project, 'custom-private-media'); fs.mkdirSync(media);
    process.env.PI_MEDIA_CONFIG_DIR = media;
    fs.writeFileSync(path.join(media, 'ordinary-name.txt'), 'private fixture');
    fs.symlinkSync(media, path.join(project, 'media-alias'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.ok(!(await list()).entries.some(e => ['custom-private-media', 'media-alias'].includes(e.name)));
    await assert.rejects(list('custom-private-media'), { code: 'FILE_PRIVATE' });
    assert.ok((await list()).entries.some(e => e.name === 'alias' && e.link));
    assert.ok(!(await list()).entries.some(e => ['outside.md', 'private-alias', 'disguised.txt'].includes(e.name)));
    assert.equal((await list('alias/nested')).entries[0].name, '报告 空格.md');
    await assert.rejects(list('../'), { code: 'FILE_OUTSIDE' });
    await assert.rejects(list('private-alias'), { code: 'FILE_OUTSIDE' });
    await assert.rejects(browser.request({ cwd: agent, path: '' }), { code: 'FILE_PRIVATE' });
    await assert.rejects(list('README.md'), { code: 'FILE_TYPE' });
    await assert.rejects(list('', { unknown: '1' }), { code: 'FILE_PATH' });
    await assert.rejects(search(''), { code: 'FILE_PATH' });
    await assert.rejects(list('', { hidden: '1' }), { code: 'FILE_PATH' });
});

test('directory changes, cancellation, busy and incomplete searches are explicit', async () => {
    const original = fileIo.openRead;
    const moving = path.join(project, 'moving'); fs.mkdirSync(moving); fs.writeFileSync(path.join(moving, 'one.md'), 'fixture');
    try {
        fileIo.openRead = async (...args) => {
            const handle = await original(...args);
            if (args[0] === path.join(moving, 'one.md')) fs.utimesSync(moving, new Date(), new Date(Date.now() + 10000));
            return handle;
        };
        await assert.rejects(list('moving'), { code: 'FILE_CHANGED' });
    } finally { fileIo.openRead = original; }
    const controller = new AbortController(); controller.abort();
    await assert.rejects(browser.request({ cwd: project, path: '' }, false, controller.signal), { code: 'FILE_ABORTED' });
    browser.running = 2;
    await assert.rejects(list(), { code: 'FILE_BUSY' }); browser.running = 0;
    fs.mkdirSync(path.join(project, 'many'));
    for (let i = 0; i < 105; i++) fs.writeFileSync(path.join(project, 'many', `match-${i}.txt`), 'fixture');
    const results = await search('match-');
    assert.equal(results.entries.length, 100); assert.equal(results.partial, true);
    for (let i = 105; i < 505; i++) fs.writeFileSync(path.join(project, 'many', `match-${i}.txt`), 'fixture');
    const directory = await list('many'); assert.equal(directory.entries.length, 500); assert.equal(directory.partial, true);
    assert.equal(browser.running, 0);
});
