// Enumerate tests in Node so cmd.exe and POSIX shells run the same suite.
const { sourceFiles } = require('./source-files.cjs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
// Tests use synthetic providers and must not inherit a developer's ambient Pi
// credentials. Pi 0.86 makes Radius/OpenRouter models available from ambient
// auth, which otherwise changes model snapshots and test routing.
const ambientProviderEnv = /^(?:OPENAI|OPENROUTER|ANTHROPIC|GOOGLE|GEMINI|AZURE|MISTRAL|XAI|DEEPSEEK|MOONSHOT|GROQ|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|COHERE|VERTEX)_(?:API_KEY|API_TOKEN|TOKEN|KEY|CREDENTIALS|PROFILE|BASE_URL)$/;
const memoryFixtureEnv = new Set(['PIVANE_TEST_HERMES_BUNDLE', 'PIVANE_TEST_PI_JITI']);
for (const key of Object.keys(process.env)) {
    if (key.startsWith('PIVANE_') && !memoryFixtureEnv.has(key) || ambientProviderEnv.test(key) || /^(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_PROFILE|GOOGLE_APPLICATION_CREDENTIALS|MINIMAX_API_KEY)$/.test(key)) delete process.env[key];
}
process.env.PIVANE_TEST_HERMES_BUNDLE ||= require('../server/pi-bundled-capabilities').memoryBundle();
process.env.PIVANE_TEST_PI_JITI ||= require('node:module').createRequire(path.join(root, 'node_modules/@earendil-works/pi-coding-agent/package.json')).resolve('jiti');
if (!require('../server/profile-memory/management').profileMemoryCapability({ bundlePath: process.env.PIVANE_TEST_HERMES_BUNDLE }).installed) throw new Error('Bundled memory must be installed before testing (npm ci)');
const files = sourceFiles(root, 'tests');
if (!files.length) throw new Error('No Node tests found');
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files.map(name => path.join(root, name))], {
    cwd: root, env: process.env, stdio: 'inherit'
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status === null ? 1 : result.status;
