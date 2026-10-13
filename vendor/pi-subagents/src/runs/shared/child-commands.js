import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import { createAtomicJsonWriter } from "../../shared/atomic-json.js";
import { watchAsyncControlInbox, requestAsyncCommand } from "../background/control-channel.js";
export const CHILD_COMMAND_TOOL = "subagent_command";
const writeAtomicJson = createAtomicJsonWriter({ mode: 0o600 });
const MAX_OUTPUT_BYTES = 8 * 1024;
const RECENT_COMMANDS = 20;
function childCommandStatePath(channelDir) {
    return path.join(channelDir, "commands.json");
}
export function readChildCommandState(channelDir) {
    try {
        return JSON.parse(fs.readFileSync(childCommandStatePath(channelDir), "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
function active(job) { return job.snapshot.endedAt === undefined; }
function text(result) {
    return Buffer.from(result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")).subarray(-MAX_OUTPUT_BYTES).toString("utf8");
}
/** Owns command lifetimes, not shell execution. The supplied Pi tool still executes the command. */
export function createChildCommandRuntime(channelDir) {
    const ownerId = randomUUID();
    const jobs = new Map();
    const usedIds = new Set();
    let closed = false;
    let disposeInbox;
    const state = () => ({ ownerId, closed, commands: [...jobs.values()].map((job) => ({ ...job.snapshot })) });
    const persist = () => writeAtomicJson(childCommandStatePath(channelDir), {
        ownerId, closed,
        commands: [...jobs.values()].map((job) => ({ ...job.snapshot, output: job.yielded ? job.snapshot.output : "" })),
    });
    const operate = (operation, toolCallId) => {
        if (operation === "status" && toolCallId === undefined)
            return state();
        const job = toolCallId ? jobs.get(toolCallId) : undefined;
        if (!job)
            throw new Error(`No retained command '${toolCallId ?? ""}' in this child session.`);
        if (operation !== "status" && closed)
            throw new Error("Child command controller is closed.");
        const before = job.snapshot.state;
        if (active(job)) {
            if (operation === "yield" && job.snapshot.state === "running") {
                job.yielded = true;
                job.snapshot.state = "yielded";
                job.yieldResult();
            }
            else if (operation === "cancel") {
                job.snapshot.state = "cancel_requested";
                job.controller.abort();
            }
        }
        if (job.snapshot.state !== before)
            persist();
        return { ownerId, closed, commands: [{ ...job.snapshot }] };
    };
    const startInbox = () => {
        if (disposeInbox)
            return;
        disposeInbox = watchAsyncControlInbox(channelDir, {
            onCommand(request) {
                const replyPath = commandReplyPath(channelDir, request.id);
                try {
                    if (request.ownerId !== ownerId)
                        throw new Error("Command request belongs to another child session.");
                    if (Date.now() > request.deadlineAt)
                        throw new Error("Command request expired before delivery.");
                    writeAtomicJson(replyPath, { state: operate(request.operation, request.toolCallId) });
                }
                catch (error) {
                    writeAtomicJson(replyPath, { error: error instanceof Error ? error.message : String(error) });
                }
            },
        });
    };
    const stop = async () => {
        closed = true;
        disposeInbox?.();
        for (const job of jobs.values())
            if (active(job)) {
                job.snapshot.state = "cancel_requested";
                job.controller.abort();
            }
        await Promise.all([...jobs.values()].map((job) => job.settled));
        if (jobs.size)
            persist();
    };
    return {
        state,
        operate,
        shutdown: stop,
        async finish() {
            const pending = [...jobs.values()].filter(active);
            if (!pending.length)
                return;
            await stop();
            throw new Error(`Child finished with unfinished commands: ${pending.map((job) => job.snapshot.toolCallId).join(", ")}. Commands were cancelled; query or cancel background commands before finishing.`);
        },
        wrap(tool) {
            return {
                ...tool,
                parameters: Type.Unsafe({ ...tool.parameters, properties: {
                        ...tool.parameters.properties,
                        yieldTimeMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 30_000, description: "Return a managed command handle after this wait; does not terminate the command. Omit to wait for completion." })),
                    } }),
                description: `${tool.description}\nOptional yieldTimeMs returns a command handle without stopping execution. Use subagent_command to query or cancel it. Finish or cancel every command before completing the task.`,
                async execute(toolCallId, params, signal, onUpdate, ctx) {
                    if (closed)
                        throw new Error("Child command controller is closed.");
                    if (usedIds.has(toolCallId))
                        throw new Error(`Command id '${toolCallId}' was already used in this child session.`);
                    usedIds.add(toolCallId);
                    const { yieldTimeMs, ...args } = params;
                    const controller = new AbortController();
                    const commandSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
                    let yieldResult;
                    const yielded = new Promise((resolve) => { yieldResult = resolve; });
                    const job = { snapshot: { toolCallId, state: "running", startedAt: Date.now(), output: "" }, controller, yieldResult, settled: Promise.resolve() };
                    // Keep active commands and a bounded recent history; never retain full outputs.
                    const completed = [...jobs].filter(([, candidate]) => !active(candidate));
                    for (const [id] of completed.slice(0, Math.max(0, completed.length - RECENT_COMMANDS + 1)))
                        jobs.delete(id);
                    jobs.set(toolCallId, job);
                    persist();
                    startInbox();
                    let timer;
                    if (typeof yieldTimeMs === "number")
                        timer = setTimeout(() => operate("yield", toolCallId), yieldTimeMs);
                    const execution = Promise.resolve().then(() => tool.execute(toolCallId, args, commandSignal, (update) => {
                        job.snapshot.output = text(update);
                        if (job.snapshot.state === "running")
                            onUpdate?.(update);
                    }, ctx)).then((result) => {
                        job.snapshot.output = text(result);
                        job.snapshot.state = "completed";
                        const fullOutputPath = result.details?.fullOutputPath;
                        if (fullOutputPath)
                            job.snapshot.fullOutputPath = fullOutputPath;
                        return result;
                    }, (error) => {
                        job.snapshot.state = controller.signal.aborted ? "cancelled" : "failed";
                        job.snapshot.output = String(error).slice(-MAX_OUTPUT_BYTES);
                        throw error;
                    }).finally(() => {
                        if (timer)
                            clearTimeout(timer);
                        job.snapshot.endedAt = Date.now();
                        persist();
                    });
                    job.settled = execution.then(() => { }, () => { });
                    const result = await Promise.race([execution.then((value) => ({ value })), yielded.then(() => undefined)]);
                    if (result)
                        return result.value;
                    return { content: [{ type: "text", text: `Command is still running (toolCallId: ${toolCallId}). This is not a successful exit. Use subagent_command({ action: "status", toolCallId: ${JSON.stringify(toolCallId)} }) to inspect or wait, or action: "cancel" to stop it.\n${job.snapshot.output}` }], details: { command: { ...job.snapshot } } };
                },
            };
        },
        tool() {
            return {
                name: CHILD_COMMAND_TOOL, label: "Child command",
                description: "Inspect or cancel bash commands owned by this child. Cancellation stops only the selected command, not the agent. Check terminal state before finishing.",
                parameters: Type.Object({ action: Type.String({ enum: ["status", "cancel"] }), toolCallId: Type.Optional(Type.String()), waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 30_000 })) }),
                async execute(_id, params, signal) {
                    const { action, toolCallId, waitMs = 0 } = params;
                    operate(action, toolCallId);
                    const job = toolCallId ? jobs.get(toolCallId) : undefined;
                    if (job && active(job) && waitMs > 0)
                        await waitForCommand(job.settled, waitMs, signal);
                    const snapshot = operate("status", toolCallId);
                    return { content: [{ type: "text", text: JSON.stringify(snapshot) }], details: snapshot };
                },
            };
        },
    };
}
async function waitForCommand(settled, waitMs, signal) {
    let timer;
    let abort;
    const wait = new Promise((resolve, reject) => {
        timer = setTimeout(resolve, waitMs);
        abort = () => reject(new Error("Command wait aborted; command remains managed by the child."));
        if (signal?.aborted)
            abort();
        else
            signal?.addEventListener("abort", abort, { once: true });
    });
    try {
        await Promise.race([settled, wait]);
    }
    finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
    }
}
function commandReplyPath(channelDir, id) {
    return path.join(channelDir, "command-replies", `${id}.json`);
}
export async function controlChildCommand(channelDir, operation, toolCallId, signal) {
    const current = readChildCommandState(channelDir);
    if (!current)
        throw new Error("No command controller is available for this child. Command controls require a local native Pi child with bash.");
    if (current.closed) {
        if (operation === "status") {
            if (toolCallId === undefined)
                return current;
            const command = current.commands.find((entry) => entry.toolCallId === toolCallId);
            if (!command)
                throw new Error(`No retained command '${toolCallId}' in this child session.`);
            return { ...current, commands: [command] };
        }
        throw new Error("Child command controller is closed.");
    }
    if (operation !== "status" && !toolCallId)
        throw new Error("An exact toolCallId is required; command controls never target the next command.");
    const id = randomUUID();
    const deadlineAt = Date.now() + 5_000;
    const request = { type: "command", id, ownerId: current.ownerId, operation, ...(toolCallId ? { toolCallId } : {}), deadlineAt };
    requestAsyncCommand(channelDir, request);
    const replyPath = commandReplyPath(channelDir, id);
    try {
        while (Date.now() < deadlineAt) {
            if (signal?.aborted)
                throw new Error("Command control wait aborted; delivery may still be pending.");
            try {
                const reply = JSON.parse(fs.readFileSync(replyPath, "utf8"));
                if (reply.error)
                    throw new Error(reply.error);
                if (reply.state)
                    return reply.state;
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("Command control acknowledgement timed out. Inspect command status; cancellation is not confirmed.");
    }
    finally {
        fs.rmSync(replyPath, { force: true });
    }
}
//# sourceMappingURL=child-commands.js.map