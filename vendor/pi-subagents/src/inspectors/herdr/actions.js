import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.js";
import { detectHerdr } from "./client.js";
export function bindingPath(asyncDir, index) {
    return path.join(asyncDir, "inspectors", `herdr${index === undefined ? "" : `-${index}`}.json`);
}
function parse(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const binding = value;
    if (binding.schemaVersion !== 1
        || binding.kind !== "herdr-inspector"
        || (binding.childIndex !== undefined && (!Number.isInteger(binding.childIndex) || binding.childIndex < 0))
        || typeof binding.runId !== "string"
        || typeof binding.asyncDir !== "string"
        || typeof binding.paneId !== "string"
        || typeof binding.openedAt !== "string"
        || typeof binding.command !== "string")
        return undefined;
    return binding;
}
export function readHerdrInspectorBinding(asyncDir, index) {
    try {
        return parse(JSON.parse(fs.readFileSync(bindingPath(asyncDir, index), "utf8")));
    }
    catch {
        return undefined;
    }
}
/** Read a binding only when it belongs to the requested inspector target. */
export function readHerdrInspectorBindingForTarget(target) {
    const binding = readHerdrInspectorBinding(target.asyncDir, target.index);
    if (!binding || binding.runId !== target.runId || binding.childIndex !== target.index)
        return undefined;
    try {
        if (fs.realpathSync(binding.asyncDir) !== fs.realpathSync(target.asyncDir))
            return undefined;
    }
    catch {
        return undefined;
    }
    return binding;
}
function result(text, isError = false) {
    return {
        content: [{ type: "text", text }],
        ...(isError ? { isError: true } : {}),
        details: { mode: "management", results: [] },
    };
}
function errorText(input) {
    return `Herdr inspector error (${input.code}): ${input.message}`;
}
function paneId(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const record = value;
    const pane = record.pane && typeof record.pane === "object" ? record.pane : record;
    for (const key of ["pane_id", "paneId", "id"]) {
        if (typeof pane[key] === "string")
            return pane[key];
    }
    return undefined;
}
async function pane(client, id, signal) {
    return client.run(["pane", "get", id], { timeoutMs: 5_000, signal });
}
export async function openHerdrInspector(context, launch, params, client) {
    const detected = await detectHerdr(client, context.signal);
    if (!detected.ok)
        return result(errorText(detected.error), true);
    const existing = readHerdrInspectorBindingForTarget(context.target);
    if (existing) {
        const current = await pane(client, existing.paneId, context.signal);
        if (current.ok && paneId(current.data) === existing.paneId) {
            return result(`Herdr inspector pane ${existing.paneId} is already open for async run ${context.target.runId}.${params.focus ? " Herdr cannot refocus an arbitrary raw pane id; select it in the Herdr UI." : ""}`);
        }
    }
    const split = await client.run([
        "pane", "split", "--current", "--direction", "right",
        "--cwd", context.target.status.cwd ?? context.cwd,
        params.focus === true ? "--focus" : "--no-focus",
    ], { timeoutMs: 15_000, signal: context.signal });
    if (!split.ok)
        return result(errorText(split.error), true);
    const id = paneId(split.data);
    if (!id)
        return result("Herdr inspector error (PANE_GONE): pane split returned no pane id.", true);
    const started = await client.run(["pane", "run", id, launch.displayCommand], { timeoutMs: 15_000, signal: context.signal });
    if (!started.ok) {
        await client.run(["pane", "close", id], { timeoutMs: 5_000 });
        return result(errorText(started.error), true);
    }
    const now = (context.now?.() ?? new Date()).toISOString();
    const binding = {
        schemaVersion: 1,
        kind: "herdr-inspector",
        runId: context.target.runId,
        asyncDir: context.target.asyncDir,
        ...(context.target.index === undefined ? {} : { childIndex: context.target.index }),
        ...(launch.mission ? { missionId: launch.mission.id, missionPath: launch.mission.path } : {}),
        paneId: id,
        openedAt: now,
        ...(params.focus === true ? { lastFocusedAt: now } : {}),
        herdrVersion: detected.data.versionText,
        command: launch.displayCommand,
    };
    writeAtomicJson(bindingPath(context.target.asyncDir, context.target.index), binding);
    return result(`Opened read-only Herdr inspector pane ${id} for async run ${context.target.runId}. Closing the pane does not stop the run.\nControls inside the pane: steer <message>, stop, status.`);
}
export async function statusHerdrInspector(context, client) {
    const binding = readHerdrInspectorBindingForTarget(context.target);
    if (!binding) {
        return result(`No Herdr inspector binding exists for async run ${context.target.runId}${context.target.index === undefined ? "" : ` child ${context.target.index}`}.`);
    }
    const live = await pane(client, binding.paneId, context.signal);
    if (!live.ok) {
        return result(`${errorText(live.error)}\nBinding: ${bindingPath(context.target.asyncDir, context.target.index)}\nRun state remains authoritative: ${context.target.status.state}.`, true);
    }
    return result(`Herdr inspector ${binding.paneId} is open for async run ${context.target.runId}.\nRun state: ${context.target.status.state}\nBinding: ${bindingPath(context.target.asyncDir, context.target.index)}`);
}
export async function closeHerdrInspector(context, client) {
    const binding = readHerdrInspectorBindingForTarget(context.target);
    if (!binding)
        return result(`No Herdr inspector binding exists for async run ${context.target.runId}.`);
    const closed = await client.run(["pane", "close", binding.paneId], { timeoutMs: 10_000, signal: context.signal });
    if (!closed.ok && closed.error.code !== "NOT_FOUND" && closed.error.code !== "PANE_GONE") {
        return result(errorText(closed.error), true);
    }
    fs.rmSync(bindingPath(context.target.asyncDir, context.target.index), { force: true });
    return result(`Closed Herdr inspector pane ${binding.paneId} for async run ${context.target.runId}. The subagent run was not stopped.`);
}
//# sourceMappingURL=actions.js.map