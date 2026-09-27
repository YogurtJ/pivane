import { fileURLToPath } from 'node:url';
import * as sdk from '@earendil-works/pi-coding-agent';
import bundled from './pi-bundled-resources.js';

// Build the same native resource inventory used by Settings, then let Pi load
// only selected paths. Filtering happens before any third-party factory runs.
export async function managedLoaderOptions({ cwd, agentDir, settings, parsed }) {
    const { resolved, settingsView } = await bundled.resolveManagedResources(sdk, { cwd, agentDir, settings });
    const paths = type => resolved[type].filter(item => item.enabled).map(item => item.path);
    const explicit = values => (values || []).filter(file => {
        const entry = bundled.identify(file, cwd);
        if (!entry) return true;
        return entry.mode === 'package' && bundled.packageAt(file)?.root === fileURLToPath(new URL('../vendor/' + entry.name, import.meta.url));
    });
    const extensionPath = file => file === fileURLToPath(new URL('../vendor/pi-subagents/index.js', import.meta.url))
        ? fileURLToPath(new URL('./pi-bundled-subagents.mjs', import.meta.url)) : file;
    return { settingsView, options: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        noContextFiles: parsed.noContextFiles, systemPrompt: parsed.systemPrompt, appendSystemPrompt: parsed.appendSystemPrompt,
        additionalExtensionPaths: [...explicit(parsed.extensions), ...(parsed.noExtensions ? [] : paths('extensions'))].map(extensionPath),
        additionalSkillPaths: [...explicit(parsed.skills), ...(parsed.noSkills ? [] : paths('skills'))],
        additionalPromptTemplatePaths: [...explicit(parsed.promptTemplates), ...(parsed.noPromptTemplates ? [] : paths('prompts'))],
        additionalThemePaths: [...explicit(parsed.themes), ...(parsed.noThemes ? [] : paths('themes'))],
    } };
}
export function reloadableLoader(loader, input, initialOptions) {
    return new Proxy({}, { get(_target, prop) {
        if (prop === 'reload') return async () => {
            await input.settings.reload();
            const { options } = await managedLoaderOptions(input);
            // Keep the native loader and its reload/cache lifecycle. These are the
            // resource arrays supplied by this adapter to its public constructor.
            for (const key of ['additionalExtensionPaths', 'additionalSkillPaths', 'additionalPromptTemplatePaths', 'additionalThemePaths']) {
                initialOptions[key].splice(0, initialOptions[key].length, ...options[key]);
            }
            await loader.reload();
        };
        const value = loader[prop]; return typeof value === 'function' ? value.bind(loader) : value;
    } });
}
