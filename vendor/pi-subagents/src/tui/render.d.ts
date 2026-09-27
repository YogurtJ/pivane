/**
 * Rendering functions for subagent results
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component } from "@earendil-works/pi-tui";
import { type AsyncJobState, type AsyncJobStep, type Details, type MainWindowRendererConfig } from "../shared/types.ts";
type Theme = ExtensionContext["ui"]["theme"];
export declare function liveDetailHintText(): string;
/**
 * Truncate a line to maxWidth, preserving ANSI styling through the ellipsis.
 *
 * pi-tui's truncateToWidth adds \x1b[0m before ellipsis which resets all styling,
 * causing background color bleed in the TUI. This implementation tracks active
 * ANSI styles and re-applies them before the ellipsis.
 *
 * Uses Intl.Segmenter for proper Unicode/emoji handling (not char-by-char).
 */
export declare function truncLine(text: string, maxWidth: number): string;
interface LegacyResultAnimationContext {
    state: {
        subagentResultAnimationTimer?: ReturnType<typeof setInterval>;
    };
}
export declare function clearLegacyResultAnimationTimer(context: LegacyResultAnimationContext): void;
export declare function compactTaskText(task: string | undefined, label?: string): string | undefined;
export interface AsyncLaneProjection {
    label?: string;
    role: string;
    phase?: string;
    state: AsyncJobState["status"] | AsyncJobStep["status"];
    gate?: string;
    next?: string;
    output?: string;
    workspace?: string;
    ref: string;
    chips: string[];
}
/** Project already-loaded async status facts into one bounded, render-only lane row. */
export declare function projectAsyncLane(job: AsyncJobState, ...args: [selectedStep?: AsyncJobStep]): AsyncLaneProjection | undefined;
export declare function widgetRenderKey(job: AsyncJobState, expanded?: boolean): string;
/** Structural identity of the workflow rows that Fleet can cover. */
export declare function inlineWorkflowRenderKey(job: AsyncJobState, children: AsyncJobState[]): string;
/** Presentation-only coverage from the mounted inline Fleet roster, never configuration. */
export declare function setInlineWorkflowCoverage(ui: ExtensionContext["ui"], coverage: ReadonlyMap<string, string>): void;
export declare function buildWidgetLines(jobs: AsyncJobState[], theme: Theme, width?: number, expanded?: boolean, frame?: number): string[];
/**
 * Render the async jobs widget
 */
export declare function renderWidget(ctx: ExtensionContext, jobs: AsyncJobState[]): void;
export declare function renderSubagentSummary(result: AgentToolResult<Details>, options: {
    isPartial?: boolean;
}, theme: Theme): Component;
/**
 * Render a subagent result
 */
export declare function renderSubagentResult(result: AgentToolResult<Details>, options: {
    expanded: boolean;
}, theme: Theme, frame?: number, rendererConfig?: MainWindowRendererConfig, foregroundDetachShortcut?: string): Component;
export {};
//# sourceMappingURL=render.d.ts.map