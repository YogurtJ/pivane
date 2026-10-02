import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "../shared/model-info.ts";
type Theme = Pick<ExtensionContext["ui"]["theme"], "fg" | "getThinkingBorderColor">;
/** Registers where the main session's current thinking level is read; glyphs that stand for several children take its color. */
export declare function setMainThinkingLevelSource(source: () => ThinkingLevel | undefined): void;
/** Reads the main session's level through `read`; a stale or not-yet-bound Pi runtime has no level to show. */
export declare function readMainThinkingLevel(read: () => ThinkingLevel): ThinkingLevel | undefined;
/** The running tone of a glyph: Pi's prompt-box color for the recorded level of the one child it stands for, else for the main session's current level, else accent. */
export declare function runningTone(theme: Theme, childLevel?: ThinkingLevel): (text: string) => string;
export {};
//# sourceMappingURL=running-tone.d.ts.map