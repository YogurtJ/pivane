(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const limits = { files: 8, documents: 5, documentBytes: 20 * 1024 * 1024, fileBytes: 100 * 1024 * 1024, batchBytes: 200 * 1024 * 1024,
        images: 6, imageBytes: 6 * 1024 * 1024, textBytes: 1024 * 1024, message: 400000, encodedBytes: 24 * 1024 * 1024 };
    const imageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    const textExtensions = 'txt,md,markdown,json,jsonl,js,mjs,cjs,ts,tsx,jsx,py,sh,bash,zsh,css,html,htm,xml,yaml,yml,toml,ini,csv,tsv,log,sql,rs,go,c,h,cpp,hpp,java,kt,swift,rb,php,r,lua,vue,svelte,conf,cfg,gitignore,env'.split(',');
    const documents = typeof module !== 'undefined' && module.exports ? require('./pi-document-references') : globalThis.PiDocumentReferences;
    const accept = ''; // All files may be stored as opaque originals; parsers remain type-specific.
    let nextId = 0;
    const id = () => `attachment-${++nextId}`;
    const escapeName = name => String(name).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
    const textBlock = file => file.reference ? `\n\n${documents.marker(file.reference)}` : `\n\n<attached_file name="${escapeName(file.name)}">\n${file.text}\n</attached_file>`;
    function payload(text, files) {
        const quotes = files.filter(file => file.kind === 'quote').map(file => window.PiQuotes.serialize(file)).join('');
        return { message: `${quotes}${text}${files.filter(file => ['text', 'document'].includes(file.kind) || file.reference).map(textBlock).join('')}`.trim(),
            images: files.filter(file => file.kind === 'image').map(file => ({ type: 'image', mimeType: file.mimeType, data: file.data })) };
    }
    function fromPayload({ message = '', images = [] }) {
        if (!Array.isArray(images) || images.some(image => !image || typeof image.data !== 'string' || !image.data.length
            || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data))) throw new Error(translateUi('图片内容与支持的格式不符，文件可能损坏'));
        const parts = documents.split(message), originals = parts.filter(part => part.reference?.format === 'image').map(part => part.reference);
        const text = parts.filter(part => !part.reference).map(part => part.text).join('').trim();
        const paired = new Set(originals.slice(0, images.length));
        const files = parts.filter(part => part.reference && !paired.has(part.reference)).map(({ reference }) => ({
            id: id(), kind: 'document', name: reference.name, size: reference.size, format: reference.format, reference
        }));
        files.push(...images.map((image, index) => ({ id: id(), kind: 'image', name: originals[index]?.name || translateUi('图片 {0}', index + 1),
            ...(originals[index] ? { reference: originals[index], size: originals[index].size } : {}),
            data: image.data, mimeType: image.mimeType, preview: `data:${image.mimeType};base64,${image.data}` })));
        validateDraft(text, files);
        return { text, files };
    }
    function validatePayload({ message, images = [] }) {
        documents.validateCount(message);
        if (message.length > limits.message) throw new Error(translateUi('正文与文本附件合计不能超过 400000 字符'));
        if (images.length > limits.images) throw new Error(translateUi('一次最多添加 6 张图片'));
        if (images.some(image => !imageTypes.includes(image.mimeType))) throw new Error(translateUi('图片仅支持 PNG/JPEG/WebP/GIF'));
        if (images.reduce((sum, image) => sum + image.data.length, 0) > limits.encodedBytes) throw new Error(translateUi('图片编码后总量不能超过 24MB，请减少图片或缩小尺寸'));
    }
    function validateDraft(text, files, { allowPending = false } = {}) {
        if (!allowPending && files.some(file => file.kind === 'pending-upload')) throw new Error(translateUi('有附件上传结果待确认，请先查询结果或移除该项'));
        if (files.length > limits.files) throw new Error(translateUi('一次最多添加 8 个附件'));
        if (files.reduce((sum, file) => sum + (file.size || 0), 0) > limits.batchBytes) throw new Error(translateUi('附件总量不能超过 200 MiB'));
        validatePayload(payload(text, files));
    }
    function classify(file) {
        const type = (file.type || '').toLowerCase(), name = String(file.name || 'clipboard');
        const ext = name.toLowerCase().split('.').pop();
        const inferred = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext];
        if (imageTypes.includes(type) || inferred && (!type || type === 'application/octet-stream')) return { kind: 'image', mimeType: inferred || type };
        if (['docx', 'xlsx', 'pptx', 'pdf'].includes(ext)) return { kind: 'document', format: ext };
        if (type.startsWith('image/') || type.startsWith('audio/') || type.startsWith('video/') || ['heic', 'heif', 'avif', 'svg', 'bmp', 'tif', 'tiff', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'webm', 'mov', 'mkv', 'avi', 'zip', 'gz', 'bz2', 'xz', 'tar', 'rar', '7z', 'doc', 'xls', 'ppt'].includes(ext)) return { kind: 'document', format: 'file' };
        if (type.startsWith('text/') && !type.startsWith('image/') || ['application/json', 'application/xml', 'application/javascript', 'application/yaml', 'application/x-yaml', 'application/toml'].includes(type)
            || textExtensions.includes(ext) || /^(Dockerfile|Makefile|LICENSE|README)$/i.test(name)) return { kind: 'text', mimeType: 'text/plain' };
        return { kind: 'document', format: 'file' };
    }
    function imageMime(bytes) {
        const starts = signature => signature.every((value, index) => bytes[index] === value);
        if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
        if (starts([255, 216, 255])) return 'image/jpeg';
        const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
        if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'image/gif';
        if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
        throw new Error(translateUi('图片内容与支持的格式不符，文件可能损坏'));
    }
    async function uploadReference(file, upload, format, options) {
        if (!upload) throw new Error(translateUi('当前入口尚未启用附件上传，请使用支持此功能的持久线程'));
        const result = await upload(file, options);
        if (!documents.valid(result?.reference) || result.reference.name !== file.name || result.reference.size !== file.size || result.reference.format !== format)
            throw new Error(translateUi('附件上传返回无效，请核对原上传'));
        return result.reference;
    }
    async function read(file, { upload, preserveImages = false, assertCurrent = () => {} } = {}) {
        assertCurrent();
        const format = classify(file);
        if (format.kind === 'document') {
            const maximum = format.format === 'file' ? limits.fileBytes : limits.documentBytes;
            if (!file.size || file.size > maximum) throw new Error(translateUi('单个附件须为非空文件且不超过 {0} MiB', maximum / 1024 / 1024));
            const reference = await uploadReference(file, upload, format.format);
            assertCurrent();
            return { id: id(), name: file.name, size: file.size, ...format, reference };
        }
        const maximum = format.kind === 'image' ? limits.imageBytes : limits.textBytes;
        if (!file.size) throw new Error(translateUi('文件为空'));
        if (file.size > maximum) throw new Error(format.kind === 'image' ? translateUi('单张图片不能超过 6MB') : translateUi('单个文本附件不能超过 1MB'));
        const bytes = new Uint8Array(await file.arrayBuffer());
        assertCurrent();
        const result = { id: id(), name: file.name || 'clipboard', size: file.size, ...format };
        if (format.kind === 'image') {
            result.mimeType = imageMime(bytes);
            let binary = '';
            for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
            result.data = btoa(binary); result.preview = `data:${result.mimeType};base64,${result.data}`;
            if (preserveImages) {
                result.reference = await uploadReference(file, upload, 'image', { purpose: 'image' });
                assertCurrent();
            }
        } else {
            const signature = String.fromCharCode(...bytes.subarray(0, 5));
            if (signature === '%PDF-' || bytes[0] === 80 && bytes[1] === 75 && [3, 5, 7].includes(bytes[2])
                || bytes[0] === 208 && bytes[1] === 207 && bytes[2] === 17 && bytes[3] === 224) throw new Error(translateUi('PDF、Office 或压缩包不能作为文本附件'));
            try { result.text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
            catch { throw new Error(translateUi('文本编码不是 UTF-8，请转换编码后添加')); }
            if (/[\x00-\x08\x0e-\x1f\x7f]/.test(result.text)) throw new Error(translateUi('文件包含二进制内容，不能作为文本附件'));
        }
        return result;
    }
    const errorSummary = errors => `${errors.slice(0, 2).join('\n')}${errors.length > 2 ? translateUi('\n另有 {0} 个附件未添加', errors.length - 2) : ''}`;
    const hasFiles = transfer => Boolean(transfer && ([...(transfer.types || [])].includes('Files') || [...(transfer.items || [])].some(item => item.kind === 'file') || transfer.files?.length));
    function transferFiles(transfer) {
        const items = [...(transfer?.items || [])].filter(item => item.kind === 'file'), files = [], errors = [];
        let unavailable = false, directory = false;
        for (const item of items) {
            try {
                if (item.webkitGetAsEntry?.()?.isDirectory) { directory = true; errors.push(translateUi('暂不支持文件夹，请选择其中的文件')); continue; }
                const file = item.getAsFile(); if (file) files.push(file); else unavailable = true;
            } catch { unavailable = true; }
        }
        if (!items.length || unavailable && !directory) {
            const key = file => JSON.stringify([file.name, file.size, file.type, file.lastModified]);
            for (const file of [...(transfer?.files || [])]) if (!files.some(existing => key(existing) === key(file))) files.push(file);
        }
        if (!files.length && !errors.length) errors.push(translateUi('浏览器未提供文件内容，请拖入文件或点击回形针选择'));
        return { files, errors };
    }
    function transferText(transfer) {
        const get = type => { try { return transfer.getData(type) || ''; } catch { return ''; } };
        const text = get('text/plain');
        return text || get('text/uri-list').split(/\r?\n/).filter(line => line && !line.startsWith('#')).join('\n');
    }
    const filenameFallback = file => translateUi('[文件名（未上传）：{0}]', file.name || 'clipboard');
    function recoveryText(metadata, failed, accepted = []) {
        const text = metadata?.text || '';
        const base = value => { try { value = decodeURIComponent(value); } catch {} return value.replace(/^['"]|['"]$/g, '').split(/[\\/]/).pop(); };
        const names = new Set([...(metadata?.files || []), ...failed, ...accepted].map(file => file.name));
        const lines = text.split(/\r?\n/).filter(Boolean);
        const representation = lines.length && lines.every(line => names.has(base(line)));
        if (text && !representation) return [!(metadata?.files || []).length && !accepted.length ? translateUi('[文字／路径（文件未上传）：{0}]', text) : text, ...failed.map(filenameFallback)].join('\n');
        if (text && !accepted.length) return lines.map(line => translateUi('[文字／路径（文件未上传）：{0}]', line)).join('\n');
        const failedNames = new Set(failed.map(file => file.name));
        const paths = representation ? lines.filter(line => failedNames.has(base(line))) : [];
        return [...paths.map(line => translateUi('[路径（未上传）：{0}]', line)), ...failed.filter(file => !paths.some(line => base(line) === file.name)).map(filenameFallback)].join('\n');
    }
    function bindTransfers({ zone, input, onFiles, onError }) {
        const consume = event => {
            const transfer = event.clipboardData || event.dataTransfer;
            if (!hasFiles(transfer)) return;
            const text = transferText(transfer); // Clipboard access ends when this event returns.
            const { files, errors } = transferFiles(transfer);
            event.preventDefault(); event.stopPropagation();
            const operation = onFiles(files, { text, files, errors, anchor: { value: input.value, start: input.selectionStart, end: input.selectionEnd } });
            Promise.resolve(operation).catch(error => onError(error.message));
        };
        input.addEventListener('paste', consume);
        zone.addEventListener('dragover', event => {
            if (!hasFiles(event.dataTransfer)) return;
            event.preventDefault(); event.stopPropagation();
            event.dataTransfer.dropEffect = 'copy'; zone.classList.add('pi-file-dragover');
        });
        zone.addEventListener('dragleave', event => { if (!zone.contains(event.relatedTarget)) zone.classList.remove('pi-file-dragover'); });
        zone.addEventListener('drop', event => { zone.classList.remove('pi-file-dragover'); consume(event); });
        document.addEventListener('dragend', () => zone.classList.remove('pi-file-dragover'));
    }
    const api = { limits, accept, id, textBlock, payload, fromPayload, validatePayload, validateDraft, classify, read, hasFiles, transferFiles, transferText, recoveryText, filenameFallback, bindTransfers, errorSummary };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else window.PiAttachments = api;
})();
