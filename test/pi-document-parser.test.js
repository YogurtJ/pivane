const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDocument, officeZip, xml } = require('../server/pi-document-parser');
const { DocumentParserPool } = require('../server/pi-document-pool');
const { zip, docxFiles, xlsxFiles, pptxFiles, pdfBytes } = require('./document-fixtures.cjs');

test('Word reads Chinese runs, paragraph breaks and table rows in bounded ranges', async () => {
    const bytes = zip(docxFiles());
    const overview = await parseDocument(bytes, 'docx'); assert.equal(overview.total, 3);
    const result = await parseDocument(bytes, 'docx', { action: 'read', start: 2, count: 1 });
    assert.deepEqual(result.items.map(item => item.text), ['第二段\t金额\n100']); assert.equal(result.nextStart, 3);
    assert.equal((await parseDocument(bytes, 'docx', { action: 'read', start: 3 })).items[0].text, '项目\t预算');
    const large = docxFiles(); large['word/document.xml'] = large['word/document.xml'].replace('第二段', '长'.repeat(30000));
    const truncated = await parseDocument(zip(large), 'docx', { action: 'read' });
    assert.equal(truncated.truncated, true); assert.ok(truncated.items.reduce((n, item) => n + item.text.length, 0) <= 24000);
});

test('Excel honors sheet identity, sparse rows, column ranges, rich/shared strings and saved formulas', async () => {
    const bytes = zip(xlsxFiles()), overview = await parseDocument(bytes, 'xlsx');
    assert.deepEqual(overview.sheets, [{ name: '销售', state: 'visible' }, { name: '隐藏表', state: 'hidden' }]); assert.equal(overview.date1904, true);
    const result = await parseDocument(bytes, 'xlsx', { action: 'read', sheet: '销售', start: 2, count: 3, column: 2, columns: 1 });
    assert.equal(result.nextStart, 5); assert.equal(result.lastRow, 6); assert.equal(result.rows.length, 1);
    assert.deepEqual(result.rows[0].cells.map(cell => [cell.address, cell.value, cell.formula]), [['B3', '300', 'SUM(A3:A4)']]);
    assert.equal((await parseDocument(bytes, 'xlsx', { action: 'read' })).rows[0].cells[1].value, '部门 <A>');
    assert.equal((await parseDocument(bytes, 'xlsx', { action: 'read', start: 6 })).rows[0].cells[0].value, '销售总额');
    assert.equal((await parseDocument(bytes, 'xlsx', { action: 'read', sheet: '隐藏表' })).rows[0].cells[0].value, '隐藏内容');
    await assert.rejects(parseDocument(bytes, 'xlsx', { action: 'read', sheet: 'missing' }), /工作表/);
    const uncached = xlsxFiles(); uncached['xl/worksheets/sheet1.xml'] = uncached['xl/worksheets/sheet1.xml'].replace('<v>300</v>', '<v/>');
    assert.equal((await parseDocument(zip(uncached), 'xlsx', { action: 'read', start: 3, count: 1 })).rows[0].cells[1].cachedValue, null);
});

test('Excel reads selected cells from a normal 10000-row workbook inside the isolated memory budget', async () => {
    const files = xlsxFiles(), rows = Array.from({ length: 10000 }, (_, i) => {
        const row = i + 1; return `<row r="${row}">${['A', 'B', 'C', 'D', 'E'].map(column => `<c r="${column}${row}"><v>${row}</v></c>`).join('')}</row>`;
    });
    files['xl/worksheets/sheet1.xml'] = `<worksheet><sheetData>${rows.join('')}</sheetData></worksheet>`;
    const pool = new DocumentParserPool();
    try {
        const result = await pool.run(zip(files), 'xlsx', { action: 'read', start: 9999, count: 2, columns: 2 });
        assert.equal(result.lastRow, 10000); assert.equal(result.rows.length, 2); assert.equal(result.rows[1].cells[1].value, '10000');
        assert.equal(result.nextStart, null); assert.equal(result.truncated, false);
    } finally { await pool.dispose(); }
});

test('PowerPoint uses presentation relationship order rather than archive filename order', async () => {
    const result = await parseDocument(zip(pptxFiles()), 'pptx', { action: 'read' });
    assert.equal(result.total, 2); assert.deepEqual(result.items.map(item => item.text), ['第一页', '第二页']);
    const files = pptxFiles(); files['ppt/_rels/presentation.xml.rels'] = files['ppt/_rels/presentation.xml.rels'].replace('Target="slides/slide2.xml"', 'Target="https://invalid.example/evil.xml" TargetMode="External"');
    await assert.rejects(parseDocument(zip(files), 'pptx'), /关系/);
});

test('PDF text extraction works in the isolated parser with explicit page coverage', async () => {
    const pool = new DocumentParserPool();
    try {
        const inspect = await pool.run(pdfBytes(), 'pdf'); assert.equal(inspect.total, 1);
        const result = await pool.run(pdfBytes(), 'pdf', { action: 'read', start: 1, count: 1 });
        assert.match(result.items[0].text, /Office upload fixture/); assert.equal(result.items[0].hasText, true); assert.equal(pool.jobs.size, 0);
    } finally { await pool.dispose(); }
});

test('damaged, mislabeled, macro, malicious XML and expansion-bomb inputs fail within budgets', async () => {
    await assert.rejects(parseDocument(Buffer.from('fake'), 'docx'), /损坏/);
    await assert.rejects(parseDocument(zip(docxFiles()), 'xlsx'), /扩展名/);
    await assert.rejects(parseDocument(zip({ ...docxFiles(), 'word/vbaProject.bin': 'macro' }), 'docx'), /宏/);
    assert.throws(() => xml(Buffer.from('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>')), /声明/);
    assert.throws(() => xml(Buffer.from('<x><y></x></y>')), /匹配/);
    assert.throws(() => officeZip(zip({ ...docxFiles(), '../outside': 'no' })), /路径/);
    const damaged = zip(docxFiles(), { compress: false }); damaged[31] ^= 1; assert.throws(() => officeZip(damaged), /位置/);
    const bomb = zip(docxFiles()), central = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); bomb.writeUInt32LE(65 * 1024 ** 2, central + 24);
    assert.throws(() => officeZip(bomb), /64 MiB/);
    await assert.rejects(parseDocument(zip(docxFiles()), 'docx', { start: 0 }), /范围/);
});

test('parser admission, cancellation, timeout and shutdown retain slots until child exit', async () => {
    const pool = new DocumentParserPool({ maximum: 1 }), controller = new AbortController();
    const parsing = pool.run(zip(docxFiles()), 'docx', {}, { signal: controller.signal });
    await assert.rejects(pool.run(zip(docxFiles()), 'docx'), /正在进行/);
    controller.abort(); await assert.rejects(parsing, /取消/); assert.equal(pool.jobs.size, 0);
    await pool.dispose(); await assert.rejects(pool.run(zip(docxFiles()), 'docx'), /关闭/);
    const short = new DocumentParserPool({ timeout: 1 });
    await assert.rejects(short.run(zip(docxFiles()), 'docx'), /预算/); assert.equal(short.jobs.size, 0); await short.dispose();
});
