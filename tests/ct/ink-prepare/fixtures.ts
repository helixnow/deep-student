function makePdfPage(mediaBox: string, cropBox: string, rotate: number, contentObject: number): string {
  return `<< /Type /Page /Parent 2 0 R /MediaBox ${mediaBox} /CropBox ${cropBox} /Rotate ${rotate} /Resources << >> /Contents ${contentObject} 0 R >>`;
}

export function makeInkPreparePdfFixture(): ArrayBuffer {
  const firstPage = '1 1 1 rg 0 0 300 400 re f 1 0 0 rg 24 30 60 18 re f';
  const secondPage = '1 1 1 rg 0 0 500 400 re f 0 0 1 rg 380 60 60 20 re f';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    makePdfPage('[0 0 300 400]', '[0 0 300 400]', 0, 5),
    makePdfPage('[0 0 500 400]', '[50 40 450 340]', 90, 6),
    `<< /Length ${firstPage.length} >>\nstream\n${firstPage}\nendstream`,
    `<< /Length ${secondPage.length} >>\nstream\n${secondPage}\nendstream`,
  ];
  const encoder = new TextEncoder();
  const chunks = ['%PDF-1.7\n%InkPrepareCT\n'];
  const offsets = [0];
  let length = encoder.encode(chunks[0]).length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const chunk = `${index + 1} 0 obj\n${object}\nendobj\n`;
    chunks.push(chunk);
    length += encoder.encode(chunk).length;
  });
  const xrefOffset = length;
  chunks.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  chunks.push(offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join(''));
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return encoder.encode(chunks.join('')).buffer;
}

export async function makeInkPreparePngFixture(): Promise<ArrayBuffer> {
  const canvas = document.createElement('canvas');
  canvas.width = 36;
  canvas.height = 24;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas unavailable for ink preparation PNG fixture');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#d7191c';
  context.fillRect(4, 4, 9, 6);
  context.fillStyle = '#1450cc';
  context.fillRect(24, 14, 8, 6);
  const png = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG fixture encoding failed')), 'image/png');
  });
  return png.arrayBuffer();
}
