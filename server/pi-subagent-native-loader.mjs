// Exact vendor import seams. Upstream files and their original manifest hashes
// remain unchanged; only Pivane-hosted sessions use these reviewed boundaries.
// Node >=22.19 supports synchronous module hooks for import and require.
import { registerHooks } from 'node:module';
const redirects = new Map([
    ['../vendor/pi-subagents/src/runs/shared/mcp-direct-tool-allowlist.js', './pi-subagent-mcp-resolution.mjs'],
    ['../vendor/pi-subagents/src/runs/background/runner-aliases.js', './pi-subagent-host-aliases.mjs'],
].map(([from, to]) => [new URL(from, import.meta.url).href, new URL(to, import.meta.url).href]));
registerHooks({ resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const replacement = redirects.get(resolved.url);
    return replacement ? { ...resolved, url: replacement } : resolved;
} });
