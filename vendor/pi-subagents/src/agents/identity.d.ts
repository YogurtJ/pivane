import type { AgentConfig, ChainConfig } from "./agents.ts";
export declare function parsePackageName(value: unknown, label?: string): {
    packageName?: string;
    error?: string;
};
export declare function buildRuntimeName(localName: string, packageName?: string): string;
export declare function frontmatterNameForConfig(config: Pick<AgentConfig | ChainConfig, "name" | "localName" | "packageName">): string;
//# sourceMappingURL=identity.d.ts.map