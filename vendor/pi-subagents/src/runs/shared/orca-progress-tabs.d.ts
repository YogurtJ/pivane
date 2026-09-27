import type { Message } from "@earendil-works/pi-ai";
import { type OrcaProgressTabsConfig } from "../../shared/types.ts";
export interface OrcaProgressTab {
    /** Resolves when the terminal-create watchdog closes, after its final manifest/queue writes (success or failure). Not viewer completion. */
    readonly creationSettled: Promise<void>;
    append(text: string): void;
    section(input: {
        agent: string;
        index: number;
        count: number;
    }): void;
    event(event: {
        type?: string;
        message?: Message;
        toolName?: string;
        args?: unknown;
    }): void;
    /** Resolves once the mirrored log and its done marker are on disk, so a host may exit afterwards. */
    finish(status: "completed" | "failed" | "stopped", sessionFile?: string): Promise<void>;
}
export declare function resolveOrcaCommand(env?: NodeJS.ProcessEnv): string | undefined;
export declare function resolvePiSessionId(sessionFile: string | undefined): string | undefined;
export declare function createOrcaProgressTab(input: {
    cwd: string;
    runId: string;
    agent: string;
    index: number;
    stepCount?: number;
    config?: OrcaProgressTabsConfig;
    env?: NodeJS.ProcessEnv;
    command?: string;
}): OrcaProgressTab | undefined;
//# sourceMappingURL=orca-progress-tabs.d.ts.map