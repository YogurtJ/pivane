import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type AgentConfig } from "./agents.ts";
import type { Details, JsonSchemaObject, SingleResult, SubagentState } from "../shared/types.ts";
type RefinementAction = "refine" | "refine.show" | "refine.rollback";
type RefinementEvidenceSource = "live-state" | "artifact-metadata" | "artifact-output";
export interface RefinementEvidenceItem {
    id: string;
    source: RefinementEvidenceSource;
    runId?: string;
    agent: string;
    at?: string;
    status?: string;
    model?: string;
    thinking?: string;
    acceptanceStatus?: string;
    reviewFindings?: string[];
    residualRisks?: string[];
    errors?: string[];
    controlSignals?: string[];
    outputTail?: string;
    refs: string[];
}
export interface RefinementProposalEdit {
    title: string;
    guidance: string;
    evidenceIds: string[];
    rationale: string;
}
export interface RefinementProposal {
    summary: string;
    edits: RefinementProposalEdit[];
    rejectedIdeas?: string[];
    residualRisks: string[];
}
interface RefinementMetadata {
    agent: string;
    revision: number;
    updatedAt: string;
    base: {
        source: AgentConfig["source"];
        filePath: string;
        systemPromptSha256: string;
    };
    evidence: {
        maxItems: number;
        maxAgeDays: number;
        itemBytes: number;
        totalBytes: number;
    };
}
interface RefinementSnapshot {
    revision: number;
    at: string;
    action: "refine" | "rollback";
    before: string;
    after: string;
    evidenceIds: string[];
    proposalAgent?: string;
}
interface ParsedRefinementFile {
    metadata: RefinementMetadata;
    current: string;
    snapshots: RefinementSnapshot[];
}
interface ProposalChildResult {
    isError?: boolean;
    content?: Array<{
        type: string;
        text?: string;
    }>;
    details?: {
        results?: Array<Pick<SingleResult, "structuredOutput" | "finalOutput" | "error">>;
    };
}
export type LaunchRefinementProposalChild = (task: string, outputSchema: JsonSchemaObject, signal: AbortSignal) => Promise<ProposalChildResult>;
export interface RefinementActionContext {
    cwd: string;
    state: SubagentState;
    signal: AbortSignal;
    launchProposalChild: LaunchRefinementProposalChild;
}
export declare function getAgentRefinementPath(cwd: string, agentName: string): string;
export declare function parseRefinementFile(markdown: string, label?: string): ParsedRefinementFile;
export declare function collectBoundedRefinementEvidence(cwd: string, agentName: string, state: SubagentState): RefinementEvidenceItem[];
export declare function appendAgentRefinementOverlay(systemPrompt: string, input: {
    cwd: string;
    agentName: string;
}): string;
export declare function validateRefinementProposal(proposal: unknown, evidenceIds: string[]): {
    ok: true;
    proposal: RefinementProposal;
} | {
    ok: false;
    error: string;
};
export declare function handleRefinementAction(action: RefinementAction, params: {
    agent?: string;
}, ctx: RefinementActionContext): Promise<AgentToolResult<Details>>;
export {};
//# sourceMappingURL=agent-refinements.d.ts.map