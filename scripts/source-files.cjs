const fs = require('node:fs');
const path = require('node:path');

// Application source discovery is shared by checking, testing and packaging.
// Data, vendored assets and maintainer records are never discovered as source.
const GROUPS = Object.freeze({
    server: { directory: 'server', extensions: ['.js', '.mjs', '.ts'] },
    public: { directory: 'public', extensions: ['.js', '.css', '.html'], excluded: ['vendor', 'brand', 'images', 'videos', 'audio', 'downloads', 'legacy-workspace'] },
    scripts: { directory: 'scripts', extensions: ['.cjs'] },
    tests: { directory: 'test', pattern: /\.test\.js$/ },
    testSupport: { directory: 'test', extensions: ['.js', '.cjs', '.mjs', '.ts'] },
    browser: { directory: 'test/browser', extensions: ['.cjs'] },
    release: { directory: 'test/release', extensions: ['.cjs'] }
});

function sourceFiles(root, group) {
    const rule = GROUPS[group];
    if (!rule) throw new Error(`Unknown source group: ${group}`);
    const files = [];
    function visit(relative) {
        const directory = path.join(root, relative);
        if (fs.lstatSync(directory).isSymbolicLink()) throw new Error(`Source directory is a symlink: ${relative}`);
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
            if (entry.name.startsWith('.') || rule.excluded?.includes(entry.name) || ['node_modules', 'backups'].includes(entry.name) || /\.bak(?:[.-]|$)|\.tmp$|~$/i.test(entry.name)) continue;
            const file = `${relative}/${entry.name}`;
            if (entry.isSymbolicLink()) throw new Error(`Source entry is a symlink: ${file}`);
            if (entry.isDirectory()) visit(file);
            else if (entry.isFile() && (rule.pattern ? rule.pattern.test(entry.name) : rule.extensions.includes(path.extname(entry.name)))) files.push(file);
        }
    }
    visit(rule.directory);
    return files;
}

function distributionFiles(root) {
    const { publicDocumentation, assertPublicPath } = require('./check-docs.cjs');
    const files = [
        ...publicDocumentation(root), 'docs/public-files.json',
        'native/pi-win32-fd.c', 'native/pi-win32-x64-fd.node', 'native/win32-x64-manifest.json',
        'native/pi-darwin-fd.c', 'native/pi-darwin-fd.node', 'native/darwin-fd-manifest.json',
        'package.json', 'package-lock.json', 'LICENSE', 'server.js', '.env.example', '.gitignore',
        'public/vendor/mermaid-11.17.2.min.js', 'public/vendor/mermaid-LICENSE.txt',
        'public/vendor/katex-0.18.7/katex.min.js', 'public/vendor/katex-0.18.7/katex.min.css', 'public/vendor/katex-0.18.7/LICENSE',
        'public/brand/fontawesome-6.4.0/css/all.min.css', 'public/brand/fontawesome-6.4.0/LICENSE.txt',
        ...['fa-brands-400', 'fa-regular-400', 'fa-solid-900', 'fa-v4compatibility'].flatMap(name => ['woff2', 'ttf'].map(ext => `public/brand/fontawesome-6.4.0/webfonts/${name}.${ext}`)),
        'public/site.webmanifest', 'public/brand/favicon.ico', 'public/brand/apple-touch-icon.png',
        ...[64, 192, 512, 1024].map(size => `public/brand/logo-${size}.png`),
        'config/media-lab.json', 'config/tts-providers.json',
        'test/private-file-helper.cjs', 'test/fixtures/pi-0843-session.jsonl', 'test/fixtures/release-video.mp4',
        'pi-packages/media-workbench/package.json', 'pi-packages/media-workbench/extensions/media-tools.ts'
    ];
    const fonts = 'public/vendor/katex-0.18.7/fonts';
    for (const name of fs.readdirSync(path.join(root, fonts)).sort()) {
        if (/^KaTeX_[A-Za-z0-9]+-[A-Za-z]+\.(woff2?|ttf)$/.test(name)) files.push(`${fonts}/${name}`);
    }
    for (const group of Object.keys(GROUPS)) files.push(...sourceFiles(root, group));
    const result = [...new Set(files)].sort();
    for (const file of result) assertPublicPath(file);
    return result;
}

module.exports = { sourceFiles, distributionFiles };
