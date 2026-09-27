import { extractTextFromContent, extractToolArgsPreview, getFinalOutput, hasEmptyTerminalAssistantResponse } from "../../shared/utils.js";
import { acceptChildWatchdogEvent, applyChildWatchdogMessage, childWatchdogIsActive, isChildWatchdogStatusEvent, } from "../../watchdog/child-status.js";
import { projectChildLifecycle } from "../shared/child-lifecycle.js";
import { formatSubagentModelVerificationError } from "../shared/model-resolution.js";
import { formatChildModelResolutionDiagnostic, isChildModelResolutionFailure } from "../shared/model-resolution-diagnostic.js";
import { isMutatingTool, resolveCurrentPath } from "../shared/long-running-guard.js";
import { effectiveToolTimeoutMs, formatToolTimeoutMessage, toolTimeoutCallKey } from "../shared/tool-timeout.js";
import { createReportedChildSessionInput } from "../shared/child-launch.js";
import { childSessionHasQueuedMessages, projectChildSessionEventForJson } from "../shared/child-session.js";
import { reconcileAttemptUsage } from "../shared/usage-reconciliation.js";
import { formatSteerMessage } from "../shared/subagent-prompt-runtime.js";
import { takeMatchingAcceptedSteer, unconsumedSteerReason } from "./steering.js";
/** Events the child emits while the model streams; not persisted into the diagnostic log. */
function shouldPersistChildEvent(event) {
    return event.type !== "message_update";
}
function assistantStartsToolCall(message) {
    return Array.isArray(message.content)
        && message.content.some((part) => part.type === "toolCall");
}
function isTerminalAssistantStop(message) {
    return message.stopReason === "stop" && !assistantStartsToolCall(message);
}
function emptyUsage() {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}
function omitUndefined(value) {
    for (const key of Object.keys(value)) {
        if (value[key] === undefined)
            delete value[key];
    }
    return value;
}
const FINAL_STOP_GRACE_MS = 1000;
const HARD_FINISH_MS = 3000;
const ABORT_SETTLE_MS = 3000;
export function runChildSession(input) {
    return new Promise((resolve) => {
        const startedAt = Date.now();
        const messages = [];
        const usage = emptyUsage();
        let model;
        let error;
        let assistantError;
        let interrupted = false;
        let timedOut = false;
        let stopped = false;
        let observedMutationAttempt = false;
        let structuredOutputToolInvoked = false;
        let structuredOutputMessageStartIndex;
        let currentTool;
        let currentToolArgs;
        let currentPath;
        let toolCount = 0;
        let session;
        let messageBaseline;
        const acceptedSteers = [];
        let unsubscribe;
        let settled = false;
        let promptSettled = false;
        let forcedTermination = false;
        let cleanTerminalAssistantStopReceived = false;
        let agentSettledReceived = false;
        let queuedDrainHold = false;
        let compactionStartedReceived = false;
        let afterCompactionSettlement = false;
        let finalDrainTimer;
        let finalHardFinishTimer;
        let watchdogTailTimer;
        let abortSettleTimer;
        let childWatchdogState;
        const childLifecycleState = { compactionRetryActive: false };
        const timeoutMessage = () => input.timeoutMessage ?? "Subagent timed out.";
        const stopMessage = () => input.stopMessage ?? "Subagent stopped by user.";
        let activeToolSequence = 0;
        const activeToolCalls = new Map();
        const activeToolKeysByName = new Map();
        const refreshCurrentTool = () => {
            const active = [...activeToolCalls.values()].at(-1);
            currentTool = active?.tool;
            currentToolArgs = active?.args;
            currentPath = active?.path;
        };
        const recordActiveToolCall = (event) => {
            const key = toolTimeoutCallKey(event, ++activeToolSequence);
            const active = omitUndefined({
                key,
                tool: event.toolName,
                args: extractToolArgsPreview(event.args ?? {}),
                path: resolveCurrentPath(event.toolName, event.args),
            });
            activeToolCalls.set(key, active);
            const keys = activeToolKeysByName.get(active.tool) ?? [];
            keys.push(key);
            activeToolKeysByName.set(active.tool, keys);
            refreshCurrentTool();
        };
        const removeActiveToolCall = (event) => {
            const key = typeof event.toolCallId === "string" && event.toolCallId.length > 0
                ? `id:${event.toolCallId}`
                : typeof event.toolName === "string"
                    ? activeToolKeysByName.get(event.toolName)?.[0]
                    : activeToolCalls.size === 1
                        ? [...activeToolCalls.keys()][0]
                        : undefined;
            if (!key)
                return;
            const active = activeToolCalls.get(key);
            if (!active)
                return;
            activeToolCalls.delete(key);
            const keys = activeToolKeysByName.get(active.tool)?.filter((candidate) => candidate !== key) ?? [];
            if (keys.length > 0)
                activeToolKeysByName.set(active.tool, keys);
            else
                activeToolKeysByName.delete(active.tool);
            refreshCurrentTool();
        };
        const abortChild = () => {
            if (settled || promptSettled)
                return;
            // A hung session creation has no session to abort yet; the settle timer below is the only
            // thing that ends the run, and a session created afterwards is disposed by the launch block.
            void session?.abort().catch(() => {
                // The run settles through its prompt promise; abort failures are not separately actionable.
            });
            if (!abortSettleTimer) {
                abortSettleTimer = setTimeout(() => {
                    abortSettleTimer = undefined;
                    if (!settled && !promptSettled)
                        settle(undefined, true);
                }, ABORT_SETTLE_MS);
                abortSettleTimer.unref?.();
            }
        };
        const writeOutputText = (text) => {
            for (const line of text.split("\n")) {
                if (line.trim())
                    input.writeOutputLine(line);
            }
        };
        const appendChildEvent = (event) => {
            if (!input.childEventContext)
                return;
            if (!shouldPersistChildEvent(event))
                return;
            input.appendChildEvent({
                ...event,
                subagentSource: "child",
                subagentRunId: input.childEventContext.runId,
                subagentStepIndex: input.childEventContext.stepIndex,
                subagentAgent: input.childEventContext.agent,
                observedAt: Date.now(),
            });
        };
        const clearWatchdogTailTimer = () => {
            if (watchdogTailTimer) {
                clearTimeout(watchdogTailTimer);
                watchdogTailTimer = undefined;
            }
        };
        const clearFinalDrainTimers = () => {
            if (finalDrainTimer) {
                clearTimeout(finalDrainTimer);
                finalDrainTimer = undefined;
            }
            if (finalHardFinishTimer) {
                clearTimeout(finalHardFinishTimer);
                finalHardFinishTimer = undefined;
            }
        };
        function armWatchdogTail() {
            if ((!cleanTerminalAssistantStopReceived && !agentSettledReceived) || watchdogTailTimer || settled || promptSettled)
                return;
            watchdogTailTimer = setTimeout(() => {
                watchdogTailTimer = undefined;
                childWatchdogState = {
                    phase: "stale",
                    seq: (childWatchdogState?.seq ?? 0) + 1,
                    lastUpdate: Date.now(),
                    reason: "child watchdog tail timeout",
                    timedOut: true,
                };
                startFinalDrain();
            }, input.childWatchdog?.watchdogTailTimeoutMs ?? 120_000);
            watchdogTailTimer.unref?.();
        }
        // If the child emits its terminal event but its run never settles (a hook
        // is stuck), abort it after a short grace period and then finish without it.
        const observeQueuedDrainHold = () => {
            if (childSessionHasQueuedMessages(session))
                queuedDrainHold = true;
            return queuedDrainHold;
        };
        function startFinalDrain() {
            if (childWatchdogIsActive(childWatchdogState)) {
                armWatchdogTail();
                return;
            }
            if (promptSettled || finalDrainTimer || settled)
                return;
            if (observeQueuedDrainHold())
                return;
            armFinalDrainTimer();
        }
        function armFinalDrainTimer() {
            if (promptSettled || finalDrainTimer || settled)
                return;
            finalDrainTimer = setTimeout(() => {
                if (settled || promptSettled)
                    return;
                if (input.launch.capture.finalDrainHeld() || observeQueuedDrainHold()) {
                    finalDrainTimer = undefined;
                    armFinalDrainTimer();
                    return;
                }
                forcedTermination = true;
                if (!cleanTerminalAssistantStopReceived && !agentSettledReceived && !error && !assistantError) {
                    error = `Subagent session did not settle within ${FINAL_STOP_GRACE_MS}ms after its terminal event. Aborting it.`;
                }
                abortChild();
                finalHardFinishTimer = setTimeout(() => {
                    if (settled || promptSettled)
                        return;
                    settle(undefined, true);
                }, HARD_FINISH_MS);
                finalHardFinishTimer.unref?.();
            }, FINAL_STOP_GRACE_MS);
            finalDrainTimer.unref?.();
        }
        const applyChildLifecycle = (action) => {
            if (action === "cancel-drain") {
                cleanTerminalAssistantStopReceived = false;
                agentSettledReceived = false;
                clearFinalDrainTimers();
                clearWatchdogTailTimer();
                return;
            }
            if (action === "start-drain")
                startFinalDrain();
        };
        let toolTimeoutSequence = 0;
        const activeToolTimeouts = new Map();
        const activeToolTimeoutKeysByName = new Map();
        const removeToolTimeoutKey = (key) => {
            const active = activeToolTimeouts.get(key);
            if (!active)
                return;
            clearTimeout(active.timer);
            activeToolTimeouts.delete(key);
            const keys = activeToolTimeoutKeysByName.get(active.toolName)?.filter((candidate) => candidate !== key) ?? [];
            if (keys.length > 0)
                activeToolTimeoutKeysByName.set(active.toolName, keys);
            else
                activeToolTimeoutKeysByName.delete(active.toolName);
        };
        const clearActiveToolTimeout = (event) => {
            const key = typeof event.toolCallId === "string" && event.toolCallId.length > 0
                ? `id:${event.toolCallId}`
                : typeof event.toolName === "string"
                    ? activeToolTimeoutKeysByName.get(event.toolName)?.[0]
                    : activeToolTimeouts.size === 1
                        ? [...activeToolTimeouts.keys()][0]
                        : undefined;
            if (key)
                removeToolTimeoutKey(key);
        };
        const clearAllToolTimeouts = () => {
            for (const key of [...activeToolTimeouts.keys()])
                removeToolTimeoutKey(key);
        };
        const terminateForTimeout = (message) => {
            if (settled || promptSettled || timedOut || stopped)
                return;
            timedOut = true;
            interrupted = false;
            error = message;
            abortChild();
        };
        const armToolTimeout = (event) => {
            const timeoutForTool = effectiveToolTimeoutMs(event.toolName, input.toolTimeoutMs);
            if (timeoutForTool === undefined)
                return;
            const runRemaining = input.runDeadlineAt === undefined ? undefined : Math.max(0, input.runDeadlineAt - Date.now());
            if (runRemaining !== undefined && timeoutForTool >= runRemaining)
                return;
            const key = toolTimeoutCallKey(event, ++toolTimeoutSequence);
            const toolName = event.toolName;
            const timer = setTimeout(() => {
                removeToolTimeoutKey(key);
                terminateForTimeout(formatToolTimeoutMessage(toolName, timeoutForTool));
            }, timeoutForTool);
            timer.unref?.();
            activeToolTimeouts.set(key, { toolName, timer });
            const keys = activeToolTimeoutKeysByName.get(toolName) ?? [];
            keys.push(key);
            activeToolTimeoutKeysByName.set(toolName, keys);
        };
        const processEvent = (raw) => {
            if (settled)
                return;
            const event = raw;
            appendChildEvent(projectChildSessionEventForJson(raw));
            input.transcriptWriter?.writeChildEvent(projectChildSessionEventForJson(raw));
            if (event.type === "compaction_start")
                compactionStartedReceived = true;
            if (event.type === "compaction_end" && event.willRetry === true) {
                compactionStartedReceived = false;
                afterCompactionSettlement = false;
            }
            if (event.type === "turn_start" || event.type === "agent_start" || event.type === "auto_retry_start") {
                queuedDrainHold = false;
            }
            if (event.type === "agent_start" || event.type === "auto_retry_start") {
                compactionStartedReceived = false;
                afterCompactionSettlement = false;
            }
            const lifecycleAction = projectChildLifecycle(event, false, childLifecycleState);
            if (event.type === "agent_settled" && lifecycleAction === "start-drain") {
                agentSettledReceived = true;
                afterCompactionSettlement = compactionStartedReceived;
            }
            applyChildLifecycle(lifecycleAction);
            if (isChildWatchdogStatusEvent(event)) {
                if (!input.childWatchdog)
                    return;
                const next = acceptChildWatchdogEvent({
                    current: childWatchdogState,
                    event,
                    ...(input.childEventContext ? {
                        runId: input.childEventContext.runId,
                        agent: input.childEventContext.agent,
                        childIndex: input.childEventContext.stepIndex,
                    } : {}),
                });
                if (!next)
                    return;
                childWatchdogState = next;
                input.onChildEvent?.(event);
                if (childWatchdogIsActive(next)) {
                    clearFinalDrainTimers();
                    armWatchdogTail();
                }
                else {
                    clearWatchdogTailTimer();
                    if (cleanTerminalAssistantStopReceived || agentSettledReceived)
                        startFinalDrain();
                }
                return;
            }
            input.onChildEvent?.(event);
            if (event.type === "tool_execution_end") {
                clearActiveToolTimeout(event);
                removeActiveToolCall(event);
                return;
            }
            if (event.type === "tool_execution_start" && event.toolName) {
                toolCount += 1;
                const toolArgs = event.args && typeof event.args === "object" && !Array.isArray(event.args) ? event.args : {};
                armToolTimeout({ toolCallId: event.toolCallId, toolName: event.toolName });
                recordActiveToolCall({ toolCallId: event.toolCallId, toolName: event.toolName, args: toolArgs });
                if (event.toolName === "structured_output") {
                    structuredOutputToolInvoked = true;
                    structuredOutputMessageStartIndex = messages.length;
                }
                observedMutationAttempt = observedMutationAttempt || isMutatingTool(event.toolName, toolArgs, input.mutationTools);
                const preview = extractToolArgsPreview(toolArgs);
                input.writeOutputLine(preview ? `${event.toolName}: ${preview}` : event.toolName);
                return;
            }
            if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
                if (event.type === "tool_result_end") {
                    clearActiveToolTimeout(event);
                    removeActiveToolCall({
                        toolCallId: event.message.toolCallId ?? event.toolCallId,
                        toolName: event.message.toolName ?? event.toolName,
                    });
                }
                messages.push(event.message);
                const text = extractTextFromContent(event.message.content);
                if (text)
                    writeOutputText(text);
                if (event.type === "message_end" && event.message.role === "user" && text) {
                    const matched = takeMatchingAcceptedSteer(acceptedSteers, text);
                    if (matched) {
                        input.onSteerOutcome?.(matched.request, {
                            state: "delivered",
                            deliveryStatus: "delivered",
                            message: "Child consumed the steering input.",
                        });
                    }
                }
                if (input.childWatchdog && event.type === "message_end") {
                    const next = applyChildWatchdogMessage(childWatchdogState, event.message);
                    if (next)
                        childWatchdogState = next;
                }
                if (event.type !== "message_end" || event.message.role !== "assistant")
                    return;
                const hasToolCall = assistantStartsToolCall(event.message);
                if (event.message.model) {
                    model = event.message.model;
                    if (input.expectedModelForVerification && !hasToolCall) {
                        const modelVerificationError = formatSubagentModelVerificationError(input.expectedModelForVerification, event.message.model, input.modelVerificationRegistry, input.modelResponseAliases);
                        if (modelVerificationError && !error)
                            error = modelVerificationError;
                    }
                }
                if (event.message.errorMessage)
                    assistantError = event.message.errorMessage;
                else if (hasToolCall && event.message.stopReason === "toolUse") {
                    // A recovered request can finish via a terminating tool, without a text stop.
                    assistantError = undefined;
                }
                const eventUsage = event.message.usage;
                if (eventUsage) {
                    usage.turns++;
                    usage.input += eventUsage.input ?? eventUsage.inputTokens ?? 0;
                    usage.output += eventUsage.output ?? eventUsage.outputTokens ?? 0;
                    usage.cacheRead += eventUsage.cacheRead ?? 0;
                    usage.cacheWrite += eventUsage.cacheWrite ?? 0;
                    usage.cost += eventUsage.cost?.total ?? 0;
                }
                if (isTerminalAssistantStop(event.message)) {
                    if (!event.message.errorMessage && extractTextFromContent(event.message.content).trim())
                        assistantError = undefined;
                    cleanTerminalAssistantStopReceived ||= !event.message.errorMessage;
                    clearAllToolTimeouts();
                    activeToolCalls.clear();
                    activeToolKeysByName.clear();
                    refreshCurrentTool();
                    applyChildLifecycle(projectChildLifecycle(event, true, childLifecycleState));
                }
            }
        };
        /** Stops observing the child and returns when its extensions have shut down. */
        const finish = () => {
            clearFinalDrainTimers();
            clearWatchdogTailTimer();
            clearAllToolTimeouts();
            if (abortSettleTimer) {
                clearTimeout(abortSettleTimer);
                abortSettleTimer = undefined;
            }
            input.registerInterrupt?.(undefined);
            input.registerTimeout?.(undefined);
            input.registerStop?.(undefined);
            input.registerSteer?.(undefined);
            input.registerWatchdogStatus?.(undefined);
            unsubscribe?.();
            return Promise.resolve().then(() => session?.dispose()).catch(() => undefined);
        };
        /** The child run ended (or was forced to end); fold in the outcome once the child's shutdown work is done. */
        const failUnconsumedSteers = () => {
            for (const entry of acceptedSteers.splice(0)) {
                input.onSteerOutcome?.(entry.request, { state: "failed", message: unconsumedSteerReason(entry.request.mode) });
            }
        };
        const settle = (promptError, forced = false) => {
            if (settled)
                return;
            settled = true;
            failUnconsumedSteers();
            const terminalUsage = session && messageBaseline !== undefined
                ? reconcileAttemptUsage(usage, session.messages, messageBaseline)
                : usage;
            const closed = finish();
            const finalOutput = getFinalOutput(messages);
            let finalError = error ?? assistantError;
            const promptErrorMessage = promptError === undefined ? undefined : promptError instanceof Error ? promptError.message : String(promptError);
            if (!finalError && promptErrorMessage !== undefined) {
                finalError = promptErrorMessage;
            }
            // A child launched without the ambient extensions resolves a provider
            // extension's model as "not found". Annotate only a creation/prompt failure
            // that produced no turn; keep the core error and add the rule and the
            // remedies that load the extension for this child.
            if (promptErrorMessage !== undefined
                && finalError === promptErrorMessage
                && isChildModelResolutionFailure(promptErrorMessage)
                && messages.length === 0
                && terminalUsage.turns === 0
                && !input.launch.session.ambientExtensions) {
                finalError = `${promptErrorMessage}\n\n${formatChildModelResolutionDiagnostic({ agent: input.launch.config.agent, model: input.launch.session.model, host: "runner", capabilityCeiling: input.launch.toolPlan.capabilityCeiling })}`;
            }
            const forcedDrainAfterFinalSuccess = (forced || forcedTermination) && (cleanTerminalAssistantStopReceived || agentSettledReceived) && !finalError;
            const forcedDrainAfterEmptyTerminal = forcedDrainAfterFinalSuccess && hasEmptyTerminalAssistantResponse(messages);
            if (!finalError && forced && !forcedDrainAfterFinalSuccess && !interrupted && !timedOut && !stopped) {
                finalError = "Subagent session did not settle after it was aborted.";
            }
            const exitCode = timedOut || stopped
                ? 1
                : interrupted || (forcedDrainAfterFinalSuccess && !forcedDrainAfterEmptyTerminal)
                    ? 0
                    : finalError || promptError !== undefined ? 1 : 0;
            void closed.then(() => {
                const result = omitUndefined({
                    exitCode,
                    messages,
                    usage: terminalUsage,
                    toolCount,
                    durationMs: Date.now() - startedAt,
                    model,
                    nativeMachine: session?.machineEvidence ? { provider: "herdr", machineId: session.machineEvidence.machineId, ...(session.machineEvidence.initial ? { initialGit: session.machineEvidence.initial } : {}), ...(session.machineEvidence.final ? { finalGit: session.machineEvidence.final } : {}) } : undefined,
                    error: stopped ? stopMessage() : timedOut ? (error ?? timeoutMessage()) : interrupted || (forcedDrainAfterFinalSuccess && !forcedDrainAfterEmptyTerminal) ? undefined : finalError,
                    finalOutput: (timedOut || stopped) && !finalOutput.trim() ? (stopped ? stopMessage() : error ?? timeoutMessage()) : finalOutput,
                    outputState: finalOutput.trim() ? "present" : "absent",
                    interrupted: interrupted || undefined,
                    timedOut: timedOut || undefined,
                    stopped: stopped || undefined,
                    observedMutationAttempt,
                    structuredOutputToolInvoked,
                    structuredOutputMessageStartIndex,
                    watchdog: childWatchdogState,
                    sessionFile: session?.sessionFile,
                    currentTool,
                    currentToolArgs,
                    currentPath,
                    afterCompactionSettlement: afterCompactionSettlement || undefined,
                });
                resolve(result);
            });
        };
        input.registerInterrupt?.(() => {
            if (settled || promptSettled || timedOut || stopped)
                return;
            interrupted = true;
            if (!error)
                error = "Interrupted. Waiting for explicit next action.";
            abortChild();
        });
        input.registerTimeout?.(() => terminateForTimeout(timeoutMessage()));
        input.registerStop?.(() => {
            if (settled || promptSettled || timedOut || stopped)
                return;
            stopped = true;
            interrupted = false;
            error = stopMessage();
            abortChild();
        });
        void (async () => {
            try {
                const createInput = createReportedChildSessionInput(input.launch, input.transcriptWriter);
                const created = await input.factory.create(createInput);
                if (settled) {
                    await created.dispose().catch(() => undefined);
                    return;
                }
                session = created;
                const steer = created.steer.bind(created);
                const followUp = created.followUp.bind(created);
                created.steer = async (text) => {
                    if (cleanTerminalAssistantStopReceived || agentSettledReceived)
                        queuedDrainHold = true;
                    return steer(text);
                };
                created.followUp = async (text) => {
                    if (cleanTerminalAssistantStopReceived || agentSettledReceived)
                        queuedDrainHold = true;
                    return followUp(text);
                };
                unsubscribe = created.subscribe(processEvent);
                input.registerWatchdogStatus?.((event) => processEvent(event));
                input.registerSteer?.(async (request) => {
                    const text = formatSteerMessage(request);
                    const followUp = request.mode === "follow_up";
                    const accepted = { request, text };
                    acceptedSteers.push(accepted);
                    const queued = {
                        state: "queued",
                        deliveryStatus: "queued",
                        message: followUp ? "Pi queued the follow-up input." : "Pi accepted the steering input.",
                    };
                    try {
                        if (followUp)
                            await created.followUp(text);
                        else
                            await created.steer(text);
                    }
                    catch (steerError) {
                        const index = acceptedSteers.indexOf(accepted);
                        if (index >= 0)
                            acceptedSteers.splice(index, 1);
                        return { state: "failed", message: steerError instanceof Error ? steerError.message : String(steerError) };
                    }
                    return queued;
                });
                if (interrupted || timedOut || stopped)
                    abortChild();
                messageBaseline = created.messages.length;
                await created.prompt(input.prompt);
                promptSettled = true;
                settle(undefined);
            }
            catch (promptError) {
                promptSettled = true;
                settle(promptError ?? new Error("Child session failed."));
            }
        })();
    });
}
//# sourceMappingURL=run-child-session.js.map