const zlib = require('node:zlib');
const path = require('node:path');
const { fail } = require('./pi-file-scope');
const MAX_EXPANDED = 64 * 1024 * 1024, MAX_PART = 8 * 1024 * 1024, MAX_XML_TOKENS = 500000;
const bad = message => fail(message, 415, 'DOCUMENT_FORMAT');

// Office packages are read in memory. No extraction to disk, external targets,
// executable parts or archive-provided paths are ever opened.
function officeZip(bytes) {
    const endMin = Math.max(0, bytes.length - 65557);
    let end = -1;
    for (let i = bytes.length - 22; i >= endMin; i--) if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
    if (end < 0) throw bad('Office 文件损坏，无法读取压缩目录');
    const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
    if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || count !== bytes.readUInt16LE(end + 8)
        || count > 4096 || !count || start + size !== end) throw bad('不支持多卷、ZIP64 或过多条目的 Office 文件');
    const entries = new Map(); let offset = start, expanded = 0;
    for (let i = 0; i < count; i++) {
        if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw bad('Office 压缩目录无效');
        const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
        const crc = bytes.readUInt32LE(offset + 16), compressed = bytes.readUInt32LE(offset + 20), length = bytes.readUInt32LE(offset + 24);
        const n = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32), local = bytes.readUInt32LE(offset + 42);
        if (offset + 46 + n + extra + comment > end || !n || flags & 1 || ![0, 8].includes(method) || bytes.readUInt16LE(offset + 34)) throw bad('Office 文件包含加密或不支持的压缩条目');
        let name;
        try { name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset + 46, offset + 46 + n)); } catch { throw bad('Office 内部文件名编码无效'); }
        if (/^[\/]|[\\\x00-\x1f\x7f]/.test(name) || name.split('/').some(part => part === '..' || part === '.') || entries.has(name)) throw bad('Office 包含无效或重复路径');
        expanded += length;
        if (expanded > MAX_EXPANDED || length === 0xffffffff || compressed === 0xffffffff || local === 0xffffffff) throw fail('Office 解压后超过 64 MiB 读取预算', 413, 'DOCUMENT_LIMIT');
        if (local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) throw bad('Office 压缩条目无效');
        const localNameLength = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28), data = local + 30 + localNameLength + localExtra;
        if (data + compressed > start || !bytes.subarray(local + 30, local + 30 + localNameLength).equals(bytes.subarray(offset + 46, offset + 46 + n))) throw bad('Office 压缩条目位置无效');
        entries.set(name, { method, crc, compressed, length, data }); offset += 46 + n + extra + comment;
    }
    if (offset !== end) throw bad('Office 压缩目录长度无效');
    return {
        names: [...entries.keys()],
        read(name) {
            const entry = entries.get(name);
            if (!entry) throw bad(`Office 缺少必要内容：${name}`);
            if (entry.length > MAX_PART) throw fail('Office 单个 XML 部分超过 8 MiB 读取预算', 413, 'DOCUMENT_LIMIT');
            const compressed = bytes.subarray(entry.data, entry.data + entry.compressed);
            let result;
            try { result = entry.method === 0 ? compressed : zlib.inflateRawSync(compressed, { maxOutputLength: MAX_PART }); }
            catch { throw bad('Office 压缩内容损坏或超过读取预算'); }
            if (result.length !== entry.length || crc32(result) !== entry.crc) throw bad('Office 内容校验失败');
            return result;
        }
    };
}
// Node 22 also supported; do not depend on newer zlib.crc32.
const crcTable = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1; return n >>> 0; });
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8; return (crc ^ 0xffffffff) >>> 0; }
function entities(value) {
    if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/.test(value)) throw bad('Office XML 实体无效');
    return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, (_, entity) => {
        if (entity[0] !== '#') return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity];
        const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
        if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) throw bad('Office XML 字符无效');
        return String.fromCodePoint(code);
    });
}
// A bounded XML reader for OOXML data, with no DTD/entity expansion or I/O.
function xml(bytes) {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw bad('仅支持 UTF-8 Office XML'); }
    if (/<!DOCTYPE|<!ENTITY/i.test(text) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw bad('Office XML 包含不支持的声明或字符');
    const root = { name: '#root', attrs: {}, children: [] }, stack = [root];
    const tokens = /<!--[^]*?-->|<\?[^]*?\?>|<!\[CDATA\[[^]*?\]\]>|<(?:"[^"<]*"|'[^'<]*'|[^'"<>])*>|[^<]+/g;
    let offset = 0, nodes = 0, token;
    while ((token = tokens.exec(text))) {
        if (token.index !== offset || ++nodes > MAX_XML_TOKENS || stack.length > 128) throw fail('Office XML 无效或超过结构预算', 413, 'DOCUMENT_LIMIT');
        offset = tokens.lastIndex; const value = token[0];
        if (value.startsWith('<!--') || value.startsWith('<?')) continue;
        if (value.startsWith('<![CDATA[')) { stack.at(-1).children.push(value.slice(9, -3)); continue; }
        if (value.startsWith('</')) {
            const close = /^<\/([\w:.-]+)\s*>$/.exec(value);
            if (!close || stack.length === 1 || stack.pop().qualified !== close[1]) throw bad('Office XML 标签不匹配');
        } else if (value.startsWith('<')) {
            const open = /^<([\w:.-]+)([^]*?)(\/?)>$/.exec(value);
            if (!open) throw bad('Office XML 标签无效');
            const attrs = Object.create(null), attributes = open[2], re = /\s+([\w:.-]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/g;
            let at = 0, attr;
            while ((attr = re.exec(attributes))) {
                if (attributes.slice(at, attr.index).trim() || Object.hasOwn(attrs, attr[1])) throw bad('Office XML 属性无效');
                attrs[attr[1]] = entities(attr[2] ?? attr[3]); at = re.lastIndex;
            }
            if (attributes.slice(at).trim()) throw bad('Office XML 属性无效');
            const node = { name: open[1].split(':').at(-1), qualified: open[1], attrs, children: [] };
            stack.at(-1).children.push(node); if (!open[3]) stack.push(node);
        } else { stack.at(-1).children.push(entities(value)); }
    }
    if (offset !== text.length || stack.length !== 1 || root.children.filter(item => typeof item !== 'string').length !== 1 || root.children.some(item => typeof item === 'string' && item.trim())) throw bad('Office XML 文档无效');
    return root.children.find(item => typeof item !== 'string');
}
const children = (node, name) => (node?.children || []).filter(item => typeof item !== 'string' && (!name || item.name === name));
function descendants(node, name) { const result = []; function visit(current) { for (const child of children(current)) { if (child.name === name) result.push(child); visit(child); } } visit(node); return result; }
const plain = node => (node?.children || []).map(item => typeof item === 'string' ? item : plain(item)).join('');
const rich = node => descendants(node, 't').map(plain).join('');
const getXml = (zip, name) => xml(zip.read(name));
function relationships(zip, base) {
    const file = path.posix.join(path.posix.dirname(base), '_rels', path.posix.basename(base) + '.rels');
    const map = new Map();
    for (const rel of children(getXml(zip, file), 'Relationship')) {
        const { Id, Target, TargetMode } = rel.attrs;
        if (!Id || map.has(Id)) throw bad('Office 关系标识无效');
        if (TargetMode === 'External') { map.set(Id, null); continue; }
        if (!Target || /^[a-z]+:|[\\\x00-\x1f?#]/i.test(Target)) throw bad('Office 关系路径无效');
        const resolved = path.posix.normalize(Target.startsWith('/') ? Target.slice(1) : path.posix.join(path.posix.dirname(base), Target));
        if (resolved.startsWith('../') || !zip.names.includes(resolved)) throw bad('Office 关系指向缺失内容');
        map.set(Id, resolved);
    }
    return map;
}
function detectDocument(bytes, format) {
    if (format === 'pdf') {
        if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw bad('PDF 内容与扩展名不符');
        return null;
    }
    const zip = officeZip(bytes), types = getXml(zip, '[Content_Types].xml');
    const main = { docx: 'word/document.xml', xlsx: 'xl/workbook.xml', pptx: 'ppt/presentation.xml' }[format];
    const expected = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml' }[format];
    if (!main || !children(types, 'Override').some(item => item.attrs.PartName === '/' + main && item.attrs.ContentType === expected)) throw bad('Office 内容与扩展名不符或为启用宏的文件');
    if (zip.names.some(name => /(?:^|\/)vbaProject\.bin$/i.test(name)) || children(types).some(item => /vbaProject|macroEnabled/i.test(item.attrs.ContentType || ''))) throw bad('暂不支持包含宏的 Office 文件');
    getXml(zip, main); return zip;
}
function validateRead(raw = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['action', 'start', 'count', 'sheet', 'column', 'columns'].includes(key))) throw fail('文档读取参数无效', 400, 'DOCUMENT_INPUT');
    const input = { action: raw.action ?? 'inspect', start: raw.start ?? 1, count: raw.count ?? 20, sheet: raw.sheet, column: raw.column ?? 1, columns: raw.columns ?? 20 };
    if (!['inspect', 'read'].includes(input.action) || !Number.isSafeInteger(input.start) || input.start < 1 || input.start > 1048576
        || !Number.isSafeInteger(input.count) || input.count < 1 || input.count > 200 || !Number.isSafeInteger(input.column) || input.column < 1 || input.column > 16384
        || !Number.isSafeInteger(input.columns) || input.columns < 1 || input.columns > 50
        || input.sheet !== undefined && (typeof input.sheet !== 'string' || !input.sheet || input.sheet.length > 240)) throw fail('文档读取范围无效', 400, 'DOCUMENT_INPUT');
    return input;
}
function clip(text, max = 24000) { return { text: text.slice(0, max), truncated: text.length > max }; }
function docx(zip, input) {
    const body = children(getXml(zip, 'word/document.xml'), 'body')[0];
    if (!body) throw bad('Word 缺少正文');
    const paragraph = node => {
        function visit(current) { if (current.name === 't') return plain(current); if (current.name === 'tab') return '\t'; if (['br', 'cr'].includes(current.name)) return '\n'; if (current.name === 'del') return ''; return children(current).map(visit).join(''); }
        return visit(node);
    };
    const units = [];
    for (const block of children(body)) {
        if (block.name === 'p') units.push({ kind: 'paragraph', text: paragraph(block) });
        else if (block.name === 'tbl') for (const row of children(block, 'tr')) units.push({ kind: 'table-row', text: children(row, 'tc').map(cell => descendants(cell, 'p').map(paragraph).join('\n')).join('\t') });
        else if (block.name === 'sdt') for (const p of descendants(block, 'p')) units.push({ kind: 'paragraph', text: paragraph(p) });
    }
    const base = { format: 'docx', unit: 'paragraph-or-table-row', total: units.length,
        warnings: ['正文按段落和表格行读取；页眉、页脚、批注、嵌入对象和图片中文字未提取，排版未还原。'] };
    if (input.action === 'inspect') return base;
    const selected = units.slice(input.start - 1, input.start - 1 + input.count); let remaining = 24000, truncated = false;
    const items = selected.map((item, i) => { const part = clip(item.text, Math.max(0, remaining)); remaining -= part.text.length; truncated ||= part.truncated; return { index: input.start + i, kind: item.kind, ...part }; });
    return { ...base, start: input.start, items, truncated, nextStart: input.start + selected.length <= units.length ? input.start + selected.length : null };
}
function pptx(zip, input) {
    const main = 'ppt/presentation.xml', presentation = getXml(zip, main), rels = relationships(zip, main);
    const slides = descendants(presentation, 'sldId').map(item => rels.get(item.attrs['r:id']));
    if (slides.length > 10000 || slides.some(file => !file || !/^ppt\/slides\/[^/]+\.xml$/.test(file))) throw bad('PPT 幻灯片关系无效或超过预算');
    const base = { format: 'pptx', unit: 'slide', total: slides.length, warnings: ['提取幻灯片文本与表格文本；图片、图表数据、动画、备注和原版布局未提取。'] };
    if (input.action === 'inspect') return base;
    const count = Math.min(input.count, 10), items = []; let remaining = 24000, truncated = false;
    for (let i = input.start - 1; i < Math.min(slides.length, input.start - 1 + count); i++) {
        const text = descendants(getXml(zip, slides[i]), 'p').map(rich).join('\n'), part = clip(text, Math.max(0, remaining));
        remaining -= part.text.length; truncated ||= part.truncated; items.push({ index: i + 1, ...part });
    }
    return { ...base, start: input.start, items, truncated, nextStart: input.start + items.length <= slides.length ? input.start + items.length : null };
}
const columnNumber = letters => [...letters].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0);
function xlsx(zip, input) {
    const main = 'xl/workbook.xml', workbook = getXml(zip, main), rels = relationships(zip, main);
    const sheets = descendants(workbook, 'sheet').map(item => ({ name: item.attrs.name, state: item.attrs.state || 'visible', file: rels.get(item.attrs['r:id']) }));
    if (sheets.length > 200 || sheets.some(sheet => !sheet.name || !sheet.file || !/^xl\/worksheets\/[^/]+\.xml$/.test(sheet.file))) throw bad('Excel 工作表关系无效或超过预算');
    const base = { format: 'xlsx', unit: 'row', sheets: sheets.map(({ name, state }) => ({ name, state })),
        warnings: ['公式返回原式与文件中已有的缓存结果，不重新计算。数值按原始单元格值返回；日期/货币格式未转换，日期系统在 date1904 字段标明。图表、图片、批注和外部数据未提取。'],
        date1904: ['1', 'true'].includes(descendants(workbook, 'workbookPr')[0]?.attrs.date1904) };
    if (input.action === 'inspect') return base;
    const sheet = input.sheet ? sheets.find(sheet => sheet.name === input.sheet) : sheets[0];
    if (!sheet) throw fail('请选择文件中存在的工作表', 400, 'DOCUMENT_SHEET');
    const strings = zip.names.includes('xl/sharedStrings.xml') ? children(getXml(zip, 'xl/sharedStrings.xml'), 'si').map(rich) : [];
    const doc = getXml(zip, sheet.file), rows = [], start = input.start, end = start + input.count;
    let remaining = 20000, truncated = false, lastRow = 0;
    for (const row of descendants(doc, 'row')) {
        const index = Number(row.attrs.r);
        if (!Number.isInteger(index) || index < 1 || index > 1048576 || index <= lastRow) throw bad('Excel 行号无效');
        lastRow = index;
        if (index < start || index >= end) continue;
        const cells = []; let previousColumn = 0;
        for (const cell of children(row, 'c')) {
            const address = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(cell.attrs.r || '');
            const column = address && columnNumber(address[1]);
            if (!address || Number(address[2]) !== index || column > 16384 || column <= previousColumn) throw bad('Excel 单元格地址无效');
            previousColumn = column;
            if (column < input.column || column >= input.column + input.columns) continue;
            const type = cell.attrs.t || 'n', valueNode = children(cell, 'v')[0], raw = plain(valueNode), formulaNode = children(cell, 'f')[0];
            let value = type === 'inlineStr' ? rich(cell) : raw;
            if (type === 's') { if (!/^\d+$/.test(raw) || Number(raw) >= strings.length) throw bad('Excel 共享字符串索引无效'); value = strings[Number(raw)]; }
            const part = clip(value, Math.max(0, Math.min(2000, remaining))); remaining -= part.text.length; truncated ||= part.truncated;
            const formula = formulaNode ? clip(plain(formulaNode), Math.max(0, Math.min(2000, remaining))) : null;
            if (formula) { remaining -= formula.text.length; truncated ||= formula.truncated; }
            cells.push({ address: cell.attrs.r, type, value: part.text, style: cell.attrs.s || null, truncated: part.truncated || Boolean(formula?.truncated),
                ...(formula ? { formula: formula.text, formulaAttributes: formulaNode.attrs, cachedValue: !valueNode || !raw && type !== 'str' ? null : part.text } : {}) });
        }
        rows.push({ index, cells });
    }
    return { ...base, sheet: sheet.name, start, count: input.count, column: input.column, columns: input.columns, lastRow,
        dimension: descendants(doc, 'dimension')[0]?.attrs.ref || null, rows, truncated, nextStart: end <= lastRow ? end : null };
}
async function pdf(bytes, input) {
    // PDF.js text extraction only. No browser renderer, embedded JavaScript or network.
    globalThis.fetch = async () => { throw new Error('Document network access is disabled'); };
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({ data: Uint8Array.from(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false,
        useWorkerFetch: false, stopAtErrors: true, verbosity: 0, maxImageSize: 1, enableXfa: false });
    try {
        const doc = await task.promise;
        if (doc.numPages > 10000) throw fail('PDF 页数超过读取预算', 413, 'DOCUMENT_LIMIT');
        const base = { format: 'pdf', unit: 'page', total: doc.numPages, warnings: ['只提取可复制文字，不自动 OCR；扫描页、图片、表格布局和附件未提取。'] };
        if (input.action === 'inspect') return base;
        const count = Math.min(input.count, 10), items = []; let remaining = 24000, truncated = false;
        for (let page = input.start; page <= Math.min(doc.numPages, input.start + count - 1); page++) {
            const current = await doc.getPage(page), content = await current.getTextContent();
            const text = content.items.map(item => (item.str || '') + (item.hasEOL ? '\n' : ' ')).join(''), part = clip(text, Math.max(0, remaining));
            remaining -= part.text.length; truncated ||= part.truncated; items.push({ index: page, ...part, hasText: Boolean(text.trim()) }); current.cleanup();
        }
        return { ...base, start: input.start, items, truncated, nextStart: input.start + items.length <= doc.numPages ? input.start + items.length : null };
    } catch (error) {
        if (error.name === 'PasswordException') throw bad('PDF 需要密码，请先解除密码后上传');
        if (error.status) throw error;
        throw bad('PDF 损坏或无法提取文字');
    } finally { await task.destroy(); }
}
async function parseDocument(bytes, format, raw, validateOnly = false) {
    const input = validateRead(raw), zip = detectDocument(bytes, format);
    if (validateOnly && format !== 'pdf') return { format, valid: true };
    const result = format === 'pdf' ? await pdf(bytes, validateOnly ? { ...input, action: 'inspect' } : input)
        : ({ docx, pptx, xlsx })[format](zip, input);
    if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) throw fail('文档结果超过输出预算，请缩小读取范围', 413, 'DOCUMENT_LIMIT');
    return result;
}
module.exports = { parseDocument, officeZip, xml, validateRead, crc32 };
