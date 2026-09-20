// Project-owned SDK entrypoint. Inherits context through a private pipe, never argv or a session file.
import { Socket } from 'node:net';
import sideTools from './pi-side-tools.js';
import {
    createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices,
    getAgentDir, SessionManager, SettingsManager, runRpcMode,
} from '@earendil-works/pi-coding-agent';

process.env.PI_OFFLINE = '1';
let runtime;
try {
    const input = new Socket({ fd: 3, readable: true, writable: false });
    const chunks = []; let bytes = 0;
    for await (const chunk of input) {
        bytes += chunk.length;
        if (bytes > 32 * 1024 * 1024) throw new Error('Side bootstrap exceeds transport limit');
        chunks.push(chunk);
    }
    const seed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (seed.version !== 1 || !Array.isArray(seed.entries) || typeof seed.systemPrompt !== 'string') throw new Error('Invalid side bootstrap');
    if (seed.toolMode !== undefined && !['none', 'assist'].includes(seed.toolMode)) throw new Error('Invalid tool profile');
    const tools = seed.toolMode === 'assist' ? [...sideTools.READ_TOOLS, 'edit', 'write', process.platform === 'win32' ? 'powershell' : 'bash'] : [];
    const cwd = process.cwd(), agentDir = getAgentDir();
    const disk = SettingsManager.create(cwd, agentDir, { projectTrusted: false }).getGlobalSettings();
    const settingsManager = SettingsManager.inMemory({
        compaction: disk.compaction, retry: disk.retry, transport: disk.transport, thinkingBudgets: disk.thinkingBudgets,
        packages: [], extensions: [], skills: [], prompts: [], themes: [], enableInstallTelemetry: false,
    });
    const sessionManager = SessionManager.inMemory(cwd, { id: seed.sessionId }, seed.entries);
    const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
        let gateLoaded = false;
        const services = await createAgentSessionServices({ cwd, agentDir, settingsManager,
            resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
                extensionFactories: tools.length ? [{ name: 'pivane-side-tools', factory: pi => { sideTools.sideToolGate(pi); gateLoaded = true; } }] : [],
                systemPromptOverride: () => seed.systemPrompt, appendSystemPromptOverride: () => [],
                agentsFilesOverride: () => ({ agentsFiles: [] }) },
            resourceLoaderReloadOptions: { projectTrusted: false },
        });
        const model = services.modelRuntime.getModel(seed.provider, seed.modelId);
        if (!model) throw new Error(`Side model is not registered: ${seed.provider}/${seed.modelId}`);
        const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model,
            thinkingLevel: seed.thinkingLevel, ...(tools.length ? { tools } : { noTools: 'all' }) });
        const active = result.session.agent.state.tools.map(tool => tool.name).sort();
        if (result.session.sessionFile || tools.length && !gateLoaded || JSON.stringify(active) !== JSON.stringify([...tools].sort())) throw new Error('Side isolation check failed');
        return { ...result, services, diagnostics: services.diagnostics };
    };
    runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });
    // The official RPC adapter owns LF framing, prompt acceptance, compaction and event semantics.
    await runRpcMode(runtime);
} catch {
    // Bootstrap contains private context. Never include a parser/model error's payload in stderr.
    process.stderr.write('Side memory runtime could not initialize; check model registration and context configuration.\n');
    process.exitCode = 1;
} finally {
    runtime?.session.dispose();
}
