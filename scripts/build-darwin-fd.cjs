// Rebuild the distributable macOS backend on a Mac with Node 22 headers and Xcode Command Line Tools.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
if (process.platform !== 'darwin') throw new Error('Build this backend on macOS; Linux uses /proc directly');
const root = path.resolve(__dirname, '..'), directory = path.join(root, 'native');
const headers = fs.realpathSync(process.env.PI_NODE_HEADERS || path.resolve(path.dirname(process.execPath), '../include/node'));
if (!fs.statSync(path.join(headers, 'node_api.h')).isFile()) throw new Error('Node-API headers are required');
const source = path.join(directory, 'pi-darwin-fd.c'), output = path.join(directory, 'pi-darwin-fd.node');
const temporary = output + '.' + process.pid + '.tmp';
const flags = ['-O2', '-Wall', '-Wextra', '-Werror', '-std=c11', '-DNAPI_VERSION=8', '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=11.0', '-bundle', '-undefined', 'dynamic_lookup'];
try {
    execFileSync('/usr/bin/xcrun', ['clang', ...flags, '-I', headers, source, '-o', temporary], { stdio: 'inherit' });
    const architectures = execFileSync('/usr/bin/lipo', ['-archs', temporary], { encoding: 'utf8' }).trim().split(/\s+/).sort();
    if (architectures.join(',') !== 'arm64,x86_64') throw new Error('Expected a universal macOS binary');
    fs.renameSync(temporary, output);
    const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    fs.writeFileSync(path.join(directory, 'darwin-fd-manifest.json'), JSON.stringify({ version: 1, napi: 8, minimumMacOS: '11.0', architectures,
        sourceSha256: hash(source), binarySha256: hash(output), builtWithNode: process.version,
        compiler: execFileSync('/usr/bin/xcrun', ['clang', '--version'], { encoding: 'utf8' }).split('\n')[0], flags }, null, 2) + '\n');
    console.log('Built and recorded macOS universal descriptor-path backend');
} finally { fs.rmSync(temporary, { force: true }); }
