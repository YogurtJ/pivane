import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import { type ExternalRun } from "../api/external-runs.ts";
import { type FleetKeybindingAction, type FleetKeybindingsConfig, type ForegroundChildControl, type ForegroundResumeChild, type ForegroundResumeRun, type ForegroundRunControl, type SubagentState } from "../shared/types.ts";
import { type AsyncRunSummary } from "../runs/background/async-status.ts";
import type { SteerDeliveryMode } from "../runs/background/control-channel.ts";
import type { InspectorPlugin } from "../inspectors/types.ts";
export declare const DEFAULT_FLEET_KEYBINDINGS: Record<FleetKeybindingAction, string[]>;
type ResolvedFleetKeybindings = Record<FleetKeybindingAction, string[]>;
export declare function resolveFleetKeybindings(config: FleetKeybindingsConfig | undefined): ResolvedFleetKeybindings;
type Theme = ExtensionContext["ui"]["theme"];
type FleetTui = {
    terminal?: {
        rows: number;
    };
    requestRender(): void;
};
type AsyncStep = AsyncRunSummary["steps"][number];
export type FleetItem = ({
    key: string;
    kind: "foreground-active";
    runId: string;
    index?: number;
    agent: string;
    state: "running";
    updatedAt: number;
    control: ForegroundRunControl;
    activeChild?: ForegroundChildControl;
} | {
    key: string;
    kind: "foreground-recent";
    runId: string;
    index: number;
    agent: string;
    state: ForegroundResumeChild["status"];
    updatedAt: number;
    run: ForegroundResumeRun;
    child: ForegroundResumeChild;
} | {
    key: string;
    kind: "async";
    runId: string;
    index?: number;
    agent: string;
    state: string;
    updatedAt: number;
    run: AsyncRunSummary;
    step?: AsyncStep;
} | {
    key: string;
    kind: "external";
    runId: string;
    agent: string;
    state: ExternalRun["state"];
    updatedAt: number;
    run: ExternalRun;
}) & {
    description?: string;
};
export interface FleetSnapshot {
    items: FleetItem[];
    error?: string;
}
export interface FleetActionResult {
    text: string;
    isError?: boolean;
}
export interface FleetActionHandlers {
    steer(input: {
        runId: string;
        asyncDir: string;
        index?: number;
        message: string;
        mode: SteerDeliveryMode;
    }): Promise<FleetActionResult>;
    stop(input: {
        runId: string;
        asyncDir: string;
        index?: number;
    }): Promise<FleetActionResult> | FleetActionResult;
    inspect?(input: {
        runId: string;
        asyncDir: string;
        index?: number;
    }): Promise<FleetActionResult>;
    redoPrompt?(input: {
        runId: string;
        index: number;
        guidance: string;
        control?: ForegroundRunControl;
    }): Promise<FleetActionResult>;
}
export interface FleetViewOptions {
    asyncDirRoot?: string;
    resultsDir?: string;
    refreshMs?: number;
    initialKey?: string;
    markdownTheme?: MarkdownTheme;
    fleetKeybindings?: FleetKeybindingsConfig;
    actions?: FleetActionHandlers;
    copyText?: (text: string) => Promise<void> | void;
    inspectorPlugins?: () => readonly InspectorPlugin[];
    inspectorEnv?: NodeJS.ProcessEnv;
}
export declare function collectFleetSnapshot(state: SubagentState, options?: {
    asyncDirRoot?: string;
    resultsDir?: string;
    limit?: number;
}): FleetSnapshot;
export declare class SubagentFleetComponent implements Component {
    private snapshot;
    private selected;
    private selectedKey;
    private detailScroll;
    private detailAutoFollow;
    private detailLineCount;
    private detailViewportHeight;
    private bodyHeight;
    private expandedTools;
    private promptAuditOpen;
    private promptAuditView;
    private actionNotice;
    private steerDraft;
    private redoGuidanceDraft;
    private steerMode;
    private stopConfirming;
    private actionBusy;
    private transcriptCache;
    private disposed;
    private refreshTimer;
    private readonly refreshMs;
    private readonly tui;
    private readonly theme;
    private readonly markdownTheme;
    private readonly state;
    private readonly done;
    private readonly options;
    private readonly keybindings;
    constructor(tui: FleetTui, theme: Theme, state: SubagentState, done: (result: undefined) => void, options?: FleetViewOptions);
    private scheduleRefresh;
    private stopRefresh;
    private refresh;
    private moveSelection;
    private selectedPromptAudit;
    private promptAuditItems;
    private selectedPromptText;
    private movePromptSelection;
    private resetActionInput;
    private selectedAsyncAction;
    private selectedSteerAction;
    private selectedInspectAction;
    private inspectSelected;
    private actionLines;
    private withActionLines;
    private setActionNotice;
    private runAction;
    private scrollDetail;
    handleInput(data: string): void;
    private rosterLines;
    private renderedTranscript;
    private promptAuditDetail;
    private wrappedDetail;
    render(width: number): string[];
    invalidate(): void;
    dispose(): void;
}
export declare function openSubagentFleet(ctx: ExtensionContext, state: SubagentState, options?: FleetViewOptions): Promise<void>;
export {};
//# sourceMappingURL=fleet.d.ts.map