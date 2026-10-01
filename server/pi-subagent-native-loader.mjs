// A single exact vendor import seam. Upstream files and their original manifest
// hashes remain unchanged; only Pivane-hosted sessions use the native resolver.
// Node >=22.19 supports synchronous module hooks for import and require.
import { registerHooks } from 'node:module';
const from = new URL('../vendor/pi-subagents/src/runs/shared/mcp-direct-tool-allowlist.js', import.meta.url).href;
const to = new URL('./pi-subagent-mcp-resolution.mjs', import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    return resolved.url === from ? { ...resolved, url: to } : resolved;
} });
