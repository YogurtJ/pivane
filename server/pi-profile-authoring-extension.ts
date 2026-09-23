import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { readProfileAuthoring, validateProposal, DRAFT_ENTRY } from './pi-profile-authoring.js';
import scope from './profile-memory/scope.js';

export function registerProfileAuthoring(pi: ExtensionAPI, getAgentDir: () => string) {
    let input: any = null;
    try { input = JSON.parse(process.env.PIVANE_PROFILE_AUTHORING_CONTEXT || 'null'); } catch { /* inert */ }
    let activeIdentity: any = null;
    const eligible = (ctx: any) => {
        try {
            if (!process.env.PI_WEB_NAVIGATION_TOKEN || ctx.mode !== 'rpc' || input?.version !== 1
                || ctx.cwd !== input.cwd || ctx.sessionManager.getCwd() !== input.cwd
                || ctx.sessionManager.getSessionId() !== input.sessionId
                || fs.realpathSync.native(ctx.sessionManager.getSessionFile()) !== input.sessionPath
                || fs.realpathSync.native(input.sessionPath) !== input.sessionPath
                || !input.sessionPath.startsWith(path.join(fs.realpathSync.native(getAgentDir()), 'sessions') + path.sep)) return false;
            const marker = readProfileAuthoring(ctx.sessionManager);
            return Boolean(marker && marker.profileId === input.profileId && marker.profileRevision === input.profileRevision
                && activeIdentity && scope.sameActiveFile(input.sessionPath, activeIdentity));
        } catch { return false; }
    };
    pi.on('before_agent_start', (event: any, ctx: any) => {
        if (!eligible(ctx)) return;
        return { systemPrompt: event.systemPrompt + '\n\nYou are drafting an assistant profile, not editing it. Ask for missing facts, do not invent user identity or memories. Use profile_draft only to submit a bounded proposal after discussion. No profile files, settings or credentials may be changed as part of drafting. The user decides whether to import the proposal in the editor and explicitly save it.' };
    });
    pi.on('session_start', (_event: any, ctx: any) => {
        if (!process.env.PI_WEB_NAVIGATION_TOKEN || ctx.mode !== 'rpc' || input?.version !== 1
            || ctx.cwd !== input.cwd || ctx.sessionManager.getSessionId() !== input.sessionId
            || ctx.sessionManager.getSessionFile() !== input.sessionPath
            || readProfileAuthoring(ctx.sessionManager)?.profileRevision !== input.profileRevision) return;
        const agentDir = fs.realpathSync.native(getAgentDir());
        activeIdentity = scope.verifyNativeSession({ sessionId: input.sessionId, cwd: input.cwd, profileId: null,
            sessionPath: input.sessionPath, sessionsRoot: path.join(agentDir, 'sessions') }, ctx.sessionManager);
        if (!eligible(ctx)) return;
        pi.registerTool({ name: 'profile_draft', label: 'Profile draft',
            description: 'Record a proposed assistant profile for optional user review. Read-only planning: never saves profile settings or memory.',
            parameters: Type.Object({
                name: Type.Optional(Type.String({ maxLength: 80 })),
                description: Type.Optional(Type.String({ maxLength: 500 })),
                soul: Type.Optional(Type.String({ maxLength: 32768 })),
                user: Type.Optional(Type.String({ maxLength: 32768 })),
                memory: Type.Optional(Type.String({ maxLength: 65536 })),
            }, { additionalProperties: false }),
            execute: async (_id: string, params: any, signal: AbortSignal, _update: any, context: any) => {
                if (!eligible(context)) throw new Error('Profile drafting session unavailable');
                signal?.throwIfAborted();
                const proposal = validateProposal(params);
                const entry = { version: 1, sessionId: input.sessionId, id: randomUUID(), proposal };
                pi.appendEntry(DRAFT_ENTRY, entry);
                return { content: [{ type: 'text' as const, text: 'Draft recorded for review. No profile changes were saved.' }], details: { profileDraft: entry.id } };
            },
        });
    });
}
