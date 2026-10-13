import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import type { DisabledFeatureSurface } from "../shared/disabled-features.ts";
/**
 * Lowers a model tool call's `options` into the flat params the executor reads.
 * Management fields given at the top level keep working, as in the flat shape older sessions declared.
 */
export declare function flattenSubagentToolOptions(params: Record<string, unknown>, disabled?: DisabledFeatureSurface): SubagentParamsLike;
//# sourceMappingURL=subagent-options.d.ts.map