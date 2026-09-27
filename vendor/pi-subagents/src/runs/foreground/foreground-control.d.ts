import type { AgentProgress, ForegroundChildControl, ForegroundRunControl } from "../../shared/types.ts";
import { type PromptAuditRerunContract } from "./prompt-audit.ts";
interface BeginForegroundChildInput {
    index: number;
    agent: string;
    description?: string;
    authoredTask: string;
    effectivePrompt: string;
    cwd?: string;
    outputPath?: string;
    rerun?: PromptAuditRerunContract;
    model?: string;
    thinking?: string;
    interrupt: () => boolean;
    detach?: () => boolean;
    steer?: ForegroundChildControl["steer"];
}
export declare function retainForegroundSchedulingOwner(control: ForegroundRunControl): void;
export declare function settleForegroundSchedulingOwner(control: ForegroundRunControl): void;
export declare function foregroundSchedulingSettled(control: ForegroundRunControl): boolean;
export declare function beginForegroundChild(control: ForegroundRunControl, input: BeginForegroundChildInput): void;
export declare function updateForegroundChild(control: ForegroundRunControl, index: number, progress: AgentProgress | undefined): void;
export declare function finishForegroundChild(control: ForegroundRunControl, index: number): void;
export {};
//# sourceMappingURL=foreground-control.d.ts.map