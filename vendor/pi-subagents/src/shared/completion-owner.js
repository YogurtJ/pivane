import { randomUUID } from "node:crypto";
const COMPLETION_OWNER_KEY = Symbol.for("pi-subagents.completion-owner-id");
/** Stable for one parent Pi process across extension reloads. */
export function currentCompletionOwnerId() {
    const runtime = globalThis;
    runtime[COMPLETION_OWNER_KEY] ??= randomUUID();
    return runtime[COMPLETION_OWNER_KEY];
}
//# sourceMappingURL=completion-owner.js.map