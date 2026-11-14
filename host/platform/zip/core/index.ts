/**
 * 可移植 ZIP 核心（桌面、移动端 Worker、WebView 共用）：只依赖 Web Streams、`Uint8Array`、
 * `TextEncoder` / `TextDecoder`，不 import 任何 Node 模块。读写的字节布局与 Rust `zip 0.6.6` 一致，
 * 支持 ZIP64（>4GiB、>65535 条目）。
 *
 * 存储与压缩通过接口注入：`ZipByteSource` / `ZipByteSink` 提供随机读写（内存版见
 * `memoryZipSource` / `MemoryZipSink`；桌面文件版在 `../node/file.ts`），`ZipCodec` 提供 deflate 与
 * CRC（默认 `webZipCodec`）。
 */
export {
  ZipWriter,
  type ZipEntryOptions,
  type ZipStreamEntryOptions,
  type ZipWrittenEntry,
  type ZipWriterOptions,
  type ZipWriterState,
} from './writer.ts';
export {
  ZipEntrySizeMismatchError,
  ZipReader,
  type ZipEntry,
  type ZipEntryStreamOptions,
  type ZipReaderOpenOptions,
} from './reader.ts';
export {
  MemoryZipSink,
  memoryZipSource,
  readAllBytes,
  sourceRangeStream,
  toReadableStream,
  webZipCodec,
  type ZipByteSink,
  type ZipByteSource,
  type ZipChunkSource,
  type ZipCodec,
  type ZipTransform,
} from './io.ts';
export {
  ZIP64_BYTES_THR,
  ZIP64_ENTRY_THR,
  ZipFormatError,
  crc32Update,
  type ZipCompressionMethod,
} from './format.ts';
