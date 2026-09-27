import type { ExternalCliReceiptMetadata, ExternalCliCapabilityNarrowing, ExternalCliRunnerStatus, ExternalProcessStatus, HerdrMachineReference } from "../../shared/types.ts";
export declare const CODE_OWNED_EXTERNAL_CLI_ADAPTER_IDS: readonly ["codex-exec", "codex-exec-writer", "claude-code", "claude-code-writer", "cursor-agent", "cursor-agent-writer"];
export type CodeOwnedExternalCliAdapterId = typeof CODE_OWNED_EXTERNAL_CLI_ADAPTER_IDS[number];
export declare const CODE_OWNED_EXTERNAL_CLI_ADAPTER_LABEL: string;
export declare function isCodeOwnedExternalCliAdapterId(value: unknown): value is CodeOwnedExternalCliAdapterId;
export declare function validateCodeOwnedProfileRunner(agent: {
    name: string;
    localName?: string;
    aliases?: readonly string[];
    runner?: {
        type: string;
        adapter?: string;
    };
}): string | undefined;
export declare function parseExternalCliCapabilityNarrowing(value: unknown, label: string): ExternalCliCapabilityNarrowing | undefined;
export declare function resolveExternalCliRunnerStatus(input: {
    adapter?: CodeOwnedExternalCliAdapterId;
    command: string;
    args?: string[];
    promptDelivery?: "stdin";
    capabilities?: ExternalCliCapabilityNarrowing;
    machine?: HerdrMachineReference;
}): ExternalCliRunnerStatus;
export declare function normalizeExternalCliRunnerStatus(value: unknown): ExternalCliRunnerStatus | undefined;
export declare function externalCliReceiptMetadata(input: {
    runner: ExternalCliRunnerStatus;
    externalProcess?: ExternalProcessStatus;
    outputReference?: string;
}): ExternalCliReceiptMetadata;
//# sourceMappingURL=external-cli-contract.d.ts.map