import * as path from "node:path";
import { parseExternalCliJsonlEvent } from "./external-cli-runner.js";
const MAX_EVENT_TYPE_LENGTH = 128;
const MAX_ERROR_LENGTH = 4_096;
const MAX_OVERSIZED_TOOL_CALL_BYTES = 1024 * 1024;
export const CURSOR_AGENT_ADAPTER_ID = "cursor-agent";
export const CURSOR_AGENT_WRITER_ADAPTER_ID = "cursor-agent-writer";
export const CURSOR_AGENT_ENV_ALLOWLIST = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "CURSOR_API_KEY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
];
function terminalError(event) {
    for (const value of [event.result, event.error, event.message]) {
        if (typeof value === "string" && value.trim())
            return value.trim().slice(0, MAX_ERROR_LENGTH);
    }
    const subtype = typeof event.subtype === "string" && event.subtype ? event.subtype : "unknown";
    return `Cursor Agent reported terminal result ${subtype}.`;
}
export function createCursorAgentJsonlParser() {
    let eventCount = 0;
    let terminal;
    return {
        parseLine(line) {
            const event = parseExternalCliJsonlEvent(line, "Cursor Agent", MAX_EVENT_TYPE_LENGTH);
            if (terminal)
                throw new Error("Cursor Agent emitted an event after its terminal state.");
            eventCount += 1;
            if (event.type === "error")
                terminal = { state: "failed", error: terminalError(event) };
            else if (event.type === "result") {
                if (event.subtype === "success" && event.is_error === false && typeof event.result === "string" && event.result.trim()) {
                    terminal = { state: "completed", output: event.result.trim() };
                }
                else
                    terminal = { state: "failed", error: terminalError(event) };
            }
            return { phase: terminal ? terminal.state : "streaming", eventCount };
        },
        skipOversizedLine(prefix, byteLength) {
            if (terminal || byteLength > MAX_OVERSIZED_TOOL_CALL_BYTES || !/^\s*\{\s*"type"\s*:\s*"tool_call"\s*,/.test(prefix))
                return undefined;
            eventCount += 1;
            return { phase: "streaming", eventCount };
        },
        finish() {
            return terminal;
        },
    };
}
export function resolveCursorAgentLaunch(input) {
    const writer = input.adapter === CURSOR_AGENT_WRITER_ADAPTER_ID;
    const promptDirectory = path.join(input.asyncDir, `external-${input.stepIndex}.cursor-prompt`);
    const promptFilePath = path.join(promptDirectory, "handoff.txt");
    const promptRelative = path.relative(input.cwd, promptDirectory);
    const promptOutsideWorkspace = promptRelative.startsWith("..") || path.isAbsolute(promptRelative);
    const prefix = [...(input.commandPrefixArgs ?? [])];
    const args = [
        ...prefix,
        "-p",
        "--output-format", "stream-json",
        ...(writer ? [] : ["--mode", "ask"]),
        "--sandbox", "enabled",
        "--workspace", input.cwd,
        ...(promptOutsideWorkspace ? ["--add-dir", promptDirectory] : []),
        `Read the complete handoff from the private file at ${promptFilePath}. Follow it and return only the final answer.`,
    ];
    return {
        command: input.command,
        args,
        promptFilePath,
        temporaryDirectories: [promptDirectory],
        environment: { allowlist: CURSOR_AGENT_ENV_ALLOWLIST },
        preflight: {
            id: input.adapter,
            versionArgs: [...prefix, "--version"],
            helpArgs: [...prefix, "--help"],
            validate(result) {
                if (!/^\d{4}\.\d{2}\.\d{2}-[0-9a-f]+$/.test(result.version))
                    throw new Error(`Unsupported Cursor Agent version response: ${JSON.stringify(result.version)}.`);
                for (const required of ["Start the Cursor Agent", "--print", "stream-json", "--sandbox <mode>", "enabled", "--workspace <path-or-name>", "--add-dir <path>", ...(writer ? ["all tools", "including write and shell"] : ["--mode <mode>", "ask:", "read-only"])]) {
                    if (!result.help.includes(required))
                        throw new Error(`Cursor Agent help does not document required option ${JSON.stringify(required)}.`);
                }
            },
        },
        parser: createCursorAgentJsonlParser(),
    };
}
//# sourceMappingURL=cursor-agent-adapter.js.map