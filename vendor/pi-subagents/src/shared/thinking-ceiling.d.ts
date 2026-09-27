import { type ThinkingLevel } from "./model-info.ts";
export type { ThinkingLevel } from "./model-info.ts";
export declare function parseThinkingLevel(value: unknown, field?: string): ThinkingLevel;
export declare function compareThinkingLevels(left: ThinkingLevel, right: ThinkingLevel): number;
export declare function intersectThinkingCeilings(...ceilings: Array<ThinkingLevel | undefined>): ThinkingLevel | undefined;
export interface ThinkingCeilingCheck {
    model?: string;
    configThinking?: string | false;
    ceiling?: ThinkingLevel;
    agent?: string;
    runId?: string;
}
export declare function assertThinkingWithinCeiling(input: ThinkingCeilingCheck): void;
//# sourceMappingURL=thinking-ceiling.d.ts.map