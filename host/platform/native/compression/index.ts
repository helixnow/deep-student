import { promisify } from 'node:util';
import { constants, crc32, createInflateRaw, gzip, zstdCompress, zstdDecompress } from 'node:zlib';
import type { NativeCompression } from './api.ts';
import { zstdFrames } from './zstd-frames.ts';

const compressZstd = promisify(zstdCompress);
const decompressZstd = promisify(zstdDecompress);
const compressGzip = promisify(gzip);

/** flate2::read::GzDecoder consumes one member, unlike node gunzip (all members). */
async function decodeGzip(bytes: Uint8Array, maxOutputBytes?: number): Promise<Uint8Array> {
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const invalid = () => new Error('invalid gzip stream');
  if (input.length < 10 || input[0] !== 0x1f || input[1] !== 0x8b || input[2] !== 8 || (input[3]! & 0xe0)) throw invalid();
  const flags = input[3]!;
  let offset = 10;
  if (flags & 4) {
    if (offset + 2 > input.length) throw invalid();
    const length = input.readUInt16LE(offset);
    offset += 2 + length;
  }
  for (const flag of [8, 16]) {
    if (flags & flag) {
      const end = input.indexOf(0, offset);
      if (end === -1) throw invalid();
      offset = end + 1;
    }
  }
  if (flags & 2) {
    if (offset + 2 > input.length || (crc32(input.subarray(0, offset)) & 0xffff) !== input.readUInt16LE(offset)) throw invalid();
    offset += 2;
  }
  if (offset > input.length) throw invalid();
  const inflater = createInflateRaw();
  const chunks: Buffer[] = [];
  let length = 0;
  await new Promise<void>((resolve, reject) => {
    inflater.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (maxOutputBytes !== undefined && length > maxOutputBytes) {
        inflater.destroy(new RangeError('decompressed output exceeds limit'));
      } else chunks.push(chunk);
    });
    inflater.once('error', reject);
    inflater.once('end', resolve);
    inflater.end(input.subarray(offset));
  });
  const trailer = offset + inflater.bytesWritten;
  if (trailer + 8 > input.length) throw invalid();
  const output = Buffer.concat(chunks, length);
  if (input.readUInt32LE(trailer) !== crc32(output) || input.readUInt32LE(trailer + 4) !== (length >>> 0)) throw invalid();
  return output;
}

export const compression: NativeCompression = {
  async zstdEncode(bytes, level = 0) {
    return compressZstd(bytes, { params: {
      [constants.ZSTD_c_compressionLevel]: level,
      [constants.ZSTD_c_contentSizeFlag]: 0,
      [constants.ZSTD_c_checksumFlag]: 0,
    } });
  },
  async zstdDecode(bytes, maxOutputBytes) {
    const chunks: Buffer[] = [];
    let length = 0;
    for (const frame of zstdFrames(bytes)) {
      const remaining = maxOutputBytes === undefined ? undefined : maxOutputBytes - length;
      const chunk = await decompressZstd(frame, remaining === undefined ? {} : { maxOutputLength: Math.max(1, remaining) });
      length += chunk.length;
      if (maxOutputBytes !== undefined && length > maxOutputBytes) throw new RangeError('decompressed output exceeds limit');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, length);
  },
  async gzipEncode(bytes) {
    const output = await compressGzip(bytes);
    // flate2/src/gz/mod.rs::GzBuilder uses OS=255 and mtime=0 unless configured.
    output[9] = 255;
    return output;
  },
  gzipDecode: decodeGzip,
};
