const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { publicDocumentation, checkDocumentation } = require('./check-docs.cjs');

const root = path.resolve(__dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const release = process.argv[2] === '--release';
if (process.argv.length > (release ? 3 : 2)) throw new Error('Usage: node scripts/package-trial.cjs [--release]');
const application = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
if (application.name !== 'pivane' || !/^\d+\.\d+\.\d+(?:-[a-z0-9]+(?:\.[a-z0-9]+)*)?$/.test(application.version)
    || lock.version !== application.version || lock.packages[''].version !== application.version
    || lock.name !== application.name || lock.packages[''].name !== application.name) throw new Error('Application/lockfile release identity mismatch');
const releaseMetadata = { product: 'Pivane', appVersion: application.version, piVersion: application.dependencies['@earendil-works/pi-coding-agent'], channel: application.version.includes('-') ? 'prerelease' : 'stable' };
const files = [
    ...publicDocumentation(root), 'docs/public-files.json', 'scripts/check-docs.cjs',
    'native/pi-win32-fd.c', 'native/pi-win32-x64-fd.node', 'native/win32-x64-manifest.json', 'scripts/build-win32-fd.cjs', 'scripts/check-syntax.cjs',
    'native/pi-darwin-fd.c', 'native/pi-darwin-fd.node', 'native/darwin-fd-manifest.json', 'scripts/build-darwin-fd.cjs',
    'package.json', 'package-lock.json', 'LICENSE', 'server.js', '.env.example', '.gitignore',
    'public/vendor/mermaid-11.17.2.min.js', 'public/vendor/mermaid-LICENSE.txt',
    'public/vendor/katex-0.18.7/katex.min.js', 'public/vendor/katex-0.18.7/katex.min.css', 'public/vendor/katex-0.18.7/LICENSE',
    'public/brand/fontawesome-6.4.0/css/all.min.css', 'public/brand/fontawesome-6.4.0/LICENSE.txt',
    ...['fa-brands-400', 'fa-regular-400', 'fa-solid-900', 'fa-v4compatibility'].flatMap(name => ['woff2','ttf'].map(ext => `public/brand/fontawesome-6.4.0/webfonts/${name}.${ext}`)),
    'public/site.webmanifest', 'public/brand/favicon.ico', 'public/brand/apple-touch-icon.png',
    ...[64, 192, 512, 1024].map(size => `public/brand/logo-${size}.png`),
    'config/media-lab.json', 'config/tts-providers.json', 'scripts/package-trial.cjs', 'scripts/access-reset.cjs', 'scripts/run-tests.cjs',
    // Synthetic compatibility fixture only; user session directories are never included.
    'test/private-file-helper.cjs', 'test/release/guard.cjs',
    'test/fixtures/pi-0843-session.jsonl', 'test/fixtures/release-video.mp4', 'test/release/provider.cjs', 'test/release/data.cjs', 'test/release/state.cjs', 'test/release/runtime.cjs',
    'pi-packages/media-workbench/package.json', 'pi-packages/media-workbench/extensions/media-tools.ts'
];
function includeDirectory(directory, pattern) {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
        if (entry.isFile() && pattern.test(entry.name) && !/\.bak|\.tmp|~$/.test(entry.name)) files.push(`${directory}/${entry.name}`);
    }
}
includeDirectory('public/vendor/katex-0.18.7/fonts', /^KaTeX_[A-Za-z0-9]+-[A-Za-z]+\.(woff2?|ttf)$/);
includeDirectory('server', /\.(js|mjs|ts)$/);
includeDirectory('public', /\.(html|css|js)$/);
includeDirectory('test', /\.test\.js$/);
includeDirectory('test/browser', /\.cjs$/);
includeDirectory('test/release', /\.cjs$/);
checkDocumentation(root, files);
if (application.license !== 'ISC' || !fs.readFileSync(path.join(root, 'LICENSE'), 'utf8').startsWith('ISC License\n')) throw new Error('Project license declaration mismatch');
const nativeManifest = JSON.parse(fs.readFileSync(path.join(root, 'native/darwin-fd-manifest.json')));
if (nativeManifest.napi !== 8 || nativeManifest.sourceSha256 !== hash(fs.readFileSync(path.join(root, 'native/pi-darwin-fd.c')))
    || nativeManifest.binarySha256 !== hash(fs.readFileSync(path.join(root, 'native/pi-darwin-fd.node')))) {
    throw new Error('Native file descriptor backend must match its source and build manifest');
}
const windowsManifest = JSON.parse(fs.readFileSync(path.join(root, 'native/win32-x64-manifest.json')));
if (windowsManifest.napi !== 8 || windowsManifest.arch !== 'x64' || windowsManifest.platform !== 'win32'
    || windowsManifest.sourceSha256 !== hash(fs.readFileSync(path.join(root, 'native/pi-win32-fd.c')))
    || windowsManifest.binarySha256 !== hash(fs.readFileSync(path.join(root, 'native/pi-win32-x64-fd.node')))) throw new Error('Windows native backend manifest mismatch');
