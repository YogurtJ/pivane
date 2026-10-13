import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectSubagentsDir } from "../../shared/artifacts.js";
import { writePrivateAtomicJson } from "../../shared/atomic-json.js";
import { withFileLease } from "../../shared/file-lease.js";
import { shortenPath } from "../../shared/formatters.js";
import { validateExecutionAcceptance } from "../shared/acceptance.js";
import { previewSimpleWorkflowRun } from "../../workflows/scripted-workflow.js";
import { resolveGitRepositoryIdentity } from "../../workflows/chat-progress.js";
import { getConfigDirName } from "../../shared/utils.js";
import { normalizeWorktreeBaseRef } from "../shared/worktree.js";
import { deepFreezeWorkflowArgs, normalizeWorkflowArgs } from "../../workflows/workflow-resources.js";
import { readMission, resolveMissionStoreLocation, validateMissionId } from "../../missions/store.js";
import { calendarDateAfter, latestCalendarOccurrence, nextCalendarOccurrence, normalizeCalendarRule, restoreCalendarTrigger } from "./calendar-schedule.js";
import { reconcileAsyncRun } from "./stale-run-reconciler.js";
export const SCHEDULED_RUN_ACTIONS = [
    "schedule.create",
    "schedule.list",
    "schedule.show",
    "schedule.history",
    "schedule.pause",
    "schedule.resume",
    "schedule.run",
    "schedule.run-due",
    "schedule.delete",
];
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_MAX_PENDING = 20;
const MAX_HISTORY = 100;
const STALE_LAUNCH_CLAIM_MS = 5 * 60_000;
const SCHEDULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function isScheduledRunAction(action) {
    return typeof action === "string" && SCHEDULED_RUN_ACTIONS.includes(action);
}
export function scheduledRunsEnabled(config) {
    return config.scheduledRuns?.enabled !== false;
}
export function scheduledRunStorePath(cwd, _sessionId, root) {
    if (!root)
        return path.join(getProjectSubagentsDir(path.resolve(cwd)), "schedules");
    const projectKey = createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 20);
    return path.join(root, projectKey);
}
export function parseScheduledRunTime(at, now = Date.now()) {
    const trimmed = at.trim();
    const relative = trimmed.match(/^\+(\d+)(s|m|h|d)$/);
    if (relative) {
        const amount = Number(relative[1]);
        if (!Number.isSafeInteger(amount) || amount < 1)
            throw new Error(`Invalid at value "${at}". Relative delays must be positive, such as "+10m".`);
        const unitMs = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2]];
        const result = now + amount * unitMs;
        if (!Number.isSafeInteger(result))
            throw new Error(`Invalid at value "${at}". Relative delay is too large.`);
        return result;
    }
    const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/);
    if (!iso)
        throw new Error(`Invalid at value "${at}". Use a one-shot delay such as "+10m" or an ISO timestamp with timezone.`);
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    const hour = Number(iso[4]);
    const minute = Number(iso[5]);
    const second = iso[6] === undefined ? 0 : Number(iso[6]);
    const zone = iso[7];
    const offsetHour = zone === "Z" ? 0 : Number(zone.slice(1, 3));
    const offsetMinute = zone === "Z" ? 0 : Number(zone.slice(4, 6));
    const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
    const parsed = Date.parse(trimmed);
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59 || !Number.isFinite(parsed))
        throw new Error(`Invalid at value "${at}". Use a valid ISO timestamp.`);
    if (parsed <= now)
        throw new Error(`Scheduled time ${new Date(parsed).toISOString()} is in the past.`);
    return parsed;
}
export function parseScheduleInterval(every) {
    const match = every.trim().match(/^(\d+)(m|h|d|w)$/);
    if (!match)
        throw new Error(`Invalid every value "${every}". This first recurring slice supports fixed intervals such as "30m", "6h", "2d", or "2w".`);
    const amount = Number(match[1]);
    if (!Number.isSafeInteger(amount) || amount < 1)
        throw new Error(`Invalid every value "${every}". Interval must be positive.`);
    const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2]];
    const result = amount * unitMs;
    if (!Number.isSafeInteger(result))
        throw new Error(`Invalid every value "${every}". Interval is too large.`);
    return result;
}
function timestamp(value) {
    return new Date(value).toISOString();
}
function validateScheduleId(id) {
    if (!SCHEDULE_ID.test(id))
        throw new Error("Schedule id must be 1-64 characters and contain only letters, numbers, '.', '_', or '-'.");
    return id;
}
function normalizedComparisonPath(value) {
    const absolute = path.resolve(value);
    if (process.platform !== "win32")
        return absolute;
    let normalized = absolute;
    try {
        normalized = fs.realpathSync.native(absolute);
    }
    catch { }
    normalized = normalized.replaceAll("/", "\\");
    if (normalized.startsWith("\\\\?\\UNC\\"))
        normalized = `\\\\${normalized.slice(8)}`;
    else if (normalized.startsWith("\\\\?\\"))
        normalized = normalized.slice(4);
    normalized = path.win32.normalize(normalized).toLowerCase();
    if (normalized.length > 3)
        normalized = normalized.replace(/[\\]+$/, "");
    return normalized;
}
function pathWithin(root, candidate) {
    const relative = path.relative(normalizedComparisonPath(root), normalizedComparisonPath(candidate));
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function resolveGitCommonDirForCheckout(checkoutRoot) {
    const gitPath = path.join(checkoutRoot, ".git");
    try {
        const stat = fs.statSync(gitPath);
        if (stat.isDirectory())
            return fs.realpathSync.native(gitPath);
        if (!stat.isFile())
            return undefined;
        const match = /^gitdir:[ \t]*([^\r\n]+)$/i.exec(fs.readFileSync(gitPath, "utf-8").trim());
        return match?.[1] ? fs.realpathSync.native(path.resolve(checkoutRoot, match[1])) : undefined;
    }
    catch {
        return undefined;
    }
}
function samePath(left, right) {
    return normalizedComparisonPath(left) === normalizedComparisonPath(right);
}
function resolveTrustedGitConfigRoot(checkoutRoot, commonDir) {
    const resolvedCommonDir = resolveGitCommonDirForCheckout(checkoutRoot);
    if (!resolvedCommonDir || !samePath(resolvedCommonDir, commonDir))
        return undefined;
    const configRoot = path.join(checkoutRoot, getConfigDirName());
    try {
        const resolved = fs.realpathSync.native(configRoot);
        return fs.statSync(resolved).isDirectory() && pathWithin(checkoutRoot, resolved) ? resolved : undefined;
    }
    catch {
        return undefined;
    }
}
function registeredGitWorktreeRoots(projectCwd) {
    const result = spawnSync("git", ["-C", projectCwd, "worktree", "list", "--porcelain"], { encoding: "utf-8", windowsHide: true });
    if (result.status !== 0 || typeof result.stdout !== "string")
        return [];
    const roots = [];
    for (const line of result.stdout.split(/\r?\n/)) {
        if (!line.startsWith("worktree "))
            continue;
        try {
            roots.push(fs.realpathSync.native(line.slice("worktree ".length).trim()));
        }
        catch { }
    }
    return roots;
}
function resolveSharedGitConfigRoot(projectCwd) {
    const repository = resolveGitRepositoryIdentity(projectCwd);
    if (!repository)
        return undefined;
    let projectConfigRoot;
    try {
        projectConfigRoot = fs.realpathSync.native(path.join(projectCwd, getConfigDirName()));
    }
    catch {
        return undefined;
    }
    // Git may report a separate-git-dir primary checkout as its common git
    // directory, not as the checkout root. Without a registered checkout root,
    // do not infer a shared config path from that unprovable layout.
    for (const checkoutRoot of new Set(registeredGitWorktreeRoots(projectCwd))) {
        const resolved = resolveTrustedGitConfigRoot(checkoutRoot, repository.commonDir);
        if (resolved && samePath(resolved, projectConfigRoot))
            return resolved;
    }
    return undefined;
}
// In the home directory the project config dir is the user's own Pi config dir,
// which may be a symlink to another disk.
function resolveHomeConfigRoot(projectPath) {
    const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
    try {
        if (!samePath(fs.realpathSync.native(home), projectPath))
            return undefined;
        return fs.realpathSync.native(path.join(home, getConfigDirName()));
    }
    catch {
        return undefined;
    }
}
function assertScheduleRoot(root, projectCwd, create) {
    if (!projectCwd) {
        if (create)
            fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        return;
    }
    let projectPath;
    try {
        projectPath = fs.realpathSync.native(projectCwd);
    }
    catch (error) {
        if (!create && error.code === "ENOENT")
            return;
        throw error;
    }
    let existing = root;
    while (!fs.existsSync(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing)
            break;
        existing = parent;
    }
    const existingPath = fs.realpathSync.native(existing);
    const withinProject = pathWithin(projectPath, existingPath);
    const sharedGitConfigRoot = withinProject ? undefined : resolveSharedGitConfigRoot(projectCwd);
    const homeConfigRoot = withinProject ? undefined : resolveHomeConfigRoot(projectPath);
    const isTrustedPath = (candidate) => pathWithin(projectPath, candidate)
        || (sharedGitConfigRoot !== undefined && pathWithin(sharedGitConfigRoot, candidate))
        || (homeConfigRoot !== undefined && pathWithin(homeConfigRoot, candidate));
    if (!isTrustedPath(existingPath))
        throw new Error(`Project schedule root '${root}' resolves outside the real project.`);
    if (!create)
        return;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!isTrustedPath(fs.realpathSync.native(root)))
        throw new Error(`Project schedule root '${root}' resolves outside the real project.`);
}
function scheduleDir(root, id, create = false, projectCwd) {
    assertScheduleRoot(root, projectCwd, create);
    const dir = path.join(root, validateScheduleId(id));
    try {
        const stat = fs.lstatSync(dir);
        if (stat.isSymbolicLink() || !stat.isDirectory())
            throw new Error(`Schedule path '${dir}' must be a real directory.`);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
        if (!create)
            return dir;
        fs.mkdirSync(dir, { mode: 0o700 });
    }
    const rootPath = fs.realpathSync.native(root);
    const dirPath = fs.realpathSync.native(dir);
    if (!samePath(dirPath, path.join(rootPath, id)))
        throw new Error(`Schedule path '${dir}' escapes the project schedule root.`);
    return dir;
}
function readJson(file, label) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf-8"));
    }
    catch (error) {
        throw new Error(`Failed to read ${label} '${file}': ${error instanceof Error ? error.message : String(error)}`, { cause: error instanceof Error ? error : undefined });
    }
}
function parseScheduleTarget(value, file) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`Schedule record '${file}' has invalid trigger or target.`);
    const target = value;
    if (typeof target.workflowScript === "string" && target.workflowScript.trim()) {
        let baseRef;
        let missionId;
        try {
            baseRef = normalizeWorktreeBaseRef(target.baseRef);
        }
        catch (error) {
            throw new Error(`Schedule record '${file}' has an invalid baseRef: ${error instanceof Error ? error.message : String(error)}`);
        }
        try {
            missionId = target.missionId === undefined ? undefined : validateMissionId(target.missionId);
        }
        catch (error) {
            throw new Error(`Schedule record '${file}' has an invalid missionId: ${error instanceof Error ? error.message : String(error)}`);
        }
        const normalizedArgs = normalizeWorkflowArgs(target.args);
        if ("error" in normalizedArgs)
            throw new Error(`Schedule record '${file}' has invalid args: ${normalizedArgs.error}`);
        return { workflowScript: target.workflowScript.trim(), args: deepFreezeWorkflowArgs(normalizedArgs.args), ...(baseRef === undefined ? {} : { baseRef }), ...(missionId === undefined ? {} : { missionId }) };
    }
    if (target.agent !== undefined || target.task !== undefined)
        throw new Error(`Schedule record '${file}' uses a removed legacy agent target; recreate it with schedule.create and workflow: true or a workflow script path.`);
    throw new Error(`Schedule record '${file}' requires a workflowScript target.`);
}
function parseSchedule(value, file) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`Schedule record '${file}' must be a JSON object.`);
    const record = value;
    if ((record.schemaVersion !== 1 && record.schemaVersion !== 2) || typeof record.id !== "string" || typeof record.name !== "string" || typeof record.cwd !== "string" || typeof record.createdAt !== "string" || typeof record.updatedAt !== "string" || typeof record.paused !== "boolean")
        throw new Error(`Schedule record '${file}' has invalid required fields.`);
    validateScheduleId(record.id);
    if (!record.trigger || typeof record.trigger !== "object" || !record.target || typeof record.target !== "object")
        throw new Error(`Schedule record '${file}' has invalid trigger or target.`);
    if (record.overlap !== "skip" || (record.catchUp !== "none" && record.catchUp !== "latest"))
        throw new Error(`Schedule record '${file}' has unsupported policy fields.`);
    if (record.trigger.kind === "once") {
        if (typeof record.trigger.at !== "string" || (record.trigger.nextRunAt !== undefined && typeof record.trigger.nextRunAt !== "string"))
            throw new Error(`Schedule record '${file}' has an invalid one-shot trigger.`);
    }
    else if (record.trigger.kind === "interval") {
        if (typeof record.trigger.every !== "string" || typeof record.trigger.everyMs !== "number" || typeof record.trigger.anchorAt !== "string" || typeof record.trigger.nextRunAt !== "string")
            throw new Error(`Schedule record '${file}' has an invalid interval trigger.`);
    }
    else if (record.trigger.kind === "calendar") {
        restoreCalendarTrigger(record.trigger); // Validate without rewriting during read-only list/show.
    }
    else
        throw new Error(`Schedule record '${file}' has an unsupported trigger.`);
    if (record.sessionOnly !== undefined && typeof record.sessionOnly !== "boolean")
        throw new Error(`Schedule record '${file}' has invalid sessionOnly.`);
    if (record.quiet !== undefined && typeof record.quiet !== "boolean")
        throw new Error(`Schedule record '${file}' has invalid quiet.`);
    if (record.sessionOnly === true && (typeof record.ownerSessionFile !== "string" || !record.ownerSessionFile.trim()))
        throw new Error(`Schedule record '${file}' is session-only but has no owner session file.`);
    const target = parseScheduleTarget(record.target, file);
    if ((record.schemaVersion === 2) !== (target.missionId !== undefined))
        throw new Error(`Schedule record '${file}' requires schemaVersion 2 exactly when missionId is present.`);
    return { ...record, target };
}
class ScheduleStore {
    root;
    projectCwd;
    constructor(root, projectCwd) {
        this.root = root;
        this.projectCwd = projectCwd;
    }
    directory(id, create = false) {
        return scheduleDir(this.root, id, create, this.projectCwd);
    }
    ids() {
        assertScheduleRoot(this.root, this.projectCwd, false);
        if (!fs.existsSync(this.root))
            return [];
        return fs.readdirSync(this.root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && SCHEDULE_ID.test(entry.name))
            .map((entry) => entry.name);
    }
    list() {
        return this.ids().map((id) => this.find(id)).filter((record) => record !== undefined);
    }
    get(id) {
        const record = this.find(id);
        if (!record)
            throw new Error(`Schedule '${id}' not found.`);
        return record;
    }
    /** Like {@link get}, but returns undefined when the schedule no longer exists. */
    find(id) {
        const file = path.join(scheduleDir(this.root, id, false, this.projectCwd), "schedule.json");
        if (!fs.existsSync(file))
            return undefined;
        return parseSchedule(readJson(file, "schedule record"), file);
    }
    write(record) {
        writePrivateAtomicJson(path.join(scheduleDir(this.root, record.id, true, this.projectCwd), "schedule.json"), record);
    }
    delete(id) {
        fs.rmSync(scheduleDir(this.root, id, false, this.projectCwd), { recursive: true, force: true });
    }
    history(id) {
        const file = path.join(scheduleDir(this.root, id, false, this.projectCwd), "history.json");
        if (!fs.existsSync(file))
            return [];
        const value = readJson(file, "schedule history");
        if (value?.schemaVersion !== 1 || !Array.isArray(value.runs))
            throw new Error(`Schedule history '${file}' has invalid fields.`);
        return value.runs;
    }
    /** The run's own receipt; it is written before history.json and is never trimmed. */
    getRun(id, runId) {
        if (!SCHEDULE_ID.test(runId))
            throw new Error(`Invalid schedule run id '${runId}'.`);
        const file = path.join(scheduleDir(this.root, id, false, this.projectCwd), "runs", `${runId}.json`);
        if (!fs.existsSync(file))
            return undefined;
        const run = readJson(file, "schedule run");
        if (run?.id !== runId || run.scheduleId !== id)
            throw new Error(`Schedule run '${file}' has invalid fields.`);
        return run;
    }
    writeRun(schedule, run, event) {
        const dir = scheduleDir(this.root, schedule.id, true, this.projectCwd);
        writePrivateAtomicJson(path.join(dir, "runs", `${run.id}.json`), run);
        // Sessions sharing this project update history.json from their own snapshots.
        withFileLease(path.join(dir, "history.json"), () => {
            // An earlier update may have timed out; a run's own receipt is newer than a "running" entry.
            const earlier = this.history(schedule.id).filter((item) => item.id !== run.id)
                .map((item) => item.state === "running" ? this.getRun(schedule.id, item.id) ?? item : item);
            const runs = [run, ...earlier].slice(0, MAX_HISTORY);
            writePrivateAtomicJson(path.join(dir, "history.json"), { schemaVersion: 1, runs });
            fs.appendFileSync(path.join(dir, "events.jsonl"), `${JSON.stringify({ schemaVersion: 1, timestamp: new Date().toISOString(), event, scheduleId: schedule.id, runId: run.id, state: run.state })}\n`, { encoding: "utf-8", mode: 0o600 });
        });
    }
    appendEvent(schedule, event) {
        const dir = scheduleDir(this.root, schedule.id, true, this.projectCwd);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.appendFileSync(path.join(dir, "events.jsonl"), `${JSON.stringify({ schemaVersion: 1, timestamp: new Date().toISOString(), event, scheduleId: schedule.id })}\n`, { encoding: "utf-8", mode: 0o600 });
    }
}
function resolveMaxPending(config) {
    const value = config.scheduledRuns?.maxPending;
    return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : DEFAULT_MAX_PENDING;
}
function hasPendingScheduleWork(schedule) {
    return schedule.activeRunId !== undefined || schedule.trigger.nextRunAt !== undefined;
}
function nextAfter(trigger, plannedAt, now) {
    if (trigger.kind === "once")
        return { ...trigger, nextRunAt: undefined };
    if (trigger.kind === "calendar")
        return {
            ...trigger,
            ...nextCalendarOccurrence(trigger, Math.max(plannedAt, now), calendarDateAfter(trigger, plannedAt, trigger.nextLocalDate)),
        };
    const next = plannedAt + (Math.floor(Math.max(0, now - plannedAt) / trigger.everyMs) + 1) * trigger.everyMs;
    return { ...trigger, nextRunAt: timestamp(next) };
}
function nextRunAt(schedule) {
    const value = schedule.trigger.nextRunAt;
    if (!value)
        return undefined;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed))
        throw new Error(`Schedule '${schedule.id}' has invalid nextRunAt.`);
    return parsed;
}
function duePlannedAt(schedule, now) {
    const next = nextRunAt(schedule);
    if (next === undefined || next > now || schedule.catchUp !== "latest")
        return next;
    if (schedule.trigger.kind === "calendar")
        return Date.parse(latestCalendarOccurrence(schedule.trigger, now, schedule.trigger.nextLocalDate).nextRunAt);
    if (schedule.trigger.kind === "interval")
        return next + Math.floor((now - next) / schedule.trigger.everyMs) * schedule.trigger.everyMs;
    return next;
}
function triggerLabel(trigger) {
    if (trigger.kind === "calendar")
        return `every ${trigger.every}${trigger.on ? ` (${trigger.on.join(", ")})` : ""} at ${trigger.at} ${trigger.timezone}`;
    return trigger.kind === "once" ? `at ${trigger.at}` : `every ${trigger.every}`;
}
function textResult(text, schedules, runs, isError = false) {
    const publicSchedules = schedules?.map(publicScheduleRecord);
    return {
        content: [{ type: "text", text }],
        ...(isError ? { isError: true } : {}),
        details: { mode: "management", results: [], schedules: { ...(publicSchedules ? { records: publicSchedules } : {}), ...(runs ? { runs } : {}) } },
    };
}
function publicScheduleRecord(schedule) {
    const { ownerSessionFile: _ownerSessionFile, ...rest } = schedule;
    return rest;
}
function targetLabel(target) {
    const preview = previewSimpleWorkflowRun(target.workflowScript);
    return preview?.agent ? `workflow -> agent ${preview.agent}` : "workflow (dynamic)";
}
function sanitizeTarget(params) {
    if (params.tasks || params.chain)
        return { error: "Recurring schedules require a workflow script; legacy tasks and chain inputs are unsupported." };
    if (params.agent !== undefined || params.task !== undefined)
        return { error: "schedule.create requires workflow: true or a workflow script path, e.g. a ```js workflow block containing return runs.run('main', { agent, task })." };
    if (typeof params.workflowScript !== "string" || !params.workflowScript.trim())
        return { error: "schedule.create requires workflow: true or a workflow script path." };
    if (params.context === "fork")
        return { error: "Scheduled runs require fresh context." };
    if (params.async === false)
        return { error: "Scheduled runs are always async." };
    let baseRef;
    let missionId;
    try {
        baseRef = normalizeWorktreeBaseRef(params.baseRef);
        missionId = params.missionId === undefined ? undefined : validateMissionId(params.missionId);
    }
    catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
    const acceptanceErrors = validateExecutionAcceptance(params);
    if (acceptanceErrors.length)
        return { error: acceptanceErrors.join(" ") };
    const normalizedArgs = normalizeWorkflowArgs(params.args);
    if ("error" in normalizedArgs)
        return { error: normalizedArgs.error };
    return { target: { workflowScript: params.workflowScript.trim(), args: deepFreezeWorkflowArgs(normalizedArgs.args), ...(baseRef === undefined ? {} : { baseRef }), ...(missionId === undefined ? {} : { missionId }) } };
}
function executionParams(schedule, quiet = false) {
    return {
        ...schedule.target,
        async: true,
        context: "fresh",
        cwd: schedule.cwd,
        ...(schedule.target.missionId === undefined ? { mission: false } : {}),
        // Scheduled fires have no operator watching, so completions must name the origin.
        scheduleOrigin: { id: schedule.id, ...(schedule.name ? { name: schedule.name } : {}), ...(quiet ? { quiet: true } : {}) },
        ...(schedule.timeoutMs === undefined ? {} : { timeoutMs: schedule.timeoutMs }),
    };
}
function snapshotContext(ctx, cwd) {
    const source = ctx.sessionManager;
    const sessionId = source.getSessionId();
    const sessionFile = source.getSessionFile();
    const sessionManager = new Proxy(source, {
        get(target, property) {
            if (property === "getSessionId")
                return () => sessionId;
            if (property === "getSessionFile")
                return () => sessionFile;
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
    return { ...ctx, cwd, sessionManager };
}
/**
 * 规范化会话文件路径, 兼容 Windows 路径大小写差异.
 *
 * @param value 会话文件路径
 * @returns 规范化后的路径, 空值时返回 undefined
 */
function normalizedSessionFile(value) {
    if (!value || !value.trim())
        return undefined;
    const normalized = path.normalize(path.resolve(value));
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
/**
 * 判断 Schedule 是否属于当前 Pi 会话.
 *
 * @param schedule Schedule 记录
 * @param ctx 当前 Pi 会话上下文
 * @returns 是否允许当前会话执行该 Schedule
 */
function scheduleBelongsToSession(schedule, ctx) {
    if (schedule.sessionOnly !== true)
        return true;
    const ownerSessionFile = normalizedSessionFile(schedule.ownerSessionFile);
    const currentSessionFile = normalizedSessionFile(ctx.sessionManager.getSessionFile());
    return ownerSessionFile !== undefined && ownerSessionFile === currentSessionFile;
}
export function listScheduledRunSummaries(cwd, root) {
    return new ScheduleStore(scheduledRunStorePath(cwd, undefined, root), root === undefined ? path.resolve(cwd) : undefined).list();
}
export class ScheduledRunManager {
    store;
    stores = new Map();
    contexts = new Map();
    timers = new Map();
    observedAsyncIds = new Set();
    now;
    randomId;
    timersApi;
    deps;
    constructor(deps) {
        this.deps = deps;
        this.now = deps.now ?? Date.now;
        this.randomId = deps.randomId ?? (() => randomUUID().slice(0, 8));
        this.timersApi = deps.timers ?? globalThis;
    }
    bindSession(ctx) {
        if (!scheduledRunsEnabled(this.deps.config))
            return;
        this.selectProject(ctx.cwd, ctx);
    }
    stop() {
        this.stopTimers();
        this.store = undefined;
        this.stores.clear();
        this.contexts.clear();
        this.observedAsyncIds.clear();
    }
    async handleToolCall(params, ctx) {
        try {
            if (!scheduledRunsEnabled(this.deps.config))
                return textResult("Scheduled runs are disabled by scheduledRuns.enabled=false.", undefined, undefined, true);
            this.selectProject(params.cwd ?? ctx.cwd, ctx);
            switch (params.action) {
                case "schedule.create": return this.create(params, ctx);
                case "schedule.list": return this.list();
                case "schedule.show": return this.show(params);
                case "schedule.history": return this.history(params);
                case "schedule.pause": return this.pause(params, true);
                case "schedule.resume": return this.pause(params, false);
                case "schedule.run": return await this.runManual(params);
                case "schedule.run-due": return await this.runDue();
                case "schedule.delete": return this.remove(params);
                default: return textResult(`Unknown schedule action: ${params.action}`, undefined, undefined, true);
            }
        }
        catch (error) {
            return textResult(error instanceof Error ? error.message : String(error), undefined, undefined, true);
        }
    }
    observedCompletionRunIds() {
        return new Set(this.observedAsyncIds);
    }
    referencedAsyncRunIds() {
        const runIds = new Set(this.observedAsyncIds);
        for (const store of this.stores.values()) {
            for (const scheduleId of store.ids()) {
                for (const run of store.history(scheduleId)) {
                    if (run.asyncId)
                        runIds.add(run.asyncId);
                }
            }
        }
        return runIds;
    }
    handleAsyncCompletion(payload) {
        if (!payload || typeof payload !== "object")
            return;
        const data = payload;
        const asyncId = typeof data.runId === "string" ? data.runId : typeof data.id === "string" ? data.id : undefined;
        if (!asyncId)
            return;
        for (const store of this.stores.values()) {
            let ids;
            try {
                ids = store.ids();
            }
            catch (error) {
                console.error(`Failed to inspect schedule store '${store.root}' during async completion:`, error);
                continue;
            }
            for (const id of ids) {
                try {
                    const schedule = store.get(id);
                    const listed = store.history(id).find((item) => item.asyncId === asyncId) ?? this.activeRun(store, schedule);
                    // history.json can lag the run's receipt when its update timed out.
                    const run = listed && (store.getRun(id, listed.id) ?? listed);
                    if (run?.asyncId !== asyncId || run.state !== "running")
                        continue;
                    this.finishRun(store, schedule, run, data.success === true, typeof data.summary === "string" ? data.summary : undefined);
                    return;
                }
                catch (error) {
                    console.error(`Failed to inspect schedule '${id}' in '${store.root}' during async completion:`, error);
                }
            }
        }
    }
    create(params, ctx) {
        const store = this.requireStore();
        const target = sanitizeTarget(params);
        if (target.error)
            return textResult(target.error, undefined, undefined, true);
        const at = params.at?.trim();
        const every = params.every?.trim();
        const calendar = every === "day" || every === "week";
        if (!calendar && Boolean(at) === Boolean(every))
            return textResult("schedule.create requires exactly one trigger: at or every.", undefined, undefined, true);
        if (params.overlap !== undefined && params.overlap !== "skip")
            return textResult("This first recurring slice supports overlap='skip' only.", undefined, undefined, true);
        if (params.catchUp !== undefined && params.catchUp !== "none" && params.catchUp !== "latest")
            return textResult("catchUp must be 'none' or 'latest'.", undefined, undefined, true);
        if (params.mission !== undefined || params.missionUpdate !== undefined || params.missionStatus !== undefined || params.missionScope !== undefined)
            return textResult("Schedules accept only an existing missionId; mission creation and updates are unsupported.", undefined, undefined, true);
        if (!calendar && (params.on !== undefined || params.timezone !== undefined))
            return textResult("on and timezone require every:'day' or every:'week'.", undefined, undefined, true);
        if (params.quiet !== undefined && typeof params.quiet !== "boolean")
            return textResult("quiet must be a boolean.", undefined, undefined, true);
        if (!calendar && at && params.quiet === true)
            return textResult("quiet is only supported for recurring schedules.", undefined, undefined, true);
        const sessionOnly = params.sessionOnly === true;
        if (sessionOnly && params.cwd !== undefined && !samePath(params.cwd, ctx.cwd))
            return textResult("sessionOnly schedules cannot use an explicit cross-project cwd.", undefined, undefined, true);
        const ownerSessionFile = sessionOnly ? ctx.sessionManager.getSessionFile() : undefined;
        if (sessionOnly && !ownerSessionFile)
            return textResult("sessionOnly schedules require a persisted current session.", undefined, undefined, true);
        if (target.target.missionId !== undefined) {
            readMission(resolveMissionStoreLocation({ projectRoot: path.resolve(params.cwd ?? ctx.cwd), ...(this.deps.config.missions ? { config: this.deps.config.missions } : {}) }), target.target.missionId);
        }
        const sessionId = ctx.sessionManager.getSessionId() ?? "unknown";
        if (this.deps.resolveCapabilityCeiling?.(sessionId))
            return textResult("Cannot persist a schedule while a capability ceiling is active.", undefined, undefined, true);
        const pendingCount = store.list().filter(hasPendingScheduleWork).length;
        const maxPending = resolveMaxPending(this.deps.config);
        if (pendingCount >= maxPending)
            return textResult(`Schedule limit reached (${maxPending}).`, undefined, undefined, true);
        const id = validateScheduleId((params.id?.trim() || this.randomId()));
        if (store.ids().includes(id))
            return textResult(`Schedule '${id}' already exists.`, undefined, undefined, true);
        const now = this.now();
        let trigger;
        if (calendar) {
            const rule = normalizeCalendarRule({ every, at, on: params.on, timezone: params.timezone });
            trigger = { kind: "calendar", ...rule, ...nextCalendarOccurrence(rule, now) };
        }
        else if (at) {
            const planned = parseScheduledRunTime(at, now);
            trigger = { kind: "once", at, nextRunAt: timestamp(planned) };
        }
        else {
            const everyMs = parseScheduleInterval(every);
            trigger = { kind: "interval", every: every, everyMs, anchorAt: timestamp(now), nextRunAt: timestamp(now + everyMs) };
        }
        const schedule = {
            // Older readers ignore unknown target fields; they must reject mission-bound definitions.
            schemaVersion: target.target.missionId === undefined ? 1 : 2,
            id,
            name: params.name?.trim() || targetLabel(target.target),
            cwd: path.resolve(params.cwd ?? ctx.cwd),
            trigger,
            target: target.target,
            overlap: "skip",
            catchUp: params.catchUp ?? "latest",
            ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
            paused: false,
            ...(sessionOnly ? { sessionOnly: true, ownerSessionFile: path.resolve(ownerSessionFile) } : {}),
            ...(trigger.kind !== "once" && params.quiet === true ? { quiet: true } : {}),
            createdAt: timestamp(now),
            updatedAt: timestamp(now),
        };
        store.write(schedule);
        store.appendEvent(schedule, "schedule.created");
        this.arm(schedule, store);
        return textResult(`Created schedule ${id}.\nName: ${schedule.name}\nTrigger: ${triggerLabel(trigger)}\nSession only: ${schedule.sessionOnly === true ? "yes" : "no"}\nQuiet: ${schedule.quiet === true ? "yes" : "no"}\nNext: ${schedule.trigger.nextRunAt}\nTarget: ${targetLabel(schedule.target)}${schedule.target.missionId === undefined ? "" : `\nMission: ${schedule.target.missionId}`}`, [schedule]);
    }
    list() {
        const schedules = this.requireStore().list().sort((a, b) => (a.trigger.nextRunAt ?? "").localeCompare(b.trigger.nextRunAt ?? ""));
        if (!schedules.length)
            return textResult("No project schedules.", []);
        return textResult([`Project schedules: ${schedules.length}`, ...schedules.map((item) => `- ${item.id} | ${item.paused ? "paused" : item.activeRunId ? "running" : "scheduled"} | ${item.trigger.nextRunAt ?? "no next run"} | ${item.sessionOnly === true ? "session-only" : "project"} | ${item.name}${item.target.missionId === undefined ? "" : ` | mission ${item.target.missionId}`}`)].join("\n"), schedules);
    }
    show(params) {
        const schedule = this.resolve(params);
        return textResult([`Schedule: ${schedule.id}`, `Name: ${schedule.name}`, `State: ${schedule.paused ? "paused" : schedule.activeRunId ? "running" : "scheduled"}`, `Session only: ${schedule.sessionOnly === true ? "yes" : "no"}`, `Quiet: ${schedule.quiet === true ? "yes" : "no"}`, `Target: ${targetLabel(schedule.target)}`, schedule.target.missionId === undefined ? undefined : `Mission: ${schedule.target.missionId}`, `CWD: ${shortenPath(schedule.cwd)}`, `Trigger: ${triggerLabel(schedule.trigger)}`, `Next: ${schedule.trigger.nextRunAt ?? "none"}`, `Catch up: ${schedule.catchUp}`, schedule.activeRunId ? `Active run: ${schedule.activeRunId}` : undefined].filter(Boolean).join("\n"), [schedule]);
    }
    history(params) {
        const schedule = this.resolve(params);
        const runs = this.requireStore().history(schedule.id);
        return textResult(runs.length ? [`Schedule history: ${schedule.id}`, ...runs.map((run) => `- ${run.id} | ${run.state} | ${run.plannedAt}${run.asyncId ? ` | async ${run.asyncId}` : ""}`)].join("\n") : `No runs recorded for schedule ${schedule.id}.`, [schedule], runs);
    }
    pause(params, paused) {
        const schedule = this.resolve(params);
        if (schedule.paused === paused)
            return textResult(`Schedule ${schedule.id} is already ${paused ? "paused" : "active"}.`, [schedule]);
        schedule.paused = paused;
        schedule.updatedAt = timestamp(this.now());
        this.requireStore().write(schedule);
        this.requireStore().appendEvent(schedule, paused ? "schedule.paused" : "schedule.resumed");
        const store = this.requireStore();
        if (paused)
            this.clearTimer(store, schedule.id);
        else
            this.restoreOne(store, schedule);
        return textResult(`${paused ? "Paused" : "Resumed"} schedule ${schedule.id}.`, [schedule]);
    }
    async runManual(params) {
        const store = this.requireStore();
        const schedule = this.resolve(params);
        const context = this.requireContext(store);
        if (!scheduleBelongsToSession(schedule, context)) {
            return textResult(`Skipped schedule ${schedule.id}: current session is not its owner.`, [schedule]);
        }
        if (params.quiet !== undefined && typeof params.quiet !== "boolean")
            return textResult("quiet must be a boolean.", undefined, undefined, true);
        const manualTrigger = schedule.trigger;
        const run = await this.launch(store, schedule, this.now(), "manual", false, params.quiet === true);
        const updated = store.get(schedule.id);
        if (run.state === "running") {
            const now = this.now();
            if (updated.trigger.kind === "calendar") {
                if (manualTrigger.kind !== "calendar")
                    throw new Error("Schedule trigger changed during manual launch.");
                const consumed = latestCalendarOccurrence(manualTrigger, now, manualTrigger.nextLocalDate)?.nextRunAt ?? manualTrigger.nextRunAt;
                const advanced = nextAfter(manualTrigger, Date.parse(consumed), now);
                if (advanced.nextLocalDate > updated.trigger.nextLocalDate)
                    updated.trigger = advanced;
            }
            else if (updated.trigger.kind === "interval")
                updated.trigger.nextRunAt = timestamp(now + updated.trigger.everyMs);
            else
                updated.trigger.nextRunAt = undefined;
            updated.updatedAt = timestamp(now);
            store.write(updated);
            store.appendEvent(updated, "schedule.manual_satisfied");
            this.arm(updated, store);
        }
        return textResult(`Manual schedule run ${run.id}: ${run.state}${run.asyncId ? ` (async ${run.asyncId})` : ""}.`, [store.get(schedule.id)], [run], run.state === "failed_launch");
    }
    async runDue() {
        const store = this.requireStore();
        const context = this.requireContext(store);
        const due = store.list().filter((schedule) => scheduleBelongsToSession(schedule, context) && !schedule.paused && nextRunAt(schedule) !== undefined && nextRunAt(schedule) <= this.now());
        const runs = [];
        for (const schedule of due) {
            const planned = duePlannedAt(schedule, this.now());
            if (!schedule.activeRunId && schedule.catchUp === "none" && planned < this.now())
                runs.push(this.recordMissed(store, schedule, planned, "run-due"));
            else
                runs.push(await this.launch(store, schedule, planned, "run-due", true));
        }
        return textResult(runs.length ? `Processed ${runs.length} due schedule(s).` : "No schedules are due.", store.list(), runs);
    }
    remove(params) {
        const schedule = this.resolve(params);
        const store = this.requireStore();
        if (schedule.activeRunId) {
            const run = this.activeRun(store, schedule);
            let terminal = false;
            if (run?.scheduleId === schedule.id && run.state === "running" && run.asyncId && run.asyncDir) {
                const status = readJson(path.join(run.asyncDir, "status.json"), "async status");
                terminal = status.runId === run.asyncId && typeof status.state === "string" && ["complete", "failed", "stopped", "rejected"].includes(status.state);
            }
            if (!terminal)
                return textResult(`Schedule ${schedule.id} has active run ${schedule.activeRunId}; stop that run before deleting the schedule.`, [schedule], undefined, true);
        }
        this.clearTimer(store, schedule.id);
        store.appendEvent(schedule, "schedule.deleted");
        store.delete(schedule.id);
        return textResult(`Deleted schedule ${schedule.id}.`);
    }
    restore(store) {
        for (const schedule of store.list())
            this.restoreOne(store, schedule);
    }
    restoreOne(store, schedule, notBefore, rearm = true) {
        if (!scheduleBelongsToSession(schedule, this.requireContext(store)))
            return;
        if (schedule.trigger.kind === "calendar") {
            const refreshed = restoreCalendarTrigger(schedule.trigger);
            if (JSON.stringify(refreshed) !== JSON.stringify(schedule.trigger)) {
                schedule.trigger = refreshed;
                schedule.updatedAt = timestamp(this.now());
                store.write(schedule);
            }
        }
        if (schedule.activeRunId) {
            const run = this.activeRun(store, schedule);
            if (run?.state === "running" && run.asyncId)
                this.observedAsyncIds.add(run.asyncId);
            const startedAt = run?.startedAt ? Date.parse(run.startedAt) : Number.NaN;
            const outcome = this.terminalAsyncOutcome(run);
            if (run && outcome) {
                // Restore releases a dead or terminal claim at most once and never re-enters itself. On success it continues
                // to the existing policy code below with the latest record. On failure it arms the schedule from disk, so the
                // next fire retries the release, and the original error propagates unchanged.
                let latest;
                try {
                    latest = this.finishRun(store, schedule, run, outcome.success, outcome.error, true) ?? store.find(schedule.id);
                }
                catch (error) {
                    if (rearm) {
                        try {
                            const current = store.find(schedule.id);
                            if (current)
                                this.arm(current, store, notBefore);
                        }
                        catch { /* Keep the release error. */ }
                    }
                    throw error;
                }
                if (!latest) {
                    this.clearTimer(store, schedule.id);
                    return;
                }
                schedule = latest;
            }
            if (schedule.activeRunId && (!run || run.state !== "running" || (!run.asyncId && Number.isFinite(startedAt) && startedAt + STALE_LAUNCH_CLAIM_MS <= this.now()))) {
                if (run?.state === "running") {
                    run.state = "failed_launch";
                    run.completedAt = timestamp(this.now());
                    run.error = "Recovered a stale launch claim before an async run was attached.";
                    store.writeRun(schedule, run, "schedule.run.failed");
                }
                schedule.activeRunId = undefined;
                schedule.updatedAt = timestamp(this.now());
                store.write(schedule);
                fs.rmSync(path.join(store.directory(schedule.id), "active.lock"), { force: true });
            }
        }
        if (!rearm || schedule.paused)
            return;
        const next = nextRunAt(schedule);
        if (next === undefined)
            return;
        if (!schedule.activeRunId && next < this.now() && schedule.catchUp === "none") {
            try {
                this.recordMissed(store, schedule, next, "timer");
            }
            catch (error) {
                if (notBefore !== undefined)
                    this.arm(schedule, store, notBefore);
                throw error;
            }
        }
        this.arm(schedule, store, notBefore);
    }
    arm(schedule, store, notBefore) {
        this.clearTimer(store, schedule.id);
        if (schedule.paused)
            return;
        const next = nextRunAt(schedule);
        if (next === undefined)
            return;
        const timer = this.timersApi.setTimeout(() => {
            // A timer callback is outside every caller's try/catch, so an escaping
            // rejection here reaches the process as an uncaught exception and exits
            // Pi. Contain every failure to this one schedule.
            void this.fire(store, schedule.id).catch((error) => {
                console.warn(`[pi-subagents] Scheduled run '${schedule.id}' failed to fire: ${error instanceof Error ? error.message : String(error)}`);
                this.restoreAfterFireError(store, schedule.id);
            });
        }, Math.min(Math.max(0, next - this.now(), (notBefore ?? 0) - this.now()), MAX_TIMER_DELAY_MS));
        timer.unref?.();
        this.timers.set(this.timerKey(store, schedule.id), timer);
    }
    restoreAfterFireError(store, id) {
        try {
            const schedule = store.find(id);
            if (!schedule)
                return;
            const now = this.now();
            const planned = schedule.trigger.kind !== "once" ? duePlannedAt(schedule, now) : undefined;
            const notBefore = planned !== undefined && planned <= now ? Date.parse(nextAfter(schedule.trigger, planned, now).nextRunAt) : undefined;
            this.restoreOne(store, schedule, notBefore, schedule.trigger.kind !== "once");
        }
        catch (error) {
            console.warn(`[pi-subagents] Scheduled run '${id}' could not be restored after fire failure: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async fire(store, id) {
        this.clearTimer(store, id);
        // Schedules are project-scoped and shared, and `delete` only clears the
        // timer inside the deleting process. Another session can therefore remove
        // a schedule while this process still holds an armed timer for it; there
        // is then nothing to run and nothing to re-arm.
        const schedule = store.find(id);
        if (!schedule)
            return;
        if (!scheduleBelongsToSession(schedule, this.requireContext(store)))
            return;
        const planned = duePlannedAt(schedule, this.now());
        if (planned === undefined || schedule.paused)
            return;
        if (planned > this.now())
            return this.arm(schedule, store);
        await this.launch(store, schedule, planned, "timer", true);
    }
    async launch(store, schedule, planned, dueReason, advance, quiet) {
        const now = this.now();
        const nextRunAtBeforeClaim = schedule.trigger.nextRunAt;
        const nextLocalDateBeforeClaim = schedule.trigger.kind === "calendar" ? schedule.trigger.nextLocalDate : undefined;
        const run = { schemaVersion: 1, id: this.randomId(), scheduleId: schedule.id, plannedAt: timestamp(planned), dueReason, state: "running", startedAt: timestamp(now) };
        if (schedule.activeRunId) {
            let active;
            let outcome;
            try {
                active = this.activeRun(store, schedule);
                outcome = this.terminalAsyncOutcome(active);
            }
            catch (error) {
                console.warn(`[pi-subagents] Could not reconcile active run '${schedule.activeRunId}' of schedule '${schedule.id}': ${error instanceof Error ? error.message : String(error)}`);
            }
            // A dead runner's completion never reaches this schedule, so its claim would skip every later fire.
            if (active && outcome) {
                const released = this.finishRun(store, schedule, active, outcome.success, outcome.error, true);
                // Another session already released or re-claimed that run for this occurrence.
                if (!released)
                    return this.skipLostClaim(store, schedule.id, run, planned, now);
                schedule = released;
            }
        }
        if (schedule.activeRunId) {
            run.state = "skipped";
            run.completedAt = timestamp(now);
            if (advance) {
                schedule.trigger = nextAfter(schedule.trigger, planned, now);
                schedule.updatedAt = timestamp(now);
                store.write(schedule);
            }
            store.writeRun(schedule, run, "schedule.skipped_overlap");
            this.arm(schedule, store);
            return run;
        }
        const lockPath = path.join(store.directory(schedule.id, true), "active.lock");
        fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
        let lock;
        try {
            lock = fs.openSync(lockPath, "wx", 0o600);
            fs.writeFileSync(lock, run.id, "utf-8");
            fs.closeSync(lock);
        }
        catch (error) {
            if (lock !== undefined) {
                // An empty or partial claim would make every later launch skip. Keep the
                // descriptor open until the inode check so a replacement owner's lock survives.
                try {
                    // Bigint stats: Windows file ids exceed 2^53, so number inodes of nearby files can compare equal.
                    const owned = fs.fstatSync(lock, { bigint: true });
                    const current = fs.lstatSync(lockPath, { bigint: true });
                    if (owned.ino !== 0n && owned.dev === current.dev && owned.ino === current.ino)
                        fs.rmSync(lockPath);
                }
                catch { /* Preserve the original error. */ }
                try {
                    fs.closeSync(lock);
                }
                catch { /* Preserve the original error. */ }
                throw error;
            }
            if (error.code !== "EEXIST")
                throw error;
            return this.skipLostClaim(store, schedule.id, run, planned, now);
        }
        schedule.activeRunId = run.id;
        schedule.lastRunId = run.id;
        if (advance)
            schedule.trigger = nextAfter(schedule.trigger, planned, now);
        schedule.updatedAt = timestamp(now);
        try {
            store.write(schedule);
            store.writeRun(schedule, run, "schedule.run.started");
        }
        catch (error) {
            // No child has launched: release this run's claim, then report the original error.
            // Another session may already have recovered the claim and launched its own run.
            try {
                const latest = store.find(schedule.id);
                if (latest?.activeRunId === run.id) {
                    latest.activeRunId = undefined;
                    latest.updatedAt = timestamp(this.now());
                    store.write(latest);
                }
                if (fs.readFileSync(lockPath, "utf-8") === run.id)
                    fs.rmSync(lockPath);
            }
            catch (cleanupError) {
                console.warn(`[pi-subagents] Could not release schedule claim '${run.id}': ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
            }
            throw error;
        }
        try {
            const result = await this.deps.launch(executionParams(schedule, dueReason === "manual" ? quiet === true : schedule.quiet === true), this.requireContext(store), new AbortController().signal);
            const asyncId = result.details?.asyncId ?? result.details?.runId;
            if (result.isError || !asyncId)
                throw new Error(result.content.find((item) => item.type === "text")?.text ?? "Scheduled launch failed.");
            run.asyncId = asyncId;
            run.asyncDir = result.details?.asyncDir;
            this.observedAsyncIds.add(asyncId);
            store.writeRun(schedule, run, "schedule.run.attached_async");
            this.arm(schedule, store);
            return run;
        }
        catch (error) {
            // The child is running, so its claim stays until completion.
            if (run.asyncId)
                throw new Error(`Scheduled run '${run.id}' attached to async run '${run.asyncId}', but recording it failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
            run.state = "failed_launch";
            run.completedAt = timestamp(this.now());
            run.error = error instanceof Error ? error.message : String(error);
            const latest = store.get(schedule.id);
            latest.activeRunId = undefined;
            if (!advance && nextRunAtBeforeClaim) {
                if (latest.trigger.kind === "calendar") {
                    // An overlapping timer may have advanced both cursor fields while
                    // this manual attachment was pending. Failure satisfies neither.
                    if (nextLocalDateBeforeClaim !== undefined) {
                        latest.trigger.nextLocalDate = nextLocalDateBeforeClaim;
                        latest.trigger.nextRunAt = nextRunAtBeforeClaim;
                    }
                }
                else
                    latest.trigger.nextRunAt = nextRunAtBeforeClaim;
            }
            latest.updatedAt = timestamp(this.now());
            store.write(latest);
            fs.rmSync(lockPath, { force: true });
            try {
                store.writeRun(latest, run, "schedule.run.failed");
            }
            finally {
                this.arm(latest, store);
            }
            return run;
        }
    }
    /**
     * `releaseOnly` releases a dead run's claim and leaves the pending occurrence to the caller: it neither skips nor re-arms it.
     * It acts only while the schedule on disk still names that run, and returns the record it wrote, or undefined when another
     * session already released or re-claimed it.
     */
    finishRun(store, schedule, run, success, error, releaseOnly = false) {
        const now = this.now();
        if (run.asyncId)
            this.observedAsyncIds.delete(run.asyncId);
        if (releaseOnly) {
            const latest = store.find(schedule.id);
            if (latest?.activeRunId !== run.id)
                return undefined;
            schedule = latest;
        }
        const next = nextRunAt(schedule);
        let skipped;
        if (!releaseOnly && next !== undefined && next <= now) {
            const planned = duePlannedAt(schedule, now);
            skipped = {
                schemaVersion: 1,
                id: this.randomId(),
                scheduleId: schedule.id,
                plannedAt: timestamp(planned),
                dueReason: "timer",
                state: "skipped",
                completedAt: timestamp(now),
            };
            schedule.trigger = nextAfter(schedule.trigger, planned, now);
        }
        run.state = success ? "completed" : "failed_run";
        run.completedAt = timestamp(now);
        if (!success && error)
            run.error = error;
        schedule.activeRunId = undefined;
        schedule.updatedAt = timestamp(now);
        store.write(schedule);
        const lockPath = path.join(store.directory(schedule.id), "active.lock");
        // A released dead run's lock may already belong to another session's newer claim.
        let holder;
        if (releaseOnly)
            try {
                holder = fs.readFileSync(lockPath, "utf-8");
            }
            catch { /* No readable lock names this run. */ }
        if (!releaseOnly || holder === run.id)
            fs.rmSync(lockPath, { force: true });
        // The schedule is already released; a history.json timeout must not leave it unarmed.
        try {
            store.writeRun(schedule, run, success ? "schedule.run.completed" : "schedule.run.failed");
            if (skipped)
                store.writeRun(schedule, skipped, "schedule.skipped_overlap");
        }
        finally {
            if (!releaseOnly)
                this.arm(schedule, store);
        }
        return schedule;
    }
    skipLostClaim(store, scheduleId, run, planned, now) {
        run.state = "skipped";
        run.completedAt = timestamp(now);
        // Losing the claim gives this snapshot no authority to change the owner.
        const latest = store.find(scheduleId);
        if (!latest) {
            this.clearTimer(store, scheduleId);
            return run;
        }
        store.writeRun(latest, run, "schedule.skipped_overlap");
        if (latest.trigger.kind === "once") {
            this.clearTimer(store, latest.id);
        }
        else {
            // The owner may hold the lock before persisting its cursor. Back off
            // locally without consuming that pending occurrence on disk.
            const next = nextRunAt(latest);
            const notBefore = next !== undefined && next <= now
                ? Date.parse(nextAfter(latest.trigger, duePlannedAt(latest, now) ?? planned, now).nextRunAt)
                : undefined;
            this.arm(latest, store, notBefore);
        }
        return run;
    }
    recordMissed(store, schedule, planned, dueReason) {
        const run = {
            schemaVersion: 1,
            id: this.randomId(),
            scheduleId: schedule.id,
            plannedAt: timestamp(planned),
            dueReason,
            state: "missed",
            completedAt: timestamp(this.now()),
        };
        schedule.trigger = nextAfter(schedule.trigger, planned, this.now());
        schedule.updatedAt = timestamp(this.now());
        store.write(schedule);
        store.writeRun(schedule, run, "schedule.missed");
        return run;
    }
    selectProject(cwd, ctx) {
        const projectCwd = path.resolve(cwd);
        const root = scheduledRunStorePath(projectCwd, undefined, this.deps.storeRoot);
        const isBoundContext = path.resolve(ctx.cwd) === projectCwd;
        const previousContext = this.contexts.get(root);
        const contextChanged = isBoundContext
            && previousContext !== undefined
            && normalizedSessionFile(previousContext.sessionManager.getSessionFile()) !== normalizedSessionFile(ctx.sessionManager.getSessionFile());
        if (isBoundContext)
            this.contexts.set(root, snapshotContext(ctx, projectCwd));
        else if (!this.contexts.has(root))
            throw new Error(`Cannot use project '${projectCwd}' until that project has been opened in this runtime.`);
        let store = this.stores.get(root);
        if (!store) {
            store = new ScheduleStore(root, this.deps.storeRoot === undefined ? projectCwd : undefined);
            this.stores.set(root, store);
            this.restore(store);
        }
        else if (contextChanged) {
            this.restore(store);
        }
        this.store = store;
    }
    resolve(params) {
        const id = params.id?.trim();
        if (!id)
            throw new Error(`${params.action} requires id.`);
        return this.requireStore().get(id);
    }
    requireStore() {
        if (!this.store)
            throw new Error("Schedule store is unavailable.");
        return this.store;
    }
    requireContext(store) {
        const ctx = this.contexts.get(store.root);
        if (!ctx)
            throw new Error("Schedule runtime context is unavailable.");
        return ctx;
    }
    activeRun(store, schedule) {
        if (!schedule.activeRunId)
            return undefined;
        return store.getRun(schedule.id, schedule.activeRunId) ?? store.history(schedule.id).find((run) => run.id === schedule.activeRunId);
    }
    /** Reconciles an attached running run (a dead runner PID becomes failed) and returns its outcome once terminal. */
    terminalAsyncOutcome(run) {
        if (run?.state !== "running" || !run.asyncDir)
            return undefined;
        const status = reconcileAsyncRun(run.asyncDir, { now: this.now, kill: this.deps.kill }).status;
        if (!status || !["complete", "failed", "stopped", "rejected"].includes(status.state))
            return undefined;
        // Stale-run repair records its reason on the failed steps, not the root status.
        const error = [status.error, ...(status.steps ?? []).map((step) => step.error)].find((value) => typeof value === "string");
        return { success: status.state === "complete", error };
    }
    timerKey(store, id) {
        return `${store.root}\0${id}`;
    }
    clearTimer(store, id) {
        const key = this.timerKey(store, id);
        const timer = this.timers.get(key);
        if (!timer)
            return;
        this.timersApi.clearTimeout(timer);
        this.timers.delete(key);
    }
    stopTimers() {
        for (const timer of this.timers.values())
            this.timersApi.clearTimeout(timer);
        this.timers.clear();
    }
}
export function createScheduledRunManager(deps) {
    return new ScheduledRunManager(deps);
}
//# sourceMappingURL=scheduled-runs.js.map