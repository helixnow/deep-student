// The repository's @types/node predates the Node 24 runtime's Zstandard API.
import 'node:zlib';
declare module 'node:zlib' {
  interface ZstdOptions {
    params?: Record<number, number>;
    maxOutputLength?: number;
  }
  function zstdCompress(input: Uint8Array, options: ZstdOptions, callback: (error: Error | null, output: Buffer) => void): void;
  function zstdDecompress(input: Uint8Array, options: ZstdOptions, callback: (error: Error | null, output: Buffer) => void): void;
  namespace constants {
    const ZSTD_c_compressionLevel: number;
    const ZSTD_c_contentSizeFlag: number;
    const ZSTD_c_checksumFlag: number;
  }
}
