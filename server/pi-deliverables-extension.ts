import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { ENTRY, references, DeliverableStore } from './pi-deliverables.js';
import { PiSessionStore } from './pi-session-store.js';

export function registerDeliverables(pi: ExtensionAPI) {
    let objects: any;
    const enabled = (ctx: any) => ctx.mode === 'rpc' && Boolean(process.env.PI_WEB_NAVIGATION_TOKEN) && Boolean(ctx.sessionManager.getSessionFile());
    pi.on('session_start', (_event, ctx) => {
        if (!enabled(ctx)) return;
        objects ||= new DeliverableStore(new PiSessionStore());
        pi.registerTool({
            name: 'deliver_files', label: 'Deliver files',
            description: 'Publish explicitly requested task deliverables as immutable, private Pivane snapshots and return browser-openable links. Up to 20 files, 16 MiB each, 64 MiB total. Preserves originals. Supply a stable requestId; retry only that same ID after an uncertain response. Defaults to current project; sourceRoot is an explicit allowed external source directory for authorized task outputs, never for credentials or unrelated files.',
            promptSnippet: 'Publish task deliverables with stable browser preview and download links',
            promptGuidelines: [
                'When handing over generated documents, images or self-contained HTML, use deliver_files and include its returned links in the final reply. Server paths alone are not downloadable links.',
                'Publish only files the user asked to receive or outputs produced for the authorized task. Do not publish secrets, unrelated private material, or whole directories. An external sourceRoot does not expand the task authorization.',
                'HTML previews run in a restricted iframe, not the workbench DOM. Self-contained HTML, PDF, CSV/TSV, SVG and supported audio can be previewed; package-dependent pages are not supported. Downloads preserve original bytes.'
            ],
            parameters: Type.Object({
                requestId: Type.String({ minLength: 1, maxLength: 160 }),
                title: Type.String({ minLength: 1, maxLength: 160 }),
                files: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 1, maxItems: 20 }),
                sourceRoot: Type.Optional(Type.String({ maxLength: 4096 }))
            }),
            execute: async (_id, input, signal, _update, context) => {
                if (!enabled(context)) throw new Error('A persistent managed Pivane thread is required');
                const sessionId = context.sessionManager.getSessionId(), sessionFile = context.sessionManager.getSessionFile();
                const result = await objects.publish({ cwd: context.cwd, sessionId }, input, signal);
                if (sessionId !== context.sessionManager.getSessionId() || sessionFile !== context.sessionManager.getSessionFile()) throw new Error('Session changed; inspect the original requestId');
                // The managed worker alone appends native branch state. Snapshots
                // without this entry are not accessible through the browser API.
                if (!references(context.sessionManager.getBranch()).some((ref: any) => ref.id === result.reference.id)) pi.appendEntry(ENTRY, result.reference);
                return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { pivaneDeliverable: result } };
            }
        });
    });
}
