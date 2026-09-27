import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChildRuntimeConfig } from "../runs/shared/child-runtime-config.ts";
import { type SubagentState } from "../shared/types.ts";
export declare function createChildSafeState(): SubagentState;
/** Register delegation and supervisor replies for fanout-authorized children. */
export default function registerFanoutChildSubagentExtension(pi: ExtensionAPI, childConfig: ChildRuntimeConfig): void;
//# sourceMappingURL=fanout-child.d.ts.map