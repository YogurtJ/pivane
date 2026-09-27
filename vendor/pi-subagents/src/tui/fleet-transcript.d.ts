import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type MarkdownTheme } from "@earendil-works/pi-tui";
type Theme = ExtensionContext["ui"]["theme"];
export type FleetTranscriptEvent = {
    kind: "assistant";
    text: string;
    model?: string;
    timestamp?: number;
} | {
    kind: "user";
    text: string;
    timestamp?: number;
} | {
    kind: "tool";
    toolCallId?: string;
    name: string;
    args?: string;
    argsPayload?: string;
    output?: string;
    outputTruncated?: boolean;
    status: "running" | "complete" | "error";
    error?: string;
    startedAt?: number;
    endedAt?: number;
    timestamp?: number;
} | {
    kind: "notice";
    text: string;
    tone: "muted" | "warning" | "error";
    timestamp?: number;
};
export interface FleetTranscript {
    path: string;
    events: FleetTranscriptEvent[];
    truncated: boolean;
    warning?: string;
}
interface FleetTranscriptReadOptions {
    trustedRoots: string[];
    trustedFiles?: string[];
    trustedFileRoot?: string;
    maxRecords?: number;
    maxBytes?: number;
}
export declare function readFleetTranscript(filePath: string, options: FleetTranscriptReadOptions): FleetTranscript;
export declare function renderFleetTranscript(transcript: FleetTranscript, width: number, theme: Theme, markdownTheme: MarkdownTheme, options?: {
    expandedTools?: boolean;
}): string[];
export {};
//# sourceMappingURL=fleet-transcript.d.ts.map