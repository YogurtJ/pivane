import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { registerNativeSupervisorClient } from "../../intercom/native-supervisor-channel.js";
import { permissionDecision } from "./permissions.js";
import { RUNTIME_EXTENSION_ACK_EVENT, isRuntimeAcknowledgedExtensionId } from "./runtime-acknowledged-extensions.js";
import { createStructuredOutputToolParameters, MISSING_STRUCTURED_ACCEPTANCE_REPORT_ERROR, validateStructuredOutputValue } from "./structured-output.js";
import { validateAcceptanceReport } from "./acceptance.js";
import { formatChildToolDiagnostic } from "./tool-availability.js";
import { shouldBlockToolForBudget, toolBudgetBlockedMessage, toolBudgetSoftNudge } from "./tool-budget.js";
import { INTERCOM_SESSION_IDENTITY_EVENT } from "../../shared/types.js";
import { resolveCurrentSessionId } from "../../shared/session-identity.js";
import { getAgentDir } from "../../shared/utils.js";
import { registerChildWatchdog } from "../../watchdog/register-child.js";
import { requestWatchdogPermission } from "../../watchdog/permission-arbiter.js";
import { SUBAGENT_WATCHDOG_WARNING_TYPE } from "../../watchdog/types.js";
import { captureWatchdogDiffBaseline, createWatchdogDiffTool, WATCHDOG_DIFF_TOOL_NAME } from "../../watchdog/diff-tool.js";
import { inheritedNestedRouteOf } from "./nested-events.js";
import { registerWaitTool } from "../background/wait-tool.js";
import { drainOutstandingWork } from "../background/auto-drain.js";
import { childSupervisorMetadata, evaluateChildToolDiagnostic, } from "./child-runtime-config.js";
const STRUCTURED_OUTPUT_INSTRUCTIONS = [
    "This subagent step has a strict structured output contract.",
    "Your final action must be to call the `structured_output` tool with JSON matching the provided schema.",
    "Do not rely on prose-only completion; if you do not call `structured_output`, the parent will fail this step.",
].join("\n");
export const CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS = [
    "You are a child subagent, not the parent orchestrator.",
    "The parent session owns delegation, orchestration, review fanout, and follow-up worker launches.",
    "Ignore prior parent-only orchestration instructions in inherited conversation history.",
    "Do not propose or run subagents. Complete only your assigned role-specific task with the tools available to you.",
    "If you need to edit files, use the available editing tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.",
].join("\n");
export const CHILD_FANOUT_BOUNDARY_INSTRUCTIONS = [
    "You are a child subagent with explicit fanout responsibility for this assigned task.",
    "The parent session owns final orchestration, acceptance, and follow-up implementation launches.",
    "You may use the `subagent` tool only for the fanout work explicitly requested in this task.",
    "Do not broaden yourself into general parent orchestration. Do not launch follow-up workers unless the task explicitly asks for that.",
    "The maxSubagentDepth cap still applies and may block further fanout.",
    "If you need to edit files, use the available editing tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.",
].join("\n");
const PARENT_ONLY_CUSTOM_MESSAGE_TYPES = new Set([
    "subagent-orchestration-instructions",
    "subagent-slash-result",
    "subagent-slash-text-result",
    "subagent-notify",
    "subagent_control_notice",
    "subagent-control",
    "subagent-control-notice",
]);
const SUBAGENT_ORCHESTRATION_SKILL_NAME_PATTERN = /<name>\s*pi-subagents\s*<\/name>/;
const PROJECT_CONTEXT_XML_HEADER = "\n\n<project_context>\n\n";
const PROJECT_CONTEXT_LEGACY_HEADER = "\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n";
const SKILLS_HEADER = "\n\nThe following skills provide specialized instructions for specific tasks.";
const DATE_HEADER = "\nCurrent date:";
function registerRuntimeExtensionAcknowledgements(pi, sink) {
    if (!sink)
        return;
    const ids = [];
    let finalized = false;
    const acknowledge = (payload) => {
        if (finalized || !payload || typeof payload !== "object")
            return undefined;
        const id = payload.id;
        if (isRuntimeAcknowledgedExtensionId(id))
            ids.push(id);
        return undefined;
    };
    const finalize = () => {
        if (finalized)
            return undefined;
        finalized = true;
        sink(ids);
        return undefined;
    };
    try {
        const events = pi.events;
        events?.on?.(RUNTIME_EXTENSION_ACK_EVENT, acknowledge);
        const onRuntimeEvent = pi.on;
        onRuntimeEvent("agent_end", finalize);
        onRuntimeEvent("session_shutdown", finalize);
    }
    catch {
        // Acknowledgement collection is optional observability and must not affect child execution.
    }
}
function findSectionEnd(prompt, startIndex, nextHeaders) {
    let endIndex = prompt.length;
    for (const header of nextHeaders) {
        const index = prompt.indexOf(header, startIndex);
        if (index !== -1 && index < endIndex) {
            endIndex = index;
        }
    }
    return endIndex;
}
export function stripProjectContext(prompt) {
    const xmlStartIndex = prompt.indexOf(PROJECT_CONTEXT_XML_HEADER);
    if (xmlStartIndex !== -1) {
        const closingTag = "</project_context>";
        const closingIndex = prompt.indexOf(closingTag, xmlStartIndex + PROJECT_CONTEXT_XML_HEADER.length);
        if (closingIndex !== -1) {
            return `${prompt.slice(0, xmlStartIndex)}${prompt.slice(closingIndex + closingTag.length)}`;
        }
    }
    const legacyStartIndex = prompt.indexOf(PROJECT_CONTEXT_LEGACY_HEADER);
    if (legacyStartIndex === -1)
        return prompt;
    const endIndex = findSectionEnd(prompt, legacyStartIndex + PROJECT_CONTEXT_LEGACY_HEADER.length, [SKILLS_HEADER, DATE_HEADER]);
    return `${prompt.slice(0, legacyStartIndex)}${prompt.slice(endIndex)}`;
}
const GLOBAL_CONTEXT_FILE_NAMES = new Set(["agents.md", "agents.override.md", "claude.md"]);
function canonicalDirectory(dir) {
    try {
        return fs.realpathSync(dir);
    }
    catch {
        return path.resolve(dir);
    }
}
function expandContextPath(filePath) {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    return filePath === "~"
        ? home ?? filePath
        : /^~[\\/]/.test(filePath)
            ? path.join(home ?? "~", filePath.slice(2))
            : filePath;
}
function isContextFilePath(filePath) {
    return GLOBAL_CONTEXT_FILE_NAMES.has(path.basename(expandContextPath(filePath)).toLowerCase());
}
function isGlobalContextFile(filePath) {
    const expanded = expandContextPath(filePath);
    if (!isContextFilePath(filePath))
        return false;
    return canonicalDirectory(path.dirname(expanded)) === canonicalDirectory(getAgentDir());
}
function stripGlobalInstructionsFromXmlContext(context) {
    const block = /<project_instructions\s+path=(["'])(.*?)\1\s*>[\s\S]*?<\/project_instructions>\s*/gi;
    return context.replace(block, (match, _quote, filePath) => isGlobalContextFile(filePath) ? "" : match);
}
function stripGlobalInstructionsFromLegacyContext(context) {
    const sections = [...context.matchAll(/^## ([^\r\n]+)(?:\r?\n|$)/gm)]
        .filter((match) => isContextFilePath(match[1].trim()));
    let rewritten = "";
    let cursor = 0;
    for (let index = 0; index < sections.length; index++) {
        const section = sections[index];
        const start = section.index;
        const end = sections[index + 1]?.index ?? context.length;
        rewritten += context.slice(cursor, start);
        if (!isGlobalContextFile(section[1].trim()))
            rewritten += context.slice(start, end);
        cursor = end;
    }
    return `${rewritten}${context.slice(cursor)}`;
}
export function stripGlobalContext(prompt) {
    const rewrittenXml = prompt.replace(/<project_context>[\s\S]*?<\/project_context>/gi, (context) => {
        const rewritten = stripGlobalInstructionsFromXmlContext(context);
        return /<project_instructions\b/i.test(rewritten) ? rewritten : "";
    });
    const legacyStartIndex = rewrittenXml.indexOf(PROJECT_CONTEXT_LEGACY_HEADER);
    if (legacyStartIndex === -1)
        return rewrittenXml;
    const legacyEndIndex = findSectionEnd(rewrittenXml, legacyStartIndex + PROJECT_CONTEXT_LEGACY_HEADER.length, [SKILLS_HEADER, DATE_HEADER]);
    const legacyContext = rewrittenXml.slice(legacyStartIndex, legacyEndIndex);
    return `${rewrittenXml.slice(0, legacyStartIndex)}${stripGlobalInstructionsFromLegacyContext(legacyContext)}${rewrittenXml.slice(legacyEndIndex)}`;
}
export function stripInheritedSkills(prompt) {
    const startIndex = prompt.indexOf(SKILLS_HEADER);
    if (startIndex === -1)
        return prompt;
    const endIndex = findSectionEnd(prompt, startIndex + SKILLS_HEADER.length, [DATE_HEADER]);
    return `${prompt.slice(0, startIndex)}${prompt.slice(endIndex)}`;
}
export function stripSubagentOrchestrationSkill(prompt) {
    return prompt
        .replace(/\n{0,2}<skill\s+name=["']pi-subagents["'][^>]*>[\s\S]*?<\/skill>\n{0,2}/g, "\n\n")
        .replace(/[ \t]*<skill>\s*[\s\S]*?<\/skill>\s*/g, (block) => SUBAGENT_ORCHESTRATION_SKILL_NAME_PATTERN.test(block) ? "" : block);
}
function stripChildBoundaryInstructions(prompt) {
    let rewritten = prompt;
    for (const boundary of [CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS, CHILD_FANOUT_BOUNDARY_INSTRUCTIONS]) {
        rewritten = rewritten.split(boundary).join("");
    }
    return rewritten.replace(/^(?:[ \t]*\r?\n)+/, "");
}
export function rewriteSubagentPrompt(prompt, options) {
    let rewritten = prompt;
    if (!options.inheritProjectContext) {
        rewritten = stripProjectContext(rewritten);
    }
    if (!options.inheritGlobalContext) {
        rewritten = stripGlobalContext(rewritten);
    }
    if (!options.inheritSkills) {
        rewritten = stripInheritedSkills(rewritten);
    }
    rewritten = stripSubagentOrchestrationSkill(rewritten);
    rewritten = stripChildBoundaryInstructions(rewritten);
    const boundary = options.fanoutChild ? CHILD_FANOUT_BOUNDARY_INSTRUCTIONS : CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS;
    const structured = options.structuredOutput ? `\n\n${STRUCTURED_OUTPUT_INSTRUCTIONS}` : "";
    return `${boundary}${structured}\n\n${rewritten}`;
}
function isParentOnlySubagentMessage(message) {
    const m = message;
    if (m?.role !== "custom" || typeof m.customType !== "string")
        return false;
    if (m.customType === SUBAGENT_WATCHDOG_WARNING_TYPE)
        return true;
    return PARENT_ONLY_CUSTOM_MESSAGE_TYPES.has(m.customType);
}
function isSubagentToolResultMessage(message) {
    const m = message;
    return m?.role === "toolResult" && m.toolName === "subagent";
}
function isSubagentToolCallBlock(block) {
    const b = block;
    return b?.type === "toolCall" && b.name === "subagent";
}
const PORTABLE_TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_PORTABLE_TOOL_ID_LENGTH = 64;
const COMPOSITE_TOOL_ID_APIS = new Set([
    "azure-openai-responses",
    "cursor-native",
    "openai-completions",
    "openai-responses",
]);
const PROMPT_CACHE_KEY_APIS = new Set([
    "azure-openai-responses",
    "openai-codex-responses",
    "openai-completions",
    "openai-responses",
]);
export function rewriteForkCacheProviderRequest(event, ctx, forkCacheKey) {
    const key = forkCacheKey?.trim();
    if (!key || !PROMPT_CACHE_KEY_APIS.has(ctx?.model?.api ?? ""))
        return undefined;
    if (!event || typeof event !== "object")
        return undefined;
    const payload = event.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
        return undefined;
    if (typeof payload.prompt_cache_key !== "string")
        return undefined;
    return { ...payload, prompt_cache_key: key };
}
function portableToolId(id) {
    if (PORTABLE_TOOL_ID_PATTERN.test(id) && id.length <= MAX_PORTABLE_TOOL_ID_LENGTH)
        return id;
    const encoded = `tool_${Buffer.from(id).toString("base64url") || "empty"}`;
    if (encoded.length <= MAX_PORTABLE_TOOL_ID_LENGTH)
        return encoded;
    return `tool_${createHash("sha256").update(id).digest("base64url")}`;
}
function sanitizeToolHistoryMessage(message) {
    const m = message;
    if (m?.role === "toolResult" && typeof m.toolCallId === "string") {
        const toolCallId = portableToolId(m.toolCallId);
        return toolCallId === m.toolCallId ? message : { ...m, toolCallId };
    }
    if (m?.role !== "assistant" || !Array.isArray(m.content))
        return message;
    let changed = false;
    const content = m.content.map((block) => {
        const b = block;
        if (b?.type !== "toolCall" || typeof b.id !== "string")
            return block;
        const id = portableToolId(b.id);
        if (id === b.id)
            return block;
        changed = true;
        return { ...b, id };
    });
    return changed ? { ...m, content } : message;
}
function stripAssistantSubagentToolCallBlocks(message) {
    const m = message;
    if (m?.role !== "assistant" || !Array.isArray(m.content))
        return message;
    const filteredContent = m.content.filter((block) => !isSubagentToolCallBlock(block));
    if (filteredContent.length === m.content.length)
        return message;
    if (filteredContent.length === 0)
        return undefined;
    return { ...m, content: filteredContent };
}
export function stripParentOnlySubagentMessages(messages, options = {}) {
    const preserveCurrentFanoutToolHistory = options.preserveFanoutToolHistory === true;
    const sanitizeToolIds = options.sanitizeToolIds ?? true;
    let changed = false;
    const filtered = [];
    for (const message of messages) {
        if (isParentOnlySubagentMessage(message) || (!preserveCurrentFanoutToolHistory && isSubagentToolResultMessage(message))) {
            changed = true;
            continue;
        }
        const stripped = preserveCurrentFanoutToolHistory ? message : stripAssistantSubagentToolCallBlocks(message);
        if (stripped === undefined) {
            changed = true;
            continue;
        }
        const sanitized = sanitizeToolIds ? sanitizeToolHistoryMessage(stripped) : stripped;
        if (stripped !== message || sanitized !== stripped)
            changed = true;
        filtered.push(sanitized);
    }
    return changed ? filtered : messages;
}
export function formatSteerMessage(request) {
    return [
        request.mode === "follow_up" ? "Queued follow-up from the parent orchestrator:" : "Mid-run steering from the parent orchestrator:",
        "",
        request.message,
        "",
        "Incorporate this guidance at the next safe point. Do not restart the task unless the guidance explicitly asks you to.",
    ].join("\n");
}
export function registerPermissionGate(pi, permissions, childWatchdog, requestPermission = requestWatchdogPermission) {
    const rules = permissions?.rules;
    if (!rules || Object.keys(rules).length === 0)
        return;
    const rawWatchdogConfig = childWatchdog ? JSON.stringify(childWatchdog) : undefined;
    const timeoutMs = childWatchdog?.agentEndTimeoutMs ?? 30_000;
    const onRuntimeEvent = pi.on;
    onRuntimeEvent("tool_call", async (event, ctx) => {
        const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
        const decision = permissionDecision(rules, toolName);
        if (decision === "allow")
            return undefined;
        if (decision === "deny")
            return { block: true, reason: `Blocked by pi-subagents permission rule: '${toolName}' is denied.` };
        if (ctx.signal?.aborted)
            return { block: true, reason: "Blocked by pi-subagents permission rule: Watchdog permission decision was cancelled." };
        let timeout;
        let abort;
        let result;
        try {
            result = await Promise.race([
                requestPermission({
                    ctx,
                    toolName,
                    args: event.input ?? {},
                    rawWatchdogConfig,
                    auditPath: permissions.auditPath,
                    ...(ctx.signal ? { signal: ctx.signal } : {}),
                }),
                new Promise((resolve) => {
                    if (!ctx.signal)
                        return;
                    abort = () => resolve({ approved: false, reason: "Watchdog permission decision was cancelled.", source: "watchdog" });
                    ctx.signal.addEventListener("abort", abort, { once: true });
                }),
                new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Watchdog permission decision timed out after ${timeoutMs}ms.`)), timeoutMs); }),
            ]);
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return { block: true, reason: `Blocked by pi-subagents permission rule: Watchdog permission arbiter failed closed: ${reason}` };
        }
        finally {
            if (timeout)
                clearTimeout(timeout);
            if (abort)
                ctx.signal?.removeEventListener("abort", abort);
        }
        if (result.approved)
            return undefined;
        return { block: true, reason: `Blocked by pi-subagents permission rule: ${result.reason}` };
    });
}
function registerToolBudget(pi, budget) {
    if (!budget)
        return;
    let toolCount = 0;
    let softNudged = false;
    const sendUserMessage = pi.sendUserMessage;
    const onRuntimeEvent = pi.on;
    onRuntimeEvent("tool_call", (event) => {
        const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
        toolCount++;
        if (budget.soft !== undefined && toolCount >= budget.soft && !softNudged) {
            softNudged = true;
            try {
                sendUserMessage?.(toolBudgetSoftNudge(budget, toolCount), { deliverAs: "steer" });
            }
            catch {
                // Budget nudges are advisory; blocking below remains authoritative.
            }
        }
        if (!shouldBlockToolForBudget(budget, toolName, toolCount))
            return undefined;
        return { block: true, reason: toolBudgetBlockedMessage(budget, toolName, toolCount) };
    });
}
function registerStructuredOutputTool(pi, structured) {
    const terminalState = structured.terminalState ??= { captured: false };
    const required = structured.acceptanceReport === "required";
    const parameters = createStructuredOutputToolParameters(structured.schema, { acceptanceReport: structured.acceptanceReport });
    const registerTool = pi.registerTool;
    registerTool({
        name: "structured_output",
        label: "Structured Output",
        description: "Submit the required final structured output for this subagent step. This terminates the step.",
        parameters,
        async execute(_id, params) {
            const validation = await validateStructuredOutputValue(structured.schema, params.value);
            if (validation.status === "invalid") {
                throw new Error(`Structured output validation failed: ${validation.message}`);
            }
            if (required && params.acceptanceReport === undefined) {
                throw new Error(MISSING_STRUCTURED_ACCEPTANCE_REPORT_ERROR);
            }
            if (required && params.acceptanceReport !== undefined) {
                const acceptanceValidation = validateAcceptanceReport(params.acceptanceReport, "acceptanceReport");
                if (!acceptanceValidation.report) {
                    throw new Error(`Invalid structured output acceptance report: ${acceptanceValidation.errors.join("; ")}`);
                }
            }
            structured.capture(params.value, structured.acceptanceReport ? params.acceptanceReport : undefined);
            terminalState.captured = true;
            return {
                content: [{ type: "text", text: "Structured output captured." }],
                details: {},
                terminate: true,
            };
        },
    });
}
/** Register every child-side hook the prompt runtime owns for one child session. */
export default function registerSubagentPromptRuntime(pi, config, drainObservation) {
    // A path-based load has no ChildRuntimeConfig. This can happen if an
    // ambient-extension discovery path finds the runtime module in addition to
    // the configured inline factory. It must be inert rather than crashing the
    // child before startup; the inline factory remains the real registration path.
    if (!config)
        return;
    registerRuntimeExtensionAcknowledgements(pi, config.runtimeAcknowledgements);
    registerPermissionGate(pi, config.permissions, config.childWatchdog);
    registerToolBudget(pi, config.toolBudget);
    if (config.structuredOutput && !config.structuredOutput.terminalState)
        config.structuredOutput.terminalState = { captured: false };
    registerChildWatchdog(pi, config.childWatchdog, config.watchdogStatus, config.structuredOutput?.terminalState);
    const requestedWatchdogDiff = config.requiredTools?.includes(WATCHDOG_DIFF_TOOL_NAME);
    const reviewerLaunchBaseline = requestedWatchdogDiff && config.cwd
        ? captureWatchdogDiffBaseline(config.cwd)
        : undefined;
    if (requestedWatchdogDiff && typeof pi.registerTool === "function") {
        pi.registerTool(createWatchdogDiffTool(reviewerLaunchBaseline, { workingTreeAtLaunch: true }));
    }
    const waitState = config.runtimeState ?? {
        baseCwd: "",
        currentSessionId: null,
        asyncJobs: new Map(),
        foregroundRuns: new Map(),
        foregroundControls: new Map(),
        lastForegroundControlId: null,
        cleanupTimers: new Map(),
        lastUiContext: null,
        poller: null,
        completionSeen: new Map(),
        watcher: null,
        watcherRestartTimer: null,
        resultFileCoalescer: { schedule: () => false, clear: () => { } },
    };
    const nestedRootRunId = inheritedNestedRouteOf(config)?.rootRunId;
    if (typeof pi.registerTool === "function")
        registerWaitTool(pi, waitState, config.waitTool.enabled, undefined, config.waitTool.defaultTimeoutMs, { nestedRootRunId });
    const supervisorMetadata = childSupervisorMetadata(config);
    let nativeSupervisorClientRegistered = false;
    const registerNativeSupervisorClientOnce = () => {
        if (nativeSupervisorClientRegistered)
            return;
        nativeSupervisorClientRegistered = true;
        registerNativeSupervisorClient(pi, supervisorMetadata);
    };
    const onRuntimeEvent = pi.on;
    onRuntimeEvent("session_start", (_event, ctx) => {
        const sessionManager = ctx?.sessionManager;
        waitState.currentSessionId = sessionManager ? resolveCurrentSessionId(sessionManager) : null;
        registerNativeSupervisorClientOnce();
    });
    onRuntimeEvent("agent_start", () => {
        if (!config.requiredTools)
            return;
        const diagnostic = evaluateChildToolDiagnostic(config, pi.getAllTools().map((tool) => tool.name));
        config.toolDiagnostic?.(diagnostic);
        if (diagnostic)
            throw new Error(formatChildToolDiagnostic(diagnostic));
    });
    onRuntimeEvent("agent_end", async (_event, ctx) => {
        if (ctx?.hasUI === true)
            drainObservation?.deny();
        if (drainObservation) {
            try {
                if (ctx?.sessionManager?.getSessionFile() !== waitState.currentSessionId)
                    drainObservation.deny();
            }
            catch {
                drainObservation.deny();
            }
        }
        config.holdFinalDrain?.(true);
        try {
            await drainOutstandingWork({ state: waitState, events: pi.events, nestedRootRunId, hasPendingSupervisorRequest: config.hasPendingSupervisorRequest }, drainObservation);
        }
        finally {
            config.holdFinalDrain?.(false);
        }
    });
    if (config.structuredOutput)
        registerStructuredOutputTool(pi, config.structuredOutput);
    onRuntimeEvent("before_provider_request", (event, ctx) => rewriteForkCacheProviderRequest(event, ctx, config.forkCacheKey));
    onRuntimeEvent("context", (event, ctx) => {
        if (!event || typeof event !== "object" || !("messages" in event) || !Array.isArray(event.messages))
            return undefined;
        const messages = stripParentOnlySubagentMessages(event.messages, {
            sanitizeToolIds: !COMPOSITE_TOOL_ID_APIS.has(ctx?.model?.api ?? ""),
            preserveFanoutToolHistory: config.fanoutChild,
        });
        if (messages === event.messages)
            return undefined;
        return { messages };
    });
    // pi-intercom asks at session start for this session's intercom ID. Claiming
    // the route there frees the session name for the readable label. An older
    // pi-intercom never asks and routes by name, so the route stays the name.
    const routingName = config.intercomSessionName;
    let intercomIdClaimed = false;
    if (routingName) {
        pi.events.on(INTERCOM_SESSION_IDENTITY_EVENT, (request) => {
            if (!request || typeof request !== "object" || !("version" in request) || request.version !== 1 || !("claim" in request) || typeof request.claim !== "function")
                return;
            request.claim(routingName);
            intercomIdClaimed = true;
        });
    }
    onRuntimeEvent("before_agent_start", async (event) => {
        if (!event || typeof event !== "object" || !("systemPrompt" in event) || typeof event.systemPrompt !== "string")
            return undefined;
        registerNativeSupervisorClientOnce();
        const childSessionName = intercomIdClaimed ? config.sessionName || routingName : routingName || config.sessionName;
        if (childSessionName && typeof pi.setSessionName === "function") {
            pi.setSessionName(childSessionName);
        }
        const { inheritProjectContext, inheritGlobalContext, inheritSkills } = config;
        const fanoutChild = config.fanoutChild;
        let rewritten = event.systemPrompt;
        if (inheritProjectContext !== undefined || inheritGlobalContext !== undefined || inheritSkills !== undefined || fanoutChild) {
            rewritten = rewriteSubagentPrompt(event.systemPrompt, {
                inheritProjectContext: inheritProjectContext ?? true,
                inheritGlobalContext: inheritGlobalContext ?? true,
                inheritSkills: inheritSkills ?? true,
                fanoutChild,
                structuredOutput: Boolean(config.structuredOutput),
            });
        }
        if (rewritten === event.systemPrompt)
            return;
        return { systemPrompt: rewritten };
    });
}
//# sourceMappingURL=subagent-prompt-runtime.js.map