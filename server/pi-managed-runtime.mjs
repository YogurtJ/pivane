// Managed RPC entrypoint using Pi's public SDK and native RPC transport.
// Pivane owns resource selection; SessionManager remains the conversation owner.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices,
    getAgentDir, SessionManager, SettingsManager, ProjectTrustStore, runRpcMode, parseArgs,
    resolveCliModel, resolveModelScopeWithDiagnostics, initTheme } from '@earendil-works/pi-coding-agent';
import { managedLoaderOptions, reloadableLoader } from './pi-bundled-loader.mjs';

let runtime;
try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.mode !== 'rpc' || parsed.messages.length || parsed.diagnostics.some(item => item.type === 'error')) throw new Error('Invalid managed RPC arguments');
    const cwd = process.cwd(), agentDir = getAgentDir();
    // Upstream subprocesses resolve the exact host Pi SDK even with our entrypoint.
    const piRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../node_modules/@earendil-works/pi-coding-agent');
    process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = piRoot;
    // Preserve the CLI's proxy/idle-timeout setup when embedding its RPC SDK.
    // This small host seam is reviewed alongside the pinned Pi version.
    const http = await import(pathToFileURL(path.join(piRoot, 'dist/core/http-dispatcher.js')).href);
    const sessionManager = parsed.noSession ? SessionManager.inMemory(cwd) : SessionManager.open(parsed.session, undefined, cwd);
    const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
        const global = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
        const trusted = parsed.projectTrustOverride ?? new ProjectTrustStore(agentDir).get(cwd) ?? (global.getDefaultProjectTrust() === 'always');
        const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
        http.applyHttpProxySettings(settings.getGlobalSettings().httpProxy);
        http.configureHttpDispatcher(settings.getHttpIdleTimeoutMs());
        const input = { cwd, agentDir, settings, parsed };
        const { settingsView, options } = await managedLoaderOptions(input);
        const services = await createAgentSessionServices({ cwd, agentDir, settingsManager: settingsView,
            modelRuntimeSignal: AbortSignal.timeout(15000), extensionFlagValues: parsed.unknownFlags, resourceLoaderOptions: options });
        services.resourceLoader = reloadableLoader(services.resourceLoader, input, options);
        const diagnostics = [...services.diagnostics, ...services.resourceLoader.getExtensions().errors.map(item => ({ type: 'error', message: `Extension ${item.path}: ${item.error}` }))];
        const patterns = parsed.models ?? settings.getEnabledModels();
        const scopedModels = patterns?.length ? (await resolveModelScopeWithDiagnostics(patterns, services.modelRuntime, { allowNetwork: false })).scopedModels : [];
        const selected = resolveCliModel({ cliProvider: parsed.provider, cliModel: parsed.model, cliThinking: parsed.thinking, modelRuntime: services.modelRuntime });
        if (selected.error) throw new Error(selected.error);
        const model = selected.model || (!sessionManager.buildSessionContext().messages.length ? scopedModels[0]?.model : undefined);
        const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model,
            thinkingLevel: parsed.thinking ?? selected.thinkingLevel, scopedModels,
            tools: parsed.tools, excludeTools: parsed.excludeTools, noTools: parsed.noTools ? 'all' : parsed.noBuiltinTools ? 'builtin' : undefined });
        if (model && (parsed.thinking !== undefined || selected.thinkingLevel !== undefined)) created.session.setThinkingLevel(created.session.thinkingLevel);
        for (const diagnostic of diagnostics) process.stderr.write(`${diagnostic.message}\n`);
        return { ...created, services, diagnostics };
    };
    runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });
    initTheme(runtime.services.settingsManager.getTheme(), false);
    await runRpcMode(runtime);
} catch (error) {
    process.stderr.write(`Managed Pi runtime could not initialize: ${error.message}\n`);
    process.exitCode = 1;
} finally { await runtime?.dispose(); }
