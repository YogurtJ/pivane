const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-codemode-policy-')));
const agentDir = path.join(root, 'agent'), cwd = path.join(root, 'project');
for (const dir of [agentDir, cwd]) fs.mkdirSync(dir);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_PROJECT_ROOTS = root;
process.env.PI_OFFLINE = '1';
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const imageRef = { provider: 'fixture', id: 'painter' };
const classifierRef = { provider: 'fixture', id: 'classifier' };
const imageContext = { input: [{ type: 'text', text: 'synthetic fox' }] };
const classifierContext = { state: { approved: true }, questions: { approved: {
    type: 'bool', instructions: 'Is this approved?', criteria: { true: 'Approved', false: 'Not approved' },
} } };
const usage = { input: 3, output: 2, totalTokens: 5, cost: { total: 0.125 } };

// The real ModelRegistry delegates here. Private fields make a lost method
// receiver fail; image auth/provider sentinels record activity at the boundary.
class SyntheticRuntime {
    #label;
    calls = [];
    constructor(label = 'first') { this.#label = label; }
    getModelsOfType(type, provider) {
        this.calls.push({ method: 'catalog', type, provider });
        return [{ ...(type === 'image' ? imageRef : classifierRef), type, name: this.#label,
            api: 'synthetic', input: ['text'], headers: { 'x-fixture': 'synthetic-header' } }]
            .filter(model => !provider || model.provider === provider);
    }
    getModelOfType(type, provider, id) {
        return this.getModelsOfType(type, provider).find(model => model.id === id);
    }
    async getAvailableOfType(type, provider, options) {
        this.calls.push({ method: 'availability', options });
        return this.getModelsOfType(type, provider);
    }
    async classify(model, context, options) {
        this.calls.push({ method: 'classify', model, context, options });
        return { provider: model.provider, model: model.id, answers: { approved: { type: 'bool', probability: 1 } },
            stopReason: 'stop', usage, label: this.#label };
    }
    async generateImages() {
        this.calls.push({ method: 'image-auth' }, { method: 'image-provider', label: this.#label });
        throw new Error('IMAGE_PROVIDER_WAS_INVOKED');
    }
}

async function dependencies() {
    const sdk = await import('@earendil-works/pi-coding-agent');
    const policy = await import('../server/pi-codemode-policy.mjs');
    // Public SDK exports the factory; inspect official schema recognition too.
    const sdkRoot = fs.realpathSync(path.join(__dirname, '../node_modules/@earendil-works/pi-coding-agent'));
    const official = await import(pathToFileURL(path.join(sdkRoot, 'dist/extensions/codemode/tool.js')).href);
    return { sdk, ...policy, ...official };
}
async function fixture(options = {}, label) {
    const { sdk, wrapCodemodeExtension } = await dependencies();
    const runtime = new SyntheticRuntime(label);
    const registry = new sdk.ModelRegistry(runtime);
    const entries = [], tools = [];
    let original;
    const officialFactory = sdk.createCodemodeExtension(options);
    const api = {
        registerTool(tool) { original ??= tool; tools.push(tool); },
        getSettings() { return { codemode: { mode: 'on' } }; },
        getAllTools() { return tools; },
        appendEntry(customType, data) { entries.push({ type: 'custom', customType, data }); },
    };
    wrapCodemodeExtension(pi => officialFactory(new Proxy(pi, {
        get(target, key) {
            if (key === 'registerTool') return tool => { original = tool; return target.registerTool(tool); };
            return Reflect.get(target, key);
        },
    })))(api);
    const context = { tools: [], modelRegistry: registry, sessionManager: { getBranch: () => entries },
        executeTool() { throw new Error('No fixture tools'); } };
    const run = code => tools[0].execute('fixture-script', { code }, undefined, undefined, context);
    return { runtime, registry, original, tool: tools[0], context, entries, run };
}
function text(result) { return result.content.filter(block => block.type === 'text').map(block => block.text).join('\n'); }
function assertNoImages(runtime) {
    assert.equal(runtime.calls.some(call => call.method.startsWith('image-')), false, 'no image auth or provider activity');
}

test('main and child native factories install the image boundary', async () => {
    const { sdk } = await dependencies();
    const { nativeExtensionFactories, childNativeExtensions } = await import('../server/pi-native-mcp.mjs');
    const main = (await nativeExtensionFactories()).find(entry => entry.name === 'codemode');
    const child = childNativeExtensions({ cwd, agentDir, allowedTools: ['codemode'] }).find(entry => entry.name === 'codemode');
    for (const [label, entry] of [['main', main], ['child', child]]) {
        const runtime = new SyntheticRuntime(label), tools = [];
        await entry.factory({ registerTool: tool => tools.push(tool), getSettings: () => ({}), getAllTools: () => tools });
        const result = await tools[0].execute(label, { code: `return await models.generateImages(${JSON.stringify(imageRef)}, ${JSON.stringify(imageContext)});` }, undefined, undefined,
            { tools: [], modelRegistry: new sdk.ModelRegistry(runtime), sessionManager: { getBranch: () => [] } });
        assert.equal(result.isError, true, label);
        assert.match(text(result), /blocked in Pivane codemode/, label);
        assertNoImages(runtime);
    }
});

test('official factory schema, renderers, loadout and options retain their identity', async () => {
    const { codemodeSchema } = await dependencies();
    const f = await fixture({ mode: 'only', inlineBudget: 0 });
    for (const key of Object.keys(f.original).filter(key => key !== 'execute')) assert.equal(f.tool[key], f.original[key], key);
    assert.equal(f.tool.parameters, codemodeSchema);
    assert.equal(f.tool.reachesTools, f.original.reachesTools);
    assert.deepEqual(f.tool.reachesTools({ code: 'await tools.mcp__fixture__echo({});' }), ['await', 'tools', 'mcp__fixture__echo']);
    assert.equal(f.tool.reachesTools({ code: 'text(ALL_TOOLS);' }), 'all');
    assert.equal(f.tool.defaultActive, false);
    assert.equal(f.tool.exposure, 'model-only');
    const nested = { name: 'fixture_echo', description: 'Synthetic echo', parameters: { type: 'object', properties: {} } };
    const loadout = { callable: [nested], declared: [nested, f.tool], getExposure: () => 'direct', getNamespace: () => undefined, getPromptGuidelines: () => [] };
    const prepared = f.tool.prepareLoadout(loadout);
    assert.deepEqual(prepared.hiddenDeclarations, ['fixture_echo']);
    assert.match(prepared.descriptions.codemode, /models/);
    assert.doesNotMatch(prepared.descriptions.codemode, /### `fixture_echo`/);
    const disabled = await fixture({ models: false });
    assert.doesNotMatch(disabled.tool.description, /`models`/);
    const result = await disabled.run('return typeof models;');
    assert.match(text(result), /undefined/);
    assert.deepEqual(disabled.runtime.calls, []);
});

test('real official codemode blocks direct, aliased and computed images before registry auth/provider activity', async () => {
    const f = await fixture();
    const args = `${JSON.stringify(imageRef)}, ${JSON.stringify(imageContext)}`;
    for (const code of [
        `return await models.generateImages(${args});`,
        `const { generateImages: paint } = models; return await paint(${args});`,
        `const method = ['generate', 'Images'].join(''); return await models[method](${args});`,
        `const paint = models.generateImages.bind(models); return await paint(${args});`,
        `return await models.generateImages.call(Object.getPrototypeOf(models), ${args});`,
    ]) {
        const result = await f.run(code);
        assert.equal(result.isError, true, code);
        assert.match(text(result), /models\.generateImages\(\) is blocked in Pivane codemode/);
        assert.match(text(result), /media planning and confirmation.*user-confirmed media execution ticket/);
        assert.equal(result.usage, undefined);
        assert.equal(result.content.some(block => block.type === 'image'), false);
        assertNoImages(f.runtime);
    }
    assert.equal(f.context.modelRegistry, f.registry, 'original context is unchanged');
    assert.equal(f.registry.generateImages, Object.getPrototypeOf(f.registry).generateImages, 'original registry is unchanged');
});

test('official catalog, classifiers, usage and branch store keep working after a caught image denial', async () => {
    const f = await fixture();
    const result = await f.run(`
        const catalog = await models.getModelsOfType('image', 'fixture');
        const available = await models.getAvailableOfType('classifier', 'fixture');
        const model = await models.getModelOfType('classifier', 'fixture', 'classifier');
        try { await models.generateImages(catalog[0], ${JSON.stringify(imageContext)}); } catch (error) { text(error.message); }
        const classified = await models.classify({...model, baseUrl:'https://invalid.example', headers:{injected:'synthetic'}}, ${JSON.stringify(classifierContext)});
        store('classification', classified.answers);
        return { catalog, available, model, classified };
    `);
    assert.equal(result.isError, undefined);
    assert.match(text(result), /"probability":1/);
    assert.match(text(result), /"name":"first"/);
    assert.doesNotMatch(text(result), /synthetic-header|invalid\.example/);
    assert.deepEqual(result.usage, usage);
    assert.ok(result.details.calls.some(call => call.name === 'models.classify' && call.status === 'ok' && call.cost === 0.125));
    const call = f.runtime.calls.find(call => call.method === 'classify');
    assert.deepEqual(call.context, classifierContext);
    assert.equal(call.model.baseUrl, undefined, 'official catalog resolves caller-supplied model');
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.ok(f.runtime.calls.find(call => call.method === 'availability').options.signal instanceof AbortSignal);
    assert.deepEqual(f.entries[0].data, { set: { classification: { approved: { type: 'bool', probability: 1 } } }, delete: [] });
    assert.match(text(await f.run('return load("classification");')), /"probability":1/);
    const failed = await f.run(`store('discard', true); await models.generateImages(${JSON.stringify(imageRef)}, ${JSON.stringify(imageContext)});`);
    assert.equal(failed.isError, true);
    assert.equal(f.entries.length, 1, 'official failed-script writes are discarded');
    assertNoImages(f.runtime);
});

test('Pi 1.2 images from read retain private temporary paths and classifier image context without opening generation', async () => {
    const f = await fixture();
    const block = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC' };
    const { sdk } = await dependencies();
    const read = sdk.createReadTool(cwd);
    const file = path.join(cwd, 'synthetic.png'); fs.writeFileSync(file, Buffer.from(block.data, 'base64'));
    const calls = []; f.context.tools = [read];
    f.context.executeTool = async (name, args) => { calls.push({ name, args }); return { toolCall: { id: 'fixture-read' }, result: await read.execute('fixture-read', args), isError: false }; };
    const files = [];
    try {
        const result = await f.run('const pic=await tools.read({path:"synthetic.png"}); image(pic); image(pic); text(pic.type); for(let i=0;i<300;i++)text("image-tail-"+i); console.log("console-one"); text("next-item"); return "last-item";');
        assert.equal(result.isError, undefined, text(result));
        assert.equal(result.content.filter(item => item.type === 'image').length, 2);
        const paths = [...text(result).matchAll(/\[Image saved to ([^\n]+?) \(image\/png,/g)].map(match => match[1]);
        assert.equal(paths.length, 2); assert.equal(paths[0], paths[1], 'same image is saved once'); files.push(paths[0]);
        assert.equal(path.dirname(paths[0]), os.tmpdir());
        assert.deepEqual(fs.readFileSync(paths[0]), Buffer.from(block.data, 'base64'));
        if (process.platform !== 'win32') assert.equal(fs.statSync(paths[0]).mode & 0o777, 0o600);
        assert.deepEqual(calls, [{ name: 'read', args: { path: 'synthetic.png' } }]);
        assert.match(text(result), /==> text [0-9]+\/[0-9]+ <==/); assert.match(text(result), /image-tail-299/); assert.match(text(result), /<console_output>\nconsole-one\n<\/console_output>/);
        const context = { ...classifierContext, images: [block] };
        const classified = await f.run(`return await models.classify(${JSON.stringify(classifierRef)}, ${JSON.stringify(context)});`);
        assert.equal(classified.isError, undefined); assert.deepEqual(classified.usage, usage);
        assert.deepEqual(f.runtime.calls.find(call => call.method === 'classify').context, context);
        const invalid = await f.run(`return await models.classify(${JSON.stringify(classifierRef)}, {...${JSON.stringify(classifierContext)},images:[{type:'image',data:12,mimeType:'image/png'}]});`);
        assert.equal(invalid.isError, true); assert.match(text(invalid), /context.images\[0\] must be an image block/);
        assert.equal(f.runtime.calls.filter(call => call.method === 'classify').length, 1);
        assertNoImages(f.runtime);
    } finally { for (const file of files) fs.rmSync(file, { force: true }); }
});

test('Pi 1.2 frozen intrinsics prevent prototype corruption and later scripts remain usable', async () => {
    const f = await fixture();
    const result = await f.run('try { Array.prototype.toJSON=()=>"corrupt"; } catch {} try { Object.prototype.injected=true; } catch {} return [1,2,3];');
    assert.equal(result.isError, undefined); assert.match(text(result), /\[1,2,3\]/); assert.doesNotMatch(text(result), /corrupt/);
    const next = await f.run('return {clean:!Object.prototype.injected,values:[4,5]};');
    assert.equal(next.isError, undefined); assert.match(text(next), /"clean":true/); assert.match(text(next), /\[4,5\]/);
});

test('Pi 1.2 output limits fail scripts without replaying completed calls or committing failed store writes', { timeout: 60000 }, async () => {
    const f = await fixture();
    const { MAX_OUTPUT_CHARS, MAX_OUTPUT_ITEMS } = await import('@earendil-works/pi-codemode');
    assert.equal(MAX_OUTPUT_CHARS, 16 * 1024 * 1024); assert.equal(MAX_OUTPUT_ITEMS, 100000);
    const result = await f.run(`
        await models.classify(${JSON.stringify(classifierRef)}, ${JSON.stringify(classifierContext)});
        store('failed-output', true);
        try { text('x'.repeat(${MAX_OUTPUT_CHARS + 1})); } catch { text('must-not-resume'); }
    `);
    assert.equal(result.isError, true); assert.match(text(result), /script output exceeded the limit/);
    assert.doesNotMatch(text(result), /must-not-resume/);
    assert.equal(f.runtime.calls.filter(call => call.method === 'classify').length, 1);
    assert.deepEqual(result.usage, usage); assert.deepEqual(f.entries, []); assertNoImages(f.runtime);
    const items = await f.run(`for (let i = 0; i <= ${MAX_OUTPUT_ITEMS}; i++) text('');`);
    try {
        assert.equal(items.isError, true); assert.match(text(items), /script output exceeded the limit/);
    } finally { if (items.details.fullOutputPath) fs.rmSync(items.details.fullOutputPath, { force: true }); }
});

test('large text integration keeps native truncation, private full output, console, usage and branch store', async () => {
    const f = await fixture();
    const result = await f.run(`// @options: {"max_output_tokens": 100}
        await models.classify(${JSON.stringify(classifierRef)}, ${JSON.stringify(classifierContext)});
        for (let i = 0; i < 300; i++) text(i % 2 ? 'line-' + i : '');
        console.log('tail-one'); console.log('tail-two');
        store('large-success', { ok: true }); return { last: true };
    `);
    const output = text(result), file = result.details.fullOutputPath;
    assert.equal(result.isError, undefined); assert.deepEqual(result.usage, usage);
    assert.match(output, /Warning: truncated output/); assert.ok(file);
    try {
        const full = fs.readFileSync(file, 'utf8');
        const expected = Array.from({ length: 300 }, (_, i) => `==> text ${i + 1}/301 <==\n${i % 2 ? 'line-' + i : ''}`)
            .map((value, i) => value + (i % 2 ? '\n' : '')).join('')
            + '==> text 301/301 <==\n{"last":true}\n<console_output>\ntail-one\ntail-two\n</console_output>';
        assert.equal(full, expected);
        assert.equal(path.dirname(file), os.tmpdir());
        if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    } finally { if (file) fs.rmSync(file, { force: true }); }
    assert.equal(f.runtime.calls.filter(call => call.method === 'classify').length, 1);
    assert.deepEqual(f.entries[0].data, { set: { 'large-success': { ok: true } }, delete: [] });
    assert.match(text(await f.run('return load("large-success");')), /"ok":true/); assertNoImages(f.runtime);
});

test('large partial text preserves native timeout and abort without failed store or replay', { timeout: 15000 }, async () => {
    for (const mode of ['timeout', 'abort']) {
        const f = await fixture(), controller = new AbortController();
        const code = `${mode === 'timeout' ? '// @options: {"timeout_ms": 500}\n' : ''}
            await models.classify(${JSON.stringify(classifierRef)}, ${JSON.stringify(classifierContext)});
            store('never-commit', true); for(let i=0;i<300;i++)text('partial-'+i);
            while(true){}
        `;
        const timer = mode === 'abort' ? setTimeout(() => controller.abort(new Error('fixture-abort')), 500) : undefined;
        let result;
        try { result = await f.tool.execute('partial-stop', { code }, controller.signal, undefined, f.context); }
        finally { clearTimeout(timer); }
        assert.equal(result.isError, true); assert.match(text(result), mode === 'timeout' ? /Script timed out/ : /Script aborted.*fixture-abort/);
        assert.match(text(result), /==> text 300\/300 <==\npartial-299/);
        assert.deepEqual(result.usage, usage); assert.deepEqual(f.entries, []);
        assert.equal(f.runtime.calls.filter(call => call.method === 'classify').length, 1); assertNoImages(f.runtime);
    }
});

test('invalid and non-first options lines fail before model or nested calls, updates and store writes', async () => {
    const f = await fixture(), nested = [], updates = [];
    f.context.tools = [{ name: 'once', description: 'Synthetic side effect', parameters: { type: 'object' } }];
    f.context.executeTool = async () => { nested.push('called'); throw new Error('must not run'); };
    for (const code of [
        'await tools.once({});\n// @options: {"timeout_ms": 500}\nstore("never",true);',
        '\n// @options: {"timeout_ms": 500}\nawait tools.once({});',
        '// @options: {"timeout_ms": 0}\nawait tools.once({});',
        '// @options: {"max_output_tokens": -1}\nawait tools.once({});',
        '// @options: {broken}\nawait tools.once({});',
    ]) {
        await assert.rejects(() => f.tool.execute('invalid-source', { code }, undefined, update => updates.push(update), f.context),
            error => error.name === 'CodemodeSourceError' && /first line|@options/.test(error.message));
    }
    assert.deepEqual(nested, []);
    assert.deepEqual(f.runtime.calls, []);
    assert.deepEqual(updates, []);
    assert.deepEqual(f.entries, []);
});

test('registry facade hides the runtime and prototype and follows current registry on every execution', async () => {
    const { sdk, wrapCodemodeExtension } = await dependencies();
    const seen = [], registered = [];
    const factory = pi => pi.registerTool({ name: 'codemode', execute: async (_id, _params, _signal, _update, ctx) => {
        const registry = ctx.modelRegistry;
        seen.push(registry);
        assert.equal(Object.getPrototypeOf(registry), null);
        assert.equal(registry.runtime, undefined);
        assert.equal(registry.constructor, undefined);
        assert.ok(Object.isFrozen(registry));
        assert.throws(() => registry.generateImages(), /Pivane media planning and confirmation/);
        assert.throws(() => sdk.ModelRegistry.prototype.generateImages.call(registry, imageRef, imageContext), TypeError);
        assert.throws(() => Object.defineProperty(registry, 'generateImages', { value: () => 'bypass' }), TypeError);
        return registry.getModelsOfType('image')[0].name;
    } });
    const wrapped = wrapCodemodeExtension(factory);
    const first = new SyntheticRuntime('first'), second = new SyntheticRuntime('second');
    const api = { registerTool: tool => registered.push(tool) };
    wrapped(api);
    const ctx = { modelRegistry: new sdk.ModelRegistry(first) };
    assert.equal(await registered[0].execute('a', {}, undefined, undefined, ctx), 'first');
    ctx.modelRegistry = new sdk.ModelRegistry(second);
    assert.equal(await registered[0].execute('b', {}, undefined, undefined, ctx), 'second');
    wrapped(api); // Fresh factory registration after resource reload.
    assert.equal(await registered[1].execute('c', {}, undefined, undefined, ctx), 'second');
    assert.equal(new Set(seen).size, 3);
    assertNoImages(first); assertNoImages(second);
    const official = await fixture();
    official.context.modelRegistry = new sdk.ModelRegistry(second);
    assert.match(text(await official.run('return await models.getModelsOfType("image");')), /"name":"second"/);
    const blocked = await official.run(`await models.generateImages(${JSON.stringify(imageRef)}, ${JSON.stringify(imageContext)});`);
    assert.equal(blocked.isError, true);
    assertNoImages(second);
});

test('official scripts without a session still work and unrelated tool registration passes through', async () => {
    const { wrapCodemodeExtension } = await dependencies();
    const unrelated = { name: 'fixture_tool', execute: () => 'unchanged' }, registered = [];
    wrapCodemodeExtension(pi => pi.registerTool(unrelated))({ registerTool: tool => registered.push(tool) });
    assert.equal(registered[0], unrelated);
    const f = await fixture();
    const result = await f.tool.execute('no-session', { code: 'return 42;' });
    assert.match(text(result), /Script completed[\s\S]*42/);
});

test('real session preserves namespace discovery, nested hook allowlist and successful calls before image denial', async t => {
    const { sdk, wrapCodemodeExtension } = await dependencies();
    const settings = sdk.SettingsManager.inMemory({ enableInstallTelemetry: false, defaultProjectTrust: 'never', defaultTools: ['codemode'] });
    const synthetic = new SyntheticRuntime();
    const runtime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, 'synthetic-auth.json'), modelsPath: null,
        modelsStorePath: path.join(agentDir, 'synthetic-store.json'), refreshOnCreate: false, allowModelNetwork: false });
    // Fixture-local model methods only. Production runtime and its prototype are untouched.
    for (const method of ['getModelsOfType', 'getAvailableOfType', 'getModelOfType', 'classify', 'generateImages']) {
        runtime[method] = synthetic[method].bind(synthetic);
    }
    const nestedRuns = [], hooks = [], events = [];
    const namespace = { name: 'mcp__fixture-server', aliases: ['fixture-server'], description: 'Synthetic namespace', instructions: 'Fixture instructions' };
    const extensionFactories = [
        { name: 'codemode', factory: wrapCodemodeExtension(sdk.createCodemodeExtension()) },
        { name: 'fixture-tools', factory: pi => {
            for (const name of ['echo', 'forbidden']) pi.registerTool({ name: `mcp__fixture-server__${name}`, label: name,
                description: `Synthetic ${name}`, namespace, exposure: 'deferred',
                parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
                execute: async (_id, args) => { nestedRuns.push(name); return { content: [{ type: 'text', text: `NESTED_OK:${args.value}` }] }; } });
            pi.on('tool_call', event => {
                hooks.push(event.toolName);
                if (event.toolName !== 'mcp__fixture-server__echo' && event.toolName !== 'codemode') {
                    return { block: true, reason: 'Tool is outside this child\'s authorized tool allowlist.' };
                }
            });
        } },
    ];
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noSkills: true, noPromptTemplates: true,
        noContextFiles: true, extensionFactories });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await sdk.createAgentSession({ cwd, agentDir, modelRuntime: runtime, settingsManager: settings,
        sessionManager: sdk.SessionManager.inMemory(cwd), resourceLoader: loader,
        model: { provider: 'fixture', id: 'chat', api: 'openai-completions', name: 'Synthetic chat', input: ['text'], contextWindow: 32000, maxTokens: 1000 } });
    await session.bindExtensions({ mode: 'print' });
    t.after(async () => { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); });
    session.subscribe(event => events.push(event));
    // The native nested-call pipeline requires an issued parent tool call.
    session.agent.state.messages.push({ role: 'assistant', content: [{ type: 'toolCall', id: 'parent-call', name: 'codemode', arguments: {} }],
        provider: 'fixture', api: 'openai-completions', model: 'chat', stopReason: 'toolUse', timestamp: Date.now() });
    const tool = session.agent.state.tools.find(candidate => candidate.name === 'codemode');
    const code = `
        text(await describeNamespace('fixture_server'));
        text(await searchTools('echo', { namespace: 'fixture_server' }));
        text(await describeTool('mcp__fixture_server__echo'));
        text(ALL_TOOLS.map(t => t.name));
        const outcomes = await Promise.allSettled([
            tools.mcp__fixture_server__echo({value:'accepted'}),
            tools.mcp__fixture_server__forbidden({value:'denied'})
        ]);
        text(outcomes.map(r => r.status === 'fulfilled' ? r.value : r.reason.message));
        const paint = models[['generate', 'Images'].join('')];
        await paint(${JSON.stringify(imageRef)}, ${JSON.stringify(imageContext)});
    `;
    const result = await tool.execute('parent-call', { code });
    assert.equal(result.isError, true);
    assert.match(text(result), /Synthetic namespace/);
    assert.match(text(result), /Fixture instructions/);
    assert.match(text(result), /mcp__fixture_server__echo/);
    assert.match(text(result), /NESTED_OK:accepted/);
    assert.match(text(result), /authorized tool allowlist/);
    assert.match(text(result), /Pivane media planning and confirmation/);
    assert.deepEqual(nestedRuns, ['echo']);
    assert.ok(hooks.includes('mcp__fixture-server__forbidden'));
    assert.ok(events.some(event => event.type === 'tool_execution_start' && event.parentToolCallId === 'parent-call'));
    assert.ok(result.details.calls.some(call => call.name === 'mcp__fixture-server__echo' && call.status === 'ok'));
    assert.ok(result.details.calls.some(call => call.name === 'mcp__fixture-server__forbidden' && call.status === 'error'));
    assertNoImages(synthetic);
});
