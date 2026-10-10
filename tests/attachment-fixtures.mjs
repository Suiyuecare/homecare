/** Synthetic local files; no original platform or personal data. */
function syntheticPdf() {
  const stream = 'BT /F1 12 Tf 30 60 Td (SYNTHETIC ATTACHMENT TEST) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + 'endstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source));
    source += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
  }
  const startXref = Buffer.byteLength(source);
  source += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  source += 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + startXref + '\n%%EOF\n';
  return Buffer.from(source);
}
export const PDF_BYTES = syntheticPdf();
export const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64');
export const filePayload = (bytes = PDF_BYTES, fileName = '合成測試.pdf', mimeType = 'application/pdf') => ({ fileName, mimeType, contentBase64: bytes.toString('base64') });
