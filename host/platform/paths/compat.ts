/**
 * Rust 标准库/常用 crate 语义的精确复刻，供 F4 各服务共用。
 *
 * 本模块是**可移植**的：只含纯函数与平台模块 re-export，运行时闭包不加载 `node:*`，也不需要 Worker
 * 的 Node shim（`mobile/tests/boot/worker-boot.test.ts` 的 shim 表因此不含本文件）。
 * 文件原语（原子写、目录创建、权限、带退避的 rename）依赖 `node:fs`，已整体迁到桌面入口
 * `host/platform/util/durable-fs.ts`；`ioMessage` 的平台判定改由 `io-error.ts` 的 `globalThis.process`
 * 读取承担，没有 `process` 的运行时（移动端 Worker）按 glibc 文案。
 */
// ------------------------------------------------------------------ 平台模块 re-export
//
// 字符串/UTF-8 已迁到 `host/platform/util`，chrono 已迁到 `host/platform/time`。
// 这里保留同名 re-export 以兼容既有导入；新代码请直接引用平台模块。

export {
  charCount,
  decodeUtf8Strict,
  isRustWhitespace,
  rustTrim,
  rustTrimEnd,
  rustTrimStart,
  takeChars,
  utf8ByteLength,
} from '../util/portable.ts';
export {
  chronoRfc3339,
  chronoStamp,
  civilTime,
  nowEpochNanos,
  toRfc3339,
  toRfc3339Opts,
  ymd,
} from '../time/index.ts';
export type { CivilTime } from '../time/index.ts';

// ------------------------------------------------------------------ 路径

/** Rust `PathBuf::join` 的字符串语义（不规范化，已以分隔符结尾时不重复添加）。 */
export function rustJoin(base: string, sep: '/' | '\\', ...parts: string[]): string {
  let out = base;
  for (const part of parts) {
    if (part.startsWith('/') || (sep === '\\' && /^[A-Za-z]:\\|^\\\\/.test(part))) {
      out = part;
      continue;
    }
    out = out.length === 0 || out.endsWith(sep) || out.endsWith('/') ? out + part : out + sep + part;
  }
  return out;
}

// ------------------------------------------------------------------ 错误文案

export { errnoCode, ioMessage, ioMessageFor } from './io-error.ts';
