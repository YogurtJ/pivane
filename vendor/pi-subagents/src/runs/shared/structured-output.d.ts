import type { Message } from "@earendil-works/pi-ai";
import type { JsonSchemaObject } from "../../shared/types.ts";
import type { ResolvedAcceptanceReportMode } from "./acceptance.ts";
export declare const MISSING_STRUCTURED_OUTPUT_CALL_ERROR = "Missing structured_output call; this step has outputSchema and must finish by calling structured_output.";
export declare const MISSING_STRUCTURED_ACCEPTANCE_REPORT_ERROR = "Missing acceptanceReport in structured_output call; acceptance.report is \"on\".";
export declare const STRUCTURED_OUTPUT_REJECTION_ERROR = "structured_output was invoked but no valid output was captured.";
export declare const INVALID_STRUCTURED_OUTPUT_SCHEMA_ERROR = "Structured output invocation was rejected: invalid outputSchema.";
export declare const STRUCTURED_OUTPUT_VALIDATOR_UNAVAILABLE_ERROR = "Structured output invocation was rejected: validator unavailable.";
export declare const MAX_STRUCTURED_OUTPUT_REJECTION_ERROR_BYTES = 4096;
/** Returns bounded evidence from the latest failed structured_output result in a terminal transcript. */
export declare function formatStructuredOutputRejectionError(messages: readonly Message[]): string;
export interface StructuredOutputRuntime {
    schema: JsonSchemaObject;
    schemaPath: string;
    outputPath: string;
    acceptanceReportPath?: string;
    acceptanceReportRequired?: boolean;
}
export declare function createStructuredOutputToolParameters(schema: JsonSchemaObject, options?: {
    acceptanceReport?: "optional" | "required";
}): JsonSchemaObject;
interface CompiledJsonSchema {
    Check(value: unknown): boolean;
    Errors(value: unknown): Iterable<JsonSchemaValidationError>;
}
interface JsonSchemaValidationError {
    keyword?: string;
    schemaPath?: string;
    instancePath?: string;
    params?: {
        failingKeyword?: string;
        requiredProperties?: string[];
    };
    message?: string;
}
type CompileJsonSchema = (schema: unknown) => CompiledJsonSchema;
export declare function resolveCompileFromPackageRoot(packageRoot: string): Promise<CompileJsonSchema | undefined>;
export declare function assertJsonSchemaObject(schema: unknown, label?: string): asserts schema is JsonSchemaObject;
export declare function createStructuredOutputRuntime(schema: JsonSchemaObject, baseDir?: string, options?: {
    acceptanceReport?: ResolvedAcceptanceReportMode;
}): StructuredOutputRuntime;
export declare function validateStructuredOutputValue(schema: JsonSchemaObject, value: unknown): Promise<{
    status: "valid";
} | {
    status: "invalid";
    message: string;
}>;
export declare function readStructuredOutput(runtime: StructuredOutputRuntime): Promise<{
    value?: unknown;
    error?: string;
}>;
export declare function readStructuredOutputAcceptanceReport(runtime: StructuredOutputRuntime): {
    value?: unknown;
    error?: string;
};
/**
 * Capture callback that persists the structured output (and acceptance report)
 * to the runtime's files, for hosts that read the value back from disk.
 */
export declare function createStructuredOutputFileCapture(runtime: StructuredOutputRuntime): (value: unknown, acceptanceReport: unknown | undefined) => void;
export declare function clearStructuredOutputCaptures(runtime: StructuredOutputRuntime): string | undefined;
export declare function cleanupStructuredOutputRuntime(runtime: StructuredOutputRuntime | undefined): void;
export {};
//# sourceMappingURL=structured-output.d.ts.map