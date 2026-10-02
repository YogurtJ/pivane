import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerModelSpeed } from './pi-model-speed-extension.mjs';
export default function (pi: ExtensionAPI) {
    registerModelSpeed(pi, { agentDir: getAgentDir(), preserveExisting: false });
}
