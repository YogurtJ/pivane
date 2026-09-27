export interface WatchdogScopeEntry {
    prompt: string;
    createdAt: string;
}
export declare class WatchdogScopeArtifact {
    private entries;
    addPrompt(prompt: string, options?: {
        createdAt?: string;
    }): void;
    reset(): void;
    snapshot(): WatchdogScopeEntry[];
    render(): string;
    private trim;
}
//# sourceMappingURL=scope.d.ts.map