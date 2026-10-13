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
export declare function supervisorReplyHint(requestId: string): string;
export declare function parseSupervisorRequestDetails(value: unknown): SupervisorRequestMessageDetails | undefined;
export declare function parseSupervisorReplyData(value: unknown): SupervisorReplyEntryData | undefined;
//# sourceMappingURL=supervisor-ui.d.ts.map