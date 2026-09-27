import type { RuntimeAcknowledgedChildExtensions } from "../../shared/types.ts";
export declare const RUNTIME_EXTENSION_ACK_EVENT = "subagent:acknowledge-extension";
export declare const MAX_RUNTIME_ACKNOWLEDGED_EXTENSION_IDS = 32;
export declare const MAX_RUNTIME_ACKNOWLEDGED_EXTENSION_ID_LENGTH = 128;
export declare function isRuntimeAcknowledgedExtensionId(value: unknown): value is string;
export declare function projectRuntimeAcknowledgedExtensions(ids: Iterable<unknown>): RuntimeAcknowledgedChildExtensions | undefined;
export declare function sanitizeRuntimeAcknowledgedExtensions(value: unknown): RuntimeAcknowledgedChildExtensions | undefined;
//# sourceMappingURL=runtime-acknowledged-extensions.d.ts.map