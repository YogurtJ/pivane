const zlib = require('node:zlib');
const { crc32 } = require('../server/pi-document-parser');
function zip(files, { compress = true } = {}) {
    const locals = [], central = []; let offset = 0;
    for (const [name, value] of Object.entries(files)) {
        const data = Buffer.isBuffer(value) ? value : Buffer.from(value), filename = Buffer.from(name), body = compress ? zlib.deflateRawSync(data) : data;
        const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(compress ? 8 : 0, 8);
        local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
        const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(compress ? 8 : 0, 10);
        entry.writeUInt32LE(crc32(data), 16); entry.writeUInt32LE(body.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42);
        locals.push(local, filename, body); central.push(entry, filename); offset += local.length + filename.length + body.length;
    }
    const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
}
const contentType = (part, type) => `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}"/></Types>`;
function docxFiles() { return {
    '[Content_Types].xml': contentType('word/document.xml', 'wordprocessingml.document.main+xml'),
    'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>合同 &amp; 分析</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t><w:tab/><w:t>金额</w:t><w:br/><w:t>100</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>预算</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'
}; }
function xlsxFiles() { return {
    '[Content_Types].xml': contentType('xl/workbook.xml', 'spreadsheetml.sheet.main+xml'),
    'xl/workbook.xml': '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="1"/><sheets><sheet name="销售" sheetId="1" r:id="r1"/><sheet name="隐藏表" state="hidden" sheetId="2" r:id="r2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>金额</t></si><si><r><t>销售</t></r><r><t>总额</t></r></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><dimension ref="A1:C6"/><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>部门 &lt;A&gt;</t></is></c></row><row r="3"><c r="A3"><v>100</v></c><c r="B3"><f>SUM(A3:A4)</f><v>300</v></c><c r="C3" t="b"><v>1</v></c></row><row r="6"><c r="A6" t="s"><v>1</v></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>隐藏内容</t></is></c></row></sheetData></worksheet>'
}; }
function pptxFiles() { return {
    '[Content_Types].xml': contentType('ppt/presentation.xml', 'presentationml.presentation.main+xml'),
    'ppt/presentation.xml': '<p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldIdLst><p:sldId id="1" r:id="r2"/><p:sldId id="2" r:id="r1"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="r1" Target="slides/slide1.xml"/><Relationship Id="r2" Target="slides/slide2.xml"/></Relationships>',
    'ppt/slides/slide1.xml': '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld><a:p><a:r><a:t>第二页</a:t></a:r></a:p></p:cSld></p:sld>',
    'ppt/slides/slide2.xml': '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld><a:p><a:r><a:t>第一</a:t></a:r><a:r><a:t>页</a:t></a:r></a:p></p:cSld></p:sld>'
}; }
function pdfBytes() {
    const stream = 'BT /F1 12 Tf 20 40 Td (Office upload fixture) Tj ET';
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
    let text = '%PDF-1.4\n', offsets = [0];
    for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
    const xref = Buffer.byteLength(text); text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets.slice(1)) text += `${String(offset).padStart(10, '0')} 00000 n \n`;
    text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`; return Buffer.from(text);
}
module.exports = { zip, docxFiles, xlsxFiles, pptxFiles, pdfBytes };
