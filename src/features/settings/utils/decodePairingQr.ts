import { extractPairingCodeFromText } from './qrCodeSvg';

export async function decodePairingFrame(canvas: HTMLCanvasElement, source: CanvasImageSource, width: number, height: number) {
  if (!width || !height) return null;
  const scale = Math.min(1, 2048 / Math.max(width, height));
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('无法读取二维码图像');
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const { default: jsQR } = await import('jsqr');
  return extractPairingCodeFromText(jsQR(pixels.data, pixels.width, pixels.height)?.data ?? '');
}

export async function decodePairingImage(file: File) {
  if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) {
    const code = extractPairingCodeFromText(await file.text());
    if (code) return code;
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return await decodePairingFrame(document.createElement('canvas'), image, image.naturalWidth, image.naturalHeight);
  } finally {
    URL.revokeObjectURL(url);
  }
}
