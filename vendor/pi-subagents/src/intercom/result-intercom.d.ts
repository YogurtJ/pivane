import { type Details, type IntercomEventBus, type NestedRunSummary, type PublicNestedRunSummary, type ParallelHandoffReference, type SubagentResultIntercomChild, type SubagentResultIntercomPayload, type SubagentResultStatus, type SubagentRunMode } from "../shared/types.ts";
export declare function resolveSubagentResultStatus(input: {
    exitCode?: number;
    success?: boolean;
    state?: string;
    interrupted?: boolean;
    detached?: boolean;
    processSignal?: string | null;
    timedOut?: boolean;
    stopped?: boolean;
    turnBudgetExceeded?: boolean;
}): SubagentResultStatus;
export declare function compactNestedResultChildren(children: Array<NestedRunSummary | PublicNestedRunSummary> | undefined): PublicNestedRunSummary[] | undefined;
export declare function attachNestedChildrenToResultChildren(runId: string, children: SubagentResultIntercomChild[], nestedChildren: NestedRunSummary[] | undefined): SubagentResultIntercomChild[];
interface GroupedResultIntercomMessageInput {
    to: string;
    runId: string;
    mode: SubagentRunMode;
    source: "foreground" | "async";
    children: SubagentResultIntercomChild[];
    asyncId?: string;
    asyncDir?: string;
    chainSteps?: number;
    parallelHandoff?: ParallelHandoffReference;
}
export declare function buildSubagentResultIntercomPayload(input: GroupedResultIntercomMessageInput): SubagentResultIntercomPayload;
export declare function deliverSubagentResultIntercomEvent(events: IntercomEventBus, payload: SubagentResultIntercomPayload, timeoutMs?: number): Promise<boolean>;
export declare function deliverSubagentIntercomMessageEvent(events: IntercomEventBus, to: string, message: string, timeoutMs?: number, extra?: Record<string, unknown>): Promise<boolean>;
export declare function stripDetailsOutputsForIntercomReceipt(details: Details): Details;
export declare function formatSubagentResultReceipt(input: {
    mode: SubagentRunMode;
    runId: string;
    payload: SubagentResultIntercomPayload;
}): string;
export {};
//# sourceMappingURL=result-intercom.d.ts.map