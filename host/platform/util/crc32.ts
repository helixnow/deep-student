/** CRC-32（`crc32fast` 语义）：纯 JS 实现，可移植；ZIP 读写与其他调用方共用。 */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[i] = value >>> 0;
  }
  return table;
})();

/** 增量 CRC-32（IEEE，zip/crc32fast 默认多项式）。 */
export class Crc32 {
  private value: number;

  constructor(previous = 0) {
    this.value = (previous ^ 0xffffffff) >>> 0;
  }

  update(data: Uint8Array): this {
    let value = this.value;
    for (const byte of data) value = (value >>> 8) ^ CRC32_TABLE[(value ^ byte) & 0xff]!;
    this.value = value >>> 0;
    return this;
  }

  finalize(): number {
    return (this.value ^ 0xffffffff) >>> 0;
  }
}

/** 一次计算 CRC-32；`previous` 为前一段的 `finalize()` 结果。 */
export function crc32(data: Uint8Array, previous = 0): number {
  return new Crc32(previous).update(data).finalize();
}
