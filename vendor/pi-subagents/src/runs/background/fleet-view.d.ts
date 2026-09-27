import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type AsyncStatus, type Details, type NestedRunSummary, type SubagentState } from "../../shared/types.ts";
interface FleetViewParams {
    lines?: number;
}
interface FleetViewDeps {
    asyncDirRoot?: string;
    resultsDir?: string;
    kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
    now?: () => number;
    state?: SubagentState;
    childSafe?: boolean;
}
interface TranscriptOptions {
    index?: number;
    lines?: number;
    sessionRoots?: string[];
    trustedSessionFiles?: string[];
    trustedSessionFileRoot?: string;
}
/** One structured content part of a session JSONL record. Shared by the prose transcript formatter and inspect RPC. */
export interface SessionTranscriptMessage {
    role: string;
    kind: "text" | "toolCall" | "toolResult";
    text: string;
    name?: string;
    isError?: boolean;
    /** Ordinal of the session record this part came from, so consumers can
     *  regroup multi-part messages (one session record can yield several parts). */
    recordIndex?: number;
}
/** Structured session tail: parsed content parts, newest last, bounded by
 *  maxMessages. Same trusted-root containment as the prose transcript tail. */
export declare function readSessionMessagesTail(sessionFile: string, maxMessages: number, trustedRoots: string[], trustedFiles?: string[], trustedFileRoot?: string): {
    messages: SessionTranscriptMessage[];
    warnings: string[];
    truncated: boolean;
};
export declare function inspectSubagentFleet(_params: FleetViewParams, deps?: FleetViewDeps): AgentToolResult<Details>;
export declare function formatAsyncRunTranscript(status: AsyncStatus, asyncDir: string, options?: TranscriptOptions): string;
export declare function formatNestedRunTranscript(run: NestedRunSummary, options?: TranscriptOptions): string;
export declare function formatAsyncResultTranscript(data: {
    id?: string;
    runId?: string;
    state?: string;
    success?: boolean;
    summary?: string;
    output?: string;
    sessionFile?: string;
    agent?: string;
    exitCode?: number | null;
    results?: Array<{
        agent?: string;
        sessionName?: string;
        output?: string;
        summary?: string;
        sessionFile?: string;
        state?: string;
        success?: boolean;
        exitCode?: number | null;
    }>;
}, resultPath: string, options?: TranscriptOptions): string;
export {};
//# sourceMappingURL=fleet-view.d.ts.map