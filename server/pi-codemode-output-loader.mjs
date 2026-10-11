// Exact import seam, not an upstream source rewrite. Only the reviewed lazy
// executor's sandbox import is redirected; schema/renderer/SDK imports stay native.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const hostEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
const hostRoot = path.dirname(path.dirname(hostEntry));
const executor = path.join(hostRoot, 'dist/extensions/codemode/execute.js');
const executorURL = pathToFileURL(executor).href;
const sandboxURL = import.meta.resolve('@earendil-works/pi-codemode');
const sandboxRoot = path.dirname(path.dirname(fileURLToPath(sandboxURL)));
const replacement = new URL('./pi-codemode-output.mjs', import.meta.url).href;
const reviewedExecutorSHA256 = '503de1c907882c0ee032ad83a30966f3edc095acf611f569bea573aec9730381';

export function verifyCodemodeOutputHost(host, sandbox, source, resolvedURL) {
    if (host?.name !== '@earendil-works/pi-coding-agent' || host.version !== '1.1.0'
        || sandbox?.name !== '@earendil-works/pi-codemode' || sandbox.version !== host.version
        || resolvedURL !== sandboxURL
        || createHash('sha256').update(source).digest('hex') !== reviewedExecutorSHA256) {
        throw new Error('Unreviewed Pi Codemode output host; version, executor bytes or sandbox resolution changed.');
    }
}

registerHooks({ resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (context.parentURL !== executorURL || specifier !== '@earendil-works/pi-codemode') return resolved;
    verifyCodemodeOutputHost(JSON.parse(fs.readFileSync(path.join(hostRoot, 'package.json'), 'utf8')),
        JSON.parse(fs.readFileSync(path.join(sandboxRoot, 'package.json'), 'utf8')), fs.readFileSync(executor), resolved.url);
    if (fs.realpathSync.native(executor) !== executor || fs.realpathSync.native(fileURLToPath(resolved.url)) !== fileURLToPath(resolved.url)) {
        throw new Error('Pi Codemode output seam requires physical package paths.');
    }
    return { ...resolved, url: replacement };
} });
