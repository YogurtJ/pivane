// Public Pi package/settings boundary. Rewrites only the in-memory resource view;
// CLI declarations, profile data and native session identity stay on disk as-is.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { catalog, packagePath } = require('./pi-bundled-capabilities');
const TYPES = ['extensions', 'skills', 'prompts', 'themes'];
const sourceOf = value => typeof value === 'string' ? value : value?.source;
function packageAt(file) {
    try {
        let current = fs.realpathSync.native(file);
        if (!fs.statSync(current).isDirectory()) current = path.dirname(current);
        for (;;) {
            const manifest = path.join(current, 'package.json');
            if (fs.existsSync(manifest)) {
                const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
                const entry = catalog.find(item => item.name === data.name);
                if (entry) return { entry, root: current };
            }
            const parent = path.dirname(current); if (parent === current) return null; current = parent;
        }
    } catch { return null; }
}
function identify(source, base) {
    if (typeof source !== 'string') return null;
    for (const entry of catalog) {
        if (source === `pivane:${entry.name}` || source === `npm:${entry.name}` || source.startsWith(`npm:${entry.name}@`)
            || new RegExp(`github\\.com[/:]${entry.repository.replace('/', '\\/')}(?:\\.git)?(?:@[^\\s]+)?/?$`).test(source)) return entry;
    }
    if (/^(?:npm:|git:|https?:|ssh:)/.test(source)) return null;
    return packageAt(path.resolve(base, source.replace(/^~(?=$|[/\\])/, os.homedir())))?.entry || null;
}
function projectSettings(config, base, { global = false } = {}) {
    const rewritten = [], byId = new Map();
    for (const item of config.packages || []) {
        const entry = identify(sourceOf(item), base);
        if (!entry) { rewritten.push(item); continue; }
        if (entry.mode === 'adapter') continue;
        byId.set(entry.id, typeof item === 'string' ? { source: packagePath(entry) } : { ...item, source: packagePath(entry) });
    }
    for (const entry of catalog.filter(item => item.mode === 'package')) {
        const custom = config.pivaneBuiltins?.[entry.id];
        const value = byId.get(entry.id) || (global ? { source: packagePath(entry) } : null);
        if (value || custom) {
            const filters = custom && typeof custom === 'object' ? Object.fromEntries(TYPES.filter(type => Array.isArray(custom[type])).map(type => [type, custom[type]])) : {};
            rewritten.push({ ...(value || { source: packagePath(entry), autoload: false }), ...filters });
        }
    }
    return { ...config, packages: rewritten };
}
function settingsView(settings, cwd, agentDir) {
    return new Proxy(settings, { get(target, prop) {
        if (prop === 'getGlobalSettings') return () => projectSettings(target.getGlobalSettings(), agentDir, { global: true });
        if (prop === 'getProjectSettings') return () => projectSettings(target.getProjectSettings(), path.join(cwd, '.pi'));
        const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
    } });
}
async function resolveManagedResources(sdk, { cwd, agentDir, settings }) {
    const view = settingsView(settings, cwd, agentDir);
    const manager = new sdk.DefaultPackageManager({ cwd, agentDir, settingsManager: view });
    const resolved = await manager.resolve(async () => 'skip');
    for (const type of TYPES) resolved[type] = resolved[type].filter(item => {
        const owner = packageAt(item.path);
        if (!owner) return true;
        return owner.entry.mode === 'package' && owner.root === fs.realpathSync.native(packagePath(owner.entry));
    });
    return { manager, resolved, settingsView: view };
}
function managedEntry(source) { return catalog.find(entry => source === packagePath(entry) || source === `pivane:${entry.name}`); }
module.exports = { TYPES, packageAt, identify, projectSettings, settingsView, resolveManagedResources, managedEntry };
