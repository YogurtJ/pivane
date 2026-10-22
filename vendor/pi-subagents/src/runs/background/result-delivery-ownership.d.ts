import type { SubagentState } from "../../shared/types.ts";
type ResultDeliveryState = Pick<SubagentState, "currentSessionId" | "completionOwnerId">;
export interface ResultDeliveryOwnership {
    owns(sessionId: string, completionOwnerId: unknown): boolean;
    claimedSessionIds(): readonly string[];
}
export declare function createResultDeliveryOwnership(state: ResultDeliveryState): ResultDeliveryOwnership;
export {};
