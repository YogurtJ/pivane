import { type SubagentDelegationRequest, type SubagentDelegationResponse, type SubagentDelegationThinking, type SubagentDelegationUpdate, type SubagentDelegationUpdateUsage } from "../api/delegation.ts";
import type { AcceptanceInput, AgentContract, EffectsProjection, ExecutionProjection, IntercomBridgeConfig, JsonSchemaObject, ReviewProjection, ToolBudgetConfig, Usage } from "../shared/types.ts";
export interface PromptTemplateDelegationRequest {
    requestId: string;
    agent: string;
    task: string;
    context: "fresh" | "fork";
    model: string;
    cwd: string;
}
export interface PromptTemplateDelegationResponse extends PromptTemplateDelegationRequest {
    messages: unknown[];
    contentText?: string;
    isError: boolean;
    errorText?: string;
}
interface PromptTemplateDelegationTaskProgress {
    index?: number;
    agent: string;
    status?: string;
    currentTool?: string;
    currentToolArgs?: string;
    recentOutput?: string;
    recentOutputLines?: string[];
    recentTools?: Array<{
        tool: string;
        args: string;
    }>;
    model?: string;
    toolCount?: number;
    durationMs?: number;
    tokens?: number;
}
export interface PromptTemplateDelegationUpdate {
    requestId: string;
    runId?: string;
    currentTool?: string;
    currentToolArgs?: string;
    recentOutput?: string;
    recentOutputLines?: string[];
    recentTools?: Array<{
        tool: string;
        args: string;
    }>;
    model?: string;
    toolCount?: number;
    durationMs?: number;
    tokens?: number;
    usage?: SubagentDelegationUpdateUsage;
    taskProgress?: PromptTemplateDelegationTaskProgress[];
}
interface DelegationAcceptanceSnapshot {
    status: string;
    evidenceStatus?: string;
    explicit?: boolean;
}
export interface PromptTemplateBridgeResult {
    isError?: boolean;
    content?: unknown;
    details?: {
        mode?: "single" | "parallel" | "chain" | "workflow" | "management";
        runId?: string;
        timedOut?: boolean;
        stopped?: boolean;
        results?: Array<{
            agent?: string;
            messages?: unknown[];
            finalOutput?: string;
            toolCalls?: Array<{
                text?: string;
                expandedText?: string;
            }>;
            exitCode?: number;
            error?: string;
            model?: string;
            thinking?: string;
            structuredOutput?: unknown;
            interrupted?: boolean;
            timedOut?: boolean;
            stopped?: boolean;
            toolBudgetBlocked?: boolean;
            structuredOutputFailed?: boolean;
            savedOutputPath?: string;
            sessionFile?: string;
            agentContract?: AgentContract;
            execution?: ExecutionProjection;
            acceptance?: DelegationAcceptanceSnapshot;
            review?: ReviewProjection;
            effects?: EffectsProjection;
            usage?: Usage;
            progressSummary?: {
                toolCount?: number;
                durationMs?: number;
                tokens?: number;
            };
            skillsWarning?: string;
            outputSaveError?: string;
            transcriptError?: string;
        }>;
        progress?: Array<{
            index?: number;
            agent?: string;
            status?: string;
            currentTool?: string;
            currentToolArgs?: string;
            recentOutput?: string[];
            recentTools?: Array<{
                tool?: string;
                args?: string;
            }>;
            toolCount?: number;
            durationMs?: number;
            tokens?: number;
            inputTokens?: number;
            outputTokens?: number;
            cacheRead?: number;
            cacheWrite?: number;
            turnCount?: number;
        }>;
    };
}
export interface DelegatedSubagentExecutionParams {
    agent?: string;
    task?: string;
    context: "fresh" | "fork";
    model?: string;
    cwd: string;
    timeoutMs?: number;
    toolBudget?: ToolBudgetConfig;
    skill?: string | string[] | boolean;
    output?: string | boolean;
    outputMode?: "inline" | "file-only";
    outputSchema?: JsonSchemaObject;
    agentContract?: AgentContract;
    acceptance?: AcceptanceInput;
    artifacts?: boolean;
    intercomBridge?: IntercomBridgeConfig;
    /** Internal-only thinking override accepted by executeDelegated. */
    delegatedThinkingOverride?: SubagentDelegationThinking;
    /** Internal-only capability accepted and stripped by executeDelegated. */
    delegatedAllowZeroToolBudget?: true;
    async: false;
    foregroundOnly: true;
    clarify: false;
}
export declare function parsePromptTemplateRequest(data: unknown): PromptTemplateDelegationRequest | undefined;
export declare function toDelegationUpdate(requestId: string, update: PromptTemplateBridgeResult): PromptTemplateDelegationUpdate | undefined;
export declare function toSubagentDelegationExecutionParams(request: SubagentDelegationRequest): DelegatedSubagentExecutionParams;
export declare function toSubagentDelegationUpdate(request: SubagentDelegationRequest, result: PromptTemplateBridgeResult): SubagentDelegationUpdate | undefined;
export declare function toSubagentDelegationResponse(request: SubagentDelegationRequest, result: PromptTemplateBridgeResult, aborted: boolean): SubagentDelegationResponse;
export declare function toPromptTemplateResponse(request: PromptTemplateDelegationRequest, result: PromptTemplateBridgeResult): PromptTemplateDelegationResponse;
export {};
//# sourceMappingURL=delegation-adapters.d.ts.map