import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SteeringNotice, SubagentState } from "../shared/types.ts";
export declare const SUBAGENT_STEERING_MESSAGE_TYPE = "subagent_steering_notice";
export interface SubagentSteeringMessageDetails extends SteeringNotice {
    source?: "async";
    asyncDir?: string;
    noticeText?: string;
}
export declare function formatSteeringNotice(details: Pick<SubagentSteeringMessageDetails, "runId" | "requestId" | "state" | "message">): string;
export declare function handleSubagentSteeringNotice(input: {
    pi: Pick<ExtensionAPI, "sendMessage">;
    state: SubagentState;
    details: SubagentSteeringMessageDetails;
}): void;
//# sourceMappingURL=steering-notices.d.ts.map