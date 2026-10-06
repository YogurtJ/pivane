import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';

// Chat is the main media entry: the Agent prepares one request, Pivane shows a
// confirmation card in the conversation and the user starts the paid generation
// there. These tools only read the model catalog and validate a plan through the
// planning-only internal credential; they cannot create or execute a ticket.

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

function field(definition: any) {
    const keep = ['type', 'label', 'required', 'default', 'min', 'max', 'step', 'integer', 'maxLength', 'accept', 'multiple', 'maxItems'];
    const out: any = Object.fromEntries(keep.filter(key => definition?.[key] !== undefined).map(key => [key, definition[key]]));
    if (typeof out.default === 'string' && out.default.length > 400) out.default = `${out.default.slice(0, 400)}…`;
    if (Array.isArray(definition?.choices)) out.choices = definition.choices.slice(0, 60).map((choice: any) => choice && typeof choice === 'object' ? choice.value : choice);
    return out;
}

// Presets, voice defaults and documentation links stay in the laboratory UI.
function compactModel(model: any) {
    return { id: model.id, name: model.name, kind: model.kind, executable: Boolean(model.executable), preferred: Boolean(model.preferred) || undefined,
        instructions: typeof model.instructions === 'string' ? model.instructions.slice(0, 1200) : undefined,
        parameters: Object.fromEntries(Object.entries(model.parameters || {}).map(([key, value]) => [key, field(value)])) };
}

export function registerMediaChat(pi: ExtensionAPI) {
    pi.on('session_start', (_event, ctx) => {
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
                return { content: [{ type: 'text', text: JSON.stringify({ models: usable, unavailable: models.filter(model => !model.executable).map(model => model.id) }) }],
                    details: { count: usable.length } };
            }
        });
        pi.registerTool({
            name: 'media_generate', label: 'Generate media',
            description: 'Prepare one image, video or speech generation with a configured model (ids from media_models). Pivane validates the parameters and shows the user a card in this chat; nothing is generated or charged until the user confirms that card. The user can edit parameters and regenerate in the card.',
            promptSnippet: 'Generate images, videos or speech; the user confirms a card in this chat',
            promptGuidelines: [
                'When the user asks for an image, video or spoken audio, call media_models, then media_generate with that model\'s declared parameters. Keep a model the user named. One call per output; several calls may be made together. Call it directly (not inside codemode) so the card appears.',
                'media_generate does not run the generation. After calling it, tell the user briefly what the card will generate and that they confirm it in the card. Never claim media was generated, and never repeat a call to retry; the card handles edits, failures and regeneration.',
            ],
            parameters: Type.Object({
                modelId: Type.String({ maxLength: 300 }),
                summary: Type.String({ maxLength: 500, description: 'One short sentence shown on the card' }),
                parameters: Type.Record(Type.String(), Type.Unknown())
            }),
            execute: async (_id, input, signal, _update, ctx) => {
                if (!enabled(ctx)) throw new Error('A persistent managed Pivane thread is required');
                const data = await internal('/api/media-agent/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ kind: '', plan: input }), signal });
                const plan = data.plan;
                const warnings = Array.isArray(plan.warnings) && plan.warnings.length ? ` Notes: ${plan.warnings.join(' ')}` : '';
                return { content: [{ type: 'text', text: `Card ready for the user to confirm: ${plan.summary} (${plan.modelId}). Nothing has been generated yet.${warnings}` }],
                    details: { plan } };
            }
        });
    });
}
