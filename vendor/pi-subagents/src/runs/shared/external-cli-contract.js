const UNSUPPORTED = {
    steer: "The one-shot stdin adapter closes input after launch and cannot accept live steer messages.",
    resume: "The one-shot stdin adapter has no durable external session identity.",
    structuredOutput: "The generic external CLI adapter does not parse a trusted structured result.",
    toolEvents: "The generic external CLI adapter treats stdout as untrusted text, not native Pi tool events.",
    supervisor: "The generic external CLI adapter has no trusted supervisor event transport.",
    forkContext: "Native Pi fork context is not available without an adapter-owned handoff artifact.",
    extensionBindings: "Native Pi extension bindings are never passed to external runners.",
};
const CAPABILITY_KEYS = new Set(Object.keys(UNSUPPORTED));
const PROMPT_FILE_UNSUPPORTED = {
    ...UNSUPPORTED,
    steer: "The one-shot prompt-file adapter closes input after launch and cannot accept live steer messages.",
    resume: "The one-shot prompt-file adapter does not retain a durable external session identity.",
};
export const CODE_OWNED_EXTERNAL_CLI_ADAPTER_IDS = [
    "codex-exec",
    "codex-exec-writer",
    "claude-code",
    "claude-code-writer",
    "cursor-agent",
    "cursor-agent-writer",
];
const CODE_OWNED_EXTERNAL_CLI_ADAPTER_ID_SET = new Set(CODE_OWNED_EXTERNAL_CLI_ADAPTER_IDS);
export const CODE_OWNED_EXTERNAL_CLI_ADAPTER_LABEL = CODE_OWNED_EXTERNAL_CLI_ADAPTER_IDS.map((id) => `'${id}'`).join(", ");
export function isCodeOwnedExternalCliAdapterId(value) {
    return typeof value === "string" && CODE_OWNED_EXTERNAL_CLI_ADAPTER_ID_SET.has(value);
}
const RESERVED_READ_ONLY_ADAPTERS = [
    { name: "claude-code", writer: "claude-code-writer", access: "file-write" },
    { name: "codex-exec", writer: "codex-exec-writer", access: "workspace-write" },
    { name: "cursor-agent", writer: "cursor-agent-writer", access: "workspace-write" },
];
export function validateCodeOwnedProfileRunner(agent) {
    const selectionNames = [agent.name, ...(agent.localName ? [agent.localName] : []), ...(agent.aliases ?? [])];
    for (const adapter of RESERVED_READ_ONLY_ADAPTERS) {
        if (selectionNames.includes(adapter.name) && !(agent.runner?.type === "external-cli" && agent.runner.adapter === adapter.name)) {
            return `Selection name '${adapter.name}' is reserved for the read-only '${adapter.name}' adapter. Use '${adapter.writer}' for explicit ${adapter.access} access.`;
        }
    }
    return undefined;
}
export function parseExternalCliCapabilityNarrowing(value, label) {
    if (value === undefined)
        return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${label} must be an object.`);
    const input = value;
    const unknown = Object.keys(input).filter((key) => !CAPABILITY_KEYS.has(key));
    if (unknown.length > 0)
        throw new Error(`${label} has unsupported fields: ${unknown.join(", ")}.`);
    for (const [key, setting] of Object.entries(input)) {
        if (setting !== false)
            throw new Error(`${label}.${key} may only be false; user config cannot widen code-owned external adapter capabilities.`);
    }
    return input;
}
export function resolveExternalCliRunnerStatus(input) {
    const codexExec = input.adapter === "codex-exec";
    const codexExecWriter = input.adapter === "codex-exec-writer";
    const claudeCode = input.adapter === "claude-code";
    const claudeCodeWriter = input.adapter === "claude-code-writer";
    const cursorAgent = input.adapter === "cursor-agent";
    const cursorAgentWriter = input.adapter === "cursor-agent-writer";
    const cursor = cursorAgent || cursorAgentWriter;
    const unsupported = cursor ? PROMPT_FILE_UNSUPPORTED : UNSUPPORTED;
    return {
        type: "external-cli",
        command: input.command,
        args: input.args ?? [],
        promptDelivery: cursor ? "prompt-file" : input.promptDelivery ?? "stdin",
        adapter: { id: input.adapter ?? "external-cli", version: 1, executionMode: cursor ? "one-shot-prompt-file" : "one-shot-stdin" },
        ...(codexExec ? { safety: { sandbox: "read-only", approvalPolicy: "never", ephemeral: true } } : {}),
        ...(codexExecWriter ? { safety: { access: "workspace-write", sandbox: "workspace-write", approvalPolicy: "never", ephemeral: true } } : {}),
        ...(claudeCode ? { safety: { access: "read-only", authentication: "existing-cli-required", permissionMode: "plan", tools: "none", mcp: "empty-strict", settingSources: "user", userSettingsTrust: "required", sessionPersistence: false } } : {}),
        ...(claudeCodeWriter ? { safety: { access: "workspace-write", authentication: "existing-cli-required", permissionMode: "acceptEdits", tools: "Read,Write,Edit,Glob,Grep", mcp: "empty-strict", settingSources: "user", userSettingsTrust: "required", sessionPersistence: false } } : {}),
        ...(cursorAgent ? { safety: { access: "read-only", authentication: "cursor-api-key-or-existing-login", mode: "ask", sandbox: "enabled", workspaceTrust: "existing-required", sessionReuse: false } } : {}),
        ...(cursorAgentWriter ? { safety: { access: "workspace-write", authentication: "cursor-api-key-or-existing-login", mode: "print", sandbox: "enabled", workspaceTrust: "existing-required", sessionReuse: false } } : {}),
        ...(input.machine ? { machine: input.machine } : {}),
        capabilities: {
            stop: true,
            steer: false,
            resume: false,
            structuredOutput: false,
            toolEvents: false,
            supervisor: "unsupported",
            forkContext: false,
            extensionBindings: false,
        },
        unsupportedReasons: unsupported,
        nonResumableReason: unsupported.resume,
    };
}
export function normalizeExternalCliRunnerStatus(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const input = value;
    if (input.type !== "external-cli" || typeof input.command !== "string" || !input.command.trim())
        return undefined;
    const args = Array.isArray(input.args) && input.args.every((arg) => typeof arg === "string")
        ? input.args
        : undefined;
    const promptDelivery = input.promptDelivery === "stdin" ? "stdin" : undefined;
    const machine = input.machine && typeof input.machine === "object" && !Array.isArray(input.machine)
        ? input.machine
        : undefined;
    const adapterId = input.adapter && typeof input.adapter === "object" && !Array.isArray(input.adapter)
        ? input.adapter.id
        : undefined;
    if (adapterId === "grok-build") {
        return {
            type: "external-cli",
            command: input.command,
            ...(machine ? { machine } : {}),
            args: args ?? [],
            promptDelivery: "prompt-file",
            adapter: { id: "grok-build", version: 1, executionMode: "one-shot-prompt-file" },
            capabilities: { stop: true, steer: false, resume: false, structuredOutput: false, toolEvents: false, supervisor: "unsupported", forkContext: false, extensionBindings: false },
            unsupportedReasons: PROMPT_FILE_UNSUPPORTED,
            nonResumableReason: PROMPT_FILE_UNSUPPORTED.resume,
        };
    }
    const adapter = isCodeOwnedExternalCliAdapterId(adapterId) ? adapterId : undefined;
    return resolveExternalCliRunnerStatus({ ...(adapter ? { adapter } : {}), command: input.command, ...(args ? { args } : {}), ...(promptDelivery ? { promptDelivery } : {}), ...(machine ? { machine } : {}) });
}
export function externalCliReceiptMetadata(input) {
    const { runner } = input;
    const machine = input.externalProcess?.machine ?? runner.machine;
    return {
        adapter: { ...runner.adapter },
        capabilities: { ...runner.capabilities },
        ...(machine ? { machine: { ...machine, ...(machine.remoteGit ? { remoteGit: { ...machine.remoteGit } } : {}) } } : {}),
        ...(runner.safety ? { safety: { ...runner.safety } } : {}),
        ...(input.externalProcess ? {
            outputArtifacts: {
                stdoutPath: input.externalProcess.stdoutPath,
                stderrPath: input.externalProcess.stderrPath,
                ...(input.outputReference || input.externalProcess.finalOutputPath ? { finalOutputPath: input.outputReference ?? input.externalProcess.finalOutputPath } : {}),
            },
        } : input.outputReference ? { outputArtifacts: { finalOutputPath: input.outputReference } } : {}),
        handoff: { mode: "fresh" },
        supervisor: { mode: "unsupported", reason: runner.unsupportedReasons.supervisor },
        nonResumableReason: runner.nonResumableReason,
    };
}
//# sourceMappingURL=external-cli-contract.js.map