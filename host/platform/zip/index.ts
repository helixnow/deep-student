/**
 * 平台共享 ZIP 模块（桌面入口）：流式读写，支持 ZIP64，写出布局与 Rust `zip 0.6.6` 一致。
 *
 * - `core/`：可移植核心（Web Streams + `Uint8Array`，不依赖 Node），移动端与浏览器直接 import
 *   `zip/core/index.ts`；
 * - `node/file.ts`：桌面文件适配层（`FileHandle` + zlib），提供按路径的 `ZipFileWriter` / `ZipFileReader`。
 *
 * 与 `host/platform/util` 的内存版 `ZipWriter` / `ZipArchive` 的分工：大文件、备份归档等
 * 不能整包进内存或可能超过 4GiB / 65535 条目的场景用本模块；小型内存归档仍可用 util。
 */
export * from './core/index.ts';
export {
  ZipFileReader,
  ZipFileWriter,
  fileZipSink,
  fileZipSource,
  nodeZipCodec,
  type ZipFileEntryOptions,
  type ZipWriterCreateOptions,
  type ZipWriterFinishOptions,
} from './node/file.ts';
