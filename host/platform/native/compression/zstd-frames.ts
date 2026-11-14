/** Locate complete frames before using Node's single-frame decompressor.
 * Rust zstd::stream::decode_all consumes every frame and rejects truncated input.
 * Frame layout: RFC 8878 §3.1.1–3.1.2 (no decompression is performed here).
 */
export function* zstdFrames(bytes: Uint8Array): Generator<Uint8Array> {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const requireBytes = (count: number) => {
    if (offset + count > data.length) throw new Error('incomplete zstd frame');
  };
  while (offset < data.length) {
    const start = offset;
    requireBytes(4);
    const magic = data.readUInt32LE(offset);
    offset += 4;
    if ((magic & 0xfffffff0) === 0x184d2a50) {
      requireBytes(4);
      const length = data.readUInt32LE(offset);
      offset += 4;
      requireBytes(length);
      offset += length;
      continue;
    }
    if (magic !== 0xfd2fb528) throw new Error('invalid zstd frame magic');
    requireBytes(1);
    const descriptor = data[offset++]!;
    if (descriptor & 8) throw new Error('invalid zstd frame descriptor');
    const singleSegment = (descriptor & 32) !== 0;
    const fcsFlag = descriptor >>> 6;
    const dictionaryBytes = [0, 1, 2, 4][descriptor & 3]!;
    const sizeBytes = fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag]!;
    const headerBytes = (singleSegment ? 0 : 1) + dictionaryBytes + sizeBytes;
    requireBytes(headerBytes);
    offset += headerBytes;
    let last = false;
    while (!last) {
      requireBytes(3);
      const block = data.readUIntLE(offset, 3);
      offset += 3;
      last = (block & 1) !== 0;
      const kind = (block >>> 1) & 3;
      if (kind === 3) throw new Error('invalid zstd block type');
      const size = kind === 1 ? 1 : block >>> 3;
      requireBytes(size);
      offset += size;
    }
    if (descriptor & 4) { requireBytes(4); offset += 4; }
    yield data.subarray(start, offset);
  }
}
