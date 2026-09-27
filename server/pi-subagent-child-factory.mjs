// Version-reviewed pi-subagents child-session injection seam. Upstream owns
// launch, storage, ownership, cancellation, notifications and disposal; this
// adapter only supplies a Pi SDK ResourceLoader with Pivane's package selection.
import * as sdk from '@earendil-works/pi-coding-agent';
import { createPlacementChildSessionFactory } from '../vendor/pi-subagents/src/runs/shared/child-session.js';
import resources from './pi-bundled-resources.js';
import { managedLoaderOptions } from './pi-bundled-loader.mjs';

class ChildResourceLoader {
    constructor(input) {
        const arrays = { additionalExtensionPaths: [], additionalSkillPaths: [], additionalPromptTemplatePaths: [], additionalThemePaths: [] };
        const loader = new sdk.DefaultResourceLoader({ ...input, ...arrays,
            settingsManager: resources.settingsView(input.settingsManager, input.cwd, input.agentDir),
            noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true });
        return new Proxy(loader, { get(target, prop) {
            if (prop === 'reload') return async () => {
                await input.settingsManager.reload();
                const { options } = await managedLoaderOptions({ cwd: input.cwd, agentDir: input.agentDir, settings: input.settingsManager,
                    parsed: { noExtensions: input.noExtensions, noSkills: input.noSkills, noPromptTemplates: true, noThemes: true,
                        extensions: input.additionalExtensionPaths, skills: input.additionalSkillPaths } });
                for (const key of Object.keys(arrays)) arrays[key].splice(0, arrays[key].length, ...options[key]);
                await target.reload();
            };
            const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
        } });
    }
}
export default function childFactory() {
    return createPlacementChildSessionFactory({ loadPiCodingAgent: async () => ({ ...sdk, DefaultResourceLoader: ChildResourceLoader }) });
}
