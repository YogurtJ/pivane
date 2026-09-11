const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WorkspacePreferencesService } = require('../server/workspace-preferences-service');

test('uses the Pi runtime planner default and persists a validated override', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-workspace-preferences-'));
    const filePath = path.join(root, 'pi5-workspace.json');
    const service = new WorkspacePreferencesService({ filePath });

    assert.deepEqual(service.getMediaAgent(), { provider: '', modelId: '' });
    assert.deepEqual(
        service.setMediaAgent({ provider: 'fixture-provider', modelId: 'fixture-model' }),
        { provider: 'fixture-provider', modelId: 'fixture-model' }
    );
    assert.deepEqual(service.getMediaAgent(), { provider: 'fixture-provider', modelId: 'fixture-model' });
    require('./private-file-helper.cjs').assertPrivateFile(filePath);
    fs.rmSync(root, { recursive: true, force: true });
});

test('project pins preserve other preferences and persist across service instances', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-project-pins-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const filePath = path.join(root, 'pi5-workspace.json');
    fs.writeFileSync(filePath, JSON.stringify({ custom: { keep: true } }));
    const first = new WorkspacePreferencesService({ filePath });
    const second = new WorkspacePreferencesService({ filePath });
    first.setProjectPinned('/srv/one', true);
    second.setProjectPinned('/srv/two', true);
    assert.deepEqual(first.getPinnedProjects(), ['/srv/two', '/srv/one']);
    first.setMediaAgent({ provider: 'test', modelId: 'test-model' });
    second.setProjectPinned('/srv/one', false);
    assert.deepEqual(first.getPinnedProjects(), ['/srv/two']);
    assert.deepEqual(second.getMediaAgent(), { provider: 'test', modelId: 'test-model' });
    assert.deepEqual(first.readDocument().custom, { keep: true });
    require('./private-file-helper.cjs').assertPrivateFile(filePath);
    assert.throws(() => first.setProjectPinned('/srv/one', 'false'));
    assert.throws(() => first.setProjectPinned('relative', true));
});

test('reply notices persist without messages and stale acknowledgements cannot clear newer replies', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-reply-notices-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const filePath = path.join(root, 'prefs.json');
    const service = new WorkspacePreferencesService({ filePath });
    service.setProjectPinned('/srv/project', true);
    const first = { cwd: '/srv/project', sessionId: 'one', completionId: 'first', completedAt: new Date().toISOString(), text: 'must not be stored' };
    service.recordReplyNotice(first);
    service.recordReplyNotice({ ...first, completionId: 'second' });
    service.clearReplyNotice(first.cwd, first.sessionId, 'first');
    const restored = new WorkspacePreferencesService({ filePath });
    assert.equal(restored.getReplyNotices()[0].completionId, 'second');
    assert.equal(restored.getReplyNotices().length, 1);
    assert.equal(fs.readFileSync(filePath, 'utf8').includes('must not be stored'), false);
    restored.clearReplyNotice(first.cwd, first.sessionId, 'second');
    assert.deepEqual(service.getReplyNotices(), []);
    assert.deepEqual(service.getPinnedProjects(), ['/srv/project']);
    service.recordReplyNotice({ ...first, completionId: 'manual', manual: true });
    assert.equal(restored.getReplyNotices()[0].manual, true);
    require('./private-file-helper.cjs').assertPrivateFile(filePath);
    restored.clearReplyNotice(first.cwd, first.sessionId, 'second');
    assert.equal(service.getReplyNotices()[0].completionId, 'manual');
    service.recordReplyNotice({ ...first, completionId: 'new-completion' });
    assert.equal(restored.getReplyNotices()[0].manual, undefined);
});

test('empty project visibility persists, unpins only the removed project and preserves other data', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-project-visibility-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const filePath = path.join(root, 'prefs.json');
    const service = new WorkspacePreferencesService({ filePath });
    service.setProjectPinned('/srv/one', true);
    service.setProjectPinned('/srv/two', true);
    service.setMediaAgent({ provider: 'test', modelId: 'example' });
    service.recordReplyNotice({ cwd: '/srv/two', sessionId: 'session', completionId: 'reply', completedAt: 'now' });
    service.setProjectHidden('/srv/one', true);
    const restored = new WorkspacePreferencesService({ filePath });
    assert.deepEqual(restored.getHiddenProjects(), ['/srv/one']);
    assert.deepEqual(restored.getPinnedProjects(), ['/srv/two']);
    assert.equal(restored.getReplyNotices().length, 1);
    assert.equal(restored.getMediaAgent().modelId, 'example');
    restored.setProjectHidden('/srv/one', false);
    assert.deepEqual(service.getHiddenProjects(), []);
    restored.setProjectHidden('/srv/one', true);
    service.setProjectPinned('/srv/one', true);
    assert.deepEqual(restored.getHiddenProjects(), []);
    assert.throws(() => service.setProjectHidden('/srv/one', 'true'));
    assert.throws(() => service.setProjectHidden('relative', true));
});
