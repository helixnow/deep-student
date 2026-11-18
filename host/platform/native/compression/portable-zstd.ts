import { Decompress } from 'fzstd';

export function decodeZstd(bytes: Uint8Array, maxOutputLength?: number) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const stream = new Decompress(chunk => {
    size += chunk.length;
    if (maxOutputLength !== undefined && size > maxOutputLength) {
      throw Object.assign(new Error('Decompressed data exceeds limit'), { code: 'ERR_BUFFER_TOO_LARGE' });
    }
    chunks.push(chunk.slice());
  });
  stream.push(bytes, true);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