const publicProfile = JSON.parse(fs.readFileSync(path.join(root, 'config/media-lab.json')));
const tts = JSON.parse(fs.readFileSync(path.join(root, 'config/tts-providers.json')));
if (publicProfile.image.identity || publicProfile.image.negative || publicProfile.image.defaultLora !== 'none'
    || Object.keys(publicProfile.image.presets || {}).length || publicProfile.gpuExec || tts.providers.length) {
    throw new Error('Trial packaging requires neutral public media configuration');
}
if (publicProfile.models.some(model => model.connection || model.instructionsFile || !['zimage', 'flux2'].includes(model.adapter))) {
    throw new Error('Move instance-specific model definitions outside source before packaging');
}
const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
for (const line of envExample.split(/\r?\n/)) {
    if (/^[A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*\S/.test(line)) throw new Error('Environment example contains a credential value');
}
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-trial-package-'));
const packageName = release ? `pivane-${application.version}` : 'pivane-trial';
const packageDir = path.join(temporary, packageName);
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const outputDir = path.join(root, 'dist');
fs.mkdirSync(outputDir, { recursive: true });
const archive = path.join(outputDir, release ? `${packageName}.tar.gz` : `${packageName}-${stamp}.tar.gz`);
if (fs.existsSync(archive)) throw new Error('Trial archive already exists');
try {
    const manifest = [];
    for (const file of [...new Set(files)].sort()) {
        const original = path.join(root, file);
        if (!fs.lstatSync(original).isFile() || !fs.realpathSync(original).startsWith(root + path.sep)) throw new Error(`Not a regular source file: ${file}`);
        const bytes = fs.readFileSync(original);
        const destination = path.join(packageDir, file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o644 });
        manifest.push({ path: file, bytes: bytes.length, sha256: hash(bytes) });
    }
    checkDocumentation(packageDir, manifest.map(file => file.path));
    fs.writeFileSync(path.join(packageDir, 'TRIAL_MANIFEST.json'), JSON.stringify({ version: 1, ...releaseMetadata, generatedAt: new Date().toISOString(), files: manifest }, null, 2) + '\n');
    const ownerOptions = ['darwin', 'win32'].includes(process.platform)
        ? ['--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root']
        : ['--sort=name', '--owner=0', '--group=0', '--numeric-owner'];
    execFileSync(process.platform === 'darwin' ? '/usr/bin/tar' : 'tar', [...ownerOptions, '-czf', archive, '-C', temporary, packageName], {
        env: { ...process.env, COPYFILE_DISABLE: '1' }
    });
    const sha256 = hash(fs.readFileSync(archive));
    fs.writeFileSync(archive + '.sha256', `${sha256}  ${path.basename(archive)}\n`, { flag: 'wx' });
    fs.writeFileSync(archive + '.manifest.json', JSON.stringify({ archive: path.basename(archive), sha256, ...releaseMetadata, files: manifest }, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ archive, sha256, ...releaseMetadata, files: manifest.length, bytes: fs.statSync(archive).size }, null, 2));
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
