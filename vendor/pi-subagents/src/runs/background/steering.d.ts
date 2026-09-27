import type { AsyncStatus, ResolvedToolBudget, SteerActionResult, SteeringRecoveryDescriptor, SteeringRequestStatus, SteeringStatus, SteeringTargetState, SteeringTargetStatus } from "../../shared/types.ts";
import type { SteerDeliveryMode } from "./control-channel.ts";
export declare const MAX_STEERING_REQUESTS = 20;
export declare const STEERING_MESSAGE_PREVIEW_LIMIT = 160;
export declare function steeringMessagePreview(message: string): string;
/** FIFO match of one accepted steer to an emitted user message; equal text claims the oldest entry. */
export declare function takeMatchingAcceptedSteer<T extends {
    text: string;
}>(accepted: T[], messageText: string): T | undefined;
/** Settlement reason for one accepted request that never got a matching user `message_end`. */
export declare function unconsumedSteerReason(mode?: SteerDeliveryMode): string;
export declare function steeringReceipt(message: string, receipt: string): string;
export declare function createSteeringStatus(): SteeringStatus;
export declare function steeringStatus(status: Pick<AsyncStatus, "steering">): SteeringStatus;
export declare function recordSteeringRequest(status: SteeringStatus, input: {
    id: string;
    requestedAt: number;
    source?: string;
    message: string;
    targets: Array<{
        index: number;
        state: SteeringTargetState;
        reason?: string;
    }>;
}): SteeringRequestStatus;
export declare function updateSteeringTarget(status: SteeringStatus, requestId: string, index: number, state: SteeringTargetState, now: number, fields?: Pick<SteeringTargetStatus, "reason" | "replacementRunId">): SteeringTargetStatus | undefined;
export declare function findSteeringRequest(status: SteeringStatus, requestId: string): SteeringRequestStatus | undefined;
export declare function actionResultFromSteeringStatus(status: SteeringStatus, sourceRunId: string, requestId: string, replacementRunId?: string): SteerActionResult | undefined;
export declare function steeringActionIsTerminal(result: SteerActionResult | undefined): boolean;
export declare function terminalSteeringNoticeState(status: SteeringStatus, requestId: string): "failed" | "partial" | undefined;
export declare function claimSteeringRecovery(asyncDir: string, input: {
    requestId: string;
    sourceRunId: string;
    committedAt: number;
}): {
    claimPath: string;
    markerPath: string;
};
export declare function readSteeringStatus(asyncDir: string): SteeringStatus | undefined;
export declare function remainingSteeringRecoveryLimits(descriptor: Pick<SteeringRecoveryDescriptor, "absoluteDeadlineAt" | "initialToolBudget">, status: Pick<AsyncStatus, "toolBudget" | "toolCount">, now?: number): {
    timeoutMs?: number;
    absoluteDeadlineAt?: number;
    toolBudget?: ResolvedToolBudget;
};
export declare function waitForSteeringAction(input: {
    asyncDir: string;
    sourceRunId: string;
    requestId: string;
    timeoutMs: number;
    signal?: AbortSignal;
}): Promise<SteerActionResult | undefined>;
//# sourceMappingURL=steering.d.ts.map