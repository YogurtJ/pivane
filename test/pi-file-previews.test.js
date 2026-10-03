const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { classify, representation } = require('../server/pi-file-types');
const { pdf, wav } = require('./file-preview-fixtures.cjs');
const context = { window: {} }; vm.createContext(context);
vm.runInContext(fs.readFileSync(require.resolve('../public/pi-file-previews.js'), 'utf8'), context);
const parse = (text, delimiter = ',') => JSON.parse(JSON.stringify(context.window.PiFilePreviews.parseTable(text, delimiter)));
test('typed previews recognize signatures, preserve exact bytes and restrict text encoding', () => {
    for (const [bytes, name, kind] of [[pdf(), 'report.bin', 'pdf'], [wav(), 'recording.bin', 'audio']]) {
        const data = representation({ bytes }, name);
        assert.equal(data.kind, kind); assert.equal(data.encoding, 'base64'); assert.deepEqual(Buffer.from(data.base64, 'base64'), bytes);
    }
    for (const name of ['fake.pdf', 'fake.mp3', 'fake.wav']) assert.equal(classify(Buffer.from('not the format'), name).kind, 'text');
    for (const [name, kind] of [['data.csv', 'table'], ['data.tsv', 'table'], ['diagram.svg', 'svg']]) {
        const content = '\ufeffa\tb\r\n1\t2';
        const result = representation({ bytes: Buffer.from(content) }, name);
        assert.equal(result.kind, kind); assert.equal(result.content, content); assert.equal(result.encoding, 'utf8');
    }
    assert.equal(classify(Buffer.from([0xff, 0xfe, 0]), 'data.csv').kind, 'binary');
    assert.equal(classify(Buffer.alloc(2 * 1024 * 1024 + 1, 65), 'data.csv').kind, 'binary');
    assert.equal(classify(Buffer.from('OggS video payload'), 'video.ogg').kind, 'text');
});
test('CSV/TSV handle quoted separators, multiline cells, escaped quotes, BOM and CRLF without formula execution', () => {
    assert.deepEqual(parse('\ufeffname,value\r\n"a,b","line1\nline2"\r\n"a""b",=SUM(A1:A2)\r\n'), { rows: [['name','value'],['a,b','line1\nline2'],['a"b','=SUM(A1:A2)']], partial: false });
    assert.deepEqual(parse('a\tb\n"x\ty"\t""', '\t').rows, [['a','b'],['x\ty','']]);
    assert.deepEqual(parse(''), { rows: [], partial: false });
    assert.deepEqual(parse('a,'), { rows: [['a','']], partial: false });
    assert.throws(() => parse('"unclosed'), /quote|引号/);
    assert.throws(() => parse('"a"x,b'), /quoting|引号/);
});
test('table preview bounds rows, columns, cells and cell lengths while flagging partial content', () => {
    const rows = parse('a,b\n'.repeat(5001)); assert.equal(rows.rows.length, 5000); assert.equal(rows.partial, true);
    const columns = parse(Array(101).fill('a').join(',')); assert.equal(columns.rows[0].length, 100); assert.equal(columns.partial, true);
    const cells = parse((Array(100).fill('a').join(',') + '\n').repeat(501)); assert.equal(cells.rows.length, 500); assert.equal(cells.partial, true);
    assert.throws(() => parse('a'.repeat(32769)), /limit|过长/);
});
