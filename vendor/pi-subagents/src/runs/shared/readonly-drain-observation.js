const knownStates = new Set(["queued", "running", "complete", "failed", "partial", "paused", "stopped", "rejected"]);
/**
 * Private, installation-owned evidence. Never changes drain/query behavior or retains statuses.
 * Observes the ordinary indexed drain, not historical ownership or outside work appearing later.
 */
export class ReadonlyDrainObservation {
    state = "pending";
    started = false;
    first = false;
    file;
    guard;
    constructor(file, guard) { this.file = file; this.guard = guard; }
    deny() { this.state = "denied"; }
    check() {
        try {
            if (!this.guard())
                this.deny();
        }
        catch {
            this.deny();
        }
        return this.state !== "denied";
    }
    begin(file, native) {
        if (this.started || file !== this.file || !native)
            this.deny();
        this.started = true;
        this.check();
    }
    /** Called at the existing initial read, before reconciliation or filtering. */
    status = (status) => {
        if (!status || typeof status.sessionId !== "string" || !status.sessionId
            || !knownStates.has(status.state))
            this.deny();
        else if (status.sessionId === this.file && (status.state === "queued" || status.state === "running"))
            this.deny();
    };
    predicate(hasWork) {
        if (this.first)
            return;
        this.first = true;
        if (hasWork)
            this.deny();
    }
    complete() {
        if (this.started && this.first && this.check())
            this.state = "empty";
    }
    settled() { return this.check() && this.state === "empty"; }
}
//# sourceMappingURL=readonly-drain-observation.js.map