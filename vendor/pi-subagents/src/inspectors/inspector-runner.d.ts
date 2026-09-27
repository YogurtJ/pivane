import type { MissionRecord } from "../missions/types.ts";
import type { AsyncStatus } from "../shared/types.ts";
export interface RunnerOptions {
    asyncDir: string;
    runId: string;
    index?: number;
    missionPath?: string;
    refreshMs: number;
    allowSteer?: boolean;
    allowStop?: boolean;
    sessionRoots: string[];
}
export declare function formatInspectorDashboard(input: {
    status: AsyncStatus;
    asyncDir: string;
    index?: number;
    mission?: MissionRecord;
    allowSteer?: boolean;
    allowStop?: boolean;
    sessionRoots?: string[];
}): string;
export declare function submitInspectorControl(options: RunnerOptions, line: string): string;
export declare function runInspector(argv?: string[]): void;
//# sourceMappingURL=inspector-runner.d.ts.map