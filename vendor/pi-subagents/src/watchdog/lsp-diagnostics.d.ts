import type { WatchdogLspConfig, WatchdogLspResult, WatchdogWarning } from "./types.ts";
export interface WatchdogLspRequest {
    cwd: string;
    root: string;
    changedPaths: string[];
    config: WatchdogLspConfig;
    signal?: AbortSignal;
}
export type WatchdogLspDiagnosticsFunction = (request: WatchdogLspRequest) => Promise<WatchdogLspResult> | WatchdogLspResult;
export declare class WatchdogLspDiagnosticsLedger {
    private readonly seen;
    reset(): void;
    reduce(result: WatchdogLspResult): WatchdogLspResult;
}
export declare function formatWatchdogLspDiagnosticsBlock(result: WatchdogLspResult): string;
export declare function watchdogWarningFromLspDiagnostics(result: WatchdogLspResult): WatchdogWarning | undefined;
export declare function collectWatchdogLspDiagnostics(request: WatchdogLspRequest): Promise<WatchdogLspResult>;
//# sourceMappingURL=lsp-diagnostics.d.ts.map