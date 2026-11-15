import { ImageOperationError, type NativeImage, type RgbaImage } from './api.ts';

function canvas(width: number, height: number): OffscreenCanvasRenderingContext2D {
  if (width <= 0 || height <= 0 || width * height > 24_000_000) throw new Error('Image dimensions exceed the mobile canvas limit');
  const context = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
  if (context === null) throw new Error('OffscreenCanvas 2D is unavailable');
  return context;
}

function put(input: RgbaImage): OffscreenCanvasRenderingContext2D {
  const ctx = canvas(input.width, input.height);
  ctx.putImageData(new ImageData(Uint8ClampedArray.from(input.rgba), input.width, input.height), 0, 0);
  return ctx;
}

function rgba(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number, width: number, height: number): RgbaImage {
  return { width, height, rgba: width && height
    ? new Uint8Array(ctx.getImageData(x, y, width, height).data.buffer) : new Uint8Array() };
}

const bitmap = (bytes: Uint8Array) => createImageBitmap(new Blob([Uint8Array.from(bytes)]), { imageOrientation: 'none' });

export const webImage: NativeImage = {
  async dimensions(bytes) {
    const image = await bitmap(bytes);
    try { return { width: image.width, height: image.height }; } finally { image.close(); }
  },
  async decodeRgba(bytes) {
    const image = await bitmap(bytes);
    try {
      const ctx = canvas(image.width, image.height);
      ctx.drawImage(image, 0, 0);
      return rgba(ctx, 0, 0, image.width, image.height);
    } finally { image.close(); }
  },
  cropRgba(input, { x, y, width, height }) {
    width = Math.max(0, Math.min(width, input.width - x));
    height = Math.max(0, Math.min(height, input.height - y));
    return rgba(put(input), x, y, width, height);
  },
  resizeRgba(input, width, height, filter) {
    const output = canvas(width, height);
    output.imageSmoothingQuality = filter === 'lanczos3' ? 'high' : 'medium';
    output.drawImage(put(input).canvas, 0, 0, width, height);
    return rgba(output, 0, 0, width, height);
  },
  resizeDimensions(width, height, maxWidth, maxHeight) {
    const scale = Math.min(maxWidth / width, maxHeight / height);
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  },
  async encode(input, { format, quality }) {
    const blob = await put(input).canvas.convertToBlob({ type: `image/${format}`,
      ...(quality === undefined ? {} : { quality: quality / 100 }) });
    if (blob.type !== `image/${format}`) throw new Error(`Encoder unavailable: ${format}`);
    return new Uint8Array(await blob.arrayBuffer());
  },
  async cropFigure(bytes, [left, top, right, bottom]) {
    const image = await webImage.decodeRgba(bytes);
    const x = Math.max(0, Math.floor(left * image.width)), y = Math.max(0, Math.floor(top * image.height));
    return webImage.encode(webImage.cropRgba(image, { x, y, width: Math.ceil(right * image.width) - x,
      height: Math.ceil(bottom * image.height) - y }), { format: 'png' });
  },
  async encodeJpegWithinLimit(input, maxBytes, qualities) {
    for (const quality of qualities) {
      const bytes = await webImage.encode(input, { format: 'jpeg', quality });
      if (bytes.length <= maxBytes) return bytes;
    }
    throw new Error(`JPEG cannot fit in ${maxBytes} bytes`);
  },
  resizeAndEncodeJpeg: (bytes, { maxDimension, quality }) =>
    webImage.resizeTriangleJpeg(bytes, maxDimension, maxDimension, quality),
  async resizeTriangleJpeg(bytes, maxWidth, maxHeight, quality) {
    let image: RgbaImage;
    try { image = await webImage.decodeRgba(bytes); }
    catch (error) { throw new ImageOperationError('decode', error); }
    try {
      if (image.width > maxWidth || image.height > maxHeight) {
        const size = webImage.resizeDimensions(image.width, image.height, maxWidth, maxHeight);
        image = webImage.resizeRgba(image, size.width, size.height, 'triangle');
      }
      return await webImage.encode(image, { format: 'jpeg', quality });
    } catch (error) { throw new ImageOperationError('encode', error); }
  },
};
