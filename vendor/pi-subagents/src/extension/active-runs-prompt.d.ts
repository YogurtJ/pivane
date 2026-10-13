import type { AsyncJobState } from "../shared/types.ts";
/**
 * The `active_subagents` prompt section: one line per queued or running background run of this session.
 * Pi diffs prompt sections every turn, so it holds only fields that stay the same while a run is unchanged.
 * Task text is not available here: launch events carry it redacted.
 */
export declare function buildActiveRunsSection(jobs: Iterable<AsyncJobState>, sessionId: string | null | undefined): string | undefined;
//# sourceMappingURL=active-runs-prompt.d.ts.map