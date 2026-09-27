import { type SubagentState } from "../../shared/types.ts";
import { type AsyncRunLocation } from "./async-resume.ts";
import { type NestedRunMatch, type NestedRunResolutionScope } from "../shared/nested-events.ts";
export type ResolvedSubagentRunId = {
    kind: "foreground";
    id: string;
} | {
    kind: "async";
    id: string;
    location: AsyncRunLocation;
} | {
    kind: "nested";
    id: string;
    match: NestedRunMatch;
};
export interface ResolveSubagentRunIdDeps {
    state?: SubagentState;
    asyncDirRoot?: string;
    resultsDir?: string;
    nested?: NestedRunResolutionScope;
}
export declare function resolveSubagentRunId(id: string, deps?: ResolveSubagentRunIdDeps): ResolvedSubagentRunId | undefined;
//# sourceMappingURL=run-id-resolver.d.ts.map