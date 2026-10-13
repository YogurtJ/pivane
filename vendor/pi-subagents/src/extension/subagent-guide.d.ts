export declare const SUBAGENT_GUIDE_TOPICS: readonly ["overview", "workflows", "agents", "missions", "observability", "tool-reference", "configuration", "models", "watchdog", "extension-api", "council"];
export type SubagentGuideTopic = (typeof SUBAGENT_GUIDE_TOPICS)[number];
/** Reads a guide topic. Docs-backed topics return their intro and table of contents; `topic/section` returns one section. */
export declare function readSubagentGuide(topic?: string, root?: string): string;
//# sourceMappingURL=subagent-guide.d.ts.map