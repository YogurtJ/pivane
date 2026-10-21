import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { askUserQuestion } from './pi-user-question.js';

export function registerUserQuestion(pi: ExtensionAPI) {
    let pending = false;
    pi.on('session_start', (_event, ctx) => {
        if (ctx.mode !== 'rpc' || !process.env.PI_WEB_NAVIGATION_TOKEN) return;
        pi.registerTool({
            name: 'ask_user_question', label: 'Ask user', exposure: 'model-only',
            description: 'Ask the user 1–4 questions in the Pivane Web UI and wait for their explicit answers. Each question may offer 2–8 options (label plus optional one-line description); the user can also type their own answer unless allowCustom is false, or skip a question. Omit options for a free-text question. The user answers all questions in one panel and submits once. Cancellation, timeout, stopping and unavailable UI return distinct statuses with no answers. Default timeout: 10 minutes for the whole call; maximum: 30 minutes.',
            promptSnippet: 'Ask the user 1–4 short questions, each with optional choices',
            promptGuidelines: [
                'Use ask_user_question when a meaningful user decision or missing information blocks progress. Group related questions into one call (at most 4). Prefer 2–4 concise, mutually exclusive options and put the recommended option first; continue independent work when possible.',
                'Honor decisions and authorization already given. Do not ask again for routine, reversible work that is already authorized.',
                'Only status answered supplies user answers; a skipped question has answer null and grants no default. Cancellation, timeout, aborted and unavailable never imply consent or a default choice. Do not automatically repeat a cancelled or timed-out question.'
            ],
            parameters: Type.Object({
                questions: Type.Array(Type.Object({
                    question: Type.String({ minLength: 1, maxLength: 1000, description: 'Complete question text shown to the user. Must be unique within the call.' }),
                    header: Type.Optional(Type.String({ maxLength: 24, description: 'Very short topic label shown above the question, for example "Style".' })),
                    options: Type.Optional(Type.Array(Type.Object({
                        label: Type.String({ minLength: 1, maxLength: 120, description: 'Concise choice text returned as the answer.' }),
                        description: Type.Optional(Type.String({ maxLength: 240, description: 'Optional one-line explanation of the choice.' }))
                    }), { minItems: 2, maxItems: 8 })),
                    allowCustom: Type.Optional(Type.Boolean({ description: 'Allow a typed answer besides the options. Default true.' })),
                    placeholder: Type.Optional(Type.String({ maxLength: 120, description: 'Hint for the typed answer field.' }))
                }), { minItems: 1, maxItems: 4 }),
                timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 1800000 }))
            }),
            execute: async (_id, input, signal, _update, context) => {
                if (pending) throw new Error('A user question is already awaiting an answer in this thread');
                pending = true;
                try {
                    const result = await askUserQuestion(input, context, signal);
                    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: { pivaneQuestion: result } };
                } finally { pending = false; }
            }
        });
    });
}
