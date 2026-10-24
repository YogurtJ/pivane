const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
function runtime({ languages = ['en-US'], saved, blocked = false, ui = {}, reorderCatalog = false } = {}) {
    const storage = new Map(saved === undefined ? [] : [['pi.workspace.language', saved]]);
    const context = { ...ui, navigator: { languages }, localStorage: {
        getItem(key) { if (blocked) throw Error('blocked'); return storage.get(key) ?? null; },
        setItem(key, value) { if (blocked) throw Error('blocked'); storage.set(key, value); }
    } };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(root, 'public/pi-i18n-catalog.js'), 'utf8'), context);
    if (reorderCatalog) context.PiI18nCatalog = [...context.PiI18nCatalog].reverse();
    vm.runInContext(fs.readFileSync(path.join(root, 'public/pi-i18n.js'), 'utf8'), context);
    return { api: context.PiI18n, rows: context.PiI18nCatalog, storage, context };
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
test('counted UI labels use English singular only for one and preserve Chinese and values', () => {
    const { api } = runtime();
    const chinese = runtime({ saved: 'zh-CN' }).api;
    for (const [source, noun] of [['{0} 段思考', 'thinking block'], ['{0} 次工具调用', 'tool call'], ['{0} 次工具', 'tool call'], ['{0} 轮', 'turn']]) {
        for (const count of [0, 1, 2]) {
            assert.equal(api.t(source, count), `${count} ${noun}${count === 1 ? '' : 's'}`);
            assert.equal(chinese.t(source, count), source.replace('{0}', count));
        }
    }
    assert.equal(api.t('{0} 工具失败', 1), '1 tool failed');
    assert.equal(api.t('{0} 工具失败', 2), '2 tools failed');
    assert.equal(api.t('预览 {0}', 1), 'Preview 1', 'ordinary translations keep their template');
    assert.equal(api.t('{0} 段思考', '{1}'), '{1} thinking blocks', 'values are not reinterpreted');
});
function languageCard({ languages = ['en-US'], blockers = [], restorable = 0, bridge = true, blocked = false } = {}) {
    const elements = new Map(), events = new Map(), timers = [], frames = [], shown = [];
    class Element {
        constructor(id) { this.id = id; this.listeners = new Map(); this.children = []; this.attributes = new Map(); this.hidden = false; this.disabled = false; if (id) elements.set(id, this); }
        append(...children) { this.children.push(...children); for (const child of children) if (child.id) elements.set(child.id, child); }
        after(node) { this.afterNode = node; }
        setAttribute(key, value) { this.attributes.set(key, value); }
        addEventListener(name, callback) { this.listeners.set(name, callback); }
        remove() { elements.delete(this.id); }
        fire(name) { this.listeners.get(name)?.(); }
    }
    const select = new Element('workspace-language'); select.options = [{ textContent: '' }];
    const status = new Element('workspace-language-status'); new Element('workspace-language-hint');
    const body = new Element(); let boot;
    const document = { documentElement: {}, body, createElement: () => new Element(), getElementById: id => elements.get(id),
        createTreeWalker: () => ({ nextNode: () => false }), querySelectorAll: () => [], addEventListener(name, callback) { if (name === 'DOMContentLoaded') boot = callback; } };
    const window = { PiInlineStatus: { show(node, value) { node.textContent = value.text; node.tone = value.tone; shown.push(value); } },
        addEventListener(name, callback) { events.set(name, callback); } };
    let prepared = 0, reloaded = 0, confirmation = '', confirmed = false;
    if (bridge) window.PiWorkbenchReload = { assess: () => ({ blockers, restorable }), prepare: () => { prepared++; } };
    const result = runtime({ languages, blocked, ui: { document, window, NodeFilter: { SHOW_COMMENT: 128 }, Node: { TEXT_NODE: 3 },
        location: { reload() { reloaded++; } }, requestAnimationFrame(callback) { frames.push(callback); }, setTimeout(callback, delay) { timers.push({ callback, delay }); },
        confirm(text) { confirmation = text; return confirmed; } } });
    boot();
    return { ...result, select, status, elements, events, timers, shown, change(value) { select.value = value; select.fire('change'); },
        confirm(value) { confirmed = value; }, get confirmation() { return confirmation; }, get prepared() { return prepared; }, get reloaded() { return reloaded; },
        paint() { while (frames.length) frames.shift()(); }, runTimer(delay) { timers.find(timer => timer.delay === delay).callback(); } };
}
test('language card keeps the page locale frozen and saves a same-locale selection without reload', () => {
    const ui = languageCard(); ui.change('en');
    assert.equal(ui.api.preference(), 'en'); assert.equal(ui.api.locale, 'en');
    assert.equal(ui.reloaded, 0); assert.equal(ui.timers.length, 0); assert.equal(ui.status.tone, 'info');
    assert.equal(ui.status.afterNode.hidden, true);
});
test('language card renders blocker reasons and restorable text safely and confirms before switching', () => {
    const ui = languageCard({ blockers: ['Attachment <img>', 'Temporary session'], restorable: 2 }); ui.change('zh-CN');
    assert.equal(ui.status.tone, 'warning'); assert.ok(ui.status.textContent.includes('Attachment <img>'));
    assert.equal(ui.status.afterNode.hidden, false); assert.match(ui.status.afterNode.children[1].textContent, /2/);
    const button = ui.status.afterNode.children[0]; button.fire('click');
    assert.ok(ui.confirmation.includes('Temporary session') && ui.confirmation.includes('2'));
    assert.equal(ui.prepared, 0); assert.equal(ui.reloaded, 0);
    ui.confirm(true); button.fire('click');
    assert.equal(ui.elements.get('workspace-language-switch-overlay').lang, 'zh-CN');
    assert.equal(ui.elements.get('workspace-language-switch-overlay').children[0].children[1].textContent, '正在切换为简体中文…');
    assert.equal(ui.prepared, 0, 'drafts are prepared immediately before navigation, after the overlay paints');
    ui.paint(); ui.runTimer(150); assert.equal(ui.prepared, 1); assert.equal(ui.reloaded, 1);
    assert.equal(ui.api.locale, 'en', 'current DOM translations remain frozen until navigation completes');
    ui.runTimer(4000); assert.equal(ui.elements.has('workspace-language-switch-overlay'), false); assert.equal(ui.select.disabled, false);
    assert.equal(ui.status.tone, 'warning', 'cancelled navigation returns to the saved pending warning');
});
test('language card reloads safely without the optional workbench bridge and retains storage/listener behavior', () => {
    const ui = languageCard({ bridge: false, languages: ['zh-CN'] }); ui.change('en');
    assert.equal(ui.elements.get('workspace-language-switch-overlay').children[0].children[1].textContent, 'Switching to English…');
    ui.paint(); ui.runTimer(150); assert.equal(ui.prepared, 0); assert.equal(ui.reloaded, 1);
    ui.runTimer(4000); assert.equal(ui.status.tone, 'info'); assert.ok(ui.status.textContent.includes('语言已保存'));
    ui.api.save('zh-CN'); ui.events.get('storage')({ key: 'pi.workspace.language' }); assert.equal(ui.select.value, 'zh-CN');
    ui.events.get('languagechange')(); assert.equal(ui.select.value, 'zh-CN');
    const failed = languageCard({ blocked: true }); failed.change('zh-CN'); assert.equal(failed.status.tone, 'error'); assert.equal(failed.timers.length, 0);
});
test('static translations use source text across catalog order changes and consume their markers once', () => {
    for (const saved of ['zh-CN', 'en']) {
        const comments = [
            ['i18n:s2469', ' 助手身份 '],
            ['i18n:s2892', '消息显示'],
            ['i18n:s2758', '简洁'],
            ['i18n:s3528', '本轮工具后送达'],
            ['i18n:s3529', '当前任务完成后送达'],
            ['i18n:s999999', '小'],
            ['i18n', '字体大小'],
            ['i18n:s0', 'unknown <raw>'],
            ['unrelated', '保存']
        ].map(([data, source]) => ({ data, nextSibling: { nodeType: 3, data: source }, remove() { this.removed = true; } }));
        const attributes = new Map([
            ['data-i18n-title', 's2469'], ['title', '助手身份'],
            ['data-i18n-aria-label', 's3529'], ['aria-label', '当前任务完成后送达'],
            ['data-i18n-placeholder', 's0'], ['placeholder', 'unknown <raw>'], ['data-i18n-alt', 's0']
        ]);
        const node = { getAttribute: key => attributes.get(key) ?? null, setAttribute: (key, value) => attributes.set(key, value), removeAttribute: key => attributes.delete(key) };
        const document = { documentElement: {}, addEventListener() {},
            createTreeWalker() { const remaining = comments.filter(comment => !comment.removed); let index = 0; return { nextNode() { this.currentNode = remaining[index++]; return Boolean(this.currentNode); } }; },
            querySelectorAll: selector => attributes.has(selector.slice(1, -1)) ? [node] : [] };
        const { api } = runtime({ saved, reorderCatalog: true, ui: { document, NodeFilter: { SHOW_COMMENT: 128 }, Node: { TEXT_NODE: 3 } } });
        api.translateStatic();
        const english = saved === 'en';
        assert.deepEqual(comments.map(comment => comment.nextSibling.data), english
            ? [' Assistant profiles ', 'Message display', 'Compact', 'Delivered after this tool step', 'Delivered after the current task', 'Small', 'Font size', 'unknown <raw>', '保存']
            : [' 助手身份 ', '消息显示', '简洁', '本轮工具后送达', '当前任务完成后送达', '小', '字体大小', 'unknown <raw>', '保存']);
        assert.equal(attributes.get('title'), english ? 'Assistant profiles' : '助手身份');
        assert.equal(attributes.get('aria-label'), english ? 'Delivered after the current task' : '当前任务完成后送达');
        assert.equal(attributes.get('placeholder'), 'unknown <raw>'); assert.equal(attributes.has('alt'), false);
        assert.equal([...attributes.keys()].some(key => key.startsWith('data-i18n-')), false);
        assert.ok(comments.slice(0, -1).every(comment => comment.removed)); assert.equal(comments.at(-1).removed, undefined);
        const before = comments.map(comment => comment.nextSibling.data);
        api.translateStatic(); assert.deepEqual(comments.map(comment => comment.nextSibling.data), before);
    }
});

