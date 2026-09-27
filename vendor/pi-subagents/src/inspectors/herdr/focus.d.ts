import type { HerdrClient, HerdrErrorCode } from "./client.ts";
export type HerdrFocusErrorCode = HerdrErrorCode | "PANE_FOCUS_UNSUPPORTED" | "INVALID_PANE_RESPONSE";
export type HerdrPaneFocusResult = {
    ok: true;
    data: {
        paneId: string;
        tabId?: string;
        workspaceId?: string;
    };
} | {
    ok: false;
    error: {
        code: HerdrFocusErrorCode;
        message: string;
        details?: unknown;
    };
};
export declare function herdrPaneRecord(value: unknown): Record<string, unknown> | undefined;
export declare function herdrPaneFocusTarget(value: unknown): {
    paneId?: string;
    tabId?: string;
    workspaceId?: string;
};
export declare function focusHerdrPane(client: HerdrClient, paneId: string, signal?: AbortSignal): Promise<HerdrPaneFocusResult>;
//# sourceMappingURL=focus.d.ts.map