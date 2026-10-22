// Pi 1.4.0 / pi-subagents 0.80.0 child-session injection seam. Upstream owns
// launch, storage, ownership, cancellation, notifications and disposal; this
// adapter supplies the resource selection and authorized native tool factories.
import './pi-subagent-native-loader.mjs';
import path from 'node:path';
import networkTransport from './workspace-network-transport.js';
import { registerModelSpeed } from './pi-model-speed-extension.mjs';
import * as sdk from '@earendil-works/pi-coding-agent';
import { createPlacementChildSessionFactory } from '../vendor/pi-subagents/src/runs/shared/child-session.js';
import resources from './pi-bundled-resources.js';
import { managedLoaderOptions } from './pi-bundled-loader.mjs';
import { childNativeExtensions, nativeBuiltins } from './pi-native-mcp.mjs';
import { wrapCodemodeExtension } from './pi-codemode-policy.mjs';

class ChildResourceLoader {
    constructor(input) {
        const policy = childPolicy;
        const nativeFactories = childNativeExtensions({ cwd: input.cwd, agentDir: input.agentDir, settings: input.settingsManager,
            allowedTools: policy?.tools, excludeTools: policy?.excludeTools,
            ambientExtensions: policy?.ambientExtensions, denyExtensions: policy?.runtime?.capabilityCeiling?.denyExtensions });
        if (policy) policy.nativeMcp = nativeFactories.find(entry => entry.name === 'mcp');
        // 0.80 owns readiness through its MCP wrapper and Codemode metadata.
        // Its SDK factory below supplies our filtered MCP implementation; keep
        // those two wrappers for selected tools without loading a second transport.
        const readiness = Boolean(policy?.builtinMcpTools?.length && policy.nativeMcp);
        // Upstream appends these wrappers after launch.hooks. Preserve their exact
        // entries, not a same-named hook that the previous adapter also filtered.
        const upstreamFactories = new Set(readiness ? ['mcp', 'codemode'].map(name =>
            (input.extensionFactories || []).findLast(entry => entry.name === name)) : []);
        const upstreamBuiltin = entry => readiness && ['mcp', 'codemode'].includes(entry.name);
        const arrays = { additionalExtensionPaths: [], additionalSkillPaths: [], additionalPromptTemplatePaths: [], additionalThemePaths: [] };
        const loader = new sdk.DefaultResourceLoader({ ...input, ...arrays,
            settingsManager: resources.settingsView(input.settingsManager, input.cwd, input.agentDir),
            noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
            // The pinned Pi's context-file discovery does not consult project trust.
            // Keep only the identity's global context when the parent distrusts cwd.
            agentsFilesOverride: base => {
                const resolved = input.agentsFilesOverride ? input.agentsFilesOverride(base) : base;
                return input.settingsManager.isProjectTrusted() ? resolved : { ...resolved,
                    agentsFiles: resolved.agentsFiles.filter(entry => path.dirname(entry.path) === input.agentDir) };
            },
            extensionFactories: [...nativeFactories.filter(entry => !upstreamBuiltin(entry)),
                pi => registerModelSpeed(pi, { agentDir: input.agentDir, preserveExisting: false }),
                ...(input.extensionFactories || []).filter(entry => upstreamFactories.has(entry)
                    || (!nativeBuiltins.includes(entry.name) && !nativeFactories.some(native => native.name === entry.name)))] });
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
    const upstream = createPlacementChildSessionFactory({ loadPiCodingAgent: async () => {
        const policy = childPolicy;
        return { ...sdk, DefaultResourceLoader: ChildResourceLoader,
            createMcpExtension: () => pi => {
                if (!policy?.nativeMcp) throw new Error('Selected native MCP tools are outside this child\'s authorized extensions.');
                return policy.nativeMcp.factory(pi);
            },
            createCodemodeExtension: () => wrapCodemodeExtension(sdk.createCodemodeExtension()) };
    } });
    let disposals = 0;
    return { create(launch) {
        const generation = disposals;
        const checkDisposal = () => {
            if (generation !== disposals) throw new Error('The child session factory was disposed before this launch started.');
        };
        // The vendor factory serializes env/loading internally. Also serialize
        // policy capture so concurrently created children cannot borrow tools.
        const task = creating.catch(() => {}).then(async () => {
            checkDisposal();
            await networkTransport.initializeSdkNetwork();
            checkDisposal();
            const policy = { ...launch };
            childPolicy = policy;
            try { return await upstream.create(launch); }
            finally { childPolicy = undefined; }
        });
        creating = task; return task;
    }, dispose() { disposals += 1; return upstream.dispose(); } };
}
