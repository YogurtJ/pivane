const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
function runtime({ languages = ['en-US'], saved, blocked = false } = {}) {
    const storage = new Map(saved === undefined ? [] : [['pi.workspace.language', saved]]);
    const context = { navigator: { languages }, localStorage: {
        getItem(key) { if (blocked) throw Error('blocked'); return storage.get(key) ?? null; },
        setItem(key, value) { if (blocked) throw Error('blocked'); storage.set(key, value); }
    } };
    vm.createContext(context);
    for (const file of ['pi-i18n-catalog.js', 'pi-i18n.js']) vm.runInContext(fs.readFileSync(path.join(root, 'public', file), 'utf8'), context);
    return { api: context.PiI18n, rows: context.PiI18nCatalog, storage };
}
test('interface language negotiates browser preferences and honors explicit saved choices', () => {
    assert.equal(runtime({ languages: ['zh-TW', 'en'] }).api.locale, 'zh-CN');
    assert.equal(runtime({ languages: ['en-GB', 'zh-CN'] }).api.locale, 'en');
    assert.equal(runtime({ languages: ['fr-FR', 'zh-Hans'] }).api.locale, 'zh-CN');
    assert.equal(runtime({ languages: ['fr-FR'] }).api.locale, 'en');
    assert.equal(runtime({ languages: [], saved: 'invalid' }).api.locale, 'en');
    assert.equal(runtime({ languages: ['en'], saved: 'zh-CN' }).api.locale, 'zh-CN');
    assert.equal(runtime({ languages: ['zh-CN'], saved: 'en' }).api.locale, 'en');
    assert.equal(runtime({ languages: ['zh-CN'], blocked: true }).api.locale, 'zh-CN');
});
test('language writes affect only the browser preference and leave this page stable until reopened', () => {
    const { api, storage } = runtime({ languages: ['en'] });
    assert.equal(api.save('zh-CN'), true);
    assert.equal(api.locale, 'en');
    assert.deepEqual([...storage.keys()], ['pi.workspace.language']);
    assert.equal(runtime({ saved: storage.get('pi.workspace.language') }).api.locale, 'zh-CN');
    assert.equal(api.save('system'), true);
    assert.throws(() => api.save('unsupported'), /Unsupported/);
    assert.equal(runtime({ blocked: true }).api.save('en'), false);
});
test('translation preserves interpolated values and unknown text without recursive substitution', () => {
    const { api } = runtime();
    assert.equal(api.t('保存'), 'Save');
    assert.equal(api.t('预览 {0}', '<img src=x onerror=alert(1)> {1}'), 'Preview <img src=x onerror=alert(1)> {1}');
    assert.equal(api.t('unknown {0}'), 'unknown {0}');
    assert.equal(api.t('预览 {0}', null), 'Preview null');
    assert.equal(api.t('预览 {0}', undefined), 'Preview undefined');
    assert.equal(api.t(undefined), '');
    assert.equal(api.t('未知的用户正文'), '未知的用户正文');
    assert.equal(runtime({ saved: 'zh-CN' }).api.t('预览 {0}', '$&'), '预览 $&');
});
test('all catalogs, numeric placeholders and static/source bindings are complete', () => {
    const { rows } = runtime();
    const sources = new Set();
    const placeholders = text => [...text.matchAll(/\{\d+\}/g)].map(m => m[0]).sort();
    for (const [source, english] of rows) {
        assert.ok(source && english, 'empty translation');
        assert.ok(!sources.has(source), `duplicate: ${source}`); sources.add(source);
        assert.deepEqual(placeholders(english), placeholders(source), source);
        assert.ok(!/<\/?(?:script|iframe|img|span|div)\b/i.test(english), `markup in translation: ${source}`);
    }
    const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
    for (const match of html.matchAll(/(?:i18n:s|data-i18n-[\w-]+="s)(\d+)/g)) assert.ok(rows[Number(match[1])], `missing static key ${match[1]}`);
    for (const match of html.matchAll(/<!--i18n:s(\d+)-->([^<]*)/g)) {
        assert.equal(match[2].trim(), rows[Number(match[1])][0], `static source mismatch ${match[1]}`);
    }
    for (const name of fs.readdirSync(path.join(root, 'public')).filter(n => n.endsWith('.js') && n !== 'pi-i18n-catalog.js')) {
        const source = fs.readFileSync(path.join(root, 'public', name), 'utf8');
        for (const match of source.matchAll(/translateUi\(("(?:[^"\\]|\\.)*")/g)) assert.ok(sources.has(JSON.parse(match[1])), `${name}: missing ${match[1]}`);
    }
});
