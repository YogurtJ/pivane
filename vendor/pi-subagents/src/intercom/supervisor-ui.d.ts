import type { EntryRenderOptions, MessageRenderOptions, Theme } from "@earendil-works/pi-coding-agent";
import { type Component } from "@earendil-works/pi-tui";
export declare const SUPERVISOR_REQUEST_MESSAGE_TYPE = "subagent_supervisor_request";
export declare const SUPERVISOR_REPLY_ENTRY_TYPE = "subagent_supervisor_reply";
export type SupervisorReason = "need_decision" | "interview_request" | "progress_update";
export interface SupervisorRequestMessageDetails {
    id?: string;
    requestId?: string;
    reason?: SupervisorReason;
    expectsReply?: boolean;
    runId?: string;
    agent?: string;
    childIndex?: number;
    childTarget?: string;
    interview?: unknown;
    requestBody?: string;
    replyHint?: string;
}
export interface SupervisorReplyEntryData {
    requestId: string;
    reason?: SupervisorReason;
    runId: string;
    agent: string;
    childIndex: number;
    childTarget?: string;
    message: string;
    createdAt: number;
}
interface SupervisorMessageLike {
    content: unknown;
    details?: unknown;
}
interface SupervisorEntryLike {
    data?: unknown;
}
export declare function supervisorReplyHint(requestId: string): string;
export declare function renderSupervisorRequest(message: SupervisorMessageLike, options: MessageRenderOptions, theme: Theme): Component | undefined;
export declare function renderSupervisorReply(entry: SupervisorEntryLike, options: EntryRenderOptions, theme: Theme): Component | undefined;
export {};
//# sourceMappingURL=supervisor-ui.d.ts.map