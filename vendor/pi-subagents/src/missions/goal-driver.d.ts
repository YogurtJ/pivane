import type { RetainedChild } from "../runs/background/retained-children.ts";
import type { ControlEvent } from "../shared/types.ts";
import type { MissionStoreLocation } from "./types.ts";
export interface GoalContinuationNotice {
    missionId: string;
    message: string;
    event: ControlEvent;
}
export declare function collectGoalContinuationNotices(input: {
    location: MissionStoreLocation;
    ownerSessionId: string;
    retainedChildren: RetainedChild[];
    turnId: number;
    now?: number;
}): GoalContinuationNotice[];
//# sourceMappingURL=goal-driver.d.ts.map