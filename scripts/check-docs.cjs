const fs = require('node:fs');
const path = require('node:path');
const { lexer, walkTokens } = require('marked');

const PRIVATE_PATH = /^(?:docs\/local(?:\/|$)|backups(?:\/|$)|\.pivane-runtime(?:\/|$)|AGENTS\.local\.md$|\.env(?:$|\.(?!example$))|\.pi(?:\/|$)|node_modules(?:\/|$)|dist(?:\/|$)|public\/(?:images|videos|audio|downloads|legacy-workspace)(?:\/|$)|(?:generation_history|video_history|tts_history|prompts)\.json$)/i;
function assertPublicPath(file) {
    if (typeof file !== 'string' || !file || file.includes('\\') || path.posix.isAbsolute(file)
        || file.split('/').some(part => !part || part === '.' || part === '..') || PRIVATE_PATH.test(file)) {
        throw new Error(`Private or invalid distribution path: ${file}`);
    }
}
function publicDocumentation(root) {
    const registry = JSON.parse(fs.readFileSync(path.join(root, 'docs/public-files.json'), 'utf8'));
    if (registry.version !== 1 || !Array.isArray(registry.files) || new Set(registry.files).size !== registry.files.length) {
        throw new Error('Invalid public documentation registry');
    }
    for (const file of registry.files) {
        assertPublicPath(file);
        if (!file.endsWith('.md')) throw new Error(`Expected Markdown documentation: ${file}`);
    }
    return registry.files;
}
function checkDocumentation(root, distributionFiles) {
    root = fs.realpathSync(root);
    const files = publicDocumentation(root), declared = new Set(files);
    const included = distributionFiles ? new Set([...distributionFiles, 'TRIAL_MANIFEST.json']) : null;
    if (included) for (const file of distributionFiles) assertPublicPath(file);
    const errors = [];
    if (included) for (const file of included) {
        if (file.endsWith('.md') && !declared.has(file)) errors.push(`Distribution Markdown is not declared public: ${file}`);
    }
    function regular(file) {
        const target = path.resolve(root, file);
        const relative = path.relative(root, fs.realpathSync(target));
        return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
            && fs.lstatSync(target).isFile();
    }
    function inspectDirectory(directory) {
        for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
            const file = directory + '/' + entry.name;
            if (file === 'docs/local') continue;
            if (entry.isSymbolicLink()) { errors.push(`Documentation symlink is not allowed: ${file}`); continue; }
            if (entry.isDirectory()) inspectDirectory(file);
            else if (entry.name.endsWith('.md') && !declared.has(file)) errors.push(`Classify documentation in public-files.json or docs/local: ${file}`);
        }
    }
    inspectDirectory('docs');
    const instanceMarker = /\/srv\/Pi5_GUI|\/home\/pi(?:\/|["`])|pi5-[a-z-]+-deploy-\d{8}|\/tmp\/pi-[a-z0-9-]*deploy-result\.json|backups\/[a-z0-9-]+-2026\d{4}/i;
    for (const file of files) {
        if (!regular(file)) { errors.push(`Not a regular public file: ${file}`); continue; }
        if (included && !included.has(file)) errors.push(`Public document omitted from package: ${file}`);
        const text = fs.readFileSync(path.join(root, file), 'utf8');
        if (instanceMarker.test(text)) errors.push(`Maintainer instance record in public document: ${file}`);
        walkTokens(lexer(text), token => {
            if (!['link', 'image'].includes(token.type)) return;
            const href = token.href;
            if (!href || href.startsWith('#') || /^(?:https?:|mailto:|data:|\/\/)/i.test(href)) return;
            if (/^[a-z][a-z\d+.-]*:/i.test(href)) { errors.push(`Unsupported document URL in ${file}: ${href}`); return; }
            let target;
            try { target = decodeURIComponent(href.split(/[?#]/, 1)[0]); } catch { errors.push(`Invalid encoded link in ${file}`); return; }
            if (!target) return;
            const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
            try {
                if (path.posix.isAbsolute(target) || target.includes('\\')) throw new Error('use a relative documentation path');
                assertPublicPath(resolved);
                if (!regular(resolved)) throw new Error('not a regular file');
                if (resolved.endsWith('.md') && !declared.has(resolved)) throw new Error('Markdown target is not public');
                if (included && !included.has(resolved)) throw new Error('target is omitted from package');
            } catch (error) { errors.push(`Broken/private link in ${file}: ${href} (${error.message})`); }
        });
    }
    if (errors.length) throw new Error(errors.join('\n'));
    return { documents: files.length };
}
module.exports = { assertPublicPath, publicDocumentation, checkDocumentation };
if (require.main === module) {
    try { console.log(`Pivane documentation checked: ${checkDocumentation(path.resolve(__dirname, '..')).documents} public files`); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
