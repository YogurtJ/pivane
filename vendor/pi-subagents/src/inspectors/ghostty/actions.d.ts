import { type ExecFileOptionsWithStringEncoding } from "node:child_process";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Details } from "../../shared/types.ts";
import type { InspectorContext, InspectorLaunch, InspectorParams } from "../types.ts";
/** Static Ghostty 1.3 AppleScript; dynamic values arrive as `on run argv` arguments. */
export declare const GHOSTTY_APPLESCRIPT = "on run argv\n  set launchCommand to item 1 of argv\n  set launchCwd to item 2 of argv\n  set shouldFocus to item 3 of argv\n  tell application \"Ghostty\"\n    set sourceWindow to front window\n    set sourceTab to selected tab of sourceWindow\n    set sourceTerminal to focused terminal of sourceTab\n    set surfaceConfiguration to new surface configuration\n    set initial working directory of surfaceConfiguration to launchCwd\n    set command of surfaceConfiguration to launchCommand\n    set newTerminal to split sourceTerminal direction right with configuration surfaceConfiguration\n    if shouldFocus is \"true\" then\n      focus newTerminal\n    else\n      focus sourceTerminal\n    end if\n    return id of newTerminal\n  end tell\nend run";
export type GhosttyRunner = (args: readonly string[], options: ExecFileOptionsWithStringEncoding) => Promise<{
    stdout: string;
    stderr: string;
}>;
export declare function openGhosttyInspector(context: InspectorContext, launch: InspectorLaunch, params: InspectorParams, runner?: GhosttyRunner): Promise<AgentToolResult<Details>>;
//# sourceMappingURL=actions.d.ts.map