/** Hard cap on the final name so host UI rows stay one line. */
export declare const CHILD_SESSION_NAME_MAX_CHARS = 80;
export declare function deriveChildSessionName(input: {
    agent?: string;
    task?: string;
    /** Workflow node label; preferred over the task excerpt when present. */
    label?: string;
}): string | undefined;
//# sourceMappingURL=child-session-name.d.ts.map