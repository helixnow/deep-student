import { init, compress } from '@bokuweb/zstd-wasm';
import type { NativeCompression } from '../../../host/platform/native/compression/api.ts';
import { decodeZstd } from '../../../host/platform/native/compression/portable-zstd.ts';

let initialized: Promise<void> | undefined;
async function gzip(bytes: Uint8Array, encode: boolean, max?: number) {
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(
    encode ? new CompressionStream('gzip') : new DecompressionStream('gzip'),
  );
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (max !== undefined && length > max) {
      await reader.cancel();
      throw new RangeError('decompressed output exceeds limit');
    }
    chunks.push(value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
export const mobileCompression: NativeCompression = {
  async zstdEncode(bytes, level = 0) {
    await (initialized ??= init().catch(error => { initialized = undefined; throw error; }));
    return compress(bytes, level);
  },
  async zstdDecode(bytes, max) { return decodeZstd(bytes, max); },
  gzipEncode: bytes => gzip(bytes, true),
  gzipDecode: (bytes, max) => gzip(bytes, false, max),
};
