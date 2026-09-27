import type { DynamicParallelStep, ParallelTaskItem } from "../../shared/settings.ts";
import type { ArtifactPaths, ChainOutputMap, JsonSchemaObject, SingleResult } from "../../shared/types.ts";
export declare class DynamicFanoutError extends Error {
}
export interface DynamicFanoutConfig {
    maxItems?: number;
    allowRunnerFields?: boolean;
}
export interface DynamicMaterializedItem {
    index: number;
    key: string;
    idKey: string;
    item: unknown;
}
export interface DynamicCollectedResult {
    key: string;
    index: number;
    item: unknown;
    agent: string;
    exitCode: number | null;
    text: string;
    structured?: unknown;
    error?: string;
    timedOut?: boolean;
    stopped?: boolean;
    outputPath?: string;
    artifactPaths?: ArtifactPaths;
}
export interface DynamicMaterializedGroup {
    items: DynamicMaterializedItem[];
    parallel: ParallelTaskItem[];
    collectedOnEmpty?: DynamicCollectedResult[];
}
export declare function isSafeOutputName(name: string): boolean;
export declare function assertJsonPointer(pointer: string, label: string): void;
export declare function resolveJsonPointer(value: unknown, pointer: string, label: string): unknown;
export declare function normalizeItemKeyForId(key: string): string;
export declare function resolveItemTemplate(template: string, itemName: string, item: unknown): string;
export declare function assertNoUnresolvedItemReferences(template: string, itemName: string, label: string): void;
export declare function hasDynamicFanoutFields(step: unknown): boolean;
export declare function validateDynamicStepShape(step: DynamicParallelStep, stepIndex: number, config?: DynamicFanoutConfig): void;
export declare function resolveDynamicFanoutItems(step: DynamicParallelStep, outputs: ChainOutputMap, stepIndex: number, config?: DynamicFanoutConfig): DynamicMaterializedItem[];
export declare function materializeDynamicParallelStep(step: DynamicParallelStep, outputs: ChainOutputMap, stepIndex: number, config?: DynamicFanoutConfig): DynamicMaterializedGroup;
export declare function collectDynamicResults(step: DynamicParallelStep, items: DynamicMaterializedItem[], results: Array<Pick<SingleResult, "agent" | "error" | "timedOut" | "stopped" | "structuredOutput" | "artifactPaths" | "savedOutputPath"> & {
    exitCode: number | null;
    output?: string;
    finalOutput?: string;
}>): DynamicCollectedResult[];
export declare function validateDynamicCollection(schema: JsonSchemaObject | undefined, value: DynamicCollectedResult[]): Promise<void>;
//# sourceMappingURL=dynamic-fanout.d.ts.map