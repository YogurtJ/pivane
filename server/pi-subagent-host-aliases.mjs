// pi-subagents 0.74.0 requires a removed host export during detached preflight.
// Keep the upstream resolver and package scope; omit only the obsolete, unused
// alias for the exact Pi 1.0.0 and 1.0.2 hosts reviewed here. No replacement API is invented.
import fs from 'node:fs';
import path from 'node:path';
import { resolveHostPeerAliases as upstreamResolve, findHostPeerPackageDir } from '../vendor/pi-subagents/src/runs/background/runner-aliases.js?pivane-original=1';
export * from '../vendor/pi-subagents/src/runs/background/runner-aliases.js?pivane-original=1';
const removed = '@earendil-works/pi-agent-core/node';
function manifest(root) {
    try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); }
    catch { return null; }
}
export function resolveHostPeerAliases(piPackageRoot) {
    const result = upstreamResolve(piPackageRoot);
    if (!result.missing.includes(removed)) return result;
    const host = manifest(piPackageRoot);
    const coreRoot = findHostPeerPackageDir(piPackageRoot, '@earendil-works/pi-agent-core');
    const core = coreRoot && manifest(coreRoot);
    if (host?.name !== '@earendil-works/pi-coding-agent' || !['1.0.0', '1.0.2'].includes(host.version)
        || core?.name !== '@earendil-works/pi-agent-core' || core.version !== host.version
        || !core.exports || Object.hasOwn(core.exports, './node')) return result;
    return { aliases: result.aliases, missing: result.missing.filter(name => name !== removed) };
}
