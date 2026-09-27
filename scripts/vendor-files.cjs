const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
function vendorFiles(root, { verify = true } = {}) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'vendor/manifest.json'), 'utf8'));
    if (manifest.version !== 1 || !Array.isArray(manifest.packages)) throw new Error('Invalid vendor manifest');
    const files = ['vendor/manifest.json'], seen = new Set();
    for (const pkg of manifest.packages) {
        if (!/^pi-[a-z-]+$/.test(pkg.name) || !Array.isArray(pkg.files)) throw new Error('Invalid vendor package');
        for (const file of pkg.files) {
            if (!file.path.startsWith(`vendor/${pkg.name}/`) || file.path.split('/').some(p => !p || p === '.' || p === '..' || p === 'node_modules')
                || file.path.includes('\\') || seen.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid vendor file');
            seen.add(file.path);
            const full = path.join(root, file.path);
            if (!fs.lstatSync(full).isFile() || fs.realpathSync(full) !== full) throw new Error(`Vendor file is not regular: ${file.path}`);
            if (verify && createHash('sha256').update(fs.readFileSync(full)).digest('hex') !== file.sha256) throw new Error(`Upstream source changed: ${file.path}`);
            files.push(file.path);
        }
        const metadata = JSON.parse(fs.readFileSync(path.join(root, 'vendor', pkg.name, 'package.json'), 'utf8'));
        if (metadata.name !== pkg.name || metadata.version !== pkg.version || metadata.license !== pkg.license) throw new Error('Vendor identity mismatch');
    }
    return files;
}
module.exports = { vendorFiles };
