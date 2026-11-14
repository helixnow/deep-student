import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../index.ts';

describe('native compression', () => {
  it('decodes a Zstandard raw-block frame, including concatenated frames', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      // Zstandard magic + descriptor/window + last raw block, independent of our encoder.
      const frame = Buffer.from('28b52ffd0000190000616263', 'hex');
      expect(Buffer.from(await host.ctx.nativeCompression.zstdDecode(frame)).toString()).toBe('abc');
      expect(Buffer.from(await host.ctx.nativeCompression.zstdDecode(Buffer.concat([frame, frame]))).toString()).toBe('abcabc');
      const encoded = await host.ctx.nativeCompression.zstdEncode(Buffer.from('abc'), 1);
      expect(Buffer.from(encoded.subarray(0, 4)).toString('hex')).toBe('28b52ffd');
      // zstd::stream::encode_all has no pledged source size and no checksum by default.
      expect(encoded[4]! & 0xc4).toBe(0);
      expect(Buffer.from(await host.ctx.nativeCompression.zstdDecode(encoded)).toString()).toBe('abc');
    } finally { await host.dispose(); }
  });
  it('keeps flate2 GzDecoder single-member semantics and validates checksums', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const codec = host.ctx.nativeCompression;
      const a = await codec.gzipEncode(Buffer.from('first'));
      const b = await codec.gzipEncode(Buffer.from('second'));
      expect(a[9]).toBe(255); // GzBuilder default operating_system.
      expect(Buffer.from(await codec.gzipDecode(Buffer.concat([a, b]))).toString()).toBe('first');
      const corrupt = Buffer.from(a);
      corrupt[corrupt.length - 8] = corrupt[corrupt.length - 8]! ^ 1;
      await expect(codec.gzipDecode(corrupt)).rejects.toThrow();
    } finally { await host.dispose(); }
  });
  it('enforces output limits and rejects truncated compressed input', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const codec = host.ctx.nativeCompression;
      const input = new Uint8Array(1024 * 512);
      const zstd = await codec.zstdEncode(input, 3);
      const gzip = await codec.gzipEncode(input);
      await expect(codec.zstdDecode(zstd, 1024)).rejects.toThrow();
      await expect(codec.gzipDecode(gzip, 1024)).rejects.toThrow();
      await expect(codec.zstdDecode(zstd.subarray(0, zstd.length - 1))).rejects.toThrow();
      await expect(codec.gzipDecode(gzip.subarray(0, gzip.length - 1))).rejects.toThrow();
    } finally { await host.dispose(); }
  });
});
