import type { AsyncStatus, NestedRunSummary } from "../../shared/types.ts";
export type AsyncStatusStep = NonNullable<AsyncStatus["steps"]>[number];
export interface ResolvedAsyncStatusChild {
    index: number;
    step: AsyncStatusStep;
    id: string;
    nested?: NestedRunSummary;
}
export type AsyncStatusChildResolution = {
    ok: true;
    child: ResolvedAsyncStatusChild;
} | {
    ok: false;
    code: "not_found" | "ambiguous";
    message: string;
};
export declare function asyncStatusChildIdentity(step: AsyncStatusStep, index: number): string;
export declare function asyncStatusChildIdentityCandidates(step: AsyncStatusStep, index: number): string[];
export declare function resolveAsyncStatusChild(status: Pick<AsyncStatus, "runId" | "steps">, childId: string, options?: {
    includeNested?: boolean;
}): AsyncStatusChildResolution;
export declare function isStoppableAsyncStatusStep(step: AsyncStatusStep): boolean;
export declare function stopStoppableAsyncStatusChildren(status: Pick<AsyncStatus, "steps">, stopChild: ((childId: string, message?: string) => boolean) | undefined, message: string): void;
//# sourceMappingURL=child-identity.d.ts.map