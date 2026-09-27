import type { AsyncStatus } from "../../shared/types.ts";
export declare const TERMINAL_RUN_INDEX_DIR = ".terminal-runs";
export declare function updateTerminalRunIndex(asyncDir: string, status: AsyncStatus): void;
export declare function readRecentTerminalRunIndex(asyncDirRoot: string, options?: {
    sessionId?: string;
    limit?: number;
}): string[];
//# sourceMappingURL=terminal-run-index.d.ts.map