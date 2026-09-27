import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ControlEvent, SubagentState } from "../shared/types.ts";
export declare const SUBAGENT_CONTROL_MESSAGE_TYPE = "subagent_control_notice";
export interface SubagentControlMessageDetails {
    event: ControlEvent;
    source?: "foreground" | "async" | "goal";
    asyncDir?: string;
    childIntercomTarget?: string;
    noticeText?: string;
}
export declare function controlNoticeTarget(details: SubagentControlMessageDetails): string | undefined;
export declare function formatSubagentControlNotice(details: SubagentControlMessageDetails, content?: string): string;
export declare function handleSubagentControlNotice(input: {
    pi: Pick<ExtensionAPI, "sendMessage">;
    state: SubagentState;
    visibleControlNotices: Set<string>;
    details: SubagentControlMessageDetails;
}): void;
//# sourceMappingURL=control-notices.d.ts.map