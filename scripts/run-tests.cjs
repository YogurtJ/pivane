// Enumerate tests in Node so cmd.exe and POSIX shells run the same suite.
const { sourceFiles } = require('./source-files.cjs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const usage = 'Usage: npm test -- [--list] [--timing] [test/file.test.js | test/directory ...]';

function selectTests(root, args) {
    let list = false, timing = false;
    const selectors = [];
    for (const arg of args) {
        if (arg === '--list') list = true;
        else if (arg === '--timing') timing = true;
        else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}\n${usage}`);
        else {
            const name = arg.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
            if (!name || name.split('/').some(part => !part || part === '.' || part === '..') || !/^test(?:\/|$)/.test(name)) {
                throw new Error(`Expected a repository-relative test file or directory: ${arg}`);
            }
            selectors.push(name);
        }
    }
    const discovered = sourceFiles(root, 'tests');
    if (!discovered.length) throw new Error('No Node tests found');
    for (const selector of selectors) {
        if (!discovered.some(file => file === selector || file.startsWith(selector + '/'))) {
            throw new Error(`No Node tests match: ${selector}`);
        }
    }
    const files = selectors.length ? discovered.filter(file => selectors.some(selector => file === selector || file.startsWith(selector + '/'))) : discovered;
    return { files, list, timing };
}

// Preserve the full-suite credential filtering for targeted runs as well.
function testEnvironment(environment) {
    const env = { ...environment };
    const ambientProviderEnv = /^(?:OPENAI|OPENROUTER|ANTHROPIC|GOOGLE|GEMINI|AZURE|MISTRAL|XAI|DEEPSEEK|MOONSHOT|GROQ|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|COHERE|VERTEX)_(?:API_KEY|API_TOKEN|TOKEN|KEY|CREDENTIALS|PROFILE|BASE_URL)$/;
    const memoryFixtureEnv = new Set(['PIVANE_TEST_HERMES_BUNDLE', 'PIVANE_TEST_PI_JITI']);
    for (const key of Object.keys(env)) {
        if (key.startsWith('PIVANE_') && !memoryFixtureEnv.has(key) || ambientProviderEnv.test(key) || /^(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_PROFILE|GOOGLE_APPLICATION_CREDENTIALS|MINIMAX_API_KEY)$/.test(key)) delete env[key];
    }
    return env;
}

function main(args) {
    const { files, list, timing } = selectTests(root, args);
    if (list) { console.log(files.join('\n')); return 0; }
    const env = testEnvironment(process.env);
    env.PIVANE_TEST_HERMES_BUNDLE ||= require('../server/pi-bundled-capabilities').memoryBundle();
    env.PIVANE_TEST_PI_JITI ||= require('node:module').createRequire(path.join(root, 'node_modules/@earendil-works/pi-coding-agent/package.json')).resolve('jiti');
    if (!require('../server/profile-memory/management').profileMemoryCapability({ bundlePath: env.PIVANE_TEST_HERMES_BUNDLE }).installed) throw new Error('Bundled memory must be installed before testing (npm ci)');
    const options = ['--test', '--test-concurrency=1'];
    if (timing) options.push('--test-reporter=' + path.join(__dirname, 'test-timing-reporter.cjs'));
    const result = spawnSync(process.execPath, [...options, ...files.map(name => path.join(root, name))], { cwd: root, env, stdio: 'inherit' });
    if (result.error) console.error(result.error.message);
    return result.status === null ? 1 : result.status;
}

module.exports = { selectTests, testEnvironment };
if (require.main === module) {
    try { process.exitCode = main(process.argv.slice(2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
