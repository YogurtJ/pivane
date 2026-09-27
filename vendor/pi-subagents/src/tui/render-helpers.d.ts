import type { Theme } from "@earendil-works/pi-coding-agent";
export declare function fuzzyFilter<T extends {
    name: string;
    description: string;
    model?: string;
}>(items: T[], query: string): T[];
/** Remove a repeated job name from a child label when a safe separator follows it. */
export declare function stripRepeatedAgentPrefix(label: string, jobName: string | undefined): string;
/** Whether a status label may omit the one logical step marker. */
export declare function shouldSuppressSingleStep(chainStepCount?: number, stepsTotal?: number): boolean;
/** Add an Agent fraction only when visible candidates collide. */
export declare function withDuplicateLabelDiscriminators<T extends {
    index: number;
    displayName: string;
}>(rows: readonly T[], total: number): Array<T & {
    rowLabel: string;
}>;
export declare function pad(s: string, len: number): string;
export declare function row(content: string, width: number, theme: Theme): string;
export declare function renderHeader(text: string, width: number, theme: Theme): string;
export declare function formatPath(filePath: string): string;
export declare function formatScrollInfo(above: number, below: number): string;
export declare function renderFooter(text: string, width: number, theme: Theme): string;
//# sourceMappingURL=render-helpers.d.ts.map