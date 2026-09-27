import { type GlobalMissionListResult, type MissionCreateInput, type MissionListResult, type MissionRecord, type MissionStoreConfig, type MissionStoreLocation, type MissionUpdateInput } from "./types.ts";
export declare function validateMissionId(value: unknown, label?: string): string;
export declare function parseMissionRecord(value: unknown, source?: string): MissionRecord;
export declare function validateMissionStoreConfig(value: unknown, label?: string): MissionStoreConfig | undefined;
export declare function resolveMissionStoreLocation(input: {
    projectRoot: string;
    config?: MissionStoreConfig;
    agentDir?: string;
}): MissionStoreLocation;
export declare function missionRecordPath(location: MissionStoreLocation, missionId: string): string;
export declare function createMission(location: MissionStoreLocation, input: MissionCreateInput, now?: Date, retainTerminal?: number): MissionRecord;
export declare class MissionNotFoundError extends Error {
    readonly code = "MISSION_NOT_FOUND";
    readonly missionId: string;
    readonly missionDir: string;
    constructor(missionId: string, location: MissionStoreLocation);
}
export declare function readMission(location: MissionStoreLocation, missionId: string): MissionRecord;
export declare function listMissions(location: MissionStoreLocation): MissionListResult;
export declare function updateMission(location: MissionStoreLocation, missionId: string, update: MissionUpdateInput, now?: Date, retainTerminal?: number): MissionRecord;
export declare function listGlobalMissions(globalIndexDir: string): GlobalMissionListResult;
//# sourceMappingURL=store.d.ts.map