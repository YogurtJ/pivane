const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const execute = promisify(execFile);
const MAX_BODY = 120 * 1024 * 1024;

// %{http_code} predates the newer --fail-with-body / --retry-all-errors flags.
// Read the final four bytes only, so binary bodies and status-like text survive.
function responseParts(stdout) {
    const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '');
    const tail = bytes.subarray(-4).toString('ascii');
    if (bytes.length < 4 || !/^\n\d{3}$/.test(tail)) return null;
    return { status: Number(tail.slice(1)), body: bytes.subarray(0, -4) };
}
function detail(value) {
    return (Buffer.isBuffer(value) ? value.subarray(0, 2400).toString('utf8') : String(value || '')).slice(0, 600);
}
function transportDetail(error) {
    const parts = responseParts(error.stdout);
    const body = parts ? parts.body : error.stdout;
    // execFile's message contains the full command, potentially including headers
    // and the prompt. Report response/stderr or an error code, never that command.
    return detail(body) || detail(error.stderr) || `curl 请求失败（${error.code || 'unknown'}）`;
}
function createComfyRequest({ run = execute, wait = delay } = {}) {
    return async function comfyRequest(baseUrl, requestPath, options = {}) {
        const hasBody = options.body !== undefined && options.body !== null;
        const method = String(options.method || (hasBody ? 'POST' : 'GET')).toUpperCase();
        const args = ['-q', '-sS', '--max-time', String(options.timeout || 240), '--retry', '0',
            '--write-out', '\n%{http_code}'];
        if (options.method) args.push('-X', method);
        for (const header of options.headers || []) args.push('-H', header);
        if (hasBody) args.push('--data-binary', options.body);
        args.push('--', `${baseUrl}${requestPath}`);
        const attempts = method === 'GET' ? 6 : 1;
        let lastDetail;
        for (let attempt = 0; attempt < attempts; attempt++) {
            try {
                const { stdout } = await run('curl', args, { encoding: 'buffer', maxBuffer: MAX_BODY + 4 });
                const response = responseParts(stdout);
                if (!response || response.status < 200 || response.status > 599) {
                    lastDetail = 'curl 未返回有效 HTTP 状态';
                } else if (response.status >= 400) {
                    lastDetail = `HTTP ${response.status}${response.body.length ? ': ' + detail(response.body) : ''}`;
                } else {
                    return options.binary ? response.body : response.body.toString('utf8');
                }
            } catch (error) { lastDetail = transportDetail(error); }
            // Retry read-only requests with a fresh output buffer. Never replay
            // a generation POST, even after a connection error or HTTP failure.
            if (attempt + 1 < attempts) await wait(1000);
        }
        throw new Error(`连不上 ComfyUI：${baseUrl}。请确认 RunPod Pod 还开着，并且填的是 8188 的代理地址。原始错误：${lastDetail}`);
    };
}
module.exports = { comfyRequest: createComfyRequest(), createComfyRequest };
