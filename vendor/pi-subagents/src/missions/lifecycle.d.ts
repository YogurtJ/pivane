import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Details } from "../shared/types.ts";
import type { MissionRecord, MissionStoreConfig, MissionStoreLocation } from "./types.ts";
export declare const MISSION_BINDING_FILE = "mission.json";
export interface MissionLaunchParams {
    missionId?: string;
    mission?: unknown;
    task?: string;
    tasks?: Array<{
        task?: string;
    }>;
    chain?: Array<{
        task?: string;
        parallel?: Array<{
            task?: string;
        }> | {
            task?: string;
        };
    }>;
}
export interface MissionLaunchBinding {
    missionId: string;
    location: MissionStoreLocation;
    autoCreated: boolean;
    announceInContent?: boolean;
}
export declare function prepareMissionLaunch(input: {
    params: MissionLaunchParams;
    projectRoot: string;
    config?: MissionStoreConfig;
    ownerSessionId?: string;
}): MissionLaunchBinding | undefined;
export declare function writeMissionAsyncBinding(asyncDir: string, binding: MissionLaunchBinding): void;
export declare function attachMissionToLaunchResult(input: {
    binding: MissionLaunchBinding;
    result: AgentToolResult<Details>;
}): AgentToolResult<Details>;
export declare function readMissionBinding(asyncDir: string): MissionLaunchBinding | undefined;
export declare function syncMissionFromAsyncCompletion(value: unknown): MissionRecord | undefined;
//# sourceMappingURL=lifecycle.d.ts.map