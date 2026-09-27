import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Details } from "../shared/types.ts";
import { type MissionArtifact, type MissionReceipt, type MissionStatus, type MissionStoreConfig, type MissionTokenBudget } from "./types.ts";
export declare const MISSION_ACTIONS: readonly ["mission.create", "mission.list", "mission.show", "mission.update", "mission.resolve-decision", "mission.attach-run", "mission.close"];
export type MissionAction = typeof MISSION_ACTIONS[number];
export interface MissionLaunchInput {
    title: string;
    objective?: string;
    goal?: true;
    budget?: MissionTokenBudget;
    labels?: string[];
}
export interface MissionUpdateToolInput {
    title?: string;
    objective?: string;
    goal?: boolean | {
        paused: boolean;
    };
    budget?: MissionTokenBudget;
    status?: MissionStatus;
    summary?: string;
    labels?: string[];
    artifacts?: MissionArtifact[];
    receipts?: Array<Omit<MissionReceipt, "createdAt">>;
    decisions?: Array<{
        title: string;
        prompt?: string;
        options?: string[];
        recommendation?: string;
    }>;
}
export interface MissionActionParams {
    missionId?: string;
    mission?: unknown;
    missionUpdate?: unknown;
    missionStatus?: string;
    missionScope?: string;
    id?: string;
    runId?: string;
    dir?: string;
    runMode?: string;
    runStatus?: string;
    agent?: string;
    summary?: string;
}
interface MissionActionContext {
    cwd: string;
    currentSessionId?: string;
    config?: MissionStoreConfig;
    agentDir?: string;
}
export declare function validateMissionLaunch(value: unknown): MissionLaunchInput;
export declare function handleMissionAction(action: MissionAction, params: MissionActionParams, ctx: MissionActionContext): AgentToolResult<Details>;
export {};
//# sourceMappingURL=actions.d.ts.map