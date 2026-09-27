import type { MissionStoreLocation } from "./types.ts";
export declare const MISSION_STATE_MAX_BYTES: number;
export interface MissionWorkflowState {
    path: string;
    get(key: string): unknown;
    set(key: string, value: unknown): void;
}
export interface MissionWorkflowStateOptions {
    isProcessAlive?: (pid: number) => boolean;
    getProcessStartKey?: (pid: number) => string | undefined;
    retryDelaysMs?: readonly number[];
}
export declare function missionStatePath(location: MissionStoreLocation, missionId: string): string;
export declare function createMissionWorkflowState(location: MissionStoreLocation, missionId: string, options?: MissionWorkflowStateOptions): MissionWorkflowState;
//# sourceMappingURL=workflow-state.d.ts.map