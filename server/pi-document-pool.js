const { fork } = require('node:child_process');
const path = require('node:path');
const { fail } = require('./pi-file-scope');
class DocumentParserPool {
    constructor({ timeout = 20000, maximum = 2 } = {}) { this.timeout = timeout; this.maximum = maximum; this.jobs = new Set(); this.closed = false; }
    async run(bytes, format, input = {}, { signal, validateOnly = false } = {}) {
        if (this.closed) throw fail('文档服务正在关闭', 503, 'DOCUMENT_BUSY');
        if (this.jobs.size >= this.maximum) throw fail('文档读取正在进行，请稍后再试', 429, 'DOCUMENT_BUSY');
        signal?.throwIfAborted();
        // Reserve synchronously before process launch. Keep the slot until exit,
        // including abort, timeout, IPC errors and early HTTP disconnects.
        const job = {}; this.jobs.add(job);
        job.promise = new Promise((resolve, reject) => {
            let child, timer, result, failure;
            const cancel = () => { failure ||= fail('文档读取已取消', 499, 'DOCUMENT_ABORTED'); child?.kill(); };
            try {
                child = fork(path.join(__dirname, 'pi-document-worker.js'), [], {
                    execArgv: ['--max-old-space-size=192'], serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
                    // Parser receives no model credentials, user config, proxy or
                    // project environment. NODE_OPTIONS cannot inject extensions.
                    env: { ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}), LANG: 'C.UTF-8' }
                });
            } catch { this.jobs.delete(job); reject(fail('无法启动文档读取进程', 503, 'DOCUMENT_PARSER')); return; }
            child.once('message', message => {
                if (message?.error) failure ||= fail(String(message.error).slice(0, 1000), message.status || 415, message.code);
                else if (message?.result) result = message.result;
                else failure ||= fail('文档读取结果无效', 502, 'DOCUMENT_PARSER');
            });
            child.once('error', () => { failure ||= fail('文档读取进程失败', 503, 'DOCUMENT_PARSER'); child.kill(); });
            child.once('exit', (code, exitSignal) => {
                clearTimeout(timer); signal?.removeEventListener('abort', cancel); this.jobs.delete(job);
                if (failure) reject(failure);
                else if (code !== 0 || exitSignal || !result) reject(fail('文档读取失败或超过内存预算，请缩小文件', 413, 'DOCUMENT_LIMIT'));
                else resolve(result);
            });
            timer = setTimeout(() => { failure ||= fail('文档读取超过 20 秒预算，请缩小文件', 413, 'DOCUMENT_TIMEOUT'); child.kill(); }, this.timeout);
            signal?.addEventListener('abort', cancel, { once: true });
            if (signal?.aborted) cancel();
            child.send({ bytes, format, input, validateOnly }, error => { if (error) { failure ||= fail('文档读取进程不可用', 503, 'DOCUMENT_PARSER'); child.kill(); } });
        });
        return job.promise;
    }
    async dispose() { this.closed = true; await Promise.allSettled([...this.jobs].map(job => job.promise)); }
}
module.exports = { DocumentParserPool };
