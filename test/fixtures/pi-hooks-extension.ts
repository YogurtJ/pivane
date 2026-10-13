import fs from 'node:fs';
import { getAgentDir, VERSION } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { registerCron } from '../../server/pi-cron-runtime.js';
import { registerModelSpeed } from '../../server/pi-model-speed-extension.mjs';
import { registerToolProvenance } from '../../server/pi-tool-provenance.js';
import { registerAgentThreads, launchAgentTask } from '../../server/pi-agent-threads-extension.ts';
import { registerAgentMessages } from '../../server/pi-agent-messages-extension.ts';
import { receiveAgentMessages } from '../../server/pi-agent-message-format.js';
import { registerExtensionAssistant } from '../../server/pi-extension-assistant-extension.ts';
import { registerAgentProfile } from '../../server/pi-profile-runtime.js';
import { registerAssistantProject } from '../../server/pi-assistant-project-runtime.js';
import { registerProfileAuthoring } from '../../server/pi-profile-authoring-extension.ts';
import { registerProfileMemory } from '../../server/profile-memory/extension.ts';

// Explicitly loaded by the isolated native RPC fixture; no managed sibling adapters.
export default async function (pi) {
    const controlFile = process.env.PIVANE_HOOK_FIXTURE_CONTROL!;
    const ownedPi = new Proxy(pi, { get(target, key) {
        if (key !== 'on') return Reflect.get(target, key);
        return (name, handler) => pi.on(name, (event, ctx) => {
            if (name === 'before_agent_start') {
                if (event.messageType === 'custom') Object.defineProperty(event, 'prompt', {
                    get() { throw new Error('Custom wakes have no user prompt'); },
                });
                Object.defineProperty(event, 'systemPrompt', { get() { throw new Error('Owned hooks must preserve native sections'); } });
            }
            return handler(event, ctx);
        });
    } });
    pi.on('before_agent_start', event => {
        if (fs.existsSync(controlFile + '.force')) event.systemPromptOptions.forceSystemPrompt = 'EXACT FORCED PREFIX';
    });
    const cron = registerCron(ownedPi);
    registerModelSpeed(ownedPi, { agentDir: getAgentDir() });
    registerToolProvenance(ownedPi);
    registerExtensionAssistant(ownedPi);
    registerAgentThreads(ownedPi);
    registerAgentMessages(ownedPi);
    registerAgentProfile(ownedPi, getAgentDir);
    registerAssistantProject(ownedPi, getAgentDir);
    registerProfileAuthoring(ownedPi, getAgentDir);
    await registerProfileMemory(ownedPi);
    pi.on('before_agent_start', async (event, ctx) => {
        ctx.ui.notify(JSON.stringify({ hookFixture: 'start', version: VERSION,
            messageType: event.messageType, customType: event.messageType === 'custom' ? event.message.customType : null,
            sections: Object.keys(event.systemPromptOptions.sections), forced: event.systemPromptOptions.forceSystemPrompt !== undefined }));
        if (fs.existsSync(controlFile)) {
            const deadline = Date.now() + 10000;
            while (fs.existsSync(controlFile)) {
                if (Date.now() > deadline) throw new Error('Slow hook fixture was not released');
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }
    });
    pi.registerTool({ name: 'fixture_switch', label: 'Fixture loadout switch', description: 'Synthetic loadout change',
        parameters: Type.Object({}), execute: async () => {
            pi.setActiveTools(pi.getActiveTools().filter(name => name !== 'read'));
            return { content: [{ type: 'text', text: 'LOADOUT CHANGED' }], details: {} };
        } });
    pi.registerCommand('hook_fixture', { description: 'Synthetic hooks fixture control', handler: async (raw, ctx) => {
        const input = JSON.parse(raw);
        if (input.action === 'task') launchAgentTask(pi, ctx, input.requestId);
        else if (input.action === 'wake') receiveAgentMessages(pi, ctx, { messages: input.messages });
        else if (input.action === 'cron') await cron(ctx, input.input);
        else if (input.action === 'nextTurn') pi.sendMessage({ customType: 'fixture-next-turn', content: 'NEXT TURN CONTEXT', display: false }, { deliverAs: 'nextTurn', triggerTurn: false });
        else if (input.action === 'custom') pi.sendMessage({ customType: 'fixture-custom', content: input.text, display: false }, { triggerTurn: true, deliverAs: input.deliverAs });
        else throw new Error('Unknown hook fixture action');
    } });
}
