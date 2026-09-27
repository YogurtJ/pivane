import { type SubagentDelegationRequest } from "../api/delegation.ts";
export type SubagentDelegationParseResult = {
    ok: true;
    request: SubagentDelegationRequest;
} | {
    ok: false;
    requestId?: string;
    ownerRunId?: string;
    nodeId?: string;
    error: string;
};
export declare function parseSubagentDelegationRequest(data: unknown): SubagentDelegationParseResult;
//# sourceMappingURL=delegation-request.d.ts.map