test('all catalogs, numeric placeholders and static/source bindings are complete', () => {
    const { rows } = runtime();
    const sources = new Set();
    const placeholders = text => [...text.matchAll(/\{\d+\}/g)].map(m => m[0]).sort();
    for (const [source, english, singular] of rows) {
        assert.ok(source && english, 'empty translation');
        assert.ok(!sources.has(source), `duplicate: ${source}`); sources.add(source);
        assert.deepEqual(placeholders(english), placeholders(source), source);
        if (singular !== undefined) {
            assert.ok(singular && source.includes('{0}'), `invalid singular: ${source}`);
            assert.deepEqual(placeholders(singular), placeholders(source), source);
            assert.ok(!/<\/?(?:script|iframe|img|span|div)\b/i.test(singular), `markup in singular: ${source}`);
        }
        assert.ok(!/<\/?(?:script|iframe|img|span|div)\b/i.test(english), `markup in translation: ${source}`);
    }
    const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
    for (const match of html.matchAll(/<!--i18n(?::s\d+)?-->([^<]*)/g)) {
        assert.ok(sources.has(match[1].trim()), `missing static source: ${match[1].trim()}`);
    }
    const decode = text => text.replace(/&(?:amp|quot|apos|lt|gt);/g, entity => ({ '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' })[entity]);
    for (const tag of html.matchAll(/<[^!][^>]*\bdata-i18n-[^>]*>/g)) {
        for (const marker of tag[0].matchAll(/\bdata-i18n-(title|aria-label|placeholder|alt)(?:="[^"]*")?/g)) {
            const original = new RegExp(`(?:\\s)${marker[1]}="([^"]*)"`).exec(tag[0]);
            assert.ok(original, `missing ${marker[1]} source: ${tag[0]}`);
            assert.ok(sources.has(decode(original[1])), `missing attribute source: ${original[1]}`);
        }
    }
    for (const name of fs.readdirSync(path.join(root, 'public')).filter(n => n.endsWith('.js') && n !== 'pi-i18n-catalog.js')) {
        const source = fs.readFileSync(path.join(root, 'public', name), 'utf8');
        for (const match of source.matchAll(/translateUi\(("(?:[^"\\]|\\.)*")/g)) assert.ok(sources.has(JSON.parse(match[1])), `${name}: missing ${match[1]}`);
    }
});
