import type { AsyncParallelGroupStatus } from "../../shared/types.ts";
export declare function normalizeParallelGroups(groups: unknown, stepCount: number, chainStepCount: number): AsyncParallelGroupStatus[];
export declare function flatToLogicalStepIndex(flatIndex: number, chainStepCount: number, groups: AsyncParallelGroupStatus[]): number;
//# sourceMappingURL=parallel-groups.d.ts.map