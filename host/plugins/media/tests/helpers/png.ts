/**
 * Test-only PNG fixture encoder.
 *
 * Production crop output must go through F7 `nativeImage.encode`; this helper
 * exists to build deterministic input PNGs for the media tests.
 */
import { deflateSync } from 'node:zlib';

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBytes.copy(output, 4);
  Buffer.from(data).copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, Buffer.from(data)])), 8 + data.length);
  return output;
}

/** Encode unpremultiplied 8-bit RGBA pixels as a PNG. */
export function encodePngRgba(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width <= 0 || height <= 0) {
    throw new Error('invalid PNG dimensions');
  }
  if (rgba.length !== width * height * 4) {
    throw new Error('RGBA buffer length does not match dimensions');
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const target = y * (stride + 1);
    raw[target] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, target + 1);
  }

  return new Uint8Array(Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]));
}
