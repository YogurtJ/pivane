import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { readVerifiedFile } from './pi-file-bytes.js';
import { fileScope } from './pi-file-scope.js';
import { MEDIA_PLAN_ENTRY, branchPlans as plansFromBranch, mediaPlanRecord } from './pi-media-plan-format.js';

// Chat prepares one canonical plan and saves its native origin before asking
// the server to consume automatic authorization. The internal credential cannot
// access lab execution tickets; preferences and card confirmations still govern
// generation through the server's existing review/execute boundary.

const KINDS = ['image', 'video', 'tts'] as const;
const enabled = (ctx: any) => ctx.mode === 'rpc' && Boolean(process.env.PI_WEB_NAVIGATION_TOKEN && process.env.PI_WORKSPACE_INTERNAL_ORIGIN
    && process.env.PI_WORKSPACE_INTERNAL_TOKEN) && Boolean(ctx.sessionManager.getSessionFile());

async function internal(path: string, options: RequestInit = {}) {
    const origin = process.env.PI_WORKSPACE_INTERNAL_ORIGIN!;
    const response = await fetch(new URL(path, origin), { ...options, redirect: 'error',
        headers: { ...options.headers, Authorization: `Bearer ${process.env.PI_WORKSPACE_INTERNAL_TOKEN}` } });
    const data: any = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || `Pivane HTTP ${response.status}`);
    return data;
}

// Reference attachments: the Agent names an image instead of copying base64. Pivane
// stores the bytes once (content-addressed) and the card shows a thumbnail so the
// user sees exactly which image is sent before confirming.
const REFERENCE_HELP = 'For image/video parameters (reference image, image to edit, first frame) pass a reference string, never base64: '
    + '"chat-image:-1" = the latest image the user attached in this conversation (-2 the one before; 1 the first), '
    + '"chat-result:-1" = the latest generated image (legacy completion order), "chat-video:-1" = the latest generated video. '
    + 'Call media_results first to identify finished assets; prefer its stable "media-result:<plan-id>/<attempt-id>" references when choosing storyboard frames. '
    + '"file:<path>" = a PNG/JPEG/WebP (or MP4 for video) file inside the project, at most 20 MiB. Use an array for parameters with multiple:true.';
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4' };

function pick<T>(items: T[], index: number, what: string): T {
    const item = index < 0 ? items[items.length + index] : items[index - 1];
    if (!index || !item) throw new Error(items.length ? `There is no ${what} ${index}; this conversation has ${items.length}` : `This conversation has no ${what}s yet`);
    return item;
}

function branchPlans(ctx: any) {
    return plansFromBranch(ctx.sessionManager.getBranch());
}

