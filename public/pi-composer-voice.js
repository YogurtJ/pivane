(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const node = (tag, text) => { const n = document.createElement(tag); if (text) n.textContent = text; return n; };
    const stopTracks = stream => stream?.getTracks().forEach(track => track.stop());
    function wav(chunks, rate) {
        const count = chunks.reduce((sum, chunk) => sum + chunk.length, 0), input = new Float32Array(count);
        let at = 0; for (const chunk of chunks) { input.set(chunk, at); at += chunk.length; }
        const frames = Math.floor(count * 16000 / rate), buffer = new ArrayBuffer(44 + frames * 2), view = new DataView(buffer);
        const text = (at, value) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
        text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
        view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
        view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
        text(36, 'data'); view.setUint32(40, frames * 2, true);
        for (let i = 0; i < frames; i++) {
            const start = Math.floor(i * rate / 16000), end = Math.min(count, Math.max(start + 1, Math.floor((i + 1) * rate / 16000)));
            let value = 0; for (let j = start; j < end; j++) value += input[j];
            value = Math.max(-1, Math.min(1, value / (end - start)));
            view.setInt16(44 + i * 2, value * (value < 0 ? 32768 : 32767), true);
        }
        return new Blob([buffer], { type: 'audio/wav' });
    }
    const base64 = blob => new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error(translateUi("无法读取录音"))); reader.readAsDataURL(blob);
    });
    class PiComposerVoice {
        constructor(host) {
            this.host = host; this.button = document.getElementById('pi-transcribe-button'); this.settings = document.getElementById('pi-transcribe-settings');
            this.enabled = false; this.phase = 'idle'; this.epoch = 0;
            this.bar = node('section'); this.bar.className = 'pi-voice-bar'; this.bar.id = 'pi-voice-bar'; this.bar.hidden = true;
            this.bar.setAttribute('aria-label', translateUi("语音转录"));
            this.models = node('select'); this.models.id = 'pi-voice-model'; this.models.setAttribute('aria-label', translateUi("转录模型"));
            this.message = node('p'); this.message.setAttribute('role', 'status'); this.message.setAttribute('aria-live', 'polite');
            this.result = node('textarea'); this.result.id = 'pi-voice-result'; this.result.hidden = true; this.result.setAttribute('aria-label', translateUi("转录文字"));
            this.file = node('input'); this.file.type = 'file'; this.file.accept = '.wav,.mp3,audio/wav,audio/mpeg'; this.file.hidden = true;
            this.upload = this.action(translateUi("转录音频文件"), () => this.file.click());
            this.record = this.action(translateUi("开始录音"), () => this.toggle());
            this.use = this.action(translateUi("加入当前草稿"), () => this.insert()); this.use.hidden = true;
            this.copy = this.action(translateUi("复制文字"), () => this.host.copy(this.result.value)); this.copy.hidden = true;
            this.close = this.action(translateUi("收起"), () => { this.cancel(); this.bar.hidden = true; this.button.focus(); });
            this.bar.append(this.models, this.record, this.upload, this.close, this.message, this.result, this.use, this.copy, this.file);
            document.getElementById('pi-attachments').before(this.bar);
            this.button.addEventListener('click', () => this.toggle());
            this.settings.querySelector('span').textContent = translateUi("语音转录设置");
            this.settings.addEventListener('click', () => this.open());
            this.models.addEventListener('change', () => { try { localStorage.setItem('pi.web.transcriptionModel', this.models.value); } catch {} });
            this.file.addEventListener('change', () => {
                const file = this.file.files[0]; this.file.value = ''; if (!file) return;
                if (!/\.(wav|mp3)$/i.test(file.name) || file.size > 7_500_000) return this.status(translateUi("请选择 WAV / MP3 音频，最大 7.5MB"));
                this.submit(file, /\.mp3$/i.test(file.name) ? 'mp3' : 'wav', this.host.context());
            });
            window.addEventListener('pagehide', () => this.cancel());
            document.addEventListener('visibilitychange', () => { if (document.hidden && ['permission', 'recording'].includes(this.phase)) this.cancel(); });
            this.sync();
        }
        action(text, fn) { const b = node('button', text); b.type = 'button'; b.addEventListener('click', fn); return b; }
        status(text) { this.message.textContent = text; this.bar.hidden = false; }
        async setEnabled(value) { this.enabled = value; this.sync(); if (value) await this.load(); }
        async load() {
            if (this.loading) return this.loading;
            this.loading = (async () => {
                try {
                    const data = await this.host.api('/api/pi/composer/transcription');
                    if (!this.enabled) return;
                    this.catalog = data; let preferred;
                    try { preferred = localStorage.getItem('pi.web.transcriptionModel'); } catch {}
                    this.models.replaceChildren(...(data.models || []).map(model => { const option = node('option', model.name); option.value = model.id; return option; }));
                    if ((data.models || []).some(model => model.id === preferred)) this.models.value = preferred;
                } catch (error) { this.status(translateUi(error.message)); }
                finally { this.loading = null; this.sync(); }
            })();
            return this.loading;
        }
        async open() {
            this.bar.hidden = false;
            if (this.phase !== 'idle') return;
            await this.load();
            this.status(this.models.options.length ? translateUi("录音或选择音频后，将上传至所选模型转录；文字可编辑后发送。") : translateUi("没有可用的转录模型，请先配置 MiMo 或 OpenAI 兼容语音供应商。"));
            this.models.focus();
        }
        sync() {
            const context = this.host.context();
            if (['permission', 'recording'].includes(this.phase) && (!context.connected || this.origin?.key !== context.key || this.origin?.generation !== context.generation)) this.cancel();
            this.button.hidden = !this.enabled; this.settings.hidden = !this.enabled;
            this.button.disabled = !this.enabled || !context.connected || context.submitting || this.phase === 'transcribing' || this.phase === 'permission';
            this.button.dataset.recording = String(this.phase === 'recording');
            this.button.title = this.phase === 'recording' ? translateUi("结束录音并转录") : this.phase === 'transcribing' ? translateUi("正在转录…") : translateUi("语音转录");
            this.button.setAttribute('aria-label', this.button.title); this.button.setAttribute('aria-pressed', String(this.phase === 'recording'));
            this.button.querySelector('i').className = this.phase === 'recording' ? 'fa-solid fa-stop' : this.phase === 'transcribing' ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-microphone';
            const busy = this.phase !== 'idle';
            this.models.disabled = busy;
            this.upload.disabled = busy || !this.models.options.length || !context.connected || context.submitting;
            this.record.disabled = this.button.disabled;
            this.record.textContent = this.phase === 'recording' ? translateUi("结束录音并转录") : translateUi("开始录音");
            this.close.textContent = ['permission', 'recording'].includes(this.phase) ? translateUi("取消录音") : translateUi("收起");
            this.use.disabled = !context.connected || context.submitting;
        }
        async toggle() {
            if (this.phase === 'recording') return this.finish();
            if (this.phase !== 'idle') return;
            if (!this.catalog || !this.models.options.length) { await this.open(); return; }
            if (!this.host.context().connected || this.host.context().submitting) return;
            const Audio = window.AudioContext || window.webkitAudioContext;
            if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !Audio) { this.status(translateUi("麦克风需要 HTTPS 或 localhost；也可以选择 WAV / MP3 音频转录。")); return; }
            this.origin = { ...this.host.context() }; const epoch = ++this.epoch;
            this.phase = 'permission'; this.status(translateUi("正在请求麦克风权限…")); this.sync();
            try {
                // Construct/resume within the user gesture, before permission awaits (Safari).
                this.audio = new Audio(); await this.audio.resume();
                if (epoch !== this.epoch) return;
                const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
                if (epoch !== this.epoch) { stopTracks(stream); return; }
                this.stream = stream; this.chunks = []; this.samples = 0; this.rate = this.audio.sampleRate;
                this.source = this.audio.createMediaStreamSource(stream); this.processor = this.audio.createScriptProcessor(4096, 1, 1);
                this.processor.onaudioprocess = event => {
                    if (this.phase !== 'recording') return;
                    const chunk = event.inputBuffer.getChannelData(0), room = Math.max(0, this.rate * 120 - this.samples);
                    this.chunks.push(chunk.slice(0, room)); this.samples += Math.min(room, chunk.length);
                    if (this.samples >= this.rate * 120) { this.status(translateUi("已达到两分钟，正在结束录音并转录…")); void this.finish(); }
                };
                this.source.connect(this.processor); this.processor.connect(this.audio.destination);
                this.startedAt = Date.now(); this.phase = 'recording'; this.result.hidden = true; this.use.hidden = this.copy.hidden = true;
                this.timer = setInterval(() => {
                    const seconds = Math.floor((Date.now() - this.startedAt) / 1000);
                    this.status(translateUi("录音中 {0} 秒，再点麦克风结束并转录", seconds));
                    if (seconds >= 120) void this.finish();
                }, 1000);
                this.status(translateUi("录音中 {0} 秒，再点麦克风结束并转录", 0)); this.sync();
            } catch {
                if (epoch !== this.epoch) return;
                this.release(); this.phase = 'idle'; this.status(translateUi("无法使用麦克风，请检查浏览器权限，或选择音频文件。")); this.sync();
            }
        }
        release() {
            clearInterval(this.timer); stopTracks(this.stream); this.stream = null;
            this.source?.disconnect(); this.processor?.disconnect(); if (this.processor) this.processor.onaudioprocess = null;
            this.source = this.processor = null;
            const audio = this.audio; this.audio = null; if (audio && audio.state !== 'closed') void audio.close().catch(() => {});
        }
        cancel() {
            if (!['permission', 'recording'].includes(this.phase)) return;
            this.epoch++; this.release(); this.chunks = []; this.phase = 'idle'; this.status(translateUi("录音已取消，未上传")); this.sync();
        }
        async finish() {
            if (this.phase !== 'recording') return;
            const chunks = this.chunks, rate = this.rate, origin = this.origin;
            this.release(); this.chunks = [];
            if (this.samples < rate / 4) { this.phase = 'idle'; this.status(translateUi("录音太短，请重新录音")); this.sync(); return; }
            await this.submit(wav(chunks, rate), 'wav', origin);
        }
        async submit(blob, format, origin) {
            if (!this.models.value || this.phase === 'transcribing' || !origin.connected || origin.submitting) return;
            this.phase = 'transcribing'; this.status(translateUi("正在转录…")); this.result.hidden = true; this.use.hidden = this.copy.hidden = true; this.sync();
            // Freeze the model before asynchronous file reading; no automatic retry.
            const modelId = this.models.value, revision = this.catalog.revision;
            try {
                const data = await base64(blob);
                const response = await this.host.api('/api/pi/composer/transcription', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                    cwd: origin.cwd, requestId: Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''), modelId, revision, language: 'auto', audio: { format, data }, confirmed: true
                }) });
                this.result.value = response.text; this.phase = 'idle';
                const current = this.host.context();
                if (current.key === origin.key && current.generation === origin.generation && this.insert()) return;
                this.result.hidden = false; this.use.hidden = this.copy.hidden = false;
                this.status(translateUi("转录完成；草稿或线程状态已变化，请检查文字后加入当前草稿。"));
            } catch (error) { this.phase = 'idle'; this.status(translateUi(error.message)); }
            finally { this.sync(); }
        }
        insert() {
            try {
                if (!this.result.value.trim() || !this.host.append(this.result.value.trim())) return false;
                this.result.value = ''; this.result.hidden = true; this.use.hidden = this.copy.hidden = true; this.bar.hidden = true;
                return true;
            } catch (error) { this.status(translateUi(error.message)); return false; }
        }
    }
    window.PiComposerVoice = PiComposerVoice;
    window.PiComposerVoice.wav = wav;
})();
