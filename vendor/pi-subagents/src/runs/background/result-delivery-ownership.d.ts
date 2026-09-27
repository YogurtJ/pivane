import type { SubagentState } from "../../shared/types.ts";
type ResultDeliveryState = Pick<SubagentState, "currentSessionId" | "completionOwnerId">;
export interface ResultDeliveryOwnership {
    owns(sessionId: string, completionOwnerId: unknown): boolean;
    claimedSessionIds(): readonly string[];
    claimPredecessor(previousSessionFile: string | undefined, previousRuntimeSessionId: string | null): boolean;
    clear(): void;
}
export declare function createResultDeliveryOwnership(state: ResultDeliveryState): ResultDeliveryOwnership;
export {};
//# sourceMappingURL=result-delivery-ownership.d.ts.map