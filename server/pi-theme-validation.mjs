// Pi's CLI opts in before discovering resources; SDK hosts must do the
// same. These are exports of pinned native modules, not package subpath APIs.
// Keep this import seam under version review when upgrading the host Pi.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import reviewedHost from './pi-reviewed-host.js';

let initialization;
async function installNativeValidator() {
    const piRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../node_modules/@earendil-works/pi-coding-agent');
    const metadata = JSON.parse(await fs.readFile(path.join(piRoot, 'package.json'), 'utf8'));
    if (metadata.name !== '@earendil-works/pi-coding-agent' || metadata.version !== reviewedHost.REVIEWED_PI_VERSION) {
        throw new Error(`Native theme validation requires the reviewed Pi ${reviewedHost.REVIEWED_PI_VERSION} host package`);
    }
    const directory = path.join(piRoot, 'dist/modes/interactive/theme');
    const [theme, schema] = await Promise.all([
        import(pathToFileURL(path.join(directory, 'theme.js')).href),
        import(pathToFileURL(path.join(directory, 'theme-schema.js')).href)
    ]);
    if (typeof theme.setThemeJsonValidator !== 'function' || typeof schema.validateThemeJson !== 'function') {
        throw new Error('Native theme validation exports are unavailable');
    }
    theme.setThemeJsonValidator(schema.validateThemeJson);
}

// Await before managedLoaderOptions/createAgentSessionServices can discover themes.
export function initializeNativeThemeValidation() {
    return initialization ||= installNativeValidator();
}
