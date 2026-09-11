(() => {
    const limits = { files: 8, images: 6, imageBytes: 6 * 1024 * 1024, textBytes: 1024 * 1024, message: 400000, encodedBytes: 24 * 1024 * 1024 };
    const imageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    const textExtensions = 'txt,md,markdown,json,jsonl,js,mjs,cjs,ts,tsx,jsx,py,sh,bash,zsh,css,html,htm,xml,yaml,yml,toml,ini,csv,tsv,log,sql,rs,go,c,h,cpp,hpp,java,kt,swift,rb,php,r,lua,vue,svelte,conf,cfg,gitignore,env'.split(',');
    const accept = [...imageTypes, 'text/*', ...textExtensions.map(ext => `.${ext}`)].join(',');
    let nextId = 0;
    const id = () => `attachment-${++nextId}`;
    const escapeName = name => String(name).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
    const textBlock = file => `\n\n<attached_file name="${escapeName(file.name)}">\n${file.text}\n</attached_file>`;
    function payload(text, files) {
        return { message: `${text}${files.filter(file => file.kind === 'text').map(textBlock).join('')}`.trim(),
            images: files.filter(file => file.kind === 'image').map(file => ({ type: 'image', mimeType: file.mimeType, data: file.data })) };
    }
    function validatePayload({ message, images = [] }) {
        if (message.length > limits.message) throw new Error('正文与文本附件合计不能超过 400000 字符');
        if (images.length > limits.images) throw new Error('一次最多添加 6 张图片');
        if (images.some(image => !imageTypes.includes(image.mimeType))) throw new Error('图片仅支持 PNG/JPEG/WebP/GIF');
        if (images.reduce((sum, image) => sum + image.data.length, 0) > limits.encodedBytes) throw new Error('图片编码后总量不能超过 24MB，请减少图片或缩小尺寸');
    }
    function validateDraft(text, files) {
        if (files.length > limits.files) throw new Error('一次最多添加 8 个附件');
        validatePayload(payload(text, files));
    }
    function classify(file) {
        const type = (file.type || '').toLowerCase();
        const ext = file.name.toLowerCase().split('.').pop();
        const inferred = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext];
        if (imageTypes.includes(type) || inferred && (!type || type === 'application/octet-stream')) return { kind: 'image', mimeType: inferred || type };
        if (type.startsWith('image/') || ['heic', 'heif', 'avif', 'svg', 'bmp', 'tif', 'tiff'].includes(ext)) throw new Error('图片仅支持 PNG/JPEG/WebP/GIF，请先转换格式');
        if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'gz', 'rar', '7z'].includes(ext)) throw new Error('暂不支持 PDF、Office 或压缩包，请转换为文本后添加');
        if (type.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript', 'application/yaml', 'application/x-yaml', 'application/toml'].includes(type)
            || textExtensions.includes(ext) || /^(Dockerfile|Makefile|LICENSE|README)$/i.test(file.name)) return { kind: 'text', mimeType: 'text/plain' };
        throw new Error('不支持此文件格式，请添加图片或 UTF-8 文本/代码文件');
    }
    function imageMime(bytes) {
        const starts = signature => signature.every((value, index) => bytes[index] === value);
        if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
        if (starts([255, 216, 255])) return 'image/jpeg';
        const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
        if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'image/gif';
        if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
        throw new Error('图片内容与支持的格式不符，文件可能损坏');
    }
    async function read(file) {
        const format = classify(file);
        const maximum = format.kind === 'image' ? limits.imageBytes : limits.textBytes;
        if (!file.size) throw new Error('文件为空');
        if (file.size > maximum) throw new Error(format.kind === 'image' ? '单张图片不能超过 6MB' : '单个文本附件不能超过 1MB');
        const bytes = new Uint8Array(await file.arrayBuffer());
        const result = { id: id(), name: file.name || 'clipboard', size: file.size, ...format };
        if (format.kind === 'image') {
            result.mimeType = imageMime(bytes);
            let binary = '';
            for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
            result.data = btoa(binary);
            result.preview = `data:${result.mimeType};base64,${result.data}`;
        } else {
            const signature = String.fromCharCode(...bytes.subarray(0, 5));
            if (signature === '%PDF-' || bytes[0] === 80 && bytes[1] === 75 && [3, 5, 7].includes(bytes[2])
                || bytes[0] === 208 && bytes[1] === 207 && bytes[2] === 17 && bytes[3] === 224) throw new Error('PDF、Office 或压缩包不能作为文本附件');
            try { result.text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
            catch { throw new Error('文本编码不是 UTF-8，请转换编码后添加'); }
            if (/[\x00-\x08\x0e-\x1f\x7f]/.test(result.text)) throw new Error('文件包含二进制内容，不能作为文本附件');
        }
        return result;
    }
    const errorSummary = errors => `${errors.slice(0, 2).join('\n')}${errors.length > 2 ? `\n另有 ${errors.length - 2} 个附件未添加` : ''}`;
    const hasFiles = transfer => Boolean(transfer && ([...(transfer.types || [])].includes('Files') || [...(transfer.items || [])].some(item => item.kind === 'file') || transfer.files?.length));
    function transferFiles(transfer) {
        const items = [...(transfer?.items || [])].filter(item => item.kind === 'file');
        const errors = [];
        const files = items.length ? items.flatMap(item => {
            if (item.webkitGetAsEntry?.()?.isDirectory) { errors.push('暂不支持文件夹，请选择其中的文件'); return []; }
            const file = item.getAsFile();
            return file ? [file] : [];
        }) : [...(transfer?.files || [])];
        if (!files.length && !errors.length) errors.push('浏览器未提供文件内容，请拖入文件或点击回形针选择');
        return { files, errors };
    }
    function bindTransfers({ zone, input, onFiles, onError }) {
        const consume = event => {
            const transfer = event.clipboardData || event.dataTransfer;
            if (!hasFiles(transfer)) return;
            event.preventDefault();
            event.stopPropagation();
            const { files, errors } = transferFiles(transfer);
            errors.forEach(onError);
            if (files.length) onFiles(files);
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
    const api = { limits, accept, id, textBlock, payload, validatePayload, validateDraft, classify, read, hasFiles, transferFiles, bindTransfers, errorSummary };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else window.PiAttachments = api;
})();
