import type { AcceptanceConfig, AcceptanceInput, AgentContract, AcceptanceLedger, AcceptanceReport, AcceptanceReviewGate, AcceptanceRole, AcceptanceReviewResult, JsonSchemaObject, ResolvedAcceptanceConfig, SingleResult, SubagentRunMode, ChildWatchdogProgress } from "../../shared/types.ts";
export declare function normalizeAcceptanceInput(input: unknown): AcceptanceConfig;
export type ResolvedAcceptanceReportMode = "off" | "optional" | "required";
export declare function resolveAcceptanceReportMode(input: unknown): ResolvedAcceptanceReportMode;
type GateAcceptanceNormalizationResult = {
    ok: true;
    acceptance?: AcceptanceInput;
} | {
    ok: false;
    error: string;
};
export declare const GATE_INPUT_ERROR = "gate must be a non-empty command string or { command, output?: \"json\", schema?, timeoutMs? }.";
export interface GateObjectInput {
    command: string;
    output?: "json";
    schema?: JsonSchemaObject;
    timeoutMs?: number;
}
/** Validates the two accepted gate shapes without normalizing them. Shared by preflight and the workflow sandbox mirror. */
export declare function parseGateInput(gate: unknown): {
    ok: true;
    gate: GateObjectInput;
} | {
    ok: false;
    error: string;
};
/** True when an acceptance policy declares at least one `output: "json"` verify command, from either the gate shorthand or an explicit verify list. */
export declare function acceptanceHasTypedVerify(acceptance: AcceptanceInput | undefined): boolean;
export declare const TYPED_VERIFY_OUTPUT_SCHEMA_CONFLICT = "a typed verify command (output: \"json\") cannot be combined with outputSchema; the child would have two structured-output sources.";
export declare function normalizeGateAcceptance(gate: unknown, acceptance: AcceptanceInput | undefined): GateAcceptanceNormalizationResult;
export declare function describeGateAcceptanceConflict(gate: unknown, acceptance: unknown): string;
export declare function validateAcceptanceInput(input: unknown, pathLabel?: string): string[];
type ExecutionAcceptanceInput = {
    acceptance?: unknown;
    outputSchema?: unknown;
    tasks?: Array<{
        acceptance?: unknown;
        outputSchema?: unknown;
    }>;
    chain?: Array<{
        acceptance?: unknown;
        outputSchema?: unknown;
        parallel?: Array<{
            acceptance?: unknown;
            outputSchema?: unknown;
        }> | {
            acceptance?: unknown;
            outputSchema?: unknown;
        };
    }>;
};
export declare function validateExecutionAcceptancePolicy(input: ExecutionAcceptanceInput): string[];
export declare function validateExecutionAcceptance(input: ExecutionAcceptanceInput): string[];
export declare function resolveEffectiveAcceptance(input: {
    explicit?: AcceptanceInput;
    agentName: string;
    acceptanceRole?: AcceptanceRole;
    task?: string;
    mode?: SubagentRunMode;
    async?: boolean;
    dynamic?: boolean;
    dynamicGroup?: boolean;
    agentContract?: AgentContract;
}): ResolvedAcceptanceConfig;
/** Label a declared review gate the same way in prompts and capability summaries. */
export declare function formatReviewGateLabel(review: AcceptanceReviewGate): string;
export declare function formatAcceptancePrompt(acceptance: ResolvedAcceptanceConfig, options?: {
    reportOptional?: boolean;
    structuredOutput?: boolean;
}): string;
interface AcceptanceReportParseResult {
    report?: AcceptanceReport;
    error?: string;
    /** True when an acceptance-report signal was found but its envelope was invalid. */
    malformed?: boolean;
    sourcePath?: string;
}
export declare const ACCEPTANCE_REPORT_NOT_FOUND = "Structured acceptance report not found.";
export declare function parseAcceptanceReport(output: string): AcceptanceReportParseResult;
export declare function stripAcceptanceReport(output: string): string;
export declare function validateAcceptanceReport(value: unknown, pathLabel?: string): {
    report?: AcceptanceReport;
    errors: string[];
};
/** Capture the repository-wide index tree. Throws when Git cannot provide trustworthy evidence. */
export declare function captureStagedIndexBaseline(cwd: string): string;
export declare function aggregateAcceptanceReport(input: {
    results: Array<Pick<SingleResult, "agent" | "acceptance" | "error"> & {
        exitCode: number | null;
    }>;
    notes?: string;
}): AcceptanceReport;
/** The first typed verify result on a ledger, if any command produced one. */
export declare function typedVerifyOutput(ledger: AcceptanceLedger | undefined): {
    value: unknown;
} | undefined;
/**
 * On Windows with `shell: true`, cmd.exe parses the command line itself and an
 * unquoted executable path containing spaces (e.g. `C:\Program Files\...\tool.exe`)
 * is split at the first space, so cmd tries to run `C:\Program` and fails.
 *
 * The command line is ambiguous, so only an unquoted absolute drive path with
 * a space in a directory component is safe to identify as an executable. That
 * path is quoted; everything after it is preserved as arguments.
 *
 * Commands that already start with a quote, single-token commands, and commands
 * whose first token already ends in an executable extension are returned
 * unchanged. Non-Windows platforms pass the command through untouched.
 */
export declare function quoteExecutableForShell(command: string, platform?: string): string;
export declare function evaluateAcceptance(input: {
    acceptance: ResolvedAcceptanceConfig;
    output: string;
    cwd: string;
    /** Host-captured launch index tree; required by preserveStagedIndex. */
    stagedIndexBaseline?: string;
    /**
     * Content the child sent to its configured output file (from its own write
     * tool calls, not from disk, so a concurrent writer to the same path cannot
     * be misattributed). Searched for the acceptance report; searched before
     * the assistant output when `authoritative` (outputMode "file-only").
     */
    fileOutput?: {
        content: string;
        path: string;
        authoritative?: boolean;
        durable?: boolean;
    };
    report?: AcceptanceReport;
    reportError?: string;
    reviewResult?: AcceptanceReviewResult;
    signal?: AbortSignal;
    abortMessage?: string;
    reportOptional?: boolean;
    artifactsDir?: string;
    runId?: string;
    watchdog?: ChildWatchdogProgress;
}): Promise<AcceptanceLedger>;
export declare function buildSkippedAcceptanceLedger(acceptance: ResolvedAcceptanceConfig, input: {
    id: string;
    message: string;
}): AcceptanceLedger;
export declare function acceptanceFailureMessage(ledger: AcceptanceLedger): string | undefined;
export {};
//# sourceMappingURL=acceptance.d.ts.map