// Version-reviewed pi-subagents child-session injection seam. Upstream owns
// launch, storage, ownership, cancellation, notifications and disposal; this
// adapter only supplies a Pi SDK ResourceLoader with Pivane's package selection.
import './pi-subagent-native-loader.mjs';
import * as sdk from '@earendil-works/pi-coding-agent';
import { createPlacementChildSessionFactory } from '../vendor/pi-subagents/src/runs/shared/child-session.js';
import resources from './pi-bundled-resources.js';
import { managedLoaderOptions } from './pi-bundled-loader.mjs';
import { childNativeExtensions } from './pi-native-mcp.mjs';

class ChildResourceLoader {
    constructor(input) {
        const policy = childPolicy;
        const nativeFactories = childNativeExtensions({ cwd: input.cwd, agentDir: input.agentDir, settings: input.settingsManager,
            allowedTools: policy?.tools, excludeTools: policy?.excludeTools,
            ambientExtensions: policy?.ambientExtensions, denyExtensions: policy?.runtime?.capabilityCeiling?.denyExtensions, captureApi: pi => { if (policy) policy.nativeApi = pi; } });
        const arrays = { additionalExtensionPaths: [], additionalSkillPaths: [], additionalPromptTemplatePaths: [], additionalThemePaths: [] };
        const loader = new sdk.DefaultResourceLoader({ ...input, ...arrays,
            settingsManager: resources.settingsView(input.settingsManager, input.cwd, input.agentDir),
            noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
            extensionFactories: [...nativeFactories, ...(input.extensionFactories || [])] });
        return new Proxy(loader, { get(target, prop) {
            if (prop === 'reload') return async () => {
                await input.settingsManager.reload();
                const { options } = await managedLoaderOptions({ cwd: input.cwd, agentDir: input.agentDir, settings: input.settingsManager,
                    parsed: { noExtensions: input.noExtensions, noSkills: input.noSkills, noPromptTemplates: true, noThemes: true,
                        extensions: input.additionalExtensionPaths, skills: input.additionalSkillPaths } });
                // The child owns a filtered native MCP extension, never the parent's
                // unfiltered built-ins (or another ambient adapter).
                options.additionalExtensionPaths = [...nativeFactories.filter(entry => entry.builtin).map(entry => `builtin:${entry.name}`),
                    ...options.additionalExtensionPaths.filter(file => !file.startsWith('builtin:'))];
                for (const key of Object.keys(arrays)) arrays[key].splice(0, arrays[key].length, ...options[key]);
                await target.reload();
            };
            const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
        } });
    }
}
let childPolicy;
let creating = Promise.resolve();
export default function childFactory() {
    const upstream = createPlacementChildSessionFactory({ loadPiCodingAgent: async () => ({ ...sdk, DefaultResourceLoader: ChildResourceLoader }) });
    return { create(launch) {
        // The vendor factory serializes env/loading internally. Also serialize
        // policy capture so concurrently created children cannot borrow tools.
        const task = creating.catch(() => {}).then(async () => {
            const policy = { ...launch };
            childPolicy = policy;
            try {
                const child = await upstream.create(launch);
                // Native MCP connects asynchronously. Ensure granted tools exist
                // before the vendor's agent_start strict-registry check runs.
                const required = (launch.tools || []).filter(name => name.startsWith('mcp__'));
                const deadline = Date.now() + 10000;
                while (required.length && required.some(name => !policy.nativeApi?.getAllTools().some(tool => tool.name === name && tool.exposure !== 'hidden'))) {
                    if (Date.now() >= deadline) { await child.dispose(); throw new Error('Authorized native MCP child tools did not connect; no model request was sent.'); }
                    await new Promise(resolve => setTimeout(resolve, 25));
                }
                return child;
            } finally { childPolicy = undefined; }
        });
        creating = task; return task;
    }, dispose: () => upstream.dispose() };
}
