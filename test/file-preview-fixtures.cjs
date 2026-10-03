// Synthetic documents only; no user files or external resources.
function pdf() {
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        'BT /F1 24 Tf 30 340 Td (Preview page one) Tj ET',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
        'BT /F1 24 Tf 30 340 Td (Preview page two) Tj ET'
    ];
    let content = '%PDF-1.7\n', offsets = [0];
    objects.forEach((value, index) => {
        offsets.push(Buffer.byteLength(content));
        if ([4, 6].includes(index)) value = `<< /Length ${Buffer.byteLength(value)} >>\nstream\n${value}\nendstream`;
        content += `${index + 1} 0 obj\n${value}\nendobj\n`;
    });
    const xref = Buffer.byteLength(content);
    content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets.slice(1)) content += `${String(offset).padStart(10, '0')} 00000 n \n`;
    content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(content);
}
function wav() {
    const bytes = Buffer.alloc(16044);
    bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36); bytes.writeUInt32LE(16000, 40); return bytes;
}
module.exports = { pdf, wav };
