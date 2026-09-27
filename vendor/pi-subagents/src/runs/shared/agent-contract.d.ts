import type { AgentContract, ExecutionProjection, ReviewProjection, SingleResult } from "../../shared/types.ts";
export declare function isAgentContract(contract: AgentContract | undefined): boolean;
export declare function buildExecutionProjection(result: Pick<SingleResult, "exitCode" | "error" | "interrupted" | "timedOut" | "stopped" | "detached">): ExecutionProjection;
export declare function buildReviewProjection(result: Pick<SingleResult, "acceptance">): ReviewProjection;
export declare function attachContractProjections<T extends SingleResult>(result: T): T;
//# sourceMappingURL=agent-contract.d.ts.map