async function resolveReferences(parameters: Record<string, unknown>, definitions: Record<string, any>, ctx: any, signal?: AbortSignal) {
    const branch = () => ctx.sessionManager.getBranch() as any[];
    const notes: string[] = [];
    const cache = new Map<string, string>();
    let chatImages: { data: string; mimeType: string; timestamp?: string }[] | null = null;
    let results: { url: string }[] | null = null;
    const upload = async (data: string) => (await internal('/api/media-agent/references', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }), signal })).ref as string;
    const one = async (value: unknown, name: string): Promise<unknown> => {
        if (typeof value !== 'string') return value;
        if (/^data:/.test(value)) throw new Error(`${name}: do not paste base64; use chat-image:-1, chat-result:-1 or file:<path>`);
        let match;
        const cacheKey = definitions[name].type + ':' + value;
        if (cache.has(cacheKey)) return cache.get(cacheKey);
        let resolved: string;
        if ((match = /^chat-image:(-?\d+)$/.exec(value))) {
            chatImages ||= branch().filter(entry => entry.type === 'message' && entry.message?.role === 'user' && Array.isArray(entry.message.content))
                .flatMap(entry => entry.message.content.filter((block: any) => block?.type === 'image' && typeof block.data === 'string')
                    .map((block: any) => ({ data: block.data, mimeType: block.mimeType, timestamp: entry.timestamp })));
            const image = pick(chatImages, Number(match[1]), 'attached image');
            if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType)) throw new Error(`${name}: ${image.mimeType} cannot be used as a reference; ask the user for PNG, JPEG or WebP`);
            resolved = await upload(`data:${image.mimeType};base64,${image.data}`);
            notes.push(`${name} = attached image ${match[1]}${image.timestamp ? ` (${image.timestamp})` : ''}`);
        } else if ((match = /^chat-result:(-?\d+)$/.exec(value))) {
            if (!results) {
                const keys = branchPlans(ctx).map(plan => plan.id);
                results = keys.length ? (await internal('/api/media-agent/chat-images', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ keys }), signal })).images : [];
            }
            resolved = pick(results!, Number(match[1]), 'generated image').url;
            notes.push(`${name} = generated image ${match[1]} (${resolved})`);
        } else if ((match = /^media-result:(plan-[0-9a-f-]{36})\/([0-9a-f-]{36})$/.exec(value))) {
            if (!branchPlans(ctx).some(plan => plan.id === match![1])) throw new Error('This media result is not in the current conversation branch');
            const data = await internal('/api/media-agent/chat-results', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ keys: [match[1]] }), signal });
            const attempt = data.requests?.[0]?.attempts?.find((item: any) => item.id === match![2] && item.status === 'done');
            if (!attempt?.asset || attempt.kind !== definitions[name].type) throw new Error('The selected result is unavailable or has the wrong media type');
            resolved = attempt.asset.url.split('?')[0]; notes.push(name + ' = ' + value);
        } else if ((match = /^chat-video:(-?\d+)$/.exec(value))) {
            const keys = branchPlans(ctx).filter(plan => plan.kind === 'video').map(plan => plan.id).slice(-100);
            const data = keys.length ? await internal('/api/media-agent/chat-results', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ keys }), signal }) : { requests: [] };
            const videos = data.requests.flatMap((item: any) => item.attempts).filter((item: any) => item.status === 'done' && item.asset?.kind === 'video')
                .sort((a: any, b: any) => String(a.finishedAt || '').localeCompare(String(b.finishedAt || '')));
            resolved = (pick(videos, Number(match[1]), 'generated video') as any).asset.url.split('?')[0];
            notes.push(name + ' = generated video ' + match[1]);
        } else if ((match = /^file:([\s\S]+)$/.exec(value))) {
            const root = await realpath(ctx.cwd);
            const scope = await fileScope({ resolveProject: () => root }, root);
            const target = path.resolve(root, match[1].trim());
            const mimeType = MIME[path.extname(target).toLowerCase()];
            if (!mimeType) throw new Error(`${name}: use a PNG, JPEG, WebP or MP4 file`);
            const { bytes } = await readVerifiedFile(target, { check: scope.check, maxBytes: 20 * 1024 * 1024 });
            resolved = await upload(`data:${mimeType};base64,${bytes.toString('base64')}`);
            notes.push(`${name} = ${path.relative(root, target) || path.basename(target)}`);
        } else return value;
        cache.set(cacheKey, resolved);
        return resolved;
    };
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(parameters || {})) {
        if (!['image', 'video'].includes(definitions[name]?.type)) { out[name] = value; continue; }
        if (Array.isArray(value)) {
            if (value.length > (definitions[name].maxItems || 8)) throw new Error('Too many reference attachments');
            const items = [];
            for (const item of value) items.push(await one(item, name));
            out[name] = items;
        } else out[name] = await one(value, name);
    }
    return { parameters: out, notes };
}

function field(definition: any) {
    const keep = ['type', 'label', 'required', 'default', 'min', 'max', 'step', 'integer', 'maxLength', 'accept', 'multiple', 'maxItems', 'role', 'description'];
    const out: any = Object.fromEntries(keep.filter(key => definition?.[key] !== undefined).map(key => [key, definition[key]]));
    if (typeof out.default === 'string' && out.default.length > 400) out.default = `${out.default.slice(0, 400)}…`;
    if (Array.isArray(definition?.choices)) out.choices = definition.choices.slice(0, 60).map((choice: any) => choice && typeof choice === 'object' ? choice.value : choice);
    return out;
}

// Presets, voice defaults and documentation links stay in the laboratory UI.
function compactModel(model: any) {
    return { id: model.id, name: model.name, kind: model.kind, executable: Boolean(model.executable), preferred: Boolean(model.preferred) || undefined,
        waiting: model.waiting,
        instructions: typeof model.instructions === 'string' ? model.instructions.slice(0, 1200) : undefined,
        parameters: Object.fromEntries(Object.entries(model.parameters || {}).map(([key, value]) => [key, field(value)])) };
}

