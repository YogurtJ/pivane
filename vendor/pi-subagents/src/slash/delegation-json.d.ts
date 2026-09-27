export type BoundedJsonClone = {
    ok: true;
    value: unknown;
    encodedBytes: number;
} | {
    ok: false;
    reason: "invalid" | "too_large";
};
/** Clone plain JSON data without invoking getters or toJSON hooks. */
export declare function cloneJsonWithinByteLimit(input: unknown, maxBytes: number): BoundedJsonClone;
//# sourceMappingURL=delegation-json.d.ts.map