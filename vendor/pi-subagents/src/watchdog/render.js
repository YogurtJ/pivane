import { Container, Spacer, Text } from "@earendil-works/pi-tui";
function titleCase(value) {
    return value.split("-").map((part) => part ? `${part[0]?.toUpperCase()}${part.slice(1)}` : part).join(" ");
}
function stateLabels(warning) {
    const labels = [];
    if (warning.state === "displayed")
        labels.push("displayed");
    if (warning.stale || warning.state === "stale")
        labels.push("stale");
    if (warning.state === "failed")
        labels.push("failed review");
    if (warning.state === "stalemate")
        labels.push("stalemate");
    return labels;
}
export function formatWatchdogWarningRenderText(warning) {
    const labels = stateLabels(warning);
    const subject = warning.severity === "blocker" ? "Blocker" : "Concern";
    const lines = [
        `Subagent watchdog ${subject}${labels.length ? ` (${labels.join(", ")})` : ""}: ${warning.summary}`,
        `Evidence: ${warning.evidence}`,
        `Recommended action: ${warning.recommendedAction}`,
        `Importance: ${titleCase(warning.importance)} · Category: ${titleCase(warning.category)} · Source: ${warning.source}${warning.agent ? ` · Agent: ${warning.agent}` : ""}${warning.runId ? ` · Run: ${warning.runId}` : ""}`,
    ];
    if (warning.state === "failed" && warning.error)
        lines.push(`Failure: ${warning.error}`);
    if (warning.state === "stalemate" && warning.stalemateRepeats !== undefined) {
        lines.push(`Same warning ${warning.stalemateRepeats} time${warning.stalemateRepeats === 1 ? "" : "s"} in a row; the watchdog stopped continuing the run.`);
    }
    if (warning.stale || warning.state === "stale")
        lines.push("This warning arrived after the watchdog catch-up timeout.");
    return lines.join("\n");
}
export function renderWatchdogWarning(warning, options, theme) {
    const text = formatWatchdogWarningRenderText(warning);
    const lines = text.split("\n");
    const container = new Container();
    const color = warning.severity === "blocker" ? "error" : "warning";
    const bold = theme.bold ?? ((value) => value);
    container.addChild(new Text(theme.fg(color, bold(lines[0] ?? "Subagent watchdog warning")), 0, 0));
    if (options.expanded) {
        container.addChild(new Spacer(1));
        for (const line of lines.slice(1))
            container.addChild(new Text(theme.fg("dim", line), 0, 0));
    }
    else if (lines[1]) {
        container.addChild(new Text(theme.fg("dim", `  ⎿  ${lines[1]}`), 0, 0));
    }
    return container;
}
//# sourceMappingURL=render.js.map