const MAX_AUTO_PER_TURN = 4;

export function registerMediaChat(pi: ExtensionAPI) {
    let turnAuto = { count: 0 };
    pi.on('turn_start', () => { turnAuto = { count: 0 }; });
    pi.on('session_start', (_event, ctx) => {
        turnAuto = { count: 0 };
        if (!enabled(ctx)) return;
        pi.registerTool({
            name: 'media_models', label: 'Media models',
            description: 'List the image, video and speech (TTS) models the user configured in Pivane, with each model\'s parameters, defaults and requirements. Read this before media_generate.',
            promptSnippet: 'List configured image, video and speech generation models',
            parameters: Type.Object({ kind: Type.Optional(StringEnum(KINDS)) }),
            execute: async (_id, input, signal) => {
                const kinds = input.kind ? [input.kind] : [...KINDS];
                const models: any[] = [];
                for (const kind of kinds) {
                    const data = await internal(`/api/media-agent/capabilities/${kind}`, { signal });
                    models.push(...(data?.lab?.models || []).map(compactModel));
                }
                const usable = models.filter(model => model.executable);
                const attachments = usable.some(model => Object.values(model.parameters).some((item: any) => ['image', 'video'].includes(item.type)));
                return { content: [{ type: 'text', text: JSON.stringify({ models: usable, unavailable: models.filter(model => !model.executable).map(model => model.id),
                    ...(attachments ? { attachments: REFERENCE_HELP } : {}) }) }],
                    details: { count: usable.length } };
            }
        });
        pi.registerTool({
            name: 'media_results', label: 'Media results',
            description: 'Read the media cards, generation status and finished image/video/audio links in the current conversation branch. Returns stable image/video references for subsequent generations. Read this before choosing first/last frames or reusing a generated video. This only reads local state: it never submits, resumes or waits for a remote generation.',
            parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 500 })) }),
            execute: async (_id, input, signal, _update, ctx) => {
                const all = branchPlans(ctx).reverse(), offset = input.offset || 0, limit = input.limit || 10;
                const plans = all.slice(offset, offset + limit), keys = plans.map(plan => plan.id);
                const data = keys.length ? await internal('/api/media-agent/chat-results', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ keys }), signal }) : { requests: [] };
                const cards = plans.map(plan => { const attempts = data.requests.find((row: any) => row.key === plan.id)?.attempts || [];
                    return { key: plan.id, summary: plan.summary, kind: plan.kind, status: attempts.at(-1)?.status || 'not_submitted',
                        attempts: attempts.slice(-3), omittedAttempts: Math.max(0, attempts.length - 3) }; });
                return { content: [{ type: 'text', text: JSON.stringify({ cards, total: all.length,
                    nextOffset: offset + limit < all.length ? offset + limit : null,
                    note: 'Results are metadata and links, not an analysis of video contents. Unfinished cards must complete before reuse; confirmation stays in the card.' }) }], details: { count: cards.length } };
            }
        });
        pi.registerTool({
            name: 'media_generate', label: 'Generate media',
            description: 'Prepare one image, video or speech generation with a configured model (ids from media_models), including image editing / image-to-image with a reference image. Pivane validates the parameters, shows a card in this chat, and starts generation automatically when auto-execution is enabled for that media kind (enabled by default for image and speech; video requires card confirmation by default). The user can inspect parameters, edit and regenerate in the card. ' + REFERENCE_HELP,
            promptSnippet: 'Generate images, videos or speech; shows a chat card and runs automatically when enabled for that media kind',
            promptGuidelines: [
                'When the user asks for an image, video or spoken audio, call media_models, then media_generate with that model\'s declared parameters. Keep a model the user named. One call per output; several calls may be made together. Call it directly (not inside codemode) so the card appears.',
                'To edit or transform an image (image-to-image), pick a model with an image parameter (often an edit variant) and pass a reference such as "chat-image:-1" (latest image the user attached) or "chat-result:-1" (latest image a card generated); never base64. The card shows the reference thumbnail.',
                'For image-to-video, first/last frames, reference images/videos or video editing, use the selected model’s declared image/video fields, roles, multiple flag and limits. Call media_results to identify completed assets by summary/prompt, then use their stable references; do not guess frame order from completion time. A multi-stage workflow prepares images first; only prepare the video after those images exist. Video generation can take hours; report card status honestly and do not repeatedly submit or poll tools in a loop.',
                'Inspect the tool result of media_generate to see whether generation already completed, is running/queued, or is waiting for confirmation in the card (or via /confirm in WeChat). Never claim unverified media was generated, and never repeat a call to retry; the card handles edits, failures and regeneration.',
            ],
            parameters: Type.Object({
                modelId: Type.String({ maxLength: 300 }),
                summary: Type.String({ maxLength: 500, description: 'One short sentence shown on the card' }),
                parameters: Type.Record(Type.String(), Type.Unknown())
            }),
            execute: async (toolCallId, input, signal, _update, ctx) => {
                if (!enabled(ctx)) throw new Error('A persistent managed Pivane thread is required');
                const turn = turnAuto;
                let model: any;
                for (const kind of KINDS) {
                    const catalog = await internal(`/api/media-agent/capabilities/${kind}`, { signal });
                    model = catalog?.lab?.models?.find((item: any) => item.id === input.modelId);
                    if (model) break;
                }
                if (!model) throw new Error('Media model is unavailable');
                const references = await resolveReferences(input.parameters, model.parameters || {}, ctx, signal);
                // Reserve before validation can submit a paid request. Old preparations cannot
                // use a new turn's budget, and late responses only update their original turn.
                const allowAuto = turn === turnAuto && turn.count < MAX_AUTO_PER_TURN;
                if (allowAuto) turn.count++;
                const prepared = await internal('/api/media-agent/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ stage: 'prepare', toolCallId, plan: { ...input, parameters: references.parameters }, ...(allowAuto ? { autoExecute: true } : {}) }), signal });
                const plan = prepared.plan;
                signal?.throwIfAborted();
                const origin = { version: 1, toolCallId, plan };
                if (!mediaPlanRecord(origin)) throw new Error('Invalid prepared media plan');
                // appendEntry is synchronous and uses this worker's native SessionManager.
                // sendMessage would defer persistence until the streaming turn ends.
                pi.appendEntry(MEDIA_PLAN_ENTRY, origin);
                if (!(ctx.sessionManager.getBranch() as any[]).some(entry => entry.type === 'custom' && entry.customType === MEDIA_PLAN_ENTRY
                    && entry.data?.toolCallId === toolCallId && entry.data?.plan?.id === plan.id)) throw new Error('Media plan origin was not persisted');
                signal?.throwIfAborted();
                const data = await internal('/api/media-agent/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ stage: 'execute', executionToken: prepared.executionToken, planId: plan.id, toolCallId }), signal });
                const auto = data.autoExecution;
                // A lost response, failure or unknown outcome is not proof of non-execution.
                if (allowAuto && plan && (auto == null || ['not_started', 'changed', 'cancelled'].includes(auto.status))) turn.count--;
                const warnings = Array.isArray(plan.warnings) && plan.warnings.length ? ` Notes: ${plan.warnings.join(' ')}` : '';
                const used = references.notes.length ? ` References: ${references.notes.join('; ')}.` : '';
                let statusText = `Card ready for the user to confirm: ${plan.summary} (${plan.modelId}). Nothing has been generated yet.`;
                if (auto?.status === 'done' && auto.asset?.url) {
                    const ref = ['image', 'video'].includes(plan.kind) && auto.state?.attempts?.at(-1)?.id ? ` Reference: media-result:${plan.id}/${auto.state.attempts.at(-1).id}.` : '';
                    statusText = `Media generated automatically and shown on the card: ${plan.summary} (${plan.modelId}) -> ${auto.asset.url}.${ref}`;
                } else if (auto?.status === 'running' || auto?.status === 'queued') {
                    statusText = `Card created and generation started automatically (${auto.status}): ${plan.summary} (${plan.modelId}). It is still processing in the background.`;
                } else if (auto?.status === 'failed' || auto?.status === 'uncertain') {
                    statusText = `Card created and automatic generation ${auto.status}: ${plan.summary} (${plan.modelId})${auto.error ? ` — ${auto.error}` : ''}. Do not retry automatically; the user can inspect the card.`;
                }
                return { content: [{ type: 'text', text: `${statusText}${used}${warnings}` }],
                    details: { plan, ...(auto ? { autoExecution: auto } : {}) } };
            }
        });
    });
}
