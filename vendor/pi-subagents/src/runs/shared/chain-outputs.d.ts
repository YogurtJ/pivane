import { type ChainStep } from "../../shared/settings.ts";
import type { ChainOutputMap, ChainOutputMapEntry, SingleResult } from "../../shared/types.ts";
import { type DynamicFanoutConfig } from "./dynamic-fanout.ts";
export declare class ChainOutputValidationError extends Error {
}
export interface ChainOutputValidationContext {
    priorOutputNames?: Iterable<string>;
    startStepIndex?: number;
}
export declare function validateChainOutputBindings(steps: ChainStep[], dynamicFanoutConfig?: DynamicFanoutConfig): void;
export declare function validateChainOutputBindingsWithContext(steps: ChainStep[], dynamicFanoutConfig?: DynamicFanoutConfig, context?: ChainOutputValidationContext): void;
export declare function resolveOutputReferences(template: string, outputs: ChainOutputMap): string;
export declare function outputEntryFromResult(result: SingleResult, stepIndex: number): ChainOutputMapEntry;
export declare function outputEntryFromAsyncResult(result: {
    agent: string;
    output: string;
    structuredOutput?: unknown;
}, stepIndex: number): ChainOutputMapEntry;
//# sourceMappingURL=chain-outputs.d.ts.map