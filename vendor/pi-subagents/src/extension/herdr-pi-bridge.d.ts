import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export declare function resolveRemoteHerdrResources(cwd: string, resources: {
    agent: string;
    skills?: string[];
    toolCeiling?: string[];
    reads?: string[] | false;
}, remoteDefaultTools?: string[]): {
    agent: string;
    skills: string[];
    tools: string[];
    systemPrompt: string;
    inheritProjectContext: boolean;
    inheritGlobalContext: boolean;
    inheritSkills: boolean;
};
export default function registerHerdrPiBridge(pi: ExtensionAPI): void;
//# sourceMappingURL=herdr-pi-bridge.d.ts.map