export type PermissionDecision = "allow" | "ask" | "deny";
export type PermissionRules = Record<string, PermissionDecision>;
export interface PermissionConfig {
    rules?: PermissionRules;
}
export declare function redactSecretValues(value: string): string;
export declare function validatePermissionRules(value: unknown, label: string): PermissionRules | undefined;
export declare function validatePermissionConfig(value: unknown, label?: string): PermissionConfig | undefined;
export declare function resolvePermissionRules(globalConfig?: PermissionConfig, agentRules?: PermissionRules): PermissionRules | undefined;
export declare function permissionDecision(rules: PermissionRules | undefined, toolName: string): PermissionDecision;
export declare function permissionArgsPreview(input: unknown): string;
export declare function appendPermissionAudit(filePath: string | undefined, record: Record<string, unknown>): void;
//# sourceMappingURL=permissions.d.ts.map