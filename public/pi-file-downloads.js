(() => {
    const tr = (zh, en) => globalThis.PiI18n?.locale?.startsWith('en') ? en : zh;
    class PiFileDownloads {
        constructor(host) { this.host = host; this.enabled = false; this.maxBytes = null; this.pending = new Set(); }
        reset() { for (const controller of this.pending) controller.abort(); this.pending.clear(); }
        async download(target) {
            if (!this.enabled) throw new Error(tr('当前后端尚未启用独立下载', 'Independent downloads are unavailable on this server'));
            const context = this.host.context(), controller = new AbortController();
            const query = target.deliveryId
                ? new URLSearchParams({ cwd: context.cwd, sessionId: context.sessionId || '', id: target.deliveryId, index: target.index })
                : new URLSearchParams({ cwd: target.root || context.cwd, path: target.path });
            const url = `/api/pi/${target.deliveryId ? 'deliverables' : 'files'}/download?${query}`;
            this.pending.add(controller);
            try {
                // HEAD reports normal authorization/size errors in the workbench.
                // GET uses the same HttpOnly cookie and repeats every server proof.
                try { await this.host.api(url, { method: 'HEAD', signal: controller.signal }); }
                catch (error) {
                    if (error.status === 413) throw new Error(this.maxBytes
                        ? tr(`文件超过下载上限（${this.maxBytes / 1024 / 1024} MiB）`, `This file exceeds the download limit (${this.maxBytes / 1024 / 1024} MiB)`)
                        : tr('文件超过服务器的下载上限', 'This file exceeds the server download limit'));
                    throw error;
                }
                const current = this.host.context();
                if (controller.signal.aborted || current.key !== context.key || current.generation !== context.generation) return;
                const frame = document.createElement('iframe'); frame.hidden = true; frame.name = 'pivane-download-' + crypto.randomUUID();
                frame.setAttribute('aria-hidden', 'true');
                const link = document.createElement('a'); link.href = url; link.target = frame.name;
                link.download = target.name || target.path?.split(/[\\/]/).at(-1) || 'download';
                document.body.append(frame, link); link.click(); link.remove();
                // Keep the frame until the download navigation has been accepted.
                frame.addEventListener('load', () => setTimeout(() => frame.remove(), 1000), { once: true });
                setTimeout(() => frame.remove(), 60000);
            } finally { this.pending.delete(controller); }
        }
    }
    globalThis.PiFileDownloads = PiFileDownloads;
})();
